# One budget axis, remote budget set, model label, idle-since, version gate

ADR-0001 put context readouts at every decision point, yet a dispatching
model does not reliably act on them — the operator wants one explicit,
configurable line to hold terminals to, with a blunt verdict attached.
ADR-0001 also introduced the hot-terminal threshold (headroom < 100K); in
practice hot and "over budget" serve the same decision — *should this
terminal compact?* — and two vocabularies for one decision is one too many.
Separately: the fleet wants each terminal's model visible; the fleet-probe
sidecar is being retired (its session-file scanning cannot survive
cross-machine links), so its surviving value must move into `link_list`; and
the fork's stance (ADR-0004) leaves no appetite for mixed-version ambiguity.

Decision:

1. **One axis: context budget** — an absolute used-tokens ceiling.
   `tokens ≥ budget` = over budget. Percent stays ruled out (ADR-0001).
   **Amends ADR-0001**: the hot-terminal vocabulary is retired. Its safety
   floor survives as the *default* budget: an undeclared budget defaults to
   `contextWindow − 100K`, which is exactly the old hot semantics — so every
   terminal has a budget, declared or derived, and every reminder speaks one
   language: over budget.
2. **Blunt wording, one verdict.** All reminder surfaces say what happened
   and what to decide: `⚠ "x" over budget: 61K/56K — decide whether to
   link_compact (or link_new)`. Surfaces: pre-dispatch warning line in
   send/prompt/compact/new tool results, link_prompt response readout,
   link_list marker. Sender-side only — nothing is injected into the
   receiver's context (that would spend the over-budget terminal's tokens to
   tell it it overspent). Reminder only: no auto-compact, no dispatch block.
3. **Terminal-declared budget.** Resolution mirrors link-name:
   `--link-budget` flag > `PI_LINK_BUDGET` env > persisted `link-budget`
   session entry > default (window − 100K). Rides `register` and
   `status_update`; fleet-visible in link_list for free.
4. **Remote budget set.** New `link_budget` tool: `{to, budget: n | "off"}`,
   hub-routed `budget_set` → target updates its declared budget, persists
   the session entry, pushes an immediate status_update, and acks (✓/✗ like
   compact). `"off"` clears the declared value back to the default. Works on
   any terminal in the sender's visible set, self included; no extra
   authorization — link membership is already full power (ADR-0002). Budget
   is a threshold, not a membership invariant, so runtime mutation is safe
   (contrast workspace, ADR-0004, fixed for life).
5. **Per-dispatch budget.** `link_send`/`link_prompt` keep an optional
   `budget` param: overrides the target's declared value for that exchange's
   checks only, never mutates it. When the two disagree, the tool result
   carries a one-line mismatch notice showing both values — masters normally
   start their slaves, so disagreement is a signal for the user, not a state
   to auto-resolve.
6. **Model label.** `register` and `status_update` carry the raw
   `provider/model-id:thinkingLevel` string; a `model_select` handler pushes
   updates on mid-session changes. Display may shorten; fleet tags (k3,
   glm52) remain a link-name convention, not protocol.
7. **Idle-since (fleet-probe merge).** The hub tracks per-terminal
   `idleSince`: set on register-as-idle and on busy→idle transitions,
   cleared while busy. Carried in the welcome snapshot and status fan-out so
   late joiners see it; `link_list` shows idle duration per terminal — the
   retirement mechanism's data source, now hub-authoritative and therefore
   cross-machine correct. Deliberately dropped with fleet-probe: DEAD
   detection and ×N duplicate flags (both were local session-file scans;
   dead terminals are simply absent from the link), and outside-pi access.
8. **Protocol version gate.** A `LINK_PROTOCOL_VERSION` constant rides
   `register` and is echoed in `welcome`. Hub sees missing/mismatched
   version → error + close. Client sees missing/mismatched echo →
   disconnect, loud notify, stop auto-reconnect (the authFailed pattern).
   One mechanism replaces per-field compatibility reasoning: within a
   versioned link every field is guaranteed present — no "?" fallbacks, no
   silent degradation. **Amends ADR-0004's rejected list**: the workspace
   echo remains as an effective-value readback, but the version gate is now
   the wire's compatibility mechanism.
9. **Hub forwards the new fields explicitly** — `budget`, `model`, and
   `idleSince` join the status normalization whitelist (the hub
   re-serializes rather than trusting clients).

Considered and rejected: keeping hot and budget as two axes (both existed to
answer one question — compact or not; one vocabulary, one verdict); percent
budgets (ADR-0001); receiver-side reminder injection (see 2); local-only
runtime budget change (the operator tunes slaves from the master seat;
self-only mutation would force a restart per adjustment); auto-compact or
dispatch-block on over-budget (the ask is a decision prompt; escalation is a
later ADR if discipline fails); keeping fleet-probe alive alongside
(session-file scanning is machine-local by construction — wrong foundation
for a cross-machine fleet); per-field graceful degradation (one fleet, one
version gate, zero mixed-version code paths).
