import type { Dial } from "./child-process.ts";

/** Opens the bridge socket from a Worker: an outbound WebSocket is a fetch with `Upgrade`, which carries headers. */
export function workerDial(url: string, token: string): Dial {
	const target = url.replace(/^ws/, "http");
	return async () => {
		const response = await fetch(target, { headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` } });
		const socket = response.webSocket;
		if (!socket) throw new Error(`shell bridge refused the connection (HTTP ${response.status})`);
		socket.accept();
		return socket;
	};
}
