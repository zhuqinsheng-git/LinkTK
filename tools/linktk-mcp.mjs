#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocket } from "ws";
import * as z from "zod/v4";
import { readAgentToken } from "../server/agent-auth.js";

const DEFAULT_URL = process.env.LINKTK_AGENT_URL || "ws://127.0.0.1:5173/__agent-control";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const APPROVAL_GRACE_MS = Math.max(
  1000,
  Number(process.env.LINKTK_APPROVAL_GRACE_MS) || 180000,
);
const MAX_INLINE_TRANSFER_BYTES = 1024 * 1024;
const MAX_BUSINESS_TRANSFER_BYTES = 2 * 1024 ** 3;
const SFTP_CHUNK_BYTES = 256 * 1024;
const EXPOSE_ADVANCED_TOOLS = /^(1|true|yes)$/i.test(
  String(process.env.LINKTK_MCP_ADVANCED || ""),
);

function approvalTimeoutMs(businessTimeoutMs = 0) {
  const businessTimeout = Math.max(0, Number(businessTimeoutMs) || 0);
  return businessTimeout + APPROVAL_GRACE_MS;
}

function transferApprovalTimeout(sizeHint) {
  const bytes = Math.max(0, Number(sizeHint) || 0);
  const businessMs = Math.max(
    120000,
    120000 + Math.ceil(bytes / (1024 * 1024)) * 5000,
  );
  return approvalTimeoutMs(Math.min(MAX_TIMEOUT_MS, businessMs));
}

class AgentControlClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.pending = new Map();
    this.connectPromise = null;
    this.selectedSessionId = "";
    this.sessions = [];
    this.controllerId = "";
    this.controllerLabel = "";
    this.leases = [];
  }

  connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    const token = readAgentToken();
    if (!token) {
      throw new Error(
        "LinkTK AI control token not found. Call linktk_launch first, or set LINKTK_AGENT_TOKEN.",
      );
    }
    const socket = new WebSocket(this.url, {
      headers: {
        "x-linktk-agent-token": token,
      },
    });
    this.socket = socket;
    this.connectPromise = new Promise((resolve, reject) => {
      socket.once("open", () => {
        this.connectPromise = null;
        resolve();
      });
      socket.once("error", () => {
        this.connectPromise = null;
        reject(new Error(`Unable to connect to the LinkTK control channel: ${this.url}`));
      });
    });

    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type === "agent:sessions") {
        this.sessions = Array.isArray(message.sessions) ? message.sessions : [];
        if (Array.isArray(message.leases)) this.leases = message.leases;
        const request = this.pending.get(String(message.id || ""));
        if (!request) return;
        this.pending.delete(String(message.id));
        clearTimeout(request.timer);
        request.resolve(this.sessions);
        return;
      }

      if (message.type === "agent:session-selected") {
        const request = this.pending.get(String(message.id || ""));
        if (!request) return;
        this.pending.delete(String(message.id));
        clearTimeout(request.timer);
        this.sessions = Array.isArray(message.sessions) ? message.sessions : this.sessions;
        if (message.ok) {
          this.selectedSessionId = String(message.session?.sessionId || "");
          request.resolve({
            session: message.session,
            sessions: this.sessions,
          });
        } else {
          request.reject(new Error(message.error || "Failed to select the LinkTK session."));
        }
        return;
      }

      if (message.type === "agent:control-ready") {
        this.controllerId = String(message.controllerId || "");
        this.controllerLabel = String(message.controllerLabel || "");
        this.sessions = Array.isArray(message.sessions) ? message.sessions : [];
        return;
      }

      if (message.type === "agent:session-claimed") {
        const request = this.pending.get(String(message.id || ""));
        if (!request) return;
        this.pending.delete(String(message.id));
        clearTimeout(request.timer);
        this.leases = Array.isArray(message.leases) ? message.leases : this.leases;
        if (message.ok) {
          if (message.lease?.sessionId) {
            this.selectedSessionId = String(message.lease.sessionId);
          }
          request.resolve({
            lease: message.lease,
            leases: this.leases,
          });
        } else {
          request.reject(new Error(message.error || "Failed to claim the LinkTK session."));
        }
        return;
      }

      if (message.type === "agent:session-released") {
        const request = this.pending.get(String(message.id || ""));
        if (!request) return;
        this.pending.delete(String(message.id));
        clearTimeout(request.timer);
        this.leases = Array.isArray(message.leases) ? message.leases : this.leases;
        if (message.ok) {
          request.resolve({
            released: Boolean(message.released),
            sessionId: message.sessionId || "",
            leases: this.leases,
          });
        } else {
          request.reject(new Error(message.error || "Failed to release the LinkTK session lease."));
        }
        return;
      }

      if (message.type === "agent:leases") {
        const request = this.pending.get(String(message.id || ""));
        if (!request) return;
        this.pending.delete(String(message.id));
        clearTimeout(request.timer);
        this.leases = Array.isArray(message.leases) ? message.leases : [];
        request.resolve({
          controllerId: message.controllerId || this.controllerId,
          leases: this.leases,
        });
        return;
      }

      if (message.type === "agent:lease-update") {
        this.leases = Array.isArray(message.leases) ? message.leases : this.leases;
        return;
      }

      if (message.type !== "agent:result") return;

      const request = this.pending.get(String(message.id));
      if (!request) return;
      this.pending.delete(String(message.id));
      clearTimeout(request.timer);
      if (message.ok) {
        request.resolve(message.result);
      } else {
        request.reject(new Error(message.error || "LinkTK operation failed."));
      }
    });

    socket.on("close", () => {
      this.connectPromise = null;
      this.pending.forEach((request) => {
        clearTimeout(request.timer);
        request.reject(new Error("The LinkTK control connection is closed."));
      });
      this.pending.clear();
    });
    socket.on("error", () => {});
    return this.connectPromise;
  }

  async request(command, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await this.connect();
    const id = randomUUID();
    const timeout = Math.max(1000, Math.min(MAX_TIMEOUT_MS, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    const requestParams =
      this.selectedSessionId && !params.sessionId
        ? { ...params, sessionId: this.selectedSessionId }
        : params;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LinkTK operation timed out after ${timeout} ms.`));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(
        JSON.stringify({
          type: "agent:request",
          id,
          command,
          params: requestParams,
          timeoutMs: timeout,
        }),
      );
    });
  }

  async listSessions() {
    await this.connect();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Timed out reading the LinkTK AI session list."));
      }, 10000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ type: "agent:list-sessions", id }));
    });
  }

  async selectSession(sessionId) {
    await this.connect();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Timed out selecting the LinkTK AI session."));
      }, 10000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(
        JSON.stringify({
          type: "agent:select-session",
          id,
          sessionId,
        }),
      );
    });
  }

  async claimSession(sessionId, { mode = "exclusive", ttlMs, force = false } = {}) {
    await this.connect();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Timed out claiming the LinkTK session lease."));
      }, 10000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(
        JSON.stringify({
          type: "agent:claim-session",
          id,
          sessionId: sessionId || this.selectedSessionId,
          mode,
          ttlMs,
          force,
        }),
      );
    });
  }

  async releaseSession(sessionId, { force = false } = {}) {
    await this.connect();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Timed out releasing the LinkTK session lease."));
      }, 10000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(
        JSON.stringify({
          type: "agent:release-session",
          id,
          sessionId: sessionId || this.selectedSessionId,
          force,
        }),
      );
    });
  }

  async listLeases() {
    await this.connect();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Timed out reading the LinkTK session lease."));
      }, 10000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ type: "agent:list-leases", id }));
    });
  }

  close() {
    this.socket?.close();
    this.socket = null;
    this.connectPromise = null;
  }
}

const client = new AgentControlClient(DEFAULT_URL);

function controlBaseUrl() {
  const url = new URL(DEFAULT_URL);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

async function isHttpReady(url) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(1200),
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHttpReady(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function openLinkTkPage(url) {
  const browserCandidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  const executable = browserCandidates.find(existsSync);
  if (executable) {
    const child = spawn(executable, [url], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return executable;
  }
  if (process.platform === "win32") {
    const child = spawn("cmd.exe", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return "system-default-browser";
  }
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [url], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return command;
}

async function launchLinkTk({
  openBrowser = true,
  waitForSession = true,
  selectSingle = true,
  timeoutMs = 30000,
} = {}) {
  const baseUrl = controlBaseUrl();
  const targetUrl = baseUrl.toString();
  const timeout = Math.max(5000, Math.min(120000, Number(timeoutMs) || 30000));
  let serverStarted = false;
  let serverPid = null;
  let browserOpened = "";

  let sessions = [];
  try {
    sessions = await client.listSessions(2500);
  } catch {
    client.close();
  }

  if (!sessions.length) {
    const ready = await isHttpReady(targetUrl);
    if (!ready) {
      if (!["127.0.0.1", "localhost", "::1"].includes(baseUrl.hostname)) {
        throw new Error(`LinkTK service is unavailable and the control address is not local: ${targetUrl}`);
      }
      const port = baseUrl.port || "5173";
      const child = spawn(
        process.execPath,
        [
          join(ROOT, "node_modules", "vite", "bin", "vite.js"),
          "--host",
          "127.0.0.1",
          "--port",
          port,
          "--strictPort",
        ],
        {
          cwd: ROOT,
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        },
      );
      child.unref();
      serverStarted = true;
      serverPid = child.pid || null;
      if (!(await waitForHttp(targetUrl, timeout))) {
        throw new Error(`Timed out starting the LinkTK service: ${targetUrl}`);
      }
    }

    if (openBrowser) browserOpened = openLinkTkPage(targetUrl);
    if (waitForSession) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        try {
          sessions = await client.listSessions(2500);
          if (sessions.length) break;
        } catch {
          client.close();
        }
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  }

  if (selectSingle && sessions.length === 1) {
    const sessionId = sessions[0].sessionId;
    if (client.selectedSessionId !== sessionId) {
      const selected = await client.selectSession(sessionId);
      sessions = selected.sessions || sessions;
    }
  }

  return {
    ready: sessions.length > 0,
    url: targetUrl,
    serverStarted,
    serverPid,
    browserOpened,
    controllerId: client.controllerId,
    controllerLabel: client.controllerLabel,
    selectedSessionId: client.selectedSessionId,
    sessions: sessions.map((session) => ({
      sessionId: session.sessionId,
      label: session.label,
      capabilities: session.capabilities || {},
      registeredAt: session.registeredAt || 0,
    })),
  };
}

const server = new McpServer({
  name: "linktk",
  version: "1.0.0",
});

function jsonResult(value, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

function tool(handler) {
  return async (params) => {
    try {
      return jsonResult(await handler(params));
    } catch (error) {
      return jsonResult(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        true,
      );
    }
  };
}

const READ_ONLY_MCP_TOOLS = new Set([
  "linktk_sessions",
  "linktk_snapshot",
  "linktk_leases",
  "linktk_operations",
  "linktk_operation_status",
  "linktk_targets",
  "linktk_observe",
  "linktk_evidence",
  "linktk_status",
  "linktk_serial_read",
  "linktk_serial_wait",
  "linktk_serial_ports",
  "linktk_serial_presets",
  "linktk_network_status",
  "linktk_network_presets",
  "linktk_network_read",
  "linktk_network_wait",
  "linktk_ssh_status",
  "linktk_ssh_presets",
  "linktk_ssh_read",
  "linktk_ssh_wait",
  "linktk_sftp_list",
  "linktk_sftp_download",
  "linktk_sftp_download_open",
  "linktk_sftp_download_chunk",
  "linktk_sftp_download_close",
  "linktk_ymodem_status",
  "linktk_macro_list",
  "linktk_bridge_status",
  "linktk_device_profiles",
  "linktk_transactions",
  "linktk_task_templates",
  "linktk_evidence_get",
]);

const DESTRUCTIVE_MCP_TOOLS = new Set([
  "linktk_operation_start",
  "linktk_disconnect",
  "linktk_execute",
  "linktk_transfer_file",
  "linktk_bridge",
  "linktk_macro",
  "linktk_device_profile",
  "linktk_transaction",
  "linktk_task",
  "linktk_serial_send",
  "linktk_serial_exec",
  "linktk_serial_disconnect",
  "linktk_network_send",
  "linktk_network_exec",
  "linktk_network_disconnect",
  "linktk_ymodem_send",
  "linktk_ymodem_receive",
  "linktk_ymodem_cancel",
  "linktk_macro_run",
  "linktk_macro_delete",
  "linktk_bridge_stop",
  "linktk_ssh_send",
  "linktk_ssh_exec",
  "linktk_ssh_disconnect",
  "linktk_sftp_rename",
  "linktk_sftp_delete",
  "linktk_sftp_upload",
  "linktk_sftp_upload_begin",
  "linktk_sftp_upload_chunk",
  "linktk_sftp_upload_end",
  "linktk_device_profile_delete",
  "linktk_transaction_execute",
  "linktk_task_run",
  "linktk_task_delete",
]);

function withMcpAnnotations(name, config) {
  const readOnlyHint = READ_ONLY_MCP_TOOLS.has(name);
  return {
    ...config,
    annotations: {
      readOnlyHint,
      destructiveHint: readOnlyHint ? false : DESTRUCTIVE_MCP_TOOLS.has(name),
      idempotentHint: readOnlyHint,
      ...config.annotations,
    },
  };
}

function registerDefaultTool(name, config, handler) {
  server.registerTool(name, withMcpAnnotations(name, config), handler);
}

function registerAdvancedTool(name, config, handler) {
  if (!EXPOSE_ADVANCED_TOOLS) return;
  server.registerTool(name, withMcpAnnotations(name, config), handler);
}

const transportSchema = z.enum(["serial", "ssh"]).default("serial");
const dataSchema = {
  data: z.string().describe("Data to send. Plain text when encoding=text, a hex string when encoding=hex."),
  encoding: z.enum(["text", "hex"]).default("text"),
  ending: z
    .enum(["none", "lf", "cr", "crlf"])
    .optional()
    .describe("Optional. Falls back to the current device Profile line ending, or LF when no Profile is set."),
};
const waitSchema = {
  expect: z.string().default("").describe("Text or regular expression to wait for. Empty means wait for any RX data."),
  mode: z.enum(["contains", "regex"]).default("contains"),
  caseSensitive: z.boolean().default(false),
  direction: z.enum(["rx", "tx", "all"]).default("rx"),
  timeoutMs: z.number().int().min(10).max(120000).default(5000),
  since: z.number().int().min(0).optional(),
};

const operationCommandSchema = z.enum([
  "send",
  "read",
  "wait",
  "exec",
  "serial_connect",
  "serial_disconnect",
  "network_connect",
  "network_disconnect",
  "network_send",
  "network_read",
  "network_wait",
  "network_exec",
  "ymodem_send",
  "ymodem_receive",
  "ymodem_cancel",
  "macro_run",
  "macro_create",
  "macro_delete",
  "bridge_start",
  "bridge_stop",
  "ssh_connect",
  "ssh_disconnect",
  "ssh_send",
  "ssh_read",
  "ssh_wait",
  "ssh_exec",
  "sftp_list",
  "sftp_mkdir",
  "sftp_rename",
  "sftp_delete",
  "sftp_upload",
  "sftp_download",
  "transaction_execute",
  "task_run",
]);

const agentStepSchema = z.object({
  label: z.string().max(120).optional(),
  command: operationCommandSchema,
  params: z.record(z.string(), z.unknown()).default({}),
  continueOnError: z.boolean().default(false),
});

const deviceProfileUpsertSchema = {
  profileId: z.string().min(1).optional(),
  name: z.string().min(1).max(80),
  board: z.string().max(120).default(""),
  transport: z.enum(["any", "serial", "network", "ssh"]).default("any"),
  shellType: z.enum(["linux", "rtos", "uboot", "raw"]).default("linux"),
  lineEnding: z.enum(["none", "lf", "cr", "crlf"]).default("lf"),
  promptPattern: z.string().max(400).default(""),
  loginPromptPattern: z.string().max(400).default(""),
  startupPattern: z.string().max(400).default(""),
  description: z.string().max(1000).default(""),
  commonCommands: z.array(z.string().max(400)).max(50).default([]),
  dangerousPatterns: z.array(z.string().max(400)).max(50).default([]),
};

const taskTemplateUpsertSchema = {
  taskId: z.string().min(1).optional(),
  name: z.string().min(1).max(80),
  description: z.string().max(1000).default(""),
  profileId: z.string().max(120).default(""),
  transport: z.enum(["any", "serial", "network", "ssh"]).default("any"),
  steps: z.array(agentStepSchema).min(1).max(50),
  atomic: z.boolean().default(true),
  allowIrreversible: z.boolean().default(false),
};

const macroStepSchema = z.object({
  type: z.enum(["text", "hex"]).default("text"),
  data: z.string().min(1),
});

function businessTransport(value, fallback = "serial") {
  return ["serial", "network", "ssh"].includes(value) ? value : fallback;
}

async function ensureBusinessSession() {
  const sessions = await client.listSessions();
  if (!client.selectedSessionId && sessions.length === 1) {
    await client.selectSession(sessions[0].sessionId);
  }
  return sessions;
}

async function readTargetCatalog(transport = "all", timeoutMs = 10000) {
  const sessions = await ensureBusinessSession();
  const catalog = {
    selectedSessionId: client.selectedSessionId,
    sessions,
    serial: null,
    network: null,
    ssh: null,
  };
  if (!client.selectedSessionId) return catalog;

  const targets = transport === "all" ? ["serial", "network", "ssh"] : [transport];
  for (const target of targets) {
    try {
      if (target === "serial") {
        const [ports, presets] = await Promise.all([
          client.request("serial_ports", { transport: "serial" }, timeoutMs),
          client.request("serial_presets", { transport: "serial" }, timeoutMs),
        ]);
        catalog.serial = { ports, presets };
      } else if (target === "network") {
        catalog.network = {
          presets: await client.request(
            "network_presets",
            { transport: "network" },
            timeoutMs,
          ),
        };
      } else {
        catalog.ssh = {
          presets: await client.request(
            "ssh_presets",
            { transport: "ssh" },
            timeoutMs,
          ),
        };
      }
    } catch (error) {
      catalog[target] = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return catalog;
}

async function uploadBusinessFile({
  protocol,
  localPath,
  remotePath,
  filename,
  blockSize,
  overwrite,
}) {
  const stats = statSync(localPath);
  if (!stats.isFile()) throw new Error(`Local path is not a file: ${localPath}`);
  const selectedProtocol =
    protocol === "auto" ? (remotePath ? "sftp" : "ymodem") : protocol;
  if (selectedProtocol === "ymodem") {
    if (stats.size > MAX_INLINE_TRANSFER_BYTES) {
      throw new Error(
        `YMODEM uploads are limited to ${MAX_INLINE_TRANSFER_BYTES} bytes per call.`,
      );
    }
    const result = await client.request(
      "ymodem_send",
      {
        transport: "serial",
        filename: filename || basename(localPath),
        dataBase64: readFileSync(localPath).toString("base64"),
        blockSize,
      },
      approvalTimeoutMs(10 * 60 * 1000),
    );
    return { protocol: "ymodem", localPath, ...result };
  }

  if (!remotePath) throw new Error("SFTP upload requires remotePath.");
  if (stats.size > MAX_BUSINESS_TRANSFER_BYTES) {
    throw new Error(
      `SFTP uploads are limited to ${MAX_BUSINESS_TRANSFER_BYTES} bytes per call.`,
    );
  }
  if (stats.size <= MAX_INLINE_TRANSFER_BYTES) {
    const bytes = readFileSync(localPath);
    const result = await client.request(
      "sftp_upload",
      {
        transport: "ssh",
        path: remotePath,
        dataBase64: bytes.toString("base64"),
        overwrite: Boolean(overwrite),
      },
      approvalTimeoutMs(120000),
    );
    return { protocol: "sftp", localPath, remotePath, ...result };
  }

  const result = await client.request(
    "sftp_upload_from_file",
    {
      transport: "ssh",
      path: remotePath,
      localPath: resolve(localPath),
      size: stats.size,
      overwrite: Boolean(overwrite),
    },
    transferApprovalTimeout(stats.size),
  );
  return {
    protocol: "sftp",
    localPath,
    remotePath,
    bytes: stats.size,
    ...result,
  };
}

async function downloadBusinessFile({
  protocol,
  remotePath,
  localPath,
  maxBytes,
  overwrite,
}) {
  const selectedProtocol =
    protocol === "auto" ? (remotePath ? "sftp" : "ymodem") : protocol;
  if (selectedProtocol === "ymodem") {
    const result = await client.request(
      "ymodem_receive",
      {
        transport: "serial",
        includeData: true,
        maxBytes: Math.min(maxBytes, MAX_INLINE_TRANSFER_BYTES),
      },
      10 * 60 * 1000,
    );
    if (result?.dataBase64) {
      writeFileSync(localPath, Buffer.from(result.dataBase64, "base64"));
    }
    return { protocol: "ymodem", localPath, ...result };
  }

  if (!remotePath) throw new Error("SFTP download requires remotePath.");
  const limitedMaxBytes = Math.min(maxBytes, MAX_BUSINESS_TRANSFER_BYTES);
  const result = await client.request(
    "sftp_download_to_file",
    {
      transport: "ssh",
      path: remotePath,
      localPath: resolve(localPath),
      overwrite: Boolean(overwrite),
      maxBytes: limitedMaxBytes,
    },
    transferApprovalTimeout(limitedMaxBytes),
  );
  return {
    protocol: "sftp",
    remotePath,
    localPath,
    ...result,
  };
}

function transportForCommand(command) {
  const value = String(command || "");
  if (value.startsWith("ssh_") || value.startsWith("sftp_")) return "ssh";
  if (value.startsWith("network_")) return "network";
  return "serial";
}

registerDefaultTool(
  "linktk_sessions",
  {
    description:
      "List the connected LinkTK page sessions. Every board and tab has its own sessionId; with multiple pages you must select one first.",
    inputSchema: {},
  },
  tool(async () => {
    const sessions = await client.listSessions();
    return {
      selectedSessionId: client.selectedSessionId,
      sessions,
    };
  }),
);

registerDefaultTool(
  "linktk_launch",
  {
    description:
      "Ensure the local LinkTK service is running, starting it and opening a browser page if needed, then wait for an available page session. A single page is selected automatically.",
    inputSchema: {
      openBrowser: z.boolean().default(true),
      waitForSession: z.boolean().default(true),
      selectSingle: z.boolean().default(true),
      timeoutMs: z.number().int().min(5000).max(120000).default(30000),
    },
  },
  tool((params) => launchLinkTk(params)),
);

registerDefaultTool(
  "linktk_select_session",
  {
    description: "Select the LinkTK page session used by subsequent AI operations.",
    inputSchema: {
      sessionId: z.string().min(1),
    },
  },
  tool(async ({ sessionId }) => {
    const result = await client.selectSession(sessionId);
    return {
      selectedSessionId: client.selectedSessionId,
      session: result.session,
    };
  }),
);

registerDefaultTool(
  "linktk_session_claim",
  {
    description:
      "Claim a LinkTK page session lease for this AI controller. exclusive blocks writes from other AI controllers; the user can still pause, terminate, or take over in the page.",
    inputSchema: {
      sessionId: z.string().min(1).optional(),
      mode: z.enum(["exclusive", "shared"]).default("exclusive"),
      ttlMs: z.number().int().min(10000).max(30 * 60 * 1000).default(5 * 60 * 1000),
      force: z.boolean().default(false),
    },
  },
  tool((params) => client.claimSession(params.sessionId, params)),
);

registerDefaultTool(
  "linktk_session_release",
  {
    description: "Release the LinkTK page session lease held by this AI controller.",
    inputSchema: {
      sessionId: z.string().min(1).optional(),
      force: z.boolean().default(false),
    },
  },
  tool((params) => client.releaseSession(params.sessionId, params)),
);

registerDefaultTool(
  "linktk_leases",
  {
    description: "List all LinkTK page session leases and the AI controllers holding them.",
    inputSchema: {},
  },
  tool(() => client.listLeases()),
);

registerDefaultTool(
  "linktk_snapshot",
  {
    description:
      "Read a full actionable snapshot of the current LinkTK session: sessions, connections, UI state, bridge, AI control, and active operations.",
    inputSchema: {},
  },
  tool(() => client.request("snapshot", { transport: "serial" }, 10000)),
);

registerDefaultTool(
  "linktk_operations",
  {
    description: "List AI operation records and running operations in the current LinkTK session.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(20),
    },
  },
  tool(({ limit }) =>
    client.request("operation_list", { limit, transport: "serial" }, 10000),
  ),
);

registerDefaultTool(
  "linktk_operation_start",
  {
    description:
      "Start a queryable, cancellable AI operation. Use it for long commands, file transfers, or work that needs independent tracking.",
    inputSchema: {
      command: operationCommandSchema,
      params: z.record(z.string(), z.unknown()).default({}),
    },
  },
  tool(({ command, params }) => {
    const businessTimeoutMs = Number(params?.timeoutMs) || 0;
    return client.request(
      "operation_start",
      {
        command,
        params,
        transport: transportForCommand(command),
      },
      approvalTimeoutMs(Math.max(15000, businessTimeoutMs)),
    );
  }),
);

registerDefaultTool(
  "linktk_operation_status",
  {
    description: "Read the status of an AI operation; returns the most recent operation when operationId is omitted.",
    inputSchema: {
      operationId: z.string().min(1).optional(),
    },
  },
  tool(({ operationId }) =>
    client.request("operation_status", { operationId, transport: "serial" }, 10000),
  ),
);

registerDefaultTool(
  "linktk_operation_cancel",
  {
    description: "Request cancellation of a running AI operation; cancels the current operation when operationId is omitted.",
    inputSchema: {
      operationId: z.string().min(1).optional(),
    },
  },
  tool(({ operationId }) =>
    client.request("operation_cancel", { operationId, transport: "serial" }, 10000),
  ),
);

registerDefaultTool(
  "linktk_targets",
  {
    description:
      "Read the serial, network, and SSH presets plus authorized serial ports for the current session. Call this first, then connect to the device according to the goal.",
    inputSchema: {
      transport: z.enum(["all", "serial", "network", "ssh"]).default("all"),
    },
  },
  tool(({ transport }) => readTargetCatalog(transport)),
);

registerDefaultTool(
  "linktk_connect",
  {
    description:
      "Connect to a device by goal, handling serial, TCP/UDP, and SSH uniformly. Prefer existing presets; direct connection parameters are also accepted.",
    inputSchema: {
      transport: z.enum(["serial", "network", "ssh"]).default("serial"),
      presetId: z.string().min(1).optional(),
      presetName: z.string().min(1).optional(),
      portIndex: z.number().int().min(0).optional(),
      portName: z.string().min(1).optional(),
      baudRate: z.number().int().min(50).max(10000000).optional(),
      dataBits: z.union([z.literal(7), z.literal(8)]).optional(),
      stopBits: z.union([z.literal(1), z.literal(2)]).optional(),
      parity: z.enum(["none", "even", "odd"]).optional(),
      flowControl: z.enum(["none", "hardware"]).optional(),
      dtr: z.boolean().optional(),
      rts: z.boolean().optional(),
      forceReconnect: z.boolean().default(false),
      protocol: z.enum(["tcp", "udp"]).default("tcp"),
      role: z.enum(["client", "server"]).default("client"),
      host: z.string().min(1).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      username: z.string().min(1).optional(),
      password: z.string().min(1).optional(),
      alias: z.string().min(1).max(80).optional(),
      timeoutMs: z.number().int().min(1000).max(60000).default(20000),
    },
  },
  tool((params) => {
    const transport = businessTransport(params.transport);
    if (transport === "serial") {
      if (
        !params.presetId &&
        !params.presetName &&
        params.portIndex === undefined &&
        !params.portName
      ) {
        throw new Error("Serial connect requires presetId, presetName, portIndex, or portName.");
      }
      return client.request(
        "serial_connect",
        {
          transport,
          presetId: params.presetId,
          name: params.presetName,
          portIndex: params.portIndex,
          portName: params.portName,
          baudRate: params.baudRate,
          dataBits: params.dataBits,
          stopBits: params.stopBits,
          parity: params.parity,
          flowControl: params.flowControl,
          dtr: params.dtr,
          rts: params.rts,
          forceReconnect: params.forceReconnect,
        },
        approvalTimeoutMs(30000),
      );
    }
    if (transport === "network") {
      return client.request(
        "network_connect",
        {
          transport,
          protocol: params.protocol,
          role: params.role,
          host: params.host,
          port: params.port,
          presetId: params.presetId,
          name: params.presetName,
          timeoutMs: params.timeoutMs,
        },
        approvalTimeoutMs(params.timeoutMs),
      );
    }
    if (params.presetId || params.presetName || params.alias) {
      return client.request(
        "ssh_connect_preset",
        {
          transport,
          presetId: params.presetId,
          alias: params.alias || params.presetName,
          password: params.password,
        },
        approvalTimeoutMs(45000),
      );
    }
    if (!params.host || !params.username || !params.password) {
      throw new Error("SSH connect requires an existing preset, or host, username, and password together.");
    }
    return client.request(
      "ssh_connect",
      {
        transport,
        host: params.host,
        port: params.port || 22,
        username: params.username,
        password: params.password,
        alias: params.alias,
      },
      approvalTimeoutMs(45000),
    );
  }),
);

registerDefaultTool(
  "linktk_disconnect",
  {
    description: "Disconnect the current serial, TCP/UDP, or SSH connection.",
    inputSchema: {
      transport: z.enum(["serial", "network", "ssh"]).default("serial"),
    },
  },
  tool(({ transport }) => {
    const target = businessTransport(transport);
    if (target === "network") {
      return client.request(
        "network_disconnect",
        { transport: target },
        approvalTimeoutMs(20000),
      );
    }
    if (target === "ssh") {
      return client.request(
        "ssh_disconnect",
        { transport: target },
        approvalTimeoutMs(15000),
      );
    }
    return client.request(
      "serial_disconnect",
      { transport: target },
      approvalTimeoutMs(30000),
    );
  }),
);

registerDefaultTool(
  "linktk_execute",
  {
    description:
      "Send data to the current device with an optional wait for a response. transport selects serial, TCP/UDP, or SSH so the AI does not deal with low-level tools.",
    inputSchema: {
      transport: z.enum(["serial", "network", "ssh"]).default("serial"),
      data: z.string().min(1).describe("Text or HEX data to send."),
      encoding: z.enum(["text", "hex"]).default("text"),
      ending: z.enum(["none", "lf", "cr", "crlf"]).optional(),
      expect: z.string().default(""),
      waitForResponse: z.boolean().default(false),
      mode: z.enum(["contains", "regex"]).default("contains"),
      caseSensitive: z.boolean().default(false),
      timeoutMs: z.number().int().min(10).max(120000).default(5000),
      captureMs: z.number().int().min(0).max(5000).default(120),
    },
  },
  tool((params) => {
    const transport = businessTransport(params.transport);
    const prefix =
      transport === "network" ? "network_" : transport === "ssh" ? "ssh_" : "";
    const shouldWait = params.waitForResponse || Boolean(params.expect);
    if (!shouldWait) {
      return client.request(
        `${prefix}send`,
        {
          transport,
          data: params.data,
          encoding: params.encoding,
          ending: params.ending,
        },
        approvalTimeoutMs(30000),
      );
    }
    return client.request(
      `${prefix}exec`,
      {
        transport,
        data: params.data,
        encoding: params.encoding,
        ending: params.ending,
        pattern: params.expect,
        mode: params.mode,
        caseSensitive: params.caseSensitive,
        timeoutMs: params.timeoutMs,
        captureMs: params.captureMs,
      },
      approvalTimeoutMs(params.timeoutMs),
    );
  }),
);

registerDefaultTool(
  "linktk_observe",
  {
    description:
      "Read or wait for device output. Cursors enable incremental observation for serial logs, network responses, and SSH output.",
    inputSchema: {
      transport: z.enum(["serial", "network", "ssh"]).default("serial"),
      mode: z.enum(["read", "wait"]).default("read"),
      expect: z.string().default(""),
      matchMode: z.enum(["contains", "regex"]).default("contains"),
      caseSensitive: z.boolean().default(false),
      direction: z.enum(["rx", "tx", "all"]).default("rx"),
      since: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(1000).default(200),
      timeoutMs: z.number().int().min(0).max(120000).default(5000),
    },
  },
  tool((params) => {
    const transport = businessTransport(params.transport);
    const prefix =
      transport === "network" ? "network_" : transport === "ssh" ? "ssh_" : "";
    if (params.mode === "wait") {
      return client.request(
        `${prefix}wait`,
        {
          transport,
          pattern: params.expect,
          mode: params.matchMode,
          caseSensitive: params.caseSensitive,
          direction: params.direction,
          since: params.since,
          timeoutMs: Math.max(10, params.timeoutMs),
        },
        Math.max(10, params.timeoutMs) + 10000,
      );
    }
    return client.request(
      `${prefix}read`,
      {
        transport,
        since: params.since,
        limit: params.limit,
        timeoutMs: params.timeoutMs,
      },
      params.timeoutMs + 10000,
    );
  }),
);

registerDefaultTool(
  "linktk_transfer_file",
  {
    description:
      "Transfer files between the local machine and the target device. Choose SFTP or YMODEM at the business level; chunking, encoding, and progress stay inside the MCP layer.",
    inputSchema: {
      direction: z.enum(["upload", "download"]),
      protocol: z.enum(["auto", "sftp", "ymodem"]).default("auto"),
      localPath: z.string().min(1),
      remotePath: z.string().min(1).optional(),
      filename: z.string().min(1).max(255).optional(),
      blockSize: z.union([z.literal(128), z.literal(1024)]).default(1024),
      overwrite: z
        .boolean()
        .default(false)
        .describe("Applies to SFTP only; YMODEM overwrite semantics are decided by the device-side command."),
      maxBytes: z
        .number()
        .int()
        .min(1)
        .max(MAX_BUSINESS_TRANSFER_BYTES)
        .default(MAX_BUSINESS_TRANSFER_BYTES),
    },
  },
  tool((params) =>
    params.direction === "upload"
      ? uploadBusinessFile(params)
      : downloadBusinessFile(params),
  ),
);

registerDefaultTool(
  "linktk_bridge",
  {
    description:
      "Manage the bridge between serial and TCP/UDP. One tool covers status, start, and stop.",
    inputSchema: {
      action: z.enum(["status", "start", "stop"]),
      serialToNetwork: z.boolean().default(true),
      networkToSerial: z.boolean().default(true),
    },
  },
  tool((params) => {
    if (params.action === "start") {
      return client.request(
        "bridge_start",
        {
          transport: "serial",
          serialToNetwork: params.serialToNetwork,
          networkToSerial: params.networkToSerial,
        },
        approvalTimeoutMs(30000),
      );
    }
    if (params.action === "stop") {
      return client.request(
        "bridge_stop",
        { transport: "serial" },
        approvalTimeoutMs(30000),
      );
    }
    return client.request("bridge_status", { transport: "serial" }, 10000);
  }),
);

registerDefaultTool(
  "linktk_macro",
  {
    description:
      "Manage serial Macros: list, create, replay, and delete — save repeated keystroke or send sequences as workflows.",
    inputSchema: {
      action: z.enum(["list", "run", "create", "delete"]),
      macroId: z.string().min(1).optional(),
      name: z.string().min(1).max(60).optional(),
      steps: z.array(macroStepSchema).min(1).max(500).optional(),
      commandDelay: z.number().int().min(0).max(60000).default(500),
      characterDelay: z.number().int().min(0).max(5000).default(0),
    },
  },
  tool((params) => {
    if (params.action === "list") {
      return client.request("macro_list", { transport: "serial" }, 10000);
    }
    if (params.action === "create") {
      if (!params.name || !params.steps) {
        throw new Error("Creating a Macro requires name and steps.");
      }
      return client.request(
        "macro_create",
        {
          transport: "serial",
          name: params.name,
          steps: params.steps,
          commandDelay: params.commandDelay,
          characterDelay: params.characterDelay,
        },
        approvalTimeoutMs(30000),
      );
    }
    if (!params.macroId && !params.name) {
      throw new Error("Replaying or deleting a Macro requires macroId or name.");
    }
    if (params.action === "delete") {
      return client.request(
        "macro_delete",
        { transport: "serial", macroId: params.macroId, name: params.name },
        approvalTimeoutMs(30000),
      );
    }
    return client.request(
      "macro_run",
      {
        transport: "serial",
        macroId: params.macroId,
        name: params.name,
        commandDelay: params.commandDelay,
        characterDelay: params.characterDelay,
      },
      approvalTimeoutMs(10 * 60 * 1000),
    );
  }),
);

registerDefaultTool(
  "linktk_device_profile",
  {
    description:
      "Manage device Profiles in one tool — list, select, save, and delete — so the AI works with device semantics instead of scattered buttons.",
    inputSchema: {
      action: z.enum(["list", "select", "upsert", "delete"]),
      profileId: z.string().min(1).optional(),
      name: z.string().min(1).max(80).optional(),
      board: z.string().max(120).optional(),
      transport: z.enum(["any", "serial", "network", "ssh"]).optional(),
      shellType: z.enum(["linux", "rtos", "uboot", "raw"]).optional(),
      lineEnding: z.enum(["none", "lf", "cr", "crlf"]).optional(),
      promptPattern: z.string().max(400).optional(),
      loginPromptPattern: z.string().max(400).optional(),
      startupPattern: z.string().max(400).optional(),
      description: z.string().max(1000).optional(),
      commonCommands: z.array(z.string().max(400)).max(50).optional(),
      dangerousPatterns: z.array(z.string().max(400)).max(50).optional(),
    },
  },
  tool((params) => {
    if (params.action === "list") {
      return client.request("device_profile_list", { transport: "serial" }, 10000);
    }
    if (params.action === "select") {
      return client.request(
        "device_profile_select",
        {
          transport: "serial",
          profileId: params.profileId,
          name: params.name,
        },
        approvalTimeoutMs(10000),
      );
    }
    if (params.action === "delete") {
      if (!params.profileId && !params.name) {
        throw new Error("Deleting a device Profile requires profileId or name.");
      }
      return client.request(
        "device_profile_delete",
        {
          transport: "serial",
          profileId: params.profileId,
          name: params.name,
        },
        approvalTimeoutMs(15000),
      );
    }
    if (!params.name) throw new Error("Saving a device Profile requires name.");
    return client.request(
      "device_profile_upsert",
      {
        transport: params.transport || "any",
        _routeTransport: "serial",
        profileId: params.profileId,
        name: params.name,
        board: params.board || "",
        shellType: params.shellType || "linux",
        lineEnding: params.lineEnding || "lf",
        promptPattern: params.promptPattern || "",
        loginPromptPattern: params.loginPromptPattern || "",
        startupPattern: params.startupPattern || "",
        description: params.description || "",
        commonCommands: params.commonCommands || [],
        dangerousPatterns: params.dangerousPatterns || [],
      },
      approvalTimeoutMs(15000),
    );
  }),
);

registerDefaultTool(
  "linktk_transaction",
  {
    description:
      "Run or inspect multi-step transactions. Transactions handle ordering, rollback, and step evidence so the AI does not stitch together low-level calls.",
    inputSchema: {
      action: z.enum(["execute", "list"]).default("execute"),
      name: z.string().max(120).default("AI transaction"),
      steps: z.array(agentStepSchema).min(1).max(50).optional(),
      atomic: z.boolean().default(true),
      allowIrreversible: z.boolean().default(false),
      stopOnError: z.boolean().default(true),
      limit: z.number().int().min(1).max(100).default(20),
    },
  },
  tool((params) => {
    if (params.action === "list") {
      return client.request(
        "transaction_list",
        { transport: "serial", limit: params.limit },
        10000,
      );
    }
    if (!params.steps) throw new Error("Running a transaction requires steps.");
    return client.request(
      "transaction_execute",
      {
        transport: "serial",
        name: params.name,
        steps: params.steps,
        atomic: params.atomic,
        allowIrreversible: params.allowIrreversible,
        stopOnError: params.stopOnError,
      },
      approvalTimeoutMs(30 * 60 * 1000),
    );
  }),
);

registerDefaultTool(
  "linktk_task",
  {
    description:
      "Manage replayable task templates: list, create, save from an operation, replay, and delete.",
    inputSchema: {
      action: z.enum(["list", "run", "create", "from_operation", "delete"]),
      taskId: z.string().min(1).optional(),
      name: z.string().min(1).max(80).optional(),
      operationId: z.string().min(1).optional(),
      description: z.string().max(1000).default(""),
      profileId: z.string().max(120).default(""),
      transport: z.enum(["any", "serial", "network", "ssh"]).default("any"),
      steps: z.array(agentStepSchema).min(1).max(50).optional(),
      variables: z.record(z.string(), z.string()).default({}),
      atomic: z.boolean().default(true),
      allowIrreversible: z.boolean().default(false),
    },
  },
  tool((params) => {
    if (params.action === "list") {
      return client.request("task_template_list", { transport: "serial" }, 10000);
    }
    if (params.action === "run") {
      if (!params.taskId && !params.name) {
        throw new Error("Replaying a task requires taskId or name.");
      }
      return client.request(
        "task_run",
        {
          transport: "serial",
          taskId: params.taskId,
          name: params.name,
          variables: params.variables,
          atomic: params.atomic,
          allowIrreversible: params.allowIrreversible,
        },
        approvalTimeoutMs(30 * 60 * 1000),
      );
    }
    if (params.action === "from_operation") {
      return client.request(
        "task_create_from_operation",
        {
          transport: "serial",
          operationId: params.operationId,
          name: params.name,
          description: params.description,
        },
        approvalTimeoutMs(20000),
      );
    }
    if (params.action === "delete") {
      if (!params.taskId && !params.name) {
        throw new Error("Deleting a task requires taskId or name.");
      }
      return client.request(
        "task_delete",
        { transport: "serial", taskId: params.taskId, name: params.name },
        approvalTimeoutMs(15000),
      );
    }
    if (!params.name || !params.steps) {
      throw new Error("Creating a task requires name and steps.");
    }
    return client.request(
      "task_create",
      {
        transport: params.transport,
        _routeTransport: "serial",
        taskId: params.taskId,
        name: params.name,
        description: params.description,
        profileId: params.profileId,
        steps: params.steps,
        atomic: params.atomic,
        allowIrreversible: params.allowIrreversible,
      },
      approvalTimeoutMs(20000),
    );
  }),
);

registerDefaultTool(
  "linktk_evidence",
  {
    description: "Read the full evidence bundle and replayable steps of one operation.",
    inputSchema: {
      action: z.enum(["get"]).default("get"),
      operationId: z.string().min(1).optional(),
    },
  },
  tool((params) =>
    client.request(
      "evidence_get",
      { transport: "serial", operationId: params.operationId },
      15000,
    ),
  ),
);


registerAdvancedTool(
  "linktk_device_profiles",
  {
    description:
      "List device Profiles in the LinkTK session. A Profile stores the board, shell type, prompt, line ending, common commands, and dangerous commands.",
    inputSchema: {},
  },
  tool(() => client.request("device_profile_list", { transport: "serial" }, 10000)),
);

registerAdvancedTool(
  "linktk_device_profile_select",
  {
    description: "Select the device Profile for the current LinkTK session; clears the selection when profileId/name is omitted.",
    inputSchema: {
      profileId: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
    },
  },
  tool((params) =>
    client.request(
      "device_profile_select",
      { ...params, transport: "serial" },
      approvalTimeoutMs(10000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_device_profile_upsert",
  {
    description:
      "Create or update a device Profile. A Profile gives the AI board, shell prompt, line ending, and dangerous-operation context.",
    inputSchema: deviceProfileUpsertSchema,
  },
  tool((params) =>
    client.request(
      "device_profile_upsert",
      { ...params, transport: "serial" },
      approvalTimeoutMs(15000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_device_profile_delete",
  {
    description: "Delete a device Profile by profileId or name.",
    inputSchema: {
      profileId: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
    },
  },
  tool((params) => {
    if (!params.profileId && !params.name) throw new Error("Provide profileId or name.");
    return client.request(
      "device_profile_delete",
      { ...params, transport: "serial" },
      approvalTimeoutMs(15000),
    );
  }),
);

registerAdvancedTool(
  "linktk_transaction_execute",
  {
    description:
      "Run AI operations in order and roll back reversible steps on failure. SFTP upload, delete, rename, and empty-directory creation roll back automatically; serial/SSH/network commands are treated as irreversible by default.",
    inputSchema: {
      name: z.string().max(120).default("AI transaction"),
      steps: z.array(agentStepSchema).min(1).max(50),
      atomic: z.boolean().default(true),
      allowIrreversible: z.boolean().default(false),
      stopOnError: z.boolean().default(true),
    },
  },
  tool((params) =>
    client.request(
      "transaction_execute",
      { ...params, transport: "serial" },
      approvalTimeoutMs(30 * 60 * 1000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_transactions",
  {
    description: "List transaction records in the current LinkTK session, including step results, rollback status, and evidence summaries.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(20),
    },
  },
  tool((params) =>
    client.request("transaction_list", { ...params, transport: "serial" }, 10000),
  ),
);

registerAdvancedTool(
  "linktk_task_templates",
  {
    description: "List saved task templates. A task template can contain multiple steps and replays like a transaction.",
    inputSchema: {},
  },
  tool(() => client.request("task_template_list", { transport: "serial" }, 10000)),
);

registerAdvancedTool(
  "linktk_task_run",
  {
    description: "Replay a saved LinkTK task template by taskId or name.",
    inputSchema: {
      taskId: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      variables: z.record(z.string(), z.string()).default({}),
      atomic: z.boolean().optional(),
      allowIrreversible: z.boolean().optional(),
    },
  },
  tool((params) => {
    if (!params.taskId && !params.name) throw new Error("Provide taskId or name.");
    return client.request(
      "task_run",
      { ...params, transport: "serial" },
      approvalTimeoutMs(30 * 60 * 1000),
    );
  }),
);

registerAdvancedTool(
  "linktk_task_create",
  {
    description: "Create or update a replayable LinkTK task template.",
    inputSchema: taskTemplateUpsertSchema,
  },
  tool((params) =>
    client.request(
      "task_create",
      { ...params, transport: "serial" },
      approvalTimeoutMs(20000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_task_create_from_operation",
  {
    description:
      "Save a completed operation or transaction as a task template for later replay, keeping the original parameters.",
    inputSchema: {
      operationId: z.string().min(1).optional(),
      name: z.string().min(1).max(80).optional(),
      description: z.string().max(1000).default(""),
    },
  },
  tool((params) =>
    client.request(
      "task_create_from_operation",
      { ...params, transport: "serial" },
      approvalTimeoutMs(20000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_task_delete",
  {
    description: "Delete a task template by taskId or name.",
    inputSchema: {
      taskId: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
    },
  },
  tool((params) => {
    if (!params.taskId && !params.name) throw new Error("Provide taskId or name.");
    return client.request(
      "task_delete",
      { ...params, transport: "serial" },
      approvalTimeoutMs(15000),
    );
  }),
);

registerAdvancedTool(
  "linktk_evidence_get",
  {
    description:
      "Read the evidence bundle of an AI operation: request parameters, before/after state, result, error, transaction steps, and replayable template.",
    inputSchema: {
      operationId: z.string().min(1).optional(),
    },
  },
  tool((params) =>
    client.request("evidence_get", { ...params, transport: "serial" }, 15000),
  ),
);

registerAdvancedTool(
  "linktk_status",
  {
    description: "Read current LinkTK serial, terminal, network, and SSH state. This does not modify the device.",
    inputSchema: {
      transport: z.enum(["serial", "ssh"]).default("serial"),
    },
  },
  tool(({ transport }) =>
    transport === "ssh"
      ? client.request("ssh_status", { transport }, 10000)
      : client.request("status", { transport }, 10000),
  ),
);

registerAdvancedTool(
  "linktk_serial_send",
  {
    description: "Send data through the open LinkTK serial port. Sent content is shown in the page.",
    inputSchema: dataSchema,
  },
  tool((params) =>
    client.request(
      "send",
      { ...params, transport: "serial" },
      approvalTimeoutMs(30000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_serial_read",
  {
    description: "Read the LinkTK serial event buffer. Pass the returned cursor as the next since to avoid re-reading old logs.",
    inputSchema: {
      since: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(1000).default(200),
      timeoutMs: z.number().int().min(0).max(120000).default(0),
    },
  },
  tool((params) =>
    client.request("read", { ...params, transport: "serial" }, params.timeoutMs + 10000),
  ),
);

registerAdvancedTool(
  "linktk_serial_wait",
  {
    description: "Wait for the given content in the LinkTK serial receive area. Sends nothing.",
    inputSchema: {
      ...waitSchema,
      since: z.number().int().min(0).optional(),
    },
  },
  tool((params) =>
    client.request(
      "wait",
      {
        transport: "serial",
        pattern: params.expect,
        mode: params.mode,
        caseSensitive: params.caseSensitive,
        direction: params.direction,
        since: params.since,
        timeoutMs: params.timeoutMs,
      },
      params.timeoutMs + 10000,
    ),
  ),
);

registerAdvancedTool(
  "linktk_serial_exec",
  {
    description: "Send a command over serial and wait for the expected response. Fits Linux shells, RTOS shells, and interactive serial debugging.",
    inputSchema: {
      ...dataSchema,
      ...waitSchema,
      captureMs: z.number().int().min(0).max(5000).default(120),
    },
  },
  tool((params) =>
    client.request(
      "exec",
      {
        ...params,
        transport: "serial",
        pattern: params.expect,
      },
      approvalTimeoutMs(params.timeoutMs),
    ),
  ),
);

registerAdvancedTool(
  "linktk_serial_ports",
  {
    description:
      "List browser-authorized serial ports and system-detected ports. Ports not yet authorized for Web Serial require a one-time user selection in the page.",
    inputSchema: {},
  },
  tool(() => client.request("serial_ports", { transport: "serial" }, 15000)),
);

registerAdvancedTool(
  "linktk_serial_presets",
  {
    description: "List serial connection presets saved in the LinkTK page, including port labels and line settings.",
    inputSchema: {},
  },
  tool(() => client.request("serial_presets", { transport: "serial" }, 10000)),
);

registerAdvancedTool(
  "linktk_serial_connect",
  {
    description:
      "Open a LinkTK serial port by port or saved preset. Authorized ports connect directly; unauthorized ports still need one user selection in the page.",
    inputSchema: {
      presetId: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      portIndex: z.number().int().min(0).optional(),
      portName: z.string().min(1).optional(),
      baudRate: z.number().int().min(50).max(10000000).optional(),
      dataBits: z.union([z.literal(7), z.literal(8)]).optional(),
      stopBits: z.union([z.literal(1), z.literal(2)]).optional(),
      parity: z.enum(["none", "even", "odd"]).optional(),
      flowControl: z.enum(["none", "hardware"]).optional(),
      dtr: z.boolean().optional(),
      rts: z.boolean().optional(),
      forceReconnect: z.boolean().default(false),
    },
  },
  tool((params) =>
    client.request(
      "serial_connect",
      { ...params, transport: "serial" },
      approvalTimeoutMs(30000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_serial_disconnect",
  {
    description: "Close the current LinkTK serial port, keeping browser-authorized ports.",
    inputSchema: {},
  },
  tool(() =>
    client.request(
      "serial_disconnect",
      { transport: "serial" },
      approvalTimeoutMs(30000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_network_status",
  {
    description:
      "Read current LinkTK TCP/UDP session state: role, endpoints, connection count, byte counters, and event cursors.",
    inputSchema: {},
  },
  tool(() => client.request("network_status", { transport: "network" }, 10000)),
);

registerAdvancedTool(
  "linktk_network_presets",
  {
    description: "List network connection presets in LinkTK, including protocol, role, host, and port.",
    inputSchema: {},
  },
  tool(() => client.request("network_presets", { transport: "network" }, 10000)),
);

registerAdvancedTool(
  "linktk_network_connect",
  {
    description:
      "Start a TCP/UDP server or client in the LinkTK page. The connection process is shown in the page.",
    inputSchema: {
      protocol: z.enum(["tcp", "udp"]).default("tcp"),
      role: z.enum(["client", "server"]).default("client"),
      host: z.string().min(1).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      presetId: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      timeoutMs: z.number().int().min(1000).max(60000).default(20000),
    },
  },
  tool((params) =>
    client.request(
      "network_connect",
      { ...params, transport: "network" },
      approvalTimeoutMs(params.timeoutMs),
    ),
  ),
);

registerAdvancedTool(
  "linktk_network_disconnect",
  {
    description: "Stop the current TCP/UDP server or client connection in LinkTK.",
    inputSchema: {},
  },
  tool(() =>
    client.request(
      "network_disconnect",
      { transport: "network" },
      approvalTimeoutMs(20000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_network_send",
  {
    description: "Send text or HEX data through the current LinkTK TCP/UDP session.",
    inputSchema: dataSchema,
  },
  tool((params) =>
    client.request(
      "network_send",
      { ...params, transport: "network" },
      approvalTimeoutMs(30000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_network_read",
  {
    description: "Read the RX/TX event buffer of the current TCP/UDP session.",
    inputSchema: {
      since: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(1000).default(200),
      timeoutMs: z.number().int().min(0).max(120000).default(0),
    },
  },
  tool((params) =>
    client.request("network_read", { ...params, transport: "network" }, params.timeoutMs + 10000),
  ),
);

registerAdvancedTool(
  "linktk_network_wait",
  {
    description: "Wait for the given text or regular expression in the TCP/UDP session.",
    inputSchema: waitSchema,
  },
  tool((params) =>
    client.request(
      "network_wait",
      {
        transport: "network",
        pattern: params.expect,
        mode: params.mode,
        caseSensitive: params.caseSensitive,
        direction: params.direction,
        since: params.since,
        timeoutMs: params.timeoutMs,
      },
      params.timeoutMs + 10000,
    ),
  ),
);

registerAdvancedTool(
  "linktk_network_exec",
  {
    description:
      "Send data through the current TCP/UDP session and wait for a response. Fits network shells, ASCII protocols, and request/response debugging.",
    inputSchema: {
      ...dataSchema,
      ...waitSchema,
      captureMs: z.number().int().min(0).max(5000).default(120),
    },
  },
  tool((params) =>
    client.request(
      "network_exec",
      {
        ...params,
        transport: "network",
        pattern: params.expect,
      },
      approvalTimeoutMs(params.timeoutMs),
    ),
  ),
);

registerAdvancedTool(
  "linktk_ymodem_status",
  {
    description: "Read current LinkTK YMODEM state: mode, block size, and the latest result.",
    inputSchema: {},
  },
  tool(() => client.request("ymodem_status", { transport: "serial" }, 10000)),
);

registerAdvancedTool(
  "linktk_ymodem_send",
  {
    description:
      "Send a single file over the LinkTK serial port with YMODEM. Content is base64; suits firmware and small resource files.",
    inputSchema: {
      filename: z.string().min(1).max(96),
      dataBase64: z.string().min(1).max(Math.ceil((MAX_INLINE_TRANSFER_BYTES * 4) / 3)),
      blockSize: z.union([z.literal(128), z.literal(1024)]).default(1024),
    },
  },
  tool((params) =>
    client.request(
      "ymodem_send",
      { ...params, transport: "serial" },
      approvalTimeoutMs(10 * 60 * 1000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_ymodem_receive",
  {
    description:
      "Wait for and receive one YMODEM file over the LinkTK serial port. Returns base64 by default; above maxBytes it only triggers a page download.",
    inputSchema: {
      includeData: z.boolean().default(true),
      maxBytes: z
        .number()
        .int()
        .min(0)
        .max(MAX_INLINE_TRANSFER_BYTES)
        .default(MAX_INLINE_TRANSFER_BYTES),
    },
  },
  tool((params) =>
    client.request("ymodem_receive", { ...params, transport: "serial" }, 10 * 60 * 1000),
  ),
);

registerAdvancedTool(
  "linktk_ymodem_cancel",
  {
    description: "Cancel the current LinkTK YMODEM transfer.",
    inputSchema: {},
  },
  tool(() =>
    client.request(
      "ymodem_cancel",
      { transport: "serial" },
      approvalTimeoutMs(30000),
    ),
  ),
);

const macroSelectorSchema = {
  macroId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
};

registerAdvancedTool(
  "linktk_macro_list",
  {
    description: "List LinkTK serial Macros with steps, command interval, and character interval.",
    inputSchema: {},
  },
  tool(() => client.request("macro_list", { transport: "serial" }, 10000)),
);

registerAdvancedTool(
  "linktk_macro_run",
  {
    description:
      "Replay an existing LinkTK Macro, selected by macroId or name, optionally overriding command and character intervals.",
    inputSchema: {
      ...macroSelectorSchema,
      commandDelay: z.number().int().min(0).max(60000).optional(),
      characterDelay: z.number().int().min(0).max(5000).optional(),
    },
  },
  tool((params) => {
    if (!params.macroId && !params.name) {
      throw new Error("Provide macroId or name.");
    }
    return client.request(
      "macro_run",
      { ...params, transport: "serial" },
      approvalTimeoutMs(10 * 60 * 1000),
    );
  }),
);

registerAdvancedTool(
  "linktk_macro_create",
  {
    description:
      "Create a serial Macro in the current LinkTK session. Step order is stored as-is and replayed in order.",
    inputSchema: {
      name: z.string().min(1).max(60),
      steps: z.array(macroStepSchema).min(1).max(500),
      commandDelay: z.number().int().min(0).max(60000).default(500),
      characterDelay: z.number().int().min(0).max(5000).default(0),
    },
  },
  tool((params) =>
    client.request(
      "macro_create",
      { ...params, transport: "serial" },
      approvalTimeoutMs(30000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_macro_delete",
  {
    description: "Delete a LinkTK Macro by macroId or name.",
    inputSchema: macroSelectorSchema,
  },
  tool((params) => {
    if (!params.macroId && !params.name) {
      throw new Error("Provide macroId or name.");
    }
    return client.request(
      "macro_delete",
      { ...params, transport: "serial" },
      approvalTimeoutMs(30000),
    );
  }),
);

registerAdvancedTool(
  "linktk_bridge_status",
  {
    description:
      "Read the LinkTK serial↔TCP/UDP bridge state, forwarding direction, and cumulative byte counts.",
    inputSchema: {},
  },
  tool(() => client.request("bridge_status", { transport: "serial" }, 10000)),
);

registerAdvancedTool(
  "linktk_bridge_start",
  {
    description:
      "Start the bridge between the serial port and the current TCP/UDP connection. One-way or two-way forwarding can be chosen.",
    inputSchema: {
      serialToNetwork: z.boolean().default(true),
      networkToSerial: z.boolean().default(true),
    },
  },
  tool((params) =>
    client.request(
      "bridge_start",
      { ...params, transport: "serial" },
      approvalTimeoutMs(30000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_bridge_stop",
  {
    description: "Stop the current LinkTK serial↔TCP/UDP bridge.",
    inputSchema: {},
  },
  tool(() =>
    client.request(
      "bridge_stop",
      { transport: "serial" },
      approvalTimeoutMs(30000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_ssh_presets",
  {
    description:
      "List SSH presets in the LinkTK page: alias, endpoint, whether a password is saved, and preset quick paths. Passwords are never returned.",
    inputSchema: {},
  },
  tool(() => client.request("ssh_presets", { transport: "ssh" }, 10000)),
);

registerAdvancedTool(
  "linktk_ssh_connect",
  {
    description:
      "Open an SSH session through the LinkTK page. Connection progress, terminal output, and AI operations are all shown in the page.",
    inputSchema: {
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535).default(22),
      username: z.string().min(1),
      password: z.string().min(1),
      alias: z.string().max(80).optional(),
    },
  },
  tool((params) =>
    client.request(
      "ssh_connect",
      { ...params, transport: "ssh" },
      approvalTimeoutMs(45000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_ssh_connect_preset",
  {
    description:
      "Connect using an existing SSH preset in LinkTK. Prefer alias; no password is needed when it is already saved in the preset.",
    inputSchema: {
      alias: z.string().min(1).optional(),
      presetId: z.string().min(1).optional(),
      password: z.string().min(1).optional(),
    },
  },
  tool((params) => {
    if (!params.alias && !params.presetId) {
      throw new Error("Provide the SSH preset alias or presetId.");
    }
    return client.request(
      "ssh_connect_preset",
      { ...params, transport: "ssh" },
      approvalTimeoutMs(45000),
    );
  }),
);

registerAdvancedTool(
  "linktk_ssh_disconnect",
  {
    description: "Disconnect the current LinkTK SSH session.",
    inputSchema: {},
  },
  tool(() =>
    client.request(
      "ssh_disconnect",
      { transport: "ssh" },
      approvalTimeoutMs(15000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_ssh_send",
  {
    description: "Write data to the current SSH shell without waiting for a specific response.",
    inputSchema: dataSchema,
  },
  tool((params) =>
    client.request(
      "ssh_send",
      { ...params, transport: "ssh" },
      approvalTimeoutMs(30000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_ssh_read",
  {
    description: "Read the SSH terminal output buffer. The returned cursor enables incremental reads.",
    inputSchema: {
      since: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(1000).default(200),
      timeoutMs: z.number().int().min(0).max(120000).default(0),
    },
  },
  tool((params) =>
    client.request("ssh_read", { ...params, transport: "ssh" }, params.timeoutMs + 10000),
  ),
);

registerAdvancedTool(
  "linktk_ssh_wait",
  {
    description: "Wait for the given output in the SSH terminal. Sends nothing.",
    inputSchema: waitSchema,
  },
  tool((params) =>
    client.request(
      "ssh_wait",
      {
        transport: "ssh",
        pattern: params.expect,
        mode: params.mode,
        caseSensitive: params.caseSensitive,
        direction: params.direction,
        since: params.since,
        timeoutMs: params.timeoutMs,
      },
      params.timeoutMs + 10000,
    ),
  ),
);

registerAdvancedTool(
  "linktk_ssh_exec",
  {
    description: "Send a command to the SSH shell and wait for the expected output. Recommended for remote commands and script debugging.",
    inputSchema: {
      ...dataSchema,
      ...waitSchema,
      captureMs: z.number().int().min(0).max(5000).default(120),
    },
  },
  tool((params) =>
    client.request(
      "ssh_exec",
      {
        ...params,
        transport: "ssh",
        pattern: params.expect,
      },
      approvalTimeoutMs(params.timeoutMs),
    ),
  ),
);

registerAdvancedTool(
  "linktk_sftp_list",
  {
    description: "List an SSH remote directory. Results also appear in the LinkTK file panel.",
    inputSchema: {
      path: z.string().default("."),
    },
  },
  tool((params) =>
    client.request("sftp_list", { ...params, transport: "ssh" }, 30000),
  ),
);

registerAdvancedTool(
  "linktk_sftp_mkdir",
  {
    description: "Create a directory on the SSH remote host.",
    inputSchema: {
      path: z.string().min(1),
    },
  },
  tool((params) =>
    client.request(
      "sftp_mkdir",
      { ...params, transport: "ssh" },
      approvalTimeoutMs(30000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_sftp_rename",
  {
    description: "Rename an SSH remote file or directory.",
    inputSchema: {
      from: z.string().min(1),
      to: z.string().min(1),
    },
  },
  tool((params) =>
    client.request(
      "sftp_rename",
      { ...params, transport: "ssh" },
      approvalTimeoutMs(30000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_sftp_delete",
  {
    description: "Delete an SSH remote file or directory. The root directory and empty paths are rejected.",
    inputSchema: {
      path: z.string().min(1),
      isDirectory: z.boolean().default(false),
    },
  },
  tool((params) =>
    client.request(
      "sftp_delete",
      { ...params, transport: "ssh" },
      approvalTimeoutMs(30000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_sftp_upload",
  {
    description:
      "Upload small files to the SSH remote host. Content is base64. Use the begin/chunk/end tools for large files.",
    inputSchema: {
      path: z.string().min(1),
      dataBase64: z.string().min(1).max(Math.ceil((MAX_INLINE_TRANSFER_BYTES * 4) / 3)),
      overwrite: z.boolean().default(false),
    },
  },
  tool((params) =>
    client.request(
      "sftp_upload",
      { ...params, transport: "ssh" },
      approvalTimeoutMs(120000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_sftp_upload_begin",
  {
    description: "Start a chunked SFTP upload session.",
    inputSchema: {
      path: z.string().min(1),
      size: z.number().int().min(0).max(16 * 1024 * 1024),
      overwrite: z.boolean().default(false),
    },
  },
  tool((params) =>
    client.request(
      "sftp_upload_begin",
      { ...params, transport: "ssh" },
      approvalTimeoutMs(30000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_sftp_upload_chunk",
  {
    description: "Append a base64 chunk to the SFTP upload session.",
    inputSchema: {
      uploadId: z.string().min(1),
      dataBase64: z.string().min(1).max(524288),
    },
  },
  tool((params) =>
    client.request(
      "sftp_upload_chunk",
      { ...params, transport: "ssh" },
      approvalTimeoutMs(60000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_sftp_upload_end",
  {
    description: "Finish the SFTP upload session and write the file to the remote host.",
    inputSchema: {
      uploadId: z.string().min(1),
    },
  },
  tool((params) =>
    client.request(
      "sftp_upload_end",
      { ...params, transport: "ssh" },
      approvalTimeoutMs(120000),
    ),
  ),
);

registerAdvancedTool(
  "linktk_sftp_download",
  {
    description:
      "Read a small SSH remote file as base64. Use the open/read/close tools to read large files in chunks.",
    inputSchema: {
      path: z.string().min(1),
      maxBytes: z.number().int().min(1).max(MAX_INLINE_TRANSFER_BYTES).default(MAX_INLINE_TRANSFER_BYTES),
    },
  },
  tool((params) =>
    client.request("sftp_download", { ...params, transport: "ssh" }, 120000),
  ),
);

registerAdvancedTool(
  "linktk_sftp_download_open",
  {
    description: "Open an SFTP download session that caches the remote file in the LinkTK page.",
    inputSchema: {
      path: z.string().min(1),
      maxBytes: z.number().int().min(1).max(16 * 1024 * 1024).default(16 * 1024 * 1024),
    },
  },
  tool((params) =>
    client.request("sftp_download_open", { ...params, transport: "ssh" }, 120000),
  ),
);

registerAdvancedTool(
  "linktk_sftp_download_chunk",
  {
    description: "Read one base64 chunk of the SFTP download session at the given offset.",
    inputSchema: {
      downloadId: z.string().min(1),
      offset: z.number().int().min(0).default(0),
      length: z.number().int().min(1).max(1024 * 1024).default(256 * 1024),
    },
  },
  tool((params) =>
    client.request("sftp_download_chunk", { ...params, transport: "ssh" }, 30000),
  ),
);

registerAdvancedTool(
  "linktk_sftp_download_close",
  {
    description: "Release the in-memory cache of the SFTP download session.",
    inputSchema: {
      downloadId: z.string().min(1),
    },
  },
  tool((params) =>
    client.request("sftp_download_close", { ...params, transport: "ssh" }, 10000),
  ),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`LinkTK MCP server is running. Control: ${DEFAULT_URL}`);
}

function shutdown() {
  client.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
