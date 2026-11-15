import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { DiscordGateway } from "../src/gateway.ts";
import { eventually, FakeNet } from "./net.ts";

const BOT = "111111111111111111";
const ALLOWED = "100000000000000001";
const STRANGER = "100000000000000009";
const CHANNEL = "500000000000000001";
let gatewaySeq = 0;
let messageSeq = 710000000000000000n;

const gateway = () => env.GATEWAY.getByName(`test-${++gatewaySeq}`);

const message = (over: Record<string, unknown> = {}) => ({
	id: String(++messageSeq),
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

const prime = (stub: DurableObjectStub<DiscordGateway>) =>
	runInDurableObject(stub, (_o, state) => {
		state.storage.sql.exec("INSERT OR REPLACE INTO gw_state (key, value) VALUES ('bot_id', ?), ('session_id', 'sess'), ('resume_url', 'wss://resume.discord.test')", BOT);
	});

const ingest = (stub: DurableObjectStub<DiscordGateway>, data: unknown, seq: number) =>
	runInDurableObject(stub, async (object: DiscordGateway) => {
		const journaled = object.ingest(data, seq);
		await object.processJournal();
		return journaled;
	});

const stateValue = (stub: DurableObjectStub<DiscordGateway>, key: string) =>
	runInDurableObject(stub, (_o, state) => state.storage.sql.exec<{ value: string }>("SELECT value FROM gw_state WHERE key = ?", key).toArray()[0]?.value);

afterEach(() => vi.restoreAllMocks());

describe("gateway ingress", () => {
	test("a mention starts a thread on its message, is admitted once, and a replay changes nothing", async () => {
		const net = new FakeNet().install().reply({ text: "on it" });
		const stub = gateway();
		await prime(stub);
		net.on((call) => (call.method === "GET" && call.url.endsWith(`/channels/${CHANNEL}`) ? Response.json({ id: CHANNEL, type: 0 }) : undefined));
		const data = message();
		expect(await ingest(stub, data, 12)).toBe(true);
		expect(await stateValue(stub, "seq")).toBe("12");
		const threads = net.calls.filter((c) => c.url.endsWith(`/messages/${data.id}/threads`));
		expect(threads).toHaveLength(1);
		expect(threads[0]!.body).toEqual({ name: "fix the empty state", auto_archive_duration: 1440 });
		expect(net.calls.some((c) => c.method === "PUT" && c.url.includes(`/messages/${data.id}/reactions/${encodeURIComponent("👀")}`))).toBe(true);

		const conversation = env.CONVERSATIONS.getByName(data.id);
		await eventually(
			async () => {
				await runDurableObjectAlarm(conversation);
				return net.sent(data.id);
			},
			(s) => s.length === 1,
		);

		await ingest(stub, data, 13);
		expect(net.calls.filter((c) => c.url.endsWith(`/messages/${data.id}/threads`))).toHaveLength(1);
		expect(net.modelRequests).toHaveLength(1);
		const bound = await runInDurableObject(stub, (_o, state) => state.storage.sql.exec("SELECT thread_id FROM gw_threads").toArray());
		expect(bound).toEqual([{ thread_id: data.id }]);
	});

	test("a thread that already exists for the message counts as created", async () => {
		const net = new FakeNet().install().reply({ text: "ok" });
		const stub = gateway();
		await prime(stub);
		net.on((call) => (call.method === "GET" && call.url.endsWith(`/channels/${CHANNEL}`) ? Response.json({ id: CHANNEL, type: 0 }) : undefined));
		net.on((call) => (call.url.endsWith("/threads") ? Response.json({ code: 160004, message: "A thread has already been created for this message" }, { status: 400 }) : undefined));
		const data = message();
		await ingest(stub, data, 1);
		const journal = await runInDurableObject(stub, (_o, state) => state.storage.sql.exec("SELECT * FROM gw_journal").toArray());
		expect(journal).toEqual([]);
		expect(await runInDurableObject(env.CONVERSATIONS.getByName(data.id), (_o, state) => state.storage.sql.exec("SELECT stage FROM bobik_inputs").toArray())).toHaveLength(1);
	});

	test("a stranger's mention gets one denial reply and no conversation", async () => {
		const net = new FakeNet().install();
		const stub = gateway();
		await prime(stub);
		const data = message({ author: { id: STRANGER } });
		await ingest(stub, data, 1);
		await ingest(stub, data, 2);
		const replies = net.sent(CHANNEL);
		expect(replies).toHaveLength(1);
		expect(replies[0]!.body.content).toBe("You are not on this bot's allowlist.");
		expect(net.calls.some((c) => c.url.endsWith("/threads"))).toBe(false);
		expect(net.modelRequests).toHaveLength(0);
	});

	test("unrelated traffic writes nothing", async () => {
		new FakeNet().install();
		const stub = gateway();
		await prime(stub);
		expect(await ingest(stub, message({ content: "lunch?", mentions: [] }), 1)).toBe(false);
		expect(await ingest(stub, message({ author: { id: ALLOWED, bot: true } }), 2)).toBe(false);
		expect(await stateValue(stub, "seq")).toBeUndefined();
	});

	test("a failed admission keeps its journal row for the alarm to retry", async () => {
		const net = new FakeNet().install().reply({ text: "eventually" });
		const stub = gateway();
		await prime(stub);
		let down = true;
		net.on((call) => (call.method === "GET" && call.url.endsWith(`/channels/${CHANNEL}`) ? (down ? new Response("", { status: 503 }) : Response.json({ id: CHANNEL, type: 0 })) : undefined));
		const data = message();
		await ingest(stub, data, 1);
		const row = await runInDurableObject(stub, (_o, state) => state.storage.sql.exec<{ attempts: number; state: string }>("SELECT attempts, state FROM gw_journal").toArray()[0]);
		expect(row).toMatchObject({ attempts: 1, state: "pending" });
		down = false;
		await runInDurableObject(stub, (_o, state) => state.storage.sql.exec("UPDATE gw_journal SET next_at = 0"));
		await runDurableObjectAlarm(stub);
		expect(await runInDurableObject(stub, (_o, state) => state.storage.sql.exec("SELECT * FROM gw_journal").toArray())).toEqual([]);
		expect(net.calls.filter((c) => c.url.endsWith(`/messages/${data.id}/threads`))).toHaveLength(1);
	});
});

describe("gateway connection", () => {
	const clients = new Map<DurableObjectStub<DiscordGateway>, WebSocket>();

	/** Connects the gateway to an in-memory Discord. Socket I/O must stay inside the object's context. */
	async function connect(stub: DurableObjectStub<DiscordGateway>, canResume: boolean) {
		const received: any[] = [];
		await runInDurableObject(stub, (object: DiscordGateway) => {
			const pair = new WebSocketPair();
			const [client, server] = [pair[0], pair[1]];
			client.accept();
			server.accept();
			client.addEventListener("message", (event) => {
				received.push(JSON.parse(event.data as string));
			});
			clients.set(stub, client);
			object.attach(server, canResume);
		});
		return {
			received,
			send: (frame: unknown) => runInDurableObject(stub, () => clients.get(stub)!.send(JSON.stringify(frame))),
			close: (code: number) => runInDurableObject(stub, () => clients.get(stub)!.close(code, "test")),
		};
	}

	test("identify, READY, heartbeats with sequence, and a fatal close that stops reconnecting", async () => {
		const net = new FakeNet().install();
		const stub = gateway();
		await runInDurableObject(stub, (_o, state) => state.storage.sql.exec("INSERT INTO gw_state (key, value) VALUES ('enabled', '1')"));
		const { send, close, received } = await connect(stub, false);
		await send({ op: 10, d: { heartbeat_interval: 60 } });
		await eventually(() => received.length, (n) => n >= 1);
		expect(received[0]).toMatchObject({ op: 2, d: { token: "test-discord-token", intents: 33281 } });
		await send({ op: 0, s: 1, t: "READY", d: { session_id: "abc", resume_gateway_url: "wss://resume.discord.test", user: { id: BOT } } });
		await eventually(() => stateValue(stub, "session_id"), (v) => v === "abc");
		const beat = await eventually(() => received.filter((f) => f.op === 1), (b) => b.length >= 1);
		expect(beat[0]).toEqual({ op: 1, d: 1 });
		await send({ op: 11 });
		await close(4004);
		await eventually(() => stateValue(stub, "fatal"), (v) => typeof v === "string" && v.includes("4004"));
		const status = await stub.status();
		expect(status).toMatchObject({ enabled: true, phase: "stopped", resumable: false });
		await stub.ensure();
		expect(net.calls.filter((c) => c.url.includes("gateway"))).toHaveLength(0);
	});

	test("an abnormal close resumes on the stored resume URL instead of identifying", async () => {
		const net = new FakeNet().install();
		const stub = gateway();
		await prime(stub);
		await runInDurableObject(stub, (_o, state) => state.storage.sql.exec("INSERT INTO gw_state (key, value) VALUES ('enabled', '1'), ('seq', '41')"));
		const { send, close, received } = await connect(stub, true);
		await send({ op: 10, d: { heartbeat_interval: 45_000 } });
		await eventually(() => received.length, (n) => n >= 1);
		expect(received[0]).toEqual({ op: 6, d: { token: "test-discord-token", session_id: "sess", seq: 41 } });
		expect((await stub.status()).lastAckAgeS).toBeNull();
		await send({ op: 11 });
		await eventually(() => stub.status(), (status) => status.lastAckAgeS === 0);
		await close(1011);
		const upgrade = await eventually(() => net.calls.filter((c) => c.url.includes("resume.discord.test")), (c) => c.length >= 1, 15_000);
		expect(upgrade[0]!.url).toContain("v=10");
		expect(net.calls.some((c) => c.url.endsWith("/gateway/bot"))).toBe(false);
		await stub.stop();
	}, 30_000);

	test("starting without an allowlist is refused", async () => {
		const stub = gateway();
		await runInDurableObject(stub, async (object: DiscordGateway) => {
			const saved = object["env"].ALLOWED_USER_IDS;
			object["env"].ALLOWED_USER_IDS = "";
			await expect(object.start()).rejects.toThrow(/ALLOWED_USER_IDS/);
			object["env"].ALLOWED_USER_IDS = saved;
		});
	});
});
