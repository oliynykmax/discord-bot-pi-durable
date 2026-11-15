import type { Context } from "@earendil-works/pi-ai";
import { KIMI_ID, VERDA_PROVIDER, verdaModels } from "../src/verda.ts";

const key = process.env.VERDA_API_KEY;
if (!key) throw new Error("VERDA_API_KEY is not set");
const env = { VERDA_API_KEY: key, VERDA_BASE_URL: "https://inference.verda.com/v1" } as Parameters<typeof verdaModels>[0];
const models = verdaModels(env);
const model = models.getModel(VERDA_PROVIDER, KIMI_ID);
if (!model) throw new Error("model not registered");

const context: Context = {
	systemPrompt: "Use the tool to answer. Be brief.",
	messages: [{ role: "user", content: "What is 17 times 23? Use the multiply tool.", timestamp: Date.now() }],
	tools: [
		{
			name: "multiply",
			description: "Multiply two integers.",
			parameters: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"] },
		},
	],
};
const first = await models.completeSimple(model, context, { reasoning: "low", maxTokens: 2048 });
const call = first.content.find((c) => c.type === "toolCall");
console.log("turn 1:", first.stopReason, call ? `tool ${call.name}` : "no tool call", first.errorMessage ?? "");
if (!call || call.type !== "toolCall") process.exit(1);
const { a, b } = call.arguments as { a: number; b: number };
context.messages.push(first, {
	role: "toolResult",
	toolCallId: call.id,
	toolName: call.name,
	content: [{ type: "text", text: String(a * b) }],
	isError: false,
	timestamp: Date.now(),
});
const second = await models.completeSimple(model, context, { reasoning: "low", maxTokens: 2048 });
const answer = second.content.filter((c) => c.type === "text").map((c) => c.text).join("");
console.log("turn 2:", second.stopReason, JSON.stringify(answer.slice(0, 200)), second.errorMessage ?? "");
console.log("thinking blocks:", first.content.filter((c) => c.type === "thinking").length, second.content.filter((c) => c.type === "thinking").length);
if (!answer.includes("391")) process.exit(1);
