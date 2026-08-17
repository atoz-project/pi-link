// ADR-0008 qualified addresses — end-to-end test with REAL pi processes.
// Spawns three actual `pi` binaries (rpc mode, stdin held open, no LLM calls)
// loading the repo's index.ts: a global-grant hub plus one terminal each
// in workspaces alpha and beta. Then probes the live link with raw WebSocket
// clients and asserts cross-group invisibility on the wire.
//
// Complements test/workspace-isolation.mjs (mocked Pi host): this one covers
// the real flag plumbing (--link/--link-name/--link-workspace through the pi
// binary), real extension loading, and real process lifecycle.
//
// Requires: `pi` on PATH, port 9900 free. Run: npm run test:e2e

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

const EXTENSION = new URL("../index.ts", import.meta.url).pathname;
const PORT = 19903; // isolated test fleet port (PI_LINK_PORT, never the real 9900)

let failures = 0;
const check = (cond, label) => {
  console.log((cond ? "  ok — " : "  FAIL — ") + label);
  if (!cond) failures++;
};

// ── Real pi terminals ───────────────────────────────────────────────────────

const children = [];
function startPi(name, workspace, globalGrant) {
  const args = [
    "--mode", "rpc",
    "--no-session",
    "-e", EXTENSION,
    "--link",
    "--link-name", name,
  ];
  if (workspace) args.push("--link-workspace", workspace);
  if (globalGrant) args.push("--link-global");
  // Held open on stdin: rpc mode idles until a prompt arrives (none comes).
  // HOME isolation makes the run hermetic: no global pi-link install
  // (~/.pi/agent settings — duplicate tools/flags conflict), no profiles
  // file (~/.pi/agent/pi-link.json — a token there would make the hub
  // reject unauthenticated probes), no user session state.
  const child = spawn("pi", args, {
    cwd: mkdtempSync(join(tmpdir(), "pi-link-e2e-")),
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: mkdtempSync(join(tmpdir(), "pi-link-e2e-home-")),
      PI_LINK_PORT: String(PORT),
    },
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  children.push({ child, name, log: () => log });
  return child;
}

function killAll() {
  for (const { child } of children) {
    try {
      // SIGKILL, not SIGTERM: pi traps SIGTERM for graceful shutdown but can
      // linger with stdin held open, orphaning a hub on the test port.
      child.kill("SIGKILL");
    } catch {}
  }
}
process.on("exit", killAll);

// ── Raw protocol probe ──────────────────────────────────────────────────────

function probe(register, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("probe timeout"));
    }, timeoutMs);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "welcome") {
        clearTimeout(timer);
        resolve(msg);
        ws.close();
      }
    });
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "register",
          version: 3,
          workspace: "default",
          global: false,
          sessionId: `probe-${Math.random().toString(36).slice(2, 10)}`,
          ...register,
        }),
      ),
    );
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

// Poll until the real hub accepts registers (pi startup takes seconds).
async function waitForHub(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await probe({ name: "probe-ready" });
    } catch {
      if (Date.now() > deadline) {
        for (const c of children) console.error(`--- ${c.name} log ---\n${c.log()}`);
        throw new Error("hub did not come up");
      }
      await delay(500);
    }
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

console.log("e2e: 3 real pi terminals (hub global, a@alpha, b@beta)");
startPi("e2e-hub", "default", true); // global grant, home "default"
const ready = await waitForHub();
check(Array.isArray(ready.terminals), "real pi hub is up and speaking the protocol");

startPi("e2e-a", "alpha");
startPi("e2e-beta", "beta");

// Wait until both scoped terminals are registered (visible to a global probe).
let glob;
for (let i = 0; i < 40; i++) {
  await delay(500);
  glob = await probe({ name: "probe-g", workspace: "ops", global: true });
  if (glob.terminals.includes("alpha/e2e-a") && glob.terminals.includes("beta/e2e-beta"))
    break;
}
check(
  glob.terminals.includes("default/e2e-hub") &&
    glob.terminals.includes("alpha/e2e-a") &&
    glob.terminals.includes("beta/e2e-beta"),
  `global member sees all real terminals, qualified (${glob.terminals})`,
);

const beta = await probe({ name: "probe-b", workspace: "beta" });
check(beta.workspace === "beta", "beta probe welcome echoes effective home");
check(
  beta.terminals.includes("default/e2e-hub") && beta.terminals.includes("beta/e2e-beta"),
  `beta sees global hub + beta member (${beta.terminals})`,
);
check(
  !beta.terminals.includes("alpha/e2e-a"),
  "beta does NOT see the alpha terminal (real --link-workspace flag took effect)",
);

const alpha = await probe({ name: "probe-a", workspace: "alpha" });
check(
  alpha.terminals.includes("alpha/e2e-a") && !alpha.terminals.includes("beta/e2e-beta"),
  "alpha sees only alpha + global members",
);

killAll();
console.log(failures === 0 ? "\nE2E ALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
