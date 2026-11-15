import { Connection, type Reply, type RequestOptions, RemoteExecutionEnv, type RemoteInfo } from "@earendil-works/pi-env";
import { type Dial, releaseProgram, websocketProgram } from "./child-process.ts";

export const SHELL_ENV_ID = "bobik-shell";
export const THREADS_DIR = "/home/bobik/threads";
const IDLE_MS = 60_000;

type Json = Record<string, unknown>;

/**
 * One pi-env connection for one Discord thread, in the shape `RemoteExecutionEnv` uses. It creates `cwd`, the thread's
 * folder, once per daemon session, and hangs up after a minute without requests: an open outbound socket keeps the Durable
 * Object resident and its daemon running. The next request connects again.
 */
export class ShellLink {
	readonly cwd: string;
	readonly #program: string;
	readonly #connection: Connection;
	readonly #idleMs: number;
	#socket: WebSocket | undefined;
	#busy = 0;
	#idle: ReturnType<typeof setTimeout> | undefined;
	#prepared: number | undefined;

	constructor(dial: Dial, cwd: string, idleMs = IDLE_MS) {
		this.cwd = cwd;
		this.#program = websocketProgram(async () => {
			this.#socket = await dial();
			return this.#socket;
		});
		this.#connection = new Connection({ command: [this.#program] });
		this.#idleMs = idleMs;
	}

	env(): RemoteExecutionEnv {
		// `Connection` has private fields, so only a cast lets this object stand in for one.
		return new RemoteExecutionEnv({ connection: this as unknown as Connection, id: SHELL_ENV_ID, cwd: this.cwd });
	}

	info(signal?: AbortSignal): Promise<RemoteInfo> {
		return this.#track(() => this.#connection.info(signal));
	}

	session(): Promise<number> {
		return this.#track(() => this.#connection.session());
	}

	request(op: string, json: Json, options: RequestOptions = {}): Promise<Reply> {
		return this.#track(async () => {
			if (options.session === undefined) await this.#prepare(options.signal);
			return this.#connection.request(op, json, options);
		});
	}

	kill(id: number, session: number): void {
		this.#connection.kill(id, session);
	}

	close(): void {
		clearTimeout(this.#idle);
		this.#connection.close();
		releaseProgram(this.#program);
	}

	/** Closes the socket now if nothing is in flight; the daemon kills what it started. */
	hangUp(): void {
		if (this.#busy === 0) this.#socket?.close(1000, "idle");
	}

	async #prepare(signal: AbortSignal | undefined) {
		const session = await this.#connection.session();
		if (this.#prepared === session) return;
		await this.#connection.request("mkdir", { path: this.cwd, recursive: true }, { session, ...(signal ? { signal } : {}) });
		this.#prepared = session;
	}

	async #track<T>(work: () => Promise<T>): Promise<T> {
		this.#busy++;
		clearTimeout(this.#idle);
		try {
			return await work();
		} finally {
			if (--this.#busy === 0) this.#idle = setTimeout(() => this.hangUp(), this.#idleMs);
		}
	}
}
