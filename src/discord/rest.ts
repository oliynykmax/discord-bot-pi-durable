export type RestResult<T> =
	| { readonly ok: true; readonly status: number; readonly body: T }
	| { readonly ok: false; readonly kind: "rate_limited"; readonly retryAfterMs: number; readonly global: boolean }
	| { readonly ok: false; readonly kind: "rejected"; readonly status: number; readonly code?: number }
	| { readonly ok: false; readonly kind: "unavailable"; readonly status?: number; readonly ambiguous: boolean };

export type DiscordMessage = {
	readonly id: string;
	readonly channel_id: string;
	readonly content: string;
	readonly author?: { readonly id: string };
	readonly nonce?: string | number;
};

export type DiscordChannel = {
	readonly id: string;
	readonly type: number;
	readonly parent_id?: string | null;
	readonly guild_id?: string;
};

export type GatewayBot = {
	readonly url: string;
	readonly session_start_limit: { readonly remaining: number; readonly reset_after: number };
};

const TIMEOUT_MS = 15_000;

export class DiscordRest {
	constructor(
		private readonly token: string,
		private readonly base: string,
	) {}

	async request<T>(method: string, path: string, body?: unknown): Promise<RestResult<T>> {
		let response: Response;
		try {
			response = await fetch(`${this.base}${path}`, {
				method,
				headers: {
					authorization: `Bot ${this.token}`,
					"user-agent": "DiscordBot (https://github.com/oliynykmax/bobik-pi-durable, 0.1)",
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
		} catch {
			return { ok: false, kind: "unavailable", ambiguous: method !== "GET" };
		}
		if (response.status === 429) {
			const data = (await response.json().catch(() => ({}))) as { retry_after?: number; global?: boolean };
			const header = Number(response.headers.get("retry-after"));
			const seconds = typeof data.retry_after === "number" ? data.retry_after : Number.isFinite(header) ? header : 5;
			return { ok: false, kind: "rate_limited", retryAfterMs: Math.ceil(seconds * 1000) + 250, global: data.global === true };
		}
		if (response.status >= 500) {
			await response.body?.cancel();
			return { ok: false, kind: "unavailable", status: response.status, ambiguous: method !== "GET" };
		}
		if (!response.ok) {
			const data = (await response.json().catch(() => ({}))) as { code?: number };
			return { ok: false, kind: "rejected", status: response.status, ...(typeof data.code === "number" ? { code: data.code } : {}) };
		}
		const text = await response.text();
		return { ok: true, status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
	}

	sendMessage(channelId: string, content: string, nonce: string, replyTo?: string) {
		return this.request<DiscordMessage>("POST", `/channels/${channelId}/messages`, {
			content,
			nonce,
			enforce_nonce: true,
			allowed_mentions: { parse: [], replied_user: false },
			...(replyTo ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
		});
	}

	react(channelId: string, messageId: string, emoji: string) {
		return this.request<undefined>("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
	}

	startThread(channelId: string, messageId: string, name: string) {
		return this.request<DiscordChannel>("POST", `/channels/${channelId}/messages/${messageId}/threads`, {
			name,
			auto_archive_duration: 1440,
		});
	}

	channel(channelId: string) {
		return this.request<DiscordChannel>("GET", `/channels/${channelId}`);
	}

	messagesAfter(channelId: string, afterId: string) {
		return this.request<DiscordMessage[]>("GET", `/channels/${channelId}/messages?after=${afterId}&limit=100`);
	}

	gatewayBot() {
		return this.request<GatewayBot>("GET", "/gateway/bot");
	}
}

export const THREAD_ALREADY_CREATED = 160004;
