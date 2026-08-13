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

**Hot terminal**:
A terminal whose last-known context usage is at or above the hint threshold —
risky to hand heavy work without compacting first.
_Avoid_: overloaded, full

**Fan-out**:
The hub's 1→(N−1) re-broadcast of a status channel message. Hub serializes
once and writes each client socket; cost scales with event rate × N.
