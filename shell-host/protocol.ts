import { createHash, timingSafeEqual } from "node:crypto";

export const MAX_SESSIONS = 16;
const DAEMON_TOKEN = /^[0-9a-f]{32}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type BridgeConfig = {
	readonly hostname: string;
	readonly port: number;
	/** SHA-256 of the bearer token, so a shell that reads this process's environment learns nothing it can use. */
	readonly tokenSha256: Buffer;
	/** The daemon program and any leading arguments, before `serve --token <hex>`. */
	readonly command: readonly string[];
	readonly home: string;
};

export function readConfig(env: Record<string, string | undefined>): BridgeConfig {
	const digest = env.SHELL_TOKEN_SHA256?.trim().toLowerCase() ?? "";
	if (!SHA256_HEX.test(digest)) throw new Error("SHELL_TOKEN_SHA256 must be the 64-hex-digit SHA-256 of the bearer token");
	const port = Number(env.PORT ?? "8788");
	if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be a TCP port");
	const command = (env.PI_ENV_COMMAND ?? "/opt/bobik/pi-env").split(/\s+/).filter(Boolean);
	if (command.length === 0) throw new Error("PI_ENV_COMMAND is empty");
	return { hostname: env.HOST ?? "127.0.0.1", port, tokenSha256: Buffer.from(digest, "hex"), command, home: env.SHELL_HOME ?? "/home/bobik" };
}

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest();

export function authorized(header: string | null, tokenSha256: Buffer): boolean {
	const match = /^Bearer (\S+)$/.exec(header ?? "");
	return match !== null && timingSafeEqual(sha256(match[1]!), tokenSha256);
}

export type Route = { readonly kind: "health" } | { readonly kind: "upgrade" } | { readonly kind: "reject"; readonly status: number; readonly body: string };

export function route(request: Request, tokenSha256: Buffer, sessions: number): Route {
	const { pathname } = new URL(request.url);
	if (pathname === "/healthz" && request.method === "GET") return { kind: "health" };
	if (pathname !== "/pi-env") return { kind: "reject", status: 404, body: "not found" };
	if (!authorized(request.headers.get("authorization"), tokenSha256)) return { kind: "reject", status: 401, body: "unauthorized" };
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return { kind: "reject", status: 426, body: "websocket upgrade required" };
	if (sessions >= MAX_SESSIONS) return { kind: "reject", status: 503, body: "too many shell sessions" };
	return { kind: "upgrade" };
}

/** The first client frame, `{"args":["serve","--token","<32 hex>"]}`; anything else is refused. */
export function daemonArgs(message: unknown): readonly string[] | undefined {
	if (typeof message !== "string") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(message);
	} catch {
		return undefined;
	}
	const args = (parsed as { args?: unknown } | null)?.args;
	if (!Array.isArray(args) || args.length !== 3) return undefined;
	const [serve, flag, token] = args as unknown[];
	return serve === "serve" && flag === "--token" && typeof token === "string" && DAEMON_TOKEN.test(token) ? ["serve", "--token", token] : undefined;
}

/** The daemon's whole environment: the bridge's own (and its token digest) stays out of the shell. */
export function daemonEnv(home: string, user: string): Record<string, string> {
	return {
		HOME: home,
		USER: user,
		LOGNAME: user,
		SHELL: "/bin/bash",
		PATH: `${home}/.local/bin:${home}/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
		LANG: "C.UTF-8",
		TERM: "dumb",
	};
}
