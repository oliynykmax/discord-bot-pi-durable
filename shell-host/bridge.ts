// Runs pi-env daemons for bobik's Worker over WebSockets. Caddy terminates TLS in front of it.
// Binary frames are the daemon's stdin and stdout; the server also sends {"stderr": text} and {"exit": code}.
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { constants, userInfo } from "node:os";
import type { Readable, Writable } from "node:stream";
import type { ServerWebSocket } from "bun";
import { daemonArgs, daemonEnv, readConfig, route } from "./protocol.ts";

type Daemon = ChildProcessByStdio<Writable, Readable, Readable>;
type Socket = ServerWebSocket<{ daemon?: Daemon }>;

const KILL_GRACE_MS = 2_000;
const SESSION_VAR = "BOBIK_SHELL_SESSION";
const config = readConfig(process.env);
const env = daemonEnv(config.home, userInfo().username);
const live = new Set<Daemon>();

function send(ws: Socket, data: string | Uint8Array) {
	if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

/**
 * pi-env kills the process group of a command still running, but a command's background job outlives it. Every process
 * of a session inherits its marker, so this finds what is left once the daemon is gone.
 */
function killSession(session: string) {
	const marker = Buffer.from(`${SESSION_VAR}=${session}\0`);
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			if (readFileSync(`/proc/${entry}/environ`).includes(marker)) process.kill(Number(entry), "SIGKILL");
		} catch {
			// Gone, or not ours.
		}
	}
}

function start(ws: Socket, args: readonly string[]): Daemon {
	const [program, ...prefix] = config.command;
	const session = randomUUID();
	const daemon = spawn(program!, [...prefix, ...args], { cwd: config.home, env: { ...env, [SESSION_VAR]: session }, stdio: ["pipe", "pipe", "pipe"], detached: true });
	live.add(daemon);
	daemon.stdin.on("error", () => {});
	daemon.stdout.on("data", (chunk: Buffer) => send(ws, chunk));
	daemon.stderr.setEncoding("utf8").on("data", (text: string) => send(ws, JSON.stringify({ stderr: text })));
	daemon.on("error", (error) => {
		send(ws, JSON.stringify({ stderr: `bridge: ${error.message}\n` }));
		ws.close(1011, "daemon failed to start");
	});
	daemon.on("exit", (code, signal) => {
		killSession(session);
		send(ws, JSON.stringify({ exit: code ?? 128 + (signal ? constants.signals[signal] : 0) }));
	});
	daemon.on("close", () => {
		live.delete(daemon);
		ws.close(1000, "daemon exited");
	});
	return daemon;
}

/** End stdin, so the daemon kills what it started and exits; then kill its whole process group. */
function stop(daemon: Daemon | undefined) {
	if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return;
	daemon.stdin.end();
	setTimeout(() => {
		if (daemon.exitCode !== null || daemon.signalCode !== null || daemon.pid === undefined) return;
		try {
			process.kill(-daemon.pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}, KILL_GRACE_MS);
}

const server = Bun.serve<{ daemon?: Daemon }, never>({
	hostname: config.hostname,
	port: config.port,
	fetch(request, server) {
		const decision = route(request, config.tokenSha256, live.size);
		switch (decision.kind) {
			case "health":
				return Response.json({ service: "bobik-shell", status: "ok", sessions: live.size });
			case "reject":
				return new Response(decision.body, { status: decision.status });
			case "upgrade":
				return server.upgrade(request, { data: {} }) ? undefined : new Response("websocket upgrade failed", { status: 400 });
		}
	},
	websocket: {
		maxPayloadLength: 32 * 1024 * 1024,
		message(ws, message) {
			if (ws.data.daemon === undefined) {
				const args = daemonArgs(message);
				if (args === undefined) return ws.close(1008, 'first frame must be {"args":["serve","--token","<32 hex>"]}');
				ws.data.daemon = start(ws, args);
				return;
			}
			if (typeof message === "string") return ws.close(1008, "only binary frames after the first");
			ws.data.daemon.stdin.write(message);
		},
		close(ws) {
			stop(ws.data.daemon);
		},
	},
});

console.log(`bobik shell bridge on ${server.hostname}:${server.port}`);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		for (const daemon of live) stop(daemon);
		server.stop(true);
		setTimeout(() => process.exit(0), KILL_GRACE_MS + 100);
	});
}
