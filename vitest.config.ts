import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					DISCORD_TOKEN: "test-discord-token",
					VERDA_API_KEY: "test-verda-key",
					ADMIN_SECRET: "test-admin-secret",
					ALLOWED_USER_IDS: "100000000000000001,100000000000000002",
					GH_APP_PRIVATE_KEY_PKCS8: "",
					DISCORD_API_BASE: "https://discord.test/api/v10",
					GITHUB_API_BASE: "https://github.test",
					VERDA_BASE_URL: "https://verda.test/v1",
				},
			},
		}),
	],
	test: { testTimeout: 30_000 },
});
