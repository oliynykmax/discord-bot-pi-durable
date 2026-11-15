import { describe, expect, test } from "vitest";
import { allowRequest, repoPath, type Scope } from "../src/github/policy.ts";

const scope: Scope = { owner: "team", name: "repo", base: "main", branch: "bobik/600000000000000001" };
const R = "/repos/team/repo";
const allowed = (method: string, path: string, body?: unknown) => allowRequest(method, path, body, scope).ok;

describe("GitHub request policy", () => {
	test("reads and the bot branch's write shapes are allowed", () => {
		expect(allowed("GET", `${R}/contents/src/a.ts?ref=main`)).toBe(true);
		expect(allowed("POST", `${R}/git/trees`, { tree: [] })).toBe(true);
		expect(allowed("POST", `${R}/git/commits`, {})).toBe(true);
		expect(allowed("POST", `${R}/git/refs`, { ref: `refs/heads/${scope.branch}`, sha: "x" })).toBe(true);
		expect(allowed("PATCH", `${R}/git/refs/heads/${scope.branch}`, { sha: "x", force: false })).toBe(true);
		expect(allowed("POST", `${R}/pulls`, { head: scope.branch, base: "main" })).toBe(true);
	});

	test.each<[string, string, unknown]>([
		["PATCH", `${R}/git/refs/heads/main`, { sha: "x" }],
		["PATCH", `${R}/git/refs/heads/bobik/600000000000000002`, { sha: "x" }],
		["PATCH", `${R}/git/refs/heads/${scope.branch}`, { sha: "x", force: true }],
		["POST", `${R}/git/refs`, { ref: "refs/heads/main", sha: "x" }],
		["POST", `${R}/git/refs`, { ref: "refs/tags/v1", sha: "x" }],
		["POST", `${R}/pulls`, { head: "main", base: "main" }],
		["POST", `${R}/pulls`, { head: scope.branch, base: "release" }],
		["PUT", `${R}/pulls/1/merge`, {}],
		["DELETE", `${R}/git/refs/heads/${scope.branch}`, undefined],
		["POST", `${R}/merges`, {}],
		["PATCH", `${R}/git/refs/heads/%6Dain`, { sha: "x" }],
		["GET", "/repos/other/repo/contents/a", undefined],
		["GET", `${R}/contents/%2e%2e/secret`, undefined],
		["POST", `${R}/git/trees?x=1`, {}],
	])("%s %s is refused", (method, path, body) => expect(allowed(method, path, body)).toBe(false));

	test("a non-bot branch scope refuses everything", () => {
		expect(allowRequest("GET", `${R}/contents/a`, undefined, { ...scope, branch: "main" }).ok).toBe(false);
	});

	test("repository paths are normalized and workflow writes are refused", () => {
		expect(repoPath("./src/a.ts", "write")).toEqual({ ok: true, path: "src/a.ts" });
		for (const bad of ["/etc/passwd", "a/../b", "a//b", "a\\b", "", ".github/workflows/ci.yml", ".git/config"]) {
			expect(repoPath(bad, "write").ok).toBe(false);
		}
		expect(repoPath(".github/workflows/ci.yml", "read").ok).toBe(true);
	});
});
