# pi-link

WebSocket-based inter-terminal communication for Pi: one hub, N clients,
chat/prompt/compact/status traffic on a single local link.

## Language

**Status channel**:
The `status_update` broadcast path carrying a terminal's LinkStatus and
context snapshot to all peers. The only state-propagation channel; chat and
prompt traffic are not state carriers.
_Avoid_: heartbeat, telemetry

**Context snapshot**:
A point-in-time reading of one terminal's LLM context usage
(`{tokens, contextWindow}`). `tokens: null` means unknown.
_Avoid_: memory usage, ctx info

**Peer context cache**:
The receiver-side map from terminal name to its last-known context snapshot
(`terminalContexts` on clients, `hubTerminalContexts` on the hub), read
through `getContextFor()`.
_Avoid_: context store, registry

**Decision point**:
A moment where one terminal decides whether/what to dispatch to another and
should consume the peer context cache. Reminder surfaces are sender-side
only (ADR-0005 §2): pre-dispatch warning line in send/prompt/compact/new
tool results, the link_prompt response readout, and the link_list marker.
Nothing is injected into the receiver's context.

**Headroom**:
Absolute remaining context of a terminal: `contextWindow − tokens`, computed
from a context snapshot. Percent is display gloss only, because equal
percentages mean very different absolute room on different window sizes (and
Pi's own auto-compaction triggers on an absolute reserve, default 16K). The
default context budget is derived from it: `contextWindow − 100K`.
_Avoid_: free space, remaining percent

**Context budget**:
The one compaction-decision axis: an absolute used-tokens ceiling,
`tokens ≥ budget` = over budget. Every terminal has one — declared
(`--link-budget` > `PI_LINK_BUDGET` > persisted entry) or defaulted to
`contextWindow − 100K` (subsuming ADR-0001's retired "hot terminal").
Runtime-mutable on any visible terminal via the `link_budget` tool
(hub-routed set + persist + ack); an optional per-dispatch `budget` on
send/prompt overrides it for one exchange, with a mismatch notice when the
two disagree. Reminder-only — blunt verdict text, no auto-compact, no
dispatch block (ADR-0005).
_Avoid_: quota, limit (nothing is enforced), percent, hot (retired)

**Idle-since**:
Hub-tracked timestamp per terminal: set on register-as-idle and busy→idle
transitions, cleared while busy; carried in welcome/status fan-out, shown in
`link_list` as idle duration. The retirement mechanism's data source —
hub-authoritative, so it survives cross-machine links (unlike the retired
fleet-probe's session-file scan) (ADR-0005).
_Avoid_: last activity (that was fleet-probe's file-mtime notion)

**Model label**:
Telemetry: the raw `provider/model-id:thinkingLevel` string in register and
status_update, re-pushed on mid-session model change. Display may shorten;
fleet tags (k3, glm52) are a link-name convention, not protocol (ADR-0005).
_Avoid_: model tag (that's the naming convention)

**Protocol version gate**:
`LINK_PROTOCOL_VERSION` rides register and is echoed in welcome; missing or
mismatched on either side → refuse membership loudly and stop auto-reconnect.
The single compatibility mechanism for the wire — within a versioned link
every field is guaranteed present (ADR-0005, amending ADR-0004's per-field
echo rationale).
_Avoid_: capability negotiation, feature flags

**Fresh session (link_new)**:
The remote lifecycle op that replaces a terminal's session in place:
ack-before-teardown carrying `oldSessionId`, identity (name + home
workspace + global grant) pre-written into the new session, completion
observed as terminal_left → terminal_joined (ADR-0006, extended by
ADR-0008).
_Avoid_: reset, clear, wipe (history stays resumable on disk)

**Fan-out**:
The hub's 1→(N−1) re-broadcast of a status channel message. Hub serializes
once and writes each client socket; cost scales with event rate × N.

**Profile**:
A named fleet membership declaration in `~/.pi/agent/pi-link.json` (mode
0600): the dial target (`url`; omitted = loopback) plus the fleet's shared
token — one resolved profile answers both "where" and "what ticket"
(ADR-0007, amending ADR-0002's match-key role). Selected at spawn:
`default` > none; an unknown name fails closed. The selector surface is
the **membership string** (ADR-0009): `--link-name` / `PI_LINK_NAME` accept
`[profile:][workspace/]name`, each omitted segment falling through its own
chain. The
`default` profile is the machine's answer to "where is my fleet?" — on the
hub's own machine the answer is loopback. No profile means loopback-only,
unauthenticated, pre-ADR-0002 behavior. Membership is machine-level
environment, never a session entry (contrast link-name/workspace/budget).
_Avoid_: account, credential, URL env (retired)

**Resurrection**:
Bringing a retired or dead terminal back by resuming its session file —
explicitly, by path: look up with `pi-link --list -g` / `--resolve <name>`,
then `pi --link --session <path>`. Never implicit by name: the launcher's
name→session execution mode is retired because resuming into an unexpected
live context (or silently creating a blank one on a typo) executes where
nobody decided to (ADR-0007). Identity rides the session (name, workspace,
budget); environment rides the machine's profile.
_Avoid_: resume-by-name, launcher

**Trust domain**:
One link/fleet. Membership confers full power over every member it can
reach (a prompt executes a full agent turn with tools). Exactly one shared
token per domain; no finer-grained authorization exists by design
(ADR-0002). The reach matrix (ADR-0008) shapes blast radius inside the
domain — mistake-proofing, not authorization: any terminal may re-enter
with a global grant; the token remains the only lock.
_Avoid_: tenant, scope

**Home workspace**:
The workspace a terminal lives in — its name's uniqueness scope and the
first half of its address. Every terminal has exactly one: the workspace
segment of the membership string (flag > env) > persisted session entry >
`default`. Fixed for the
terminal's lifetime, never derived from cwd; undeclared means the `default`
workspace, not privilege (ADR-0008, superseding ADR-0004's optional
workspace / global-observer-by-omission).
_Avoid_: tenant, room, channel, project (the flag is per-terminal, not per-repo)

**Global grant**:
The explicit second axis (`--link-global` > `PI_LINK_GLOBAL` > persisted
session entry > false): see everyone, reach everyone, be reachable by
everyone. Self-declared within the trust domain — a badge on status
surfaces, not an authorization tier (ADR-0008).
_Avoid_: admin, superuser, global observer (the by-omission form is retired)

**Address**:
`workspace/name` — the wire-level identity of a terminal; every protocol
`from`/`to` is fully qualified. A bare name in a tool call resolves in the
sender's own workspace only (no scope chain); cross-workspace addressing is
always spelled qualified. `workspace/*` broadcasts to one group (globals
only, for foreign groups). `/`, `*`, and `:` are reserved characters in
names and workspaces (`:` splits the profile segment, ADR-0009). Display
shortens same-workspace addresses (ADR-0008).
_Avoid_: path, FQDN

**Takeover**:
Register carries the pi `sessionId` as identity anchor. A joiner claiming a
live `(workspace, name)` with the same sessionId silently replaces the old
socket (netsplit heal, resurrection); with a different sessionId it is
loudly refused (`nameTaken` latch, authFailed family — no reconnect storm,
`/link-connect` retries). The hub never renames; `uniqueName` suffixes are
retired. Concurrent clones self-name at the source (ADR-0008).
_Avoid_: eviction, kick, rename

**Visible set**:
The universe one terminal can see and address — visibility and reachability
are the same function: own workspace ∪ global members for a regular;
everyone for a global member. Cuts every surface — welcome snapshot,
joined/left, `link_list`, broadcast, status fan-out, direct addressing.
Cross-workspace sends between regulars are refused with an existence-hiding
error (ADR-0004 surfaces, ADR-0008 matrix).
_Avoid_: filter, view
