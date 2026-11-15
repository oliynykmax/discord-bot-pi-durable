import { DurableObject } from "cloudflare:workers";
import { nonceFor, type ThreadInput } from "./domain.ts";
import { connection, type Connection, type Effect, type Frame, type GatewayEvent, INTENTS, step } from "./discord/protocol.ts";
import { DiscordRest, type RestResult, THREAD_ALREADY_CREATED } from "./discord/rest.ts";
import { channelKind, type ChannelKind, inbound, type Inbound, route, type View } from "./discord/routing.ts";
import { accessFrom, discordApi, type Env, snowflake, type Snowflake } from "./env.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gw_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS gw_journal (
	message_id TEXT PRIMARY KEY,
	payload TEXT NOT NULL,
	seq INTEGER,
	state TEXT NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	next_at INTEGER NOT NULL,
	reason TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gw_journal_due ON gw_journal (state, next_at);
CREATE TABLE IF NOT EXISTS gw_threads (thread_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS gw_done (message_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
`;

const MAX_JOURNAL_ATTEMPTS = 8;
const DONE_RETENTION_MS = 30 * 24 * 3_600_000;
const IGNORED_CHECKPOINT_MS = 5 * 60_000;
const MIN_IDENTIFY_GAP_MS = 5_500;

type JournalRow = { message_id: string; payload: string; attempts: number; next_at: number };
type Outcome = { readonly kind: "done" } | { readonly kind: "retry"; readonly delayMs: number; readonly reason: string };

const DONE: Outcome = { kind: "done" };
const backoff = (attempts: number) => Math.min(10 * 60_000, 2_000 * 3 ** attempts);

function retryFor(result: Exclude<RestResult<unknown>, { ok: true }>, what: string, attempts: number): Outcome {
	switch (result.kind) {
		case "rate_limited":
			return { kind: "retry", delayMs: result.retryAfterMs, reason: `${what}: rate limited` };
		case "rejected":
			return { kind: "retry", delayMs: backoff(attempts), reason: `${what}: HTTP ${result.status}${result.code ? ` code ${result.code}` : ""}` };
		case "unavailable":
			return { kind: "retry", delayMs: backoff(attempts), reason: `${what}: Discord unavailable` };
	}
}

export type GatewayStatus = {
	readonly enabled: boolean;
	readonly phase: "stopped" | "connecting" | Connection["phase"];
	readonly fatal: string | null;
	readonly resumable: boolean;
	readonly lastAckAgeS: number | null;
	readonly lastReadyAgeS: number | null;
	readonly journal: { readonly pending: number; readonly blocked: number };
	readonly boundThreads: number;
	readonly lastError: string | null;
};

export class DiscordGateway extends DurableObject<Env> {
	#ws: WebSocket | undefined;
	#conn: Connection | undefined;
	#connecting: Promise<void> | undefined;
	#heartbeat: ReturnType<typeof setTimeout> | undefined;
	#reconnect: ReturnType<typeof setTimeout> | undefined;
	#reconnects = 0;
	#lastAck: number | undefined;
	#lastIdentify = 0;
	#lastCheckpoint = 0;
	#lastError: string | null = null;
	#processing: Promise<void> = Promise.resolve();
	#rest: DiscordRest | undefined;
	readonly #bound = new Set<string>();
	readonly #channels = new Map<string, ChannelKind>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(SCHEMA);
		for (const row of this.sql<{ thread_id: string }>("SELECT thread_id FROM gw_threads")) this.#bound.add(row.thread_id);
	}

	private sql<T extends Record<string, SqlStorageValue>>(query: string, ...binds: SqlStorageValue[]): T[] {
		return this.ctx.storage.sql.exec<T>(query, ...binds).toArray();
	}

	private get(key: string): string | undefined {
		return this.sql<{ value: string }>("SELECT value FROM gw_state WHERE key = ?", key)[0]?.value;
	}

	private set(key: string, value: string | number) {
		this.sql("INSERT INTO gw_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, String(value));
	}

	private unset(...keys: string[]) {
		for (const key of keys) this.sql("DELETE FROM gw_state WHERE key = ?", key);
	}

	private rest(): DiscordRest {
		this.#rest ??= new DiscordRest(this.env.DISCORD_TOKEN, discordApi(this.env));
		return this.#rest;
	}

	private view(): View {
		const roles = this.get("bot_roles");
		return {
			botId: snowflake(this.get("bot_id")),
			botRoles: new Set(roles ? (JSON.parse(roles) as string[]) : []),
			bound: (id) => this.#bound.has(id),
			access: accessFrom(this.env),
		};
	}

	async start(): Promise<GatewayStatus> {
		if (accessFrom(this.env).users.size === 0 && accessFrom(this.env).roles.size === 0) {
			throw new Error("ALLOWED_USER_IDS or ALLOWED_ROLE_IDS must be set before the gateway starts");
		}
		this.set("enabled", 1);
		this.unset("fatal");
		await this.link();
		return this.status();
	}

	async stop(): Promise<GatewayStatus> {
		this.set("enabled", 0);
		this.unset("session_id", "resume_url", "seq");
		this.teardown(1000);
		return this.status();
	}

	/** Cron entry: reconnects a persisted-enabled gateway and drains a due journal. Writes nothing when healthy. */
	async ensure(): Promise<void> {
		if (this.get("enabled") === "1" && !this.get("fatal") && !this.#ws) await this.link();
		if (this.sql("SELECT 1 FROM gw_journal WHERE state = 'pending' AND next_at <= ? LIMIT 1", Date.now()).length > 0) await this.processJournal();
	}

	override async alarm(): Promise<void> {
		await this.processJournal();
		await this.ensure();
	}

	status(): GatewayStatus {
		const counts = this.sql<{ state: string; n: number }>("SELECT state, COUNT(*) AS n FROM gw_journal GROUP BY state");
		const ready = Number(this.get("last_ready_at") ?? 0);
		return {
			enabled: this.get("enabled") === "1",
			phase: this.#conn?.phase ?? (this.#connecting ? "connecting" : "stopped"),
			fatal: this.get("fatal") ?? null,
			resumable: this.get("session_id") !== undefined,
			lastAckAgeS: this.#lastAck === undefined ? null : Math.round((Date.now() - this.#lastAck) / 1000),
			lastReadyAgeS: ready ? Math.round((Date.now() - ready) / 1000) : null,
			journal: { pending: counts.find((c) => c.state === "pending")?.n ?? 0, blocked: counts.find((c) => c.state === "blocked")?.n ?? 0 },
			boundThreads: this.#bound.size,
			lastError: this.#lastError,
		};
	}

	private link(): Promise<void> {
		this.#connecting ??= this.open().finally(() => {
			this.#connecting = undefined;
		});
		return this.#connecting;
	}

	private async open(): Promise<void> {
		if (this.#ws || this.get("enabled") !== "1" || this.get("fatal")) return;
		const sessionId = this.get("session_id");
		const resumeUrl = this.get("resume_url");
		const canResume = sessionId !== undefined && resumeUrl !== undefined;
		let url = resumeUrl;
		if (!canResume) {
			const info = await this.rest().gatewayBot();
			if (!info.ok) {
				if (info.kind === "rejected" && info.status === 401) return this.fatal("Discord rejected the bot token");
				this.#lastError = "gateway lookup failed";
				return this.scheduleReconnect(info.kind === "rate_limited" ? info.retryAfterMs : this.backoff());
			}
			if (info.body.session_start_limit.remaining < 1) {
				this.#lastError = "identify limit reached";
				return this.scheduleReconnect(info.body.session_start_limit.reset_after);
			}
			const wait = this.#lastIdentify + MIN_IDENTIFY_GAP_MS - Date.now();
			if (wait > 0) return this.scheduleReconnect(wait);
			url = info.body.url;
		}
		const target = new URL(url!.replace(/^wss:/, "https:"));
		target.searchParams.set("v", "10");
		target.searchParams.set("encoding", "json");
		let socket: WebSocket | null;
		try {
			socket = (await fetch(target, { headers: { upgrade: "websocket" } })).webSocket;
		} catch {
			socket = null;
		}
		if (!socket) {
			this.#lastError = "websocket upgrade failed";
			return this.scheduleReconnect(this.backoff());
		}
		socket.accept();
		this.attach(socket, canResume);
	}

	/** Takes over an accepted socket. Public so tests can drive the protocol over an in-memory WebSocketPair. */
	attach(socket: WebSocket, canResume: boolean) {
		this.#ws = socket;
		const seq = this.get("seq");
		this.#conn = connection(canResume, seq === undefined ? null : Number(seq));
		socket.addEventListener("message", (event) => {
			if (this.#ws !== socket) return;
			let frame: Frame;
			try {
				frame = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer)) as Frame;
			} catch {
				return;
			}
			this.event({ type: "frame", frame, jitter: Math.random() });
		});
		socket.addEventListener("close", (event) => {
			if (this.#ws !== socket) return;
			this.#ws = undefined;
			this.event({ type: "closed", code: event.code, jitter: Math.random() });
			this.#conn = undefined;
		});
		socket.addEventListener("error", () => {
			if (this.#ws !== socket) return;
			this.#lastError = "websocket error";
		});
	}

	private event(event: GatewayEvent) {
		if (!this.#conn) return;
		const [next, effects] = step(this.#conn, event);
		this.#conn = next;
		for (const effect of effects) this.perform(effect);
	}

	private perform(effect: Effect) {
		switch (effect.type) {
			case "heartbeat":
				return this.send({ op: 1, d: effect.seq });
			case "identify":
				this.#lastIdentify = Date.now();
				return this.send({
					op: 2,
					d: { token: this.env.DISCORD_TOKEN, intents: INTENTS, properties: { os: "cloudflare", browser: "bobik", device: "bobik" } },
				});
			case "resume":
				return this.send({ op: 6, d: { token: this.env.DISCORD_TOKEN, session_id: this.get("session_id"), seq: effect.seq } });
			case "schedule_heartbeat":
				clearTimeout(this.#heartbeat);
				this.#heartbeat = setTimeout(() => this.event({ type: "heartbeat_due" }), effect.delayMs);
				return;
			case "dispatch":
				return this.dispatch(effect.name, effect.data, effect.seq);
			case "close":
				return this.teardown(effect.code);
			case "reconnect":
				this.teardown(4000);
				if (!effect.resume) this.unset("session_id", "resume_url", "seq");
				return this.scheduleReconnect(effect.delayMs + this.backoff());
			case "forget_session":
				return this.unset("session_id", "resume_url", "seq");
			case "fatal":
				return this.fatal(effect.reason);
		}
	}

	private send(payload: unknown) {
		try {
			this.#ws?.send(JSON.stringify(payload));
		} catch {
			this.#lastError = "websocket send failed";
		}
	}

	private teardown(code: number) {
		clearTimeout(this.#heartbeat);
		const socket = this.#ws;
		this.#ws = undefined;
		this.#conn = undefined;
		try {
			socket?.close(code, "bobik");
		} catch {
			// A socket already closing cannot be closed again.
		}
	}

	private fatal(reason: string) {
		this.teardown(1000);
		this.set("fatal", reason);
		this.#lastError = reason;
		console.error("gateway stopped", reason);
	}

	private backoff() {
		this.#reconnects += 1;
		return Math.min(60_000, 1_000 * 2 ** Math.min(this.#reconnects, 6));
	}

	private scheduleReconnect(delayMs: number) {
		clearTimeout(this.#reconnect);
		this.#reconnect = setTimeout(() => void this.link(), Math.max(0, delayMs));
	}

	private dispatch(name: string, data: unknown, seq: number | null) {
		switch (name) {
			case "READY": {
				const d = data as { session_id?: string; resume_gateway_url?: string; user?: { id?: string } };
				if (d.session_id && d.resume_gateway_url) {
					this.set("session_id", d.session_id);
					this.set("resume_url", d.resume_gateway_url);
				}
				if (snowflake(d.user?.id)) this.set("bot_id", d.user!.id!);
				this.set("last_ready_at", Date.now());
				this.#reconnects = 0;
				this.#lastAck = Date.now();
				break;
			}
			case "RESUMED":
				this.#reconnects = 0;
				break;
			case "GUILD_CREATE":
				this.learnGuild(data);
				break;
			case "GUILD_ROLE_CREATE":
			case "GUILD_ROLE_UPDATE":
				this.learnRole((data as { role?: unknown }).role);
				break;
			case "THREAD_CREATE":
			case "THREAD_UPDATE":
			case "CHANNEL_CREATE":
			case "CHANNEL_UPDATE":
				this.learnChannel(data);
				break;
			case "MESSAGE_CREATE":
				if (this.ingest(data, seq)) return;
				break;
		}
		this.checkpoint(seq);
	}

	/** Journals a relevant message and advances the resume cursor in one transaction. Returns whether it journaled. */
	ingest(data: unknown, seq: number | null): boolean {
		const message = inbound(data, this.view());
		if (!message) return false;
		const done = this.sql("SELECT 1 FROM gw_done WHERE message_id = ?", message.id).length > 0;
		this.ctx.storage.transactionSync(() => {
			if (!done) {
				this.sql(
					"INSERT OR IGNORE INTO gw_journal (message_id, payload, seq, state, next_at, created_at) VALUES (?, ?, ?, 'pending', ?, ?)",
					message.id,
					JSON.stringify(message),
					seq,
					Date.now(),
					Date.now(),
				);
			}
			if (seq !== null) this.set("seq", seq);
		});
		this.#lastCheckpoint = Date.now();
		void this.armAlarm(Date.now() + 1_000);
		void this.processJournal();
		return true;
	}

	private checkpoint(seq: number | null) {
		if (seq === null || Date.now() - this.#lastCheckpoint < IGNORED_CHECKPOINT_MS || !this.get("session_id")) return;
		this.set("seq", seq);
		this.#lastCheckpoint = Date.now();
	}

	private learnGuild(data: unknown) {
		const d = data as { roles?: unknown[]; channels?: unknown[]; threads?: unknown[] };
		for (const role of d.roles ?? []) this.learnRole(role);
		for (const channel of [...(d.channels ?? []), ...(d.threads ?? [])]) this.learnChannel(channel);
	}

	private learnRole(raw: unknown) {
		const role = raw as { id?: unknown; tags?: { bot_id?: unknown } };
		const botId = this.get("bot_id");
		if (!botId || typeof role.id !== "string" || role.tags?.bot_id !== botId) return;
		const roles = new Set(this.view().botRoles);
		if (roles.has(role.id)) return;
		roles.add(role.id);
		this.set("bot_roles", JSON.stringify([...roles]));
	}

	private learnChannel(raw: unknown) {
		const channel = raw as { id?: unknown; type?: unknown; parent_id?: unknown };
		if (typeof channel.id === "string" && typeof channel.type === "number") {
			this.#channels.set(channel.id, channelKind(channel.type, typeof channel.parent_id === "string" ? channel.parent_id : undefined));
		}
	}

	private async armAlarm(at: number) {
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > at) await this.ctx.storage.setAlarm(at);
	}

	/** Drains due journal rows, one at a time and in order. Serialized per object. */
	processJournal(): Promise<void> {
		const run = this.#processing.then(() => this.drainJournal());
		this.#processing = run.catch((error) => {
			this.#lastError = "journal processing failed";
			console.error("journal processing failed", error instanceof Error ? error.message : String(error));
		});
		return this.#processing;
	}

	private async drainJournal() {
		for (let i = 0; i < 20; i++) {
			const row = this.sql<JournalRow>("SELECT message_id, payload, attempts, next_at FROM gw_journal WHERE state = 'pending' ORDER BY created_at, message_id LIMIT 1")[0];
			if (!row) break;
			if (row.next_at > Date.now()) {
				await this.armAlarm(row.next_at);
				break;
			}
			let outcome: Outcome;
			try {
				outcome = await this.process(JSON.parse(row.payload) as Inbound, row.attempts);
			} catch (error) {
				outcome = { kind: "retry", delayMs: backoff(row.attempts), reason: error instanceof Error ? error.message.slice(0, 200) : "processing failed" };
			}
			if (outcome.kind === "done") {
				this.ctx.storage.transactionSync(() => {
					this.sql("DELETE FROM gw_journal WHERE message_id = ?", row.message_id);
					this.sql("INSERT OR REPLACE INTO gw_done (message_id, at) VALUES (?, ?)", row.message_id, Date.now());
				});
				continue;
			}
			const attempts = row.attempts + 1;
			this.#lastError = outcome.reason;
			if (attempts >= MAX_JOURNAL_ATTEMPTS) {
				this.sql("UPDATE gw_journal SET state = 'blocked', attempts = ?, reason = ? WHERE message_id = ?", attempts, outcome.reason, row.message_id);
				continue;
			}
			const nextAt = Date.now() + outcome.delayMs;
			this.sql("UPDATE gw_journal SET attempts = ?, next_at = ?, reason = ? WHERE message_id = ?", attempts, nextAt, outcome.reason, row.message_id);
			await this.armAlarm(nextAt);
			break;
		}
		this.sql("DELETE FROM gw_done WHERE at < ?", Date.now() - DONE_RETENTION_MS);
	}

	private async channel(id: string): Promise<ChannelKind | undefined> {
		const cached = this.#channels.get(id);
		if (cached) return cached;
		const result = await this.rest().channel(id);
		if (!result.ok) return undefined;
		const kind = channelKind(result.body.type, result.body.parent_id);
		this.#channels.set(id, kind);
		return kind;
	}

	private async process(message: Inbound, attempts: number): Promise<Outcome> {
		const bound = this.#bound.has(message.channelId);
		let channel: ChannelKind | undefined;
		if (!bound && message.mentioned && message.allowed) {
			channel = await this.channel(message.channelId);
			if (!channel) return { kind: "retry", delayMs: backoff(attempts), reason: "channel lookup failed" };
		}
		const target = route(message, channel, bound, accessFrom(this.env));
		switch (target.kind) {
			case "ignore":
				return DONE;
			case "reply": {
				const sent = await this.rest().sendMessage(message.channelId, target.text, await nonceFor(`reply:${message.id}`), message.id);
				if (sent.ok || (sent.kind === "rejected" && (sent.status === 403 || sent.status === 404))) return DONE;
				return retryFor(sent, "reply", attempts);
			}
			case "converse": {
				if (target.open === "start") {
					const opened = await this.openThread(message, target.title, attempts);
					if (opened.kind !== "done") return opened;
				}
				if (target.open !== "bound") this.bind(target.threadId);
				const input: ThreadInput = {
					messageId: message.id,
					threadId: target.threadId,
					authorId: message.authorId,
					authorName: message.authorName,
					action: target.action,
					attachments: message.attachments,
				};
				const admission = await this.env.CONVERSATIONS.getByName(target.threadId).accept(input);
				const emoji = target.open === "start" ? "👀" : admission.reaction;
				if (emoji) await this.rest().react(message.channelId, message.id, emoji);
				return DONE;
			}
		}
	}

	/** Creates the thread on the source message, so its id is the message id and a retry can find it again. */
	private async openThread(message: Inbound, title: string, attempts: number): Promise<Outcome> {
		if (this.#bound.has(message.id)) return DONE;
		const created = await this.rest().startThread(message.channelId, message.id, title);
		if (created.ok) return DONE;
		if (created.kind === "rejected" && created.code === THREAD_ALREADY_CREATED) return DONE;
		if (created.kind === "unavailable") {
			const found = await this.rest().channel(message.id);
			if (found.ok) return DONE;
		}
		return retryFor(created, "thread creation", attempts);
	}

	private bind(threadId: Snowflake) {
		if (this.#bound.has(threadId)) return;
		this.sql("INSERT OR IGNORE INTO gw_threads (thread_id, created_at) VALUES (?, ?)", threadId, Date.now());
		this.#bound.add(threadId);
	}
}
