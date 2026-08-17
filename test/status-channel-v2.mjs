// ADR-0005/0006 status channel v2 — integration test.
// Real extension instances (mocked Pi hosts) + raw WebSocket clients cover
// the issue #13 acceptance checklist: protocol version gate (both
// directions), one budget axis (default/declared/per-dispatch), blunt
// sender-side reminders, link_budget, model label, idle-since, link_new,
// and the hub normalization whitelist.
//
// Run: node test/status-channel-v2.mjs

process.env.PI_LINK_PORT ||= "19902"; // isolated test fleet port (before import)

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { setTimeout as delay } from "node:timers/promises";

// #15 item 8: profiles-file path knob (before import). Scenario 2 redirects
// a client to the pre-gate hub via a profile + PI_LINK_PROFILE (PI_LINK_URL
// is retired). No `default` key, so every other terminal resolves loopback.
const PROFILES_FILE = join(
  mkdtempSync(join(tmpdir(), "pi-link-v2-test-")),
  "pi-link.json",
);
process.env.PI_LINK_PROFILES_FILE = PROFILES_FILE;

const { default: createLink } = await import("../index.ts");

const PORT = 19902;
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

function makeHost(flags, opts = {}) {
  const handlers = {};
  const tools = {};
  const commands = {};
  const notifications = [];
  const appended = [];
  const sentMessages = []; // pi.sendMessage payloads (inbound chat content)
  const calls = []; // ordering probe: "ack" via wire, "newSession" via cmd ctx
  const usage = { tokens: 100, contextWindow: 256_000 };
  const cmdCtx = {
    ui: null, // wired below
    newSession: async (options) => {
      calls.push("newSession");
      opts.onNewSession?.(options);
      return { cancelled: false };
    },
  };
  const ui = {
    notify: (message, level) => notifications.push({ message, level }),
    setStatus: () => {},
    theme: { fg: (_role, text) => text, bold: (text) => text },
  };
  cmdCtx.ui = ui;
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
    // Simulate pi's extension-command interception: sendUserMessage with
    // expandPromptTemplates:true and a "/cmd" text runs the command handler
    // with a command ctx (which alone carries newSession).
    sendUserMessage: (text, options) => {
      if (
        options?.expandPromptTemplates &&
        typeof text === "string" &&
        text.startsWith("/")
      ) {
        const sp = text.indexOf(" ");
        const name = sp === -1 ? text.slice(1) : text.slice(1, sp);
        const cmd = commands[name];
        if (cmd) return cmd.handler(sp === -1 ? "" : text.slice(sp + 1), cmdCtx);
      }
    },
    getSessionName: () => undefined,
    setSessionName: () => {},
  };
  const ctx = {
    cwd: "/tmp/link-test",
    ui,
    sessionManager: {
      getEntries: () => opts.entries ?? [],
      getSessionId: () => opts.sessionId ?? "sess-1",
    },
    isIdle: () => true,
    getContextUsage: () => usage,
    model: opts.model,
    thinkingLevel: opts.thinkingLevel,
  };
  return {
    pi,
    ctx,
    handlers,
    tools,
    commands,
    notifications,
    appended,
    sentMessages,
    calls,
    usage,
  };
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
        JSON.stringify({
          type: "register",
          version: VERSION,
          workspace: "default",
          global: false,
          sessionId: `raw-${Math.random().toString(36).slice(2, 10)}`,
          ...register,
        }),
      ),
    );
    ws.on("error", reject);
  });
}

const send = (client, msg) => client.ws.send(JSON.stringify(msg));
const ofType = (client, type) => client.received.filter((m) => m.type === type);
const toolText = (result) => result.content[0].text;

// ── Scenario 1: version gate, hub side ──────────────────────────────────────

console.log("scenario 1: version gate");

const hub = await startTerminal(
  { link: true, "link-name": "hub", "link-global": true },
  { model: { provider: "anthropic", id: "claude-opus-4" }, thinkingLevel: "high" },
);
await waitFor(
  () => hub.notifications.find((n) => n.message.includes("Link hub started")),
  "hub start",
);

// Register without a version → error + close.
{
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const got = await new Promise((resolve) => {
    ws.on("message", (raw) => resolve(JSON.parse(raw.toString())));
    ws.on("open", () =>
      ws.send(JSON.stringify({ type: "register", name: "no-version" })),
    );
  });
  assert(
    got.type === "error" && /protocol version rejected/i.test(got.message),
    "hub rejects register without a protocol version",
  );
  await delay(200);
  assert(ws.readyState === WebSocket.CLOSED, "hub closes the gated socket");
}

// Register with the previous version → error + close (ADR-0008: one wave).
{
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const got = await new Promise((resolve) => {
    ws.on("message", (raw) => resolve(JSON.parse(raw.toString())));
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "register",
          name: "v2-client",
          version: 2,
          workspace: "default",
          global: false,
          sessionId: "raw-v2",
        }),
      ),
    );
  });
  assert(
    got.type === "error" && /protocol version rejected/i.test(got.message),
    "hub refuses a v2 register loudly (fleet upgrades together)",
  );
  await delay(200);
  assert(ws.readyState === WebSocket.CLOSED, "hub closes the v2 socket");
}

// ── Scenario 2: version gate, client side (old hub without echo) ────────────

const GATE_PORT = 9998;
let gateRegisters = 0;
const gateHub = new WebSocketServer({ port: GATE_PORT, host: "127.0.0.1" });
gateHub.on("connection", (sock) => {
  sock.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== "register") return;
    gateRegisters++;
    // Pre-gate hub: welcome without a version echo.
    sock.send(
      JSON.stringify({ type: "welcome", name: msg.name, terminals: [msg.name] }),
    );
  });
});

writeFileSync(
  PROFILES_FILE,
  JSON.stringify({ profiles: { gatehub: { url: `ws://127.0.0.1:${GATE_PORT}` } } }),
);
process.env.PI_LINK_PROFILE = "gatehub";
const gated = await startTerminal({ link: true, "link-name": "gated" });
await waitFor(() => gateRegisters === 1, "register on pre-gate hub");
await waitFor(
  () =>
    gated.notifications.find((n) =>
      n.message.includes("protocol version mismatch"),
    ),
  "version refusal notify",
);
assert(true, "missing version echo → loud refusal notify");
await delay(5_500);
assert(
  gateRegisters === 1,
  `no reconnect hammer after version refusal (${gateRegisters} attempts)`,
);
await gated.commands["link-connect"].handler("", gated.ctx);
await waitFor(() => gateRegisters === 2, "manual retry after refusal");
assert(true, "/link-connect retries after version refusal");
delete process.env.PI_LINK_PROFILE;
await gated.handlers.session_shutdown();
gateHub.close();

// ── Scenario 3: budget axis, reminders, link_budget, model, idle, link_new ──

console.log("scenario 3: status channel v2 surfaces");

// Scoped worker (alpha) running the real extension.
const worker = await startTerminal(
  { link: true, "link-name": "w", "link-workspace": "alpha" },
  {
    model: { provider: "openai", id: "gpt-5" },
    thinkingLevel: "high",
    sessionId: "sess-old-123",
    onNewSession: (options) => {
      // ADR-0006 §2: run the pre-write against a fake new-session manager
      // and capture what identity the new instance would inherit.
      worker.newSessionEntries = [];
      options.setup({
        appendCustomEntry: (customType, data) =>
          worker.newSessionEntries.push({ customType, data }),
      });
    },
  },
);
await waitFor(
  () => worker.notifications.find((n) => n.message.includes("Joined link")),
  "worker join",
);
const g = await rawClient({ name: "g", global: true }); // global grant
const r = await rawClient({ name: "r", workspace: "beta" }); // other group
await delay(300);

// Model label rides register → visible in the hub's link_list.
{
  const res = await hub.tools.link_list.execute("t", {}, undefined);
  assert(
    res.details.models?.["alpha/w"] === "openai/gpt-5:high",
    `model label in link_list (got ${res.details.models?.["alpha/w"]})`,
  );
  assert(
    res.details.models?.["default/hub"] === "anthropic/claude-opus-4:high",
    "hub's own model label listed",
  );
}

// Mid-session thinking-level change propagates via status_update.
worker.ctx.thinkingLevel = "max";
await worker.handlers.thinking_level_select({}, worker.ctx);
await delay(300);
{
  const res = await hub.tools.link_list.execute("t", {}, undefined);
  assert(
    res.details.models?.["alpha/w"] === "openai/gpt-5:max",
    "thinking_level_select re-push updates the peer label",
  );
}

// Budget default fires exactly where the retired hot threshold fired:
// tokens ≥ window − 100K (window 256000 → boundary 156000).
worker.usage.tokens = 155_999;
await worker.handlers.session_compact({}, worker.ctx); // force push
await delay(300);
{
  const res = await hub.tools.link_send.execute(
    "t",
    { to: "alpha/w", message: "m1", triggerTurn: false },
    undefined,
  );
  assert(
    !toolText(res).includes("over budget"),
    `default budget: 155999/256000 not over (got "${toolText(res)}")`,
  );
}
worker.usage.tokens = 156_000;
await worker.handlers.session_compact({}, worker.ctx);
await delay(300);
{
  const res = await hub.tools.link_send.execute(
    "t",
    { to: "alpha/w", message: "m2", triggerTurn: false },
    undefined,
  );
  const text = toolText(res);
  assert(
    text.includes(
      '⚠ "alpha/w" over budget: 156K/156K — decide whether to link_compact (or link_new)',
    ),
    `default budget fires at window−100K with blunt wording (got "${text}")`,
  );
  assert(!text.includes("hot"), "no hot wording remains");
}

// Receiver's context is provably untouched (sender-side reminders only).
await delay(300);
assert(
  worker.sentMessages.length > 0 &&
    worker.sentMessages.every((m) => m.content === "m1" || m.content === "m2"),
  "inbound chat content carries no budget annotation",
);

// link_budget set: hub → worker. Ack ✓, entry persisted, immediate status.
{
  const res = await hub.tools.link_budget.execute(
    "t",
    { to: "alpha/w", budget: 56_000 },
    undefined,
  );
  assert(
    toolText(res).includes('Budget on "alpha/w" set to 56K') && !res.details.error,
    `link_budget set acks ✓ (got "${toolText(res)}")`,
  );
  assert(
    worker.appended.some(
      (e) => e.customType === "link-budget" && e.data.budget === 56_000,
    ),
    "target persists the link-budget session entry",
  );
  await delay(300);
  const list = await hub.tools.link_list.execute("t", {}, undefined);
  assert(
    list.details.overBudget?.includes("alpha/w"),
    "link_list marker: worker over declared 56K at 156K tokens",
  );
}

// Declared 56K fires at ≥56K; per-dispatch override replaces it for one
// exchange; mismatch notice shows both values.
worker.usage.tokens = 61_000;
await worker.handlers.session_compact({}, worker.ctx);
await delay(300);
{
  const over = await hub.tools.link_send.execute(
    "t",
    { to: "alpha/w", message: "m3", triggerTurn: false },
    undefined,
  );
  assert(
    toolText(over).includes('⚠ "alpha/w" over budget: 61K/56K'),
    `declared 56K fires at 61K (got "${toolText(over)}")`,
  );
  const overrideUnder = await hub.tools.link_send.execute(
    "t",
    { to: "alpha/w", message: "m4", triggerTurn: false, budget: 70_000 },
    undefined,
  );
  const text = toolText(overrideUnder);
  assert(
    !text.includes("over budget") &&
      text.includes("budget mismatch: dispatch 70K vs \"alpha/w\" declared 56K"),
    `per-dispatch 70K overrides for one exchange + mismatch notice (got "${text}")`,
  );
  const after = await hub.tools.link_send.execute(
    "t",
    { to: "alpha/w", message: "m5", triggerTurn: false },
    undefined,
  );
  assert(
    toolText(after).includes("over budget: 61K/56K"),
    "declared budget unmutated after the override exchange",
  );
}

// link_prompt round-trip: pre-dispatch reminder leads the result; the
// response readout carries the verdict (with override semantics).
{
  const promptPromise = hub.tools.link_prompt.execute(
    "t",
    { to: "alpha/w", prompt: "ping" },
    undefined,
  );
  await delay(300); // let the request land on the worker
  await worker.handlers.agent_end(
    { messages: [{ role: "assistant", content: [{ type: "text", text: "pong" }] }] },
    worker.ctx,
  );
  const res = await promptPromise;
  const text = toolText(res);
  assert(
    text.startsWith('⚠ "alpha/w" over budget: 61K/56K') &&
      text.includes("pong") &&
      /\[61K\/256K \(24%\) · ⚠ "alpha\/w" over budget: 61K\/56K/.test(text),
    `link_prompt: pre-dispatch line + response readout verdict (got "${text}")`,
  );
}

// link_budget "off" clears back to default.
{
  const res = await hub.tools.link_budget.execute(
    "t",
    { to: "alpha/w", budget: "off" },
    undefined,
  );
  assert(
    !res.details.error && toolText(res).includes("default"),
    `link_budget off acks ✓ (got "${toolText(res)}")`,
  );
  assert(
    worker.appended.some(
      (e) => e.customType === "link-budget" && e.data.budget === null,
    ),
    "off persists null (clears to default)",
  );
  await delay(300);
  const list = await hub.tools.link_list.execute("t", {}, undefined);
  assert(
    !list.details.overBudget?.includes("alpha/w"),
    "61K tokens under default 156K after off",
  );
}

// not_found + cross-workspace addressing.
{
  const ghost = await hub.tools.link_budget.execute(
    "t",
    { to: "ghost", budget: 1000 },
    undefined,
  );
  assert(ghost.details.error === "not_found", "link_budget → not_found");
  const cross = await worker.tools.link_budget.execute(
    "t",
    { to: "beta/r", budget: 1000 },
    undefined,
  );
  assert(
    cross.details.error === "not_found",
    "cross-workspace link_budget → not_found",
  );
}

// Idle-since: register-as-idle sets the clock (welcome snapshot for late
// joiners), busy clears it, busy→idle re-sets — all hub-clock.
{
  assert(
    typeof g.welcome.idleSince?.["alpha/w"] === "number" &&
      typeof g.welcome.idleSince?.["default/hub"] === "number",
    "welcome snapshot carries idle-since for idle terminals",
  );
  send(g, {
    type: "status_update",
    name: "default/g",
    status: { kind: "thinking", since: Date.now() },
    budget: null,
    model: null,
  });
  await delay(300);
  let fanned = ofType(r, "status_update").filter((m) => m.name === "default/g").at(-1);
  assert(fanned?.idleSince === null, "busy clears idle-since in the fan-out");
  send(g, {
    type: "status_update",
    name: "default/g",
    status: { kind: "idle", since: 1 }, // client clock says 1 — hub clock wins
    budget: null,
    model: null,
    junk: "dropped-by-whitelist",
  });
  await delay(300);
  fanned = ofType(r, "status_update").filter((m) => m.name === "default/g").at(-1);
  assert(
    typeof fanned?.idleSince === "number" && fanned.idleSince > 1,
    "busy→idle re-sets idle-since on the hub clock",
  );
  assert(
    fanned && !("junk" in fanned) && "budget" in fanned && "model" in fanned,
    "hub normalization whitelist drops unlisted fields, keeps v2 fields",
  );
  const list = await hub.tools.link_list.execute("t", {}, undefined);
  assert(
    /idle \(\ds\)/.test(list.details.statuses?.["default/g"] ?? ""),
    `link_list shows idle duration from the hub clock (got "${list.details.statuses?.["default/g"]}")`,
  );
}

// link_new: busy declines; idle acks with oldSessionId, then re-enters
// through the command path and pre-writes identity into the new session.
{
  await worker.handlers.agent_start({}, worker.ctx);
  const busy = await hub.tools.link_new.execute("t", { to: "alpha/w" }, undefined);
  assert(
    busy.details.error === "busy",
    `busy target declines link_new (got "${toolText(busy)}")`,
  );
  await worker.handlers.agent_end({ messages: [] }, worker.ctx);

  const res = await hub.tools.link_new.execute("t", { to: "alpha/w" }, undefined);
  assert(
    !res.details.error &&
      toolText(res).includes("sess-old-123") &&
      res.details.oldSessionId === "sess-old-123",
    `idle target acks with oldSessionId (got "${toolText(res)}")`,
  );
  await waitFor(
    () => worker.calls.includes("newSession"),
    "command-ctx newSession",
  );
  const entries = worker.newSessionEntries ?? [];
  assert(
    entries.some(
      (e) => e.customType === "link-name" && e.data.name === "w",
    ) &&
      entries.some(
        (e) => e.customType === "link-workspace" && e.data.workspace === "alpha",
      ) &&
      entries.some(
        (e) => e.customType === "link-active" && e.data.active === true,
      ),
    "setup pre-writes name + workspace + connect intent into the new session",
  );
}

// ── Teardown ────────────────────────────────────────────────────────────────

for (const c of [g, r]) c.ws.close();
await worker.handlers.session_shutdown();
await hub.handlers.session_shutdown();

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
