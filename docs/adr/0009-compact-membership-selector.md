# ADR-0009: Compact membership selector — `--link-name` as `[profile:][workspace/]name`

Status: Accepted (2026-08-17, grill-with-docs; Q1–Q8 adopted, Q7 amended). Amends ADR-0007 §profile chain, ADR-0008 §1 workspace chain + §reserved characters. No wire change (protocol stays v3).

## Context

The launch surface grew one flag per wave: `--link` (ADR-0002), `--link-name` (ADR-0002), `--link-budget` (ADR-0005), `--link-profile` (ADR-0007), `--link-workspace` and `--link-global` (ADR-0008) — six flags, three of which express a single concept: **membership** (which island, which group, who). pi's own `--model provider/model:thinking` demonstrates the hierarchical compact selector; ADR-0008 already canonized `workspace/name` as the address form. The profile axis (ADR-0007) is the remaining segment.

## Decision

1. **`--link-name` accepts the membership string `[profile:][workspace/]name`.** A `:` splits the profile from the address; the address follows ADR-0008 (`workspace/name` or bare `name`). All four forms are valid and unambiguous:
   - `fleet-public:pl/s-k3-a` — full
   - `pl/s-k3-a` — ambient profile
   - `fleet-public:s-k3-a` — ambient workspace
   - `s-k3-a` — bare name
   Each omitted segment falls through its existing precedence chain independently (profile: env string → profiles-file `default` → fail-closed per ADR-0007; workspace: env string → session entry → `"default"` per ADR-0008; name: session entry → random per ADR-0002).
2. **`--link-workspace` and `--link-profile` are deleted.** `PI_LINK_WORKSPACE` and `PI_LINK_PROFILE` are deleted; `PI_LINK_NAME` accepts the same grammar as the flag.
3. `--link` (boolean opt-in), `--link-global`, `--link-budget`, `PI_LINK_GLOBAL`, `PI_LINK_BUDGET` unchanged. `--link` stays boolean because pi's `registerFlag` has no optional-value type — the opt-in and the selector remain visually distinct flags.
4. **Reserved characters**: name and workspace must not contain `/`, `*`, or `:`; profile names must not contain `:`. Malformed strings (empty segments, more than one `:`) fail closed with exit 1 at startup — same posture as #19's empty-value rule.
5. Saved session entries stay granular (`link-name` / `link-workspace` / `link-global`); the profile is still never persisted (membership is per-launch, ADR-0007). `/link-name` runtime rename stays bare-name only — home workspace is fixed for the terminal's lifetime (ADR-0008 §1).
6. **No lockstep rollout**: the selector is client-local parsing. Each terminal adopts the new form at its next natural restart; old launch commands fail loudly (pi rejects unregistered flags).
7. **The fleet SKILL startup template is a first-class implementation deliverable** (user ruling, amending the "docs never lead deployed reality" posture for this artifact): the rewritten template ships in the same wave as the code, not after fleet redeployment.

### Amendments to prior ADRs

- **ADR-0007** profile chain: `--link-profile flag > PI_LINK_PROFILE > default > none` reads "profile segment of the membership string (flag > env) > profiles-file `default` > none". Fail-closed posture unchanged.
- **ADR-0008 §1** workspace chain: "--link-workspace > PI_LINK_WORKSPACE > session entry > default" reads "workspace segment of the membership string (flag > env) > session entry > `default`". Reserved-character list gains `:` (§8).

## Considered and rejected

- **Valued `--link`** (`pi --link fleet-public:pl/s-k3-a`): `registerFlag` supports only `boolean`/`string`; rejected on the platform constraint, and the boolean opt-in stays visually distinct from the selector.
- **A new `--link-identity` flag** instead of upgrading `--link-name`: same expressive power, one more vocabulary word; rejected.
- **Folding the global grant into the string** (a marker sigil): a second sigil language; `--link-global` stays boolean. Rejected.
- **One-release overlap of the old flags**: rejected (no transitional third states); the failure mode is loud and local to the restarting terminal.

## Consequences

- Launch command: `pi --link --link-name fleet-public:pl/s-k3-a --model '<provider>/<model>:<thinking>' [--session <id>]`; fleet/hub terminals omit the workspace segment and add `--link-global` (`--link-name fleet-public:hub-hz --link-global` — a global member's home group is inconsequential, it lands in `default`).
- The `proj` prefix of fleet names retires into the workspace segment (fleet SKILL naming table slims: new names `<proj>/m-<model>`, `<proj>/s-<model>-<letter>`; existing names grandfathered).
- `pi-link --list` / `--resolve` and the bin CLI are unaffected (they do not parse membership flags).
