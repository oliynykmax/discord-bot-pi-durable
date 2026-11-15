import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Conversation } from "../src/conversation.ts";
import type { ThreadInput } from "../src/domain.ts";
import type { Env, Snowflake } from "../src/env.ts";
import { FakeShell } from "./fake-shell.ts";
import { eventually, FakeNet } from "./net.ts";

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
