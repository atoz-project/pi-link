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
from a context snapshot. The primary capacity metric — percent is display
gloss only, because equal percentages mean very different absolute room on
different window sizes (and Pi's own auto-compaction triggers on an absolute
reserve, default 16K).
_Avoid_: free space, remaining percent

**Hot terminal**:
A terminal whose last-known headroom is below the hot threshold (default
100K tokens) — a typical work order will not fit comfortably; compact before
dispatching heavy work.
_Avoid_: overloaded, full, high percentage

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
