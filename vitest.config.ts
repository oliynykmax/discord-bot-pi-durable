import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	// Mirrors the `alias` in wrangler.jsonc, which the Workers pool does not read.
	resolve: { alias: [{ find: /^node:child_process$/, replacement: fileURLToPath(new URL("./src/shell/child-process.ts", import.meta.url).href) }] },
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
					SHELL_URL: "wss://shell.test/pi-env",
					SHELL_TOKEN: "test-shell-token",
				},
			},
		}),
	],
	test: { testTimeout: 30_000, exclude: ["test/node/**", "node_modules/**"] },
});
