export type Scope = {
	readonly owner: string;
	readonly name: string;
	readonly base: string;
	readonly branch: string;
};

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const BRANCH = /^bobik\/\d{15,21}$/;
const deny = (reason: string): Verdict => ({ ok: false, reason });
const ALLOW: Verdict = { ok: true };

function segments(path: string): string[] | undefined {
	const out: string[] = [];
	for (const raw of path.split("/").slice(1)) {
		let part: string;
		try {
			part = decodeURIComponent(raw);
		} catch {
			return undefined;
		}
		if (part === "" || part === "." || part === ".." || part.includes("/") || part.includes("\\") || /[\u0000-\u001f]/.test(part)) {
			return undefined;
		}
		out.push(part);
	}
	return out;
}

function record(body: unknown): Record<string, unknown> {
	return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

export function allowRequest(method: string, url: string, body: unknown, scope: Scope): Verdict {
	if (!BRANCH.test(scope.branch)) return deny("branch is not a bot branch");
	if (scope.branch === scope.base) return deny("branch is the base branch");
	const [path = "", query] = url.split("?", 2);
	if (query !== undefined && method !== "GET") return deny("query on a mutation");
	const parts = segments(path);
	if (!parts) return deny("malformed path");
	const [root, owner, name, ...rest] = parts;
	if (root !== "repos" || owner !== scope.owner || name !== scope.name) return deny("repository outside scope");
	const tail = rest.join("/");
	const fields = record(body);

	if (method === "GET") return ALLOW;
	if (method === "POST" && (tail === "git/blobs" || tail === "git/trees" || tail === "git/commits")) return ALLOW;
	if (method === "POST" && tail === "git/refs") {
		return fields.ref === `refs/heads/${scope.branch}` ? ALLOW : deny("ref creation outside the bot branch");
	}
	if (method === "PATCH" && tail === `git/refs/heads/${scope.branch}`) {
		return fields.force === undefined || fields.force === false ? ALLOW : deny("force update");
	}
	if (method === "POST" && tail === "pulls") {
		const head = fields.head === scope.branch || fields.head === `${scope.owner}:${scope.branch}`;
		return head && fields.base === scope.base ? ALLOW : deny("pull request outside the bot branch");
	}
	return deny(`${method} ${tail} is not allowed`);
}

export type RepoPath = string & { readonly __repoPath: unique symbol };

export type PathCheck = { readonly ok: true; readonly path: RepoPath } | { readonly ok: false; readonly reason: string };

export function repoPath(raw: unknown, purpose: "read" | "write"): PathCheck {
	if (typeof raw !== "string") return { ok: false, reason: "path must be a string" };
	const path = raw.trim().replace(/^\.\//, "");
	if (path.length === 0 || path.length > 300) return { ok: false, reason: "path must be 1 to 300 characters" };
	if (path.startsWith("/") || path.endsWith("/")) return { ok: false, reason: "path must be relative to the repository root" };
	if (/[\u0000-\u001f\\]/.test(path)) return { ok: false, reason: "path contains a control character or backslash" };
	if (path.split("/").some((part) => part === "" || part === "." || part === "..")) return { ok: false, reason: "path has an empty, . or .. segment" };
	if (purpose === "write" && (path === ".git" || path.startsWith(".git/") || path.startsWith(".github/workflows/"))) {
		return { ok: false, reason: "writing .git or .github/workflows is not allowed" };
	}
	return { ok: true, path: path as RepoPath };
}

export const encodePath = (path: RepoPath) => path.split("/").map(encodeURIComponent).join("/");
