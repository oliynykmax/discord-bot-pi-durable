import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Conversation } from "../src/conversation.ts";
import type { ThreadInput } from "../src/domain.ts";
import type { Env, Snowflake } from "../src/env.ts";
import { MEMORY_TOOLS, memoryArguments, memoryToolSpecs } from "../src/memory.ts";
import { FakeMemory } from "./fake-memory.ts";
import { FakeShell } from "./fake-shell.ts";
import { eventually, FakeNet } from "./net.ts";

let threadSeq = 330000000000000000n;
const newThread = () => String(++threadSeq) as Snowflake;
let messageSeq = 430000000000000000n;

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

describe("memory tools", () => {
	test("drop project administration and every scope argument, and replay only read-only tools", () => {
		const specs = memoryToolSpecs([
			{ name: "bm_search", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { query: { type: "string" }, project: { type: "string" }, all_projects: { type: "boolean" } }, required: ["project"] } },
			{ name: "bm_delete", annotations: { readOnlyHint: false }, inputSchema: { type: "object", properties: { identifier: { type: "string" }, project: { type: "string" } }, required: ["identifier", "project"] } },
			{ name: "bm_man", inputSchema: { type: "object", properties: { page: { type: "string" } } } },
			{ name: "bm_project", inputSchema: { type: "object", properties: {} } },
		]);
		expect(specs.map((s) => [s.name, s.readOnly, s.scoped])).toEqual([
			["bm_search", true, true],
			["bm_delete", false, true],
			["bm_man", false, false],
		]);
		expect(specs[0]!.inputSchema).toEqual({ type: "object", properties: { query: { type: "string" } } });
		expect(specs[1]!.inputSchema).toEqual({ type: "object", properties: { identifier: { type: "string" } }, required: ["identifier"] });
		expect(memoryArguments(specs[0]!, { query: "x", project: "main", all_projects: true, projects: ["main"] })).toEqual({ query: "x", project: "bobik" });
		expect(memoryArguments(specs[2]!, { page: "bm-search(3)", project: "main" })).toEqual({ page: "bm-search(3)" });
	});

	test("the saved tools/list offers the real server's tools without project scope", () => {
		const specs = memoryToolSpecs(MEMORY_TOOLS);
		expect(specs.map((s) => s.name)).not.toContain("bm_project");
		expect(specs.filter((s) => s.readOnly).map((s) => s.name).sort()).toEqual(["bm_context", "bm_find", "bm_list", "bm_man", "bm_read", "bm_schema", "bm_search"]);
		for (const spec of specs) expect(Object.keys(spec.inputSchema.properties as object)).not.toContain("project");
	});
});

describe("memory", () => {
	test("a plain chat never connects to the memory server, and its tools stay deferred", async () => {
		const memory = new FakeMemory();
		const net = new FakeNet().install().on(memory.handler).reply({ text: "hey" });
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		await stub.accept(say(thread, "hi"));
		await answered(stub, net, thread);
		expect(memory.requests).toHaveLength(0);
		const tools = toolNames(net.modelRequests[0]);
		expect(tools).toEqual(expect.arrayContaining(["codemode", "tool_search"]));
		expect(tools.filter((name) => name.startsWith("mcp__memory__"))).toEqual([]);
		expect(JSON.stringify(net.modelRequests[0].messages)).toContain("You have a shared memory");
	});

	test("a codemode script calls bash and memory search with the shell token, and the result reaches the model", async () => {
		const shell = new FakeShell();
		const memory = new FakeMemory();
		const code = [
			'const hits = await tools.mcp__memory__bm_search({ query: "coffee", project: "main", all_projects: true });',
			'const run = await tools.bash({ command: "echo hi" });',
			'text(`${hits} | bash ${run.output.trim()}`);',
		].join("\n");
		const net = new FakeNet().install().on(shell.handler).on(memory.handler).reply({ tool: "codemode", args: { code } }, { text: "Ana drinks flat whites." });
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		await stub.accept(say(thread, "what coffee does ana like?"));
		const sent = await answered(stub, net, thread);
		expect(sent[0]!.body.content).toBe("Ana drinks flat whites.");

		expect(memory.calls).toEqual([{ name: "bm_search", arguments: { query: "coffee", project: "bobik" } }]);
		expect(memory.requests.every((r) => r.url === "https://memory.test/mcp" && r.headers.get("authorization") === "Bearer test-shell-token")).toBe(true);
		expect(toolResults(net.modelRequests[1])).toContain("Ana likes oat milk flat whites | bash hi");
	});

	test("tool_search loads the memory tools for the model, which calls them with bobik's project", async () => {
		const memory = new FakeMemory();
		const net = new FakeNet()
			.install()
			.on(memory.handler)
			.reply({ tool: "tool_search", args: { query: "write note" } }, { tool: "mcp__memory__bm_write", args: { title: "Plans", content: "Hike on Saturday", project: "main" } }, { text: "Saved." });
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		await stub.accept(say(thread, "remember: hike on saturday"));
		await answered(stub, net, thread);

		// pi-ai offers loaded tools to Kimi as a mid-conversation `{ role: "system", tools }` message, which Verda honors.
		const loaded = net.modelRequests[1].messages.filter((m: any) => m.role === "system" && m.tools).flatMap((m: any) => m.tools);
		const names = loaded.map((t: any) => t.function.name);
		expect(names).toContain("mcp__memory__bm_write");
		expect(names).not.toContain("mcp__memory__bm_project");
		const offered = loaded.find((t: any) => t.function.name === "mcp__memory__bm_write").function.parameters;
		expect(Object.keys(offered.properties)).not.toContain("project");
		expect(Object.keys(offered.properties)).toEqual(expect.arrayContaining(["title", "content", "directory"]));
		expect(memory.calls).toEqual([{ name: "bm_write", arguments: { title: "Plans", content: "Hike on Saturday", project: "bobik" } }]);
		expect(memory.methods).not.toContain("tools/list");
	});

	test("an unreachable memory server fails the call with a reason the model can relay", async () => {
		const net = new FakeNet().install();
		net.on((call) => (new URL(call.url).hostname === "memory.test" ? new Response("bad gateway", { status: 502 }) : undefined));
		const code = 'try { await tools.mcp__memory__bm_search({ query: "x" }); } catch (error) { text(`caught: ${error.message}`); }';
		net.reply({ tool: "codemode", args: { code } }, { text: "Memory is down." });
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		await stub.accept(say(thread, "check memory"));
		await answered(stub, net, thread);
		expect(toolResults(net.modelRequests[1])).toContain("caught: Memory is unreachable right now");
	});

	test("without MEMORY_MCP_URL there are no memory tools and no tool_search", async () => {
		const net = new FakeNet().install().reply({ text: "no memory" });
		const thread = newThread();
		const stub = env.CONVERSATIONS.getByName(thread);
		await runInDurableObject(stub, (instance: Conversation) => {
			(instance as unknown as { env: Env }).env = { ...env, MEMORY_MCP_URL: undefined } as Env;
		});
		await stub.accept(say(thread, "hi"));
		await answered(stub, net, thread);
		expect(toolNames(net.modelRequests[0])).not.toContain("tool_search");
		expect(toolNames(net.modelRequests[0])).toContain("codemode");
		expect(JSON.stringify(net.modelRequests[0].messages)).not.toContain("shared memory");
	});
});
