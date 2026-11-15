import { chunk, nonceFor, snowflakeAt } from "./domain.ts";
import type { DiscordRest } from "./discord/rest.ts";

/** Discord rejects a repeated nonce for only a few minutes, so a retry inside this window cannot duplicate a message. */
export const NONCE_WINDOW_MS = 120_000;
const MAX_SENDS_PER_DRAIN = 10;
const MAX_ATTEMPTS = 8;

type Row = {
	seq: number;
	group_id: string;
	part: number;
	content: string;
	reply_to: string | null;
	state: "pending" | "sending" | "sent" | "uncertain" | "blocked";
	generation: number;
	attempts: number;
	attempted_at: number | null;
	retry_at: number;
};

export type OutboxProblems = { readonly blocked: number; readonly uncertain: number; readonly pending: number };

export const OUTBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS bobik_outbox (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	group_id TEXT NOT NULL,
	part INTEGER NOT NULL,
	content TEXT NOT NULL,
	reply_to TEXT,
	state TEXT NOT NULL,
	generation INTEGER NOT NULL DEFAULT 0,
	attempts INTEGER NOT NULL DEFAULT 0,
	attempted_at INTEGER,
	retry_at INTEGER NOT NULL,
	message_id TEXT,
	reason TEXT,
	UNIQUE (group_id, part)
);
CREATE INDEX IF NOT EXISTS bobik_outbox_due ON bobik_outbox (state, retry_at);
`;

const backoff = (attempts: number) => Math.min(10 * 60_000, 5_000 * 3 ** Math.max(0, attempts - 1));

/**
 * Per-part delivery records for one Discord channel. Each group is written whole before any part is sent, parts go
 * out in order, and every attempt carries a deterministic nonce with `enforce_nonce`. A send whose outcome is unknown
 * after the nonce window is reconciled against channel history; if that cannot settle it, the part is marked
 * `uncertain` instead of being posted blindly again.
 */
export class Outbox {
	#tail: Promise<void> = Promise.resolve();

	constructor(
		private readonly sql: SqlStorage,
		private readonly rest: () => DiscordRest,
		private readonly channelId: () => string,
	) {}

	has(group: string): boolean {
		return this.sql.exec("SELECT 1 FROM bobik_outbox WHERE group_id = ? LIMIT 1", group).toArray().length > 0;
	}

	/** Writes every part of a group, or nothing when the group exists. Call inside the caller's transaction. */
	enqueue(group: string, text: string, replyTo?: string, now = Date.now()): void {
		if (this.has(group)) return;
		for (const [part, content] of chunk(text).entries()) {
			this.sql.exec(
				"INSERT INTO bobik_outbox (group_id, part, content, reply_to, state, retry_at) VALUES (?, ?, ?, ?, 'pending', ?)",
				group,
				part,
				content,
				part === 0 ? (replyTo ?? null) : null,
				now,
			);
		}
	}

	problems(): OutboxProblems {
		const rows = this.sql.exec<{ state: string; n: number }>("SELECT state, COUNT(*) AS n FROM bobik_outbox WHERE state IN ('blocked', 'uncertain', 'pending', 'sending') GROUP BY state").toArray();
		const count = (s: string) => rows.find((r) => r.state === s)?.n ?? 0;
		return { blocked: count("blocked"), uncertain: count("uncertain"), pending: count("pending") + count("sending") };
	}

	/** Sends due parts. Returns when the next part is due, or undefined when nothing is waiting. Serialized per object. */
	drain(clock: () => number = Date.now): Promise<number | undefined> {
		const run = this.#tail.then(() => this.#drain(clock));
		this.#tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	#next(): Row | undefined {
		return this.sql.exec<Row>("SELECT * FROM bobik_outbox WHERE state IN ('pending', 'sending') ORDER BY seq LIMIT 1").toArray()[0];
	}

	#settleGroup(row: Row, state: "blocked" | "uncertain", reason: string) {
		this.sql.exec("UPDATE bobik_outbox SET state = ?, reason = ? WHERE group_id = ? AND part >= ? AND state IN ('pending', 'sending')", state, reason, row.group_id, row.part);
	}

	async #drain(clock: () => number): Promise<number | undefined> {
		for (let sends = 0; sends < MAX_SENDS_PER_DRAIN; sends++) {
			const row = this.#next();
			if (!row) return undefined;
			const now = clock();
			if (row.retry_at > now) return row.retry_at;

			if (row.state === "sending" && row.attempted_at !== null && now - row.attempted_at >= NONCE_WINDOW_MS) {
				const outcome = await this.#reconcile(row);
				if (outcome === "retry") return this.#next()?.retry_at;
				continue;
			}

			const nonce = await nonceFor(`${row.group_id}:${row.part}:${row.generation}`);
			if (row.state === "pending") {
				this.sql.exec("UPDATE bobik_outbox SET state = 'sending', attempted_at = ? WHERE seq = ?", now, row.seq);
			}
			const result = await this.rest().sendMessage(this.channelId(), row.content, nonce, row.reply_to ?? undefined);
			if (result.ok) {
				this.sql.exec("UPDATE bobik_outbox SET state = 'sent', message_id = ?, reason = NULL WHERE seq = ?", result.body.id, row.seq);
				continue;
			}
			if (result.kind === "rate_limited") {
				this.sql.exec("UPDATE bobik_outbox SET retry_at = ? WHERE seq = ?", clock() + result.retryAfterMs, row.seq);
				return clock() + result.retryAfterMs;
			}
			if (result.kind === "rejected") {
				const reason = result.status === 403 ? "permission" : result.status === 404 ? "missing-channel" : `rejected-${result.status}`;
				this.#settleGroup(row, "blocked", reason);
				continue;
			}
			const attempts = row.attempts + 1;
			if (attempts >= MAX_ATTEMPTS) {
				this.#settleGroup(row, "uncertain", "retry-limit");
				continue;
			}
			const retryAt = clock() + backoff(attempts);
			this.sql.exec("UPDATE bobik_outbox SET attempts = ?, retry_at = ? WHERE seq = ?", attempts, retryAt, row.seq);
			return retryAt;
		}
		return this.#next()?.retry_at;
	}

	/** An attempt older than the nonce window: look for it in channel history before deciding to send again. */
	async #reconcile(row: Row): Promise<"settled" | "retry"> {
		const history = await this.rest().messagesAfter(this.channelId(), snowflakeAt((row.attempted_at ?? 0) - 5_000));
		if (!history.ok) {
			if (history.kind === "rejected") {
				this.#settleGroup(row, "blocked", history.status === 403 ? "permission" : "missing-channel");
				return "settled";
			}
			const delay = history.kind === "rate_limited" ? history.retryAfterMs : backoff(row.attempts + 1);
			this.sql.exec("UPDATE bobik_outbox SET attempts = attempts + 1, retry_at = ? WHERE seq = ?", Date.now() + delay, row.seq);
			if (row.attempts + 1 >= MAX_ATTEMPTS) this.#settleGroup(row, "uncertain", "history-unavailable");
			return "retry";
		}
		const nonce = await nonceFor(`${row.group_id}:${row.part}:${row.generation}`);
		const found = history.body.find((m) => m.nonce === nonce || m.content === row.content);
		if (found) {
			this.sql.exec("UPDATE bobik_outbox SET state = 'sent', message_id = ? WHERE seq = ?", found.id, row.seq);
			return "settled";
		}
		if (history.body.length >= 100) {
			this.#settleGroup(row, "uncertain", "history-too-long");
			return "settled";
		}
		this.sql.exec("UPDATE bobik_outbox SET state = 'pending', generation = generation + 1, attempted_at = NULL WHERE seq = ?", row.seq);
		return "settled";
	}
}
