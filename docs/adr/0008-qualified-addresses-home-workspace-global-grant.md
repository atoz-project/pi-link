# Qualified addresses: home workspace × global grant, hub never renames

Supersedes ADR-0004's naming and observer decisions (§2, §4); amends
ADR-0002's reach wording. Trust domain untouched: one link, one hub, one
token.

ADR-0004 shipped hard cross-group routing but left three soft spots, all one
disease: **two orthogonal facts squeezed into one field**. "No workspace"
meant both "I declared nothing" and "I see and reach everything" — privilege
granted by omission, fail-open in a codebase whose every other door fails
closed. Meanwhile names lived in one flat pool (`uniqueName` spans all
groups), so workspace A's `reviewer` steals the name and workspace B's
`reviewer` silently becomes `reviewer-2`. Worst: the hub *invents identity* —
rename is silent, register carries no session anchor, so after any netsplit
the zombie socket holds the name and the same terminal rejoins as `m-2`
while the whole fleet keeps dialing `m` into a corpse.

Decision:

1. **Two axes.** *Home workspace* (where I live) and *global grant* (how far
   I see and reach) are separate declarations. Home resolution:
   `--link-workspace` > `PI_LINK_WORKSPACE` > persisted session entry >
   **`default`** — undeclared no longer means privileged, it means the
   `default` workspace, where zero-config loopback pairs still find each
   other. Global grant: `--link-global` > `PI_LINK_GLOBAL` > persisted
   session entry > false. Both fixed at startup, never derived from cwd,
   both identity — they ride the session file and are pre-written by
   link_new (extending ADR-0006's name + workspace pre-write).
2. **Address = `workspace/name`.** Names are unique per workspace, not per
   link. On the wire every `from`/`to` is fully qualified — no ambiguity,
   ever. Display surfaces shorten same-workspace names, group `link_list`/
   panel by workspace, and badge global members. `/` and `*` become reserved
   characters, rejected loudly in both name and workspace at declaration and
   at register.
3. **Reach matrix** (visibility = reachability, one function): same
   workspace ✓; anyone → a global member ✓ (everyone may call management);
   a global member → anyone ✓; cross-workspace between regulars ✗ — refused
   at the hub with an existence-hiding error (the same text whether the
   target exists or not; confirming existence across a wall would leak
   membership). All ADR-0004 §3 surfaces stay cut by this one rule.
4. **Bare names resolve in the sender's own workspace only.** A `to` without
   `/` never falls through to a scope chain (own group, then globals):
   shadowing — a new same-name joiner silently redirecting an existing
   address — is exactly the drift this redesign kills. Cross-workspace
   addressing is always spelled `workspace/name`. Reaching a global member
   from another workspace uses its qualified name too; five extra
   characters beat one ambiguity.
5. **Broadcast follows the matrix.** A regular's `*` reaches its own
   workspace plus global members; a global's `*` reaches everyone; a global
   may target one group with `workspace/*`. A regular using `workspace/*`
   for a foreign group is refused like any cross-workspace send.
6. **The hub never renames — it accepts or refuses.** `uniqueName` is
   retired. `register` carries the terminal's pi `sessionId` as identity
   anchor (the resurrection doctrine's axiom — identity lives in the
   session file — put on the wire). Same `(workspace, name)` as a live
   member: same sessionId → **takeover** (the hub closes the old socket and
   adopts the new one silently, no joined/left churn — netsplit heal and
   resurrection both ride this); different sessionId → **loud refusal**, a
   `nameTaken` latch joins the authFailed family (no reconnect storm,
   `/link-connect` retries). Concurrent ephemeral clones (multica runs) must
   self-name distinctly at the source — disambiguation belongs to the
   joiner, who knows *why* it is a clone; the hub only knows *that* names
   collided.
7. **Global grant is self-declared.** Any member may declare it; no hub-side
   allowlist. The token is the sole security boundary (ADR-0002); the
   workspace system is mistake-proofing and noise control, not defense. An
   allowlist would be a second authorization surface — reopen ADR-0002
   before building one.
8. **One wave, protocol version 3.** Register/welcome gain
   `sessionId`/`global`/effective-workspace echo; the fail-closed membership
   handshake (ADR-0004 §5) extends to both axes: welcome must echo effective
   home and grant, mismatch → refuse membership, stop reconnect. The
   version gate (ADR-0005 §8) does the fleet-wide cutover; no per-field
   fallbacks. ADR-0004 §6 (hub is an ordinary terminal; promotion ignores
   workspace) and §7 (trust domain) stand; a joiner colliding with the
   hub's own identity is refused (the hub cannot be taken over through its
   own client port).

Amendment to ADR-0002's wording: membership still confers full agent-turn
power, but the reach matrix bounds *which* members a regular can address.
This is blast-radius shaping inside one trust domain, not authorization —
any terminal can re-enter with a global grant; nothing but noise hygiene and
mis-dispatch prevention is enforced. The one token remains the only lock.

Considered and rejected: single-axis `*`-as-home (the conflation in new
clothes — a global's name still needs a residence; `*/m` is a namespace
pun, not an address); bare-name scope chain (own group then globals —
shadowing makes addressing drift with membership); takeover-by-name without
the session anchor (an accidental duplicate launch would silently kill a
live terminal's link); hub-side global allowlist (see 7); keeping
`uniqueName` suffixes within a workspace (the hub inventing identity *is*
the smell; a suffix that nobody dialed is a wrong number waiting); per-
workspace hubs/tokens (re-rejected, ADR-0004); existence-confirming
cross-wall errors (see 3); a ws-level ping reaper for zombie sockets
(takeover already heals the one harmful case — the name is reclaimable the
instant its owner returns; reaping is bookkeeping, YAGNI); machine identity
on the wire (a held topic — it must earn its own ruling, not ride this
bump).
