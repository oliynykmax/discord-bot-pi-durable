import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { envApiKeyAuth } from "@earendil-works/pi-ai";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { MOONSHOTAI_MODELS } from "@earendil-works/pi-ai/providers/moonshotai.models";
import type { Env } from "./env.ts";

export const VERDA_PROVIDER = "verda";
export const KIMI_ID = "kimi-k3-1-pro";
export const KIMI_REF = { provider: VERDA_PROVIDER, id: KIMI_ID } as const;

export function kimiModel(baseUrl: string) {
	const catalog = MOONSHOTAI_MODELS["kimi-k3.1-pro"];
	return {
		...catalog,
		provider: VERDA_PROVIDER,
		id: KIMI_ID,
		name: "Kimi K3.1 Pro (Verda)",
		baseUrl,
		maxTokens: 131_072,
	};
}

export function verdaModels(env: Env): MutableModels {
	const models = createModels({
		authContext: {
			env: async (name) => (name === "VERDA_API_KEY" ? env.VERDA_API_KEY : undefined),
			fileExists: async () => false,
		},
		identity: { attribution: null },
	});
	models.setProvider(
		createProvider({
			id: VERDA_PROVIDER,
			name: "Verda",
			baseUrl: env.VERDA_BASE_URL,
			auth: { apiKey: envApiKeyAuth("Verda API key", ["VERDA_API_KEY"]) },
			models: [kimiModel(env.VERDA_BASE_URL)],
			api: openAICompletionsApi(),
		}),
	);
	return models;
}
