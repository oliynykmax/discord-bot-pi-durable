import { env, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Conversation } from "../src/conversation.ts";
import type { ThreadInput } from "../src/domain.ts";
import type { Snowflake } from "../src/env.ts";
import { FakeShell } from "./fake-shell.ts";
import { eventually, FakeNet } from "./net.ts";

let threadSeq = 320000000000000000n;
const newThread = () => String(++threadSeq) as Snowflake;
let messageSeq = 420000000000000000n;

const say = (threadId: Snowflake, text: string): ThreadInput => ({
	messageId: String(++messageSeq) as Snowflake,
	threadId,
	authorId: "100000000000000001" as Snowflake,
	authorName: "ana",
	action: { kind: "say", text },
	attachments: [],
});

const toolNames = (request: any): string[] => (request?.tools ?? []).map((t: any) => t.function.name);
const toolResults = (request: any): string => JSON.stringify(request.messages.filter((m: any) => m.role === "tool"));

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

describe("codemode", () => {
	test("a script runs in the sandbox Worker, calls bash on the shell, and only its output reaches the model", async () => {
		const shell = new FakeShell();
		const code = [
			'const first = await tools.bash({ command: "echo hi" });',
			'const second = await tools.bash({ command: "echo again" });',
			'text(`bash said ${first.output.trim()} twice, exit codes ${first.exitCode} and ${second.exitCode}`);',
		].join("\n");
		const net = new FakeNet().install().on(shell.handler).reply({ tool: "codemode", args: { code } }, { text: "Done." });
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		await stub.accept(say(thread, "run echo twice"));
		const sent = await answered(stub, net, thread);
		expect(sent[0]!.body.content).toBe("Done.");

		expect(toolNames(net.modelRequests[0])).toEqual(expect.arrayContaining(["codemode", "bash", "read"]));
		expect(JSON.stringify(net.modelRequests[0].messages)).toContain("<codemode>");
		expect(shell.requests.filter((r) => r.op === "exec").map((r) => r.json.command)).toEqual(["echo hi", "echo again"]);
		const results = toolResults(net.modelRequests[1]);
		expect(results).toContain("bash said hi twice, exit codes 0 and 0");
		expect(results).not.toContain("echo again");
	});

	test("a script that throws reports its error to the model", async () => {
		const net = new FakeNet().install().reply({ tool: "codemode", args: { code: 'throw new Error("nope from the script");' } }, { text: "It failed." });
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		await stub.accept(say(thread, "try it"));
		await answered(stub, net, thread);
		expect(toolResults(net.modelRequests[1])).toContain("nope from the script");
	});
});
