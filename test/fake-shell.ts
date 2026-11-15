import type { Call } from "./net.ts";

const REQUEST = 1;
const RESULT = 2;
const EVENT = 4;

function frame(type: number, id: number, json: object, payload: Uint8Array = new Uint8Array(0)): Uint8Array<ArrayBuffer> {
	const body = new TextEncoder().encode(JSON.stringify(json));
	const out = new Uint8Array(13 + body.length + payload.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, 9 + body.length + payload.length);
	view.setUint8(4, type);
	view.setUint32(5, id);
	view.setUint32(9, body.length);
	out.set(body, 13);
	out.set(payload, 13 + body.length);
	return out;
}

function parse(bytes: Uint8Array) {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const jsonLength = view.getUint32(9);
	return { type: view.getUint8(4), id: view.getUint32(5), json: JSON.parse(new TextDecoder().decode(bytes.subarray(13, 13 + jsonLength))) as Record<string, unknown> };
}

/** Answers the WebSocket upgrade to shell.test as the bridge would, with a scripted pi-env daemon behind it. */
export class FakeShell {
	readonly upgrades: Call[] = [];
	readonly requests: { op: string; json: Record<string, unknown> }[] = [];
	args: unknown;

	handler = (call: Call): Response | undefined => {
		if (new URL(call.url).hostname !== "shell.test") return undefined;
		this.upgrades.push(call);
		const { 0: client, 1: server } = new WebSocketPair();
		server.accept();
		server.binaryType = "arraybuffer";
		server.addEventListener("message", (event) => this.#onMessage(server, event.data));
		return new Response(null, { status: 101, webSocket: client });
	};

	#onMessage(server: WebSocket, data: string | ArrayBuffer) {
		if (typeof data === "string") {
			this.args = (JSON.parse(data) as { args: string[] }).args;
			server.send(new TextEncoder().encode(`PI-ENV ${(this.args as string[])[2]}\n`));
			return;
		}
		const { type, id, json } = parse(new Uint8Array(data));
		if (type !== REQUEST) return;
		const { op, ...rest } = json;
		this.requests.push({ op: String(op), json: rest });
		if (op === "hello") {
			server.send(
				frame(RESULT, id, { protocol: 1, version: "1.5.2", os: "linux", arch: "x86_64", home: "/home/bobik", tmpdir: "/tmp", cwd: "/home/bobik", driveCwds: {}, pid: 7, features: ["listFiles"] }),
			);
		} else if (op === "exec") {
			server.send(frame(EVENT, id, { kind: "output", stream: "stdout" }, new TextEncoder().encode("hi\n")));
			server.send(frame(RESULT, id, { exitCode: 0 }));
		} else {
			server.send(frame(RESULT, id, {}));
		}
	}
}
