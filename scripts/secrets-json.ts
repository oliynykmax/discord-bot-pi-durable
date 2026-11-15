// Builds the Worker's secret bundle as JSON on stdout for `wrangler secret bulk`. Values never reach argv or logs;
// stderr gets names and counts only. Run under `fnox exec` in the old bot directory, see scripts/provision.sh.
import { readFileSync } from "node:fs";

const fail = (message: string): never => {
	console.error(`provision: ${message}`);
	process.exit(1);
};
const required = (name: string) => process.env[name] || fail(`${name} is not set`);

async function pkcs8(pkcs1: string): Promise<string> {
	const child = Bun.spawn(["openssl", "pkcs8", "-topk8", "-nocrypt"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
	child.stdin.write(pkcs1.endsWith("\n") ? pkcs1 : `${pkcs1}\n`);
	await child.stdin.end();
	const out = await new Response(child.stdout).text();
	if ((await child.exited) !== 0 || !out.includes("BEGIN PRIVATE KEY")) fail("openssl could not convert GH_APP_PRIVATE_KEY to PKCS#8");
	return out.trim();
}

function botEnv(path: string): Map<string, string> {
	const values = new Map<string, string>();
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const match = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
		if (match) values.set(match[1]!, match[2]!.replace(/^(['"])(.*)\1$/, "$2"));
	}
	return values;
}

const ids = (raw: string | undefined) =>
	(raw ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => /^\d{15,21}$/.test(s));

const config = botEnv(required("BOT_ENV"));
const users = ids(config.get("ALLOWED_USER_IDS"));
const roles = ids(config.get("ALLOWED_ROLE_IDS"));
const channels = ids(config.get("CHANNEL_IDS"));
if (users.length === 0 && roles.length === 0) fail("bot.env has no ALLOWED_USER_IDS or ALLOWED_ROLE_IDS; refusing to deploy an open bot");

const verda = JSON.parse(readFileSync(required("VERDA_FILE"), "utf8")) as { VERDA_API_KEY?: string };
const admin = readFileSync(required("ADMIN_FILE"), "utf8").trim();
if (admin.length < 32) fail("admin secret is shorter than 32 characters");

const bundle: Record<string, string> = {
	DISCORD_TOKEN: required("DISCORD_TOKEN"),
	GH_APP_PRIVATE_KEY_PKCS8: await pkcs8(required("GH_APP_PRIVATE_KEY")),
	VERDA_API_KEY: verda.VERDA_API_KEY || fail("VERDA_API_KEY missing from the Verda secrets file"),
	ADMIN_SECRET: admin,
	ALLOWED_USER_IDS: users.join(","),
	...(roles.length ? { ALLOWED_ROLE_IDS: roles.join(",") } : {}),
	...(channels.length ? { CHANNEL_IDS: channels.join(",") } : {}),
};
console.error(`provision: secrets ${Object.keys(bundle).join(", ")}; ${users.length} allowed users, ${roles.length} allowed roles, ${channels.length} channels`);
process.stdout.write(JSON.stringify(bundle));
