import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { int, obj, str } from "@earendil-works/pi-schema";
import type { AttachmentRef } from "./domain.ts";

const CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_CHARS = 60_000;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const TEXT_TYPES = /^(text\/|application\/(json|xml|yaml|x-yaml|javascript|typescript|toml|x-sh|sql|csv))/;
const TEXT_EXTENSIONS = /\.(txt|md|markdown|json|jsonc|ya?ml|toml|csv|tsv|log|xml|html?|css|scss|js|jsx|mjs|cjs|ts|tsx|py|rs|go|java|kt|cs|c|h|cpp|hpp|rb|php|sh|bash|zsh|sql|ini|cfg|conf|env\.example|diff|patch)$/i;

export type AttachmentKind = "image" | "text" | "unsupported";

export function attachmentKind(ref: Pick<AttachmentRef, "name" | "contentType">): AttachmentKind {
	const type = ref.contentType?.split(";")[0]?.trim().toLowerCase();
	if (type && IMAGE_TYPES.has(type)) return "image";
	if ((type && TEXT_TYPES.test(type)) || TEXT_EXTENSIONS.test(ref.name)) return "text";
	return "unsupported";
}

export function cdnUrl(raw: string): URL | undefined {
	try {
		const url = new URL(raw);
		return url.protocol === "https:" && CDN_HOSTS.has(url.hostname) ? url : undefined;
	} catch {
		return undefined;
	}
}

const failure = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true });

async function readCapped(response: Response, limit: number): Promise<Uint8Array | undefined> {
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			return undefined;
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

export async function readAttachment(ref: AttachmentRef): Promise<ToolExecutionResult> {
	const kind = attachmentKind(ref);
	if (kind === "unsupported") return failure(`${ref.name} (${ref.contentType ?? "unknown type"}) is not a text or image file, so it cannot be read.`);
	const limit = kind === "image" ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
	if (ref.size > limit) return failure(`${ref.name} is ${ref.size} bytes; the limit for ${kind} attachments is ${limit}.`);
	const url = cdnUrl(ref.url);
	if (!url) return failure(`${ref.name} is not hosted on the Discord CDN.`);
	let response: Response;
	try {
		response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
	} catch {
		return failure(`Downloading ${ref.name} failed.`);
	}
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel();
		return failure(`${ref.name} redirected away from the Discord CDN.`);
	}
	if (!response.ok) {
		await response.body?.cancel();
		return failure(`Downloading ${ref.name} failed with HTTP ${response.status}. Discord attachment links expire; ask for the file again.`);
	}
	const bytes = await readCapped(response, limit);
	if (!bytes) return failure(`${ref.name} is larger than ${limit} bytes.`);
	if (kind === "image") {
		const mimeType = ref.contentType!.split(";")[0]!.trim().toLowerCase();
		return { output: [{ type: "text", text: `${ref.name}, ${bytes.byteLength} bytes:` }, { type: "image", data: base64(bytes), mimeType }] };
	}
	const body = new TextDecoder().decode(bytes);
	const clipped = body.length > MAX_TEXT_CHARS;
	return { output: [{ type: "text", text: `${ref.name}, ${bytes.byteLength} bytes${clipped ? `, first ${MAX_TEXT_CHARS} characters` : ""}:\n${body.slice(0, MAX_TEXT_CHARS)}` }] };
}

const Args = obj({
	message_id: str({ pattern: "^\\d{15,21}$", description: "Discord message id the attachment came with." }),
	index: int({ minimum: 1, maximum: 10, description: "1-based attachment number from the message." }),
});

export function attachmentTool(lookup: (messageId: string, index: number) => AttachmentRef | undefined): ToolRegistration {
	const tool: ToolRegistration<typeof Args> = {
		name: "discord_read_attachment",
		description: "Read a text or image file a user attached to a Discord message in this thread.",
		parameters: Args,
		replay: "safe",
		async execute(args) {
			const ref = lookup(args.message_id, args.index);
			if (!ref) return failure(`Message ${args.message_id} has no attachment ${args.index} in this conversation.`);
			return readAttachment(ref);
		},
	};
	return tool as ToolRegistration;
}
