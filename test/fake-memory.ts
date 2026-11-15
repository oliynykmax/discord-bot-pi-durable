import type { Call } from "./net.ts";

type Rpc = { jsonrpc: "2.0"; id?: number | string; method: string; params?: any };

/** A Basic Memory MCP server at memory.test over streamable HTTP, answering with JSON bodies. */
export class FakeMemory {
	readonly requests: Call[] = [];
	readonly methods: string[] = [];
	readonly calls: { name: string; arguments: Record<string, unknown> }[] = [];

	handler = (call: Call): Response | undefined => {
		if (new URL(call.url).hostname !== "memory.test") return undefined;
		this.requests.push(call);
		if (call.method !== "POST") return new Response(null, { status: 405 });
		const rpc = call.body as Rpc;
		this.methods.push(rpc.method);
		if (rpc.id === undefined) return new Response(null, { status: 202 });
		const result = this.#answer(rpc);
		if (result === undefined) return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
		return Response.json({ jsonrpc: "2.0", id: rpc.id, result }, { headers: { "mcp-session-id": "fake-session" } });
	};

	#answer(rpc: Rpc): unknown {
		switch (rpc.method) {
			case "initialize":
				return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Basic Memory", version: "4.1.3" } };
			case "tools/call": {
				this.calls.push({ name: rpc.params.name, arguments: rpc.params.arguments });
				if (rpc.params.name === "bm_search") return { content: [{ type: "text", text: "- people/ana.md: Ana likes oat milk flat whites" }] };
				return { content: [{ type: "text", text: `Created ${rpc.params.arguments.title ?? "note"}` }] };
			}
			default:
				return undefined;
		}
	}
}
