import type { Env } from "./env.ts";

export { Conversation } from "./conversation.ts";
export { DiscordGateway } from "./gateway.ts";

const HEALTH = JSON.stringify({ service: "bobik", status: "ok" });

async function authorized(request: Request, secret: string | undefined): Promise<boolean> {
	if (!secret || secret.length < 32) return false;
	const header = request.headers.get("authorization") ?? "";
	if (!header.startsWith("Bearer ")) return false;
	const encoder = new TextEncoder();
	const [given, expected] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(header.slice(7))),
		crypto.subtle.digest("SHA-256", encoder.encode(secret)),
	]);
	return crypto.subtle.timingSafeEqual(given, expected);
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const ADMIN: Record<string, "start" | "stop" | "status"> = {
	"POST /admin/gateway/start": "start",
	"POST /admin/gateway/stop": "stop",
	"GET /admin/status": "status",
};

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/healthz" && request.method === "GET") {
			return new Response(HEALTH, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
		}
		const action = ADMIN[`${request.method} ${url.pathname}`];
		if (!action) return json({ error: "not found" }, 404);
		if (!(await authorized(request, env.ADMIN_SECRET))) return json({ error: "unauthorized" }, 401);
		const gateway = env.GATEWAY.getByName("main");
		try {
			if (action === "start") return json(await gateway.start());
			if (action === "stop") return json(await gateway.stop());
			return json(await gateway.status());
		} catch (error) {
			return json({ error: error instanceof Error ? error.message.slice(0, 200) : "failed" }, 500);
		}
	},

	async scheduled(_controller, env): Promise<void> {
		await env.GATEWAY.getByName("main").ensure();
	},
} satisfies ExportedHandler<Env>;
