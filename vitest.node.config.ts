import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: { alias: [{ find: /^node:child_process$/, replacement: fileURLToPath(new URL("./src/shell/child-process.ts", import.meta.url).href) }] },
	test: { include: ["test/node/**/*.test.ts"], server: { deps: { inline: [/@earendil-works\/pi-env/] } }, testTimeout: 30_000 },
});
