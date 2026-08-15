# Public-reachable hub: profile-based shared-token auth, TLS at the edge

The fleet must span machines where SSH/Tailscale tunnels are impractical or
impossible — that is the reason this ticket exists (user ruling: in-app token
auth is a hard requirement). Link membership is RCE-equivalent on every member
(`link_prompt` runs full agent turns with tools); traffic is plaintext today;
the hub binds loopback only. Authn and transport encryption are therefore both
mandatory the moment the bind address leaves loopback.

Decision:

1. **Client endpoint is configurable**: `PI_LINK_URL` (`ws://` or `wss://` —
   Node's ws client speaks TLS natively, near-zero code). TLS termination
   belongs to the deployment edge (caddy/cloudflared SOP in README), never
   in-app certificate management. Connecting with a token over plaintext
   `ws://` to a non-loopback host produces one loud warning but is not blocked
   — policy belongs to operators, mechanism to code.
2. **Tokens live in profiles** (user ruling, replacing single-file-token):
   `~/.pi/agent/pi-link.json` (mode 0600), shape
   `{ "profiles": { "<name>": { "url": "...", "token": "..." } }, "default": "<name>" }`.
   Selection: `PI_LINK_PROFILE` > profile whose `url` matches `PI_LINK_URL` >
   `default` > none (= loopback-only, unauthenticated, byte-identical to
   today). Secrets in the file; non-secret endpoint config in env.
3. **Fail-closed**: non-loopback bind (`PI_LINK_HOST`) without a resolvable
   token → the hub refuses to start, with an explicit reason.
4. **Auth failure UX**: `crypto.timingSafeEqual` compare; hub replies an error
   and closes the socket, notifying locally with the source address. The
   client distinguishes auth rejection from hub loss: rejection **stops**
   auto-reconnect (otherwise a wrong-token terminal hammers the hub every 2s)
   and notifies clearly, waiting for manual `/link-connect`; hub loss keeps
   today's retry-with-backoff.
5. **No cross-machine promotion** (B6): a client whose URL is non-loopback
   never runs `startHub` — hub loss means reconnect-with-backoff only.
   Otherwise one hub outage splits the fleet into per-machine islands that all
   look healthy. Terminals local to the hub machine keep today's promotion.
6. **One trust domain per profile** (B5): membership confers full power by
   design; there is one shared token per profile and deliberately no
   per-terminal capability model. If a true third party ever joins, reopen
   this.
7. **Fork-first, upstream PR later** (B4): `register` gains an optional
   `token` field — old hubs ignore unknown fields; unset means unchanged
   behavior; mixed-version rule (upgrade everyone, then enable auth) goes in
   the README.

Considered and rejected: tunnels-only (unavailable in target environments);
env-var token (visible in `ps`; user ruled profiles); per-terminal tokens
(meaningless without a capability model); in-app TLS (certificate lifecycle
does not belong in a single-file extension).
