// Drives bobik's real memory tools against the live server through Caddy: the token check, the saved tools/list, and a
// note written, found, read and deleted. SHELL_TOKEN=... node scripts/memory-check.ts
import type { Context } from "@earendil-works/chord/context";
import type { JsonObject, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { MEMORY_TOOLS, memoryExtension, MemoryServer } from "../src/memory.ts";

const token = process.env.SHELL_TOKEN;
if (!token) throw new Error("SHELL_TOKEN is not set");
const url = process.env.MEMORY_MCP_URL ?? "https://138-2-191-62.sslip.io/mcp";

let failed = false;
function check(ok: boolean, what: string, detail = "") {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
	if (!ok) failed = true;
}

const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check", version: "1" } } });
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
for (const [label, authorization] of [["no token", undefined], ["a wrong token", "Bearer not-the-token"]] as const) {
	const response = await fetch(url, { method: "POST", headers: { ...headers, ...(authorization ? { authorization } : {}) }, body: initialize });
	await response.body?.cancel();
	check(response.status === 401, `${label} gets 401`, `HTTP ${response.status}`);
}

const server = new MemoryServer(url, token);
const live = await server.tools();
check(JSON.stringify(live) === JSON.stringify(MEMORY_TOOLS), "src/memory-tools.ts matches the live tools/list", live.map((t) => t.name).join(", "));

const tools = new Map(memoryExtension(server).tools!.map((tool) => [tool.name, tool as ToolRegistration]));
const context = { abortSignal: undefined } as unknown as Context;
async function run(name: string, args: JsonObject): Promise<{ text: string; isError: boolean }> {
	const tool = tools.get(`mcp__memory__${name}`)!;
	const prepared = (tool.prepareArguments?.(args) ?? args) as JsonObject;
	const result: ToolExecutionResult = await tool.execute(prepared, undefined as never, context);
	const text = (result.output ?? []).map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
	return { text, isError: result.isError === true };
}

const marker = `zebra${Date.now().toString(36)}`;
const title = `Memory check ${marker}`;
const written = await run("bm_write", { title, directory: "checks", content: `The memory check marker is ${marker}. Max likes oat milk flat whites.`, project: "main" });
const permalink = /permalink: (\S+)/.exec(written.text)?.[1];
check(!written.isError && permalink?.startsWith("bobik/checks/") === true, "bm_write creates the note in project bobik, ignoring project main", permalink ?? written.text.slice(0, 200));

const found = await run("bm_search", { query: marker });
check(!found.isError && found.text.includes(title), "bm_search finds it by keyword", found.text.split("\n")[0] ?? "");
const semantic = await run("bm_search", { query: "what coffee does Max drink", all_projects: true });
check(!semantic.isError && semantic.text.includes(title), "bm_search finds it by meaning", semantic.text.split("\n")[0] ?? "");

const read = await run("bm_read", { identifier: permalink ?? title });
check(!read.isError && read.text.includes(`marker is ${marker}`), "bm_read returns its content");

const deleted = await run("bm_delete", { identifier: permalink ?? title });
check(!deleted.isError, "bm_delete removes it", deleted.text.split("\n")[0] ?? "");
const gone = await run("bm_read", { identifier: permalink ?? title });
check(gone.isError || !gone.text.includes(`marker is ${marker}`), "bm_read no longer finds it");

server.close();
process.exit(failed ? 1 : 0);
