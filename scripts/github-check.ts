import { InstallationTokens } from "../src/github/client.ts";

const pem = process.env.GH_APP_PRIVATE_KEY_PKCS8;
if (!pem) throw new Error("GH_APP_PRIVATE_KEY_PKCS8 is not set");
const [owner, name] = (process.env.GH_REPO ?? "oliynykmax/junction-2026").split("/");
const tokens = new InstallationTokens("https://api.github.com", {
	appId: process.env.GH_APP_ID ?? "5745150",
	installationId: process.env.GH_INSTALLATION_ID ?? "181608443",
	privateKeyPkcs8: pem,
	repository: name!,
});
const token = await tokens.get();
const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "bobik-pi-durable" };
const repo = await fetch(`https://api.github.com/repos/${owner}/${name}`, { headers });
const body = (await repo.json()) as { default_branch?: string; permissions?: Record<string, boolean>; private?: boolean };
console.log("installation token minted for", `${owner}/${name}`);
console.log("repo read:", repo.status, "default branch:", body.default_branch, "private:", body.private);
const main = await fetch(`https://api.github.com/repos/${owner}/${name}/git/ref/heads/${body.default_branch}`, { headers });
console.log("base ref read:", main.status);
