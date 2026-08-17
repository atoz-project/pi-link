# pi-link

A WebSocket-based inter-terminal communication system that creates a local network between multiple Pi coding agent terminals. Enables terminals to discover each other, exchange messages, and orchestrate work across agents - all automatically on `localhost`.

> Three patterns out of the box: ask another agent for an answer (`link_prompt`), delegate async work (`link_send` with `triggerTurn:true`), or broadcast to every other terminal (`/link-broadcast`). Start two Pi terminals with `--link` — they find each other automatically.

---

## Table of Contents

- [Why?](#why)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Walkthrough](#walkthrough)
- [Configuration](#configuration)
- [LLM Tools](#llm-tools)
- [Slash Commands](#slash-commands)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)
- [Limitations & Design Decisions](#limitations--design-decisions)
- [Dependencies](#dependencies)
- [Internals](#internals)

---

## Why?

A single Pi terminal is powerful. Multiple terminals working together unlock new patterns:

- **Research + Build** - one terminal investigates APIs, docs, or logs while another writes code based on the findings.
- **Fan-out** - split a large task across agents (e.g., "terminal A handles the backend, terminal B handles the frontend") and collect results.
- **Orchestrator / Worker** - designate one terminal as a coordinator that delegates subtasks to others via `link_prompt` and assembles the final output.
- **Review pipeline** - one terminal writes code, another reviews it, back and forth until both are satisfied.

---

## Prerequisites

- [Pi coding agent](https://github.com/badlogic/pi-mono), version **0.74 or later** (for pi-link 0.1.15+). On Pi ≤0.73, pin `pi-link@0.1.14`.
- Node.js (LTS recommended)

---

## Quick Start

### Install

The minimum install — enables every in-Pi feature (`/link`, `link_send`, `link_prompt`, `/link-connect`, `--link` flag, auto-resume, all LLM tools):

```bash
pi install npm:pi-link
```

That's it. For most users this is all you need.

#### Optional: query CLI

If you also want the `pi-link` shell command to discover sessions from a terminal prompt (`pi-link --list`, `pi-link --resolve <name>` — the resurrection lookup), install the CLI globally as well:

```bash
npm i -g pi-link
```

Or install both in one line:

```bash
pi install npm:pi-link && npm i -g pi-link
```

The CLI is query-only (ADR-0007): it lists and resolves sessions but never launches Pi. Launching is explicit — see [Explicit launch & resurrection](#explicit-launch--resurrection).

### Uninstall

```bash
pi uninstall npm:pi-link      # Remove Pi extension
npm uninstall -g pi-link      # Remove query CLI (if you installed it)
```

### Usage

Link is **off by default**. Two ways to start:

```bash
pi --link                  # try it now, random name like t-a3f9
pi --link --link-name mybot  # fresh start with a stable link name
```

Already in a session? Use `/link-connect`. Use `/link` any time to check status, or let the LLM tools handle cross-terminal coordination. See [Explicit launch & resurrection](#explicit-launch--resurrection) for resurrecting a terminal.

### Notes on installation

**Why two installs?** Pi 0.75 installs Pi packages into a private npm root (`~/.pi/agent/npm/`) for safer permission handling ([pi-mono#4587](https://github.com/earendil-works/pi-mono/issues/4587)). That's where the Pi extension lives, but it means the `pi-link` query CLI is no longer on system PATH. `npm i -g pi-link` puts it on PATH separately. Both installs are safe to use together.

---

## Walkthrough

Here's a concrete example of two terminals collaborating. Open two separate `pi --link` sessions.

**Terminal 1** - rename and check status:

```
> /link-name builder
✓ Renamed to "builder"

> /link
⚡ Link: builder (hub) · 2 online
  builder: idle (5s) · 45K/272K (17%)
    cwd: ~/my-project
  researcher: idle (12s) · 80K/272K (29%)
    cwd: ~/my-project
```

**Terminal 2** - rename it too:

```
> /link-name researcher
✓ Reconnecting, requesting "researcher" (hub may assign a different name if taken)...
```

**Now ask Terminal 1's LLM to delegate work:**

In Terminal 1, type a normal prompt:

```
> Use link_prompt to ask "researcher" to summarize the contents of README.md in this directory
```

The LLM in Terminal 1 calls `link_prompt` → Terminal 2's LLM receives the prompt, reads the file, and sends back a summary → Terminal 1's LLM presents the result to you.

**Or broadcast a message to all terminals:**

```
> /link-broadcast starting the deployment pipeline
✓ Broadcast sent
```

Every other terminal sees:

```
⚡ [builder] starting the deployment pipeline
```

---

## Configuration

Link is **off by default**. Without `--link` or `--link-name`, the extension is completely silent — no status bar, no connections, no warnings.

**Naming concepts**

- **link name** — identity used on the network (visible in `link_list`, `/link`, prompts).
- **Pi session name** — identity Pi gives the session itself; lives in the session JSONL's latest `session_info` entry.
- **saved link name** — the link name persisted to the session, restored on resume. Set by `/link-name` or `pi --link-name <name>`.
- **`--link-name` flag vs `/link-name` command** — same concept (the link name) at different times (startup vs mid-session).

| What you want                        | Use                                              |
| ------------------------------------ | ------------------------------------------------ |
| Fresh named terminal                 | `pi --link --link-name <name>`                   |
| Resurrect a terminal by name         | `pi-link --resolve <name> -g` → `pi --link --session <path>` |
| Quick try, random name               | `pi --link`                                      |
| Already in a session                 | `/link-connect`                                  |
| Disconnect mid-session               | `/link-disconnect`                               |

`pi --link-name <name>` sets only the link identity, leaving Pi's normal session selection (latest in cwd, or fresh) untouched.

**Name normalization:** Link names are normalized — leading/trailing whitespace removed and internal whitespace runs collapsed to a single space. `/link-name "build   lead"` saves and shows as `build lead`.

**Name precedence:** `pi --link-name` > saved `/link-name` > Pi session name > random `t-xxxx`.

`/link-connect` and `/link-disconnect` save their intent to the session — resume later and the connection state is restored without needing the flag. Explicit user intent takes precedence over `--link`.

Once connected, terminals discover each other on `127.0.0.1:9900`. See [Limitations](#limitations--design-decisions) for the hardcoded port.

### Explicit launch & resurrection

The launcher execution mode is retired (ADR-0007 §8): `pi-link <name>` no longer resolves, resumes, or spawns anything — it exits non-zero with the recipes below. Implicit resume dropped a live agent into whatever context that session last held, and a typo'd name silently created a blank same-named terminal.

**Fresh start** (link identity only; Pi's normal session selection untouched):

```bash
pi --link --link-name worker-1
```

**Resurrect** an existing terminal — explicit two-step: look up the session, then resume it by path:

```bash
pi-link --resolve worker-1 -g   # prints the session file path
pi --link --session <printed path>
```

Session-dir resolution matches Pi's lookup order: `PI_CODING_AGENT_SESSION_DIR` env > `<cwd>/.pi/settings.json` `sessionDir` > `<agentDir>/settings.json` `sessionDir` > default `<agentDir>/sessions/`. `<agentDir>` follows `PI_CODING_AGENT_DIR` and defaults to `~/.pi/agent/`.

### Discovering sessions

`pi-link --list` shows pi-link sessions in the current cwd; `pi-link --list --global` (or `-g`) lists them across all directories. Sorted by last activity — starting a session with the same name it already has does not bump recency; only real activity (messages, tool calls, edits, name changes) does.

```
$ pi-link --list
NAME             MODIFIED  MESSAGES  ID
opus@pi-link     2m ago    4632      6332faab
gpt@pi-link      5m ago    1493      20d43841

Resurrect: pi --link --session <path>  (path via pi-link --resolve <name> -g)
```

With `--global`:

```
$ pi-link --list --global
NAME             CWD                   MODIFIED  MESSAGES  ID
opus@pi-link     ~/my-project          2m ago    4632      6332faab
gpt@pi-link      ~/other-project       5m ago    1493      20d43841

Resurrect: pi --link --session <path>  (path via pi-link --resolve <name> -g)
```

`--global` adds a `CWD` column with `~` substituted for `$HOME`. Output is plain when piped (`NO_COLOR` honored).

`pi-link --resolve <name>` follows the same scoping: local cwd by default, `--global` (or `-g`) widens. When it finds no local match but matches exist elsewhere, it points at `--global` instead of silently jumping cwds.

For scripting, `pi-link --resolve <name>` prints just the session path (machine-readable, no other output). Exit codes: `0` on single match, `1` if ambiguous (multiple matches printed to stderr), `2` if not found.

### Public-reachable hub (ADR-0002)

By default the hub binds `127.0.0.1:9900` (loopback, unauthenticated). To span machines where SSH/Tailscale tunnels are impractical, pi-link can bind a non-loopback address and authenticate clients with a shared token. **Link membership is RCE-equivalent** (`link_prompt`/`link_send triggerTurn:true` run a full agent turn with tools), so non-loopback binds require authn and transport encryption.

**Config env** (non-secret endpoint config):

| Env | Role | Default |
| --- | --- | --- |
| `PI_LINK_HOST` | hub bind host | `127.0.0.1` |
| `PI_LINK_PORT` | hub bind port + default loopback dial port (test/fleet isolation) | `9900` |
| `PI_LINK_PROFILE` | explicit profile selection (a profile *name*, never a URL) | unset |
| `PI_LINK_PROFILES_FILE` | profiles file *path* (test isolation) | `~/.pi/agent/pi-link.json` |

**Profiles file** `~/.pi/agent/pi-link.json` (mode `0600`) — the **only** token source (env vars are visible in `ps`; user ruling). Shape:

```json
{
  "profiles": {
    "fleet": { "url": "wss://hub.example:9900", "token": "<shared-secret>" }
  },
  "default": "fleet"
}
```

**The profile is the dial target (ADR-0007).** A profile is a complete fleet membership declaration: *where to dial* (`url`; omitted = `ws://127.0.0.1:$PI_LINK_PORT`) and *what ticket to carry* (`token`). One resolved profile answers both. Selection: `--link-profile` flag > `PI_LINK_PROFILE` > `default` > none. Flag and env select a profile *name*; they never carry a URL (`PI_LINK_URL` is retired — ambient naked-URL dialing is how fleets silently split). The flag tier exists because `PI_LINK_PROFILE` inherits through tmux spawn chains and can silently redirect a terminal to a valid but unintended profile — explicit launch commands should say the name out loud. `none` (no profiles file / no `default`) is loopback, unauthenticated — byte-identical zero-config behavior, opt-in, upstream-friendly.

**Unknown profile fails closed.** A selected name that does not resolve (a `--link-profile`/`PI_LINK_PROFILE` typo, a dangling `default`) is a loud refusal: no dial, no promotion, no auto-reconnect. Fix the config, then `/link-connect` (same latch family as auth/identity/version rejection).

**Hub machine setup.** `default` answers "where is my fleet?" — on the machine that hosts the hub, the answer is *here*: point `default` at a loopback profile carrying the fleet token (`url` omitted). Its terminals dial loopback; the first one promotes and binds per `PI_LINK_HOST` (bind stays env — a deployment fact of one process, not a membership fact of the machine). Member machines point their `default` at the public URL. A hub machine whose `default` dialed its own public address could never self-bootstrap after an outage — non-loopback never promotes.

**Fail-closed.** A non-loopback bind (`PI_LINK_HOST` not in `127.0.0.1`/`localhost`/`::1`; `127.0.0.2` counts as non-loopback) without a resolvable token refuses to start with an explicit reason — an unauthenticated public bind is not an allowed state. The refusal fires **once** (no retry storm every 2–5s); `/link-connect` retries after the config is fixed.

**Hub auth.** With a token resolved, `register` is verified via `sha256(token)` digests compared with `crypto.timingSafeEqual` (digest both sides — equalizes length; the token itself is never logged). Mismatch/missing → hub replies an error, closes the socket, and notifies locally with the source address. Loopback clients authenticate too (one code path).

**Auth rejection vs hub loss.** The client sets an `authFailed` flag on rejection and **stops** auto-reconnect (a wrong-token terminal would otherwise hammer the hub every 2s), notifying clearly and pointing at the profiles file; `/link-connect` resets it. Hub loss keeps today's retry-with-backoff.

**No cross-machine promotion (B6).** A client whose resolved profile URL is non-loopback never runs `startHub` — hub loss means reconnect-with-backoff only. Otherwise one outage splits the fleet into per-machine islands that all look healthy. With config-first resolution, member machines of a remote fleet structurally cannot self-promote.

**Transport encryption.** TLS termination belongs to the deployment edge (certificate lifecycle does not belong in a single-file extension). The profile `url` accepts `wss://` natively (Node's ws client speaks TLS). Sending a token over plaintext `ws://` to a non-loopback host produces one warning per session but is not blocked — policy belongs to operators, mechanism to code.

Minimal reverse-proxy TLS SOP (caddy):

```
caddy reverse-proxy --from hub.example:9900 --to 127.0.0.1:9900
```

With cloudflared: publish the local `9900` port through a named tunnel and point the member machines' profile `url` at the tunnel's `wss://` hostname.

**Mixed-version rule.** `register` carries an optional `token` field (old hubs ignore unknown fields). Upgrade all terminals before enabling auth so a mix of old (unauthenticated) and new (token-expected) hubs doesn't fragment the fleet.

### Workspaces & addresses (ADR-0008)

Every terminal has two independent identity axes, both fixed at startup, both riding the session file (and pre-written by `link_new`):

- **Home workspace** — where the terminal lives: its name's uniqueness scope and the first half of its address. `pi --link-workspace <name>` > `PI_LINK_WORKSPACE` env (consumed once) > saved `link-workspace` session entry > **`default`**. Undeclared no longer means privileged — it means the `default` workspace, where zero-config loopback pairs still find each other. Never derived from the cwd.
- **Global grant** — how far the terminal sees and reaches: `pi --link-global` > `PI_LINK_GLOBAL=1` env (consumed once) > saved `link-global` session entry > false. Self-declared within the trust domain — the token remains the only security boundary (ADR-0002); the grant is mistake-proofing and noise control, not an authorization tier.

**Address = `workspace/name`.** Names are unique per workspace, and on the wire every `from`/`to` is fully qualified — no ambiguity, ever. In tool calls a bare name resolves in *your own* workspace only (no scope chain); cross-workspace targets are always spelled qualified — five extra characters beat one ambiguity. `/` and `*` are reserved characters, rejected loudly at declaration (startup error, exit 1) and at register.

**The reach matrix** (visibility = reachability, one rule): same workspace ✓; anyone → a global member ✓; a global member → anyone ✓; regular cross-workspace ✗ — refused with an existence-hiding `not_found` (identical text whether the target exists or not; confirming existence across the wall would leak membership). The matrix cuts every surface: `link_list` (grouped by workspace, global members badged 🌐, same-workspace addresses shortened), the welcome snapshot, `terminal_joined`/`terminal_left`, broadcasts, status fan-out, and direct addressing.

**Broadcast follows the matrix.** A regular's `*` reaches its own workspace plus global members; a global's `*` reaches everyone; `workspace/*` targets one group (a regular may target only its own group — a foreign group is refused like any cross-workspace send).

**The hub never renames — it accepts or refuses.** `register` carries the terminal's pi `sessionId` as identity anchor. Claiming a live `(workspace, name)`: same sessionId → **silent takeover** (the hub adopts the new socket and closes the old one, no left/joined churn — netsplit heal and resurrection both ride this); different sessionId → loud refusal and a `nameTaken` latch (no reconnect storm; pick another name with `/link-name`, then `/link-connect`). Concurrent clones must self-name distinctly at the source — disambiguation belongs to the joiner. A joiner colliding with the hub's own identity is always refused — the hub cannot be taken over through its client port.

**Fail-closed handshake, both axes.** `register` carries home workspace + grant + sessionId; `welcome` echoes the effective home and grant. A missing or mismatched echo (a non-conforming hub) refuses membership loudly and **stops auto-reconnect** — identity is honored or membership is refused. **Upgrade the hub first** (protocol v3; the fleet upgrades together), then `/link-connect`.

**Hub and promotion.** The hub routes for all workspaces regardless of its own membership; promotion ignores workspace — any survivor can promote and correctly serves every group after clients re-register.

---

### Status channel v2: budget, model label, idle-since, version gate (ADR-0005/0006)

**Protocol version gate.** `LINK_PROTOCOL_VERSION` rides `register` and is echoed in `welcome`; a missing or mismatched version on either side refuses membership loudly and stops auto-reconnect (`/link-connect` retries). There are no mixed-version code paths — **the fleet upgrades together**.

**Context budget — one axis.** Over budget ⇔ `tokens ≥ budget`, an absolute used-tokens ceiling. Undeclared budgets default to `contextWindow − 100K` (exactly the retired "hot terminal" semantics — the hot vocabulary is gone). Resolution mirrors link-name: `pi --link-budget 56k` > `PI_LINK_BUDGET` env (consumed once) > saved `link-budget` session entry > default. Runtime-mutable on any visible terminal via the `link_budget` tool; an optional per-dispatch `budget` on `link_send`/`link_prompt` overrides it for one exchange (a mismatch notice shows both values). Reminders are **sender-side only and blunt** — `⚠ "x" over budget: 61K/56K — decide whether to link_compact (or link_new)` — on send/prompt/compact/new results, the prompt response readout, and a `link_list` marker. Nothing is injected into the receiver's context; no auto-compact, no dispatch block.

**Model label.** Every terminal reports its raw `provider/model-id:thinkingLevel` (mid-session changes re-push), shown in `link_list`. **Idle-since.** The hub tracks when each terminal went idle (hub clock, so it's cross-machine correct), shown as idle duration in `link_list` — the retirement mechanism's data source.

**`link_new` (ADR-0006).** The third lifecycle op over the link: start a brand-new session in place. The target acks first (carrying its `oldSessionId` — pi never deletes session files), then pre-writes its link-name/workspace/budget into the new session and rejoins under the same name. Completion = watching it leave and rejoin.

---

## LLM Tools

The extension registers six tools that the LLM can invoke during agent runs. pi-link also ships with a bundled **pi-link-coordination** skill that gives agents on-demand guidance for tool selection, delegation patterns, and avoiding common coordination mistakes.

### Which tool should I use?

| Tool           | Behavior                                             | Returns                                             |
| -------------- | ---------------------------------------------------- | --------------------------------------------------- |
| `link_send`    | Send a message; optionally trigger the remote LLM    | Send/delivery status only                           |
| `link_prompt`  | Run a prompt on a remote terminal and wait for reply | The remote terminal's assistant response            |
| `link_list`    | List currently connected terminals                   | Terminal list with roles, status, cwd, and context  |
| `link_compact` | Ask another terminal to compact its context window   | Waits for completion; returns compacted or an error |
| `link_budget`  | Set a terminal's declared context budget             | Ack (✓/✗); target persists + re-announces           |
| `link_new`     | Start a brand-new session on a terminal, in place    | Ack with old session id; target leaves and rejoins  |

**If you need the other terminal's answer back, use `link_prompt`.** Use `link_send` to notify or steer without waiting.

### `link_send`

Send a fire-and-forget chat message to a specific terminal or broadcast to all.

| Parameter     | Type      | Description                                          |
| ------------- | --------- | ---------------------------------------------------- |
| `to`          | `string`  | Target terminal address: bare name (your own workspace) or qualified `"workspace/name"`; `"*"` broadcasts your visible set, `"workspace/*"` one group |
| `message`     | `string`  | Message content                                      |
| `triggerTurn` | `boolean` | **Required.** `true` wakes the receiver's LLM; `false` delivers passively (busy = steered into the live run; idle = stored, not processed) |

When `triggerTurn` is `true`, the message is queued in the receiver's local inbox. Nearby arrivals are coalesced (200ms debounce), and delivery is gated on the receiving agent being idle - ensuring it starts a clean new turn. Messages arrive as a single `[Link: N message(s) received]` block at the top of a fresh turn, not mid-run. When `triggerTurn` is `false`, delivery is immediate fire-and-forget: the message is steered into the receiver's live run if it is busy, or stored in its session but **not processed** if it is idle — an idle-target warning (` ⚠ "x" is idle — message stored, not processed; resend with triggerTurn:true or use link_prompt`) is appended to the tool result in that case so the sender knows the dispatch may rot. `triggerTurn` is required (no default); omitting it yields a tool-validation error so the sender must choose per message.

Note: `triggerTurn` does **not** cause the response to come back to the caller - use `link_prompt` for that.

> **Broadcast note:** Sending to `"*"` delivers to your visible set — a regular terminal reaches its own workspace plus global members; a global member reaches everyone. `"workspace/*"` targets one group (a regular may target only its own). The sender is excluded.

Pre-validates the target name against the local terminal list before sending, catching typos early. See [Message Routing](#message-routing--error-handling) for delivery semantics. **Self-target rejection** - sending to yourself (`to` equals your own name) returns an immediate error.

### `link_prompt`

Send a prompt to a remote terminal and **wait** for the LLM's response (synchronous RPC pattern).

| Parameter | Type     | Description          |
| --------- | -------- | -------------------- |
| `to`      | `string` | Target terminal address: bare name (your own workspace) or qualified `"workspace/name"` |
| `prompt`  | `string` | Prompt text to send  |

- The remote terminal processes the prompt via `pi.sendUserMessage()` - as if a user typed it.
- Returns the remote terminal's actual assistant reply text as the tool result.
- **Self-target rejection** - prompting yourself (`to` equals your own name) returns an immediate error.
- **Heartbeat-based timeout** - no short fixed deadline. The target sends keepalives every 30s while working. The sender resets a 90-second inactivity timer on each keepalive. A 30-minute hard ceiling acts as a safety net against broken-but-chatty targets. A 10-minute task with regular activity never times out; a genuinely dead target times out in 90 seconds of silence.
- **Immediate failure on disconnect** - if the target leaves the network (`terminal_left`), pending prompts to that target fail immediately instead of waiting for the inactivity timeout.
- **Early failure detection** - if the message can't be delivered (e.g., target not found), the tool resolves immediately with an error instead of waiting for the timeout.
- Supports abort signals.
- Targets **one terminal at a time** (no broadcast mode).
- Only **one remote prompt** can execute at a time per target terminal. Concurrent requests are rejected with `"Terminal is busy"`.

### `link_list`

Lists all connected terminals with role info, live agent status, working directory, context usage, and self-identification. Takes no parameters.

Each terminal reports its current working directory on connect. `link_list` shows the full absolute path so agents can choose the right target, use explicit paths when terminals differ, and catch wrong-project mistakes early.

Each terminal also reports its current LLM context usage, rendered as `45K/272K (17%)` — tokens used over the context window, with percent. Briefly after compaction it shows as `?/272K` until the next live token count arrives. Treat it as an advisory signal when choosing a worker; prefer a less-loaded terminal for context-heavy delegation.

Each terminal's status is derived automatically from Pi lifecycle events - agents can't set it manually. Three states:

| Status            | Meaning                 |
| ----------------- | ----------------------- |
| `idle (2m)`       | Waiting for user input  |
| `thinking (3s)`   | LLM is generating       |
| `tool:bash (12s)` | Running a specific tool |

Durations are computed at render time from a `since` timestamp - no timer traffic over the wire. For peers, idle duration prefers the hub-authoritative idle-since clock (cross-machine correct; ADR-0005). Terminals that just joined with no status data yet render as blank, not fake idle.

Each line also shows the terminal's **model label** (`provider/model-id:thinkingLevel`, ADR-0005) and, when the terminal's used tokens reach its context budget, a **`⚠ over budget`** marker with the blunt reminder (see Status channel v2 above).

Working directories use full absolute paths in tool output. In the TUI (`/link`), paths are shortened to `~/...` when possible to keep the display compact.

**Example output:**

```
Connected terminals:
  • opus@pi-link (you)  idle (12s)  · 45K/272K (17%)
    cwd: C:\Users\andre\.pi
  • gpt@pi-link  thinking (3s)  · ?/272K
    cwd: C:\Users\andre\.pi
  • docs@pi-link  idle (1m)  · 90K/272K (33%)
    cwd: C:\Users\andre\.pi
```

### `link_compact`

Ask another terminal to compact its context window and **wait** until it finishes — so the very next call can dispatch new work to the freshly trimmed worker without a busy bounce.

| Parameter      | Type     | Description                                            |
| -------------- | -------- | ------------------------------------------------------ |
| `to`           | `string` | Target terminal address: bare name (your own workspace) or qualified `"workspace/name"` |
| `instructions` | `string` | Optional custom compaction instructions for the target |

- The remote terminal runs `ctx.compact()` — the same code path as `/compact`. The call returns once the runtime reports completion.
- **Success** result: `Compacted "<name>"`. The worker is now idle with a trimmed context, ready for the next dispatch.
- **Busy decline** — if the target is mid-turn or already compacting, it declines immediately with `reason: "busy"`. `link_compact` will **not** interrupt active work; retry when `link_list` shows the worker idle.
- **Self-target rejection** — calling `link_compact` on yourself returns an error pointing at `/compact`.
- **Flat 180-second timeout** — compaction typically takes 5–60s; if the target stops responding mid-compaction the call resolves with a timeout error.
- Supports abort signals.
- Targets **one terminal at a time** (no broadcast mode). To compact several workers concurrently, issue parallel tool calls.
- **No consent or capability gate** — any connected terminal can request compaction on any other; link participants are cooperating peers.

### `link_budget`

Set a terminal's declared context budget (ADR-0005) — the one compaction-decision axis: over budget ⇔ `tokens ≥ budget`.

| Parameter | Type              | Description                                                                                          |
| --------- | ----------------- | ---------------------------------------------------------------------------------------------------- |
| `to`      | `string`          | Target terminal address: bare name (your own workspace) or qualified `"workspace/name"` (self allowed) |
| `budget`  | `number \| "off"` | Absolute used-tokens ceiling (e.g. `56000`), or `"off"` to clear back to the default (`contextWindow − 100K`) |

- The target updates its declared budget, **persists it to the session** (survives restart), pushes an immediate status update so peers see the new value, and acks ✓.
- ✗ on `not_found` (including cross-workspace targets — visible-set addressing applies).
- No extra authorization — link membership is already full power (ADR-0002). Budget is a threshold, not a membership invariant, so runtime mutation is safe (contrast workspace, fixed for life).

### `link_new`

Ask another terminal to **start a brand-new session in place** (ADR-0006) — fresh context without process churn. History stays resumable on disk; pi never deletes session files.

| Parameter | Type     | Description          |
| --------- | -------- | -------------------- |
| `to`      | `string` | Target terminal address: bare name (your own workspace) or qualified `"workspace/name"` |

- **Ack-before-teardown** — the target acks first, carrying its `oldSessionId` (resurrection metadata; fleet convention: record it on the work ticket), because session replacement kills the responder's socket mid-flight.
- **Identity carries** — link-name, workspace, declared budget, and connect intent are pre-written into the new session, so the new instance rejoins under the same name in the same workspace. No rename-at-new (`/link-name`'s job), no seed prompt (wait for the rejoin, then `link_prompt`).
- **Completion** = observing `terminal_left` → `terminal_joined` for the same name.
- **Busy decline** — mid-turn, pending remote prompt, or compacting → `reason: "busy"`; retry when idle. Self-target rejection points at `/new`.

### Coordination recipes

The six tools compose into coordination shapes worth naming:

- **Fan-out** - split independent subtasks across several terminals with `link_send(triggerTurn: true)`, keep working, then synthesize the callbacks. Parallelizes work that doesn't share a sequence. If a worker's context (visible in `link_list`) runs high, `link_compact` trims it and returns when the worker is idle — feed it the next subtask immediately.
- **Adversarial review** - have one terminal produce or edit work, then `link_prompt` another to critique it. Because `link_prompt` blocks on a reply from a separate session, the critique lands in the same turn; feed it back or revise locally.
- **Independent cross-check** - send the same verification question to two terminals without sharing their answers, then reconcile - or ask a third to resolve disagreements. Separate contexts mean neither anchors on the other.

---

## Slash Commands

| Command                 | Purpose                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `/link`                 | Show link status (name, role, online count, agent status, context usage, and cwd per terminal)                           |
| `/link-name [name]`     | Rename and save as this session's preferred link name. With no argument, adopts the Pi session name. Restored on resume. |
| `/link-broadcast <msg>` | Broadcast a chat message to all other terminals                                                                          |
| `/link-connect`         | Connect to Pi Link (works anytime, with or without `--link`)                                                             |
| `/link-disconnect`      | Disconnect from Pi Link and suppress auto-reconnect (overrides `--link`)                                                 |

### Examples

```
> /link
⚡ Link: builder (hub) · 3 online
  builder: idle (12s) · 45K/272K (17%)
    cwd: ~/my-project
  worker-1: thinking (3s) · ?/272K
    cwd: ~/my-project
  worker-2: tool:bash (5s) · 180K/272K (66%)
    cwd: ~/other-project

> /link-name orchestrator
✓ Renamed to "orchestrator"

> /link-name
✓ Renamed to "my-session"

> /link-broadcast starting the build pipeline
✓ Broadcast sent

> /link-disconnect
✓ Disconnected from link

> /link-connect
✓ Joined link as "orchestrator" (3 online)
```

With no argument, `/link-name` adopts the Pi session name. `/link-connect` joins an existing hub if one is running; otherwise it starts the hub.

**Name persistence:** `/link-name` saves your preferred name to the session. Resume later and it's restored automatically. If the name is taken in your workspace (held by a *different* live session), the hub refuses loudly and stops auto-reconnect — pick another name, then `/link-connect`. If *your own* session re-registers (netsplit heal, resurrection), the hub silently takes the new socket over under the exact same name. See [Name Uniqueness & Takeover](#name-uniqueness--takeover) for details.

See [Configuration](#configuration) for details on `--link`, `/link-connect`, and `/link-disconnect` behavior.

---

## Architecture

### Hub-Spoke Topology

The network topology is **hub-spoke (star)**:

```
                       +-----------+
                       |    Hub    |
                       |   :9900   |
                       +-----+-----+
                             |
              +--------------+--------------+
              |              |              |
          +---+---+      +---+---+      +---+---+
          | pi-2  |      | pi-3  |      | pi-4  |
          |client |      |client |      |client |
          +-------+      +-------+      +-------+
```

- The **first terminal** to start becomes the **hub** - it runs a `WebSocketServer` on `127.0.0.1:9900`.
- **Subsequent terminals** connect as **clients** via plain WebSocket.
- All messages route **through the hub**; clients never talk directly to each other.

### Auto-Discovery Protocol

The discovery sequence runs on startup (with `--link` or `pi-link`) or when `/link-connect` is used. See [Configuration](#configuration) for details.

The sequence is a simple fallback:

1. Attempt to connect as a **client** to `127.0.0.1:9900`.
2. If connection fails → become the **hub** (start a WebSocket server on that port).
3. If both fail (rare race condition) → retry after a randomized 2-5 second backoff.

### Hub Promotion

When the hub disconnects, clients detect the WebSocket close event, enter `"disconnected"` state, and call `scheduleReconnect()`. The **first terminal to retry** becomes the new hub via the same initialize-or-fallback flow.

There is **no explicit leader election** - promotion is race-based.

---

## Troubleshooting

### Port 9900 is already in use

If another process occupies port 9900, the terminal can't become the hub. It will attempt to connect as a client instead (which also fails if there's no real hub), then retry after 2-5 seconds. Free the port, or set `PI_LINK_PORT` to run an isolated fleet on another port - see [Limitations](#limitations--design-decisions).

### "Terminal is busy" rejections

Each terminal handles **one remote operation at a time** — a local agent run, an incoming `link_prompt`, or a `link_compact` all block the others. If a `link_prompt` arrives while the terminal is busy, it's immediately rejected with `"Terminal is busy"`. There is no queuing. Solutions:

- Wait for the target terminal to finish its current task.
- Spread prompts across multiple worker terminals.
- Have the sender retry after a delay.

A `link_compact` to a busy target behaves the same way — the call resolves with `Compact on "<target>" not done: busy` instead of interrupting active work. Retry when `link_list` shows the worker idle.

### Terminals don't see each other

- Verify both terminals are on the same machine (the link only works on `127.0.0.1`).
- Run `/link` in each terminal to check status.
- Ensure port 9900 isn't blocked or occupied by a non-link process.

### Hub promotion loses state

When the hub goes down and a client promotes itself, terminal names and in-flight prompts from the old hub session are lost. All surviving clients reconnect and re-register. This is by design - see [Limitations](#limitations--design-decisions).

---

## Limitations & Design Decisions

| #   | Decision                                  | Rationale / Impact                                                                                                                                                                                              |
| --- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **No authentication**                     | Any localhost process can connect to port 9900. Acceptable for local dev; don't expose the port externally.                                                                                                     |
| 2   | **Hardcoded port (9900)**                 | Not configurable without editing `DEFAULT_PORT` in `index.ts`. Could conflict with other services on the same port.                                                                                             |
| 3   | **Race-based hub promotion**              | Non-deterministic. Terminal state (names, in-flight prompts) is lost during promotion. Simple but imperfect.                                                                                                    |
| 4   | **Single remote prompt per terminal**     | No queuing - immediate rejection if busy. See [`link_prompt`](#link_prompt) and [Troubleshooting](#terminal-is-busy-rejections).                                                                                |
| 5   | **No message persistence**                | Purely ephemeral WebSocket frames. Messages are lost if the recipient is offline.                                                                                                                               |
| 6   | **Client rename triggers full reconnect** | Changing a client's name requires a new `register` message, so the client disconnects and reconnects. Hub renames are handled in-place with collision checks.                                                   |
| 7   | **Single-machine / localhost-only**       | Link only binds to `127.0.0.1`; terminals on different machines cannot join.                                                                                                                                    |
| 8   | **Rename during prompt loses keepalives** | If the target renames mid-prompt, keepalive resets stop working (pending requests track by name). The final response can still succeed by request ID, but inactivity may false-fire on long tasks after rename. |

### Status channel event model (ADR-0001)

The status channel reshapes its send-side event model and consumes the existing peer context cache at every decision point, **without changing the wire protocol**. Three constants govern it:

| Constant                | Value  | Role                                                                                                                                                                                |
| ----------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STATUS_DEBOUNCE_MS`    | 1,000  | Trailing-edge debounce window on `status_update` sends. Intermediate states are dropped (status is absolute, not incremental); the latest derived state is sent at the window edge. `force` pushes bypass. |
| `HEARTBEAT_INTERVAL_MS` | 60,000 | Unconditional heartbeat while connected. Bounds peer-cache staleness at ≤60s (idle growth via steered messages was previously unbounded) and doubles as a liveness signal. Runs in both roles. |
| `DEFAULT_BUDGET_RESERVE` | 100,000 | ADR-0005: default-budget reserve — an undeclared context budget defaults to `contextWindow − 100K` (exactly the retired hot-terminal semantics; the hot vocabulary is gone). |

**Decision-point readouts** (full absolute form `tokens/window (percent%)`, never percent alone), plus the ADR-0005 blunt over-budget reminder (sender-side only):

- `link_send` success appends `· <readout>` and, when the target is over budget, `⚠ "x" over budget: 61K/56K — decide whether to link_compact (or link_new)`; broadcast (`to:"*"`) gets no readout.
- `link_prompt` result appends a final `[<readout>]` line carrying the same verdict. Cache freshness is guaranteed by the push-before-response ordering: `agent_end` calls `pushStatus(true)` (force, bypassing debounce) immediately before emitting `prompt_response`, so the freshest `status_update` always precedes the response even at a busy run's tail where the handler's non-force push is debounce-swallowed.
- `link_compact` success shows `before → after` (and re-fires the reminder if the target is still over budget).
- `link_list` marks over-budget terminals with `⚠ over budget`.
- Missing cache entries / `tokens: null` omit silently.

ADR-0005 §2: reminders are **sender-side only** — nothing is injected into the receiver's context (that would spend the over-budget terminal's tokens to tell it it overspent).

The hub stays a dumb fan-out (no subscriptions, no broker) — per-recipient visible-set filtering since ADR-0004. Busy-terminal event rate is capped at ~1 msg/s (was several per tool boundary); idle terminals emit 1/60s (net new, negligible). See `docs/adr/0001-status-channel-event-model.md`.

---

## Dependencies

### Runtime (installed by `pi install`)

| Package | Version | Purpose                             |
| ------- | ------- | ----------------------------------- |
| `ws`    | ^8.20.0 | WebSocket library (server + client) |

### Development

| Package     | Version | Purpose                     |
| ----------- | ------- | --------------------------- |
| `@types/ws` | ^8.18.1 | TypeScript type definitions |

### Provided by Pi (no install needed)

| Package                           | Purpose                                          |
| --------------------------------- | ------------------------------------------------ |
| `@earendil-works/pi-coding-agent` | Pi SDK types (ExtensionAPI, ExtensionContext)    |
| `@earendil-works/pi-tui`          | TUI Text widget for custom message rendering     |
| `typebox`                         | JSON Schema type definitions for tool parameters |

> **Pi version requirement:** pi-link 0.1.15+ requires Pi 0.74 or later (the `@earendil-works/*` namespace). Users on Pi 0.73 or earlier should pin `pi-link@0.1.14`.

### `package.json`

```json
{
  "name": "pi-link",
  "bin": {
    "pi-link": "./bin/pi-link.mjs"
  },
  "dependencies": {
    "ws": "^8.20.0"
  },
  "devDependencies": {
    "@types/ws": "^8.18.1"
  },
  "pi": {
    "extensions": ["./index.ts"],
    "skills": ["./skills"]
  }
}
```

`pi.extensions` tells Pi which files to load as extensions. `pi.skills` registers bundled skill directories. `bin` exposes the `pi-link` CLI (see [Configuration](#configuration)).

---

## Internals

> This section covers implementation details for contributors and developers who want to understand or modify the extension's internals.

### Protocol

The wire protocol (version 3, ADR-0008) consists of **11 message types**, all serialized as JSON over WebSocket frames. Cwd and context fields are optional. Every `from`/`to` is a fully qualified address (`workspace/name`); `"*"` broadcasts per the reach matrix, `"workspace/*"` targets one group. `register` carries `version`/`workspace`/`global`/`sessionId`/`budget`/`model` (guaranteed present); `welcome` echoes the version, the effective home and grant, and the visible global members.

| Type               | Direction       | Purpose                                                                             |
| ------------------ | --------------- | ----------------------------------------------------------------------------------- |
| `register`         | Client → Hub    | First message after connecting; declares name, home workspace, global grant, sessionId |
| `welcome`          | Hub → Client    | Confirms name, echoes effective home + grant, terminal list + snapshots             |
| `terminal_joined`  | Hub → All       | Broadcast when a terminal joins; may include cwd and context                        |
| `terminal_left`    | Hub → All       | Broadcast when a terminal disconnects                                               |
| `chat`             | Any → Any/All   | Fire-and-forget message; optionally triggers LLM turn                               |
| `prompt_request`   | Any → Any       | Request a remote terminal to execute a prompt                                       |
| `prompt_response`  | Any → Any       | Response carrying the remote prompt result                                          |
| `compact_request`  | Any → Any       | Request a remote terminal to compact its context; awaits a response                 |
| `compact_response` | Any → Any       | Completion/failure response for a compact_request                                   |
| `status_update`    | Any → Hub → All | Terminal broadcasts agent status change; carries updated context                    |
| `error`            | Hub → Client    | Error notification                                                                  |

### Message Flow Examples

**Joining the link:**

```
Client                         Hub
  |                             |
  | register {name:"builder",   |
  |           cwd:"C:\\Users\\..."} |
  |---------------------------->|
  |                             |
  | welcome {name, terminals,   |
  | statuses, cwds}             |
  |<----------------------------|
  |                             |
```

Hub then broadcasts `terminal_joined` to the other connected terminals. The `welcome` message includes status, cwd, and context snapshots for all connected terminals (fields omitted above for brevity). `terminal_joined` also includes the new terminal's optional cwd and context.

**Sending a chat message:**

```
Client A            Hub              Client B
  |                  |                  |
  | chat {to:pi-2}   |                  |
  |----------------->|                  |
  |                  | chat {from:A}    |
  |                  |----------------->|
  |                  |                  |
```

**Remote prompt (synchronous RPC):**

```
Client A            Hub              Client B
  |                  |                  |
  | prompt_request   |                  |
  |----------------->|                  |
  |                  | prompt_request   |
  |                  |----------------->|
  |                  |   (LLM runs)     |
  |                  |<-----------------|
  | prompt_response  |                  |
  |<-----------------|                  |
```

### Name Uniqueness & Takeover

Names are unique **per workspace** (ADR-0008) — a terminal's wire identity is its qualified address `workspace/name`. The hub never renames: it accepts or refuses. `register` carries the terminal's pi `sessionId` as the identity anchor:

- **Same `(workspace, name)`, same sessionId → silent takeover.** The hub adopts the new socket and closes the old one, with no `terminal_left`/`terminal_joined` churn — the fleet sees nothing. Netsplit heal and resurrection (same session file, same sessionId) both ride this path.
- **Same `(workspace, name)`, different sessionId → loud refusal.** The hub sends a `name taken` error and closes the socket; the client sets a `nameTaken` latch (the authFailed family — no reconnect storm, `/link-connect` retries). Disambiguation belongs to the joiner: concurrent clones must self-name distinctly at the source.
- **The hub's own identity is untouchable** — a joiner colliding with it is refused, even with the hub's sessionId.

Default names are random 4-character hex IDs: `t-a1b2`, `t-c3d4`, etc.

**Persistence:** `/link-name` saves the preferred name to the session via `pi.appendEntry("link-name", { name })`. On session resume, the saved name is restored and requested from the hub; the same sessionId makes the re-register a takeover, not a collision.

**Rename guards:**

- If you're already using the requested name, `/link-name` returns early (`"Already using..."`).
- Names containing the reserved characters `/` or `*` are refused.
- On the hub, renaming checks if the name is taken by another connected client in the same workspace before accepting the change.
- On a client, the rename triggers a reconnect; the hub enforces per-workspace uniqueness during re-registration and loudly refuses a taken name (`nameTaken` latch) instead of assigning a variant.

**Unregistered client guard:** The hub ignores all non-`register` messages from clients that haven't completed registration, preventing protocol violations from malformed or out-of-order messages.

### State Management

| State Field              | Type                                  | Purpose                                                                                     |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `role`                   | `"hub" \| "client" \| "disconnected"` | Current network role                                                                        |
| `agentRunning`           | `boolean`                             | Whether an agent run is active; blocks incoming remote prompts                              |
| `activeToolName`         | `string \| null`                      | Name of the currently executing tool (drives `tool:<name>` status)                          |
| `stateSince`             | `number`                              | Timestamp of last status change (used for duration display)                                 |
| `currentCwd`             | `string`                              | Current working directory reported to peers on connect                                      |
| `inbox`                  | `array`                               | Queued `triggerTurn:true` messages awaiting idle-gated flush                                |
| `flushTimer`             | `Timer \| null`                       | Pending inbox flush (debounce or busy-retry)                                                |
| `disposed`               | `boolean`                             | Set on `session_shutdown`; guards all WebSocket callbacks against stale context             |
| `startupConnectTimer`    | `Timer \| null`                       | Deferred startup connect (`setTimeout(0)`) so Pi's startup cycle completes first            |
| `manuallyDisconnected`   | `boolean`                             | Set by `/link-disconnect`; suppresses auto-reconnect                                        |
| `pendingRemotePrompt`    | `object \| null`                      | Tracks the single in-flight remote prompt execution                                         |
| `pendingPromptResponses` | `Map`                                 | Outstanding prompt RPCs awaiting responses (includes inactivity + ceiling timers per entry) |

### Message Routing & Error Handling

`routeMessage()` returns a `boolean` indicating delivery status:

- **Hub** - delivery is authoritative. If the target terminal isn't connected, the hub sends a protocol-level error back to the sender. For `prompt_request` messages to unknown targets, the hub sends a `prompt_response` with an error field so the sender's pending promise resolves immediately rather than timing out. Likewise, a `compact_request` to an unknown target gets a synthesized `compact_response` (`ok: false`, `reason: "not_found"`), so a remote-compact call fails fast instead of waiting out its 180-second timeout.
- **Client** - delivery is optimistic (`true` means "sent to hub"). The hub handles routing and errors via the protocol.

### Connection Lifecycle

Internally, teardown is split into two functions:

- **`disconnect()`** - closes sockets, clears connection state, resolves pending promises. Used by `/link-disconnect` and called internally by `cleanup()`.
- **`cleanup()`** - calls `disconnect()`, sets `disposed = true`, clears `ctx`. Used on `session_shutdown`.

Three helpers protect WebSocket callbacks from stale extension context:

- **`getUi()`** - safely accesses `ctx.ui`, returns `null` if the context is invalidated.
- **`notify()`** - wraps `getUi()?.notify()` for safe notification delivery.
- **`isRuntimeLive()`** - returns `false` if `disposed` or context is stale; checked before processing any incoming WebSocket message.

Startup connect is deferred via `scheduleStartupConnect()` (`setTimeout(0)`) so Pi's startup cycle completes and the extension context is fully valid before WebSocket work begins.

The `manuallyDisconnected` flag distinguishes user-initiated disconnects (`/link-disconnect`) from connection loss. When set, `scheduleReconnect()` is suppressed - the terminal stays offline until `/link-connect` is explicitly called.

### Agent Lifecycle Integration

The extension hooks into Pi's agent lifecycle events:

- **`agent_start`** → Sets `agentRunning = true`, blocking incoming remote prompts. Broadcasts `status_update` (`thinking`).
- **`agent_end`** → Wakes up the inbox flush (idle-gated delivery for `triggerTurn:true` messages). Checks if a remote prompt was running; if so, extracts the last assistant response from `event.messages` and sends back a `prompt_response`. Broadcasts `status_update` (`idle`).
- **`tool_execution_start`** → Broadcasts `status_update` (`tool:<name>`).
- **`tool_execution_end`** → Clears tool status; broadcasts `status_update` (`thinking`) while the agent run continues.
- **`session_compact`** → Force-pushes a `status_update` so peers see the new (post-compaction) context usage immediately.
- **`session_shutdown`** → Full cleanup via `cleanup()`: closes all sockets, resolves pending promises, and disposes the extension.

Status updates are push-based: each terminal broadcasts changes to the hub, which fans them out. New joiners receive a status snapshot for all terminals in the `welcome` message.

While executing a remote prompt, the target sends a forced `status_update` every 30 seconds as a keepalive - reusing the existing status push mechanism. On the sender side, each incoming `status_update` from the target resets the 90-second inactivity timer. All resolution paths (response, inactivity, ceiling, abort, disconnect, delivery failure) go through a single `cleanupPending()` helper to prevent double-resolution races.

### Idle-Gated Inbox

When a `chat` message arrives with `triggerTurn:true`, it goes into a local inbox instead of calling `pi.sendMessage()` immediately. This avoids a Pi platform race where steering messages sent mid-agent-run can be stranded (see `REPORT-sendMessage-race.md`).

The flush pipeline:

1. **Debounce** - `scheduleFlush(FLUSH_DELAY_MS)` coalesces burst arrivals (200ms window).
2. **Idle gate** - `flushInbox()` checks `ctx.isIdle()`. If busy, retries every 500ms.
3. **Batch** - up to 20 messages or ~16 000 chars per delivery (soft cap - the first item is always included even if oversized).
4. **Deliver** - one `pi.sendMessage({ triggerTurn: true })` call with a `[Link: N message(s) received]` block.
5. **Drain** - if the inbox still has items, reschedule.

On `agent_end`, the inbox flush is kicked via `scheduleFlush(0)` - deferred to the next macrotask, by which time `ctx.isIdle()` returns `true`.

| Constant          | Value  | Purpose                                  |
| ----------------- | ------ | ---------------------------------------- |
| `FLUSH_DELAY_MS`  | 200    | Burst debounce window                    |
| `IDLE_RETRY_MS`   | 500    | Busy-retry polling interval              |
| `BATCH_MAX_ITEMS` | 20     | Max messages per batch                   |
| `BATCH_MAX_CHARS` | 16 000 | Soft cap on batch text size (~4K tokens) |

### Rendering

Incoming link chat messages render with a styled `⚡ [sender]` prefix using the theme's accent color. The link status text in Pi's footer uses `theme.fg("dim", ...)` to match Pi's standard footer styling.
