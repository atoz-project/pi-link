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
should consume the peer context cache: pre-send (tool result), delivery
(inbound message annotation), and response (prompt result readout).

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
ack-before-teardown carrying `oldSessionId`, identity (name + workspace)
pre-written into the new session, completion observed as terminal_left →
terminal_joined (ADR-0006).
_Avoid_: reset, clear, wipe (history stays resumable on disk)

**Fan-out**:
The hub's 1→(N−1) re-broadcast of a status channel message. Hub serializes
once and writes each client socket; cost scales with event rate × N.

**Profile**:
A named fleet connection config in `~/.pi/agent/pi-link.json` (mode 0600):
hub URL + the fleet's shared token. A terminal selects one at spawn
(`PI_LINK_PROFILE` > URL match > `default`); no profile means loopback-only,
unauthenticated, pre-ADR-0002 behavior.
_Avoid_: account, credential

**Trust domain**:
One link/fleet. Membership confers full power over every member (a prompt
executes a full agent turn with tools). Exactly one shared token per domain;
no finer-grained authorization exists by design (ADR-0002). Workspaces do
not subdivide it — they are visibility, not authorization.
_Avoid_: tenant, scope

**Workspace**:
An optional visibility group a terminal declares at startup
(`--link-workspace` > `PI_LINK_WORKSPACE` > persisted session entry > none);
fixed for the terminal's lifetime, never derived from cwd. One hub serves
all workspaces; names stay globally unique (ADR-0004).
_Avoid_: tenant, room, channel, project (the flag is per-terminal, not per-repo)

**Global observer**:
A terminal with no workspace. Its visible set is every terminal and it is in
every terminal's visible set — pre-workspace behavior, and how fleet-level
coordinators work with zero configuration (ADR-0004).
_Avoid_: admin, superuser (it has no extra authority, only full visibility)

**Visible set**:
The universe one terminal can see and address: for a scoped terminal,
same-workspace members ∪ global observers; for a global observer, everyone.
Cuts every surface — welcome snapshot, joined/left, `link_list`, broadcast,
status fan-out, direct addressing (cross-group = `not_found`) (ADR-0004).
_Avoid_: filter, view
