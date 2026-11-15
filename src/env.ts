import type { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";
import type { Conversation } from "./conversation.ts";
import type { DiscordGateway } from "./gateway.ts";

declare global {
	namespace Cloudflare {
		interface Env {
			GATEWAY: DurableObjectNamespace<DiscordGateway>;
			CONVERSATIONS: DurableObjectNamespace<Conversation>;
			CODEMODE_SANDBOX: DurableObjectNamespace<CodemodeSandboxDurableObject>;
			GH_APP_ID: string;
			GH_INSTALLATION_ID: string;
			GH_REPO: string;
			GH_BASE_BRANCH: string;
			VERDA_BASE_URL: string;
			DISCORD_TOKEN: string;
			GH_APP_PRIVATE_KEY_PKCS8: string;
			VERDA_API_KEY: string;
			ADMIN_SECRET: string;
			ALLOWED_USER_IDS: string;
			ALLOWED_ROLE_IDS?: string;
			CHANNEL_IDS?: string;
			DISCORD_API_BASE?: string;
			GITHUB_API_BASE?: string;
			SHELL_URL?: string;
			SHELL_TOKEN?: string;
		}
	}
}

export type Env = Cloudflare.Env;

/** The shell bridge, or `undefined` when either setting is missing: bobik then runs without shell tools. */
export function shellConfig(env: Env): { readonly url: string; readonly token: string } | undefined {
	return env.SHELL_URL && env.SHELL_TOKEN ? { url: env.SHELL_URL, token: env.SHELL_TOKEN } : undefined;
}

export type Snowflake = string & { readonly __snowflake: unique symbol };

const SNOWFLAKE = /^\d{15,21}$/;

export function snowflake(value: unknown): Snowflake | undefined {
	return typeof value === "string" && SNOWFLAKE.test(value) ? (value as Snowflake) : undefined;
}

function idSet(raw: string | undefined): ReadonlySet<Snowflake> {
	const ids = new Set<Snowflake>();
	for (const part of (raw ?? "").split(",")) {
		const id = snowflake(part.trim());
		if (id) ids.add(id);
	}
	return ids;
}

export type Access = {
	readonly users: ReadonlySet<Snowflake>;
	readonly roles: ReadonlySet<Snowflake>;
	readonly channels: ReadonlySet<Snowflake>;
};

export function accessFrom(env: Env): Access {
	return { users: idSet(env.ALLOWED_USER_IDS), roles: idSet(env.ALLOWED_ROLE_IDS), channels: idSet(env.CHANNEL_IDS) };
}

export type Repo = { readonly owner: string; readonly name: string; readonly base: string };

const REPO_PART = /^[A-Za-z0-9_.-]{1,100}$/;

export function repoFrom(env: Env): Repo {
	const [owner, name, extra] = env.GH_REPO.split("/");
	if (!owner || !name || extra !== undefined || !REPO_PART.test(owner) || !REPO_PART.test(name)) {
		throw new Error("GH_REPO must be owner/name");
	}
	const base = env.GH_BASE_BRANCH || "main";
	return { owner, name, base };
}

export const discordApi = (env: Env) => env.DISCORD_API_BASE ?? "https://discord.com/api/v10";
export const githubApi = (env: Env) => env.GITHUB_API_BASE ?? "https://api.github.com";
