import { type Action, type AttachmentRef, HELP, MAX_ATTACHMENTS, parseAction, stripMentions, threadTitle } from "../domain.ts";
import { type Access, snowflake, type Snowflake } from "../env.ts";

export type Inbound = {
	readonly id: Snowflake;
	readonly channelId: Snowflake;
	readonly guildId: Snowflake;
	readonly authorId: Snowflake;
	readonly authorName: string;
	readonly allowed: boolean;
	readonly mentioned: boolean;
	readonly text: string;
	readonly attachments: readonly AttachmentRef[];
};

export type View = {
	readonly botId: Snowflake | undefined;
	readonly botRoles: ReadonlySet<string>;
	readonly bound: (channelId: string) => boolean;
	readonly access: Access;
};

type RawMessage = {
	id?: unknown;
	channel_id?: unknown;
	guild_id?: unknown;
	webhook_id?: unknown;
	content?: unknown;
	author?: { id?: unknown; bot?: unknown; username?: unknown; global_name?: unknown };
	member?: { roles?: unknown; nick?: unknown };
	mentions?: { id?: unknown }[];
	mention_roles?: unknown;
	attachments?: { id?: unknown; filename?: unknown; url?: unknown; size?: unknown; content_type?: unknown }[];
};

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

export function isAllowed(authorId: string, roles: readonly string[], access: Access): boolean {
	return access.users.has(authorId as Snowflake) || roles.some((role) => access.roles.has(role as Snowflake));
}

export function inbound(raw: unknown, view: View): Inbound | undefined {
	const d = raw as RawMessage;
	if (!view.botId || d.webhook_id != null) return undefined;
	if (d.author?.bot === true) return undefined;
	const id = snowflake(d.id);
	const channelId = snowflake(d.channel_id);
	const guildId = snowflake(d.guild_id);
	const authorId = snowflake(d.author?.id);
	if (!id || !channelId || !guildId || !authorId || authorId === view.botId) return undefined;
	const content = typeof d.content === "string" ? d.content : "";
	const mentionRoles = strings(d.mention_roles);
	const mentioned =
		(d.mentions ?? []).some((m) => m.id === view.botId) ||
		mentionRoles.some((role) => view.botRoles.has(role)) ||
		content.includes(`<@${view.botId}>`) ||
		content.includes(`<@!${view.botId}>`);
	const bound = view.bound(channelId);
	if (!mentioned && !bound) return undefined;
	const allowed = isAllowed(authorId, strings(d.member?.roles), view.access);
	if (!allowed && !mentioned) return undefined;
	const name = [d.member?.nick, d.author?.global_name, d.author?.username].find((v): v is string => typeof v === "string" && v.length > 0) ?? "user";
	const attachments: AttachmentRef[] = [];
	for (const a of (d.attachments ?? []).slice(0, MAX_ATTACHMENTS)) {
		if (typeof a.id !== "string" || typeof a.url !== "string" || typeof a.filename !== "string") continue;
		attachments.push({
			id: a.id,
			name: a.filename.slice(0, 200),
			url: a.url,
			size: typeof a.size === "number" ? a.size : 0,
			...(typeof a.content_type === "string" ? { contentType: a.content_type } : {}),
		});
	}
	return {
		id,
		channelId,
		guildId,
		authorId,
		authorName: name.slice(0, 80),
		allowed,
		mentioned,
		text: stripMentions(content, view.botId, view.botRoles),
		attachments,
	};
}

export type ChannelKind = { readonly kind: "text" } | { readonly kind: "thread"; readonly parentId: string | undefined } | { readonly kind: "other" };

export function channelKind(type: number, parentId: string | null | undefined): ChannelKind {
	if (type === 0 || type === 5) return { kind: "text" };
	if (type === 10 || type === 11 || type === 12) return { kind: "thread", parentId: parentId ?? undefined };
	return { kind: "other" };
}

export type Route =
	| { readonly kind: "ignore" }
	| { readonly kind: "reply"; readonly text: string }
	| { readonly kind: "converse"; readonly threadId: Snowflake; readonly action: Action; readonly open: "bound" | "bind" | "start"; readonly title: string };

export const unsupported = (command: string) => `\`${command}\` is not supported: bobik always uses kimi-k3-1-pro on Verda.`;

export const DENIED = "You are not on this bot's allowlist.";

export function route(message: Inbound, channel: ChannelKind | undefined, bound: boolean, access: Access): Route {
	if (!message.allowed) return message.mentioned ? { kind: "reply", text: DENIED } : { kind: "ignore" };
	const action = parseAction(message.text);
	const title = threadTitle(message.text || message.attachments[0]?.name || "");
	if (bound) {
		const empty = action.kind === "say" && !action.text && message.attachments.length === 0;
		return empty ? { kind: "reply", text: HELP } : { kind: "converse", threadId: message.channelId, action, open: "bound", title };
	}
	if (!message.mentioned || !channel) return { kind: "ignore" };
	const home = channel.kind === "thread" ? channel.parentId : message.channelId;
	if (access.channels.size > 0 && !(home && access.channels.has(home as Snowflake))) return { kind: "ignore" };
	if (action.kind === "help" || (action.kind === "say" && !action.text && message.attachments.length === 0)) return { kind: "reply", text: HELP };
	if (action.kind === "invalid") return { kind: "reply", text: action.reason };
	if (action.kind === "unsupported") return { kind: "reply", text: unsupported(action.command) };
	if (action.kind !== "say" && action.kind !== "queue") {
		return { kind: "reply", text: "That command works inside a bobik thread. Tag me with a request to start one." };
	}
	if (channel.kind === "thread") return { kind: "converse", threadId: message.channelId, action, open: "bind", title };
	if (channel.kind === "text") return { kind: "converse", threadId: message.id, action, open: "start", title };
	return { kind: "reply", text: "Tag me in a text channel or in a thread." };
}
