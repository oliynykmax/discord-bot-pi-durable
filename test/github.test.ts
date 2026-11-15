import { afterEach, describe, expect, test, vi } from "vitest";
import { appJwt, GitHubClient } from "../src/github/client.ts";
import { BranchRepo, type OpenEffect, type PullRef, type RepoState } from "../src/github/tools.ts";
import { FakeNet } from "./net.ts";

const API = "https://github.test";
const BRANCH = "bobik/600000000000000001";
const scope = { owner: "team", name: "repo", base: "main", branch: BRANCH };

function fakeGitHub(net: FakeNet) {
	const refs = new Map<string, string>([["main", "c0"]]);
	const commits = new Map<string, { tree: string; parents: string[] }>([["c0", { tree: "t0", parents: [] }]]);
	const pulls: { number: number; head: string }[] = [];
	let n = 0;
	net.on((call) => {
		const url = new URL(call.url);
		if (url.hostname !== "github.test") return undefined;
		const path = url.pathname.replace("/repos/team/repo", "");
		const ref = /^\/git\/ref\/heads\/(.+)$/.exec(path);
		if (call.method === "GET" && ref) {
			const sha = refs.get(decodeURIComponent(ref[1]!));
			return sha ? Response.json({ object: { sha } }) : Response.json({ message: "Not Found" }, { status: 404 });
		}
		const commit = /^\/git\/commits\/(\w+)$/.exec(path);
		if (call.method === "GET" && commit) return Response.json({ sha: commit[1], tree: { sha: commits.get(commit[1]!)!.tree } });
		if (call.method === "POST" && path === "/git/trees") {
			const same = call.body.tree.every((e: any) => e.content === "same");
			return Response.json({ sha: same ? call.body.base_tree : `t${++n}` });
		}
		if (call.method === "POST" && path === "/git/commits") {
			const sha = `c${++n}`;
			commits.set(sha, { tree: call.body.tree, parents: call.body.parents });
			return Response.json({ sha, tree: { sha: call.body.tree } });
		}
		if (call.method === "POST" && path === "/git/refs") {
			const name = call.body.ref.replace("refs/heads/", "");
			if (refs.has(name)) return Response.json({ message: "Reference already exists" }, { status: 422 });
			refs.set(name, call.body.sha);
			return Response.json({ object: { sha: call.body.sha } });
		}
		const patch = /^\/git\/refs\/heads\/(.+)$/.exec(path);
		if (call.method === "PATCH" && patch) {
			const name = patch[1]!;
			const parent = commits.get(call.body.sha)?.parents[0];
			if (parent !== refs.get(name)) return Response.json({ message: "Update is not a fast forward" }, { status: 422 });
			refs.set(name, call.body.sha);
			return Response.json({ object: { sha: call.body.sha } });
		}
		if (call.method === "GET" && path === "/pulls") {
			const head = url.searchParams.get("head");
			return Response.json(pulls.filter((p) => `team:${p.head}` === head).map((p) => ({ number: p.number, html_url: `https://github.com/team/repo/pull/${p.number}` })));
		}
		if (call.method === "POST" && path === "/pulls") {
			const pull = { number: pulls.length + 1, head: call.body.head };
			pulls.push(pull);
			return Response.json({ number: pull.number, html_url: `https://github.com/team/repo/pull/${pull.number}` });
		}
		return Response.json({ message: "unexpected" }, { status: 500 });
	});
	return { refs, commits, pulls };
}

function memoryState(): RepoState & { effects: Map<string, OpenEffect & { state: string }>; head?: string } {
	const effects = new Map<string, OpenEffect & { state: string }>();
	let pr: PullRef | undefined;
	const state = {
		effects,
		head: undefined as string | undefined,
		pr: () => pr,
		setPr: (value: PullRef) => (pr = value),
		setHead: (sha: string) => (state.head = sha),
		beginEffect: (callId: string, parent: string, intended: string) => effects.set(callId, { callId, parent, intended, state: "started" }),
		finishEffect: (callId: string, value: string) => (effects.get(callId)!.state = value),
		openEffects: () => [...effects.values()].filter((e) => e.state === "started"),
	};
	return state;
}

const repo = (state: RepoState) => new BranchRepo(new GitHubClient(API, scope, { get: async () => "installation-token" }), state);
const mutations = (net: FakeNet) => net.calls.filter((c) => c.method !== "GET" && c.url.includes("github.test"));

afterEach(() => vi.restoreAllMocks());

describe("bot branch writes", () => {
	test("the first write creates the bot branch from main; later writes fast-forward it without force", async () => {
		const net = new FakeNet().install();
		const gh = fakeGitHub(net);
		const state = memoryState();
		const out = await repo(state).write("call-1", "Add readme", [{ path: "README.md", content: "hi" }], undefined);
		expect(out).toContain(`Created ${BRANCH} from main`);
		expect(gh.refs.get("main")).toBe("c0");
		const second = await repo(state).write("call-2", "Edit", [{ path: "README.md", content: "hello" }], gh.refs.get(BRANCH));
		expect(second).toContain("Committed 1 file change(s)");
		const patch = net.calls.find((c) => c.method === "PATCH")!;
		expect(patch.url).toContain(`/git/refs/heads/${BRANCH}`);
		expect(patch.body.force).toBe(false);
		expect(gh.refs.get("main")).toBe("c0");
		expect(state.head).toBe(gh.refs.get(BRANCH));
	});

	test("a stale expected head is a conflict and pushes nothing", async () => {
		const net = new FakeNet().install();
		fakeGitHub(net);
		const out = await repo(memoryState()).write("call-1", "x", [{ path: "a.ts", content: "1" }], "f".repeat(40));
		expect(out).toContain("Conflict");
		expect(mutations(net)).toHaveLength(0);
	});

	test("refused paths fail before any request", async () => {
		const net = new FakeNet().install();
		fakeGitHub(net);
		for (const path of [".github/workflows/ci.yml", "../x", "/abs", ".git/config"]) {
			await expect(repo(memoryState()).write("c", "x", [{ path, content: "1" }], undefined)).rejects.toThrow();
		}
		expect(net.calls.filter((c) => c.url.includes("github.test"))).toHaveLength(0);
	});

	test("an unchanged tree is reported, not committed", async () => {
		const net = new FakeNet().install();
		fakeGitHub(net);
		const out = await repo(memoryState()).write("c", "x", [{ path: "a.ts", content: "same" }], undefined);
		expect(out).toContain("No changes");
		expect(net.calls.some((c) => c.url.endsWith("/git/commits") && c.method === "POST")).toBe(false);
	});

	test("an interrupted write is reconciled against the branch on the next call", async () => {
		const net = new FakeNet().install();
		const gh = fakeGitHub(net);
		const state = memoryState();
		await repo(state).write("call-1", "first", [{ path: "a.ts", content: "1" }], undefined);
		const applied = gh.refs.get(BRANCH)!;
		state.effects.set("lost-call", { callId: "lost-call", parent: "c0", intended: applied, state: "started" });
		state.effects.set("never-pushed", { callId: "never-pushed", parent: applied, intended: "c999", state: "started" });
		const out = await repo(state).write("call-2", "second", [{ path: "b.ts", content: "2" }], undefined);
		expect(out).toContain("earlier interrupted write was applied");
		expect(out).toContain("(commit c999) was not applied");
		expect(state.effects.get("lost-call")!.state).toBe("applied");
		expect(state.effects.get("never-pushed")!.state).toBe("not_applied");
	});

	test("opening a pull request twice returns the open one", async () => {
		const net = new FakeNet().install();
		const gh = fakeGitHub(net);
		const state = memoryState();
		expect(await repo(state).openPr("t", "b", false, "footer")).toContain("no commits yet");
		await repo(state).write("c", "x", [{ path: "a.ts", content: "1" }], undefined);
		expect(await repo(state).openPr("t", "b", false, "footer")).toContain("Opened pull request #1");
		expect(await repo(state).openPr("t", "b", false, "footer")).toContain("already open");
		expect(gh.pulls).toHaveLength(1);
		expect(net.calls.find((c) => c.method === "POST" && c.url.endsWith("/pulls"))!.body).toMatchObject({ head: BRANCH, base: "main" });
		expect(state.pr()).toEqual({ number: 1, url: "https://github.com/team/repo/pull/1" });
	});

	test("app JWTs are RS256 over a PKCS#8 key, valid under ten minutes", async () => {
		const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
		const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
		const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
		const jwt = await appJwt("5745150", pem, 1_000_000_000_000);
		const [header, payload, signature] = jwt.split(".");
		const decode = (s: string) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
		expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT" });
		const claims = decode(payload!);
		expect(claims.iss).toBe("5745150");
		expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
		const bytes = Uint8Array.from(atob(signature!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
		expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pair.publicKey, bytes, new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
	});
});
