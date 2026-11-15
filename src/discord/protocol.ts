export const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

export const FATAL_CLOSE_CODES: ReadonlyMap<number, string> = new Map([
	[4004, "authentication failed"],
	[4010, "invalid shard"],
	[4011, "sharding required"],
	[4012, "invalid API version"],
	[4013, "invalid intents"],
	[4014, "disallowed intents: enable Message Content for the bot"],
]);
const FRESH_SESSION_CLOSE_CODES = new Set([4007, 4009]);

export type Frame = { readonly op: number; readonly d?: unknown; readonly s?: number | null; readonly t?: string | null };

export type Phase = "handshake" | "identifying" | "resuming" | "ready";

export type Connection = {
	readonly phase: Phase;
	readonly heartbeatMs: number | undefined;
	readonly awaitingAck: boolean;
	readonly seq: number | null;
	readonly canResume: boolean;
};

export type GatewayEvent =
	| { readonly type: "frame"; readonly frame: Frame; readonly jitter: number }
	| { readonly type: "heartbeat_due" }
	| { readonly type: "closed"; readonly code: number; readonly jitter: number };

export type Effect =
	| { readonly type: "heartbeat"; readonly seq: number | null }
	| { readonly type: "identify" }
	| { readonly type: "resume"; readonly seq: number | null }
	| { readonly type: "schedule_heartbeat"; readonly delayMs: number }
	| { readonly type: "dispatch"; readonly name: string; readonly data: unknown; readonly seq: number | null }
	| { readonly type: "close"; readonly code: number }
	| { readonly type: "reconnect"; readonly resume: boolean; readonly delayMs: number }
	| { readonly type: "forget_session" }
	| { readonly type: "fatal"; readonly reason: string };

export const connection = (canResume: boolean, seq: number | null): Connection => ({
	phase: "handshake",
	heartbeatMs: undefined,
	awaitingAck: false,
	seq,
	canResume,
});

const RESUMABLE_RECONNECT_CODE = 4000;

/** The gateway protocol as a pure step: the Durable Object only performs the effects. */
export function step(state: Connection, event: GatewayEvent): [Connection, Effect[]] {
	switch (event.type) {
		case "heartbeat_due": {
			if (state.heartbeatMs === undefined) return [state, []];
			if (state.awaitingAck) {
				return [state, [{ type: "close", code: RESUMABLE_RECONNECT_CODE }, { type: "reconnect", resume: true, delayMs: 0 }]];
			}
			return [
				{ ...state, awaitingAck: true },
				[
					{ type: "heartbeat", seq: state.seq },
					{ type: "schedule_heartbeat", delayMs: state.heartbeatMs },
				],
			];
		}
		case "closed": {
			const fatal = FATAL_CLOSE_CODES.get(event.code);
			if (fatal) return [state, [{ type: "forget_session" }, { type: "fatal", reason: `Discord closed the gateway with ${event.code}: ${fatal}` }]];
			if (FRESH_SESSION_CLOSE_CODES.has(event.code)) {
				return [state, [{ type: "forget_session" }, { type: "reconnect", resume: false, delayMs: 1_000 + Math.floor(event.jitter * 4_000) }]];
			}
			return [state, [{ type: "reconnect", resume: state.canResume, delayMs: 1_000 + Math.floor(event.jitter * 4_000) }]];
		}
		case "frame":
			return onFrame(state, event.frame, event.jitter);
	}
}

function onFrame(state: Connection, frame: Frame, jitter: number): [Connection, Effect[]] {
	switch (frame.op) {
		case 10: {
			const interval = (frame.d as { heartbeat_interval?: unknown } | undefined)?.heartbeat_interval;
			if (typeof interval !== "number" || interval <= 0) {
				return [state, [{ type: "close", code: RESUMABLE_RECONNECT_CODE }, { type: "reconnect", resume: state.canResume, delayMs: 5_000 }]];
			}
			const start: Effect = state.canResume ? { type: "resume", seq: state.seq } : { type: "identify" };
			return [
				{ ...state, phase: state.canResume ? "resuming" : "identifying", heartbeatMs: interval, awaitingAck: false },
				[{ type: "schedule_heartbeat", delayMs: Math.floor(interval * jitter) }, start],
			];
		}
		case 11:
			return [{ ...state, awaitingAck: false }, []];
		case 1:
			return [state, [{ type: "heartbeat", seq: state.seq }]];
		case 7:
			return [state, [{ type: "close", code: RESUMABLE_RECONNECT_CODE }, { type: "reconnect", resume: state.canResume, delayMs: 0 }]];
		case 9: {
			const resumable = frame.d === true && state.canResume;
			const delayMs = 1_000 + Math.floor(jitter * 4_000);
			return [
				state,
				[
					...(resumable ? [] : [{ type: "forget_session" } as const]),
					{ type: "close", code: RESUMABLE_RECONNECT_CODE },
					{ type: "reconnect", resume: resumable, delayMs },
				],
			];
		}
		case 0: {
			const seq = typeof frame.s === "number" ? frame.s : state.seq;
			const name = frame.t ?? "";
			const phase = name === "READY" || name === "RESUMED" ? "ready" : state.phase;
			const canResume = name === "READY" ? true : state.canResume;
			return [{ ...state, seq, phase, canResume }, [{ type: "dispatch", name, data: frame.d, seq }]];
		}
		default:
			return [state, []];
	}
}
