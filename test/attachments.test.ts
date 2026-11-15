import { afterEach, describe, expect, test, vi } from "vitest";
import { attachmentKind, readAttachment } from "../src/attachments.ts";
import { FakeNet } from "./net.ts";

const ref = (over: Record<string, unknown> = {}) => ({ id: "1", name: "notes.md", url: "https://cdn.discordapp.com/attachments/1/2/notes.md", size: 12, contentType: "text/markdown", ...over });
const textOf = (r: Awaited<ReturnType<typeof readAttachment>>) => (r.output ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");

afterEach(() => vi.restoreAllMocks());

describe("attachments", () => {
	test("kinds come from content type or extension", () => {
		expect(attachmentKind({ name: "a.png", contentType: "image/png" })).toBe("image");
		expect(attachmentKind({ name: "main.rs" })).toBe("text");
		expect(attachmentKind({ name: "a.zip", contentType: "application/zip" })).toBe("unsupported");
	});

	test("text from the Discord CDN is read", async () => {
		new FakeNet().install().on((c) => (c.url.startsWith("https://cdn.discordapp.com/") ? new Response("# Notes\nhello") : undefined));
		const result = await readAttachment(ref());
		expect(result.isError).toBeUndefined();
		expect(textOf(result)).toContain("# Notes\nhello");
	});

	test("images come back as image content", async () => {
		new FakeNet().install().on((c) => (c.url.startsWith("https://cdn.discordapp.com/") ? new Response(new Uint8Array([137, 80, 78, 71])) : undefined));
		const result = await readAttachment(ref({ name: "shot.png", contentType: "image/png" }));
		expect(result.output?.[1]).toMatchObject({ type: "image", mimeType: "image/png", data: "iVBORw==" });
	});

	test("other hosts, redirects, unsupported types and size lies are refused", async () => {
		const net = new FakeNet().install();
		net.on((c) => (c.url.includes("redirect") ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }) : undefined));
		net.on((c) => (c.url.includes("huge") ? new Response(new Uint8Array(600 * 1024)) : undefined));
		expect((await readAttachment(ref({ url: "https://evil.example/x.md" }))).isError).toBe(true);
		expect((await readAttachment(ref({ url: "https://cdn.discordapp.com/redirect.md" }))).isError).toBe(true);
		expect((await readAttachment(ref({ name: "a.zip", contentType: "application/zip" }))).isError).toBe(true);
		const lie = await readAttachment(ref({ url: "https://cdn.discordapp.com/huge.md" }));
		expect(lie.isError).toBe(true);
		expect(textOf(lie)).toContain("larger than");
		expect(net.calls.some((c) => c.url.includes("evil.example"))).toBe(false);
	});
});
