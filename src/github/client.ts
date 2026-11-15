import { allowRequest, type Scope } from "./policy.ts";

export class GitHubError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export class PolicyDenied extends Error {}

export type AppCredentials = {
	readonly appId: string;
	readonly installationId: string;
	readonly privateKeyPkcs8: string;
	readonly repository: string;
};

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlText = (text: string) => b64url(new TextEncoder().encode(text));

function pemBody(pem: string): Uint8Array {
	if (!pem.includes("BEGIN PRIVATE KEY")) throw new Error("GH_APP_PRIVATE_KEY_PKCS8 must be a PKCS#8 PEM key");
	const base64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
	return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

export async function appJwt(appId: string, pkcs8Pem: string, nowMs = Date.now()): Promise<string> {
	const key = await crypto.subtle.importKey("pkcs8", pemBody(pkcs8Pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
	const now = Math.floor(nowMs / 1000);
	const unsigned = `${b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64urlText(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }))}`;
	const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
	return `${unsigned}.${b64url(signature)}`;
}

const HEADERS = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "bobik-pi-durable" };

export class InstallationTokens {
	#token: { value: string; expiresAt: number } | undefined;

	constructor(
		private readonly api: string,
		private readonly credentials: AppCredentials,
	) {}

	async get(): Promise<string> {
		if (this.#token && this.#token.expiresAt - Date.now() > 5 * 60_000) return this.#token.value;
		const jwt = await appJwt(this.credentials.appId, this.credentials.privateKeyPkcs8);
		const response = await fetch(`${this.api}/app/installations/${this.credentials.installationId}/access_tokens`, {
			method: "POST",
			headers: { ...HEADERS, authorization: `Bearer ${jwt}`, "content-type": "application/json" },
			body: JSON.stringify({
				repositories: [this.credentials.repository],
				permissions: { contents: "write", pull_requests: "write", metadata: "read" },
			}),
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) throw new GitHubError(response.status, `installation token request failed with HTTP ${response.status}`);
		const data = (await response.json()) as { token: string; expires_at: string };
		this.#token = { value: data.token, expiresAt: Date.parse(data.expires_at) };
		return data.token;
	}
}

export class GitHubClient {
	constructor(
		private readonly api: string,
		readonly scope: Scope,
		private readonly tokens: Pick<InstallationTokens, "get">,
	) {}

	get repoPath() {
		return `/repos/${this.scope.owner}/${this.scope.name}`;
	}

	async request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
		const verdict = allowRequest(method, path, body, this.scope);
		if (!verdict.ok) throw new PolicyDenied(verdict.reason);
		const response = await fetch(`${this.api}${path}`, {
			method,
			headers: { ...HEADERS, authorization: `Bearer ${await this.tokens.get()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(20_000),
		});
		if (!response.ok) {
			const data = (await response.json().catch(() => ({}))) as { message?: string };
			throw new GitHubError(response.status, `GitHub ${method} ${path.split("?")[0]} failed: HTTP ${response.status}${data.message ? ` ${data.message.slice(0, 200)}` : ""}`);
		}
		return (await response.json()) as T;
	}

	async get<T>(path: string): Promise<T | undefined> {
		try {
			return await this.request<T>("GET", path);
		} catch (error) {
			if (error instanceof GitHubError && error.status === 404) return undefined;
			throw error;
		}
	}
}
