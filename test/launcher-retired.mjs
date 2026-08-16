// ADR-0007 §8 / issue #16 — launcher execution mode retired.
// Drives bin/pi-link.mjs as a child process: `pi-link <name>` must refuse
// with the two explicit recipes (spawning nothing), the query modes
// (--list / --resolve) keep working, and PI_LINK_NAME is gone end-to-end.
//
// Run: node test/launcher-retired.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(import.meta.dirname, "../bin/pi-link.mjs");
const SESSION_DIR = mkdtempSync(join(tmpdir(), "pi-link-launcher-test-"));
let failures = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  ok — ${label}`);
  } else {
    failures++;
    console.error(`  FAIL — ${label}`);
  }
}

// Run the CLI hermetically: custom session dir (flat layout), no color.
function cli(...args) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PI_CODING_AGENT_SESSION_DIR: SESSION_DIR,
      NO_COLOR: "1",
    },
    timeout: 15_000,
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

// ── Refusal: pi-link <name> spawns nothing, prints both explicit recipes ────

console.log("launcher refusal");
{
  const r = cli("worker");
  assert(r.code !== 0 && r.code !== null, `pi-link <name> exits non-zero (got ${r.code})`);
  assert(
    r.err.includes("pi --link --link-name worker"),
    "refusal names the fresh-start recipe with the given name",
  );
  assert(
    r.err.includes("--resolve worker") && r.err.includes("--session"),
    "refusal names the resurrect recipe (resolve → pi --link --session)",
  );
  assert(
    !r.err.includes("Resuming session") && !r.err.includes("Starting new session"),
    "no resume/spawn path runs",
  );
}
{
  // Stray positional after a query mode's arguments still refuses/fails, never launches.
  const r = cli("--resolve", "a", "b");
  assert(r.code !== 0, "stray positional after --resolve <name> exits non-zero");
}
{
  // Names that would break the copy-paste recipes: whitespace-only → <name>
  // placeholder; multi-word → quoted.
  const blank = cli("   ");
  assert(
    blank.code === 1 && blank.err.includes("pi --link --link-name <name>"),
    "whitespace-only name refuses with the <name> placeholder",
  );
  const spaced = cli("build lead");
  assert(
    spaced.code === 1 && spaced.err.includes('pi --link --link-name "build lead"'),
    "multi-word name is quoted in the recipes",
  );
}

// ── Help text: two query modes + two explicit launch spellings ──────────────

console.log("help text");
{
  const r = cli("--help");
  const text = r.out + r.err;
  assert(r.code === 0, "--help exits 0");
  assert(
    text.includes("--list") &&
      text.includes("--resolve <name>") &&
      text.includes("pi --link --link-name <name>") &&
      text.includes("pi --link --session"),
    "help shows query modes + explicit launch recipes",
  );
  assert(
    !text.includes("pi-link <name>"),
    "help no longer advertises the launcher form",
  );
}

// ── Query modes unchanged ────────────────────────────────────────────────────

console.log("query modes");
{
  const r = cli("--list", "-g");
  assert(
    r.code === 0 && r.out.includes("No pi-link sessions found"),
    "--list -g on an empty session dir exits 0",
  );
}

// Fixture session (custom session dir = flat layout).
const FIXTURE = join(SESSION_DIR, "sess-worker.jsonl");
writeFileSync(
  FIXTURE,
  [
    JSON.stringify({ type: "session", cwd: "/tmp/elsewhere", id: "abcd1234-5678" }),
    JSON.stringify({ type: "custom", customType: "link-name", data: { name: "worker" } }),
  ].join("\n") + "\n",
);
{
  const r = cli("--resolve", "worker", "-g");
  assert(
    r.code === 0 && r.out.trim() === FIXTURE,
    `--resolve <name> -g prints the session path (got "${r.out.trim()}")`,
  );
  const list = cli("--list", "-g");
  assert(
    list.code === 0 && list.out.includes("worker"),
    "--list -g shows the fixture session",
  );
  const ghost = cli("--resolve", "ghost", "-g");
  assert(ghost.code === 2, `--resolve unknown name exits 2 (got ${ghost.code})`);
  // Without -g, lookup stays cwd-scoped: the fixture lives in /tmp/elsewhere,
  // so a local resolve misses it and hints at --global.
  const local = cli("--resolve", "worker");
  assert(
    local.code === 2 && local.err.includes("--global"),
    `--resolve without -g stays cwd-scoped with a --global hint (got ${local.code})`,
  );
  const version = cli("--version");
  assert(
    version.code === 0 && /^\d+\.\d+\.\d+/.test(version.out.trim()),
    `--version prints the bare semver (got "${version.out.trim()}")`,
  );
}

// ── PI_LINK_NAME handoff is gone end-to-end ─────────────────────────────────

console.log("PI_LINK_NAME removed");
{
  const bin = readFileSync(BIN, "utf8");
  const ext = readFileSync(resolve(import.meta.dirname, "../index.ts"), "utf8");
  assert(
    !bin.includes("PI_LINK_NAME") && !ext.includes("PI_LINK_NAME"),
    "PI_LINK_NAME referenced nowhere in bin/ or index.ts",
  );
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
