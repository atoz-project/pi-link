# Workspace isolation: one hub, scoped visible sets, fail-closed membership

The fleet runs many projects on one link. Two pains, both dispatch hygiene,
neither security: (a) noise — every master sees every project's terminals in
`link_list`/broadcasts, and cross-project mis-dispatch is prevented only by
convention ("谁的 slave 谁用" in the fleet skill), not mechanism; (b) name
pressure — one global namespace for the whole machine. The trust domain is
untouched: one link, one hub, one token (ADR-0002). A workspace is a
visibility group, not an authorization boundary.

Decision:

1. **Workspace is an optional terminal attribute.** Resolution precedence
   mirrors link-name: `--link-workspace` flag > `PI_LINK_WORKSPACE` env >
   persisted session entry (`link-workspace` custom entry) > none. Fixed at
   startup; changing workspace = restart the terminal. Never derived from
   cwd — cwd is a hint, not proof (worktrees and monorepos would fragment
   groups; fleet slaves deliberately live in neutral dirs).
2. **No workspace = global observer.** Its visible set is every terminal, and
   it is in every terminal's visible set. This is exactly the pre-workspace
   behavior, and it is how fleet-m works with zero configuration. Isolation
   is opt-in per terminal.
3. **Visible set is the universe** (full isolation, not decoration). For a
   scoped terminal: same-workspace members ∪ global observers. Every surface
   is cut by it, per recipient: welcome snapshot (terminals/statuses/cwds/
   contexts), `terminal_joined`/`terminal_left` and their `terminals` lists,
   `link_list`, broadcast `*`, status fan-out, and direct addressing
   (`link_send`/`link_prompt`/`link_compact`) — cross-group targets are
   `not_found` at both the client pre-check and the authoritative hub check.
   Scoping the status fan-out also cuts the ADR-0001 hub broadcast bill.
4. **Names stay globally unique** across the whole link; `uniqueName` is
   unchanged and spans all groups. Per-workspace uniqueness would show a
   global observer ambiguous duplicates and force a qualified `ws/name`
   addressing syntax; the fleet naming convention already embeds the project
   prefix, so global uniqueness costs nothing.
5. **Fail-closed membership handshake.** `register` carries `workspace`;
   `welcome` must echo the effective workspace. Missing or mismatched echo
   means the hub cannot honor the requested invariant → the client
   disconnects, notifies loudly, and stops auto-reconnect (the authFailed
   pattern: rejection ≠ hub loss, no 2s hammer). Isolation is honored or
   membership is refused — no silent degradation, no warning-only mode. The
   reverse direction needs no rule: a terminal that declares no workspace is
   asking to be a global observer, which any hub satisfies.
6. **The hub is an ordinary terminal that happens to hold the router.** Its
   own workspace membership is decoupled from serving all groups; promotion
   ignores workspace (any surviving loopback client may promote and must
   route for groups it does not belong to).
7. **Trust domain unchanged** (ADR-0002): one shared token authenticates the
   whole link, workspaces included. Workspace is routing/visibility only; a
   member of any group is still link-RCE-equivalent by design. If workspace
   ever needs to be a security boundary, reopen ADR-0002 instead of hardening
   this.

Considered and rejected: per-workspace hubs/ports (discovery, promotion, and
token stories multiply — a hygiene problem doesn't justify infrastructure);
cwd auto-derivation (see 1); per-workspace name uniqueness (see 4);
decorative filtering — list-only invisibility with addressing still open
(mis-dispatch, the root pain, survives); silent or warning-only degradation
on an old hub (an invariant downgraded to a log line is a broken promise;
first-principles ruling — no backward-compat third state); runtime
`/link-workspace` command (rejoin edge cases across two groups' joined/left
broadcasts for a thing a restart does for free); a generic protocol version
negotiation (the workspace echo *is* the acknowledgment; YAGNI).
