import { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";

/**
 * Runs bobik's code mode scripts in their own Worker, so a script that computes never holds a conversation's thread.
 * On the Workers Free plan every invocation gets 10 ms of CPU and `limits.cpu_ms` is not available. One poll is about
 * 0.1 ms on Cloudflare (pi-codemode README), so 100 polls end a computing script as a timeout before the platform
 * resets the object.
 */
export class CodemodeSandbox extends CodemodeSandboxDurableObject {
	protected override maxInterruptBudget = 100;
}

export default {
	fetch: () => new Response("Not found", { status: 404 }),
};
