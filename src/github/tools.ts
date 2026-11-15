import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { arr, bool, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { GitHubError, PolicyDenied, type GitHubClient } from "./client.ts";
import { encodePath, repoPath, type RepoPath } from "./policy.ts";

export type PullRef = { readonly number: number; readonly url: string };

export type OpenEffect = { readonly callId: string; readonly parent: string; readonly intended: string };

export interface RepoState {
	pr(): PullRef | undefined;
	setPr(pr: PullRef): void;
	setHead(sha: string): void;
	beginEffect(callId: string, parent: string, intended: string): void;
	finishEffect(callId: string, state: "applied" | "not_applied" | "failed", detail: string): void;
	openEffects(): readonly OpenEffect[];
}

const MAX_LIST = 400;
const MAX_READ_CHARS = 60_000;
const MAX_WRITE_BYTES = 512 * 1024;
const MAX_FILES = 30;

const text = (value: string): ToolExecutionResult => ({ output: [{ type: "text", text: value }] });
const failure = (value: string): ToolExecutionResult => ({ output: [{ type: "text", text: value }], isError: true });

function failed(error: unknown): ToolExecutionResult {
	if (error instanceof PolicyDenied) return failure(`Refused by bobik's repository policy: ${error.message}`);
	if (error instanceof GitHubError) return failure(error.message);
	return failure(`GitHub request failed: ${error instanceof Error ? error.message : String(error)}`);
}

type GitRef = { object: { sha: string } };
type GitCommit = { sha: string; tree: { sha: string } };
type TreeEntry = { path: string; type: string; size?: number };
type ContentFile = { type: "file"; encoding?: string; content?: string; size: number; sha: string; download_url?: string };
type ContentDir = { type: string; path: string; size: number }[];
type Pull = {
	number: number;
	html_url: string;
	title: string;
	state: string;
	draft?: boolean;
	merged?: boolean;
	mergeable_state?: string;
	head: { ref: string; sha: string };
	base: { ref: string };
	body?: string | null;
};
type PullFile = { filename: string; status: string; additions: number; deletions: number };

function decodeBase64(value: string): string {
	const bytes = Uint8Array.from(atob(value.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

export class BranchRepo {
	constructor(
		private readonly client: GitHubClient,
		private readonly state: RepoState,
	) {}

	private get scope() {
		return this.client.scope;
	}

	private get repo() {
		return this.client.repoPath;
	}

	async branchHead(): Promise<string | undefined> {
		return (await this.client.get<GitRef>(`${this.repo}/git/ref/heads/${this.scope.branch}`))?.object.sha;
	}

	async baseHead(): Promise<string> {
		const ref = await this.client.get<GitRef>(`${this.repo}/git/ref/heads/${encodeURIComponent(this.scope.base)}`);
		if (!ref) throw new GitHubError(404, `base branch ${this.scope.base} not found`);
		return ref.object.sha;
	}

	private async resolveRef(ref: "branch" | "base" | undefined): Promise<{ sha: string; label: string }> {
		if (ref !== "base") {
			const head = await this.branchHead();
			if (head) return { sha: head, label: this.scope.branch };
			if (ref === "branch") throw new GitHubError(404, `branch ${this.scope.branch} does not exist yet; it is created by the first github_write_files call`);
		}
		return { sha: await this.baseHead(), label: this.scope.base };
	}

	async list(prefix: string | undefined, ref: "branch" | "base" | undefined): Promise<string> {
		let normalized = "";
		if (prefix !== undefined && prefix.trim() !== "" && prefix.trim() !== ".") {
			const checked = repoPath(prefix.replace(/\/+$/, ""), "read");
			if (!checked.ok) throw new PolicyDenied(checked.reason);
			normalized = `${checked.path}/`;
		}
		const at = await this.resolveRef(ref);
		const tree = await this.client.request<{ tree: TreeEntry[]; truncated: boolean }>("GET", `${this.repo}/git/trees/${at.sha}?recursive=1`);
		const files = tree.tree.filter((entry) => entry.type === "blob" && entry.path.startsWith(normalized));
		const shown = files.slice(0, MAX_LIST).map((entry) => `${entry.path} (${entry.size ?? 0} B)`);
		const notes = [
			`${files.length} files under ${normalized || "/"} at ${at.label} (${at.sha.slice(0, 12)}).`,
			files.length > MAX_LIST ? `Showing the first ${MAX_LIST}; narrow the path to see more.` : "",
			tree.truncated ? "GitHub truncated the tree listing." : "",
		].filter(Boolean);
		return [...notes, ...shown].join("\n");
	}

	async read(raw: string, ref: "branch" | "base" | undefined): Promise<string> {
		const checked = repoPath(raw, "read");
		if (!checked.ok) throw new PolicyDenied(checked.reason);
		const at = await this.resolveRef(ref);
		const found = await this.client.get<ContentFile | ContentDir>(`${this.repo}/contents/${encodePath(checked.path)}?ref=${at.sha}`);
		if (!found) return `${checked.path} does not exist at ${at.label} (${at.sha.slice(0, 12)}).`;
		if (Array.isArray(found)) {
			return [`${checked.path} is a directory at ${at.label}:`, ...found.slice(0, MAX_LIST).map((e) => `${e.path}${e.type === "dir" ? "/" : ""}`)].join("\n");
		}
		if (found.encoding !== "base64" || found.content === undefined) {
			return `${checked.path} is ${found.size} bytes, too large to read through the contents API.`;
		}
		const body = decodeBase64(found.content);
		const clipped = body.length > MAX_READ_CHARS;
		return [
			`${checked.path} at ${at.label} (${at.sha.slice(0, 12)}), ${found.size} bytes${clipped ? `, first ${MAX_READ_CHARS} characters` : ""}:`,
			body.slice(0, MAX_READ_CHARS),
		].join("\n");
	}

	async reconcile(): Promise<string[]> {
		const open = this.state.openEffects();
		if (open.length === 0) return [];
		const head = await this.branchHead();
		return open.map((effect) => {
			if (head === effect.intended) {
				this.state.finishEffect(effect.callId, "applied", "branch head matches the intended commit");
				this.state.setHead(effect.intended);
				return `An earlier interrupted write was applied: ${this.scope.branch} is at ${effect.intended.slice(0, 12)}.`;
			}
			this.state.finishEffect(effect.callId, "not_applied", `branch head is ${head ?? "missing"}`);
			return `An earlier interrupted write (commit ${effect.intended.slice(0, 12)}) was not applied; ${this.scope.branch} is at ${head?.slice(0, 12) ?? "nothing yet"}.`;
		});
	}

	async write(
		callId: string,
		message: string,
		changes: readonly { path: string; content?: string; delete?: boolean }[],
		expectedHead: string | undefined,
	): Promise<string> {
		const notes = await this.reconcile();
		const entries: { path: RepoPath; mode: "100644"; type: "blob"; content?: string; sha?: null }[] = [];
		let bytes = 0;
		const seen = new Set<string>();
		for (const change of changes) {
			const checked = repoPath(change.path, "write");
			if (!checked.ok) throw new PolicyDenied(`${change.path}: ${checked.reason}`);
			if (seen.has(checked.path)) throw new PolicyDenied(`${checked.path} appears twice`);
			seen.add(checked.path);
			if (change.delete === true) {
				if (change.content !== undefined) throw new PolicyDenied(`${checked.path}: give content or delete, not both`);
				entries.push({ path: checked.path, mode: "100644", type: "blob", sha: null });
			} else {
				if (change.content === undefined) throw new PolicyDenied(`${checked.path}: content is required unless delete is true`);
				bytes += new TextEncoder().encode(change.content).byteLength;
				entries.push({ path: checked.path, mode: "100644", type: "blob", content: change.content });
			}
		}
		if (bytes > MAX_WRITE_BYTES) throw new PolicyDenied(`changes total ${bytes} bytes; the limit is ${MAX_WRITE_BYTES}`);

		const head = await this.branchHead();
		const parent = head ?? (await this.baseHead());
		if (expectedHead !== undefined && expectedHead !== parent) {
			return [...notes, `Conflict: ${head ? this.scope.branch : this.scope.base} is at ${parent}, not ${expectedHead}. Read the files again before writing.`].join("\n");
		}
		const parentCommit = await this.client.request<GitCommit>("GET", `${this.repo}/git/commits/${parent}`);
		const tree = await this.client.request<{ sha: string }>("POST", `${this.repo}/git/trees`, { base_tree: parentCommit.tree.sha, tree: entries });
		if (tree.sha === parentCommit.tree.sha) {
			return [...notes, `No changes: ${head ? this.scope.branch : this.scope.base} at ${parent.slice(0, 12)} already has this content.`].join("\n");
		}
		const commit = await this.client.request<GitCommit>("POST", `${this.repo}/git/commits`, { message: message.slice(0, 2000), tree: tree.sha, parents: [parent] });
		this.state.beginEffect(callId, parent, commit.sha);
		try {
			if (head) {
				await this.client.request("PATCH", `${this.repo}/git/refs/heads/${this.scope.branch}`, { sha: commit.sha, force: false });
			} else {
				await this.client.request("POST", `${this.repo}/git/refs`, { ref: `refs/heads/${this.scope.branch}`, sha: commit.sha });
			}
		} catch (error) {
			if (error instanceof GitHubError && error.status === 422) {
				this.state.finishEffect(callId, "not_applied", "branch moved");
				return [...notes, `Conflict: ${this.scope.branch} moved while writing, so nothing was pushed. Read the files again and retry.`].join("\n");
			}
			this.state.finishEffect(callId, "failed", error instanceof Error ? error.message : String(error));
			throw error;
		}
		this.state.finishEffect(callId, "applied", "ref updated");
		this.state.setHead(commit.sha);
		return [
			...notes,
			`Committed ${entries.length} file change(s) to ${this.scope.branch}: ${commit.sha}.`,
			head ? `Parent ${parent.slice(0, 12)}.` : `Created ${this.scope.branch} from ${this.scope.base} at ${parent.slice(0, 12)}.`,
		].join("\n");
	}

	private async openPull(): Promise<Pull | undefined> {
		const pulls = await this.client.request<Pull[]>("GET", `${this.repo}/pulls?head=${this.scope.owner}:${encodeURIComponent(this.scope.branch)}&state=open&per_page=5`);
		return pulls[0];
	}

	async openPr(title: string, body: string, draft: boolean, footer: string): Promise<string> {
		const notes = await this.reconcile();
		const existing = await this.openPull();
		if (existing) {
			this.state.setPr({ number: existing.number, url: existing.html_url });
			return [...notes, `A pull request for ${this.scope.branch} is already open: ${existing.html_url}`].join("\n");
		}
		if (!(await this.branchHead())) return [...notes, `${this.scope.branch} has no commits yet. Write files first.`].join("\n");
		const pull = await this.client.request<Pull>("POST", `${this.repo}/pulls`, {
			title: title.slice(0, 200),
			body: `${body.slice(0, 20_000)}\n\n${footer}`,
			head: this.scope.branch,
			base: this.scope.base,
			draft,
		});
		this.state.setPr({ number: pull.number, url: pull.html_url });
		return [...notes, `Opened pull request #${pull.number}: ${pull.html_url}`].join("\n");
	}

	async getPr(number: number | undefined): Promise<string> {
		const pull = number !== undefined ? await this.client.get<Pull>(`${this.repo}/pulls/${number}`) : await this.openPull();
		if (!pull) return number !== undefined ? `Pull request #${number} not found.` : `No open pull request for ${this.scope.branch}.`;
		const files = await this.client.request<PullFile[]>("GET", `${this.repo}/pulls/${pull.number}/files?per_page=50`);
		let checks = "unknown (no access to commit statuses)";
		try {
			const status = await this.client.request<{ state: string; total_count: number }>("GET", `${this.repo}/commits/${pull.head.sha}/status`);
			checks = `${status.state} (${status.total_count} statuses)`;
		} catch (error) {
			if (!(error instanceof GitHubError)) throw error;
		}
		return [
			`#${pull.number} ${pull.title}`,
			`${pull.html_url}`,
			`State ${pull.merged ? "merged" : pull.state}${pull.draft ? ", draft" : ""}, mergeable ${pull.mergeable_state ?? "unknown"}, ${pull.head.ref} → ${pull.base.ref} at ${pull.head.sha.slice(0, 12)}.`,
			`Commit status: ${checks}.`,
			`Files (${files.length}${files.length === 50 ? "+" : ""}):`,
			...files.map((f) => `${f.status} ${f.filename} +${f.additions} -${f.deletions}`),
			pull.body ? `Description:\n${pull.body.slice(0, 4000)}` : "",
		]
			.filter(Boolean)
			.join("\n");
	}
}

const Ref = oneOf(["branch", "base"], { description: "branch: the bot branch, falling back to the base branch before it exists. base: the base branch." });
const ListArgs = obj({ path: opt(str({ maxLength: 300, description: "Directory prefix, for example src/. Omit for the whole repository." })), ref: opt(Ref) });
const ReadArgs = obj({ path: str({ minLength: 1, maxLength: 300 }), ref: opt(Ref) });
const WriteArgs = obj({
	message: str({ minLength: 1, maxLength: 2000, description: "Commit message." }),
	changes: arr(
		obj({
			path: str({ minLength: 1, maxLength: 300 }),
			content: opt(str({ description: "Full new file content. Omit when deleting." })),
			delete: opt(bool({ description: "true deletes the file." })),
		}),
		{ minItems: 1, maxItems: MAX_FILES },
	),
	expected_head: opt(str({ minLength: 40, maxLength: 40, description: "Commit SHA the branch must be at, from the last write or read. Omit to write on top of the current head." })),
});
const OpenArgs = obj({
	title: str({ minLength: 1, maxLength: 200 }),
	body: str({ maxLength: 20_000, description: "What changed and why, in Markdown." }),
	draft: opt(bool()),
});
const GetArgs = obj({ number: opt(int({ minimum: 1, description: "PR number. Omit for the open PR of this conversation's branch." })) });

export function githubTools(repo: BranchRepo, footer: string): ToolRegistration[] {
	const list: ToolRegistration<typeof ListArgs> = {
		name: "github_list_files",
		description: "List files in the team repository, recursively under an optional directory.",
		parameters: ListArgs,
		replay: "safe",
		outputLimits: { maxBytes: 48_000 },
		async execute(args) {
			try {
				return text(await repo.list(args.path, args.ref));
			} catch (error) {
				return failed(error);
			}
		},
	};
	const read: ToolRegistration<typeof ReadArgs> = {
		name: "github_read_file",
		description: "Read one text file, or list one directory, from the team repository.",
		parameters: ReadArgs,
		replay: "safe",
		outputLimits: { maxBytes: 64_000 },
		async execute(args) {
			try {
				return text(await repo.read(args.path, args.ref));
			} catch (error) {
				return failed(error);
			}
		},
	};
	const write: ToolRegistration<typeof WriteArgs> = {
		name: "github_write_files",
		description:
			"Commit file changes to this conversation's own branch in one commit. Creates the branch from the base branch on first use. Each change gives the full new content of a file, or delete: true. Never touches the base branch.",
		parameters: WriteArgs,
		executionMode: "sequential",
		async execute(args, api) {
			try {
				return text(await repo.write(api.callId, args.message, args.changes, args.expected_head));
			} catch (error) {
				return failed(error);
			}
		},
	};
	const open: ToolRegistration<typeof OpenArgs> = {
		name: "github_open_pr",
		description: "Open a pull request from this conversation's branch into the base branch, or return the one already open. It never merges.",
		parameters: OpenArgs,
		executionMode: "sequential",
		async execute(args) {
			try {
				return text(await repo.openPr(args.title, args.body, args.draft ?? false, footer));
			} catch (error) {
				return failed(error);
			}
		},
	};
	const get: ToolRegistration<typeof GetArgs> = {
		name: "github_get_pr",
		description: "Read a pull request in the team repository: state, changed files, commit status and description.",
		parameters: GetArgs,
		replay: "safe",
		outputLimits: { maxBytes: 32_000 },
		async execute(args) {
			try {
				return text(await repo.getPr(args.number));
			} catch (error) {
				return failed(error);
			}
		},
	};
	return [list, read, write, open, get] as ToolRegistration[];
}
