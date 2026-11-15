import type { Context } from "@earendil-works/chord/context";
import type { Extension, JsonObject, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { type CallToolResult, Client, StreamableHTTPClientTransport, type Tool as McpTool } from "@modelcontextprotocol/client";
import { SNAPSHOT } from "./memory-tools.ts";

/**
 * The server's tools/list, as `scripts/memory-tools.ts` saved it. Registering from it means a plain chat never connects,
 * and the tools exist before the first request: Pi resolves a task's tools when the task starts, so tools listed during
 * a call would only reach later calls. `scripts/memory-check.ts` fails when the live list differs.
 */
export const MEMORY_TOOLS = SNAPSHOT as unknown as McpTool[];

/** bobik's Basic Memory project on the shell VM. The server is pinned to it, and bobik sets it on every call. */
export const MEMORY_PROJECT = "bobik";
export const MEMORY_PREFIX = "mcp__memory__";
export const MEMORY_NAMESPACE = {
	name: "memory",
	prefix: MEMORY_PREFIX,
	description: "bobik's shared long-term notes (Basic Memory). Everyone in the group sees them.",
};
const IDLE_MS = 60_000;

/** Scope arguments bobik owns: the model never picks a project or workspace. */
const SCOPE_ARGS = ["project", "projects", "all_projects", "workspace"];
/** Project administration is the operator's job, not bobik's. */
const EXCLUDED_TOOLS = new Set(["bm_project"]);

/** One server tool as bobik offers it. `scoped`: the server requires `project`, which bobik fills in. */
export type MemoryToolSpec = {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: JsonObject;
	readonly readOnly: boolean;
	readonly scoped: boolean;
};

export function memoryToolSpecs(tools: readonly McpTool[]): MemoryToolSpec[] {
	return tools
		.filter((tool) => !EXCLUDED_TOOLS.has(tool.name))
		.map((tool) => {
			const { properties = {}, required = [], ...rest } = tool.inputSchema as JsonObject & { properties?: JsonObject; required?: string[] };
			const kept = Object.fromEntries(Object.entries(properties).filter(([key]) => !SCOPE_ARGS.includes(key)));
			const stillRequired = required.filter((key) => !SCOPE_ARGS.includes(key));
			return {
				name: tool.name,
				description: tool.description ?? tool.annotations?.title ?? tool.name,
				inputSchema: { ...rest, type: "object", properties: kept, ...(stillRequired.length ? { required: stillRequired } : {}) } as JsonObject,
				readOnly: tool.annotations?.readOnlyHint === true,
				scoped: "project" in properties,
			};
		});
}

const withoutScope = (args: JsonObject): JsonObject => Object.fromEntries(Object.entries(args).filter(([key]) => !SCOPE_ARGS.includes(key)));

export function memoryArguments(spec: MemoryToolSpec, args: JsonObject): JsonObject {
	return spec.scoped ? { ...withoutScope(args), project: MEMORY_PROJECT } : withoutScope(args);
}

function toolResult(result: CallToolResult): ToolExecutionResult {
	const output = result.content.map((block) => {
		if (block.type === "text") return { type: "text" as const, text: block.text };
		if (block.type === "image") return { type: "image" as const, data: block.data, mimeType: block.mimeType };
		return { type: "text" as const, text: JSON.stringify(block) };
	});
	return { output: output.length ? output : [{ type: "text", text: "(no output)" }], ...(result.isError ? { isError: true } : {}) };
}

/**
 * The Basic Memory MCP server behind the shell VM's Caddy, over streamable HTTP with the shell token. Connects on first
 * use and hangs up after a minute without calls, since a held connection keeps the Durable Object resident.
 */
export class MemoryServer {
	readonly #url: string;
	readonly #token: string;
	#client: Promise<Client> | undefined;
	#busy = 0;
	#idle: ReturnType<typeof setTimeout> | undefined;

	constructor(url: string, token: string) {
		this.#url = url;
		this.#token = token;
	}

	/** The server's tools/list, every page. */
	async tools(): Promise<McpTool[]> {
		return this.#use(true, async (client) => {
			const tools: McpTool[] = [];
			let cursor: string | undefined;
			do {
				const page = await client.listTools(cursor ? { cursor } : undefined);
				tools.push(...page.tools);
				cursor = page.nextCursor;
			} while (cursor);
			return tools;
		});
	}

	call(spec: MemoryToolSpec, args: JsonObject, signal: AbortSignal | undefined): Promise<CallToolResult> {
		return this.#use(spec.readOnly, (client) => client.callTool({ name: spec.name, arguments: memoryArguments(spec, args) }, signal ? { signal } : {}) as Promise<CallToolResult>);
	}

	close(): void {
		clearTimeout(this.#idle);
		const client = this.#client;
		this.#client = undefined;
		void client?.then((c) => c.close()).catch(() => {});
	}

	/** A failed call drops the session. Only a read-only call is sent again, on a fresh session. */
	async #use<T>(retry: boolean, work: (client: Client) => Promise<T>): Promise<T> {
		this.#busy++;
		clearTimeout(this.#idle);
		try {
			try {
				return await work(await this.#connect());
			} catch (error) {
				this.close();
				if (!retry) throw error;
				return await work(await this.#connect());
			}
		} finally {
			if (--this.#busy === 0) this.#idle = setTimeout(() => this.close(), IDLE_MS);
		}
	}

	#connect(): Promise<Client> {
		this.#client ??= (async () => {
			const client = new Client({ name: "bobik", version: "1" });
			const transport = new StreamableHTTPClientTransport(new URL(this.#url), {
				authProvider: { token: async () => this.#token },
				fetch: (input, init) => fetch(input, init),
			});
			await client.connect(transport);
			return client;
		})();
		return this.#client;
	}
}

function memoryTool(server: MemoryServer, spec: MemoryToolSpec): ToolRegistration {
	return {
		name: `${MEMORY_PREFIX}${spec.name}`,
		description: spec.description,
		parameters: spec.inputSchema,
		deferred: true,
		replay: spec.readOnly ? "safe" : "unsafe",
		// The server's descriptions ask for `project`, which the schema no longer has; drop it instead of failing validation.
		prepareArguments: (args: unknown) => (args && typeof args === "object" && !Array.isArray(args) ? withoutScope(args as JsonObject) : args),
		async execute(args: JsonObject, _api: unknown, context: Context): Promise<ToolExecutionResult> {
			try {
				return toolResult(await server.call(spec, args, context.abortSignal));
			} catch (error) {
				return { output: [{ type: "text", text: `Memory is unreachable right now: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
			}
		},
	} as ToolRegistration;
}

/** The memory tools, deferred: offered to the model after tool_search finds them, callable from codemode at any time. */
export function memoryExtension(server: MemoryServer): Extension {
	return { name: "memory", tools: memoryToolSpecs(MEMORY_TOOLS).map((spec) => memoryTool(server, spec)) };
}
