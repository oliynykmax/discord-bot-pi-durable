import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Conversation } from "../src/conversation.ts";
import { type Action, nonceFor, operationId, type ThreadInput } from "../src/domain.ts";
import type { Snowflake } from "../src/env.ts";
import { NONCE_WINDOW_MS } from "../src/outbox.ts";
import { eventually, FakeNet } from "./net.ts";

const AUTHOR = "100000000000000001" as Snowflake;
let threadSeq = 300000000000000000n;
const newThread = () => String(++threadSeq) as Snowflake;
let messageSeq = 400000000000000000n;
const newMessage = () => String(++messageSeq) as Snowflake;

const input = (threadId: Snowflake, action: Action, messageId = newMessage()): ThreadInput => ({
	messageId,
	threadId,
	authorId: AUTHOR,
	authorName: "ana",
	action,
	attachments: [],
});

const say = (text: string): Action => ({ kind: "say", text });

function gate() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => (open = resolve));
	return { open, opened };
}

async function until<T>(stub: DurableObjectStub<Conversation>, probe: () => T | Promise<T>, ok: (value: T) => boolean) {
	return eventually(
		async () => {
			await runDurableObjectAlarm(stub);
			return probe();
		},
		ok,
	);
}

const inputs = (stub: DurableObjectStub<Conversation>) =>
	runInDurableObject(stub, (_o, state) => state.storage.sql.exec<{ message_id: string; role: string; stage: string; reaction: string }>("SELECT message_id, role, stage, reaction FROM bobik_inputs ORDER BY created_at").toArray());

const outbox = (stub: DurableObjectStub<Conversation>) =>
	runInDurableObject(stub, (_o, state) => state.storage.sql.exec<{ group_id: string; part: number; state: string; reason: string | null; generation: number }>("SELECT group_id, part, state, reason, generation FROM bobik_outbox ORDER BY seq").toArray());

afterEach(() => vi.restoreAllMocks());

describe("conversation", () => {
	test("a message runs through PiHarness and Verda and its answer is delivered once", async () => {
		const net = new FakeNet().install().reply({ text: "Hello from kimi", reasoning: "thinking" });
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		expect(await stub.accept(input(thread, say("hi")))).toEqual({ duplicate: false, reaction: "✅" });
		const sent = await until(stub, () => net.sent(thread), (s) => s.length === 1);
		expect(sent[0]!.body).toMatchObject({ content: "Hello from kimi", enforce_nonce: true, allowed_mentions: { parse: [], replied_user: false } });
		expect(net.modelRequests[0]).toMatchObject({ model: "kimi-k3-1-pro", max_tokens: 131072, reasoning_effort: "low", stream: true });
	});

	test("the same Discord message admitted twice, even concurrently, is one Pi operation and one reply", async () => {
		const net = new FakeNet().install().reply({ text: "once" });
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		const message = input(thread, say("hi"));
		const [a, b] = await Promise.all([stub.accept(message), stub.accept(message)]);
		expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
		await until(stub, () => net.sent(thread), (s) => s.length === 1);
		expect(await stub.accept(message)).toEqual({ duplicate: true, reaction: "✅" });
		for (let i = 0; i < 3; i++) await runDurableObjectAlarm(stub);
		expect(net.modelRequests).toHaveLength(1);
		expect(net.sent(thread)).toHaveLength(1);
	});

	test("a reply during a run steers it and the run posts one answer", async () => {
		const first = gate();
		const net = new FakeNet().install();
		net.on((call) => (call.url.includes("github.test") ? Response.json({ message: "Bad credentials" }, { status: 401 }) : undefined));
		net.reply(async () => {
			await first.opened;
			return { tool: "github_list_files", args: {} };
		}, { text: "Done with both requests" });
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		await stub.accept(input(thread, say("list the files")));
		await eventually(() => net.modelRequests.length, (n) => n === 1);
		expect(await stub.accept(input(thread, say("and mention the README")))).toEqual({ duplicate: false, reaction: "✅" });
		first.open();
		const sent = await until(stub, () => net.sent(thread), (s) => s.length >= 1);
		for (let i = 0; i < 3; i++) await runDurableObjectAlarm(stub);
		expect(net.sent(thread)).toHaveLength(1);
		expect(sent[0]!.body.content).toBe("Done with both requests");
		expect(JSON.stringify(net.modelRequests[1].messages)).toContain("and mention the README");
		const rows = await inputs(stub);
		expect(rows.map((r) => [r.role, r.stage])).toEqual([
			["leader", "settled"],
			["steer", "settled"],
		]);
	});

	test("!queue during a run waits and gets its own answer after the first", async () => {
		const first = gate();
		const net = new FakeNet().install();
		net.reply(async () => {
			await first.opened;
			return { text: "first answer" };
		}, { text: "second answer" });
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		await stub.accept(input(thread, say("one")));
		await eventually(() => net.modelRequests.length, (n) => n === 1);
		expect(await stub.accept(input(thread, { kind: "queue", text: "two" }))).toEqual({ duplicate: false, reaction: "📥" });
		first.open();
		const sent = await until(stub, () => net.sent(thread), (s) => s.length === 2);
		expect(sent.map((c) => c.body.content)).toEqual(["first answer", "second answer"]);
		expect(JSON.stringify(net.modelRequests[0].messages)).not.toContain("two");
	});

	test("idle status skips repo framing and old PR metadata does not decorate unrelated replies", async () => {
		const net = new FakeNet().install().reply({ text: "Pasta it is" });
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		await stub.accept(input(thread, { kind: "status" }));
		const status = await until(stub, () => net.sent(thread), (s) => s.length === 1);
		expect(status[0]!.body.content).not.toContain("Branch");
		await runInDurableObject(stub, (_o, state) => {
			state.storage.sql.exec("INSERT INTO bobik_meta (key, value) VALUES ('pr', ?)", JSON.stringify({ number: 7, url: "https://github.test/pr/7" }));
		});
		await stub.accept(input(thread, say("what should we cook tonight?")));
		const sent = await until(stub, () => net.sent(thread), (s) => s.length === 2);
		expect(sent[1]!.body.content).toBe("Pasta it is");
	});

	test("commands answer without a model call", async () => {
		const net = new FakeNet().install();
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		await stub.accept(input(thread, { kind: "status" }));
		await stub.accept(input(thread, { kind: "help" }));
		await stub.accept(input(thread, { kind: "unsupported", command: "!model" }));
		await stub.accept(input(thread, { kind: "invalid", reason: "`!queue` needs text." }));
		await stub.accept(input(thread, { kind: "stop" }));
		const sent = await until(stub, () => net.sent(thread), (s) => s.length === 5);
		expect(sent[0]!.body.content).toContain("Idle. Model kimi-k3-1-pro");
		expect(sent[0]!.body.message_reference).toBeDefined();
		expect(sent[4]!.body.content).toBe("Nothing was running.");
		expect(net.modelRequests).toHaveLength(0);
	});

	test("!stop aborts the run and drops queued input with one acknowledgement", async () => {
		const hold = gate();
		const net = new FakeNet().install();
		net.reply(async () => {
			await hold.opened;
			return { text: "too late" };
		});
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		await stub.accept(input(thread, say("long job")));
		await eventually(() => net.modelRequests.length, (n) => n === 1);
		await stub.accept(input(thread, { kind: "queue", text: "later" }));
		expect(await stub.accept(input(thread, { kind: "stop" }))).toEqual({ duplicate: false, reaction: "⏹" });
		hold.open();
		const sent = await until(stub, () => net.sent(thread), (s) => s.length >= 1);
		await until(stub, () => inputs(stub), (rows) => rows.every((r) => r.stage === "settled"));
		for (let i = 0; i < 3; i++) await runDurableObjectAlarm(stub);
		expect(net.sent(thread).map((c) => c.body.content)).toEqual(["⏹ Stopped. Queued messages were dropped."]);
		expect(sent).toHaveLength(1);
		expect(net.modelRequests).toHaveLength(1);
	});

	test("input admitted before a crash but never handed to Pi is submitted after restart", async () => {
		const net = new FakeNet().install().reply({ text: "recovered answer" });
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		const message = input(thread, say("survive the crash"));
		await runInDurableObject<Conversation, void>(stub, async (instance) => {
			const object = instance as any;
			await object.lifecycle.start();
			object.insertInput(message, "received");
			await object.host.jobs.push({ id: "admit", fn: "admit", time: Date.now() });
		});
		await evictDurableObject(stub);
		await until(stub, () => net.sent(thread), (s) => s.length === 1);
		expect(net.sent(thread)[0]!.body.content).toBe("recovered answer");
		expect((await inputs(stub))[0]).toMatchObject({ stage: "settled", role: "leader" });
		expect(await stub.accept(message)).toMatchObject({ duplicate: true });
	});

	test("a run interrupted by eviction resumes and its reply is still delivered", async () => {
		const hold = gate();
		const net = new FakeNet().install();
		net.reply(async () => {
			await hold.opened;
			return { text: "never seen" };
		}, { text: "answer after restart" });
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		await stub.accept(input(thread, say("work through a restart")));
		await eventually(() => net.modelRequests.length, (n) => n === 1);
		await runInDurableObject(stub, (_o, state) => state.abort("simulated crash")).catch(() => undefined);
		hold.open();
		const restarted = env.CONVERSATIONS.getByName(thread);
		const sent = await until(restarted, () => net.sent(thread), (s) => s.length === 1);
		expect(sent[0]!.body.content).toBe("answer after restart");
		expect(net.modelRequests).toHaveLength(2);
	}, 60_000);

	test("a Discord send cut off before its result is retried with the same nonce and creates one message", async () => {
		const net = new FakeNet().install().reply({ text: "deliver me" });
		let failures = 1;
		net.on((call) => {
			if (call.method === "POST" && call.url.includes("/messages") && call.url.includes("discord.test") && failures > 0) {
				failures--;
				return new Response("bad gateway", { status: 502 });
			}
			return undefined;
		});
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		await stub.accept(input(thread, say("hi")));
		await eventually(() => outbox(stub), (rows) => rows.length === 1 && rows[0]!.state === "sending");
		await evictDurableObject(stub);
		await runInDurableObject(stub, (_o, state) => state.storage.sql.exec("UPDATE bobik_outbox SET retry_at = 0"));
		await until(stub, () => outbox(stub), (rows) => rows[0]!.state === "sent");
		const attempts = net.sent(thread);
		expect(attempts).toHaveLength(2);
		expect(attempts[0]!.body.nonce).toBe(attempts[1]!.body.nonce);
		expect(net.nonces.size).toBe(1);
	});

	test("429 waits for retry_after instead of failing the reply", async () => {
		const net = new FakeNet().install().reply({ text: "rate limited reply" });
		let limited = true;
		net.on((call) => {
			if (call.method === "POST" && call.url.includes("discord.test") && call.url.endsWith("/messages") && limited) {
				limited = false;
				return Response.json({ message: "You are being rate limited.", retry_after: 0.2, global: false }, { status: 429 });
			}
			return undefined;
		});
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		await stub.accept(input(thread, say("hi")));
		await until(stub, () => outbox(stub), (rows) => rows[0]?.state === "sent");
		expect(net.sent(thread)).toHaveLength(2);
	});

	test("a send older than the nonce window is reconciled from channel history, not posted blindly", async () => {
		const net = new FakeNet().install();
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		let history: unknown[] = [];
		net.on((call) => (call.method === "GET" && call.url.includes(`/channels/${thread}/messages?after=`) ? Response.json(history) : undefined));
		const seed = (content: string) =>
			runInDurableObject<Conversation, void>(stub, (object, state) => {
				state.storage.sql.exec("DELETE FROM bobik_outbox");
				object.outbox.enqueue("answer:test", content);
				state.storage.sql.exec("UPDATE bobik_outbox SET state = 'sending', attempted_at = ?", Date.now() - NONCE_WINDOW_MS - 1_000);
			});
		const drain = () => runInDurableObject<Conversation, number | undefined>(stub, (object) => object.outbox.drain());

		await seed("already posted");
		history = [{ id: "910000000000000001", channel_id: thread, content: "already posted", nonce: await nonceFor("answer:test:0:0") }];
		await drain();
		expect((await outbox(stub))[0]).toMatchObject({ state: "sent" });
		expect(net.sent(thread)).toHaveLength(0);

		await seed("never arrived");
		history = [{ id: "910000000000000002", channel_id: thread, content: "never arrived", nonce: "someone-elses-message" }];
		await drain();
		expect((await outbox(stub))[0]).toMatchObject({ state: "sent", generation: 1 });
		expect(net.sent(thread)).toHaveLength(1);

		await seed("cannot tell");
		history = Array.from({ length: 100 }, (_, i) => ({ id: String(920000000000000000n + BigInt(i)), channel_id: thread, content: "noise" }));
		await drain();
		expect((await outbox(stub))[0]).toMatchObject({ state: "uncertain", reason: "history-too-long" });
		expect(net.sent(thread)).toHaveLength(1);
	});

	test("a missing channel blocks delivery visibly and !status reports it", async () => {
		const net = new FakeNet().install().reply({ text: "nowhere to go" });
		const thread = newThread();
		let gone = true;
		net.on((call) => (gone && call.method === "POST" && call.url.includes(`/channels/${thread}/messages`) ? Response.json({ code: 10003, message: "Unknown Channel" }, { status: 404 }) : undefined));
		const stub = env.CONVERSATIONS.getByName(thread);
		await stub.accept(input(thread, say("hi")));
		await until(stub, () => outbox(stub), (rows) => rows[0]?.state === "blocked");
		gone = false;
		await stub.accept(input(thread, { kind: "status" }));
		const status = await until(stub, () => net.sent(thread).filter((c) => c.body.content.startsWith("Idle")), (s) => s.length === 1);
		expect(status[0]!.body.content).toContain("1 blocked");
	});

	test("long answers become ordered parts with one record each", async () => {
		const long = `${"a".repeat(1800)}\n${"b".repeat(1800)}\n${"c".repeat(100)}`;
		const net = new FakeNet().install().reply({ text: long });
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		await stub.accept(input(thread, say("write a lot")));
		const sent = await until(stub, () => net.sent(thread), (s) => s.length === 3);
		expect(sent.map((c) => c.body.content[0])).toEqual(["a", "b", "c"]);
		expect(new Set(sent.map((c) => c.body.nonce)).size).toBe(3);
		expect((await outbox(stub)).map((r) => r.part)).toEqual([0, 1, 2]);
	});

	test("operation ids are derived from Discord message ids", async () => {
		new FakeNet().install().reply({ text: "ok" });
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		const message = input(thread, say("hi"));
		await stub.accept(message);
		const result = await runInDurableObject(stub, (object: Conversation) => object.harness.wait(operationId(message.messageId)));
		expect(result).toMatchObject({ status: "done", text: "ok" });
	});
});
