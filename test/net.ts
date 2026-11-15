import { vi } from "vitest";

export type Call = { readonly method: string; readonly url: string; readonly body: any };

export type ModelTurn =
	| { readonly text: string; readonly reasoning?: string }
	| { readonly tool: string; readonly args: unknown; readonly reasoning?: string; readonly id?: string };

type Handler = (call: Call) => Response | Promise<Response> | undefined;

const sse = (chunks: unknown[]) =>
	new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
		headers: { "content-type": "text/event-stream" },
	});

function completion(turn: ModelTurn, n: number) {
	const base = { id: `chatcmpl-${n}`, object: "chat.completion.chunk", created: 1, model: "kimi-k3-1-pro" };
	const chunks: unknown[] = [];
	if (turn.reasoning) chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: turn.reasoning }, finish_reason: null }] });
	if ("text" in turn) {
		chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: turn.text }, finish_reason: null }] });
		chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
	} else {
		const id = turn.id ?? `call_${n}`;
		chunks.push({
			...base,
			choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: turn.tool, arguments: JSON.stringify(turn.args) } }] }, finish_reason: null }],
		});
		chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
	}
	return sse(chunks);
}

export class FakeNet {
	readonly calls: Call[] = [];
	readonly modelRequests: any[] = [];
	readonly script: (ModelTurn | (() => Promise<ModelTurn>))[] = [];
	readonly handlers: Handler[] = [];
	discordMessageId = 900000000000000000n;
	readonly nonces = new Map<string, string>();

	install() {
		const real = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
			let body: any = text;
			try {
				body = text ? JSON.parse(text) : undefined;
			} catch {
				// Non-JSON bodies stay as text.
			}
			const call = { method: request.method, url: request.url, body };
			this.calls.push(call);
			for (const handler of this.handlers) {
				const response = await handler(call);
				if (response) return response;
			}
			const response = await this.defaults(call);
			if (response) return response;
			if (!request.url.includes(".test")) return real(input, init);
			return new Response(JSON.stringify({ message: "unexpected" }), { status: 599 });
		});
		return this;
	}

	on(handler: Handler) {
		this.handlers.unshift(handler);
		return this;
	}

	reply(...turns: (ModelTurn | (() => Promise<ModelTurn>))[]) {
		this.script.push(...turns);
		return this;
	}

	sent(channelId?: string) {
		return this.calls.filter((c) => c.method === "POST" && /\/channels\/\d+\/messages$/.test(new URL(c.url).pathname) && (!channelId || c.url.includes(`/channels/${channelId}/`)));
	}

	private async defaults(call: Call): Promise<Response | undefined> {
		const url = new URL(call.url);
		if (url.hostname === "verda.test") {
			this.modelRequests.push(call.body);
			const next = this.script.shift();
			if (!next) return new Response(JSON.stringify({ error: { message: "script exhausted" } }), { status: 400 });
			const turn = typeof next === "function" ? await next() : next;
			return completion(turn, this.modelRequests.length);
		}
		if (url.hostname === "discord.test") {
			if (call.method === "POST" && /\/channels\/\d+\/messages$/.test(url.pathname)) {
				const nonce = String(call.body.nonce);
				const existing = this.nonces.get(nonce);
				if (existing) return Response.json({ id: existing, channel_id: "0", content: call.body.content });
				const id = String(this.discordMessageId++);
				this.nonces.set(nonce, id);
				return Response.json({ id, channel_id: url.pathname.split("/")[3], content: call.body.content });
			}
			if (call.method === "PUT" && url.pathname.includes("/reactions/")) return new Response(null, { status: 204 });
			if (call.method === "POST" && url.pathname.endsWith("/threads")) {
				const messageId = url.pathname.split("/")[5];
				return Response.json({ id: messageId, type: 11, parent_id: url.pathname.split("/")[3] });
			}
		}
		return undefined;
	}
}

export async function eventually<T>(probe: () => T | Promise<T>, ok: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
	const start = Date.now();
	for (;;) {
		const value = await probe();
		if (ok(value)) return value;
		if (Date.now() - start > timeoutMs) throw new Error(`condition not met in ${timeoutMs} ms: ${JSON.stringify(value)?.slice(0, 500)}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}
