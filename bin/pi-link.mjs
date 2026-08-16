#!/usr/bin/env node

// pi-link CLI — query pi-link sessions by name (ADR-0007 §8: query-only).
//
// Usage:
//   pi-link --list [--global|-g] List pi-link sessions in current cwd (or everywhere).
//   pi-link --resolve <name> [--global|-g]
//                                Print just the session path (machine-readable).
//   pi-link --version            Print the installed pi-link version.
//
// Launching is explicit — the name→session execution mode is retired:
//   fresh start  → pi --link --link-name <name>
//   resurrect    → pi-link --resolve <name> -g, then pi --link --session <path>

import { readdir, stat } from "fs/promises";
import { createReadStream, existsSync, readFileSync } from "fs";
import { createInterface } from "readline";
import { join } from "path";
import { homedir } from "os";

// Canonicalize a link/session name: trim + collapse internal whitespace.
// Must match the extension's normalizeName (index.ts).
function normalizeName(s) {
  return s.trim().replace(/\s+/g, " ");
}

// ── Pi config resolution ───────────────────────────────────────────────────
// Match Pi's session-dir lookup order so --list/--resolve see what Pi sees.
// Custom sessionDir → flat layout; default → <agentDir>/sessions/<encoded-cwd>.

// Match Pi's expandTildePath: only `~` and `~/...`.
function expandTilde(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function readSessionDirFromSettings(settingsPath) {
  if (!existsSync(settingsPath)) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
  } catch (err) {
    console.error(`pi-link: ignored ${settingsPath}: ${err.message}`);
    return undefined;
  }
  const value = parsed?.sessionDir;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value;
}

// PI_CODING_AGENT_DIR also relocates global settings.json to <agentDir>/settings.json.
function resolveAgentDir() {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (env) return expandTilde(env);
  return join(homedir(), ".pi", "agent");
}

// Returns { dir, isCustom }. isCustom drives layout in scanSessions:
// true → flat <dir>/*.jsonl, false → <dir>/<encoded-cwd>/*.jsonl.
function resolveSessionDir(cwd, agentDir) {
  const env = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (env) return { dir: expandTilde(env), isCustom: true };

  const projectDir = readSessionDirFromSettings(join(cwd, ".pi", "settings.json"));
  if (projectDir) return { dir: expandTilde(projectDir), isCustom: true };

  const globalDir = readSessionDirFromSettings(join(agentDir, "settings.json"));
  if (globalDir) return { dir: expandTilde(globalDir), isCustom: true };

  return { dir: join(agentDir, "sessions"), isCustom: false };
}

// Reads a session JSONL file and returns its display name, cwd, id, link
// status, and message count.
//
// Name precedence: latest valid `link-name` custom entry wins as the
// authoritative pi-link name. `session_info.name` is only a fallback for
// sessions that never set a link-name. Historical link-names are not aliases.
async function getSessionMeta(filePath) {
  let linkName;
  let sessionName;
  let cwd;
  let id;
  let hasLinkName = false;
  let messages = 0;
  const rl = createInterface({ input: createReadStream(filePath, "utf-8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "session") {
        if (typeof entry.cwd === "string") cwd = entry.cwd;
        if (typeof entry.id === "string") id = entry.id;
      } else if (entry.type === "session_info" && typeof entry.name === "string") {
        sessionName = normalizeName(entry.name) || undefined;
      } else if (entry.type === "custom" && entry.customType === "link-name") {
        hasLinkName = true;
        if (entry.data && typeof entry.data.name === "string") {
          const n = normalizeName(entry.data.name);
          if (n) linkName = n;
        }
      } else if (entry.type === "message" || entry.type === "user" || entry.type === "assistant") {
        messages++;
      }
    } catch {
      // skip malformed lines (incl. partial last line of active sessions)
    }
  }
  return { name: linkName ?? sessionName, cwd, id, hasLinkName, messages };
}

function normalizePath(p) {
  let s = p.replace(/[/\\]+/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32") s = s.toLowerCase();
  return s;
}

// Replace $HOME with ~ in display paths. Comparison is normalized
// (case-insensitive on Windows) but display preserves original casing.
function displayPath(p) {
  if (!p) return p;
  const home = homedir();
  const normP = normalizePath(p);
  const normHome = normalizePath(home);
  if (normP === normHome) return "~";
  if (normP.startsWith(normHome + "/")) return "~" + p.slice(home.length).replace(/\\/g, "/");
  return p;
}

const useAnsi =
  !!process.stdout.isTTY &&
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb";
const bold = (s) => (useAnsi ? `\x1b[1m${s}\x1b[22m` : s);
const dim = (s) => (useAnsi ? `\x1b[2m${s}\x1b[22m` : s);

function relTime(d) {
  const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return d.toISOString().slice(0, 10);
}

async function loadSessionRecord(filePath) {
  try {
    const meta = await getSessionMeta(filePath);
    const stats = await stat(filePath);
    return { ...meta, modified: stats.mtime, path: filePath };
  } catch {
    return null;
  }
}

// Returns meta + mtime + path for every readable session in `dir`. Custom
// layout is flat (<dir>/*.jsonl); default layout has one subdir level per
// encoded cwd (<dir>/<sub>/*.jsonl). Errors on individual files/dirs are
// silently skipped — active or partially-written sessions are tolerated.
async function scanSessions(dir, isCustom) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const tasks = [];
  if (isCustom) {
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      tasks.push(loadSessionRecord(join(dir, entry.name)));
    }
  } else {
    for (const sub of entries) {
      if (!sub.isDirectory()) continue;
      const subPath = join(dir, sub.name);
      let files;
      try { files = await readdir(subPath); } catch { continue; }
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        tasks.push(loadSessionRecord(join(subPath, file)));
      }
    }
  }

  return (await Promise.all(tasks)).filter((s) => s !== null);
}

// Find sessions whose current display name matches `targetName`. Returns both
// local-cwd matches and all matches (cross-cwd) so the caller can default to
// local while still surfacing a hint when non-local matches exist. Falls back
// to `session_info.name` for sessions without a link-name (so --resolve can
// find a previously-unlinked named session for explicit resurrection).
async function findSessionsByName(targetName, dir, isCustom) {
  const localCwd = normalizePath(process.cwd());
  const all = (await scanSessions(dir, isCustom))
    .filter((s) => s.name === targetName)
    .map((s) => ({ path: s.path, cwd: s.cwd || "?", modified: s.modified }))
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
  const local = all.filter((s) => normalizePath(s.cwd) === localCwd);
  return { local, all };
}

// List pi-link sessions (those with at least one link-name entry). Default
// scope is current cwd; `all` widens to every directory.
async function listSessions({ all, dir, isCustom }) {
  const localCwd = normalizePath(process.cwd());
  return (await scanSessions(dir, isCustom))
    .filter((s) => s.hasLinkName)
    .filter((s) => all || (s.cwd && normalizePath(s.cwd) === localCwd))
    .map((s) => ({
      name: s.name || "(unnamed)",
      cwd: s.cwd || "?",
      id: s.id ? s.id.slice(0, 8) : "?",
      messages: s.messages,
      modified: s.modified,
      path: s.path,
    }))
    .sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

// Renders a plain-text table. Widths are computed from unstyled cells; ANSI
// styles are applied after padding so column alignment is preserved when piped
// or styled. Mark a column with `dim: true` to render its cells dim.
function renderTable(rows, columns) {
  const widths = columns.map((c) => Math.max(c.header.length, ...rows.map((r) => String(c.get(r)).length)));
  const padCell = (text, i) => (i === columns.length - 1 ? text : text.padEnd(widths[i]));
  const styleBody = (text, i) => (columns[i].dim ? dim(text) : text);
  const headerLine = columns.map((c, i) => bold(padCell(c.header, i))).join("  ");
  const bodyLines = rows.map((r) =>
    columns.map((c, i) => styleBody(padCell(String(c.get(r)), i), i)).join("  "),
  );
  return [headerLine, ...bodyLines].join("\n");
}

// ── CLI ────────────────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);

function printCandidates(name, matches) {
  console.error(`Multiple sessions named "${name}":\n`);
  for (const m of matches) {
    console.error(`  ${m.modified.toISOString().slice(0, 19)}  cwd: ${m.cwd}`);
    console.error(`  ${m.path}\n`);
  }
  console.error(`Use: pi --link --session <path>`);
  process.exit(1);
}

// ADR-0007 §8 / #16: the launcher execution mode is retired. A bare
// positional refuses with the two explicit spellings — implicit resume drops
// a live agent into whatever context that session last held, and a typo'd
// name silently forked a blank same-named terminal.
function refuseLauncher(rawName) {
  // Recipes must be copy-pasteable: quote names with internal whitespace;
  // a name that normalizes to empty gets the <name> placeholder.
  const name = normalizeName(rawName);
  const arg = !name ? "<name>" : /\s/.test(name) ? JSON.stringify(name) : name;
  console.error(
    `Error: the 'pi-link <name>' launcher was removed (ADR-0007) — launching is explicit.`,
  );
  console.error("");
  console.error(`  Fresh start:  pi --link --link-name ${arg}`);
  console.error(`  Resurrect:    pi-link --resolve ${arg} -g`);
  console.error("                then: pi --link --session <printed path>");
  process.exit(1);
}

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function printHelp() {
  console.error("Usage: pi-link --list [--global|-g]");
  console.error("       pi-link --resolve <name> [--global|-g]");
  console.error("       pi-link --version");
  console.error("");
  console.error("Query-only CLI — launching is explicit (ADR-0007):");
  console.error("  Fresh start:  pi --link --link-name <name>");
  console.error("  Resurrect:    pi --link --session <path>  (path via pi-link --resolve <name> -g)");
  console.error("");
  console.error("By default, name lookup is scoped to the current cwd.");
  console.error("--global / -g widens the search to sessions in any cwd.");
}

function printVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    );
    console.log(pkg.version ?? "unknown");
  } catch {
    console.log("unknown");
  }
}

function describeMode(mode) {
  switch (mode) {
    case "help": return "--help";
    case "version": return "--version";
    case "list": return "--list";
    case "resolve": return "--resolve";
    default: return mode;
  }
}

// ── Parser ─────────────────────────────────────────────────────────────────
//
// Single sequential pass populates `state`; dispatcher reads it. Phases:
//   1. Global flags (--global, --help, --version)
//   2. Mode-selecting flags (--list, --resolve, --resolve=<name>)
//   3. Mode-specific extra-token rejection
//   4. Anything else: unknown flag → error; bare positional → launcher
//      refusal with the explicit recipes (ADR-0007 §8)

const state = {
  mode: null, // null | "help" | "version" | "list" | "resolve"
  resolveName: null,
  global: false,
};

function setMode(mode) {
  if (state.mode !== null && state.mode !== mode) {
    fail(`cannot combine ${describeMode(state.mode)} and ${describeMode(mode)}`);
  }
  state.mode = mode;
}

for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];

  // Phase 1: global flags / scope-affecting tokens.
  if (a === "--global" || a === "-g") {
    state.global = true;
    continue;
  }
  if (a === "--help" || a === "-h") {
    setMode("help"); // errors if combined with another mode
    continue;
  }
  if (a === "--version") {
    setMode("version"); // errors if combined with another mode
    continue;
  }
  // Phase 2: mode-selecting flags.
  if (a === "--list") {
    setMode("list");
    continue;
  }
  if (a.startsWith("--resolve=")) {
    setMode("resolve");
    if (state.resolveName !== null) fail(`--resolve specified more than once`);
    state.resolveName = a.slice("--resolve=".length);
    continue;
  }
  if (a === "--resolve") {
    setMode("resolve");
    if (state.resolveName !== null) fail(`--resolve specified more than once`);
    const next = rawArgs[i + 1];
    if (next === undefined || next.startsWith("-")) {
      fail(`--resolve requires a name argument.\n  Usage: pi-link --resolve <name> [--global|-g]`);
    }
    state.resolveName = next;
    i++; // consume the value
    continue;
  }

  // Phase 3: mode-specific extra-token rejection.
  if (state.mode === "help") {
    fail(`--help does not accept arguments: ${a}`);
  }
  if (state.mode === "version") {
    fail(`--version does not accept arguments: ${a}`);
  }
  if (state.mode === "list") {
    fail(`--list does not accept argument: ${a}\n  Usage: pi-link --list [--global|-g]`);
  }
  if (state.mode === "resolve") {
    fail(`--resolve accepts exactly one name; got extra: ${a}`);
  }

  // Phase 4: nothing else is valid. state.mode === null here (query modes
  // reject their own extra tokens in Phase 3).
  if (a.startsWith("-")) {
    fail(`Unknown argument: ${a}\n  Usage: pi-link --list [--global|-g] | pi-link --resolve <name> [--global|-g]`);
  }
  if (a === "list" || a === "resolve") {
    fail(`'pi-link ${a}' was removed. Use 'pi-link --${a}'.`);
  }
  refuseLauncher(a); // exits 1 with the explicit recipes
}

// ── Post-parse validation ──────────────────────────────────────────────────

if (state.mode === "resolve") {
  if (state.resolveName === null) {
    fail(`--resolve requires a name argument.\n  Usage: pi-link --resolve <name> [--global|-g]`);
  }
  const normalized = normalizeName(state.resolveName);
  if (!normalized) {
    fail(`--resolve requires a non-empty name argument.\n  Usage: pi-link --resolve <name> [--global|-g]`);
  }
  state.resolveName = normalized;
}

// ── Dispatch ───────────────────────────────────────────────────────────────

switch (state.mode) {
  case null:
  case "help":
    printHelp();
    process.exit(0);
    break; // unreachable; present to satisfy no-fallthrough lints
  case "version":
    printVersion();
    process.exit(0);
    break; // unreachable; present to satisfy no-fallthrough lints
  case "list":
    await runList(state);
    break;
  case "resolve":
    await runResolve(state);
    break;
  default:
    fail(`internal error: unknown mode ${state.mode}`);
}

// ── Mode handlers ──────────────────────────────────────────────────────────

async function runList(state) {
  const { dir, isCustom } = resolveSessionDir(process.cwd(), resolveAgentDir());
  const sessions = await listSessions({ all: state.global, dir, isCustom });
  if (sessions.length === 0) {
    console.log(state.global ? "No pi-link sessions found." : "No pi-link sessions found in this cwd.");
    console.log("Start one: pi --link --link-name <name>");
    return;
  }
  const columns = state.global
    ? [
      { header: "NAME", get: (s) => s.name },
      { header: "CWD", get: (s) => displayPath(s.cwd) },
      { header: "MODIFIED", get: (s) => relTime(s.modified), dim: true },
      { header: "MESSAGES", get: (s) => s.messages, dim: true },
      { header: "ID", get: (s) => s.id, dim: true },
    ]
    : [
      { header: "NAME", get: (s) => s.name },
      { header: "MODIFIED", get: (s) => relTime(s.modified), dim: true },
      { header: "MESSAGES", get: (s) => s.messages, dim: true },
      { header: "ID", get: (s) => s.id, dim: true },
    ];
  console.log(renderTable(sessions, columns));
  if (process.stdout.isTTY) {
    console.log("");
    console.log(dim("Resurrect: pi --link --session <path>  (path via pi-link --resolve <name> -g)"));
  }
}

async function runResolve(state) {
  const name = state.resolveName; // already normalized
  const { dir, isCustom } = resolveSessionDir(process.cwd(), resolveAgentDir());
  const { local, all } = await findSessionsByName(name, dir, isCustom);
  const matches = state.global ? all : local;
  if (matches.length === 1) {
    process.stdout.write(matches[0].path);
    return; // exit 0
  }
  if (matches.length > 1) {
    printCandidates(name, matches); // exits 1
  }
  // matches.length === 0 → not found; exit 2 to distinguish from ambiguous.
  console.error(`No session named "${name}" found${state.global ? "" : " in this cwd"}.`);
  if (!state.global && all.length > 0) {
    console.error(`(${all.length} match${all.length === 1 ? "" : "es"} in other cwds — try --global to consider ${all.length === 1 ? "it" : "them"}.)`);
  }
  process.exit(2);
}
