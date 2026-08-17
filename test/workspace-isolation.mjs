// ADR-0008 qualified addresses — integration smoke test.
// Boots the real extension (mocked Pi host) as hub, drives raw WebSocket
// clients against it, and asserts the issue #20 acceptance checklist:
// default home for the undeclared, qualified addressing, the reach matrix,
// broadcast semantics, sessionId takeover, nameTaken refusal + latch,
// reserved-character rejection, hub-identity collision, existence-hiding
// errors, and promotion. Raw clients speak protocol v3 — VERSION below.
//
// Requires node_modules to resolve "ws" (npm install) plus the pi host
// packages (typebox, @earendil-works/pi-tui) — index.ts imports them.
// Run: node test/workspace-isolation.mjs

process.env.PI_LINK_PORT ||= "19901"; // isolated test fleet port (before import)

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { setTimeout as delay } from "node:timers/promises";

// #15 item 8: profiles-file path knob (before import). Scenario 4 redirects
// a client to the non-conforming hub via a profile carried in the
// PI_LINK_NAME membership string (ADR-0009; PI_LINK_URL is retired). No `default` key, so every other terminal
// resolves loopback.
const PROFILES_FILE = join(
  mkdtempSync(join(tmpdir(), "pi-link-ws-test-")),
  "pi-link.json",
);
process.env.PI_LINK_PROFILES_FILE = PROFILES_FILE;

const { default: createLink } = await import("../index.ts");

const PORT = 19901;
const VERSION = 3; // LINK_PROTOCOL_VERSION in index.ts
let failures = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  ok — ${label}`);
  } else {
    failures++;
    console.error(`  FAIL — ${label}`);
  }
}

// ── Mock Pi host ────────────────────────────────────────────────────────────

let hostSeq = 0;
function makeHost(flags, opts = {}) {
  const handlers = {};
  const commands = {};
  const tools = {};
  const notifications = [];
  const sentMessages = [];
  const appended = [];
  const pi = {
    registerFlag: () => {},
    getFlag: (name) => flags[name],
    on: (event, handler) => {
      handlers[event] = handler;
    },
    appendEntry: (customType, data) => appended.push({ customType, data }),
    registerTool: (def) => {
      tools[def.name] = def;
    },
    registerCommand: (name, def) => {
      commands[name] = def;
    },
    registerMessageRenderer: () => {},
    sendMessage: (msg) => sentMessages.push(msg),
    sendUserMessage: () => {},
    getSessionName: () => undefined,
    setSessionName: () => {},
  };
  const ctx = {
    cwd: "/tmp/link-test",
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      setStatus: () => {},
      theme: { fg: (_role, text) => text, bold: (text) => text },
    },
    sessionManager: {
      getEntries: () => opts.entries ?? [],
      getSessionId: () => opts.sessionId ?? `sess-host-${++hostSeq}`,
    },
    isIdle: () => true,
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000 }),
  };
  return { pi, ctx, handlers, commands, tools, notifications, sentMessages, appended };
}

async function startTerminal(flags, opts) {
  const host = makeHost(flags, opts);
  createLink(host.pi);
  await host.handlers.session_start({}, host.ctx);
  return host;
}

async function waitFor(pred, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = pred();
    if (hit) return hit;
    await delay(100);
  }
  throw new Error(`timeout waiting for: ${label}`);
}

// ── Raw protocol client (no extension — full control over the wire) ─────────
// v3 register fields are guaranteed present; defaults make a regular member
// of the default workspace with a unique session anchor.

let rawSeq = 0;
function rawClient(register) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const received = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      received.push(msg);
      if (msg.type === "welcome") resolve({ ws, received, welcome: msg });
    });
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "register",
          version: VERSION,
          workspace: "default",
          global: false,
          sessionId: `raw-${++rawSeq}`,
          ...register,
        }),
      ),
    );
    ws.on("error", reject);
  });
}

// Raw client that resolves on the FIRST message (welcome or error) — for
// refusal scenarios.
function rawClientAny(register) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const received = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      received.push(msg);
      if (received.length === 1)
        resolve({ ws, received, first: msg, welcome: msg.type === "welcome" ? msg : null });
    });
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "register",
          version: VERSION,
          workspace: "default",
          global: false,
          sessionId: `raw-${++rawSeq}`,
          ...register,
        }),
      ),
    );
    ws.on("error", reject);
  });
}

const send = (client, msg) => client.ws.send(JSON.stringify(msg));
const ofType = (client, type) => client.received.filter((m) => m.type === type);

// ── Scenario 1: default home, reach matrix, qualified addressing, broadcast ─

console.log("scenario 1: default home + reach matrix + qualified addressing");

const hub = await startTerminal(
  { link: true, "link-name": "hub", "link-global": true },
  { sessionId: "sess-hub" },
);
await waitFor(
  () => hub.notifications.find((n) => n.message.includes("Link hub started")),
  "hub start",
);

// Two zero-config loopback terminals (no workspace, no global) land in the
// default workspace and see each other.
const zc = await startTerminal({ link: true, "link-name": "zc" });
await waitFor(
  () => zc.notifications.find((n) => n.message.includes("Joined link")),
  "zc join",
);
assert(
  zc.notifications.some((n) =>
    n.message.includes('Joined link as "zc"') &&
    n.message.includes('workspace "default"'),
  ),
  "undeclared workspace lands in \"default\"",
);
const zc2 = await startTerminal({ link: true, "link-name": "zc2" });
await waitFor(
  () => zc2.notifications.find((n) => n.message.includes("Joined link")),
  "zc2 join",
);
await waitFor(
  () => zc.notifications.find((n) => n.message.includes('"zc2" joined')),
  "zc sees zc2 join",
);
assert(true, "two zero-config loopback terminals see each other");

// Reach-matrix cast: a/a2 (alpha regulars), b (beta regular), g (global,
// home "ops" — a global's name still needs a residence).
const a = await rawClient({ name: "a", workspace: "alpha", sessionId: "s-a" });
const a2 = await rawClient({ name: "a2", workspace: "alpha", sessionId: "s-a2" });
const g = await rawClient({ name: "g", workspace: "ops", global: true, sessionId: "s-g" });
await delay(200); // let joined fan-out settle
const b = await rawClient({ name: "b", workspace: "beta", sessionId: "s-b" });
await delay(200);

// Welcome echoes both axes + the global badge set.
assert(b.welcome.workspace === "beta", "welcome echoes effective home");
assert(b.welcome.global === false, "welcome echoes effective grant (false)");
assert(g.welcome.global === true, "welcome echoes effective grant (true)");
assert(
  b.welcome.globals.includes("default/hub") && b.welcome.globals.includes("ops/g"),
  `welcome carries the visible global badge set (got ${b.welcome.globals})`,
);

// Welcome snapshots are cut by the reach matrix (qualified addresses).
assert(
  b.welcome.terminals.includes("beta/b") &&
    b.welcome.terminals.includes("default/hub") &&
    b.welcome.terminals.includes("ops/g"),
  `regular sees own workspace + global members (got ${b.welcome.terminals})`,
);
assert(
  !b.welcome.terminals.some((t) => t.startsWith("alpha/")) &&
    !b.welcome.terminals.includes("default/zc"),
  "regular does not see other workspaces' regulars (incl. default regulars)",
);
const g2 = await rawClient({ name: "g2", workspace: "ops", global: true });
assert(
  g2.welcome.terminals.includes("alpha/a") &&
    g2.welcome.terminals.includes("beta/b") &&
    g2.welcome.terminals.includes("default/zc"),
  "global member sees everyone",
);
g2.ws.close();

// Joined fan-out follows the matrix and carries the grant badge.
assert(
  ofType(a, "terminal_joined").some((m) => m.name === "ops/g" && m.global === true) &&
    !ofType(a, "terminal_joined").some((m) => m.name === "beta/b"),
  "joined fan-out: regular sees the global joiner (badged), not the cross-group joiner",
);
assert(
  ofType(g, "terminal_joined").some((m) => m.name === "beta/b"),
  "joined fan-out: global sees every joiner",
);
assert(
  ofType(a, "terminal_joined").every((m) => !m.terminals.includes("beta/b")) &&
    ofType(b, "terminal_joined").every((m) => !m.terminals.includes("alpha/a")),
  "joined terminals arrays are recipient-scoped (no cross-group leaks)",
);

// Reach matrix, direct addressing (all four cases + qualified both ways).
send(a, { type: "chat", from: "alpha/a", to: "alpha/a2", content: "same-ws", triggerTurn: false });
send(a, { type: "chat", from: "alpha/a", to: "ops/g", content: "to-global", triggerTurn: false });
send(g, { type: "chat", from: "ops/g", to: "alpha/a", content: "global-to-any", triggerTurn: false });
send(a, { type: "chat", from: "alpha/a", to: "beta/b", content: "cross-wall", triggerTurn: false });
send(b, { type: "chat", from: "beta/b", to: "alpha/a", content: "cross-wall-back", triggerTurn: false });
await delay(300);
assert(
  ofType(a2, "chat").some((m) => m.content === "same-ws"),
  "matrix: same workspace ✓",
);
assert(
  ofType(g, "chat").some((m) => m.content === "to-global"),
  "matrix: anyone → global member ✓ (qualified)",
);
assert(
  ofType(a, "chat").some((m) => m.content === "global-to-any"),
  "matrix: global member → anyone ✓ (qualified)",
);
assert(
  !ofType(b, "chat").some((m) => m.content === "cross-wall") &&
    !ofType(a, "chat").some((m) => m.content === "cross-wall-back"),
  "matrix: regular cross-workspace ✗ (both directions)",
);

// Existence-hiding: the refusal text is identical in shape whether the
// cross-wall target exists or not.
const errB = ofType(a, "error").find((m) => m.message.includes("beta/b"));
const errGhost = ofType(a, "error").find((m) => m.message.includes("beta/ghost"));
send(a, { type: "chat", from: "alpha/a", to: "beta/ghost", content: "ghost", triggerTurn: false });
await delay(200);
const errB2 = ofType(a, "error").find((m) => m.message.includes('"beta/b"'));
const errGhost2 = ofType(a, "error").find((m) => m.message.includes('"beta/ghost"'));
assert(
  errB2?.message === 'Terminal "beta/b" not found' &&
    errGhost2?.message === 'Terminal "beta/ghost" not found',
  `cross-wall refusals leak no existence information (got "${errB2?.message}" / "${errGhost2?.message}")`,
);

// Bare names resolve in the sender's own workspace only — no scope chain.
// The wire contract is qualified; the hub exact-matches and never falls
// through (a raw bare `to` is simply not found). The client-side resolution
// lives in qualifyTo — drive it through a real terminal's link_send.
send(a, { type: "chat", from: "alpha/a", to: "a2", content: "raw-bare", triggerTurn: false });
await delay(200);
assert(
  !ofType(a2, "chat").some((m) => m.content === "raw-bare") &&
    ofType(a, "error").some((m) => m.message === 'Terminal "a2" not found'),
  "hub exact-matches qualified addresses (no scope-chain fallback on the wire)",
);
{
  const ok = await zc.tools.link_send.execute(
    "t",
    { to: "zc2", message: "bare-same-ws", triggerTurn: false },
    undefined,
  );
  await delay(200);
  assert(
    !ok.details.error &&
      zc2.sentMessages.some((m) => m.content === "bare-same-ws"),
    "bare name resolves in the sender's own workspace (tool level)",
  );
  const miss = await zc.tools.link_send.execute(
    "t",
    { to: "g", message: "bare-global", triggerTurn: false },
    undefined,
  );
  assert(
    miss.details.error === "not_found" &&
      !ofType(g, "chat").some((m) => m.content === "bare-global"),
    "bare name never falls through to globals (no scope chain)",
  );
}

// Broadcast: regular * = own workspace + globals; global * = everyone;
// ws/* = one group (globals may target foreign groups, regulars may not).
send(a, { type: "chat", from: "alpha/a", to: "*", content: "bcast-regular", triggerTurn: false });
await delay(200);
assert(
  ofType(a2, "chat").some((m) => m.content === "bcast-regular") &&
    ofType(g, "chat").some((m) => m.content === "bcast-regular"),
  "regular * reaches own workspace + global members",
);
assert(
  !ofType(b, "chat").some((m) => m.content === "bcast-regular"),
  "regular * does not cross workspaces",
);
send(g, { type: "chat", from: "ops/g", to: "*", content: "bcast-global", triggerTurn: false });
await delay(200);
assert(
  ofType(b, "chat").some((m) => m.content === "bcast-global") &&
    ofType(a, "chat").some((m) => m.content === "bcast-global"),
  "global * reaches everyone",
);
send(g, { type: "chat", from: "ops/g", to: "alpha/*", content: "group-bcast", triggerTurn: false });
await delay(200);
assert(
  ofType(a, "chat").some((m) => m.content === "group-bcast") &&
    ofType(a2, "chat").some((m) => m.content === "group-bcast") &&
    !ofType(b, "chat").some((m) => m.content === "group-bcast"),
  "global ws/* reaches exactly that group",
);
send(a, { type: "chat", from: "alpha/a", to: "beta/*", content: "foreign-group", triggerTurn: false });
await delay(200);
assert(
  !ofType(b, "chat").some((m) => m.content === "foreign-group") &&
    ofType(a, "error").some((m) => m.message === 'Terminal "beta/*" not found'),
  "regular foreign ws/* refused like any cross-workspace send",
);
send(a, { type: "chat", from: "alpha/a", to: "alpha/*", content: "own-group", triggerTurn: false });
await delay(200);
assert(
  ofType(a2, "chat").some((m) => m.content === "own-group"),
  "regular own-group ws/* delivers",
);

// Status fan-out is cut by the reach matrix.
send(a, { type: "status_update", name: "alpha/a", status: { kind: "idle", since: 1 }, budget: null, model: null });
await delay(200);
assert(
  ofType(g, "status_update").some((m) => m.name === "alpha/a"),
  "status_update reaches global members",
);
assert(
  !ofType(b, "status_update").some((m) => m.name === "alpha/a"),
  "status_update does not cross workspaces",
);

// ── Scenario 2: takeover, refusal, hub-identity collision, reserved chars ──

console.log("scenario 2: takeover + nameTaken refusal + reserved characters");

const t1 = await rawClient({ name: "t", workspace: "alpha", sessionId: "sess-t" });
await delay(200);
const membershipBefore = ofType(g, "terminal_left").length + ofType(g, "terminal_joined").length;

// Same (workspace, name), same sessionId → silent takeover.
const t2 = await rawClient({ name: "t", workspace: "alpha", sessionId: "sess-t" });
assert(t2.welcome.name === "t", "takeover keeps the exact name (no suffix)");
await delay(300);
assert(
  t1.ws.readyState === WebSocket.CLOSED || t1.ws.readyState === WebSocket.CLOSING,
  "takeover closes the old socket",
);
assert(
  ofType(g, "terminal_left").length + ofType(g, "terminal_joined").length ===
    membershipBefore,
  "takeover emits no terminal_left/joined churn (the fleet sees nothing)",
);

// Same (workspace, name), different sessionId → loud refusal.
const t3 = await rawClientAny({ name: "t", workspace: "alpha", sessionId: "sess-other" });
assert(
  t3.first.type === "error" && /name taken/i.test(t3.first.message),
  `different sessionId → name-taken refusal (got "${t3.first.message}")`,
);
await delay(200);
assert(
  t3.ws.readyState === WebSocket.CLOSED || t3.ws.readyState === WebSocket.CLOSING,
  "refused register socket is closed",
);

// The hub's own identity can never be taken over through its client port —
// not even with the hub's own sessionId.
const hubClone = await rawClientAny({ name: "hub", workspace: "default", sessionId: "sess-hub" });
assert(
  hubClone.first.type === "error" && /name taken/i.test(hubClone.first.message),
  "hub-identity collision refused (same sessionId)",
);

// Reserved characters rejected at register (defense in depth).
const badName = await rawClientAny({ name: "x/y", workspace: "alpha" });
assert(
  badName.first.type === "error" && /reserved character/i.test(badName.first.message),
  'register with "/" in the name rejected loudly',
);
const badWs = await rawClientAny({ name: "x", workspace: "al*pha" });
assert(
  badWs.first.type === "error" && /reserved character/i.test(badWs.first.message),
  'register with "*" in the workspace rejected loudly',
);
// Malformed v3 register (missing sessionId) rejected loudly.
const malformed = await rawClientAny({ name: "m", workspace: "alpha", sessionId: undefined });
assert(
  malformed.first.type === "error" && /register rejected/i.test(malformed.first.message),
  "v3 register missing sessionId rejected loudly",
);

// ADR-0009: malformed membership selectors fail closed at startup (exit 1)
// — empty segments, more than one ":", more than one "/" in the address,
// reserved characters in name/workspace; flag and env tiers alike.
// process.exit would kill this runner, so these run in children.
const { spawnSync } = await import("node:child_process");
function childStart(flags, env = {}) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      const { default: createLink } = await import(${JSON.stringify(
        new URL("../index.ts", import.meta.url).href,
      )});
      const FLAGS = ${JSON.stringify(flags)};
      const handlers = {};
      const pi = {
        registerFlag: () => {},
        getFlag: (n) => FLAGS[n],
        on: (e, h) => { handlers[e] = h; },
        appendEntry: () => {}, registerTool: () => {}, registerCommand: () => {},
        registerMessageRenderer: () => {}, sendMessage: () => {},
        sendUserMessage: () => {}, getSessionName: () => undefined,
        setSessionName: () => {},
      };
      createLink(pi);
      const ctx = {
        cwd: "/tmp/link-test",
        ui: { notify: () => {}, setStatus: () => {},
              theme: { fg: (_r, t) => t, bold: (t) => t } },
        sessionManager: { getEntries: () => [] },
        isIdle: () => true,
        getContextUsage: () => ({ tokens: 1, contextWindow: 10 }),
      };
      await handlers.session_start({}, ctx);
      console.error("PARSE-OK");
      process.exit(0);
      `,
    ],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );
}
const malformedSelectors = [
  [{ link: true, "link-name": "a*b" }, {}, 'name segment reserved "*"'],
  [{ link: true, "link-name": "alpha/a*b" }, {}, 'name segment reserved "*" (qualified)'],
  [{ link: true, "link-name": "fleet-public:" }, {}, "empty address segment"],
  [{ link: true, "link-name": ":pl/x" }, {}, "empty profile segment"],
  [{ link: true, "link-name": "a:b:c" }, {}, 'more than one ":"'],
  [{ link: true, "link-name": "ws/" }, {}, "empty name segment"],
  [{ link: true, "link-name": "/x" }, {}, "empty workspace segment"],
  [{ link: true, "link-name": "a/b/c" }, {}, 'more than one "/" in the address'],
  [{ link: true }, { PI_LINK_NAME: "a*b/c" }, 'env: workspace segment reserved "*"'],
];
for (const [flags, env, label] of malformedSelectors) {
  const r = childStart(flags, env);
  assert(
    r.status === 1 && r.stderr.includes("Error:") &&
      !r.stderr.includes("PARSE-OK"),
    `malformed selector exits 1 — ${label} (${r.stderr.trim().split("\n")[0]})`,
  );
}
// All four valid forms parse. The child exits right after session_start
// (before the connect timer fires), so PARSE-OK + status 0 proves the parse.
for (const s of [
  "fleet-public:pl/s-k3-a",
  "pl/s-k3-a",
  "fleet-public:s-k3-a",
  "s-k3-a",
]) {
  const r = childStart({ link: true, "link-name": s });
  assert(
    r.status === 0 && r.stderr.includes("PARSE-OK"),
    `valid selector form "${s}" parses`,
  );
}

// Segment-level fallback: the string's workspace segment beats the saved
// session entry (re-persisted); an omitted segment falls through to the
// entry untouched. session_shutdown disposes before the connect timer fires.
{
  const saved = [
    { type: "custom", customType: "link-workspace", data: { workspace: "saved-ws" } },
    { type: "custom", customType: "link-name", data: { name: "saved-name" } },
  ];
  const explicit = await startTerminal(
    { link: true, "link-name": "alpha/t" },
    { entries: saved },
  );
  await explicit.handlers.session_shutdown();
  assert(
    explicit.appended.some(
      (e) => e.customType === "link-workspace" && e.data.workspace === "alpha",
    ),
    "string workspace segment beats the saved entry (re-persisted)",
  );
  const falling = await startTerminal(
    { link: true, "link-name": "t2" },
    { entries: saved },
  );
  await falling.handlers.session_shutdown();
  assert(
    !falling.appended.some((e) => e.customType === "link-workspace"),
    "omitted workspace segment falls through to the saved entry (no re-append)",
  );
}

// nameTaken latch: a real extension client colliding with a live holder is
// refused loudly, does not reconnect-storm, and /link-connect retries.
const dup = await startTerminal(
  { link: true, "link-name": "alpha/t" },
  { sessionId: "sess-dup" },
);
await waitFor(
  () => dup.notifications.find((n) => /name taken/i.test(n.message)),
  "nameTaken refusal notify",
);
assert(true, "same-name different-session → loud nameTaken refusal");
await delay(5_500); // backoff would be 2s + ≤3s jitter
const refusals = dup.notifications.filter((n) => /name taken/i.test(n.message)).length;
assert(refusals === 1, `no reconnect storm after nameTaken (${refusals} refusals)`);
await dup.commands["link-connect"].handler("", dup.ctx);
await waitFor(
  () => dup.notifications.filter((n) => /name taken/i.test(n.message)).length === 2,
  "manual /link-connect retry",
);
assert(true, "/link-connect retries after nameTaken");

// ── Scenario 3: fail-closed handshake against a non-conforming hub ─────────

console.log("scenario 3: non-conforming hub (no identity echo) → membership refused");

const OLD_PORT = 9999;
let oldHubRegisters = 0;
const oldHub = new WebSocketServer({ port: OLD_PORT, host: "127.0.0.1" });
oldHub.on("connection", (sock) => {
  sock.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== "register") return;
    oldHubRegisters++;
    // Speaks v3 but predates the identity echo: welcome without the
    // effective home/grant readback.
    sock.send(
      JSON.stringify({
        type: "welcome",
        name: msg.name,
        terminals: [msg.name],
        version: VERSION,
      }),
    );
  });
});

writeFileSync(
  PROFILES_FILE,
  JSON.stringify({ profiles: { oldhub: { url: `ws://127.0.0.1:${OLD_PORT}` } } }),
);
process.env.PI_LINK_NAME = "oldhub:scoped";
const scoped = await startTerminal({
  link: true,
  "link-name": "alpha/scoped",
});
await waitFor(() => oldHubRegisters === 1, "register on old hub");
await waitFor(
  () =>
    scoped.notifications.find((n) =>
      n.message.includes("echoed a different identity"),
    ),
  "identity refusal notify",
);
assert(true, "missing home/grant echo → loud refusal notify");

// Rejection ≠ hub loss: no reconnect hammer (delay is 2s + up to 3s jitter).
await delay(5_500);
assert(
  oldHubRegisters === 1,
  `no reconnect hammer after refusal (${oldHubRegisters} register attempts)`,
);

// Manual /link-connect resets and retries.
await scoped.commands["link-connect"].handler("", scoped.ctx);
await waitFor(() => oldHubRegisters === 2, "manual reconnect retry");
assert(true, "/link-connect retries after refusal");
await scoped.handlers.session_shutdown();

// The grant axis is checked too: a conforming home echo with a mismatched
// grant echo is refused the same way.
let grantRegisters = 0;
const grantHub = new WebSocketServer({ port: 9997, host: "127.0.0.1" });
grantHub.on("connection", (sock) => {
  sock.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== "register") return;
    grantRegisters++;
    sock.send(
      JSON.stringify({
        type: "welcome",
        name: msg.name,
        terminals: [msg.name],
        version: VERSION,
        workspace: msg.workspace, // home honored…
        global: false, // …grant not
        globals: [],
      }),
    );
  });
});
writeFileSync(
  PROFILES_FILE,
  JSON.stringify({ profiles: { oldhub: { url: `ws://127.0.0.1:9997` } } }),
);
const grantful = await startTerminal({
  link: true,
  "link-name": "oldhub:grantful", // flag profile segment (env was consumed by scoped)
  "link-global": true,
});
await waitFor(() => grantRegisters === 1, "register on grant-mismatch hub");
await waitFor(
  () =>
    grantful.notifications.find((n) =>
      n.message.includes("echoed a different identity"),
    ),
  "grant-mismatch refusal notify",
);
assert(true, "mismatched grant echo → loud refusal (both axes checked)");
await grantful.handlers.session_shutdown();
delete process.env.PI_LINK_NAME;
oldHub.close();
grantHub.close();

// ── Scenario 4: hub death → scoped survivor promotes and routes all groups ──

console.log("scenario 4: promotion ignores workspace");

// Retire the other REAL clients first — unlike raw sockets they reconnect
// after hub death and would race the survivor for the bind.
await zc.handlers.session_shutdown();
await zc2.handlers.session_shutdown();
await dup.handlers.session_shutdown();
await delay(200);

const survivor = await startTerminal({
  link: true,
  "link-name": "alpha/s",
});
await waitFor(
  () => survivor.notifications.find((n) => n.message.includes("Joined link")),
  "survivor join",
);

// Kill the hub; the scoped survivor must promote and rebuild filtering.
await hub.handlers.session_shutdown();
await waitFor(
  () =>
    survivor.notifications.find((n) => n.message.includes("Link hub started")),
  "survivor promotion",
  15_000,
);
assert(true, "scoped survivor promoted to hub");

const r3 = await rawClient({ name: "r3", global: true });
const r1 = await rawClient({ name: "r1", workspace: "beta" });
const r2 = await rawClient({ name: "r2", workspace: "alpha" });
const r4 = await rawClient({ name: "r4", global: true });
await delay(200);

assert(
  !r1.welcome.terminals.includes("alpha/s"),
  `promoted hub serves groups it does not belong to (beta welcome: ${r1.welcome.terminals})`,
);
assert(
  r1.welcome.terminals.includes("default/r3"),
  "beta client sees the global member",
);
assert(
  ofType(r1, "terminal_joined").some((m) => m.name === "default/r4") &&
    !ofType(r1, "terminal_joined").some((m) => m.name === "alpha/r2"),
  "beta client sees the global join, not the alpha join",
);
assert(
  r2.welcome.terminals.includes("alpha/s") && !r2.welcome.terminals.includes("beta/r1"),
  "promoted hub's own group (alpha) sees the hub, not beta",
);
assert(
  r4.welcome.terminals.includes("beta/r1") &&
    r4.welcome.terminals.includes("alpha/r2") &&
    r4.welcome.terminals.includes("alpha/s"),
  "global member sees everyone after promotion",
);

send(r1, { type: "chat", from: "beta/r1", to: "default/r3", content: "beta→global", triggerTurn: false });
send(r1, { type: "chat", from: "beta/r1", to: "alpha/r2", content: "beta→alpha", triggerTurn: false });
await delay(200);
assert(
  ofType(r3, "chat").some((m) => m.content === "beta→global"),
  "promoted hub routes within a foreign group's visible set",
);
assert(
  ofType(r1, "error").some((m) => m.message === 'Terminal "alpha/r2" not found'),
  "promoted hub still rejects cross-group addressing (existence-hiding)",
);

// The promoted (scoped) hub's own /link shows only its visible set.
survivor.notifications.length = 0;
await survivor.commands.link.handler("", survivor.ctx);
const sList = survivor.notifications[0]?.message ?? "";
assert(
  sList.includes("r2") && sList.includes("default/r3") && !sList.includes("r1"),
  "scoped promoted hub /link is cut to its visible set",
);

// ── Teardown ────────────────────────────────────────────────────────────────

for (const c of [a, a2, b, g, t2, r1, r2, r3, r4]) c.ws.close();
await survivor.handlers.session_shutdown();

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
