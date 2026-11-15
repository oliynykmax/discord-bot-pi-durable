import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Dial } from "../../src/shell/child-process.ts";
import { ShellLink } from "../../src/shell/link.ts";

// This config aliases node:child_process to the WebSocket shim, as the Worker bundle does; the test needs the real one.
const { execFileSync, spawn } = process.getBuiltinModule("node:child_process");
const root = fileURLToPath(new URL("../../", import.meta.url).href);
const daemon = join(root, "node_modules/@earendil-works/pi-env/bin/pi-env-linux-x64/pi-env");
const hasBun = (() => {
	try {
		execFileSync("bun", ["--version"]);
		return true;
	} catch {
		return false;
	}
})();
const runnable = process.platform === "linux" && process.arch === "x64" && existsSync(daemon) && hasBun;

const token = randomBytes(24).toString("hex");
let home: string;
let bridge: ChildProcess;
let base: string;

function nodeDial(url: string, bearer: string): Dial {
	return () =>
		new Promise((resolve, reject) => {
			const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${bearer}` } } as never);
			socket.binaryType = "arraybuffer";
			socket.onopen = () => resolve(socket);
			socket.onerror = () => reject(new Error(`could not open ${url}`));
		});
}

const health = async () => (await (await fetch(`${base}/healthz`)).json()) as { status: string; sessions: number };

async function until(probe: () => Promise<boolean>, what: string) {
	const start = Date.now();
	while (!(await probe())) {
		if (Date.now() - start > 10_000) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 50));
	}
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe.runIf(runnable)("bridge and pi-env daemon end to end", () => {
	beforeAll(async () => {
		home = await mkdtemp(join(tmpdir(), "bobik-shell-"));
		bridge = spawn("bun", [join(root, "shell-host/bridge.ts")], {
			env: {
				PATH: process.env.PATH,
				PORT: "0",
				SHELL_TOKEN_SHA256: createHash("sha256").update(token).digest("hex"),
				PI_ENV_COMMAND: daemon,
				SHELL_HOME: home,
			},
			stdio: ["ignore", "pipe", "inherit"],
		});
		const port = await new Promise<string>((resolve, reject) => {
			bridge.once("exit", (code) => reject(new Error(`bridge exited with ${code}`)));
			bridge.stdout!.setEncoding("utf8").on("data", (text: string) => {
				const match = /on [\d.]+:(\d+)/.exec(text);
				if (match) resolve(match[1]!);
			});
		});
		base = `http://127.0.0.1:${port}`;
	});

	afterAll(async () => {
		bridge?.kill("SIGTERM");
		if (home) await rm(home, { recursive: true, force: true });
	});

	test("healthz answers without auth", async () => {
		expect(await health()).toMatchObject({ status: "ok" });
	});

	test("a wrong token cannot open the socket", async () => {
		const link = new ShellLink(nodeDial(`${base.replace("http", "ws")}/pi-env`, "wrong"), join(home, "threads/x"));
		await expect(link.env().exec("echo hi", undefined, BACKGROUND_CONTEXT)).resolves.toMatchObject({ ok: false });
		link.close();
	});

	test("a socket with bad daemon arguments is closed without starting anything", async () => {
		const socket = await nodeDial(`${base.replace("http", "ws")}/pi-env`, token)();
		const closed = new Promise<number>((resolve) => (socket.onclose = (event) => resolve(event.code)));
		socket.send(JSON.stringify({ args: ["serve", "--token", "x; touch /tmp/pwned"] }));
		expect(await closed).toBe(1008);
		expect((await health()).sessions).toBe(0);
	});

	test("RemoteExecutionEnv runs commands and round-trips files in the thread's folder", async () => {
		const cwd = join(home, "threads/310000000000000001");
		const link = new ShellLink(nodeDial(`${base.replace("http", "ws")}/pi-env`, token), cwd);
		const env = link.env();
		let output = "";
		const echoed = await env.exec("echo hi", { onOutput: (text) => (output += text) }, BACKGROUND_CONTEXT);
		expect(echoed).toEqual({ ok: true, value: { exitCode: 0 } });
		expect(output).toBe("hi\n");

		expect(await env.writeFile("notes/hello.txt", "héllo from bobik\n", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: undefined });
		expect(await env.readTextFile("notes/hello.txt", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: "héllo from bobik\n" });
		expect(await readFile(join(cwd, "notes/hello.txt"), "utf8")).toBe("héllo from bobik\n");

		let pwd = "";
		await env.exec("pwd; echo $HOME; env | grep -c TOKEN || true", { onOutput: (text) => (pwd += text) }, BACKGROUND_CONTEXT);
		expect(pwd).toBe(`${cwd}\n${home}\n0\n`);
		expect(await env.exec("exit 3", undefined, BACKGROUND_CONTEXT)).toEqual({ ok: true, value: { exitCode: 3 } });

		let pidText = "";
		await env.exec("sleep 300 >/dev/null 2>&1 & echo $!", { onOutput: (text) => (pidText += text) }, BACKGROUND_CONTEXT);
		const sleeper = Number(pidText.trim());
		expect(alive(sleeper)).toBe(true);
		expect((await health()).sessions).toBe(1);

		link.hangUp();
		await until(async () => (await health()).sessions === 0, "the daemon to exit after hang-up");
		await until(async () => !alive(sleeper), "the background sleep to be killed");

		let again = "";
		expect(await env.exec("cat notes/hello.txt", { onOutput: (text) => (again += text) }, BACKGROUND_CONTEXT)).toMatchObject({ ok: true, value: { exitCode: 0 } });
		expect(again).toBe("héllo from bobik\n");
		expect((await health()).sessions).toBe(1);
		link.close();
		await until(async () => (await health()).sessions === 0, "the daemon to exit after close");
	});
});
