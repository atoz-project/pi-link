# Status channel: debounce + heartbeat, consumed at decision points, zero protocol change

Two symptoms, one root. (1) Peer context is invisible exactly where dispatch
decisions happen (upstream alvivar/pi-link#4); (2) the hub burns CPU at fleet
scale (~47% @ 25 terminals) because every status-kind flip at every tool
boundary broadcasts to N−1 sockets. The root: `pushStatus` triggers on state
*kind* changes rather than on what observers actually consume (context
capacity), so it is simultaneously too chatty (busy runs) and too stale (idle
growth via steered messages).

Decision — reshape the send-side event model and consume the existing peer
context cache at every decision point, changing nothing on the wire:

1. **Trailing-edge debounce, 1s** on `status_update` sends. Intermediate
   states are dropped (status is absolute, not incremental); the latest state
   is sent at the window edge. `force` pushes (session_compact, prompt
   keepalive) bypass the debounce.
2. **60s unconditional heartbeat** while connected (force semantics). Bounds
   peer-cache staleness at ≤60s (idle growth via steers was previously
   unbounded) and doubles as a liveness signal. Issue #4's "force push before
   chat send" (Ask 2) is subsumed and not implemented.
3. **Decision-point consumption** via the existing `getContextFor()` +
   `formatContext()` (absolute tokens + window + percent — never percent
   alone):
   - `link_send` / `link_prompt` / `link_compact` success results append the
     target's readout (pre-send and response decision points). Ordering
     guarantee that makes this fresh with no wire change: `agent_end` pushes
     status *before* emitting `prompt_response`; `session_compact` pushes
     before `compact_response`.
   - Inbound chat (both delivery paths: batched flush and steer) annotates
     **hot senders only**, computed at delivery time (not render time), into
     message *content* — the scheduling audience is the receiving LLM, not a
     human watching the TUI.
4. **Hotness is absolute headroom**, not percent: hot ⇔
   `contextWindow − tokens < 100_000`. Percent is incomparable across window
   sizes, and Pi's own auto-compaction triggers on an absolute reserve
   (`tokens > contextWindow − reserveTokens`, default 16,384). Constant, zero
   config; a knob is deliberately deferred until a real small-window user or
   upstream review demands it.
5. **No age labels** on readouts: staleness is bounded by (1)+(2). If the
   heartbeat is ever removed, this must be revisited.
6. **Hub stays a dumb fan-out**: no subscriptions, no broker, no per-client
   filtering, serialize-once-write-N preserved.

Considered and rejected: optional `context` field piggybacked on
`chat`/`prompt_request` (the side channel already covers every consumer given
the push-before-response ordering; wire change buys nothing); percent-based
hot threshold (incomparable across windows); delta-gated heartbeat (a state
variable and a tuning parameter to save negligible traffic); leading-edge
debounce (complexity for zero-latency first flips nobody needs); `receivedAt`
age labels (disclaimers instead of fixing freshness); config surface
(env/flag) for thresholds and intervals (YAGNI until demanded); pre-send
blocking/confirmation (policy does not belong in the transport layer).

Consequences: busy-terminal event rate is capped at ~1 msg/s (was several),
idle terminals emit 1/60s (was 0 — net new but negligible: ~10 socket
writes/s fleet-wide at 25 terminals); empirical baseline and post-rollout
comparison tracked in issue #2; acceptance harness runs on an isolated port
with protocol-level fake terminals (no test framework added — upstream has
none). Upstream decomposition (one or two PRs) is decided at PR time.
