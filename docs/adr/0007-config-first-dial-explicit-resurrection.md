# Config-first dial resolution & explicit resurrection

Incident, 2026-08-17: after the public hub upgraded to protocol v2, three
local terminals restarted. The two launched with `PI_LINK_URL` in their
environment rejoined the public hub; the one without it dialed loopback,
found nobody, promoted itself into a local hub, and the fleet silently split
in two. The operator had written `"default": "fleet-public"` in
`~/.pi/agent/pi-link.json` and reasonably believed that settled where every
terminal goes — but under ADR-0002 the profile's `url` was only a *token
match key*; the dial target lived exclusively in ambient process
environment. The root cause is a layering error: **which fleet this machine
belongs to is a machine-level fact**, yet it was stored per-process, in
invisible env inherited through tmux spawn chains — exactly the kind of
state a resurrected session cannot see.

Resurrection correctness = identity × environment. Identity (link name,
workspace, budget, history) is already self-contained in the session file
(ADR-0004/0005/0006). This ADR fixes the environment half, and rules on the
identity-resolution half of the resurrection recipe (the launcher).

Decision:

1. **The profile is the dial target.** A profile is a complete fleet
   membership declaration: *where to dial* (`url`; omitted = loopback) and
   *what ticket to carry* (`token`). One resolved profile answers both.
   **Amends ADR-0002**: `profile.url` is promoted from token match key to
   dial target.
2. **`PI_LINK_URL` is retired.** The selection chain becomes
   `PI_LINK_PROFILE` > `default` > none. Env selects a *name*; it never
   carries the URL *fact* — naked-URL dialing was the disease's legal
   entrance, and once the URL-match step dies a bare URL cannot even resolve
   a ticket. **Amends ADR-0002** (its chain had `PI_LINK_URL` as step 1 and
   a URL-match step 2; both die). The workspace/budget resolution chains are
   untouched — they resolve identity, not environment.
3. **Unknown profile name fails closed.** `PI_LINK_PROFILE` naming a profile
   that does not resolve is a loud refusal: no dial, no promotion, no
   reconnect — `/link-connect` retries after the config is fixed (joins the
   authFailed / workspaceRejected / versionRejected family). Falling through
   to loopback on a typo would be the 2026-08-17 incident with a different
   spelling.
4. **No config, no default → loopback, unauthenticated.** The zero-config
   single-machine experience is an implicit "local" profile and stays
   byte-identical to pre-ADR-0002 behavior. Upstream friendliness is
   preserved: nobody is forced to write a profiles file.
5. **Promotion is unchanged** (loopback-resolved dial only, ADR-0002 B6).
   Config-first resolution naturally disarms self-promotion on every machine
   whose home fleet is remote — the incident's second failure (the silent
   split) becomes structurally impossible without touching promotion logic.
6. **Fleet membership is machine-level, not session-level.** No
   `link-profile` session entry (contrast link-name/workspace/budget, which
   are identity). Which link a terminal joins is environment; the machine's
   `default` profile answers it. If one machine ever genuinely hosts
   terminals of multiple fleets, the established session-entry pattern is a
   one-entry addition — not before.
7. **Hub-machine doctrine, no new mechanism.** `default` answers "where is
   my fleet?" — on the machine that hosts the hub, the answer is *here*: its
   profiles file declares a default profile whose `url` is loopback (or
   omitted) carrying the fleet token. Its terminals dial loopback, the first
   one promotes and binds per `PI_LINK_HOST` (bind stays env: the hub is the
   passive side; bind address is a deployment fact of one process, not a
   membership fact of the machine). Member machines point their `default` at
   the public URL. Without this doctrine, a hub machine whose default dialed
   its own public address could never self-bootstrap after an outage
   (non-loopback ⇒ never promotes).
8. **The launcher's execution mode is retired.** `pi-link <name>`
   implicitly resolved a name to a session and resumed it — and on zero
   matches silently created a fresh one. Both implicit paths are hazards: a
   resumed session drops a live agent into whatever context that session
   last held; a typo silently forks a blank same-named terminal.
   Resurrection is **explicit two-step**: look up the id
   (`pi-link --list -g` / `pi-link --resolve <name>`), then
   `pi --link --session <id>`. Fresh start is explicit:
   `pi --link --link-name <name>`. The `pi-link` binary keeps only the
   query modes (`--list`, `--resolve`); the `PI_LINK_NAME` internal handoff
   dies with the launcher.

Amendment (2026-08-17, #19): **`--link-profile <name>` flag added.**
Decision 2's chain was the only knob with an env tier but no flag tier — a
historical accident from ADR-0002 (when env carried the URL, the profile
only picked the ticket), never re-examined when the profile was promoted
to the full membership declaration. It also left a residual ambient hole:
`PI_LINK_PROFILE` inherits through tmux spawn chains and can silently
redirect a terminal to a *valid but unintended* profile (fail-closed only
catches unresolvable names). The fleet launch doctrine is "explicit flags,
no ambient defaults"; membership deserves the same tier. The chain becomes
`--link-profile` > `PI_LINK_PROFILE` > `default` > none; the same
principle holds — a flag selects a *name*, facts stay in config. Decision
3's fail-closed latch covers the new first tier unchanged; an empty flag
value is a startup error (exit 1, mirroring `--link-name`). Decision 6 is
unchanged: no session entry — the flag is per-process explicitness, not
persistence.

Considered and rejected:

- **Keeping `PI_LINK_URL` as top-priority override** (issue #15's original
  proposal): rejected — it preserves the ambient-URL entrance, and every
  future incident report would again start with "which env did this process
  inherit?". Temporary redirection is expressed by selecting another
  profile, which carries its ticket with it.
- **Per-session fleet membership** (`link-profile` entry): rejected as
  environment-masquerading-as-identity; YAGNI until multi-fleet-per-machine
  is real (decision 6).
- **Hub self-detection** (dial own public IP, recognize self, promote):
  rejected — NAT-fragile magic replacing a one-line config doctrine.
- **Doc-only fix** (README warning that profile.url does not dial): rejected
  — the intuition trap stays armed for every future fleet member.
- **Launcher kept with fail-fast resume** (`pi-link <name>` errors on zero
  matches instead of creating): rejected by ruling — the hazard is implicit
  resume itself, not just the zero-match branch; resuming *into the wrong
  live context* and executing there is exactly what explicitness prevents.
- **Launcher kept as fresh-only alias** (`pi-link <name>` ≡
  `pi --link --link-name <name>`): rejected — one action, one spelling.
