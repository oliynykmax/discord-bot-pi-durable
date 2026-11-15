import type { Snowflake } from "./env.ts";

export type Action =
	| { readonly kind: "say"; readonly text: string }
	| { readonly kind: "queue"; readonly text: string }
	| { readonly kind: "help" }
	| { readonly kind: "status" }
	| { readonly kind: "stop" }
	| { readonly kind: "unsupported"; readonly command: string }
	| { readonly kind: "invalid"; readonly reason: string };

export type AttachmentRef = {
	readonly id: string;
	readonly name: string;
	readonly url: string;
	readonly size: number;
	readonly contentType?: string;
};

export type ThreadInput = {
	readonly messageId: Snowflake;
	readonly threadId: Snowflake;
	readonly authorId: Snowflake;
	readonly authorName: string;
	readonly action: Action;
	readonly attachments: readonly AttachmentRef[];
};

export type Admission = {
	readonly duplicate: boolean;
	readonly reaction?: string;
};

export const MAX_INPUT_CHARS = 16_000;
export const MAX_ATTACHMENTS = 5;
export const MAX_PENDING_INPUTS = 20;
export const MAX_TOOL_ROUNDS = 12;

export const HELP = [
	"Tag me in a text channel to start a conversation in a new thread. Reply in that thread to steer the running work; no mention needed.",
	"`!queue <text>` runs a message after the current run. `!stop` stops the run and drops queued messages. `!status` shows the state.",
	"I can list, read and commit files in the team repository on my own branch `bobik/<thread id>`, open a pull request, and read PRs. I never push to main or merge.",
	"I can read text and image attachments on your messages. I cannot run a shell, run tests, take screenshots or send files back.",
	"The model is fixed: Kimi K3.1 Pro on Verda.",
].join("\n");

const COMMAND = /^!(\w+)\b\s*([\s\S]*)$/;

export function parseAction(raw: string): Action {
	const text = raw.trim();
	if (/(^|\s)model=\S+/.test(text)) return { kind: "unsupported", command: "model=" };
	const match = COMMAND.exec(text);
	if (!match) return { kind: "say", text };
	const name = match[1]!.toLowerCase();
	const rest = match[2]!.trim();
	switch (name) {
		case "help":
			return { kind: "help" };
		case "status":
			return { kind: "status" };
		case "stop":
			return { kind: "stop" };
		case "queue":
			return rest ? { kind: "queue", text: rest } : { kind: "invalid", reason: "`!queue` needs text, for example `!queue add tests`." };
		case "model":
		case "models":
			return { kind: "unsupported", command: `!${name}` };
		default:
			return { kind: "say", text };
	}
}

export function stripMentions(content: string, botId: string, botRoles: Iterable<string>): string {
	let text = content.replace(new RegExp(`<@!?${botId}>`, "g"), "");
	for (const role of botRoles) text = text.replaceAll(`<@&${role}>`, "");
	return text.trim();
}

export function threadTitle(text: string): string {
	const line = text.replace(/\s+/g, " ").trim().slice(0, 90).trim();
	return line || "conversation";
}

export const operationId = (messageId: string) => `discord:${messageId}`;
export const botBranch = (threadId: Snowflake) => `bobik/${threadId}`;

const CHUNK_CHARS = 1900;
const MAX_PARTS = 5;

export function chunk(text: string): string[] {
	const parts: string[] = [];
	let rest = text.trim() || "(empty answer)";
	while (rest.length > 0 && parts.length < MAX_PARTS) {
		if (rest.length <= CHUNK_CHARS) {
			parts.push(rest);
			rest = "";
			break;
		}
		const window = rest.slice(0, CHUNK_CHARS);
		const newline = window.lastIndexOf("\n");
		const cut = newline > CHUNK_CHARS / 2 ? newline : CHUNK_CHARS;
		parts.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).trimStart();
	}
	if (rest.length > 0) {
		const last = parts.length - 1;
		parts[last] = `${parts[last]!.slice(0, CHUNK_CHARS - 40)}\n… (answer truncated)`;
	}
	return parts;
}

export async function nonceFor(key: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
	let value = 0n;
	for (const byte of digest.subarray(0, 16)) value = (value << 8n) | BigInt(byte);
	return value.toString(36).padStart(25, "0").slice(0, 25);
}

const DISCORD_EPOCH = 1420070400000n;

export function snowflakeAt(epochMs: number): string {
	return ((BigInt(Math.max(0, Math.floor(epochMs))) - DISCORD_EPOCH) << 22n).toString();
}
