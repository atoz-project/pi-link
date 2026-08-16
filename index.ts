/**
 * Pi Link — WebSocket-based inter-terminal communication
 *
 * Connects multiple Pi terminals over a local WebSocket link.
 * Opt-in via --link flag, --link-name flag, pi-link CLI, or /link-connect command.
 * First terminal to connect becomes the hub; others join as clients.
 * Hub loss triggers automatic promotion of a surviving client.
 *
 * Tools: link_send, link_prompt, link_list, link_compact
 * Commands: /link, /link-name, /link-broadcast, /link-connect, /link-disconnect
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as crypto from "node:crypto";
import * as os from "node:os";

import { WebSocket, WebSocketServer } from "ws";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_PORT = 9900;
// Test/fleet isolation knob: PI_LINK_PORT overrides the hub bind port and
// the default client URL. Read once at module load.
const LINK_PORT = (() => {
  const p = parseInt(process.env.PI_LINK_PORT ?? "", 10);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : DEFAULT_PORT;
})();
const PROMPT_INACTIVITY_MS = 90_000;
const PROMPT_HARD_CEILING_MS = 1_800_000;
const COMPACT_TIMEOUT_MS = 180_000;
const RECONNECT_DELAY_MS = 2000;
const KEEPALIVE_INTERVAL_MS = 30_000;
const FLUSH_DELAY_MS = 200;
const IDLE_RETRY_MS = 500;
const BATCH_MAX_ITEMS = 20;
const BATCH_MAX_CHARS = 16_000;
// ADR-0001 status-channel event model. Trailing-edge debounce window for
// pushStatus sends; unconditional heartbeat interval while connected.
const STATUS_DEBOUNCE_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
// ADR-0005: one budget axis (amends ADR-0001 — the "hot" vocabulary is
// retired). Undeclared budget defaults to contextWindow − reserve, exactly
// the old hot semantics; over budget ⇔ tokens ≥ budget.
const DEFAULT_BUDGET_RESERVE = 100_000;
// ADR-0005 §8: protocol version gate. Rides register, echoed in welcome;
// missing/mismatched on either side → loud refusal, no auto-reconnect.
// Within a versioned link every v2 field is guaranteed present — no
// per-field fallback paths. Bump on any breaking wire change.
const LINK_PROTOCOL_VERSION = 2;
const BUDGET_TIMEOUT_MS = 30_000;
const NEW_TIMEOUT_MS = 30_000;
// ADR-0002 public-reachable hub auth. Loopback host set (host not in it
// = non-loopback). Deliberately conservative: 127.0.0.2 counts as non-loopback,
// which also makes the fail-closed / no-self-promotion guards testable without
// a real external interface. Profiles file is the only token source
// (~/.pi/agent/pi-link.json, mode 0600); no env-var token override.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const PROFILES_FILE_PATH = (() => {
  const home = os.homedir().replace(/\\/g, "/");
  return `${home}/.pi/agent/pi-link.json`;
})();

// ─── Protocol ────────────────────────────────────────────────────────────────

interface RegisterMsg {
  type: "register";
  name: string;
  cwd?: string;
  context?: ContextSnapshot;
  // ADR-0002: optional shared-token auth. Present when the client resolved a
  // profile token; absent otherwise. Old hubs ignore unknown fields
  // (fork-first, upstream PR later).
  token?: string;
  // ADR-0004: optional workspace declaration. Absent = global observer.
  workspace?: string;
  // ADR-0005: version gate + status-channel v2 fields. Guaranteed present
  // within a versioned link (null = default/none, never absent).
  version: number;
  budget: number | null; // declared budget; null = default (window − reserve)
  model: string | null; // raw provider/model-id:thinkingLevel
}
interface WelcomeMsg {
  type: "welcome";
  name: string;
  terminals: string[];
  statuses?: Record<string, LinkStatus>;
  cwds?: Record<string, string>;
  contexts?: Record<string, ContextSnapshot>;
  // ADR-0004: echoes the effective workspace (absent = global observer).
  // ADR-0005: this is now an effective-value readback only — the version
  // gate below is the wire's compatibility mechanism.
  workspace?: string;
  // ADR-0005: echoed protocol version (the gate) + v2 snapshots, all cut to
  // the joiner's visible set.
  version: number;
  budgets: Record<string, number>; // declared budgets only (absent key = default)
  models: Record<string, string>;
  idleSince: Record<string, number>; // idle terminals only (hub clock)
}
interface TerminalJoinedMsg {
  type: "terminal_joined";
  name: string;
  terminals: string[];
  cwd?: string;
  context?: ContextSnapshot;
}
interface TerminalLeftMsg {
  type: "terminal_left";
  name: string;
  terminals: string[];
}
interface ChatMsg {
  type: "chat";
  from: string;
  to: string;
  content: string;
  triggerTurn: boolean;
}
interface PromptRequestMsg {
  type: "prompt_request";
  id: string;
  from: string;
  to: string;
  prompt: string;
}
interface PromptResponseMsg {
  type: "prompt_response";
  id: string;
  from: string;
  to: string;
  response: string;
  error?: string;
}
interface StatusUpdateMsg {
  type: "status_update";
  name: string;
  status: LinkStatus;
  // Per-terminal LLM context. Absent = old terminal (ignore); null = clear
  // stored value; object = store. Only status_update carries the null-clear.
  context?: ContextSnapshot | null;
  // ADR-0005 v2 fields. Client→hub: budget + model (null = default/none).
  // Hub→client fan-out: the hub attaches idleSince (hub-authoritative clock).
  budget: number | null;
  model: string | null;
  idleSince?: number | null;
}
interface ErrorMsg {
  type: "error";
  message: string;
}
interface CompactRequestMsg {
  type: "compact_request";
  id: string;
  from: string;
  to: string;
  instructions?: string;
}
interface CompactResponseMsg {
  type: "compact_response";
  id: string;
  from: string;
  to: string;
  ok: boolean;
  reason?: string; // "busy" | "not_found" | "unsupported" | error text; absent on success
}
// ADR-0005 §4: remote budget set. budget null = "off" (clear to default).
interface BudgetSetMsg {
  type: "budget_set";
  id: string;
  from: string;
  to: string;
  budget: number | null;
}
interface BudgetResponseMsg {
  type: "budget_response";
  id: string;
  from: string;
  to: string;
  ok: boolean;
  reason?: string; // "not_found" | error text; absent on success
}
// ADR-0006: remote fresh session. Ack carries oldSessionId (resurrection
// metadata) and is sent BEFORE ctx.newSession() tears down the responder.
interface NewRequestMsg {
  type: "new_request";
  id: string;
  from: string;
  to: string;
}
interface NewResponseMsg {
  type: "new_response";
  id: string;
  from: string;
  to: string;
  ok: boolean;
  oldSessionId?: string;
  reason?: string; // "busy" | "not_found" | "unsupported" | error text
}

type LinkStatus =
  | { kind: "idle"; since: number }
  | { kind: "thinking"; since: number }
  | { kind: "tool"; toolName: string; since: number };

type ContextSnapshot = { tokens: number | null; contextWindow: number };

type LinkMessage =
  | RegisterMsg
  | WelcomeMsg
  | TerminalJoinedMsg
  | TerminalLeftMsg
  | ChatMsg
  | PromptRequestMsg
  | PromptResponseMsg
  | StatusUpdateMsg
  | ErrorMsg
  | CompactRequestMsg
  | CompactResponseMsg
  | BudgetSetMsg
  | BudgetResponseMsg
  | NewRequestMsg
  | NewResponseMsg;

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerFlag("link", {
    description: "Connect to link on startup",
    type: "boolean",
    default: false,
  });

  pi.registerFlag("link-name", {
    description:
      "Set the pi-link terminal name on startup (link identity only; does not affect session)",
    type: "string",
  });

  pi.registerFlag("link-workspace", {
    description:
      "Set the pi-link workspace (visibility group) on startup; fixed for the terminal's lifetime",
    type: "string",
  });

  pi.registerFlag("link-budget", {
    description:
      "Set the pi-link context budget (absolute used-tokens ceiling, e.g. 56k) on startup; runtime-mutable via the link_budget tool",
    type: "string",
  });

  // ── State ────────────────────────────────────────────────────────────────

  let role: "hub" | "client" | "disconnected" = "disconnected";
  let terminalName = `t-${crypto.randomUUID().slice(0, 4)}`;
  let preferredName: string | null = null;
  // True between a client `/link-name` close and the next welcome/promotion.
  // Lets `startHub` adopt the requested name if it wins promotion before welcome.
  let pendingClientRename = false;
  let connectedTerminals: string[] = [];
  let ctx: ExtensionContext | undefined;
  let disposed = false;
  let manuallyDisconnected = false;
  // ADR-0002: set when the hub rejected our token (error-before-close). Stops
  // auto-reconnect (a wrong-token terminal would hammer the hub every 2s) and
  // is cleared by manual /link-connect. Distinguishes auth rejection from
  // hub loss (which keeps backoff retry).
  let authFailed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let startupConnectTimer: ReturnType<typeof setTimeout> | null = null;
  // ADR-0002: resolved link config (URL + token), cached on first
  // connect/startHub. null = not yet resolved. Token is the fleet shared
  // secret from the profiles file; never logged.
  let resolvedHubUrl: string | null = null;
  let resolvedToken: string | null = null;
  // Whether the plaintext-warning has fired this session (ADR-0002 §1:
  // exactly once per session, not per reconnect).
  let plaintextWarningFired = false;
  // ADR-0004: this terminal's declared workspace (null = global observer).
  // Resolved once at session_start; fixed for the terminal's lifetime.
  let workspace: string | null = null;
  // ADR-0004: set when the hub's welcome failed the workspace handshake
  // (requested a workspace but the echo was missing/mismatched = the hub
  // cannot honor isolation, e.g. an old hub). Same semantics as authFailed:
  // rejection ≠ hub loss — no auto-reconnect; manual /link-connect resets.
  let workspaceRejected = false;
  // ADR-0005: declared context budget (null = default: window − reserve).
  // Resolved at session_start (flag > env > saved entry); runtime-mutable
  // via the link_budget tool (persists the entry).
  let declaredBudget: number | null = null;
  // ADR-0005 §8: set when the version gate refused membership (welcome echo
  // missing/mismatched, or the hub sent a version-rejection error before
  // close). Same semantics as authFailed; manual /link-connect resets.
  let versionRejected = false;

  // Status tracking (local truth)
  let agentRunning = false;
  let compactRunning = false; // true while compacting for a remote request
  let activeToolName: string | null = null;
  let stateSince = Date.now();
  let lastPushedKind: string | null = null;
  let lastPushedTool: string | null = null;
  const terminalStatuses = new Map<string, LinkStatus>(); // other terminals
  const terminalContexts = new Map<string, ContextSnapshot>(); // other terminals' context
  let currentCwd = "";
  const terminalCwds = new Map<string, string>(); // other terminals' cwds
  // ADR-0005 v2 peer caches (client role; hub uses hubTerminal* below).
  const terminalBudgets = new Map<string, number>(); // declared (absent = default)
  const terminalModels = new Map<string, string>();
  const terminalIdleSince = new Map<string, number>(); // hub clock

  // Hub state
  let wss: WebSocketServer | null = null;
  const hubClients = new Map<WebSocket, string>(); // ws → terminal name
  const hubTerminalStatuses = new Map<string, LinkStatus>(); // hub-authoritative
  const hubTerminalContexts = new Map<string, ContextSnapshot>(); // hub-authoritative
  const hubTerminalCwds = new Map<string, string>(); // hub-authoritative (excludes self)
  const hubTerminalWorkspaces = new Map<string, string>(); // hub-authoritative (excludes self)
  const hubTerminalBudgets = new Map<string, number>(); // hub-authoritative (excludes self)
  const hubTerminalModels = new Map<string, string>(); // hub-authoritative (excludes self)
  const hubIdleSince = new Map<string, number>(); // hub-authoritative clock (excludes self)

  // Client state
  let ws: WebSocket | null = null;

  // Pending prompt responses (sender waiting for remote answer)
  const pendingPromptResponses = new Map<
    string,
    {
      resolve: (result: {
        content: { type: "text"; text: string }[];
        details: Record<string, unknown>;
      }) => void;
      targetName: string;
      inactivityTimeout: ReturnType<typeof setTimeout>;
      ceilingTimeout: ReturnType<typeof setTimeout>;
      // ADR-0005 §2/§5: pre-dispatch reminder + per-dispatch budget override,
      // both captured at request time (the exchange's checks use the
      // override throughout, including the response readout).
      preDispatchNote: string;
      budgetOverride?: number;
    }
  >();

  // Pending compact responses (sender waiting for remote compaction to finish)
  const pendingCompactResponses = new Map<
    string,
    {
      resolve: (result: {
        content: { type: "text"; text: string }[];
        details: Record<string, unknown>;
      }) => void;
      targetName: string;
      timeout: ReturnType<typeof setTimeout>;
      // ADR-0001: target context readout captured at request time, appended
      // as `before → after` on the success result.
      beforeReadout: string;
      // ADR-0005 §2: pre-dispatch over-budget reminder, captured at request
      // time and prepended to the tool result.
      preDispatchNote: string;
    }
  >();

  // Pending remote prompt (this terminal is executing a prompt for someone else)
  let pendingRemotePrompt: { id: string; from: string } | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  // Pending budget_set / new_request acks (sender side)
  const pendingBudgetResponses = new Map<
    string,
    {
      resolve: (result: {
        content: { type: "text"; text: string }[];
        details: Record<string, unknown>;
      }) => void;
      targetName: string;
      timeout: ReturnType<typeof setTimeout>;
      requested: number | null; // the budget we asked for (null = "off")
    }
  >();
  const pendingNewResponses = new Map<
    string,
    {
      resolve: (result: {
        content: { type: "text"; text: string }[];
        details: Record<string, unknown>;
      }) => void;
      targetName: string;
      timeout: ReturnType<typeof setTimeout>;
      // ADR-0005 §2: pre-dispatch over-budget reminder, prepended to the ok result.
      preDispatchNote: string;
    }
  >();

  // Inbox: idle-gated batched delivery for triggerTurn:true messages
  const inbox: { from: string; content: string }[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  // ADR-0001: status-channel send-side event model state.
  // Debounce: trailing-edge timer for pushStatus; arms/re-arms when a
  // non-force push happens within STATUS_DEBOUNCE_MS of the last actual send,
  // firing the latest derived state at the window edge. force=true bypasses
  // and cancels any pending timer.
  let statusDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastStatusSendAt = 0;
  // Heartbeat: unconditional pushStatus(true) every HEARTBEAT_INTERVAL_MS
  // while connected. Bounds peer-cache staleness (idle growth) and doubles as
  // a liveness signal. Runs in both hub and client roles; no overlap with the
  // remote-prompt keepalive (they coexist; force pushes dedupe by time).
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // ── Helpers ──────────────────────────────────────────────────────────────

  function getUi() {
    if (!ctx) return null;
    try {
      return ctx.ui;
    } catch {
      return null;
    }
  }

  function isRuntimeLive() {
    return !disposed && getUi() !== null;
  }

  function notify(message: string, level: "info" | "warning" | "error") {
    getUi()?.notify(message, level);
  }

  function updateStatus() {
    const ui = getUi();
    if (!ui) return;
    const theme = ui.theme;
    const count = connectedTerminals.length;
    const info =
      role === "disconnected"
        ? "link: offline"
        : `link: ${terminalName} (${role}) · ${count} terminal${count !== 1 ? "s" : ""}${workspace ? ` · ws:${workspace}` : ""}`;
    ui.setStatus("link", theme.fg("dim", info));
  }

  function deriveStatus(): LinkStatus {
    if (activeToolName)
      return { kind: "tool", toolName: activeToolName, since: stateSince };
    if (agentRunning) return { kind: "thinking", since: stateSince };
    return { kind: "idle", since: stateSince };
  }

  // ── ADR-0002 config resolution ────────────────────────────────────────
  //
  // Three env + one profiles file (~/.pi/agent/pi-link.json, 0600). The file
  // is the ONLY token source (user ruling: no env-var token override — env
  // is visible in ps). Selection chain:
  //   PI_LINK_PROFILE > profile whose url matches PI_LINK_URL > default > none
  // none (loopback, no token) = byte-identical to pre-ADR-0002 behavior.

  interface ProfileEntry {
    url?: string;
    token?: string;
  }
  interface ProfilesFile {
    profiles?: Record<string, ProfileEntry>;
    default?: string;
  }

  function loadProfilesFile(): ProfilesFile | null {
    try {
      const fs = require("node:fs");
      if (!fs.existsSync(PROFILES_FILE_PATH)) return null;
      const raw = fs.readFileSync(PROFILES_FILE_PATH, "utf8");
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed.profiles === undefined ||
          (typeof parsed.profiles === "object" && parsed.profiles !== null))
      )
        return parsed as ProfilesFile;
      return null;
    } catch {
      return null; // malformed/unreadable → treat as no profiles
    }
  }

  // Host of a ws/wss URL, or null if unparseable. "localhost"/"127.0.0.1"/"::1"
  // are loopback; everything else (incl. 127.0.0.2) is non-loopback.
  function urlHost(url: string): string | null {
    // Accept "host:port", "ws://host:port", "wss://host:port/path".
    try {
      const u = new URL(url);
      return u.hostname;
    } catch {
      // bare host:port or host
      const m = url.match(/^([^/:]+)(?::\d+)?$/);
      return m ? m[1] : null;
    }
  }

  function isLoopbackHost(host: string): boolean {
    return LOOPBACK_HOSTS.has(host);
  }

  // Resolve the effective hub URL for THIS terminal (client path).
  // PI_LINK_URL env, else default ws://127.0.0.1:9900 (today's behavior).
  function resolveHubUrl(): string {
    return process.env.PI_LINK_URL || `ws://127.0.0.1:${LINK_PORT}`;
  }

  // Resolve hub bind host (hub path). PI_LINK_HOST env, else 127.0.0.1.
  function resolveHubHost(): string {
    return process.env.PI_LINK_HOST || "127.0.0.1";
  }

  // Resolve the token + profile-selected URL for THIS terminal as a client.
  // Returns { url, token } where token is null when no profile resolves
  // (loopback default = unauthenticated). Never throws.
  function resolveClientConfig(): { url: string; token: string | null } {
    const envUrl = process.env.PI_LINK_URL;
    const envProfile = process.env.PI_LINK_PROFILE;
    const profiles = loadProfilesFile();
    const url = resolveHubUrl();

    let chosen: ProfileEntry | undefined;
    // 1. PI_LINK_PROFILE explicit
    if (envProfile && profiles?.profiles?.[envProfile])
      chosen = profiles.profiles[envProfile];
    // 2. profile whose url matches PI_LINK_URL
    if (!chosen && envUrl && profiles?.profiles) {
      for (const [, p] of Object.entries(profiles.profiles)) {
        if (p.url && urlHost(p.url) === urlHost(envUrl) && p.url === envUrl)
          chosen = p;
      }
    }
    // 3. default
    if (!chosen && profiles?.default && profiles.profiles?.[profiles.default])
      chosen = profiles.profiles[profiles.default];

    const token = chosen?.token ?? null;
    return { url, token };
  }

  // Resolve the token for the hub (this machine binds). Used for fail-closed
  // check + register verification. Token from profiles file only; env override
  // deliberately absent (user ruling). Returns null when no profile resolves.
  function resolveHubToken(): string | null {
    const profiles = loadProfilesFile();
    const envProfile = process.env.PI_LINK_PROFILE;
    let chosen: ProfileEntry | undefined;
    if (envProfile && profiles?.profiles?.[envProfile])
      chosen = profiles.profiles[envProfile];
    if (!chosen && profiles?.default && profiles.profiles?.[profiles.default])
      chosen = profiles.profiles[profiles.default];
    return chosen?.token ?? null;
  }

  // sha256 digest of a token, as a 32-byte Buffer. Used for timing-safe
  // compare (equalizes length — a raw timingSafeEqual on unequal-length
  // inputs throws, and comparing pre-hashes avoids length-leak).
  function tokenDigest(token: string): Buffer {
    return crypto.createHash("sha256").update(token, "utf8").digest();
  }

  function captureContext(): ContextSnapshot | undefined {
    if (!ctx) return undefined;
    if (typeof ctx.getContextUsage !== "function") return undefined; // older Pi
    const usage = ctx.getContextUsage();
    if (!usage) return undefined;
    if (usage.contextWindow <= 0) return undefined; // no real context to report
    return { tokens: usage.tokens, contextWindow: usage.contextWindow };
  }

  function pushStatus(force = false) {
    if (role === "disconnected") return;

    // ADR-0001: force bypasses debounce and dedup; cancels any pending timer.
    if (force) {
      if (statusDebounceTimer) {
        clearTimeout(statusDebounceTimer);
        statusDebounceTimer = null;
      }
      doSendStatus();
      return;
    }

    // Non-force: existing kind/tool dedup stays. Intermediate states are
    // dropped (status is absolute, not incremental).
    const status = deriveStatus();
    const newKind = status.kind;
    const newTool = status.kind === "tool" ? status.toolName : null;
    if (newKind === lastPushedKind && newTool === lastPushedTool) return;

    // Trailing-edge debounce: if <1s since last actual send, arm/re-arm a
    // single timer that sends the latest derived state at the window edge.
    const elapsed = Date.now() - lastStatusSendAt;
    if (elapsed >= STATUS_DEBOUNCE_MS) {
      doSendStatus();
      return;
    }
    if (statusDebounceTimer) clearTimeout(statusDebounceTimer);
    statusDebounceTimer = setTimeout(() => {
      statusDebounceTimer = null;
      // Re-check dedup at the window edge: state may have reverted to the
      // last-pushed kind/tool since the timer was armed.
      const s = deriveStatus();
      const k = s.kind;
      const t = s.kind === "tool" ? s.toolName : null;
      if (k === lastPushedKind && t === lastPushedTool) return;
      doSendStatus();
    }, STATUS_DEBOUNCE_MS - elapsed);
  }

  /** Encode + transmit a status_update now (no dedup, no debounce). */
  function doSendStatus() {
    const status = deriveStatus();
    lastPushedKind = status.kind;
    lastPushedTool = status.kind === "tool" ? status.toolName : null;
    lastStatusSendAt = Date.now();
    const context = captureContext(); // only when we actually send
    const msg: StatusUpdateMsg = {
      type: "status_update",
      name: terminalName,
      status,
      context: context ?? null, // explicit null tells peers to clear
      budget: declaredBudget,
      model: modelLabel(),
      // ADR-0005 §7: the hub attaches its own idle-since too — clients only
      // learn hub status via this broadcast, so without it the hub's
      // idle-since on peers goes stale after the welcome snapshot.
      ...(role === "hub"
        ? { idleSince: status.kind === "idle" ? stateSince : null }
        : {}),
    };
    if (role === "hub") {
      hubBroadcast(msg, terminalName, terminalName);
    } else if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  // ADR-0001: 60s unconditional heartbeat while connected. Bounds peer-cache
  // staleness at ≤60s (idle growth via steers was previously unbounded) and
  // doubles as a liveness signal. No overlap with the remote-prompt keepalive;
  // they coexist, force pushes dedupe by time. Started on link up for both
  // roles; stopped on disconnect/cleanup.
  function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => pushStatus(true), HEARTBEAT_INTERVAL_MS);
    // unref so it never keeps the event loop alive on its own.
    heartbeatTimer.unref?.();
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  // Canonicalize a link/session name: trim + collapse internal whitespace.
  // Returns undefined for nullish/blank so callers can fall through precedence.
  function normalizeName(name: string | undefined | null): string | undefined {
    const n = name?.trim().replace(/\s+/g, " ");
    return n ? n : undefined;
  }

  // Latest custom session entry of a given type (last-write-wins), or undefined.
  function latestCustomData(
    customType: string,
  ): Record<string, unknown> | undefined {
    if (!ctx) return undefined;
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i] as {
        type: string;
        customType?: string;
        data?: Record<string, unknown>;
      };
      if (e.type === "custom" && e.customType === customType) return e.data;
    }
    return undefined;
  }

  function formatDuration(since: number): string {
    const sec = Math.floor((Date.now() - since) / 1000);
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    return `${Math.floor(sec / 3600)}h`;
  }

  function formatStatus(s: LinkStatus): string {
    const dur = formatDuration(s.since);
    if (s.kind === "tool") return `tool:${s.toolName} (${dur})`;
    return `${s.kind} (${dur})`;
  }

  function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1000)}K`;
    return `${n}`;
  }

  // ADR-0005: parse a budget value — plain tokens ("56000", 56000) or
  // k-suffix ("56k"/"56K" = 56_000). Undefined = invalid.
  function parseBudget(raw: unknown): number | undefined {
    if (typeof raw === "number")
      return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
    if (typeof raw !== "string") return undefined;
    const m = raw.trim().match(/^(\d+)([kK])?$/);
    if (!m) return undefined;
    const n = parseInt(m[1], 10);
    return n > 0 ? (m[2] ? n * 1000 : n) : undefined;
  }

  // ADR-0005 §6: raw provider/model-id:thinkingLevel. Display may shorten.
  function modelLabel(): string | null {
    const m = ctx?.model;
    if (!m) return null;
    return `${m.provider}/${m.id}:${ctx?.thinkingLevel ?? "off"}`;
  }

  function formatContext(c: ContextSnapshot | null | undefined): string {
    if (!c || c.contextWindow <= 0) return ""; // guard against bad wire data
    const window = formatTokens(c.contextWindow);
    if (c.tokens === null) return `?/${window}`;
    const percent = Math.round((c.tokens / c.contextWindow) * 100);
    return `${formatTokens(c.tokens)}/${window} (${percent}%)`;
  }

  function getDeclaredBudgetFor(name: string): number | null {
    if (name === terminalName) return declaredBudget;
    const map = role === "hub" ? hubTerminalBudgets : terminalBudgets;
    return map.get(name) ?? null;
  }

  function getModelFor(name: string): string | null {
    if (name === terminalName) return modelLabel();
    const map = role === "hub" ? hubTerminalModels : terminalModels;
    return map.get(name) ?? null;
  }

  function getIdleSinceFor(name: string): number | null {
    if (name === terminalName) {
      return deriveStatus().kind === "idle" ? stateSince : null;
    }
    const map = role === "hub" ? hubIdleSince : terminalIdleSince;
    return map.get(name) ?? null;
  }

  // ADR-0005 §1: the one compaction-decision axis. Over budget ⇔
  // tokens ≥ budget, where budget = declared ?? window − reserve (the
  // reserve keeps exactly the retired hot-terminal semantics as the default).
  // overrideBudget = per-dispatch budget (§5): replaces the declared value
  // for this exchange's check only, never mutates it. Null when tokens
  // unknown or not over.
  function overBudget(
    name: string,
    overrideBudget?: number,
  ): { tokens: number; budget: number } | null {
    const c = getContextFor(name);
    if (!c || c.tokens === null || c.contextWindow <= 0) return null;
    const budget =
      overrideBudget ??
      getDeclaredBudgetFor(name) ??
      c.contextWindow - DEFAULT_BUDGET_RESERVE;
    return c.tokens >= budget ? { tokens: c.tokens, budget } : null;
  }

  // ADR-0005 §2: the one blunt verdict line. Sender-side surfaces only —
  // nothing is injected into the receiver's context.
  function budgetReminder(name: string, overrideBudget?: number): string {
    if (name === "*") return ""; // broadcast: no readout
    const hit = overBudget(name, overrideBudget);
    if (!hit) return "";
    return `⚠ "${name}" over budget: ${formatTokens(hit.tokens)}/${formatTokens(hit.budget)} — decide whether to link_compact (or link_new)`;
  }

  // ADR-0005 §5: dispatch budget and declared budget disagree → one-line
  // notice showing both values (a signal for the user, not auto-resolved).
  function budgetMismatchNotice(name: string, dispatchBudget?: number): string {
    if (name === "*" || dispatchBudget === undefined) return "";
    const declared = getDeclaredBudgetFor(name);
    if (declared === null || declared === dispatchBudget) return "";
    return `budget mismatch: dispatch ${formatTokens(dispatchBudget)} vs "${name}" declared ${formatTokens(declared)} (dispatch value used for this exchange only)`;
  }

  // ADR-0001 decision-point readout for tool results. Full absolute form —
  // never percent alone. Returns "" when the target has no cache entry or
  // unknown tokens (omit silently). Broadcast target ("*") never gets a
  // readout. The over-budget verdict is budgetReminder's job, not this one's.
  function contextReadout(name: string): string {
    if (name === "*") return ""; // broadcast: no readout
    const c = getContextFor(name);
    if (!c || c.tokens === null) return ""; // missing cache / unknown — omit
    return formatContext(c);
  }

  function getStatusFor(name: string): LinkStatus | null {
    if (name === terminalName) return deriveStatus();
    const map = role === "hub" ? hubTerminalStatuses : terminalStatuses;
    return map.get(name) ?? null;
  }

  function getCwdFor(name: string): string | null {
    if (name === terminalName) return currentCwd || null;
    if (role === "hub") return hubTerminalCwds.get(name) ?? null;
    return terminalCwds.get(name) ?? null;
  }

  function getContextFor(name: string): ContextSnapshot | null {
    if (name === terminalName) return captureContext() ?? null;
    if (role === "hub") return hubTerminalContexts.get(name) ?? null;
    return terminalContexts.get(name) ?? null;
  }

  function shortenPath(cwd: string): string {
    const home = os.homedir().replace(/\\/g, "/");
    const normalized = cwd.replace(/\\/g, "/");
    if (normalized === home) return "~";
    if (normalized.startsWith(home + "/"))
      return "~" + normalized.slice(home.length);
    return normalized;
  }

  // ── Startup connect ──────────────────────────────────────────────────────

  function scheduleStartupConnect() {
    if (startupConnectTimer) clearTimeout(startupConnectTimer);
    startupConnectTimer = setTimeout(() => {
      startupConnectTimer = null;
      if (!disposed && ctx) initialize();
    }, 0);
  }

  // ── Inbox: idle-gated batched delivery ───────────────────────────────────

  function scheduleFlush(delay: number) {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushInbox, delay);
  }

  function flushInbox() {
    flushTimer = null;
    if (inbox.length === 0) return;
    if (!ctx) return;

    // Only deliver when idle so triggerTurn takes the prompt-start path
    // instead of mid-run steering, avoiding async delivery loss.
    let idle: boolean;
    try {
      idle = ctx.isIdle();
    } catch {
      return; // stale context — bail without retry
    }
    if (!idle) {
      scheduleFlush(IDLE_RETRY_MS);
      return;
    }

    // Select batch: up to BATCH_MAX_ITEMS, ~BATCH_MAX_CHARS total (soft cap —
    // first item always included even if oversized, others deferred to next flush)
    const batch: string[] = [];
    let totalChars = 0;
    for (let i = 0; i < inbox.length && batch.length < BATCH_MAX_ITEMS; i++) {
      const item = inbox[i];
      // ADR-0005 §2: reminders are sender-side only — nothing is injected
      // into the receiver's context here.
      const text = `From "${item.from}":\n${item.content}`;
      if (batch.length > 0 && totalChars + text.length > BATCH_MAX_CHARS) break;
      batch.push(text);
      totalChars += text.length;
    }

    pi.sendMessage(
      {
        customType: "link",
        content: `[Link: ${batch.length} message(s) received]\n\n${batch.join("\n\n")}`,
        display: true,
        details: { batched: true, count: batch.length },
      },
      { triggerTurn: true },
    );
    inbox.splice(0, batch.length);

    // Reschedule if inbox still has items; agent_end wakeup will usually beat this
    if (inbox.length > 0) {
      scheduleFlush(IDLE_RETRY_MS);
    }
  }

  // ── Connection intent ──────────────────────────────────────────────────

  function shouldConnect(): boolean {
    const data = latestCustomData("link-active") as
      | { active?: boolean }
      | undefined;
    if (data?.active !== undefined) return data.active;
    return pi.getFlag("link") === true;
  }

  // ── Pending prompt helpers ───────────────────────────────────────────────

  function cleanupPending(requestId: string) {
    const pending = pendingPromptResponses.get(requestId);
    if (!pending) return null;
    clearTimeout(pending.inactivityTimeout);
    clearTimeout(pending.ceilingTimeout);
    pendingPromptResponses.delete(requestId);
    return pending;
  }

  function cleanupPendingCompact(requestId: string) {
    const pending = pendingCompactResponses.get(requestId);
    if (!pending) return null;
    clearTimeout(pending.timeout);
    pendingCompactResponses.delete(requestId);
    return pending;
  }

  function makeInactivityTimeout(requestId: string, targetName: string) {
    return setTimeout(() => {
      const pending = cleanupPending(requestId);
      if (pending) {
        pending.resolve(
          textResult(
            `Prompt to "${targetName}" timed out (no activity for ${PROMPT_INACTIVITY_MS / 1000}s)`,
            { to: targetName, error: "timeout" },
          ),
        );
      }
    }, PROMPT_INACTIVITY_MS);
  }

  function resetInactivityFor(targetName: string) {
    for (const [id, pending] of pendingPromptResponses) {
      if (pending.targetName === targetName) {
        clearTimeout(pending.inactivityTimeout);
        pending.inactivityTimeout = makeInactivityTimeout(id, targetName);
      }
    }
  }

  function allTerminalNames(): Set<string> {
    const names = new Set<string>();
    names.add(terminalName); // hub's own name
    for (const name of hubClients.values()) names.add(name);
    return names;
  }

  function uniqueName(requested: string): string {
    const existing = allTerminalNames();
    if (!existing.has(requested)) return requested;
    let i = 2;
    while (existing.has(`${requested}-${i}`)) i++;
    return `${requested}-${i}`;
  }

  function terminalList(): string[] {
    return Array.from(allTerminalNames()).sort();
  }

  // ── ADR-0004 visible set ──────────────────────────────────────────────

  // Visible-set rule: viewer sees target iff either is a global observer
  // (no workspace) or both share a workspace. Symmetric. (Named canSee —
  // `ws` already means WebSocket throughout this file.)
  function canSee(
    viewerWs: string | undefined,
    targetWs: string | undefined,
  ): boolean {
    return !viewerWs || !targetWs || viewerWs === targetWs;
  }

  // Hub-side workspace of any terminal (hub's own included). undefined =
  // global observer. Callers must check existence separately — unknown names
  // also yield undefined, so never use this alone as an existence check.
  function hubWorkspaceOf(name: string): string | undefined {
    return name === terminalName
      ? (workspace ?? undefined)
      : hubTerminalWorkspaces.get(name);
  }

  // Hub: sorted names visible to `viewer` (viewer included).
  function hubVisibleNames(viewer: string): string[] {
    const v = hubWorkspaceOf(viewer);
    return terminalList().filter((n) => canSee(v, hubWorkspaceOf(n)));
  }

  function safeParse(data: string): LinkMessage | null {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  // ── Routing ──────────────────────────────────────────────────────────────

  /** Hub: broadcast a message to every terminal except `excludeName` that can
   *  see `subject` (ADR-0004 visible set). terminal_joined/left get a
   *  recipient-scoped `terminals` array — no cross-group name leaks via
   *  membership lists. */
  function hubBroadcast(msg: LinkMessage, subject: string, excludeName?: string) {
    const subjectWs = hubWorkspaceOf(subject);
    // Membership events get per-recipient `terminals` arrays; every other
    // type serializes once (ADR-0001 §6 serialize-once-write-N preserved).
    const shared =
      msg.type === "terminal_joined" || msg.type === "terminal_left"
        ? null
        : JSON.stringify(msg);
    for (const [clientWs, name] of hubClients) {
      if (name === excludeName) continue;
      if (!canSee(hubWorkspaceOf(name), subjectWs)) continue;
      clientWs.send(shared ?? JSON.stringify(scopedForRecipient(msg, name)));
    }
    // Also deliver to the hub itself (unless excluded or out of the visible set)
    if (
      excludeName !== terminalName &&
      canSee(workspace ?? undefined, subjectWs)
    )
      handleIncoming(shared ? msg : scopedForRecipient(msg, terminalName));
  }

  /** Per-recipient view of a broadcast message: membership events carry the
   *  recipient's own visible set, everything else goes out as-is. */
  function scopedForRecipient(msg: LinkMessage, recipient: string): LinkMessage {
    if (msg.type === "terminal_joined" || msg.type === "terminal_left") {
      return { ...msg, terminals: hubVisibleNames(recipient) };
    }
    return msg;
  }

  /** Hub: find a client WebSocket by name. */
  function hubClientByName(name: string): WebSocket | undefined {
    for (const [clientWs, n] of hubClients) {
      if (n === name) return clientWs;
    }
    return undefined;
  }

  /**
   * Route a message to its destination. Works in both hub and client roles.
   * Returns true if the message was delivered (or sent to the hub for routing).
   * For the hub, this is authoritative. For clients, it's optimistic (hub may
   * still reject via protocol-level error responses).
   */
  function routeMessage(
    msg:
      | ChatMsg
      | PromptRequestMsg
      | PromptResponseMsg
      | CompactRequestMsg
      | CompactResponseMsg
      | BudgetSetMsg
      | BudgetResponseMsg
      | NewRequestMsg
      | NewResponseMsg,
  ): boolean {
    if (role === "hub") {
      if (msg.to === "*") {
        // ADR-0004: from scoped → own group + global observers; from a
        // global observer → everyone.
        hubBroadcast(msg, msg.from, msg.from);
        return true;
      }
      // ADR-0004: cross-group direct addressing is not_found at the hub.
      // Existence is checked before visibility — hubWorkspaceOf on an unknown
      // name yields undefined, which canSee would read as a global observer.
      if (msg.to === terminalName) {
        if (canSee(hubWorkspaceOf(msg.from), workspace ?? undefined)) {
          handleIncoming(msg);
          return true;
        }
      } else {
        const targetSock = hubClientByName(msg.to);
        if (
          targetSock &&
          canSee(hubWorkspaceOf(msg.from), hubWorkspaceOf(msg.to))
        ) {
          targetSock.send(JSON.stringify(msg));
          return true;
        }
      }
      // Target not found — send error back to sender
      const errText = `Terminal "${msg.to}" not found`;
      let errorMsg: LinkMessage;
      if (msg.type === "prompt_request") {
        errorMsg = {
          type: "prompt_response",
          id: msg.id,
          from: terminalName,
          to: msg.from,
          response: "",
          error: errText,
        };
      } else if (msg.type === "compact_request") {
        errorMsg = {
          type: "compact_response",
          id: msg.id,
          from: terminalName,
          to: msg.from,
          ok: false,
          reason: "not_found",
        };
      } else if (msg.type === "budget_set") {
        errorMsg = {
          type: "budget_response",
          id: msg.id,
          from: terminalName,
          to: msg.from,
          ok: false,
          reason: "not_found",
        };
      } else if (msg.type === "new_request") {
        errorMsg = {
          type: "new_response",
          id: msg.id,
          from: terminalName,
          to: msg.from,
          ok: false,
          reason: "not_found",
        };
      } else {
        errorMsg = { type: "error", message: errText };
      }

      if (msg.from === terminalName) {
        // For request/response pairs, deliver the error response locally so
        // the matching pending map resolves. For chat, skip — the tool
        // result (via return false) is sufficient; no extra UI toast.
        if (errorMsg.type !== "error") handleIncoming(errorMsg);
      } else {
        hubClientByName(msg.from)?.send(JSON.stringify(errorMsg));
      }
      return false;
    }
    if (role === "client" && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true; // optimistic — hub will handle errors via protocol
    }
    return false;
  }

  // ── Incoming message handler (runs on every terminal) ────────────────────

  function handleIncoming(msg: LinkMessage) {
    switch (msg.type) {
      // ── Client receives after registering ──
      case "welcome":
        // ADR-0005 §8: version gate FIRST — missing/mismatched echo → refuse
        // membership loudly, stop auto-reconnect (authFailed pattern). One
        // mechanism replaces per-field compatibility reasoning: below this
        // line every v2 field is guaranteed present.
        if (msg.version !== LINK_PROTOCOL_VERSION) {
          versionRejected = true;
          notify(
            `Link hub protocol version mismatch (hub: ${msg.version ?? "none"}, here: v${LINK_PROTOCOL_VERSION} — the fleet upgrades together). Disconnecting; auto-reconnect stopped. /link-connect to retry.`,
            "error",
          );
          ws?.close();
          break;
        }
        // ADR-0004 fail-closed handshake: we requested a workspace but the
        // hub's echo is missing or mismatched → the hub cannot honor
        // isolation (e.g. an old hub). Refuse membership: disconnect, loud
        // notify, stop auto-reconnect via the authFailed pattern. Isolation
        // is honored or membership is refused — no warning-only mode.
        if (workspace && msg.workspace !== workspace) {
          workspaceRejected = true;
          notify(
            `Link hub did not honor workspace "${workspace}" (echo: ${msg.workspace ? `"${msg.workspace}"` : "none"} — upgrade the hub first). Disconnecting; auto-reconnect stopped. /link-connect to retry.`,
            "error",
          );
          ws?.close();
          break;
        }
        terminalName = msg.name;
        pendingClientRename = false;
        connectedTerminals = msg.terminals;
        terminalStatuses.clear();
        terminalCwds.clear();
        terminalContexts.clear();
        terminalBudgets.clear();
        terminalModels.clear();
        terminalIdleSince.clear();
        if (msg.statuses) {
          for (const [name, status] of Object.entries(msg.statuses)) {
            terminalStatuses.set(name, status);
          }
        }
        if (msg.cwds) {
          for (const [name, cwd] of Object.entries(msg.cwds)) {
            terminalCwds.set(name, cwd);
          }
        }
        if (msg.contexts) {
          for (const [name, c] of Object.entries(msg.contexts)) {
            terminalContexts.set(name, c);
          }
        }
        // ADR-0005 v2 snapshots (guaranteed present past the version gate).
        for (const [name, b] of Object.entries(msg.budgets)) {
          terminalBudgets.set(name, b);
        }
        for (const [name, m] of Object.entries(msg.models)) {
          terminalModels.set(name, m);
        }
        for (const [name, t] of Object.entries(msg.idleSince)) {
          terminalIdleSince.set(name, t);
        }
        updateStatus();
        notify(
          `Joined link as "${terminalName}" (${connectedTerminals.length} online)${workspace ? ` · workspace "${workspace}"` : ""}`,
          "info",
        );
        pushStatus(true);
        startHeartbeat();
        break;

      // ── Membership updates ──
      case "terminal_joined":
        connectedTerminals = msg.terminals;
        if (role !== "hub" && msg.cwd) terminalCwds.set(msg.name, msg.cwd);
        if (role !== "hub" && msg.context)
          terminalContexts.set(msg.name, msg.context);
        updateStatus();
        notify(`"${msg.name}" joined the link`, "info");
        break;

      case "terminal_left":
        connectedTerminals = msg.terminals;
        terminalStatuses.delete(msg.name);
        if (role !== "hub") {
          terminalCwds.delete(msg.name);
          terminalContexts.delete(msg.name);
          terminalBudgets.delete(msg.name);
          terminalModels.delete(msg.name);
          terminalIdleSince.delete(msg.name);
        }
        // Fail any pending prompts/compacts/budgets/news to the departed terminal
        for (const [id, pending] of pendingPromptResponses) {
          if (pending.targetName === msg.name) {
            const p = cleanupPending(id);
            if (p) {
              p.resolve(
                textResult(`Terminal "${msg.name}" disconnected`, {
                  to: msg.name,
                  error: "disconnected",
                }),
              );
            }
          }
        }
        for (const [id, pending] of pendingCompactResponses) {
          if (pending.targetName === msg.name) {
            const p = cleanupPendingCompact(id);
            if (p) {
              p.resolve(
                textResult(`Terminal "${msg.name}" disconnected`, {
                  to: msg.name,
                  error: "disconnected",
                }),
              );
            }
          }
        }
        for (const [id, pending] of pendingBudgetResponses) {
          if (pending.targetName === msg.name) {
            clearTimeout(pending.timeout);
            pendingBudgetResponses.delete(id);
            pending.resolve(
              textResult(`Terminal "${msg.name}" disconnected`, {
                to: msg.name,
                error: "disconnected",
              }),
            );
          }
        }
        for (const [id, pending] of pendingNewResponses) {
          if (pending.targetName === msg.name) {
            clearTimeout(pending.timeout);
            pendingNewResponses.delete(id);
            // ADR-0006: left→joined IS the completion signal for a
            // successful new — the ack already resolved ok. A left arriving
            // while still pending means the target died before acking.
            pending.resolve(
              textResult(`Terminal "${msg.name}" disconnected`, {
                to: msg.name,
                error: "disconnected",
              }),
            );
          }
        }
        updateStatus();
        notify(`"${msg.name}" left the link`, "info");
        break;

      // ── Status update from another terminal ──
      case "status_update":
        terminalStatuses.set(msg.name, msg.status);
        if (msg.context) terminalContexts.set(msg.name, msg.context);
        else if (msg.context === null) terminalContexts.delete(msg.name);
        // ADR-0005 v2 fields (present past the version gate; null = clear).
        if (typeof msg.budget === "number") terminalBudgets.set(msg.name, msg.budget);
        else if (msg.budget === null) terminalBudgets.delete(msg.name);
        if (msg.model) terminalModels.set(msg.name, msg.model);
        else if (msg.model === null) terminalModels.delete(msg.name);
        if (typeof msg.idleSince === "number") terminalIdleSince.set(msg.name, msg.idleSince);
        else if (msg.idleSince === null) terminalIdleSince.delete(msg.name);
        resetInactivityFor(msg.name);
        break;

      // ── Chat message ──
      case "chat":
        if (msg.triggerTurn) {
          inbox.push({ from: msg.from, content: msg.content });
          scheduleFlush(FLUSH_DELAY_MS);
        } else {
          // ADR-0005 §2: no receiver-side annotation — the over-budget
          // reminder lives on the sender's surfaces only.
          pi.sendMessage(
            {
              customType: "link",
              content: msg.content,
              display: true,
              details: { from: msg.from },
            },
            { triggerTurn: false, deliverAs: "steer" },
          );
        }
        break;

      // ── Another terminal asks us to compact our context ──
      case "compact_request": {
        if (agentRunning || pendingRemotePrompt || compactRunning) {
          routeMessage({
            type: "compact_response",
            id: msg.id,
            from: terminalName,
            to: msg.from,
            ok: false,
            reason: "busy",
          });
          break;
        }
        const { id, from } = msg;
        let finished = false;
        const finish = (ok: boolean, reason?: string) => {
          if (finished) return;
          finished = true;
          compactRunning = false;
          routeMessage({
            type: "compact_response",
            id,
            from: terminalName,
            to: from,
            ok,
            reason,
          });
        };
        if (!ctx?.compact) {
          finish(false, "unsupported");
          break;
        }
        compactRunning = true;
        notify(`"${from}" requested compact`, "info");
        // compact() aborts the current turn first, so the busy guard above
        // keeps us from interrupting active work. The runtime guarantees
        // exactly one of onComplete/onError fires, so compactRunning can't
        // get stuck and the sender won't hang.
        try {
          ctx.compact({
            customInstructions: msg.instructions,
            onComplete: () => finish(true),
            onError: (e) =>
              finish(false, e instanceof Error ? e.message : String(e)),
          });
        } catch (e) {
          finish(false, e instanceof Error ? e.message : String(e));
        }
        break;
      }

      // ── Another terminal asks us to run a prompt ──
      case "prompt_request":
        if (agentRunning || pendingRemotePrompt || compactRunning) {
          routeMessage({
            type: "prompt_response",
            id: msg.id,
            from: terminalName,
            to: msg.from,
            response: "",
            error: "Terminal is busy",
          });
        } else {
          pendingRemotePrompt = { id: msg.id, from: msg.from };
          // Keepalive: periodic status push so sender knows we're alive.
          // Keepalive presumes sendUserMessage() starts a run (platform contract);
          // if it ever doesn't, the sender's 30 min hard ceiling is the backstop.
          if (keepaliveTimer) clearInterval(keepaliveTimer);
          keepaliveTimer = setInterval(
            () => pushStatus(true),
            KEEPALIVE_INTERVAL_MS,
          );
          notify(`Running remote prompt from "${msg.from}"`, "info");
          pi.sendUserMessage(
            `[Remote prompt from "${msg.from}"]\n\n${msg.prompt}`,
          );
        }
        break;

      // ── Response to a prompt we sent ──
      case "prompt_response": {
        const pending = cleanupPending(msg.id);
        if (pending) {
          if (msg.error) {
            pending.resolve(
              textResult(`Error from "${msg.from}": ${msg.error}`, {
                from: msg.from,
                error: msg.error,
              }),
            );
          } else {
            // ADR-0001: append final-line readout of the target's context at
            // response time (decision point). Cache freshness is guaranteed by
            // the push-before-response ordering: peer `agent_end` pushes
            // status before emitting `prompt_response`. Full absolute form.
            // Omit silently when the target has no cache entry / unknown
            // tokens. ADR-0005: the over-budget verdict (with any
            // per-dispatch override) rides the same readout line.
            const readout = contextReadout(pending.targetName);
            const reminder = budgetReminder(
              pending.targetName,
              pending.budgetOverride,
            );
            const note = [readout, reminder].filter(Boolean).join(" · ");
            const response = note
              ? `${msg.response}\n[${note}]`
              : msg.response;
            pending.resolve(
              textResult(
                [pending.preDispatchNote, response].filter(Boolean).join("\n"),
                { from: msg.from },
              ),
            );
          }
        }
        break;
      }

      // ── Response to a compact we requested ──
      case "compact_response": {
        const pending = cleanupPendingCompact(msg.id);
        if (pending) {
          // Use the requested target, not msg.from: a hub-synthesized
          // not_found response comes from the hub, not the worker.
          const target = pending.targetName;
          if (msg.ok) {
            // ADR-0001: before (captured at request time) → after (from cache
            // at response time). Missing cache / unknown tokens omit silently.
            const before = pending.beforeReadout;
            const after = contextReadout(target);
            const suffix =
              before || after
                ? ` · ${before || "?"} → ${after || "?"}`
                : "";
            // ADR-0005: pre-dispatch reminder leads; if the target is STILL
            // over budget after compacting, the verdict re-fires.
            const still = budgetReminder(target);
            pending.resolve(
              textResult(
                [pending.preDispatchNote, `Compacted "${target}"${suffix}`, still]
                  .filter(Boolean)
                  .join("\n"),
                { to: target },
              ),
            );
          } else {
            const reason = msg.reason ?? "failed";
            pending.resolve(
              textResult(`Compact on "${target}" not done: ${reason}`, {
                to: target,
                error: reason,
              }),
            );
          }
        }
        break;
      }

      // ── Another terminal sets our context budget (ADR-0005 §4) ──
      case "budget_set": {
        // A threshold, not a membership invariant — runtime mutation is safe
        // (contrast workspace, fixed for life). No extra authorization: link
        // membership is already full power (ADR-0002). Wire values still pass
        // the same validator as the tool path (positive integers only).
        declaredBudget = parseBudget(msg.budget) ?? null;
        pi.appendEntry("link-budget", { budget: declaredBudget });
        pushStatus(true); // immediate status_update so peers see the new value
        routeMessage({
          type: "budget_response",
          id: msg.id,
          from: terminalName,
          to: msg.from,
          ok: true,
        });
        notify(
          `"${msg.from}" set context budget to ${declaredBudget !== null ? formatTokens(declaredBudget) : "default"}`,
          "info",
        );
        break;
      }

      // ── Response to a budget set we requested ──
      case "budget_response": {
        const pending = pendingBudgetResponses.get(msg.id);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingBudgetResponses.delete(msg.id);
          const target = pending.targetName;
          if (msg.ok) {
            const what =
              pending.requested !== null
                ? formatTokens(pending.requested)
                : "default";
            pending.resolve(
              textResult(`Budget on "${target}" set to ${what}`, {
                to: target,
              }),
            );
          } else {
            const reason = msg.reason ?? "failed";
            pending.resolve(
              textResult(`Budget set on "${target}" not done: ${reason}`, {
                to: target,
                error: reason,
              }),
            );
          }
        }
        break;
      }

      // ── Another terminal asks us to start a fresh session (ADR-0006) ──
      case "new_request": {
        // Busy guard identical to link_compact: mid-turn, pending remote
        // prompt, or compacting → decline; retry when idle.
        if (agentRunning || pendingRemotePrompt || compactRunning) {
          routeMessage({
            type: "new_response",
            id: msg.id,
            from: terminalName,
            to: msg.from,
            ok: false,
            reason: "busy",
          });
          break;
        }
        // ADR-0006 §3: ack BEFORE teardown — session replacement kills this
        // socket and this extension instance; the responder ceases to exist.
        // The ack carries oldSessionId (resurrection metadata; pi never
        // deletes session files, so "new" destroys nothing on disk).
        const oldSessionId = ctx?.sessionManager.getSessionId();
        routeMessage({
          type: "new_response",
          id: msg.id,
          from: terminalName,
          to: msg.from,
          ok: true,
          oldSessionId,
        });
        notify(`"${msg.from}" requested a fresh session`, "info");
        // ctx.newSession() lives on the COMMAND context only (event/tool
        // contexts lack session-control methods). Routing through a
        // registered command — sendUserMessage with expandPromptTemplates:
        // true hits pi's extension-command interception — runs our handler
        // with a command ctx. Command handlers manage their own LLM
        // interaction, so no prompt reaches the agent.
        newNowExpected = true;
        pi.sendUserMessage("/link-new-now", { expandPromptTemplates: true });
        break;
      }

      // ── Response to a fresh-session request we sent ──
      case "new_response": {
        const pending = pendingNewResponses.get(msg.id);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingNewResponses.delete(msg.id);
          const target = pending.targetName;
          if (msg.ok) {
            // Completion = observing terminal_left → terminal_joined for the
            // same name (the ack arrives before teardown by design).
            pending.resolve(
              textResult(
                [
                  pending.preDispatchNote,
                  `Fresh session on "${target}" acknowledged (old session ${msg.oldSessionId ?? "unknown"}) — it will leave and rejoin under the same name`,
                ]
                  .filter(Boolean)
                  .join("\n"),
                { to: target, oldSessionId: msg.oldSessionId },
              ),
            );
          } else {
            const reason = msg.reason ?? "failed";
            pending.resolve(
              textResult(`Fresh session on "${target}" not done: ${reason}`, {
                to: target,
                error: reason,
              }),
            );
          }
        }
        break;
      }

      case "error":
        notify(`Link: ${msg.message}`, "error");
        // ADR-0002: hub sends an auth-rejection error before closing on
        // bad/missing token. Flag it so the close handler stops auto-reconnect
        // (auth rejection ≠ hub loss).
        if (/auth rejected/i.test(msg.message)) {
          authFailed = true;
        }
        // ADR-0005 §8: hub-side version gate rejects with an error before
        // close — flag it so the close handler stops auto-reconnect.
        if (/protocol version rejected/i.test(msg.message)) {
          versionRejected = true;
        }
        break;
    }
  }

  // ── Hub: handle a new client WebSocket ───────────────────────────────────

  function hubHandleClient(clientWs: WebSocket) {
    let clientName = "";

    clientWs.on("message", (raw) => {
      if (!isRuntimeLive()) return;
      const msg = safeParse(raw.toString());
      if (!msg) return;

      // First message must be register
      if (msg.type === "register") {
        if (clientName) return; // already registered — ignore duplicate

        // ADR-0005 §8: version gate before anything else. Missing/mismatched
        // → error + close (the client's error handler stops auto-reconnect).
        if (msg.version !== LINK_PROTOCOL_VERSION) {
          clientWs.send(
            JSON.stringify({
              type: "error",
              message: `Link protocol version rejected: hub speaks v${LINK_PROTOCOL_VERSION}, register had ${msg.version ?? "none"} — the fleet upgrades together`,
            } satisfies ErrorMsg),
          );
          notify(
            `Rejected link register (protocol version ${msg.version ?? "none"} ≠ v${LINK_PROTOCOL_VERSION})`,
            "error",
          );
          clientWs.close();
          return;
        }

        // ADR-0002: uniform auth when the hub has a token (resolved in
        // startHub). Loopback clients also authenticate — one code path,
        // local terminals read the same profiles file. Verify BEFORE
        // welcome/joined broadcast so an unauthenticated client never learns
        // fleet state. Compare sha256 digests via timingSafeEqual (equalizes
        // length; never log the token itself).
        if (resolvedToken) {
          const clientToken = msg.token;
          let authorized = false;
          if (clientToken) {
            const a = tokenDigest(clientToken);
            const b = tokenDigest(resolvedToken);
            authorized =
              a.length === b.length &&
              crypto.timingSafeEqual(a, b);
          }
          if (!authorized) {
            const remote =
              (clientWs as any & { _socket?: { remoteAddress?: string } })
                ?._socket?.remoteAddress ?? "unknown";
            const reason = clientToken
              ? "token mismatch"
              : "missing token";
            clientWs.send(
              JSON.stringify({
                type: "error",
                message: `Link auth rejected: ${reason}`,
              } satisfies ErrorMsg),
            );
            notify(
              `Rejected link register from ${remote} (${reason})`,
              "error",
            );
            clientWs.close();
            return;
          }
        }

        clientName = uniqueName(msg.name);
        hubClients.set(clientWs, clientName);
        // ADR-0004: record the declared workspace (absent = global observer).
        const clientWorkspace = normalizeName(msg.workspace);
        if (clientWorkspace)
          hubTerminalWorkspaces.set(clientName, clientWorkspace);
        // ADR-0005 v2: declared budget + model (null = default/none).
        if (typeof msg.budget === "number")
          hubTerminalBudgets.set(clientName, msg.budget);
        if (msg.model) hubTerminalModels.set(clientName, msg.model);
        // ADR-0005 §7: a freshly registered terminal is idle — start its
        // idle-since clock (hub-authoritative).
        hubIdleSince.set(clientName, Date.now());
        if (msg.cwd) hubTerminalCwds.set(clientName, msg.cwd);
        if (msg.context) hubTerminalContexts.set(clientName, msg.context);
        // ADR-0004: the joiner's welcome snapshot is cut to its visible set.
        const visibleNames = hubVisibleNames(clientName);
        const visible = new Set(visibleNames);
        connectedTerminals = hubVisibleNames(terminalName);
        updateStatus();

        // Confirm to the new client (include status + cwd snapshots, visible
        // set only — no cross-group leaks via the welcome payload)
        const statuses: Record<string, LinkStatus> = {};
        if (visible.has(terminalName)) {
          statuses[terminalName] = deriveStatus(); // hub's own status
        }
        for (const [name, status] of hubTerminalStatuses) {
          if (name !== clientName && visible.has(name)) statuses[name] = status;
        }
        const cwds: Record<string, string> = {};
        if (visible.has(terminalName) && currentCwd) {
          cwds[terminalName] = currentCwd; // hub's own cwd
        }
        for (const [name, cwd] of hubTerminalCwds) {
          if (name !== clientName && visible.has(name)) cwds[name] = cwd;
        }
        const contexts: Record<string, ContextSnapshot> = {};
        const hubContext = captureContext();
        if (hubContext && visible.has(terminalName)) {
          contexts[terminalName] = hubContext; // hub's own context
        }
        for (const [name, c] of hubTerminalContexts) {
          if (name !== clientName && visible.has(name)) contexts[name] = c;
        }
        // ADR-0005 v2 snapshots, same visible-set cut.
        const budgets: Record<string, number> = {};
        if (declaredBudget !== null && visible.has(terminalName)) {
          budgets[terminalName] = declaredBudget;
        }
        for (const [name, b] of hubTerminalBudgets) {
          if (name !== clientName && visible.has(name)) budgets[name] = b;
        }
        const models: Record<string, string> = {};
        const hubModel = modelLabel();
        if (hubModel && visible.has(terminalName)) {
          models[terminalName] = hubModel;
        }
        for (const [name, m] of hubTerminalModels) {
          if (name !== clientName && visible.has(name)) models[name] = m;
        }
        const idleSinceRec: Record<string, number> = {};
        if (
          visible.has(terminalName) &&
          deriveStatus().kind === "idle"
        ) {
          idleSinceRec[terminalName] = stateSince;
        }
        for (const [name, t] of hubIdleSince) {
          if (name !== clientName && visible.has(name)) idleSinceRec[name] = t;
        }
        clientWs.send(
          JSON.stringify({
            type: "welcome",
            name: clientName,
            terminals: visibleNames,
            statuses,
            cwds,
            contexts,
            budgets,
            models,
            idleSince: idleSinceRec,
            // ADR-0005 §8: echo the protocol version — the gate the client
            // checks before anything else.
            version: LINK_PROTOCOL_VERSION,
            // ADR-0004: echo the effective workspace — an effective-value
            // readback (the version gate is the compatibility mechanism).
            ...(clientWorkspace ? { workspace: clientWorkspace } : {}),
          } satisfies WelcomeMsg),
        );

        // Notify everyone in the joiner's visible set (include joiner's cwd +
        // context; `terminals` is scoped per recipient inside hubBroadcast)
        const joined: TerminalJoinedMsg = {
          type: "terminal_joined",
          name: clientName,
          terminals: [],
          cwd: msg.cwd,
          context: msg.context,
        };
        hubBroadcast(joined, clientName, clientName);
        return;
      }

      // Ignore messages from unregistered clients
      if (!clientName) return;

      // Status update — store and fan out to other clients only (not back to hub)
      if (msg.type === "status_update") {
        const prevStatus = hubTerminalStatuses.get(clientName);
        hubTerminalStatuses.set(clientName, msg.status);
        // ADR-0005 §7: idle-since on the hub clock — set on busy→idle
        // transitions (register-as-idle already started the clock), cleared
        // while busy.
        if (
          msg.status.kind === "idle" &&
          prevStatus &&
          prevStatus.kind !== "idle"
        )
          hubIdleSince.set(clientName, Date.now());
        else if (msg.status.kind !== "idle") hubIdleSince.delete(clientName);
        // ADR-0005 v2: declared budget + model (null = clear to default/none).
        if (typeof msg.budget === "number")
          hubTerminalBudgets.set(clientName, msg.budget);
        else if (msg.budget === null) hubTerminalBudgets.delete(clientName);
        if (msg.model) hubTerminalModels.set(clientName, msg.model);
        else if (msg.model === null) hubTerminalModels.delete(clientName);
        if (msg.context) hubTerminalContexts.set(clientName, msg.context);
        else if (msg.context === null) hubTerminalContexts.delete(clientName);
        resetInactivityFor(clientName);
        // ADR-0005 §9: the hub re-serializes from a whitelist — unlisted
        // fields clients may send are dropped by design.
        const normalized: StatusUpdateMsg = {
          type: "status_update",
          name: clientName,
          status: msg.status,
          context: msg.context, // undefined omitted by JSON; null forwarded to clear
          budget: msg.budget,
          model: msg.model,
          idleSince: hubIdleSince.get(clientName) ?? null,
        };
        const json = JSON.stringify(normalized);
        // ADR-0004: fan out only to clients that can see the updater (also
        // trims the ADR-0001 broadcast bill).
        for (const [otherWs, name] of hubClients) {
          if (
            name !== clientName &&
            canSee(hubWorkspaceOf(name), hubWorkspaceOf(clientName))
          )
            otherWs.send(json);
        }
        return;
      }

      // Route chat / prompt messages.
      // Normalize `from` to the hub's authoritative socket→name mapping,
      // mirroring the status_update path above. Don't trust the client.
      if (
        msg.type === "chat" ||
        msg.type === "prompt_request" ||
        msg.type === "prompt_response" ||
        msg.type === "compact_request" ||
        msg.type === "compact_response" ||
        msg.type === "budget_set" ||
        msg.type === "budget_response" ||
        msg.type === "new_request" ||
        msg.type === "new_response"
      ) {
        routeMessage({ ...msg, from: clientName });
      }
    });

    clientWs.on("close", () => {
      if (disposed) return;
      const name = hubClients.get(clientWs);
      if (!name) return; // already removed (e.g. via disconnect) — ignore stale event
      hubClients.delete(clientWs);
      hubTerminalStatuses.delete(name);
      hubTerminalContexts.delete(name);
      hubTerminalCwds.delete(name);
      hubTerminalBudgets.delete(name);
      hubTerminalModels.delete(name);
      hubIdleSince.delete(name);
      connectedTerminals = hubVisibleNames(terminalName);
      updateStatus();
      const left: TerminalLeftMsg = {
        type: "terminal_left",
        name,
        terminals: [], // scoped per recipient inside hubBroadcast
      };
      // Fan out within the departed terminal's visible set BEFORE deleting its
      // workspace entry — the visibility check still needs it.
      hubBroadcast(left, name, name);
      hubTerminalWorkspaces.delete(name);
    });

    clientWs.on("error", () => {
      clientWs.close();
    });
  }

  // ── Start as hub ─────────────────────────────────────────────────────────

  function startHub(): Promise<boolean> {
    return new Promise((resolve) => {
      const bindHost = resolveHubHost();
      // ADR-0002 fail-closed: non-loopback bind without a resolvable token
      // → refuse to start. Link membership is RCE-equivalent; an unauthenticated
      // public bind is not an allowed state. Explicit reason; do not bind.
      if (!isLoopbackHost(bindHost)) {
        const token = resolveHubToken();
        if (!token) {
          const reason = `Refusing to start hub on non-loopback ${bindHost}:${LINK_PORT} — no token resolvable in ${PROFILES_FILE_PATH}. Set a profile token before exposing the hub.`;
          console.error(`Link: ${reason}`);
          notify(reason, "error");
          resolve(false);
          return;
        }
        // Cache the resolved token for register verification.
        resolvedToken = token;
      } else {
        // Loopback: cache token if a profile resolves one (uniform auth —
        // loopback clients also authenticate when the hub has a token, one code
        // path). Null = unauthenticated loopback (today's behavior).
        resolvedToken = resolveHubToken();
      }

      const server = new WebSocketServer({
        port: LINK_PORT,
        host: bindHost,
      });

      server.on("listening", () => {
        if (disposed) {
          server.close();
          resolve(false);
          return;
        }
        wss = server;
        // If a client `/link-name` was in flight when the previous hub vanished,
        // this terminal is now establishing hub identity, so honor that pending
        // request. Otherwise keep the last hub-assigned identity — don't replay
        // a stale `preferredName` that may already have been deduped.
        if (pendingClientRename && preferredName) terminalName = preferredName;
        pendingClientRename = false;
        role = "hub";
        connectedTerminals = [terminalName];
        updateStatus();
        const authSuffix = resolvedToken ? " (auth: token required)" : "";
        notify(
          `Link hub started on ${bindHost}:${LINK_PORT} as "${terminalName}"${authSuffix}`,
          "info",
        );
        startHeartbeat();
        resolve(true);
      });

      server.on("connection", (clientWs) => {
        if (disposed) {
          clientWs.close();
          return;
        }
        hubHandleClient(clientWs);
      });

      server.on("error", () => {
        // Port in use → someone else is the hub
        resolve(false);
      });
    });
  }

  // ── Connect as client ────────────────────────────────────────────────────

  function connectAsClient(): Promise<boolean> {
    return new Promise((resolve) => {
      // ADR-0002: connect to the resolved hub URL (ws:// or wss:// — the ws
      // library speaks TLS natively). Token from profiles file only.
      const { url, token } = resolveClientConfig();
      resolvedHubUrl = url;
      resolvedToken = token;
      const host = urlHost(url);
      const nonLoopback = host ? !isLoopbackHost(host) : false;
      // Plaintext + token to non-loopback → one loud warning per session
      // (ADR-0002 §1: policy belongs to operators, mechanism to code; not
      // blocked). Fires exactly once (plaintextWarningFired guards reconnects).
      if (
        nonLoopback &&
        token &&
        url.startsWith("ws://") &&
        !plaintextWarningFired
      ) {
        plaintextWarningFired = true;
        notify(
          `Link: sending token over plaintext ws:// to non-loopback ${host} (profile token visible on the wire). Configure wss:// or a TLS-terminating reverse proxy.`,
          "warning",
        );
      }

      const socket = new WebSocket(url);
      let resolved = false;

      socket.on("open", () => {
        if (disposed) {
          socket.close();
          if (!resolved) {
            resolved = true;
            resolve(false);
          }
          return;
        }
        ws = socket;
        role = "client";
        resolved = true;
        // Register with preferred name if available, otherwise current name.
        // ADR-0002: include token when resolved (present = auth; absent =
        // old-hub-compatible unauthenticated). Never log the token.
        socket.send(
          JSON.stringify({
            type: "register",
            name: preferredName ?? terminalName,
            cwd: currentCwd || undefined,
            context: captureContext(),
            // ADR-0005 §8: version gate + v2 fields (null = default/none).
            version: LINK_PROTOCOL_VERSION,
            budget: declaredBudget,
            model: modelLabel(),
            ...(token ? { token } : {}),
            // ADR-0004: declare workspace (absent = global observer).
            ...(workspace ? { workspace } : {}),
          } satisfies RegisterMsg),
        );
        resolve(true);
      });

      socket.on("message", (raw) => {
        if (!isRuntimeLive()) return;
        const msg = safeParse(raw.toString());
        if (msg) handleIncoming(msg);
      });

      socket.on("close", () => {
        ws = null;
        if (disposed) return;
        if (role === "client") {
          role = "disconnected";
          connectedTerminals = [];
          stopHeartbeat();
          updateStatus();

          // ADR-0002: distinguish auth rejection from hub loss. authFailed is
          // set in handleIncoming("error") when the hub sent an auth-rejection
          // error before closing. Rejection stops auto-reconnect (a wrong-token
          // terminal would hammer the hub every 2s); clear, actionable notify
          // pointing at the profiles file. Manual /link-connect resets it.
          // Hub loss keeps today's retry-with-backoff.
          if (authFailed) {
            notify(
              `Link auth rejected by hub (token mismatch or missing). Auto-reconnect stopped. Check ${PROFILES_FILE_PATH}, then /link-connect.`,
              "error",
            );
          } else if (workspaceRejected || versionRejected) {
            // ADR-0004/0005: already notified loudly at the handshake (or via
            // the hub's rejection error); just hold the line — no
            // auto-reconnect (rejection ≠ hub loss).
          } else if (!manuallyDisconnected) {
            notify("Disconnected from link hub", "warning");
            scheduleReconnect();
          }
        }
      });

      socket.on("error", () => {
        if (!resolved) {
          resolved = true;
          resolve(false);
        }
        socket.close();
      });
    });
  }

  // ── Initialize (auto-discover) ──────────────────────────────────────────

  async function initialize() {
    if (disposed) return;

    // Try connecting to an existing hub
    if (await connectAsClient()) return;

    // ADR-0002 B6: a client whose resolved URL is non-loopback never runs
    // startHub — otherwise one hub outage splits the fleet into per-machine
    // islands that all look healthy. Hub loss means reconnect-with-backoff
    // only. Terminals local to the hub machine (loopback URL) keep today's
    // promotion. authFailed never self-promotes either (the rejection was
    // for THIS terminal's token; promoting would bind a hub the same token
    // can't satisfy — and the user must intervene). versionRejected joins
    // the guard (ADR-0005): a terminal the fleet refused for its version
    // must not promote itself into a version-split hub.
    const hubHost = resolvedHubUrl ? urlHost(resolvedHubUrl) : null;
    const nonLoopback = hubHost ? !isLoopbackHost(hubHost) : false;
    if (!nonLoopback && !authFailed && !versionRejected) {
      if (await startHub()) return;
    }

    // Hub not reachable and we cannot (or must not) promote. Retry after delay.
    if (authFailed || versionRejected) {
      // Rejection: do not schedule reconnect (stops the hammer).
      return;
    }
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (disposed || manuallyDisconnected || reconnectTimer) return;
    const delay = RECONNECT_DELAY_MS + Math.random() * 3000;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (role === "disconnected" && !disposed && !manuallyDisconnected)
        initialize();
    }, delay);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  function disconnect() {
    // Clear reconnect timer first to prevent races
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    // ADR-0001: stop heartbeat + debounce timer on disconnect.
    stopHeartbeat();
    if (statusDebounceTimer) {
      clearTimeout(statusDebounceTimer);
      statusDebounceTimer = null;
    }

    // Clean up target-side remote prompt state
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    pendingRemotePrompt = null;
    compactRunning = false;

    // Clean up pending prompts and compacts
    for (const id of [...pendingPromptResponses.keys()]) {
      const pending = cleanupPending(id);
      if (pending) {
        pending.resolve(
          textResult("Link disconnected", { error: "disconnected" }),
        );
      }
    }
    for (const id of [...pendingCompactResponses.keys()]) {
      const pending = cleanupPendingCompact(id);
      if (pending) {
        pending.resolve(
          textResult("Link disconnected", { error: "disconnected" }),
        );
      }
    }
    for (const [id, pending] of pendingBudgetResponses) {
      clearTimeout(pending.timeout);
      pending.resolve(textResult("Link disconnected", { error: "disconnected" }));
      pendingBudgetResponses.delete(id);
    }
    for (const [id, pending] of pendingNewResponses) {
      clearTimeout(pending.timeout);
      pending.resolve(textResult("Link disconnected", { error: "disconnected" }));
      pendingNewResponses.delete(id);
    }

    // Close client connection
    if (ws) {
      ws.close();
      ws = null;
    }

    // Close hub server
    if (wss) {
      for (const clientWs of hubClients.keys()) clientWs.close();
      hubClients.clear();
      wss.close();
      wss = null;
    }

    role = "disconnected";
    connectedTerminals = [];
    terminalStatuses.clear();
    hubTerminalStatuses.clear();
    terminalContexts.clear();
    hubTerminalContexts.clear();
    terminalCwds.clear();
    hubTerminalCwds.clear();
    hubTerminalWorkspaces.clear();
    terminalBudgets.clear();
    terminalModels.clear();
    terminalIdleSince.clear();
    hubTerminalBudgets.clear();
    hubTerminalModels.clear();
    hubIdleSince.clear();
    lastPushedKind = null;
    lastPushedTool = null;
    lastStatusSendAt = 0;
    // ADR-0002: clear resolved client/hub token on disconnect so a fresh
    // connect re-reads the profiles file (token may have been rotated).
    // authFailed is intentionally preserved across disconnect (a rejection
    // means the user must fix the token); only /link-connect clears it.
    resolvedHubUrl = null;
    resolvedToken = null;
    updateStatus();

    // Inbox survives disconnect — messages are local state waiting for local delivery.
    // Ensure pending flush still fires.
    if (inbox.length > 0 && !flushTimer) {
      scheduleFlush(FLUSH_DELAY_MS);
    }
  }

  function cleanup() {
    disposed = true;
    if (startupConnectTimer) {
      clearTimeout(startupConnectTimer);
      startupConnectTimer = null;
    }
    disconnect();
    ctx = undefined;
    // Full teardown: clear inbox and flush timer
    inbox.length = 0;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  // ── Lifecycle events ─────────────────────────────────────────────────────

  pi.on("session_start", async (_event, _ctx) => {
    ctx = _ctx;
    currentCwd = _ctx.cwd;

    // Resolve terminal name. Precedence:
    //   --link-name flag  >  PI_LINK_NAME env  >  saved link-name  >  session name  >  random
    //
    // --link-name is the public CLI surface (link identity only, never touches session name).
    // PI_LINK_NAME is the internal handoff from the `pi-link` wrapper, which DOES
    // seed session name when absent (the wrapper's combined-mode contract).
    // PI_LINK_NAME is consumed once and removed from process.env so spawned children don't inherit it.
    const cliRaw = pi.getFlag("link-name");
    let cliFlagName: string | undefined;
    if (typeof cliRaw === "string") {
      cliFlagName = normalizeName(cliRaw);
      if (!cliFlagName) {
        console.error("Error: --link-name requires a non-empty value.");
        process.exit(1);
      }
    }

    const envRaw = process.env.PI_LINK_NAME;
    delete process.env.PI_LINK_NAME;
    const envFlagName = normalizeName(envRaw);

    const flagName = cliFlagName ?? envFlagName;
    const fromEnv = !cliFlagName && !!envFlagName;

    if (flagName) {
      preferredName = flagName;
      terminalName = flagName;

      // Skip append if the saved name already matches; persistence is needed
      // only for first-time set or actual change. Reduces session-file growth
      // on repeated startups (common in automation).
      const latest = latestCustomData("link-name") as
        | { name?: unknown }
        | undefined;
      const latestSaved =
        typeof latest?.name === "string" ? latest.name : undefined;
      if (normalizeName(latestSaved) !== flagName) {
        pi.appendEntry("link-name", { name: flagName });
      }

      // Critical: only the env path (wrapper combined mode) seeds session name.
      // Public --link-name is link-only.
      if (fromEnv && !pi.getSessionName()) pi.setSessionName(flagName);
    } else {
      const saved = latestCustomData("link-name") as
        | { name?: unknown }
        | undefined;
      const savedName = normalizeName(
        typeof saved?.name === "string" ? saved.name : undefined,
      );
      if (savedName) {
        preferredName = savedName;
        terminalName = preferredName;
      } else {
        const sessionName = normalizeName(pi.getSessionName());
        if (sessionName) terminalName = sessionName;
      }
    }

    // Resolve workspace (ADR-0004). Precedence mirrors link-name:
    //   --link-workspace flag  >  PI_LINK_WORKSPACE env  >  saved link-workspace  >  none (global observer)
    // Fixed at startup — no runtime command, never derived from cwd. Empty
    // after normalize = error (flag) / ignore (env, entry). PI_LINK_WORKSPACE
    // is consumed once and removed so spawned children don't inherit it.
    const workspaceFlagRaw = pi.getFlag("link-workspace");
    let workspaceFlag: string | undefined;
    if (typeof workspaceFlagRaw === "string") {
      workspaceFlag = normalizeName(workspaceFlagRaw);
      if (!workspaceFlag) {
        console.error("Error: --link-workspace requires a non-empty value.");
        process.exit(1);
      }
    }
    const workspaceEnvRaw = process.env.PI_LINK_WORKSPACE;
    delete process.env.PI_LINK_WORKSPACE;
    const workspaceResolved = workspaceFlag ?? normalizeName(workspaceEnvRaw);
    if (workspaceResolved) {
      workspace = workspaceResolved;
      // Skip re-append when the saved entry already matches (same growth
      // guard as link-name).
      const latestWs = latestCustomData("link-workspace") as
        | { workspace?: unknown }
        | undefined;
      const latestSavedWs =
        typeof latestWs?.workspace === "string" ? latestWs.workspace : undefined;
      if (normalizeName(latestSavedWs) !== workspaceResolved) {
        pi.appendEntry("link-workspace", { workspace: workspaceResolved });
      }
    } else {
      const savedWorkspace = latestCustomData("link-workspace") as
        | { workspace?: unknown }
        | undefined;
      workspace =
        normalizeName(
          typeof savedWorkspace?.workspace === "string"
            ? savedWorkspace.workspace
            : undefined,
        ) ?? null;
    }

    // Resolve context budget (ADR-0005 §3). Precedence mirrors link-name:
    //   --link-budget flag  >  PI_LINK_BUDGET env  >  saved link-budget  >  default (window − reserve)
    // Accepts "56k"/"56K"/plain tokens; invalid = error (flag) / ignore
    // (env, entry). PI_LINK_BUDGET is consumed once and removed so spawned
    // children don't inherit it. Runtime-mutable via the link_budget tool.
    const budgetFlagRaw = pi.getFlag("link-budget");
    let budgetFlag: number | undefined;
    if (typeof budgetFlagRaw === "string") {
      budgetFlag = parseBudget(budgetFlagRaw);
      if (budgetFlag === undefined) {
        console.error(
          `Error: --link-budget requires a token count (e.g. 56k or 56000), got "${budgetFlagRaw}".`,
        );
        process.exit(1);
      }
    }
    const budgetEnvRaw = process.env.PI_LINK_BUDGET;
    delete process.env.PI_LINK_BUDGET;
    const budgetResolved = budgetFlag ?? parseBudget(budgetEnvRaw);
    if (budgetResolved !== undefined) {
      declaredBudget = budgetResolved;
      // Skip re-append when the saved entry already matches (same growth
      // guard as link-name).
      const latestBudget = latestCustomData("link-budget") as
        | { budget?: unknown }
        | undefined;
      if (parseBudget(latestBudget?.budget) !== budgetResolved) {
        pi.appendEntry("link-budget", { budget: budgetResolved });
      }
    } else {
      const savedBudget = latestCustomData("link-budget") as
        | { budget?: unknown }
        | undefined;
      declaredBudget = parseBudget(savedBudget?.budget) ?? null;
    }

    if (flagName || shouldConnect()) scheduleStartupConnect();
  });

  pi.on("session_shutdown", async () => {
    cleanup();
  });

  pi.on("agent_start", async () => {
    agentRunning = true;
    activeToolName = null;
    stateSince = Date.now();
    pushStatus();
  });

  pi.on("session_compact", async () => {
    // Tokens just dropped sharply — force a push so peers see the new context.
    pushStatus(true);
  });

  // ADR-0005 §6: the model label rides status_update; re-push on mid-session
  // model (or thinking-level) changes so peers' labels stay current.
  pi.on("model_select", async () => {
    pushStatus(true);
  });

  pi.on("thinking_level_select", async () => {
    pushStatus(true);
  });

  pi.on("tool_execution_start", async (event) => {
    activeToolName = event.toolName;
    stateSince = Date.now();
    pushStatus();
  });

  pi.on("tool_execution_end", async () => {
    activeToolName = null;
    if (agentRunning) stateSince = Date.now();
    pushStatus();
  });

  pi.on("agent_end", async (event) => {
    agentRunning = false;
    activeToolName = null;
    stateSince = Date.now();
    pushStatus();

    // Wake up inbox flush — agent_end fires before finishRun(), so ctx.isIdle()
    // is still false here. scheduleFlush(0) defers to next macrotask when idle.
    if (inbox.length > 0) scheduleFlush(0);

    // If we were running a remote prompt, send the response back
    if (pendingRemotePrompt) {
      const { id, from } = pendingRemotePrompt;
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      pendingRemotePrompt = null;

      // Find the last assistant text in this run
      let responseText = "";
      for (let i = event.messages.length - 1; i >= 0; i--) {
        const msg = event.messages[i];
        if (msg.role === "assistant") {
          responseText = msg.content
            .filter((c: { type: string }) => c.type === "text")
            .map((c: { type: string; text?: string }) => c.text ?? "")
            .join("\n");
          break;
        }
      }

      // ADR-0001: force a status push BEFORE emitting prompt_response. The
      // non-force pushStatus() at the top of this handler may have been
      // swallowed by the trailing-edge debounce (if <1s since the last actual
      // send — the common case at a busy run's tail, where tool_execution_end
      // just pushed). routeMessage(prompt_response) below fires synchronously,
      // so without this force push the response would reach the requester
      // before the freshest status_update, and the link_prompt readout would
      // consume a stale cache entry (the last tool-boundary snapshot) instead
      // of this terminal's just-settled idle state. force bypasses the
      // debounce and cancels any pending timer, restoring the
      // push-before-response ordering guarantee exactly where a waiter
      // consumes it. Cost: at most one extra status_update per remote prompt.
      pushStatus(true);

      routeMessage({
        type: "prompt_response",
        id,
        from: terminalName,
        to: from,
        response: responseText || "(no response)",
      });
    }
  });

  // ── Tool helpers ──────────────────────────────────────────────────────────

  function textResult(text: string, details: Record<string, unknown> = {}) {
    return { content: [{ type: "text" as const, text }], details };
  }

  function notConnectedResult() {
    return textResult("Not connected to link", { error: "not_connected" });
  }

  function truncatePreview(text: string, max = 60) {
    return text.length > max ? text.slice(0, max) + "..." : text;
  }

  // Shared "target not found" result for the send/prompt/compact tools.
  // Returns null when the target is present, so callers can `if (miss) return miss;`.
  function targetNotFound(to: string) {
    return connectedTerminals.includes(to)
      ? null
      : textResult(
          `Terminal "${to}" not found. Connected: ${connectedTerminals.join(", ")}`,
          { to, error: "not_found" },
        );
  }

  // Shared ✓/✗ result renderer for link_send and link_compact.
  function renderIconResult(
    result: { content: { type: string; text?: string }[]; details?: unknown },
    theme: { fg(role: string, text: string): string },
  ) {
    const txt = result.content[0];
    const details = result.details as Record<string, unknown> | undefined;
    const icon = details?.error
      ? theme.fg("error", "✗ ")
      : theme.fg("success", "✓ ");
    return new Text(icon + (txt?.type === "text" ? txt.text : ""), 0, 0);
  }

  // ── Tools ────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "link_send",
    label: "Link Send",
    description: [
      "Send a message to another Pi terminal on the link.",
      'Use to:"*" for broadcast. triggerTurn is required: true wakes the receiver\'s LLM (use to dispatch work); false delivers passively — into the live run if the receiver is busy, or stored-but-not-processed if it is idle (use link_prompt for a guaranteed response, or resend with triggerTurn:true once it wakes).',
    ].join(" "),
    promptSnippet:
      "Send a message to another Pi terminal on the local link network",
    parameters: Type.Object({
      to: Type.String({
        description: 'Target terminal name, or "*" for broadcast',
      }),
      message: Type.String({ description: "Message content" }),
      // ADR-0003: required (no default). The old default:false silently
      // dropped dispatches to idle receivers (steer lands in the session
      // without waking the LLM). Sender must choose per message; LLM
      // callers self-heal via tool-validation error + retry.
      triggerTurn: Type.Boolean({
        description:
          "true wakes the receiver's LLM; false delivers passively (busy = steered into the live run; idle = stored, not processed).",
      }),
      // ADR-0005 §5: optional per-dispatch budget override (tokens). Used
      // for this exchange's over-budget check only; never mutates the
      // target's declared budget. A mismatch notice shows both values.
      budget: Type.Optional(
        Type.Number({
          description:
            "Per-dispatch context budget override in tokens (e.g. 56000); overrides the target's declared budget for this exchange's over-budget check only",
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      if (role === "disconnected") return notConnectedResult();

      // Pre-validate target exists locally (best-effort, catches typos and definitely-absent names)
      if (params.to !== "*") {
        if (params.to === terminalName) {
          return textResult("Cannot send to yourself", {
            to: params.to,
            error: "self_target",
          });
        }
        const miss = targetNotFound(params.to);
        if (miss) return miss;
      }

      const delivered = routeMessage({
        type: "chat",
        from: terminalName,
        to: params.to,
        content: params.message,
        triggerTurn: params.triggerTurn,
      });

      const target = params.to === "*" ? "all terminals" : `"${params.to}"`;
      if (!delivered) {
        return textResult(`Failed to send to ${target}`, {
          to: params.to,
          error: "not_delivered",
        });
      }
      // Hub delivery is authoritative; client delivery is optimistic (hub routes)
      const verb = role === "hub" ? "Sent to" : "Sent to hub for delivery to";
      // ADR-0001/0005 decision point: context readout + blunt over-budget
      // reminder (sender-side only) + per-dispatch mismatch notice.
      // Broadcast ("*") gets no readout; missing cache / unknown tokens omit.
      const readout = contextReadout(params.to);
      const reminder = budgetReminder(params.to, params.budget);
      const mismatch = budgetMismatchNotice(params.to, params.budget);
      // ADR-0003: idle-target warning on a successful direct send with
      // triggerTurn:false. A passive send to an idle receiver is stored but
      // not processed (steer lands in the session without waking the LLM);
      // the warning tells the sender the dispatch may rot. Busy (thinking/tool)
      // or unknown status → no warning (steer into a live run is fine).
      // Broadcast excluded — passive FYI is its designed semantics.
      let idleWarning = "";
      if (params.to !== "*" && !params.triggerTurn) {
        const st = getStatusFor(params.to);
        if (st?.kind === "idle") {
          idleWarning = ` ⚠ "${params.to}" is idle — message stored, not processed; resend with triggerTurn:true or use link_prompt`;
        }
      }
      const suffix = [readout, reminder, mismatch, idleWarning]
        .filter(Boolean)
        .join(" ");
      const suffixStr = suffix ? ` · ${suffix}` : "";
      return textResult(`${verb} ${target}${suffixStr}`, {
        to: params.to,
        triggerTurn: params.triggerTurn,
      });
    },

    renderCall(args, theme) {
      const target = args.to === "*" ? "broadcast" : args.to;
      const preview =
        typeof args.message === "string"
          ? truncatePreview(args.message)
          : "...";
      let text = theme.fg("toolTitle", theme.bold("link_send "));
      text += theme.fg("accent", target);
      if (args.triggerTurn) text += theme.fg("warning", " (trigger)");
      text += "\n  " + theme.fg("dim", preview);
      return new Text(text, 0, 0);
    },

    renderResult: (result, _options, theme) => renderIconResult(result, theme),
  });

  pi.registerTool({
    name: "link_compact",
    label: "Link Compact",
    description: [
      "Ask another Pi terminal to compact its context window and wait until it finishes.",
      "Returns once the target has compacted, so you can immediately send it new work.",
      "Busy targets (mid-turn or already compacting) decline; retry when idle.",
    ].join(" "),
    promptSnippet: "Ask another Pi terminal to compact its context window",
    parameters: Type.Object({
      to: Type.String({ description: "Target terminal name" }),
      instructions: Type.Optional(
        Type.String({
          description: "Optional custom compaction instructions for the target",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) {
        return textResult("Compact request aborted", {
          to: params.to,
          error: "aborted",
        });
      }

      if (role === "disconnected") return notConnectedResult();

      if (params.to === terminalName) {
        return textResult("Cannot compact yourself - use /compact.", {
          to: params.to,
          error: "self_target",
        });
      }

      const miss = targetNotFound(params.to);
      if (miss) return miss;

      const requestId = crypto.randomUUID();

      // ADR-0005 §2: pre-dispatch reminder, captured at request time and
      // prepended to the tool result (the sender's decision point).
      const preDispatchNote = budgetReminder(params.to);

      return new Promise<ReturnType<typeof textResult>>((resolve) => {
        const timeout = setTimeout(() => {
          const pending = cleanupPendingCompact(requestId);
          if (pending) {
            pending.resolve(
              textResult(
                `Compact request to "${params.to}" timed out (${COMPACT_TIMEOUT_MS / 1000}s)`,
                { to: params.to, error: "timeout" },
              ),
            );
          }
        }, COMPACT_TIMEOUT_MS);

        pendingCompactResponses.set(requestId, {
          resolve,
          targetName: params.to,
          timeout,
          // ADR-0001: capture target readout at request time (decision point).
          // Empty when the target has no cache entry / unknown tokens — then
          // the success result just omits the before→after suffix.
          beforeReadout: contextReadout(params.to),
          preDispatchNote,
        });

        signal?.addEventListener(
          "abort",
          () => {
            const pending = cleanupPendingCompact(requestId);
            if (pending) {
              pending.resolve(
                textResult("Compact request aborted", {
                  to: params.to,
                  error: "aborted",
                }),
              );
            }
          },
          { once: true },
        );

        const delivered = routeMessage({
          type: "compact_request",
          id: requestId,
          from: terminalName,
          to: params.to,
          instructions: params.instructions,
        });

        if (!delivered) {
          const pending = cleanupPendingCompact(requestId);
          if (pending) {
            pending.resolve(
              textResult(`Failed to request compact on "${params.to}"`, {
                to: params.to,
                error: "not_delivered",
              }),
            );
          }
        }
      });
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("link_compact "));
      text += theme.fg("accent", String(args.to));
      if (typeof args.instructions === "string")
        text += "\n  " + theme.fg("dim", truncatePreview(args.instructions));
      return new Text(text, 0, 0);
    },

    renderResult: (result, _options, theme) => renderIconResult(result, theme),
  });

  // ADR-0005 §4: remote budget set. Hub-routed budget_set → target updates
  // its declared budget, persists the session entry, pushes an immediate
  // status_update, acks. No extra authorization (trust domain, ADR-0002);
  // visible-set addressing applies (cross-workspace → not_found).
  pi.registerTool({
    name: "link_budget",
    label: "Link Budget",
    description: [
      "Set a Pi terminal's declared context budget (absolute used-tokens ceiling; over budget ⇔ tokens ≥ budget).",
      'budget is a token count (e.g. 56000) or "off" to clear back to the default (contextWindow − 100K).',
      "The target persists the value, pushes an immediate status update, and acks. Works on any terminal in your visible set, yourself included.",
    ].join(" "),
    promptSnippet: "Set a terminal's declared context budget on the link",
    parameters: Type.Object({
      to: Type.String({ description: "Target terminal name" }),
      budget: Type.Union([Type.Number(), Type.Literal("off")], {
        description:
          'Absolute used-tokens ceiling (e.g. 56000), or "off" to clear back to the default',
      }),
    }),

    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) {
        return textResult("Budget request aborted", {
          to: params.to,
          error: "aborted",
        });
      }
      if (role === "disconnected") return notConnectedResult();

      const next = params.budget === "off" ? null : parseBudget(params.budget);
      if (params.budget !== "off" && next === undefined) {
        return textResult(`Invalid budget: ${params.budget}`, {
          to: params.to,
          error: "invalid",
        });
      }
      const what = next != null ? formatTokens(next) : "default";

      // Self-targeting allowed — apply locally, no routing.
      if (params.to === terminalName) {
        declaredBudget = next ?? null;
        pi.appendEntry("link-budget", { budget: declaredBudget });
        pushStatus(true);
        return textResult(`Budget on "${terminalName}" set to ${what}`, {
          to: params.to,
        });
      }

      const miss = targetNotFound(params.to);
      if (miss) return miss;

      const requestId = crypto.randomUUID();
      return new Promise<ReturnType<typeof textResult>>((resolve) => {
        const timeout = setTimeout(() => {
          const pending = pendingBudgetResponses.get(requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            pendingBudgetResponses.delete(requestId);
            pending.resolve(
              textResult(
                `Budget request to "${params.to}" timed out (${BUDGET_TIMEOUT_MS / 1000}s)`,
                { to: params.to, error: "timeout" },
              ),
            );
          }
        }, BUDGET_TIMEOUT_MS);

        pendingBudgetResponses.set(requestId, {
          resolve,
          targetName: params.to,
          timeout,
          requested: next ?? null,
        });

        signal?.addEventListener(
          "abort",
          () => {
            const pending = pendingBudgetResponses.get(requestId);
            if (pending) {
              clearTimeout(pending.timeout);
              pendingBudgetResponses.delete(requestId);
              pending.resolve(
                textResult("Budget request aborted", {
                  to: params.to,
                  error: "aborted",
                }),
              );
            }
          },
          { once: true },
        );

        const delivered = routeMessage({
          type: "budget_set",
          id: requestId,
          from: terminalName,
          to: params.to,
          budget: next ?? null,
        });
        if (!delivered) {
          const pending = pendingBudgetResponses.get(requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            pendingBudgetResponses.delete(requestId);
            pending.resolve(
              textResult(`Failed to request budget set on "${params.to}"`, {
                to: params.to,
                error: "not_delivered",
              }),
            );
          }
        }
      });
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("link_budget "));
      text += theme.fg("accent", String(args.to));
      text += " " + theme.fg("dim", String(args.budget));
      return new Text(text, 0, 0);
    },

    renderResult: (result, _options, theme) => renderIconResult(result, theme),
  });

  // ADR-0006: the third lifecycle op over the link — start a brand-new
  // session in place. Ack-before-teardown (carries oldSessionId); identity
  // (name + workspace) is pre-written into the new session; completion is
  // observed as terminal_left → terminal_joined for the same name.
  pi.registerTool({
    name: "link_new",
    label: "Link New",
    description: [
      "Ask another Pi terminal to start a brand-new session in place (fresh context; history stays resumable on disk).",
      "Busy targets (mid-turn, pending remote prompt, or compacting) decline; retry when idle.",
      "The target acks with its old session id, then leaves and rejoins under the same name and workspace.",
    ].join(" "),
    promptSnippet: "Ask another Pi terminal to start a fresh session",
    parameters: Type.Object({
      to: Type.String({ description: "Target terminal name" }),
    }),

    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) {
        return textResult("New-session request aborted", {
          to: params.to,
          error: "aborted",
        });
      }
      if (role === "disconnected") return notConnectedResult();

      if (params.to === terminalName) {
        return textResult("Cannot start a fresh session on yourself - use /new.", {
          to: params.to,
          error: "self_target",
        });
      }

      const miss = targetNotFound(params.to);
      if (miss) return miss;

      const requestId = crypto.randomUUID();
      // ADR-0005 §2: pre-dispatch over-budget reminder (fresh session is one
      // of the two remedies the verdict names — the sender still decides).
      const preDispatchNote = budgetReminder(params.to);
      return new Promise<ReturnType<typeof textResult>>((resolve) => {
        const timeout = setTimeout(() => {
          const pending = pendingNewResponses.get(requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            pendingNewResponses.delete(requestId);
            pending.resolve(
              textResult(
                `New-session request to "${params.to}" timed out (${NEW_TIMEOUT_MS / 1000}s)`,
                { to: params.to, error: "timeout" },
              ),
            );
          }
        }, NEW_TIMEOUT_MS);

        pendingNewResponses.set(requestId, {
          resolve,
          targetName: params.to,
          timeout,
          preDispatchNote,
        });

        signal?.addEventListener(
          "abort",
          () => {
            const pending = pendingNewResponses.get(requestId);
            if (pending) {
              clearTimeout(pending.timeout);
              pendingNewResponses.delete(requestId);
              pending.resolve(
                textResult("New-session request aborted", {
                  to: params.to,
                  error: "aborted",
                }),
              );
            }
          },
          { once: true },
        );

        const delivered = routeMessage({
          type: "new_request",
          id: requestId,
          from: terminalName,
          to: params.to,
        });
        if (!delivered) {
          const pending = pendingNewResponses.get(requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            pendingNewResponses.delete(requestId);
            pending.resolve(
              textResult(`Failed to request fresh session on "${params.to}"`, {
                to: params.to,
                error: "not_delivered",
              }),
            );
          }
        }
      });
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("link_new "));
      text += theme.fg("accent", String(args.to));
      return new Text(text, 0, 0);
    },

    renderResult: (result, _options, theme) => renderIconResult(result, theme),
  });

  pi.registerTool({
    name: "link_prompt",
    label: "Link Prompt",
    description: [
      "Send a prompt to another Pi terminal and wait for its LLM to respond.",
      "The remote terminal processes the prompt as if a user typed it,",
      "then returns the assistant's response. Times out after 90s of inactivity.",
    ].join(" "),
    promptSnippet:
      "Send a prompt to another Pi terminal and receive its LLM response",
    parameters: Type.Object({
      to: Type.String({ description: "Target terminal name" }),
      prompt: Type.String({ description: "Prompt to send" }),
      // ADR-0005 §5: optional per-dispatch budget override (tokens) — this
      // exchange's checks only, never mutates the target's declared budget.
      budget: Type.Optional(
        Type.Number({
          description:
            "Per-dispatch context budget override in tokens (e.g. 56000); overrides the target's declared budget for this exchange's over-budget check only",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) {
        return textResult("Prompt request aborted", {
          to: params.to,
          error: "aborted",
        });
      }

      if (role === "disconnected") return notConnectedResult();

      if (params.to === terminalName) {
        return textResult("Cannot prompt yourself", {
          to: params.to,
          error: "self_target",
        });
      }

      const miss = targetNotFound(params.to);
      if (miss) return miss;

      const requestId = crypto.randomUUID();

      return new Promise<ReturnType<typeof textResult>>((resolve) => {
        const inactivityTimeout = makeInactivityTimeout(requestId, params.to);

        const ceilingTimeout = setTimeout(() => {
          const pending = cleanupPending(requestId);
          if (pending) {
            pending.resolve(
              textResult(
                `Prompt to "${params.to}" hit hard ceiling (${PROMPT_HARD_CEILING_MS / 60_000}min)`,
                { to: params.to, error: "timeout" },
              ),
            );
          }
        }, PROMPT_HARD_CEILING_MS);

        pendingPromptResponses.set(requestId, {
          resolve,
          targetName: params.to,
          inactivityTimeout,
          ceilingTimeout,
          // ADR-0005 §2/§5: pre-dispatch reminder + mismatch notice (both
          // values) lead the result; the override also governs the response
          // readout's verdict.
          preDispatchNote: [
            budgetReminder(params.to, params.budget),
            budgetMismatchNotice(params.to, params.budget),
          ]
            .filter(Boolean)
            .join(" · "),
          budgetOverride: params.budget,
        });

        // Abort handling
        signal?.addEventListener(
          "abort",
          () => {
            const pending = cleanupPending(requestId);
            if (pending) {
              pending.resolve(
                textResult("Prompt request aborted", {
                  to: params.to,
                  error: "aborted",
                }),
              );
            }
          },
          { once: true },
        );

        const delivered = routeMessage({
          type: "prompt_request",
          id: requestId,
          from: terminalName,
          to: params.to,
          prompt: params.prompt,
        });

        if (!delivered) {
          const pending = cleanupPending(requestId);
          if (pending) {
            pending.resolve(
              textResult(`Failed to send prompt to "${params.to}"`, {
                to: params.to,
                error: "not_delivered",
              }),
            );
          }
        }
      });
    },

    renderCall(args, theme) {
      const preview =
        typeof args.prompt === "string" ? truncatePreview(args.prompt) : "...";
      let text = theme.fg("toolTitle", theme.bold("link_prompt "));
      text += theme.fg("accent", args.to ?? "...");
      text += "\n  " + theme.fg("dim", preview);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const txt = result.content[0];
      const details = result.details as Record<string, unknown> | undefined;
      if (details?.error) {
        return new Text(
          theme.fg("error", "✗ ") + (txt?.type === "text" ? txt.text : ""),
          0,
          0,
        );
      }
      const from = details?.from ?? "unknown";
      const response = txt?.type === "text" ? txt.text : "";
      const preview = truncatePreview(response, 200);
      return new Text(
        theme.fg("success", "✓ ") +
          theme.fg("accent", `[${from}] `) +
          theme.fg("text", preview),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "link_list",
    label: "Link List",
    description: "List all Pi terminals currently connected to the link.",
    promptSnippet: "List connected Pi terminals on the link",
    parameters: Type.Object({}),

    async execute() {
      if (role === "disconnected") return notConnectedResult();

      const statuses: Record<string, string> = {};
      const cwds: Record<string, string> = {};
      const contexts: Record<string, ContextSnapshot> = {};
      const models: Record<string, string> = {};
      const overBudgetNames: string[] = [];
      const list = connectedTerminals
        .map((name) => {
          const status = getStatusFor(name);
          let statusStr = status ? formatStatus(status) : "";
          if (status?.kind === "idle") {
            const idle = getIdleSinceFor(name);
            if (idle) statusStr = `idle (${formatDuration(idle)})`;
          }
          if (statusStr) statuses[name] = statusStr;
          const cwd = getCwdFor(name);
          if (cwd) cwds[name] = cwd;
          const context = getContextFor(name);
          if (context) contexts[name] = context;
          const model = getModelFor(name);
          if (model) models[name] = model;
          const over = overBudget(name) !== null;
          if (over) overBudgetNames.push(name);
          let line = terminalLine(name, "  \u2022");
          if (cwd) line += `\n    cwd: ${cwd}`;
          return line;
        })
        .join("\n");

      return textResult(`Connected terminals:\n${list}`, {
        terminals: connectedTerminals,
        statuses,
        cwds,
        contexts,
        models,
        overBudget: overBudgetNames,
        self: terminalName,
        role,
      });
    },

    renderResult(result, _options, theme) {
      const details = result.details as
        | {
            terminals?: string[];
            statuses?: Record<string, string>;
            cwds?: Record<string, string>;
            contexts?: Record<string, ContextSnapshot>;
            models?: Record<string, string>;
            overBudget?: string[];
            self?: string;
            role?: string;
          }
        | undefined;
      if (!details?.terminals) {
        const txt = result.content[0];
        return new Text(txt?.type === "text" ? txt.text : "", 0, 0);
      }

      let text = theme.fg("toolTitle", theme.bold("link "));
      text += theme.fg("muted", `(${details.role}) `);
      text += theme.fg("accent", `${details.terminals.length} terminal(s)`);
      const overSet = new Set(details.overBudget ?? []);
      for (const name of details.terminals) {
        const isSelf = name === details.self;
        const status = details.statuses?.[name] ?? "";
        const cwd = details.cwds?.[name];
        const ctxStr = formatContext(details.contexts?.[name]);
        const model = details.models?.[name];
        const nameStr = isSelf ? `\u2022 ${name} (you)` : `\u2022 ${name}`;
        text +=
          "\n  " +
          (isSelf ? theme.fg("accent", nameStr) : theme.fg("text", nameStr)) +
          (status ? "  " + theme.fg("dim", status) : "") +
          (ctxStr ? theme.fg("dim", "  \u00b7 " + ctxStr) : "");
        if (overSet.has(name)) text += theme.fg("warning", " ⚠ over budget");
        if (model) text += theme.fg("dim", "  \u00b7 " + model);
        if (cwd) text += "\n    " + theme.fg("dim", `cwd: ${shortenPath(cwd)}`);
      }
      return new Text(text, 0, 0);
    },
  });

  // Shared one-line terminal summary for link_list and /link. ADR-0005:
  // idle duration prefers the hub-authoritative idle-since clock; the
  // over-budget marker is the link_list reminder surface (§2); the model
  // label shows raw (display may shorten) (§6).
  function terminalLine(name: string, bullet = "\u2022"): string {
    const status = getStatusFor(name);
    let statusStr = status ? formatStatus(status) : "";
    if (status?.kind === "idle") {
      const idle = getIdleSinceFor(name);
      if (idle) statusStr = `idle (${formatDuration(idle)})`;
    }
    const ctxStr = formatContext(getContextFor(name));
    const over = overBudget(name) !== null;
    const model = getModelFor(name);
    const marker = name === terminalName ? " (you)" : "";
    let line = `${bullet} ${name}${marker}${statusStr ? "  " + statusStr : ""}`;
    if (ctxStr) line += `  \u00b7 ${ctxStr}`;
    if (over) line += " ⚠ over budget";
    if (model) line += `  \u00b7 ${model}`;
    return line;
  }

  // ── Commands ─────────────────────────────────────────────────────────────

  pi.registerCommand("link", {
    description: "Show link status",
    handler: async (_args, _ctx) => {
      if (role === "disconnected") {
        _ctx.ui.notify("Link: not connected", "warning");
        return;
      }
      const lines = connectedTerminals.map((name) => {
        const cwd = getCwdFor(name);
        let line = terminalLine(name, "");
        if (cwd) line += `\n  cwd: ${shortenPath(cwd)}`;
        return line;
      });
      _ctx.ui.notify(
        `Link: ${terminalName} (${role}) · ${connectedTerminals.length} online\n${lines.join("\n")}`,
        "info",
      );
    },
  });

  pi.registerCommand("link-name", {
    description: "Change link name. No arg = use session name",
    handler: async (args, _ctx) => {
      let newName = normalizeName(args) ?? "";
      if (!newName) {
        // No argument: use session name if available
        const sessionName = normalizeName(pi.getSessionName());
        if (sessionName) {
          newName = sessionName;
        } else {
          _ctx.ui.notify(
            `Current name: "${terminalName}". No session name set. Usage: /link-name <name>`,
            "info",
          );
          return;
        }
      }

      if (newName === terminalName && newName === preferredName) {
        _ctx.ui.notify(`Already using "${newName}"`, "info");
        return;
      }

      function savePreference() {
        preferredName = newName;
        pi.appendEntry("link-name", { name: preferredName });
      }

      if (newName === terminalName) {
        savePreference();
        _ctx.ui.notify(`Saved "${newName}" as preferred link name`, "info");
        return;
      }

      // If we're the hub, check uniqueness before persisting
      if (role === "hub") {
        // Check if name is taken by another terminal
        const takenByOther = Array.from(hubClients.values()).includes(newName);
        if (takenByOther) {
          _ctx.ui.notify(
            `Name "${newName}" is already taken by another terminal`,
            "warning",
          );
          return;
        }
        const old = terminalName;
        terminalName = newName;
        connectedTerminals = hubVisibleNames(terminalName);
        updateStatus();
        // Notify clients only — hub already updated local state. ADR-0004:
        // the rebroadcast stays within the renamed terminal's visible set
        // (subject = the hub's own name; its workspace is unchanged by a rename).
        hubBroadcast(
          { type: "terminal_left", name: old, terminals: [] },
          terminalName,
          terminalName,
        );
        hubBroadcast(
          {
            type: "terminal_joined",
            name: newName,
            terminals: [],
            cwd: currentCwd,
            context: captureContext(),
          },
          terminalName,
          terminalName,
        );
        pushStatus(true);
        savePreference();
        _ctx.ui.notify(`Renamed to "${newName}"`, "info");
      } else if (role === "client") {
        // Don't update terminalName here — welcome will assign authoritatively
        // after reconnect. Hub may dedupe newName to newName-2 if taken.
        savePreference();
        pendingClientRename = true;
        ws?.close();
        _ctx.ui.notify(
          `Reconnecting, requesting "${newName}" (hub may assign a different name if taken)...`,
          "info",
        );
      } else {
        savePreference();
        terminalName = newName;
        _ctx.ui.notify(`Name set to "${newName}" (not connected)`, "info");
      }
    },
  });

  pi.registerCommand("link-broadcast", {
    description: "Broadcast a message to all connected terminals",
    handler: async (args, _ctx) => {
      const message = args.trim();
      if (!message) {
        _ctx.ui.notify("Usage: /link-broadcast <message>", "warning");
        return;
      }
      if (role === "disconnected") {
        _ctx.ui.notify("Not connected to link", "warning");
        return;
      }
      routeMessage({
        type: "chat",
        from: terminalName,
        to: "*",
        content: message,
        triggerTurn: false,
      });
      _ctx.ui.notify("Broadcast sent", "info");
    },
  });

  pi.registerCommand("link-disconnect", {
    description: "Disconnect from the link",
    handler: async (_args, _ctx) => {
      pi.appendEntry("link-active", { active: false });
      manuallyDisconnected = true;
      if (role === "disconnected") {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        _ctx.ui.notify("Link disconnected", "info");
        return;
      }
      disconnect();
      _ctx.ui.notify("Disconnected from link", "info");
    },
  });

  // Set by the new_request wire handler right before it re-enters through
  // the command path; the command refuses interactive use otherwise.
  let newNowExpected = false;

  // ADR-0006: execution half of link_new. newSession() exists only on the
  // command context, so the wire handler (above) re-enters through this
  // command. The ack already went out before this runs; identity (name +
  // workspace + budget + connect intent) is pre-written into the new
  // session so the new instance rejoins identically.
  pi.registerCommand("link-new-now", {
    description: "Internal: execute a remote fresh-session request (ADR-0006)",
    handler: async (_args, cmdCtx) => {
      if (!newNowExpected) {
        cmdCtx.ui.notify(
          "Internal command (remote fresh-session execution half) — nothing pending. Use /new for a local fresh session.",
          "warning",
        );
        return;
      }
      newNowExpected = false;
      const carryName = preferredName ?? terminalName;
      const carryWorkspace = workspace;
      const carryBudget = declaredBudget;
      try {
        const { cancelled } = await cmdCtx.newSession({
          setup: async (sm) => {
            sm.appendCustomEntry("link-name", { name: carryName });
            if (carryWorkspace)
              sm.appendCustomEntry("link-workspace", {
                workspace: carryWorkspace,
              });
            if (carryBudget !== null)
              sm.appendCustomEntry("link-budget", { budget: carryBudget });
            sm.appendCustomEntry("link-active", { active: true });
          },
        });
        if (cancelled)
          cmdCtx.ui.notify(
            "Fresh session cancelled — still on the old session",
            "warning",
          );
      } catch (e) {
        cmdCtx.ui.notify(
          `Fresh session failed: ${e instanceof Error ? e.message : String(e)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("link-connect", {
    description: "Connect to the link",
    handler: async (_args, _ctx) => {
      if (role !== "disconnected") {
        _ctx.ui.notify(
          `Already connected as "${terminalName}" (${role})`,
          "info",
        );
        return;
      }
      pi.appendEntry("link-active", { active: true });
      manuallyDisconnected = false;
      // ADR-0002: manual /link-connect resets the auth-rejection flag —
      // the user has decided to retry (likely after fixing the token).
      authFailed = false;
      // ADR-0004: same reset for a refused workspace handshake (likely after
      // upgrading the hub).
      workspaceRejected = false;
      // ADR-0005: same reset for a refused protocol version.
      versionRejected = false;
      // Reset plaintext-warning so a new manual connect can re-fire it.
      plaintextWarningFired = false;
      await initialize();
    },
  });

  // ── Message renderer ─────────────────────────────────────────────────────

  pi.registerMessageRenderer("link", (message, _options, theme) => {
    const from =
      (message.details as Record<string, unknown> | undefined)?.from ?? "link";
    const text =
      theme.fg("accent", `⚡ [${from}] `) +
      theme.fg("text", String(message.content));
    return new Text(text, 0, 0);
  });
}
