import { describe, expect, test } from "vitest";
import { chunk, nonceFor, parseAction, stripMentions, threadTitle } from "../src/domain.ts";

describe("commands", () => {
	test.each([
		["fix the empty state", { kind: "say", text: "fix the empty state" }],
		["!help", { kind: "help" }],
		["!status", { kind: "status" }],
		["!STOP", { kind: "stop" }],
		["!queue add keyboard support", { kind: "queue", text: "add keyboard support" }],
		["!model gpt-5", { kind: "unsupported", command: "!model" }],
		["!models", { kind: "unsupported", command: "!models" }],
		["do it model=opus", { kind: "unsupported", command: "model=" }],
		["!stopper is a word", { kind: "say", text: "!stopper is a word" }],
	])("%s", (text, action) => expect(parseAction(text)).toEqual(action));

	test("an empty !queue is an error, not a model call", () => {
		expect(parseAction("!queue   ").kind).toBe("invalid");
	});

	test("only the bot's own mentions are stripped", () => {
		expect(stripMentions("<@111111111111111111> hi <@!111111111111111111> <@222222222222222222> <@&333333333333333333>", "111111111111111111", ["333333333333333333"])).toBe(
			"hi  <@222222222222222222>",
		);
	});

	test("thread titles are one bounded line", () => {
		expect(threadTitle("a\nb  c")).toBe("a b c");
		expect(threadTitle("x".repeat(200))).toHaveLength(90);
		expect(threadTitle("  ")).toBe("conversation");
	});
});

describe("delivery parts", () => {
	test("short text is one part", () => expect(chunk("hello")).toEqual(["hello"]));

	test("long text splits under Discord's limit and prefers newlines", () => {
		const text = `${"a".repeat(1500)}\n${"b".repeat(1500)}`;
		const parts = chunk(text);
		expect(parts).toEqual(["a".repeat(1500), "b".repeat(1500)]);
	});

	test("very long text is truncated visibly", () => {
		const parts = chunk("x".repeat(20_000));
		expect(parts).toHaveLength(5);
		for (const part of parts) expect(part.length).toBeLessThanOrEqual(2000);
		expect(parts[4]).toContain("answer truncated");
	});

	test("nonces are deterministic, distinct per part and at most 25 characters", async () => {
		const a = await nonceFor("answer:1:0:0");
		expect(a).toBe(await nonceFor("answer:1:0:0"));
		expect(a).not.toBe(await nonceFor("answer:1:1:0"));
		expect(a.length).toBeLessThanOrEqual(25);
	});
});
