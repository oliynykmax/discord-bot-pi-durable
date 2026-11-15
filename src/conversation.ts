import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import { ConversationIdle, createRegistry, Harness, ROOT_CONVERSATION_ID, type UserInput } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { PiHarness, type PiHarnessContext, type PiOperationResult } from "agents/harness/pi";
import { Lifecycle, LifecycleCapability, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";
import { DurableObject } from "cloudflare:workers";
import { attachmentKind, attachmentTool } from "./attachments.ts";
import { DiscordRest } from "./discord/rest.ts";
import { unsupported } from "./discord/routing.ts";
import {
	type Admission,
	type AttachmentRef,
	botBranch,
	HELP,
	MAX_INPUT_CHARS,
	MAX_PENDING_INPUTS,
	MAX_TOOL_ROUNDS,
	operationId,
	type ThreadInput,
} from "./domain.ts";
import { discordApi, type Env, githubApi, repoFrom, shellConfig, snowflake, type Snowflake } from "./env.ts";
import { GitHubClient, InstallationTokens } from "./github/client.ts";
import { BranchRepo, githubTools, type OpenEffect, type PullRef, type RepoState } from "./github/tools.ts";
import { OUTBOX_SCHEMA, Outbox } from "./outbox.ts";
import { ShellLink, THREADS_DIR } from "./shell/link.ts";
import { workerDial } from "./shell/worker-dial.ts";
import { KIMI_ID, KIMI_REF, verdaModels } from "./verda.ts";

type Stage = "received" | "submitted" | "settled";
type Role = "leader" | "steer" | "command";

type InputRow = {
	message_id: string;
	op_id: string;
	kind: string;
	input: string;
	role: Role | null;
	stage: Stage;
	reaction: string | null;
	note: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bobik_inputs (
	message_id TEXT PRIMARY KEY,
	op_id TEXT NOT NULL UNIQUE,
	kind TEXT NOT NULL,
	input TEXT NOT NULL,
	role TEXT,
	stage TEXT NOT NULL,
	reaction TEXT,
	note TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bobik_inputs_stage ON bobik_inputs (stage);
CREATE TABLE IF NOT EXISTS bobik_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bobik_effects (
	call_id TEXT PRIMARY KEY,
	parent TEXT NOT NULL,
	intended TEXT NOT NULL,
	state TEXT NOT NULL,
	detail TEXT,
	at INTEGER NOT NULL
);
${OUTBOX_SCHEMA}`;

const SETTLE_CHECK_MS = 60_000;
const RECOVERY_MS = 30_000;
const QUIET_REASONS = new Set(["aborted"]);

const isIdleRejection = (error: unknown) => error instanceof ConversationIdle || (error instanceof Error && error.name === "ConversationIdle");

function renderUnanswered(reason: string | undefined): string {
	switch (reason) {
		case "turn_limit":
			return `❌ I hit the limit of ${MAX_TOOL_ROUNDS} tool rounds for one run. Reply to continue from here.`;
		case "run_failed":
			return "❌ Skipped: the run before this message failed. Send it again to retry.";
		default:
			return `❌ The run ended without an answer (${reason ?? "unknown reason"}). Reply to try again.`;
	}
}

class ConversationJobs extends LifecycleCapability {
	constructor(private readonly host: Conversation) {
		super("bobik.conversation");
	}

	override onStart(): void {
		this.host.recoverInMemory();
	}

	get jobs() {
		return this.lifecycle.jobs;
	}

	async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome | void> {
		switch (job.fn) {
			case "admit":
				return (await this.host.admitReceived()) ? { rescheduleAt: Date.now() + RECOVERY_MS } : undefined;
			case "settle":
				return (await this.host.checkSettled(String(job.payload))) ? undefined : { rescheduleAt: Date.now() + SETTLE_CHECK_MS };
			case "stop":
				await this.host.applyStop(String(job.payload));
				return undefined;
			case "deliver": {
				const next = await this.host.outbox.drain();
				return next === undefined ? undefined : { rescheduleAt: Math.max(next, Date.now() + 1_000) };
			}
			default:
				return undefined;
		}
	}
}

export class Conversation extends DurableObject<Env> {
	readonly harness = new PiHarness({
		harness: (context) => this.openPi(context),
		defaults: { model: KIMI_REF, thinkingLevel: "low", maxTurns: MAX_TOOL_ROUNDS },
	});
	readonly host = new ConversationJobs(this);
	readonly lifecycle = Lifecycle.install(this).use(this.harness).use(this.host);
	readonly outbox: Outbox;
	readonly #watching = new Map<string, Promise<void>>();
	#rest: DiscordRest | undefined;
	#tokens: InstallationTokens | undefined;
	#shell: ShellLink | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(SCHEMA);
		this.outbox = new Outbox(ctx.storage.sql, () => this.rest(), () => this.threadId);
	}

	get threadId(): Snowflake {
		const id = snowflake(this.lifecycle.name);
		if (!id) throw new Error("Conversation objects are named by their Discord thread id");
		return id;
	}

	rest(): DiscordRest {
		this.#rest ??= new DiscordRest(this.env.DISCORD_TOKEN, discordApi(this.env));
		return this.#rest;
	}

	private sql<T extends Record<string, SqlStorageValue>>(query: string, ...binds: SqlStorageValue[]): T[] {
		return this.ctx.storage.sql.exec<T>(query, ...binds).toArray();
	}

	private meta(key: string): string | undefined {
		return this.sql<{ value: string }>("SELECT value FROM bobik_meta WHERE key = ?", key)[0]?.value;
	}

	private setMeta(key: string, value: string) {
		this.sql("INSERT INTO bobik_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
	}

	private openPi({ storage, context, onWake }: PiHarnessContext): Promise<Harness> {
		const registry = createRegistry();
		const threadId = this.threadId;
		const repo = repoFrom(this.env);
		const branch = botBranch(threadId);
		const shell = this.shell();
		registry.install({
			name: "bobik",
			sections: [{ key: "bobik", render: () => this.systemPrompt(repo, branch, shell?.cwd) }],
			tools: [...githubTools(this.branchRepo(), `Opened by bobik from Discord thread ${threadId}.`), attachmentTool((m, i) => this.attachment(m, i))],
		});
		if (shell) registry.install(CodingTools);
		registry.install(
			createCodemodeExtension({
				// One sandbox object per thread keeps a thread's scripts together, in the separate sandbox Worker.
				sandbox: new RemoteCodemodeSandbox({ remote: () => this.env.CODEMODE_SANDBOX.getByName(threadId) }),
				models: false,
			}),
		);
		return Harness.open(
			storage,
			{
				models: verdaModels(this.env),
				registry,
				...(shell ? { env: () => shell.env() } : {}),
				onWake,
				identity: { attribution: null },
				settings: { afterFailedRun: "withdraw", followUpMode: "one-at-a-time" },
				onReport: (report) => console.warn("pi report", report.kind),
			},
			context,
		);
	}

	/** The thread's link to the shell machine, kept for the life of this object; `undefined` without shell settings. */
	private shell(): ShellLink | undefined {
		const config = shellConfig(this.env);
		if (!config) return undefined;
		this.#shell ??= new ShellLink(workerDial(config.url, config.token), `${THREADS_DIR}/${this.threadId}`);
		return this.#shell;
	}

	private systemPrompt(repo: { owner: string; name: string; base: string }, branch: string, shellCwd: string | undefined): string {
		return [
			"You are bobik, a laid-back helper who hangs out in Discord with a small group of friends. Each message starts with its author's name.",
			"You help with whatever comes up: chatting, brainstorming, explaining things, writing and editing, translating, planning, everyday questions, and code when someone actually asks for it. Don't steer a normal conversation toward code, repositories or pull requests.",
			"Talk like a friendly, relaxed person: warm, natural, concise by default. Reply in the language the person writes in and match their mood. Light humor is fine when it fits; skip forced slang and corporate report formatting. Take every request seriously and actually do it.",
			shellCwd
				? `Your tools: discord_read_attachment reads files people attach. read, write, edit and bash work on your own small Linux machine (Ubuntu, 1 GB of RAM, shared by the whole friend group). This thread has its own folder, ${shellCwd}, which is your working directory, and its files stay between messages. Other threads have their own folders; leave them alone unless someone asks. Use the shell when it actually helps, like running code, crunching numbers or data, converting files or keeping notes. Keep commands light, give anything slow a timeout, and don't leave things running in the background: they are stopped when you go quiet. curl in the shell is your only way onto the web; you have no browser, web search or screenshots, and you can't send files back to Discord, so paste the part that matters. The GitHub tools work on one repository and only matter when a request is about that repository.`
				: "Your tools: discord_read_attachment reads files people attach. The GitHub tools work on one repository and only matter when a request is about that repository. You have no web search, shell, test runner, builds or screenshots.",
			"codemode runs a short JavaScript script that calls your other tools as `await tools.<name>(args)` and returns only what the script outputs. Use it when a job takes several tool calls, like reading a few files, looping or combining results, so it happens in one step. For a single call, call the tool directly.",
			"Never pretend to have a tool or access you lack, and never claim you ran, tested, checked or looked something up when you didn't. Only report results a tool actually gave you. If something needs a human to verify, say so.",
			`For repository work: the repository is ${repo.owner}/${repo.name}, base branch ${repo.base}, and this conversation's own branch is ${branch}. Read with github_list_files and github_read_file. Change code only with github_write_files, which commits to your branch, then open a pull request with github_open_pr. Inspect pull requests with github_get_pr. You cannot push to ${repo.base}, merge or delete branches. When you open or update a pull request, include its link in your answer.`,
			"Your final message is posted to Discord as is.",
		].join("\n");
	}

	private branchRepo(): BranchRepo {
		const repo = repoFrom(this.env);
		this.#tokens ??= new InstallationTokens(githubApi(this.env), {
			appId: this.env.GH_APP_ID,
			installationId: this.env.GH_INSTALLATION_ID,
			privateKeyPkcs8: this.env.GH_APP_PRIVATE_KEY_PKCS8,
			repository: repo.name,
		});
		const client = new GitHubClient(githubApi(this.env), { ...repo, branch: botBranch(this.threadId) }, this.#tokens);
		return new BranchRepo(client, this.repoState());
	}

	private repoState(): RepoState {
		return {
			pr: () => {
				const raw = this.meta("pr");
				return raw ? (JSON.parse(raw) as PullRef) : undefined;
			},
			setPr: (pr) => this.setMeta("pr", JSON.stringify(pr)),
			setHead: (sha) => this.setMeta("head", sha),
			beginEffect: (callId, parent, intended) =>
				this.sql("INSERT OR REPLACE INTO bobik_effects (call_id, parent, intended, state, at) VALUES (?, ?, ?, 'started', ?)", callId, parent, intended, Date.now()),
			finishEffect: (callId, state, detail) => this.sql("UPDATE bobik_effects SET state = ?, detail = ? WHERE call_id = ?", state, detail.slice(0, 500), callId),
			openEffects: () =>
				this.sql<{ call_id: string; parent: string; intended: string }>("SELECT call_id, parent, intended FROM bobik_effects WHERE state = 'started' ORDER BY at").map(
					(row): OpenEffect => ({ callId: row.call_id, parent: row.parent, intended: row.intended }),
				),
		};
	}

	private attachment(messageId: string, index: number): AttachmentRef | undefined {
		const row = this.sql<{ input: string }>("SELECT input FROM bobik_inputs WHERE message_id = ?", messageId)[0];
		if (!row) return undefined;
		return (JSON.parse(row.input) as ThreadInput).attachments[index - 1];
	}

	private modelInput(input: ThreadInput, text: string): UserInput {
		const lines = [`${input.authorName} (message ${input.messageId}):`, text];
		if (input.attachments.length > 0) {
			lines.push("", "Attachments (read with discord_read_attachment):");
			for (const [i, a] of input.attachments.entries()) {
				lines.push(`${i + 1}. ${a.name}, ${a.contentType ?? "unknown type"}, ${a.size} bytes${attachmentKind(a) === "unsupported" ? " (cannot be read)" : ""}`);
			}
		}
		return lines.join("\n");
	}

	async accept(input: ThreadInput): Promise<Admission> {
		await this.lifecycle.start();
		if (input.threadId !== this.threadId) throw new Error("input belongs to another thread");
		const existing = this.sql<{ reaction: string | null }>("SELECT reaction FROM bobik_inputs WHERE message_id = ?", input.messageId)[0];
		if (existing) return { duplicate: true, ...(existing.reaction ? { reaction: existing.reaction } : {}) };

		const action = input.action;
		switch (action.kind) {
			case "help":
				return this.command(input, HELP);
			case "unsupported":
				return this.command(input, unsupported(action.command));
			case "invalid":
				return this.command(input, action.reason);
			case "status":
				return this.command(input, await this.statusText());
			case "stop":
				return this.stop(input);
			case "say":
			case "queue": {
				if (action.text.length > MAX_INPUT_CHARS) return this.command(input, `That message is over ${MAX_INPUT_CHARS} characters. Attach long text as a file instead.`);
				if ((await this.harness.pending()).length >= MAX_PENDING_INPUTS) return this.command(input, `${MAX_PENDING_INPUTS} messages are already waiting. Wait for the run or use \`!stop\`.`);
				this.insertInput(input, "received");
				await this.host.jobs.push({ id: "admit", fn: "admit", time: Date.now() + RECOVERY_MS });
				return this.submit(this.inputRow(input.messageId)!);
			}
		}
	}

	private insertInput(input: ThreadInput, stage: Stage, role: Role | null = null, reaction: string | null = null) {
		this.sql(
			"INSERT INTO bobik_inputs (message_id, op_id, kind, input, role, stage, reaction, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			input.messageId,
			operationId(input.messageId),
			input.action.kind,
			JSON.stringify(input),
			role,
			stage,
			reaction,
			Date.now(),
		);
	}

	private inputRow(messageId: string): InputRow | undefined {
		return this.sql<InputRow>("SELECT message_id, op_id, kind, input, role, stage, reaction, note FROM bobik_inputs WHERE message_id = ?", messageId)[0];
	}

	private async command(input: ThreadInput, reply: string): Promise<Admission> {
		this.ctx.storage.transactionSync(() => {
			this.insertInput(input, "settled", "command");
			this.outbox.enqueue(`notice:${input.messageId}`, reply, input.messageId);
		});
		await this.deliverSoon();
		return { duplicate: false };
	}

	private async submit(row: InputRow): Promise<Admission> {
		const input = JSON.parse(row.input) as ThreadInput;
		const action = input.action;
		if (action.kind !== "say" && action.kind !== "queue") throw new Error(`cannot submit ${action.kind}`);
		const content = this.modelInput(input, action.text);
		const known = await this.piSubmission(row.op_id);
		let role: Role = row.role ?? "leader";
		if (!known) {
			if (action.kind === "queue") {
				await this.harness.submit(content, { operationId: row.op_id, whenBusy: "followUp" });
				role = "leader";
			} else {
				try {
					await this.harness.submit(content, { operationId: row.op_id, whenBusy: "steer", whenIdle: "reject" });
					role = "steer";
				} catch (error) {
					if (!isIdleRejection(error)) throw error;
					await this.harness.submit(content, { operationId: row.op_id, whenBusy: "followUp" });
					role = "leader";
				}
			}
		}
		const queued = (await this.harness.pending()).some((op) => op.operationId === row.op_id && op.status === "queued");
		const reaction = role === "leader" && queued ? "📥" : "✅";
		this.sql("UPDATE bobik_inputs SET stage = 'submitted', role = ?, reaction = ? WHERE message_id = ? AND stage = 'received'", role, reaction, row.message_id);
		await this.host.jobs.push({ id: `settle:${row.op_id}`, fn: "settle", time: Date.now() + SETTLE_CHECK_MS, payload: row.op_id });
		this.watch(row.op_id);
		return { duplicate: false, reaction };
	}

	private async piSubmission(opId: string) {
		const storage = await this.harness.storage();
		return storage.submissionByRequest(ROOT_CONVERSATION_ID, opId, BACKGROUND_CONTEXT);
	}

	private watch(opId: string) {
		if (this.#watching.has(opId)) return;
		const done = this.harness
			.wait(opId)
			.then((result) => this.settle(opId, result))
			.catch((error) => console.error("settlement watch failed", error instanceof Error ? error.message : String(error)))
			.finally(() => this.#watching.delete(opId));
		this.#watching.set(opId, done);
	}

	/** Runs at startup: re-attaches in-memory watchers. Detached, because startup holds the input gate. */
	recoverInMemory() {
		void (async () => {
			await this.lifecycle.start();
			for (const row of this.sql<{ op_id: string }>("SELECT op_id FROM bobik_inputs WHERE stage = 'submitted'")) this.watch(row.op_id);
			if (this.sql("SELECT 1 FROM bobik_inputs WHERE stage = 'received' LIMIT 1").length > 0) await this.admitReceived();
			await this.outbox.drain();
		})().catch((error) => console.error("conversation recovery failed", error instanceof Error ? error.message : String(error)));
	}

	async admitReceived(): Promise<boolean> {
		for (const row of this.sql<InputRow>("SELECT message_id, op_id, kind, input, role, stage, reaction, note FROM bobik_inputs WHERE stage = 'received' ORDER BY created_at")) {
			if (row.kind === "stop") await this.applyStop(row.message_id);
			else await this.submit(row);
		}
		return this.sql("SELECT 1 FROM bobik_inputs WHERE stage = 'received' LIMIT 1").length > 0;
	}

	async checkSettled(opId: string): Promise<boolean> {
		const row = this.sql<{ stage: Stage }>("SELECT stage FROM bobik_inputs WHERE op_id = ?", opId)[0];
		if (!row || row.stage === "settled") return true;
		const record = await this.piSubmission(opId);
		if (record && (record.status === "done" || record.status === "unanswered")) {
			await this.settle(opId, await this.harness.wait(opId));
			return true;
		}
		this.watch(opId);
		return false;
	}

	private async settle(opId: string, result: PiOperationResult) {
		const row = this.sql<{ message_id: string; role: Role | null; stage: Stage }>("SELECT message_id, role, stage FROM bobik_inputs WHERE op_id = ?", opId)[0];
		if (!row || row.stage === "settled") return;
		let group: string | undefined;
		let text = "";
		if (result.status === "done") {
			const record = await this.piSubmission(opId);
			group = record?.status === "done" ? `answer:${record.answer}` : `op:${opId}`;
			text = result.text ?? "";
		} else if (row.role !== "steer" && !QUIET_REASONS.has(result.reason ?? "")) {
			group = `op:${opId}`;
			text = renderUnanswered(result.reason);
		}
		this.ctx.storage.transactionSync(() => {
			if (group) this.outbox.enqueue(group, text);
			this.sql("UPDATE bobik_inputs SET stage = 'settled', note = ? WHERE op_id = ?", result.status === "done" ? "done" : (result.reason ?? "unanswered"), opId);
			if (result.status !== "done") this.setMeta("last_failure", result.reason ?? "unanswered");
		});
		await this.host.jobs.cancel(`settle:${opId}`);
		await this.deliverSoon();
	}

	private async stop(input: ThreadInput): Promise<Admission> {
		const running = (await this.harness.pending()).length > 0;
		this.insertInput(input, "received", "command", "⏹");
		this.sql("UPDATE bobik_inputs SET note = ? WHERE message_id = ?", running ? "running" : "idle", input.messageId);
		await this.host.jobs.push({ id: `stop:${input.messageId}`, fn: "stop", time: Date.now() + RECOVERY_MS, payload: input.messageId });
		void this.applyStop(input.messageId).catch((error) => console.error("stop failed", error instanceof Error ? error.message : String(error)));
		return { duplicate: false, reaction: "⏹" };
	}

	async applyStop(messageId: string) {
		const row = this.inputRow(messageId);
		if (!row || row.stage !== "received") return;
		if (row.note === "running") await this.harness.session().abort();
		const reply = row.note === "running" ? "⏹ Stopped. Queued messages were dropped." : "Nothing was running.";
		this.ctx.storage.transactionSync(() => {
			this.outbox.enqueue(`notice:${messageId}`, reply, messageId);
			this.sql("UPDATE bobik_inputs SET stage = 'settled' WHERE message_id = ?", messageId);
		});
		await this.host.jobs.cancel(`stop:${messageId}`);
		await this.deliverSoon();
	}

	private async deliverSoon() {
		await this.host.jobs.push({ id: "deliver", fn: "deliver", time: Date.now(), singleflight: true });
	}

	async statusText(): Promise<string> {
		const pending = await this.harness.pending();
		const running = pending.some((op) => op.status === "running");
		const queued = pending.filter((op) => op.status === "queued").length;
		const head = this.meta("head");
		const pr = this.repoState().pr();
		const failure = this.meta("last_failure");
		const problems = this.outbox.problems();
		return [
			`${running ? "Running" : "Idle"}${queued ? `, ${queued} queued` : ""}. Model ${KIMI_ID} on Verda.`,
			head || pr ? `Branch \`${botBranch(this.threadId)}\`${head ? ` at ${head.slice(0, 12)}` : ""}.${pr ? ` PR: ${pr.url}` : ""}` : "",
			failure ? `Last run ended without an answer: ${failure}.` : "",
			problems.blocked || problems.uncertain
				? `Delivery: ${problems.blocked} blocked, ${problems.uncertain} uncertain message part(s) need an operator.`
				: "",
		]
			.filter(Boolean)
			.join("\n");
	}
}
