import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const SANDBOX_DIST = "codemode-sandbox/dist";

function sandboxModules() {
	const files = readdirSync(SANDBOX_DIST);
	const wasm = files.filter((file) => file.endsWith(".wasm")).map((file) => ({ type: "CompiledWasm" as const, path: `${SANDBOX_DIST}/${file}` }));
	return [{ type: "ESModule" as const, path: `${SANDBOX_DIST}/index.js` }, ...wasm];
}

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
				// The sandbox Worker as `bun run build:sandbox` bundles it, bound by `script_name` as in production.
				workers: [
					{
						name: "bobik-codemode-sandbox",
						modules: sandboxModules(),
						compatibilityDate: "2026-11-01",
						durableObjects: { CodemodeSandbox: { className: "CodemodeSandbox", useSQLite: true } },
					},
				],
			},
		}),
	],
	test: { testTimeout: 30_000, exclude: ["test/node/**", "node_modules/**"] },
});
