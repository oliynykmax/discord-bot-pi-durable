import { describe, expect, test } from "vitest";
import { HELP } from "../src/domain.ts";
import type { Access, Snowflake } from "../src/env.ts";
import { DENIED, inbound, route, type View } from "../src/discord/routing.ts";

const BOT = "111111111111111111" as Snowflake;
const BOT_ROLE = "222222222222222222";
const ALLOWED = "100000000000000001";
const STRANGER = "100000000000000009";
const CHANNEL = "500000000000000001";
const THREAD = "600000000000000001";

const access = (users: string[] = [ALLOWED], roles: string[] = [], channels: string[] = []): Access => ({
	users: new Set(users as Snowflake[]),
	roles: new Set(roles as Snowflake[]),
	channels: new Set(channels as Snowflake[]),
});
const view = (a = access(), bound: string[] = []): View => ({ botId: BOT, botRoles: new Set([BOT_ROLE]), bound: (id) => bound.includes(id), access: a });
let next = 700000000000000000n;
const message = (over: Record<string, unknown> = {}) => ({
	id: String(++next),
	channel_id: CHANNEL,
	guild_id: "800000000000000001",
	author: { id: ALLOWED, username: "ana" },
	member: { roles: [] },
	content: `<@${BOT}> fix the empty state`,
	mentions: [{ id: BOT }],
	mention_roles: [],
	attachments: [],
	...over,
});

describe("authorization at ingress", () => {
	test("an allowed mention is journaled with the mention stripped", () => {
		expect(inbound(message(), view())).toMatchObject({ allowed: true, mentioned: true, text: "fix the empty state" });
	});

	test("a stranger's mention is kept only to deny it", () => {
		const m = inbound(message({ author: { id: STRANGER } }), view())!;
		expect(m.allowed).toBe(false);
		expect(route(m, { kind: "text" }, false, access())).toEqual({ kind: "reply", text: DENIED });
	});

	test("an empty allowlist denies everyone", () => {
		const a = access([]);
		const m = inbound(message(), view(a))!;
		expect(route(m, { kind: "text" }, false, a)).toEqual({ kind: "reply", text: DENIED });
	});

	test("strangers in bound threads without a mention are dropped before journaling", () => {
		expect(inbound(message({ channel_id: THREAD, author: { id: STRANGER }, content: "hi", mentions: [] }), view(access(), [THREAD]))).toBeUndefined();
	});

	test("bots, webhooks, DMs and unrelated messages are dropped", () => {
		expect(inbound(message({ author: { id: ALLOWED, bot: true } }), view())).toBeUndefined();
		expect(inbound(message({ webhook_id: "1" }), view())).toBeUndefined();
		expect(inbound(message({ guild_id: undefined }), view())).toBeUndefined();
		expect(inbound(message({ content: "hello team", mentions: [] }), view())).toBeUndefined();
	});

	test("allowed roles and the bot's managed role mention count", () => {
		const a = access([], ["900000000000000001"]);
		const m = inbound(message({ author: { id: STRANGER }, member: { roles: ["900000000000000001"] }, content: `<@&${BOT_ROLE}> hi`, mentions: [], mention_roles: [BOT_ROLE] }), view(a))!;
		expect(m).toMatchObject({ allowed: true, mentioned: true, text: "hi" });
	});
});

describe("routing", () => {
	const allowed = (over: Record<string, unknown> = {}, bound: string[] = []) => inbound(message(over), view(access(), bound))!;

	test("a mention in a text channel starts a thread on the source message", () => {
		const m = allowed();
		expect(route(m, { kind: "text" }, false, access())).toMatchObject({ kind: "converse", open: "start", threadId: m.id, action: { kind: "say" } });
	});

	test("a mention in an unbound thread binds that thread", () => {
		expect(route(allowed({ channel_id: THREAD }), { kind: "thread", parentId: CHANNEL }, false, access())).toMatchObject({ kind: "converse", open: "bind", threadId: THREAD });
	});

	test("a reply in a bound thread needs no mention", () => {
		const m = allowed({ channel_id: THREAD, content: "also add tests", mentions: [] }, [THREAD]);
		expect(route(m, undefined, true, access())).toMatchObject({ kind: "converse", open: "bound", action: { kind: "say", text: "also add tests" } });
	});

	test("commands route to the conversation without becoming prompts", () => {
		const m = allowed({ channel_id: THREAD, content: "!stop", mentions: [] }, [THREAD]);
		expect(route(m, undefined, true, access())).toMatchObject({ action: { kind: "stop" } });
	});

	test("an empty mention shows help", () => {
		expect(route(allowed({ content: `<@${BOT}>` }), { kind: "text" }, false, access())).toEqual({ kind: "reply", text: HELP });
	});

	test("channel restriction applies to unbound channels only", () => {
		const a = access([ALLOWED], [], ["500000000000000099"]);
		expect(route(allowed(), { kind: "text" }, false, a)).toEqual({ kind: "ignore" });
		const m = allowed({ channel_id: THREAD, content: "hi", mentions: [] }, [THREAD]);
		expect(route(m, undefined, true, a).kind).toBe("converse");
	});

	test("other channel kinds get a pointer to text channels", () => {
		expect(route(allowed(), { kind: "other" }, false, access())).toEqual({ kind: "reply", text: "Tag me in a text channel or in a thread." });
	});
});
