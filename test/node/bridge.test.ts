import { describe, expect, test } from "vitest";
import { authorized, daemonArgs, daemonEnv, MAX_SESSIONS, readConfig, route, sha256 } from "../../shell-host/protocol.ts";

const TOKEN = "s3cret-token";
const DIGEST = sha256(TOKEN);
const HEX = "0123456789abcdef0123456789abcdef";

const upgrade = (headers: Record<string, string>, path = "/pi-env") => new Request(`http://127.0.0.1:8788${path}`, { headers });

describe("bridge config", () => {
	test("takes the token's SHA-256, never the token", () => {
		const config = readConfig({ SHELL_TOKEN_SHA256: DIGEST.toString("hex") });
		expect(config.tokenSha256.equals(DIGEST)).toBe(true);
		expect(config).toMatchObject({ hostname: "127.0.0.1", port: 8788, command: ["/opt/bobik/pi-env"], home: "/home/bobik" });
		expect(() => readConfig({ SHELL_TOKEN: TOKEN })).toThrow(/SHELL_TOKEN_SHA256/);
		expect(() => readConfig({ SHELL_TOKEN_SHA256: "abc" })).toThrow(/SHELL_TOKEN_SHA256/);
	});

	test("splits a daemon command with a prefix", () => {
		expect(readConfig({ SHELL_TOKEN_SHA256: DIGEST.toString("hex"), PI_ENV_COMMAND: " /usr/bin/env  /opt/pi-env " }).command).toEqual(["/usr/bin/env", "/opt/pi-env"]);
	});
});

describe("bridge auth", () => {
	test("accepts only the exact bearer token", () => {
		expect(authorized(`Bearer ${TOKEN}`, DIGEST)).toBe(true);
		for (const header of [null, "", TOKEN, `bearer ${TOKEN}`, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, `Basic ${TOKEN}`, `Bearer  ${TOKEN}`]) {
			expect(authorized(header, DIGEST), String(header)).toBe(false);
		}
	});

	test("routes health, refuses strangers, and caps sessions", () => {
		expect(route(new Request("http://x/healthz"), DIGEST, 0)).toEqual({ kind: "health" });
		expect(route(upgrade({}, "/"), DIGEST, 0)).toMatchObject({ status: 404 });
		expect(route(upgrade({ upgrade: "websocket" }), DIGEST, 0)).toMatchObject({ status: 401 });
		expect(route(upgrade({ upgrade: "websocket", authorization: "Bearer nope" }), DIGEST, 0)).toMatchObject({ status: 401 });
		expect(route(upgrade({ authorization: `Bearer ${TOKEN}` }), DIGEST, 0)).toMatchObject({ status: 426 });
		expect(route(upgrade({ upgrade: "websocket", authorization: `Bearer ${TOKEN}` }), DIGEST, 0)).toEqual({ kind: "upgrade" });
		expect(route(upgrade({ upgrade: "websocket", authorization: `Bearer ${TOKEN}` }), DIGEST, MAX_SESSIONS)).toMatchObject({ status: 503 });
	});
});

describe("daemon arguments", () => {
	test("allows exactly serve --token <32 lowercase hex>", () => {
		expect(daemonArgs(JSON.stringify({ args: ["serve", "--token", HEX] }))).toEqual(["serve", "--token", HEX]);
	});

	test.each([
		["not json", "serve --token x"],
		["binary", new Uint8Array([1, 2, 3])],
		["no args", JSON.stringify({})],
		["null", "null"],
		["extra argument", JSON.stringify({ args: ["serve", "--token", HEX, "--listen"] })],
		["prepended argument", JSON.stringify({ args: ["--help", "serve", "--token", HEX] })],
		["other subcommand", JSON.stringify({ args: ["deploy", "--token", HEX] })],
		["short token", JSON.stringify({ args: ["serve", "--token", HEX.slice(1)] })],
		["uppercase token", JSON.stringify({ args: ["serve", "--token", HEX.toUpperCase()] })],
		["shell metacharacters", JSON.stringify({ args: ["serve", "--token", `${HEX.slice(0, 30)};id`] })],
		["number token", JSON.stringify({ args: ["serve", "--token", 1] })],
	])("refuses %s", (_name, message) => {
		expect(daemonArgs(message)).toBeUndefined();
	});
});

test("the daemon's environment carries nothing from the bridge", () => {
	const env = daemonEnv("/home/bobik", "bobik");
	expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "LOGNAME", "PATH", "SHELL", "TERM", "USER"]);
	expect(JSON.stringify(env)).not.toMatch(/TOKEN/);
});
