import { describe, expect, test } from "vitest";
import { connection, type Connection, type GatewayEvent, step } from "../src/discord/protocol.ts";

const run = (state: Connection, ...events: GatewayEvent[]) => {
	const effects = [];
	for (const event of events) {
		const [next, out] = step(state, event);
		state = next;
		effects.push(...out);
	}
	return { state, effects };
};
const frame = (op: number, d?: unknown, s?: number, t?: string): GatewayEvent => ({ type: "frame", frame: { op, d, s: s ?? null, t: t ?? null }, jitter: 0.5 });

describe("gateway protocol", () => {
	test("hello without a session identifies and schedules a jittered heartbeat", () => {
		const { state, effects } = run(connection(false, null), frame(10, { heartbeat_interval: 40_000 }));
		expect(effects).toEqual([{ type: "schedule_heartbeat", delayMs: 20_000 }, { type: "identify" }]);
		expect(state.phase).toBe("identifying");
	});

	test("hello with a stored session resumes from the stored sequence", () => {
		const { effects } = run(connection(true, 41), frame(10, { heartbeat_interval: 40_000 }));
		expect(effects[1]).toEqual({ type: "resume", seq: 41 });
	});

	test("heartbeats carry the latest sequence and an acked heartbeat keeps the socket", () => {
		const { effects } = run(
			connection(false, null),
			frame(10, { heartbeat_interval: 1000 }),
			frame(0, { session_id: "s" }, 1, "READY"),
			{ type: "heartbeat_due" },
			frame(11),
			{ type: "heartbeat_due" },
		);
		expect(effects.filter((e) => e.type === "heartbeat")).toEqual([
			{ type: "heartbeat", seq: 1 },
			{ type: "heartbeat", seq: 1 },
		]);
		expect(effects.some((e) => e.type === "reconnect")).toBe(false);
	});

	test("a missed heartbeat ack closes and resumes", () => {
		const { effects } = run(connection(true, 5), frame(10, { heartbeat_interval: 1000 }), { type: "heartbeat_due" }, { type: "heartbeat_due" });
		expect(effects.slice(-2)).toEqual([
			{ type: "close", code: 4000 },
			{ type: "reconnect", resume: true, delayMs: 0 },
		]);
	});

	test("a server heartbeat request is answered at once", () => {
		const { effects } = run(connection(true, 9), frame(1));
		expect(effects).toEqual([{ type: "heartbeat", seq: 9 }]);
	});

	test("op 7 reconnects with resume", () => {
		const { effects } = run(connection(true, 9), frame(7));
		expect(effects).toContainEqual({ type: "reconnect", resume: true, delayMs: 0 });
	});

	test("invalid session that is resumable resumes; otherwise the session is forgotten", () => {
		expect(run(connection(true, 3), frame(9, true)).effects).toContainEqual({ type: "reconnect", resume: true, delayMs: 3000 });
		const fresh = run(connection(true, 3), frame(9, false)).effects;
		expect(fresh[0]).toEqual({ type: "forget_session" });
		expect(fresh).toContainEqual({ type: "reconnect", resume: false, delayMs: 3000 });
	});

	test.each([4004, 4010, 4011, 4012, 4013, 4014])("close %i is fatal and does not reconnect", (code) => {
		const { effects } = run(connection(true, 3), { type: "closed", code, jitter: 0 });
		expect(effects.some((e) => e.type === "reconnect")).toBe(false);
		expect(effects.some((e) => e.type === "fatal")).toBe(true);
	});

	test.each([4007, 4009])("close %i starts a fresh session", (code) => {
		const { effects } = run(connection(true, 3), { type: "closed", code, jitter: 0 });
		expect(effects).toEqual([{ type: "forget_session" }, { type: "reconnect", resume: false, delayMs: 1000 }]);
	});

	test("an abnormal close resumes", () => {
		expect(run(connection(true, 3), { type: "closed", code: 1006, jitter: 0 }).effects).toEqual([{ type: "reconnect", resume: true, delayMs: 1000 }]);
	});

	test("READY makes the connection resumable and dispatches carry their sequence", () => {
		const { state, effects } = run(connection(false, null), frame(0, { session_id: "s" }, 7, "READY"));
		expect(state).toMatchObject({ phase: "ready", canResume: true, seq: 7 });
		expect(effects).toEqual([{ type: "dispatch", name: "READY", data: { session_id: "s" }, seq: 7 }]);
	});
});
