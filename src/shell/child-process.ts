// Stands in for `node:child_process` in the Worker bundle (see the `alias` in wrangler.jsonc), so pi-env's own
// `Connection` runs unchanged: `spawn()` of a program made by `websocketProgram()` returns a child whose stdin, stdout,
// stderr and exit travel over a WebSocket to shell-host/bridge.ts, which runs the real daemon.
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";

/** Opens a WebSocket to the bridge that is ready to send. */
export type Dial = () => Promise<WebSocket>;

const programs = new Map<string, Dial>();

export function websocketProgram(dial: Dial): string {
	const name = `websocket:${crypto.randomUUID()}`;
	programs.set(name, dial);
	return name;
}

export function releaseProgram(name: string): void {
	programs.delete(name);
}

class Stdin extends EventEmitter {
	constructor(
		readonly write: (data: Uint8Array) => boolean,
		readonly end: () => void,
	) {
		super();
	}
}

class Stderr extends EventEmitter {
	setEncoding(_encoding: string): this {
		return this;
	}
}

type Server = { readonly stderr?: unknown; readonly exit?: unknown };

export class WebSocketChild extends EventEmitter {
	readonly stdin = new Stdin(
		(data) => this.#send(data),
		() => this.kill(),
	);
	readonly stdout = new EventEmitter();
	readonly stderr = new Stderr();
	#socket: WebSocket | undefined;
	#queue: Uint8Array[] = [];
	#exitCode: number | null = null;
	#exited = false;
	#closed = false;

	constructor(dial: Dial, args: readonly string[]) {
		super();
		dial().then(
			(socket) => this.#attach(socket, args),
			(error: unknown) => {
				this.emit("error", error instanceof Error ? error : new Error(String(error)));
				this.#finish();
			},
		);
	}

	kill(): boolean {
		if (this.#closed) return false;
		if (this.#socket) this.#socket.close(1000, "closed by client");
		else this.#finish();
		return true;
	}

	#send(data: Uint8Array): boolean {
		if (this.#closed) return false;
		if (this.#socket) this.#socket.send(data);
		else this.#queue.push(data);
		return true;
	}

	#attach(socket: WebSocket, args: readonly string[]) {
		if (this.#closed) {
			socket.close(1000, "closed by client");
			return;
		}
		this.#socket = socket;
		// workerd delivers Blobs by default at recent compatibility dates.
		socket.binaryType = "arraybuffer";
		socket.addEventListener("message", (event) => this.#onMessage(event.data));
		socket.addEventListener("close", () => this.#finish());
		socket.send(JSON.stringify({ args }));
		for (const data of this.#queue) socket.send(data);
		this.#queue = [];
	}

	#onMessage(data: unknown) {
		if (typeof data !== "string") {
			this.stdout.emit("data", Buffer.from(data as ArrayBuffer));
			return;
		}
		let message: Server;
		try {
			message = JSON.parse(data) as Server;
		} catch {
			return;
		}
		if (typeof message.stderr === "string") this.stderr.emit("data", message.stderr);
		if (typeof message.exit === "number" && !this.#exited) {
			this.#exitCode = message.exit;
			this.#exited = true;
			this.emit("exit", message.exit, null);
		}
	}

	#finish() {
		if (this.#closed) return;
		this.#closed = true;
		this.#queue = [];
		if (!this.#exited) {
			this.#exited = true;
			this.emit("exit", this.#exitCode, null);
		}
		this.emit("close", this.#exitCode, null);
	}
}

export function spawn(program: string, args: readonly string[] = []): WebSocketChild {
	const dial = programs.get(program);
	if (dial === undefined) throw Object.assign(new Error(`spawn ${program}: this Worker only runs programs made by websocketProgram()`), { code: "ENOENT" });
	return new WebSocketChild(dial, args);
}
