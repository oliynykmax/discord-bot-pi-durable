import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ConversationIdle, createRegistry, Harness, ROOT_CONVERSATION_ID, type UserInput } from "@earendil-works/pi-durable";
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
import { discordApi, type Env, githubApi, repoFrom, snowflake, type Snowflake } from "./env.ts";
import { GitHubClient, InstallationTokens } from "./github/client.ts";
import { BranchRepo, githubTools, type OpenEffect, type PullRef, type RepoState } from "./github/tools.ts";
import { OUTBOX_SCHEMA, Outbox } from "./outbox.ts";
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

/**
 * The host-side jobs of a conversation: admission recovery, settlement backstops, stop recovery and delivery. Pi's
 * own recovery is PiHarness's job; these cover the application rows around it.
 */
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
		registry.install({
			name: "bobik",
			sections: [{ key: "bobik", render: () => this.systemPrompt(repo, branch) }],
			tools: [...githubTools(this.branchRepo(), `Opened by bobik from Discord thread ${threadId}.`), attachmentTool((m, i) => this.attachment(m, i))],
		});
		return Harness.open(
			storage,
			{
				models: verdaModels(this.env),
				registry,
				onWake,
				identity: { attribution: null },
				settings: { afterFailedRun: "withdraw", followUpMode: "one-at-a-time" },
				onReport: (report) => console.warn("pi report", report.kind),
			},
			context,
		);
	}

	private systemPrompt(repo: { owner: string; name: string; base: string }, branch: string): string {
		return [
			"You are bobik, the coding assistant of a hackathon team. Teammates talk to you in a Discord thread; each message starts with its author's name.",
			`You work on the GitHub repository ${repo.owner}/${repo.name}. Its base branch is ${repo.base}. This conversation's own branch is ${branch}.`,
			"Read code with github_list_files and github_read_file. Change code only with github_write_files, which commits to your branch, then open a pull request with github_open_pr. Inspect pull requests with github_get_pr. Read files users attach with discord_read_attachment.",
			`You cannot push to ${repo.base}, merge, delete branches, run a shell, run tests or builds, or take screenshots. Never claim you did. Say what a human should verify.`,
			"Your final message is posted to Discord: keep it short, say what changed, link the pull request, and list anything the team must decide.",
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

	/** Durably admits one Discord message. Resolves once the input and its recovery job are stored, not when the model answers. */
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

	/** Pi's own record of a submission, by the operation id it was admitted with. */
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

	/** Returns true while received inputs remain. */
	async admitReceived(): Promise<boolean> {
		for (const row of this.sql<InputRow>("SELECT message_id, op_id, kind, input, role, stage, reaction, note FROM bobik_inputs WHERE stage = 'received' ORDER BY created_at")) {
			if (row.kind === "stop") await this.applyStop(row.message_id);
			else await this.submit(row);
		}
		return this.sql("SELECT 1 FROM bobik_inputs WHERE stage = 'received' LIMIT 1").length > 0;
	}

	/** The durable backstop for a watcher lost to eviction. Returns true once the operation is settled here. */
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
			text = this.withPullLink(result.text ?? "");
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

	private withPullLink(text: string): string {
		const pr = this.repoState().pr();
		return pr && !text.includes(pr.url) ? `${text}\n\nPR: ${pr.url}` : text;
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
			`Branch \`${botBranch(this.threadId)}\`${head ? ` at ${head.slice(0, 12)}` : " (no commits yet)"}.${pr ? ` PR: ${pr.url}` : ""}`,
			failure ? `Last run ended without an answer: ${failure}.` : "",
			problems.blocked || problems.uncertain
				? `Delivery: ${problems.blocked} blocked, ${problems.uncertain} uncertain message part(s) need an operator.`
				: "",
		]
			.filter(Boolean)
			.join("\n");
	}
}
