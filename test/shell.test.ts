import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Conversation } from "../src/conversation.ts";
import type { ThreadInput } from "../src/domain.ts";
import type { Env, Snowflake } from "../src/env.ts";
import { type Call, eventually, FakeNet } from "./net.ts";

const REQUEST = 1;
const RESULT = 2;
const EVENT = 4;

let threadSeq = 310000000000000000n;
const newThread = () => String(++threadSeq) as Snowflake;
let messageSeq = 410000000000000000n;

const say = (threadId: Snowflake, text: string): ThreadInput => ({
	messageId: String(++messageSeq) as Snowflake,
	threadId,
	authorId: "100000000000000001" as Snowflake,
	authorName: "ana",
	action: { kind: "say", text },
	attachments: [],
});

function frame(type: number, id: number, json: object, payload: Uint8Array = new Uint8Array(0)): Uint8Array<ArrayBuffer> {
	const body = new TextEncoder().encode(JSON.stringify(json));
	const out = new Uint8Array(13 + body.length + payload.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, 9 + body.length + payload.length);
	view.setUint8(4, type);
	view.setUint32(5, id);
	view.setUint32(9, body.length);
	out.set(body, 13);
	out.set(payload, 13 + body.length);
	return out;
}

function parse(bytes: Uint8Array) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const jsonLength = view.getUint32(9);
	return { type: view.getUint8(4), id: view.getUint32(5), json: JSON.parse(new TextDecoder().decode(bytes.subarray(13, 13 + jsonLength))) as Record<string, unknown> };
}

/** Answers the WebSocket upgrade to shell.test as the bridge would, with a scripted pi-env daemon behind it. */
class FakeShell {
	readonly upgrades: Call[] = [];
	readonly requests: { op: string; json: Record<string, unknown> }[] = [];
	args: unknown;

	handler = (call: Call): Response | undefined => {
		if (new URL(call.url).hostname !== "shell.test") return undefined;
		this.upgrades.push(call);
		const { 0: client, 1: server } = new WebSocketPair();
		server.accept();
		server.binaryType = "arraybuffer";
		server.addEventListener("message", (event) => this.#onMessage(server, event.data));
		return new Response(null, { status: 101, webSocket: client });
	};

	#onMessage(server: WebSocket, data: string | ArrayBuffer) {
		if (typeof data === "string") {
			this.args = (JSON.parse(data) as { args: string[] }).args;
			server.send(new TextEncoder().encode(`PI-ENV ${(this.args as string[])[2]}\n`));
			return;
		}
		const { type, id, json } = parse(new Uint8Array(data));
		if (type !== REQUEST) return;
		const { op, ...rest } = json;
		this.requests.push({ op: String(op), json: rest });
		if (op === "hello") {
			server.send(
				frame(RESULT, id, { protocol: 1, version: "1.5.2", os: "linux", arch: "x86_64", home: "/home/bobik", tmpdir: "/tmp", cwd: "/home/bobik", driveCwds: {}, pid: 7, features: ["listFiles"] }),
			);
		} else if (op === "exec") {
			server.send(frame(EVENT, id, { kind: "output", stream: "stdout" }, new TextEncoder().encode("hi\n")));
			server.send(frame(RESULT, id, { exitCode: 0 }));
		} else {
			server.send(frame(RESULT, id, {}));
		}
	}
}

const toolNames = (request: any): string[] => (request?.tools ?? []).map((t: any) => t.function.name);

async function answered(stub: DurableObjectStub<Conversation>, net: FakeNet, thread: Snowflake) {
	return eventually(
		async () => {
			await runDurableObjectAlarm(stub);
			return net.sent(thread);
		},
		(sent) => sent.length === 1,
	);
}

afterEach(() => vi.restoreAllMocks());

describe("shell", () => {
	test("bash runs over the bridge socket, with the shell token, in the thread's own folder", async () => {
		const shell = new FakeShell();
		const net = new FakeNet().install().on(shell.handler).reply({ tool: "bash", args: { command: "echo hi" } }, { text: "It printed hi." });
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		await stub.accept(say(thread, "run echo hi"));
		const sent = await answered(stub, net, thread);
		expect(sent[0]!.body.content).toBe("It printed hi.");

		expect(toolNames(net.modelRequests[0])).toEqual(expect.arrayContaining(["read", "write", "edit", "bash"]));
		expect(JSON.stringify(net.modelRequests[0].messages)).toContain(`/home/bobik/threads/${thread}`);
		expect(shell.upgrades).toHaveLength(1);
		expect(shell.upgrades[0]!.url).toBe("https://shell.test/pi-env");
		expect(shell.upgrades[0]!.headers.get("authorization")).toBe("Bearer test-shell-token");
		expect(shell.args).toEqual(["serve", "--token", expect.stringMatching(/^[0-9a-f]{32}$/)]);
		const folder = `/home/bobik/threads/${thread}`;
		expect(shell.requests.find((r) => r.op === "mkdir")?.json).toEqual({ path: folder, recursive: true });
		const exec = shell.requests.find((r) => r.op === "exec");
		expect(exec?.json).toMatchObject({ command: "echo hi", cwd: folder });
		expect(shell.requests.findIndex((r) => r.op === "mkdir")).toBeLessThan(shell.requests.findIndex((r) => r.op === "exec"));
		const toolResult = net.modelRequests[1].messages.find((m: any) => m.role === "tool");
		expect(JSON.stringify(toolResult.content)).toContain("hi");
	});

	test("a plain chat never dials the shell", async () => {
		const shell = new FakeShell();
		const net = new FakeNet().install().on(shell.handler).reply({ text: "hey" });
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		await stub.accept(say(thread, "hi"));
		await answered(stub, net, thread);
		expect(shell.upgrades).toHaveLength(0);
	});

	test("without SHELL_URL there are no shell tools and the prompt says so", async () => {
		const net = new FakeNet().install().reply({ text: "no shell here" });
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		await runInDurableObject(stub, (instance: Conversation) => {
			(instance as unknown as { env: Env }).env = { ...env, SHELL_URL: undefined } as Env;
		});
		await stub.accept(say(thread, "hi"));
		await answered(stub, net, thread);
		expect(toolNames(net.modelRequests[0])).not.toContain("bash");
		expect(toolNames(net.modelRequests[0])).toContain("discord_read_attachment");
		expect(JSON.stringify(net.modelRequests[0].messages)).toContain("You have no web search, shell");
	});
});
