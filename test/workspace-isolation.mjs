// ADR-0004 workspace isolation — integration smoke test.
// Boots the real extension (mocked Pi host) as hub, drives raw WebSocket
// clients against it, and asserts the issue #11 acceptance checklist:
// visible sets, fail-closed handshake, cross-group name dedupe, promotion.
// Raw clients speak protocol v2 (ADR-0005 gate) — VERSION below.
//
// Requires node_modules to resolve "ws" (npm install) plus the pi host
// packages (typebox, @earendil-works/pi-tui) — index.ts imports them.
// Run: node test/workspace-isolation.mjs

process.env.PI_LINK_PORT ||= "19901"; // isolated test fleet port (before import)

import { WebSocket, WebSocketServer } from "ws";
import { setTimeout as delay } from "node:timers/promises";
const { default: createLink } = await import("../index.ts");

const PORT = 19901;
const VERSION = 2; // LINK_PROTOCOL_VERSION in index.ts
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

function makeHost(flags) {
  const handlers = {};
  const commands = {};
  const notifications = [];
  const pi = {
    registerFlag: () => {},
    getFlag: (name) => flags[name],
    on: (event, handler) => {
      handlers[event] = handler;
    },
    appendEntry: () => {},
    registerTool: () => {},
    registerCommand: (name, def) => {
      commands[name] = def;
    },
    registerMessageRenderer: () => {},
    sendMessage: () => {},
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
    sessionManager: { getEntries: () => [] },
    isIdle: () => true,
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000 }),
  };
  return { pi, ctx, handlers, commands, notifications };
}

async function startTerminal(flags) {
  const host = makeHost(flags);
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
        JSON.stringify({ type: "register", version: VERSION, ...register }),
      ),
    );
    ws.on("error", reject);
  });
}

const send = (client, msg) => client.ws.send(JSON.stringify(msg));
const ofType = (client, type) => client.received.filter((m) => m.type === type);

// ── Scenario 1: visible sets, addressing, broadcast, status fan-out, dedupe ─

console.log("scenario 1: hub + scoped/global raw clients");

const hub = await startTerminal({ link: true, "link-name": "hub" });
await waitFor(
  () => hub.notifications.find((n) => n.message.includes("Link hub started")),
  "hub start",
);

const a = await rawClient({ name: "a", workspace: "alpha" });
const g = await rawClient({ name: "g" }); // global observer
await delay(200); // let joined fan-out settle
const b = await rawClient({ name: "b", workspace: "beta" });
await delay(200);

assert(
  a.welcome.workspace === "alpha",
  "scoped client welcome echoes workspace",
);
assert(
  !("workspace" in g.welcome),
  "global observer welcome has no workspace field (pre-ADR-0004 wire shape)",
);
assert(
  a.welcome.terminals.join(",") === ["a", "hub"].sort().join(","),
  `scoped welcome snapshot = own group + global observers online at join time (got ${a.welcome.terminals})`,
);
assert(
  g.welcome.terminals.includes("a") && g.welcome.terminals.includes("hub"),
  "global observer sees everyone",
);
assert(
  !a.welcome.terminals.includes("b"),
  "welcome snapshot hides other workspace",
);
assert(
  b.welcome.terminals.join(",") === ["b", "g", "hub"].sort().join(","),
  "second workspace sees itself + global observers only",
);
assert(
  ofType(a, "terminal_joined").some((m) => m.name === "g") &&
    !ofType(a, "terminal_joined").some((m) => m.name === "b"),
  "joined fan-out: scoped client sees global joiner, not cross-group joiner",
);
assert(
  ofType(g, "terminal_joined").some((m) => m.name === "b"),
  "joined fan-out: global observer sees every joiner",
);
assert(
  ofType(a, "terminal_joined").every(
    (m) => !m.terminals.includes("b") || m.name === "b",
  ) && ofType(b, "terminal_joined").every((m) => !m.terminals.includes("a")),
  "joined terminals arrays are recipient-scoped (no cross-group name leaks)",
);

// Direct addressing: cross-group = not_found; to global observer = delivered.
send(a, { type: "chat", from: "a", to: "b", content: "x", triggerTurn: false });
send(a, { type: "chat", from: "a", to: "g", content: "hi g", triggerTurn: false });
send(b, { type: "chat", from: "b", to: "hub", content: "hi hub", triggerTurn: false });
await delay(200);
assert(
  ofType(a, "error").some((m) => /not found/i.test(m.message)),
  "cross-group direct addressing → not_found error to sender",
);
assert(
  ofType(g, "chat").some((m) => m.content === "hi g"),
  "scoped → global observer direct message delivered",
);
assert(
  ofType(b, "error").length === 0,
  "scoped → hub (global observer) direct message not rejected",
);

// Broadcast: from scoped reaches own group + global observers only.
send(a, { type: "chat", from: "a", to: "*", content: "bcast", triggerTurn: false });
await delay(200);
assert(
  ofType(g, "chat").some((m) => m.content === "bcast"),
  "scoped broadcast reaches global observer",
);
assert(
  !ofType(b, "chat").some((m) => m.content === "bcast"),
  "scoped broadcast does not cross workspaces",
);

// Status fan-out is cut by the visible set.
send(a, { type: "status_update", name: "a", status: { kind: "idle", since: 1 } });
await delay(200);
assert(
  ofType(g, "status_update").some((m) => m.name === "a"),
  "status_update reaches global observer",
);
assert(
  !ofType(b, "status_update").some((m) => m.name === "a"),
  "status_update does not cross workspaces",
);

// Name uniqueness stays global across groups.
const a2 = await rawClient({ name: "a", workspace: "beta" });
assert(
  a2.welcome.name === "a-2",
  `cross-group name collision dedupes globally (got ${a2.welcome.name})`,
);
a2.ws.close();

// /link on the hub (global observer) lists everyone.
hub.notifications.length = 0;
await hub.commands.link.handler("", hub.ctx);
const hubList = hub.notifications[0]?.message ?? "";
assert(
  hubList.includes("a") && hubList.includes("b") && hubList.includes("g"),
  "hub (global observer) /link lists all groups",
);

// ── Scenario 2: fail-closed handshake against an old hub ────────────────────

console.log("scenario 2: old hub (no workspace echo) → client refuses membership");

const OLD_PORT = 9999;
let oldHubRegisters = 0;
const oldHub = new WebSocketServer({ port: OLD_PORT, host: "127.0.0.1" });
oldHub.on("connection", (sock) => {
  sock.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== "register") return;
    oldHubRegisters++;
    // Pre-ADR-0004 hub: speaks the current protocol version but predates
    // workspaces — welcome without a workspace echo.
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

process.env.PI_LINK_URL = `ws://127.0.0.1:${OLD_PORT}`;
const scoped = await startTerminal({
  link: true,
  "link-name": "scoped",
  "link-workspace": "alpha",
});
// initialize is deferred (setTimeout 0), so keep the env until the register
// has actually landed on the old hub.
await waitFor(() => oldHubRegisters === 1, "register on old hub");

await waitFor(
  () =>
    scoped.notifications.find((n) =>
      n.message.includes('did not honor workspace "alpha"'),
    ),
  "workspace refusal notify",
);
assert(true, "missing echo → loud refusal notify");

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
delete process.env.PI_LINK_URL;
await scoped.handlers.session_shutdown();

oldHub.close();

// ── Scenario 3: hub death → scoped survivor promotes and routes all groups ──

console.log("scenario 3: promotion ignores workspace");

const survivor = await startTerminal({
  link: true,
  "link-name": "s",
  "link-workspace": "alpha",
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

const r1 = await rawClient({ name: "r1", workspace: "beta" });
const r2 = await rawClient({ name: "r2", workspace: "alpha" });
const r3 = await rawClient({ name: "r3" });
await delay(200);

assert(
  !r1.welcome.terminals.includes("s") && !r1.welcome.terminals.includes("r2"),
  `promoted hub serves groups it does not belong to (beta welcome: ${r1.welcome.terminals})`,
);
assert(
  ofType(r1, "terminal_joined").some((m) => m.name === "r3") &&
    !ofType(r1, "terminal_joined").some((m) => m.name === "r2"),
  "beta client sees the global observer join, not the alpha join",
);
assert(
  r2.welcome.terminals.includes("s") && !r2.welcome.terminals.includes("r1"),
  "promoted hub's own group (alpha) sees hub, not beta",
);
assert(
  r3.welcome.terminals.includes("r1") &&
    r3.welcome.terminals.includes("r2") &&
    r3.welcome.terminals.includes("s"),
  "global observer sees everyone after promotion",
);

send(r1, { type: "chat", from: "r1", to: "r3", content: "beta→global", triggerTurn: false });
send(r1, { type: "chat", from: "r1", to: "r2", content: "beta→alpha", triggerTurn: false });
await delay(200);
assert(
  ofType(r3, "chat").some((m) => m.content === "beta→global"),
  "promoted hub routes within a foreign group's visible set",
);
assert(
  ofType(r1, "error").some((m) => /not found/i.test(m.message)),
  "promoted hub still rejects cross-group addressing",
);

// The promoted (scoped) hub's own /link shows only its visible set.
survivor.notifications.length = 0;
await survivor.commands.link.handler("", survivor.ctx);
const sList = survivor.notifications[0]?.message ?? "";
assert(
  sList.includes("r2") && sList.includes("r3") && !sList.includes("r1"),
  "scoped promoted hub /link is cut to its visible set",
);

// ── Teardown ────────────────────────────────────────────────────────────────

for (const c of [a, b, g, r1, r2, r3]) c.ws.close();
await survivor.handlers.session_shutdown();

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
