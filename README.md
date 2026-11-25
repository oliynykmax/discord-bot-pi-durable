# bobik on Pi Durable

bobik is a relaxed, general-purpose Discord buddy for a small group of friends. Someone tags `@bobik` in a channel, bobik opens a thread on that message and answers there. It chats, brainstorms, explains, writes, translates, plans and helps with everyday things, and does code when asked. It can read attached files, and it has a Linux shell and files on its own small VM. For repository work it reads and edits the team repository through GitHub tools, on its own branch, and opens pull requests. It never pushes to the base branch and never merges.

It also keeps a shared memory: notes that last across threads, which everyone in the group sees. It saves people's preferences, plans and decisions when asked or when clearly useful, and searches them before it says it doesn't know something.

It runs entirely on Cloudflare: one Worker, a singleton Discord gateway Durable Object, and one conversation Durable Object per Discord thread, plus a small sandbox Worker for code mode scripts. Each conversation hosts a real [Pi Durable](https://developers.cloudflare.com/agents/harnesses/pi/) harness. The model is Kimi K3.1 Pro on Verda.

## Using it

- Tag `@bobik <request>` in a text channel. bobik reacts 👀, starts a thread on your message and posts its answer there.
- Tag `@bobik` inside an existing thread to make it a bobik thread.
- Reply in a bobik thread, without a mention, to steer the running work. If nothing is running, the reply starts a new run.
- `!queue <text>` runs a message after the current run. `!stop` stops the run and drops queued messages. `!status` shows state, delivery problems, and the branch and PR once there is repo activity. `!help` lists this.
- Attach text or image files and bobik can read them.
- Ask bobik to remember something, or ask what it knows. Memory is shared by everyone here, so never give it secrets.

Only allowlisted users (and optional allowed roles) can use it. Mentions from anyone else get a one-line refusal. Bots and webhooks are ignored. With no allowlist, the gateway refuses to start.

It has a real Linux shell and files on a small Oracle VM (`bobik-shell`, 1 GB of RAM shared by the whole friend group). Each thread works in its own folder, `/home/bobik/threads/<thread id>`, which persists between messages. What it cannot do: browse the web beyond what `curl` in that shell gives, take screenshots, send files back, or switch models. `!model`, `!models` and `model=` get a plain "not supported" reply. The old bot's `say`, `shot` and `pr-image` are gone.

## Design

```
Discord gateway ──► DiscordGateway DO ──accept()──► Conversation DO (name = thread id)
  (one socket)      journal, cursor,                 Lifecycle + PiHarness + Pi Harness.open
                    thread binding                   inputs, outbox, GitHub tools, codemode
                                                          │           │ RPC
                                                          │           └──► bobik-codemode-sandbox Worker: QuickJS
                                         Verda kimi-k3-1-pro · GitHub App · Discord REST
                                                          │ wss / https + bearer token
                                         bobik-shell VM: Caddy ─┬─► /pi-env  shell-host/bridge.ts ─► pi-env daemon
                                                                └─► /mcp     Basic Memory MCP (project bobik)
```

The decision was between this all-Durable-Object shape and a small external gateway bridge. The bridge would reuse a Discord library and cost less Cloudflare duration, but it is a second deployment with its own spool and secrets. This shape keeps one deployment and keeps every recovery path behind `accept()`. Its cost is a gateway object that stays resident while the socket is open, since outbound WebSockets do not hibernate.

How each part stays correct across crashes and retries:

- **Ingress.** A relevant `MESSAGE_CREATE` is written to the gateway journal and the resume cursor in one SQL transaction, before anything else happens. Ignored traffic only checkpoints the cursor, at most once every five minutes. Journal rows are processed in order and retried by the gateway's alarm with backoff. After eight failures a row is marked `blocked` and shows in admin status.
- **Idempotent admission.** The Pi operation id is `discord:<message id>`. The conversation stores the input before handing it to Pi, so a resumed gateway, a replayed event or a retried RPC all land on the same row and the same Pi submission.
- **Threads.** A thread is started on the source message, so its id is the message id. Discord's "already created" error counts as success, and an ambiguous timeout is checked by fetching that channel. bobik never falls back to an unrelated thread.
- **Steer and queue.** A reply is submitted with `whenBusy: "steer", whenIdle: "reject"`. Only `ConversationIdle` turns it into a new run, with the same operation id. `!queue` uses `followUp`, one input per run. Pi settles every input of a run with the same answer entry, and the outbox groups deliveries by that entry id, so a steered run posts one answer. Text is never compared to suppress answers.
- **Restart recovery.** Lifecycle jobs, not `waitUntil`, drive recovery: `admit` resubmits stored inputs that never reached Pi, `settle:<op>` checks each submitted operation until it settles, `stop:<msg>` reapplies an unfinished `!stop`, and `deliver` drains the outbox. PiHarness's own job resumes Pi's work after an eviction.
- **Delivery.** An answer is split into parts of at most 1,900 characters, all written in one transaction before any is sent. Each part has its own record and a deterministic nonce, sent with `enforce_nonce: true` and mentions disabled. 429s wait for `retry_after`. 403 and 404 block the group visibly. An attempt whose outcome is unknown is retried with the same nonce while Discord's nonce window lasts (taken as two minutes). After that, bobik looks for the exact nonce in channel history. Matching text alone is never proof of delivery. If it is absent, bobik sends it with a fresh nonce. If history cannot settle it, the part is marked `uncertain` for an operator rather than posted again. Delivery is at-least-once in that narrow case and is not exactly-once.
- **GitHub.** Tools take paths and content, never a repository, branch, URL or token. The branch is `bobik/<thread id>`, derived in code. Every request passes a policy that allows reads in the configured repository, blob/tree/commit creation, creating or fast-forwarding only that branch with `force: false`, and pull requests from that branch into the base branch. Merges, deletes, other refs, other repositories and `.github/workflows/` writes are refused before any request. Writes record the intended commit before moving the ref; an interrupted write is reconciled against the branch head on the next call and reported to the model. Mutating tools are `replay: "unsafe"`, so Pi reports an interrupted call to the model instead of running it again.
- **Shell.** Pi Durable's `read`, `write`, `edit` and `bash` run through pi-env's `RemoteExecutionEnv` (id `bobik-shell`, cwd `/home/bobik/threads/<thread id>`). The Worker cannot spawn processes, so `wrangler.jsonc` aliases `node:child_process` to `src/shell/child-process.ts`, whose `spawn()` returns a child process backed by a WebSocket. pi-env's own `Connection` (framing, pings, cancellation, reconnects) runs unchanged on top of it. The socket goes to `SHELL_URL` with `Authorization: Bearer $SHELL_TOKEN`; the first frame is `{"args":["serve","--token","<32 hex>"]}`, then binary frames carry the daemon's stdin and stdout, and the bridge sends `{"stderr"}` and `{"exit"}` text frames. Each conversation object keeps one connection and hangs up after 60 s without requests, since an open outbound socket keeps the object resident. The daemon kills its commands when the socket closes, and the bridge then kills every process that still carries the session's `BOBIK_SHELL_SESSION` marker. The tools are not replay-safe, so an interrupted call is reported to the model, not run again. Without `SHELL_URL` or `SHELL_TOKEN`, bobik runs without them.
- **Code mode.** Pi Durable's `codemode` tool runs a model-written JavaScript script that calls bobik's other tools as `await tools.<name>(args)`, so multi-step work takes one model round trip and only the script's output reaches the model. The direct tools stay offered next to it, because a single call needs no script and a broken script costs a round trip. Scripts run in QuickJS inside `bobik-codemode-sandbox`, a separate Worker bound by `script_name`, one sandbox object per thread, because a script that computes would otherwise hold the conversation's thread (pi-codemode README). Each tool call is a nested Pi tool call with its own replay policy, and a script survives a restart by deterministic replay. The sandbox caps a script at 100 interrupt polls, about 10 ms of pure computation: the Workers Free plan allows 10 ms of CPU per invocation and has no `limits.cpu_ms`. `models.*` is off.
- **Memory.** A Rust port of Basic Memory 1.0.0 (basic-memory-rs) runs on the VM as `bobik-memory.service`, pinned to the project `bobik` in `/home/bobik/memory`. It is bobik's own store, separate from any personal Basic Memory. The Worker reaches it at `MEMORY_MCP_URL` over streamable HTTP with `Authorization: Bearer $SHELL_TOKEN`, through `@modelcontextprotocol/client`. Each server tool becomes the Pi tool `mcp__memory__<name>`, except `bm_project`. bobik removes `project`, `projects`, `all_projects` and `workspace` from schemas and arguments and sets `project: "bobik"` itself. Tools whose MCP annotation says `readOnlyHint` are `replay: "safe"`, and writes, edits, moves and deletes are `unsafe`. The tools are `deferred`: they stay out of the prompt until `tool_search` loads them, and codemode scripts can call them any time. pi-ai offers loaded tools to Kimi as a mid-conversation `{ role: "system", tools }` message, which Verda's endpoint honors (checked 2026-11-15). The tools register from `src/memory-tools.ts`, the server's tools/list saved by `scripts/memory-tools.ts`. Pi resolves a task's tools when the task starts, so a list fetched during a call would only reach later calls, and with the saved list a plain chat never connects. The client connects on the first memory call and hangs up after a minute idle. Without `MEMORY_MCP_URL` there are no memory tools and no `tool_search`.
- **Bounds.** 16,000 characters per message, 5 attachments, 20 waiting inputs, 12 tool rounds per run, 512 KiB per commit, 30 files per commit, 60,000 characters per file read, low thinking.

## Operations

Health, for uptime checks: `GET /healthz` returns `{"service":"bobik","status":"ok"}`. It reads nothing, calls no Durable Object and says nothing about Discord or Verda.

Administration needs `Authorization: Bearer <ADMIN_SECRET>`:

| Route | Effect |
| --- | --- |
| `POST /admin/gateway/start` | Persist enabled and connect. Fails without an allowlist. |
| `POST /admin/gateway/stop` | Persist disabled, close the socket, forget the session. |
| `GET /admin/status` | Phase, fatal reason, heartbeat and READY ages, journal counts, bound thread count. No ids or secrets. |

A cron trigger runs every minute. It reconnects the gateway only when it is persisted as enabled and not fatal, and drains due journal rows. The gateway starts disabled after the first deploy. Fatal close codes (bad token, disallowed intents) stop reconnecting until the next start.

### Deploy

Worker `bobik-pi-durable`, on `workers.dev` with no custom routes, and Worker `bobik-codemode-sandbox` with no routes at all. Deploy the sandbox first, since the main Worker binds its class by `script_name`. The health endpoint is `https://bobik-pi-durable.<your-subdomain>.workers.dev/healthz`.

```sh
SUBDOMAIN=your-subdomain     # your workers.dev subdomain
bun install
bun run check                 # typecheck, tests, wrangler deploy --dry-run
bunx wrangler deploy -c codemode-sandbox/wrangler.jsonc   # the code mode sandbox Worker and its SQLite class
bunx wrangler deploy --var GH_APP_ID:... --var GH_INSTALLATION_ID:... --var GH_REPO:owner/name   # creates the Worker and both SQLite Durable Object classes; add --var SHELL_URL:... --var MEMORY_MCP_URL:... for the shell host
scripts/provision.sh          # uploads secrets, see below
curl -s https://bobik-pi-durable.$SUBDOMAIN.workers.dev/healthz
podman ps --filter name=hackbot   # the old bot must stay stopped: two sessions on one token both receive every event
ADMIN=$(cat ~/.local/state/bobik-pi-durable/admin-secret)
curl -s -X POST -H "authorization: Bearer $ADMIN" https://bobik-pi-durable.$SUBDOMAIN.workers.dev/admin/gateway/start
curl -s -H "authorization: Bearer $ADMIN" https://bobik-pi-durable.$SUBDOMAIN.workers.dev/admin/status
```

`scripts/provision.sh` runs `fnox exec` in `~/hackathon-bot` and reads only `DISCORD_TOKEN` and `GH_APP_PRIVATE_KEY` from it. It converts the PKCS#1 App key to PKCS#8 with `openssl pkcs8 -topk8 -nocrypt` in a pipe, reads only `VERDA_API_KEY` from `~/.local/state/j26-verda/app-secrets.json`, and imports `ALLOWED_USER_IDS`, `ALLOWED_ROLE_IDS` and `CHANNEL_IDS` from `~/hackathon-bot/bot.env`. It creates an admin secret in `~/.local/state/bobik-pi-durable/admin-secret` (mode 600) unless one exists. Everything goes to `wrangler secret bulk` on stdin, so no value reaches argv, logs or this repository. Only these names are written: `DISCORD_TOKEN`, `GH_APP_PRIVATE_KEY_PKCS8`, `VERDA_API_KEY`, `ADMIN_SECRET`, `ALLOWED_USER_IDS`, and `ALLOWED_ROLE_IDS` and `CHANNEL_IDS` when set.

`wrangler.jsonc` holds the generic settings `GH_BASE_BRANCH` and `VERDA_BASE_URL`. Pass your own `GH_APP_ID`, `GH_INSTALLATION_ID`, `GH_REPO`, and optionally `SHELL_URL` and `MEMORY_MCP_URL`, at deploy time with `--var NAME:VALUE`, or with `DEPLOY_VARS` in GitHub Actions. Every setting is in `.env.example`. Memory reuses the `SHELL_TOKEN` secret. To deploy from GitHub Actions on every push to `main`, configure the `production` environment as described at the top of `.github/workflows/deploy.yml`.

### Shell host

`shell-host/` holds the VM side: `bridge.ts` (Bun, on 127.0.0.1:8788, `GET /healthz` and `/pi-env`), `Caddyfile` (TLS for `138-2-191-62.sslip.io`), `bobik-bridge.service` (user `bobik`, `MemoryMax=600M`, `TasksMax=256`), `bobik-memory.service` and `bobik-keepalive.service`, an idle-priority CPU load capped by `CPUQuota` that keeps Oracle's Always Free idle reclaim from firing. `install.sh` is idempotent. It needs `/etc/bobik/shell.env` (root, mode 600) with `SHELL_TOKEN=...`, which it never writes, and stores only the token's SHA-256 for the bridge, in `/etc/bobik/bridge.env`. A shell that reads the bridge's environment therefore learns nothing it can reuse.

`bobik-memory.service` runs `bm-rs mcp --transport streamable-http --host 127.0.0.1 --port 8800 --project bobik` as `bobik`. `bm-rs` is the semantic build of basic-memory-rs, a Rust port of Basic Memory 1.0.0 with the same tools, schemas and note format, built on Ubuntu 24.04 and installed for that user beforehand (project `bobik` at `/home/bobik/memory`). It replaced the Python server on 2026-11-16: about 190 MB with the embedding model loaded, against about 390 MB. It builds its own index from the notes, so Python's `memory.db` is unused, and the two must not run on the same notes at once. On first start it downloads the embedding model to `/home/bobik/.cache/basic-memory/fastembed`. The unit keeps `MemoryHigh=400M` and `MemoryMax=450M` as headroom. Caddy forwards `/mcp` only when `Authorization` equals `Bearer {env.SHELL_TOKEN}` and answers 401 otherwise. The drop-in `caddy-bobik.conf` gives Caddy that variable from `/etc/bobik/shell.env` and drops the packaged `--environ` flag, which would print it to the journal. `{env.*}` is read per request, and the Caddyfile turns the admin API off, so the shell on the box cannot rewrite routes. `install.sh` restarts Caddy, then checks that `/mcp` answers 401 without a token.

```sh
cp node_modules/@earendil-works/pi-env/bin/pi-env-linux-x64/pi-env shell-host/pi-env
scp -r shell-host bobik-shell:/tmp/shell-host
ssh bobik-shell sudo /tmp/shell-host/install.sh     # after creating /etc/bobik/shell.env there
printf '%s' "$SHELL_TOKEN" | bunx wrangler secret put SHELL_TOKEN
```

### Checks against real services

- `scripts/verda-smoke.ts` runs a two-turn tool call against Verda through this repo's provider adapter (`VERDA_API_KEY` in the environment).
- `scripts/github-check.ts` mints a scoped installation token and reads the repository (`GH_APP_PRIVATE_KEY_PKCS8` in the environment).
- `scripts/memory-check.ts` (`SHELL_TOKEN` in the environment, run with `node`) runs bobik's real memory tools against the live server: 401 without or with a wrong token, the saved tools/list against the live one, then a note written, found by keyword and by meaning, read and deleted. After upgrading Basic Memory, run `scripts/memory-tools.ts` to save the new list.
- `bun run test:node` runs `shell-host/bridge.ts` with the real pi-env daemon on this machine (Linux x86_64 with Bun) and drives it through the Worker's transport: commands, exit codes, a file round trip, the per-thread folder, hang-up and reconnect, and that background jobs die with the session.

## Tests

`bun run test` runs Vitest inside workerd through `@cloudflare/vitest-plugin`, with the real `PiHarness`, `Lifecycle`, Pi Durable and pi-ai OpenAI-completions adapter. A scripted fake stands in for Verda's streaming API, Discord REST and GitHub at the fetch boundary. The suites cover duplicate and concurrent admission, steering versus follow-up, `!stop`, crash before Pi submission, crash mid-run, a cut-off Discord send, 429, nonce-window reconciliation, blocked delivery, the gateway protocol (identify, resume, heartbeat, missed ACK, op 7, op 9, fatal and fresh-session close codes), journal-before-cursor, replay deduplication, authorization, the GitHub policy and branch writes, attachments, the HTTP surface, `bash` over the shell socket against a scripted daemon, code mode scripts in the real sandbox Worker (loaded as an auxiliary Worker from `bun run build:sandbox`), and the memory tools against a fake MCP server.

## Known limits

- The gateway object stays resident while connected. At 128 MB for a full day that is roughly 11,000 GB-s of the free plan's 13,000 GB-s daily duration, before any conversation runs (an estimate, not a measured bill).
- If the gateway object is evicted, cron reconnects within a minute and resumes. After a non-resumable session loss, messages sent during the gap are not recovered.
- Pi Durable is experimental. Packages are pinned exactly (`agents` 0.33.0, Pi 1.5.2). Roll forward rather than back to Pi 1.4.
- Settlement grouping and admission recovery read Pi's submission record through `PiHarness.storage()`, which agents 0.33.0 marks internal. The tests cover it and will fail if an upgrade changes it.
- The shell is shared and small: one 1 GB VM for everyone, 600 MB for all shell processes together, and no isolation between thread folders beyond convention. Anything left running in the background stops when the connection goes idle.
- bobik cannot verify its GitHub changes: the repository tools do not reach the shell. Its answers say what a human should check.
- A code mode script gets about 10 ms of pure computation on the Free plan; glue code between tool calls fits, heavy computation belongs in `bash`. Whether the sandbox's own start-up fits the 10 ms CPU limit in production is not yet measured.
- Memory is one shared store for the whole group, with no per-person privacy. The shell runs as the same `bobik` user, so shell commands can read and change `/home/bobik/memory` directly.
- The memory server and the shell share 1 GB of RAM. Measured after use: about 383 MB RSS for the memory server, about 360 MB of RAM left available on the box.

## License

MIT.
