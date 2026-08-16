// ADR-0007 config-first dial resolution — integration test.
// Real extension instances (mocked Pi hosts) + fake recording hubs cover the
// issue #15 acceptance checklist: default profile dials its url+token,
// PI_LINK_PROFILE selection, unknown-profile fail-closed (no dial / no
// promotion / no reconnect; /link-connect retries), url-omitted loopback
// profile with token (hub-machine doctrine), PI_LINK_URL ignored, remote
// fleet member never self-promotes, and the #7 hubConfigFailed latch.
//
// Run: node test/config-first-dial.mjs

process.env.PI_LINK_PORT ||= "19903"; // isolated test fleet port (before import)

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { setTimeout as delay } from "node:timers/promises";

// #15 item 8: profiles-file path knob (read at module load — set before import).
const PROFILES_FILE = join(
  mkdtempSync(join(tmpdir(), "pi-link-cfg-test-")),
  "pi-link.json",
);
process.env.PI_LINK_PROFILES_FILE = PROFILES_FILE;

const { default: createLink } = await import("../index.ts");

const PORT = 19903;
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

// Fake hub: records registers, answers a well-formed v2 welcome.
function fakeHub(port) {
  const registers = [];
  const server = new WebSocketServer({ port, host: "127.0.0.1" });
  server.on("connection", (sock) => {
    sock.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== "register") return;
      registers.push(msg);
      sock.send(
        JSON.stringify({
          type: "welcome",
          name: msg.name,
          terminals: [msg.name],
          version: VERSION,
          budgets: {},
          models: {},
          idleSince: {},
          ...(msg.workspace ? { workspace: msg.workspace } : {}),
        }),
      );
    });
  });
  return { registers, server };
}

function rawClient(register, port = PORT) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
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

// True when nothing accepts on the port (i.e. no hub was promoted).
function dialFails(port) {
  return new Promise((resolve) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`);
    s.on("error", () => resolve(true));
    s.on("open", () => {
      s.close();
      resolve(false);
    });
  });
}

// ── Scenario 1: unknown PI_LINK_PROFILE fails closed ────────────────────────

console.log("scenario 1: unknown PI_LINK_PROFILE → fail closed; /link-connect retries");

// No profiles file exists yet, so the selected name cannot resolve.
process.env.PI_LINK_PROFILE = "fleet";
const t1 = await startTerminal({ link: true, "link-name": "t1" });
await waitFor(
  () =>
    t1.notifications.find(
      (n) => n.message.includes('"fleet"') && n.message.includes("not resolve"),
    ),
  "fail-closed refusal notify",
);
assert(true, "unknown profile → loud refusal notify");

// No dial, no promotion, no auto-reconnect (backoff would be 2s + ≤3s jitter).
await delay(5_500);
const refusals = t1.notifications.filter((n) =>
  n.message.includes("not resolve"),
).length;
assert(refusals === 1, `refusal fires once, no reconnect (${refusals} notifies)`);
assert(await dialFails(PORT), "no hub promoted on the loopback port");
assert(
  !t1.notifications.some(
    (n) =>
      n.message.includes("Link hub started") ||
      n.message.includes("Joined link"),
  ),
  "no dial, no promotion",
);

// Fix the config; /link-connect retries and dials the profile's url + token.
const f1 = fakeHub(19913);
writeFileSync(
  PROFILES_FILE,
  JSON.stringify({
    profiles: { fleet: { url: "ws://127.0.0.1:19913", token: "tok-fleet" } },
  }),
);
await t1.commands["link-connect"].handler("", t1.ctx);
await waitFor(() => f1.registers.length === 1, "register on the profile url");
assert(
  f1.registers[0].token === "tok-fleet",
  "PI_LINK_PROFILE dials the profile's url with its token",
);
await waitFor(
  () => t1.notifications.find((n) => n.message.includes("Joined link")),
  "joined after fix",
);
assert(true, "/link-connect retries after the config is fixed");
await t1.handlers.session_shutdown();
delete process.env.PI_LINK_PROFILE;

// ── Scenario 2: default profile is the dial target ──────────────────────────

console.log("scenario 2: default profile dials default.url with its token");

const f2 = fakeHub(19914);
writeFileSync(
  PROFILES_FILE,
  JSON.stringify({
    profiles: { fleet: { url: "ws://127.0.0.1:19914", token: "tok-default" } },
    default: "fleet",
  }),
);
const t2 = await startTerminal({ link: true, "link-name": "t2" });
await waitFor(() => f2.registers.length === 1, "register on default.url");
assert(
  f2.registers[0].token === "tok-default",
  "no env: default profile's url dialed with its token",
);
await t2.handlers.session_shutdown();

// ── Scenario 3: PI_LINK_URL is dead; zero-config loopback unchanged ─────────

console.log("scenario 3: PI_LINK_URL ignored; no profiles file → loopback hub");

rmSync(PROFILES_FILE, { force: true }); // no profiles file
process.env.PI_LINK_URL = "ws://127.0.0.1:19914"; // f2 would record any dial
const f2Before = f2.registers.length;
const t3 = await startTerminal({ link: true, "link-name": "t3" });
await waitFor(
  () => t3.notifications.find((n) => n.message.includes("Link hub started")),
  "loopback promotion with no profiles file",
);
assert(
  f2.registers.length === f2Before,
  "PI_LINK_URL not read (no dial to its target)",
);
assert(
  t3.notifications.some((n) => n.message.includes(`127.0.0.1:${PORT}`)) &&
    !t3.notifications.some((n) => n.message.includes("auth: token required")),
  "no profiles file → loopback unauthenticated hub (zero-config unchanged)",
);
delete process.env.PI_LINK_URL;
await t3.handlers.session_shutdown();

// ── Scenario 4: url-omitted profile → loopback + token (hub-machine doctrine) ─

console.log("scenario 4: url-omitted profile dials loopback carrying its token");

writeFileSync(
  PROFILES_FILE,
  JSON.stringify({
    profiles: { local: { token: "fleet-secret" } },
    default: "local",
  }),
);
const t4 = await startTerminal({ link: true, "link-name": "hubm" });
await waitFor(
  () =>
    t4.notifications.find(
      (n) =>
        n.message.includes("Link hub started") &&
        n.message.includes("auth: token required"),
    ),
  "loopback promotion with token auth",
);
assert(true, "url omitted → loopback dial; promoted hub requires the profile token");

const bad = await new Promise((resolve) => {
  const s = new WebSocket(`ws://127.0.0.1:${PORT}`);
  s.on("message", (raw) => resolve(JSON.parse(raw.toString())));
  s.on("open", () =>
    s.send(JSON.stringify({ type: "register", name: "bad", version: VERSION })),
  );
});
assert(
  bad.type === "error" && /auth rejected/i.test(bad.message),
  "tokenless register rejected by the doctrine hub",
);
const good = await rawClient({ name: "good", token: "fleet-secret" });
assert(good.welcome.name === "good", "register with the profile token welcomed");
good.ws.close();
await t4.handlers.session_shutdown();

// ── Scenario 5: remote fleet member never self-promotes ─────────────────────

console.log("scenario 5: remote member, hub down → backoff only, no promotion");

// 127.0.0.2 is deliberately non-loopback by policy (testable without a real
// external interface); nothing listens there.
writeFileSync(
  PROFILES_FILE,
  JSON.stringify({
    profiles: { remote: { url: "ws://127.0.0.2:19999", token: "t" } },
    default: "remote",
  }),
);
const t5 = await startTerminal({ link: true, "link-name": "member" });
await delay(6_000); // > one full reconnect backoff cycle (2s + ≤3s jitter)
assert(
  !t5.notifications.some((n) => n.message.includes("Link hub started")),
  "remote-member terminal never self-promotes while its hub is down",
);
assert(await dialFails(PORT), "no hub bound on the loopback port either");
assert(
  !t5.notifications.some(
    (n) =>
      n.message.includes("not resolve") ||
      n.message.includes("Refusing to start hub") ||
      n.message.includes("auto-reconnect stopped"),
  ),
  "hub loss stays in the reconnect-backoff family (no refusal latch fired)",
);
await t5.handlers.session_shutdown();

// ── Scenario 6: misconfigured hub bind fails once (#7 item 1) ────────────────

console.log("scenario 6: non-loopback bind without token → one refusal, no storm");

rmSync(PROFILES_FILE, { force: true }); // no token resolvable
process.env.PI_LINK_HOST = "127.0.0.2"; // non-loopback by policy
const t6 = await startTerminal({ link: true, "link-name": "mishub" });
await waitFor(
  () => t6.notifications.find((n) => n.message.includes("Refusing to start hub")),
  "fail-closed bind refusal",
);
await delay(5_500);
const storms = t6.notifications.filter((n) =>
  n.message.includes("Refusing to start hub"),
).length;
assert(storms === 1, `refusal fires once, not every 2–5s (${storms} refusals)`);
await t6.commands["link-connect"].handler("", t6.ctx);
await waitFor(
  () =>
    t6.notifications.filter((n) => n.message.includes("Refusing to start hub"))
      .length === 2,
  "manual retry re-attempts the bind",
);
assert(true, "/link-connect retries after hubConfigFailed");
delete process.env.PI_LINK_HOST;
await t6.handlers.session_shutdown();

// ── Teardown ────────────────────────────────────────────────────────────────

f1.server.close();
f2.server.close();

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
