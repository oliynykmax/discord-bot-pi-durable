import { env, listDurableObjectIds } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FakeNet } from "./net.ts";

const SECRET = "test-admin-secret-0123456789abcdef0123";
const call = (path: string, init?: RequestInit) => (exports as any).default.fetch(new Request(`https://bobik.example${path}`, init)) as Promise<Response>;

afterEach(() => vi.restoreAllMocks());

describe("worker HTTP surface", () => {
	test("/healthz is constant, small, and touches no Durable Object", async () => {
		const net = new FakeNet().install();
		const before = (await listDurableObjectIds(env.GATEWAY)).length + (await listDurableObjectIds(env.CONVERSATIONS)).length;
		for (let i = 0; i < 200; i++) {
			const response = await call(`/healthz?probe=${i}`);
			expect(response.status).toBe(200);
			const body = await response.text();
			expect(body).toBe('{"service":"bobik","status":"ok"}');
			for (const secret of [env.DISCORD_TOKEN, env.VERDA_API_KEY, env.ADMIN_SECRET]) expect(body).not.toContain(secret);
		}
		const after = (await listDurableObjectIds(env.GATEWAY)).length + (await listDurableObjectIds(env.CONVERSATIONS)).length;
		expect(after).toBe(before);
		expect(net.calls).toHaveLength(0);
	});

	test("unknown paths are 404 and admin routes need the bearer secret", async () => {
		expect((await call("/")).status).toBe(404);
		expect((await call("/admin/gateway/start", { method: "GET" })).status).toBe(404);
		const before = (await listDurableObjectIds(env.GATEWAY)).length;
		expect((await call("/admin/gateway/start", { method: "POST" })).status).toBe(401);
		expect((await call("/admin/status", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
		expect((await listDurableObjectIds(env.GATEWAY)).length).toBe(before);
	});

	test("a short admin secret disables administration", async () => {
		expect((await call("/admin/status", { headers: { authorization: `Bearer ${env.ADMIN_SECRET}` } })).status).toBe(401);
	});

	test("authenticated status is bounded and starts nothing", async () => {
		const saved = env.ADMIN_SECRET;
		(env as any).ADMIN_SECRET = SECRET;
		try {
			const response = await call("/admin/status", { headers: { authorization: `Bearer ${SECRET}` } });
			expect(response.status).toBe(200);
			const body = (await response.json()) as Record<string, unknown>;
			expect(Object.keys(body).sort()).toEqual(["boundThreads", "enabled", "fatal", "journal", "lastAckAgeS", "lastError", "lastReadyAgeS", "phase", "resumable"]);
			expect(body).toMatchObject({ enabled: false, phase: "stopped" });
		} finally {
			(env as any).ADMIN_SECRET = saved;
		}
	});
});
