import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import {
  agentTokenMatches,
  getOrCreateAgentToken,
  isSameOriginRequest,
  readControllerToken,
  validateAgentToken,
} from "./agent-auth.js";
import { isReadOnlyAgentTransfer } from "../shared/agent-command-policy.js";

const BROWSER_PATH = "/__agent";
const CONTROL_PATH = "/__agent-control";
const MCP_CONFIG_PATH = "/__linktk/mcp-config";
const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const MAX_LEASE_MS = 30 * 60 * 1000;
const READ_ONLY_COMMANDS = new Set([
  "status",
  "snapshot",
  "read",
  "wait",
  "network_status",
  "network_presets",
  "network_read",
  "network_wait",
  "serial_status",
  "serial_ports",
  "serial_presets",
  "ssh_status",
  "ssh_presets",
  "ssh_read",
  "ssh_wait",
  "sftp_list",
  "sftp_download",
  "sftp_download_to_file",
  "sftp_download_open",
  "sftp_download_chunk",
  "sftp_download_close",
  "ymodem_status",
  "macro_list",
  "bridge_status",
  "operation_status",
  "operation_list",
  "transaction_list",
  "task_template_list",
  "device_profile_list",
  "evidence_get",
]);

function sendMessage(socket, message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function parseMessage(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

function requestTimeout(message) {
  const value = Number(message.timeoutMs ?? message.params?.timeoutMs);
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1000, Math.min(MAX_TIMEOUT_MS, Math.round(value)));
}

function rejectUpgrade(socket, statusCode, message) {
  const body = String(message || "Unauthorized");
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusCode === 401 ? "Unauthorized" : "Forbidden"}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "\r\n" +
      body,
  );
  socket.destroy();
}

class AgentBridge {
  constructor({ token = "" } = {}) {
    this.configuredToken = token ? validateAgentToken(token) : "";
    this.token = "";
    this.browserSockets = new Set();
    this.controllerSockets = new Set();
    this.browserStates = new Map();
    this.controllerStates = new Map();
    this.controllerSelections = new Map();
    this.sessionLeases = new Map();
    this.pending = new Map();
    this.servers = new Set();
    this.browserSequence = 0;
    this.controllerSequence = 0;
    this.leaseSequence = 0;
  }

  attach(httpServer) {
    if (!httpServer || this.servers.has(httpServer)) return;
    if (!this.token) {
      this.token = this.configuredToken || getOrCreateAgentToken();
    }

    const browserServer = new WebSocketServer({
      noServer: true,
      maxPayload: 2 * 1024 * 1024,
    });
    const controllerServer = new WebSocketServer({
      noServer: true,
      maxPayload: 2 * 1024 * 1024,
    });

    const onUpgrade = (request, socket, head) => {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      if (pathname === BROWSER_PATH) {
        if (!isSameOriginRequest(request)) {
          rejectUpgrade(socket, 403, "The LinkTK page control channel rejected a cross-origin connection.");
          return;
        }
        browserServer.handleUpgrade(request, socket, head, (webSocket) => {
          browserServer.emit("connection", webSocket, request);
        });
      } else if (pathname === CONTROL_PATH) {
        if (!isSameOriginRequest(request, { allowMissing: true })) {
          rejectUpgrade(socket, 403, "The LinkTK AI control channel rejected a cross-origin connection.");
          return;
        }
        if (!agentTokenMatches(this.token, readControllerToken(request))) {
          rejectUpgrade(socket, 401, "The LinkTK AI control channel requires a valid token.");
          return;
        }
        controllerServer.handleUpgrade(request, socket, head, (webSocket) => {
          controllerServer.emit("connection", webSocket, request);
        });
      }
    };

    httpServer.on("upgrade", onUpgrade);
    browserServer.on("connection", (socket) => this.attachBrowser(socket));
    controllerServer.on("connection", (socket) => this.attachController(socket));

    httpServer.once("close", () => {
      httpServer.off("upgrade", onUpgrade);
      browserServer.close();
      controllerServer.close();
      this.pending.forEach((request) => this.rejectPending(request, "LinkTK local service has stopped."));
      this.pending.clear();
      this.browserSockets.clear();
      this.controllerSockets.clear();
      this.browserStates.clear();
      this.servers.delete(httpServer);
    });

    this.servers.add(httpServer);
  }

  attachBrowser(socket) {
    this.browserSockets.add(socket);
    this.browserSequence += 1;
    this.browserStates.set(socket, {
      client: "ui",
      sessionId: `ui-${this.browserSequence}`,
      label: "LinkTK page",
      capabilities: {},
      state: {},
      registeredAt: Date.now(),
    });
    sendMessage(socket, { type: "agent:bridge-ready", path: BROWSER_PATH });

    socket.on("message", (raw) => {
      const message = parseMessage(raw);
      if (!message) return;

      if (message.type === "agent:register") {
        const current = this.browserStates.get(socket) || {};
        const requestedSessionId = String(message.sessionId || current.sessionId || "").trim();
        const sessionId = this.uniqueSessionId(requestedSessionId, socket);
        this.browserStates.set(socket, {
          ...current,
          ...message,
          client: "ui",
          sessionId,
          label: String(message.label || current.label || "LinkTK page").slice(0, 120),
          registeredAt: current.registeredAt || Date.now(),
          capabilities: message.capabilities || current.capabilities || {},
          state: message.state || current.state || {},
        });
        sendMessage(socket, {
          type: "agent:registered",
          client: "ui",
          controllerCount: this.controllerSockets.size,
        });
        this.broadcastBrowserState();
        return;
      }

      if (message.type === "agent:state") {
        const current = this.browserStates.get(socket) || {};
        this.browserStates.set(socket, {
          ...current,
          state: message.state || {},
          capabilities: message.capabilities || current.capabilities || {},
        });
        this.broadcastBrowserState();
        return;
      }

      if (message.type === "agent:response") {
        this.resolvePending(message);
      }
    });

    socket.on("close", () => {
      this.browserSockets.delete(socket);
      const pendingForBrowser = [...this.pending.values()].filter(
        (request) => request.browser === socket,
      );
      pendingForBrowser.forEach((request) =>
        this.rejectPending(request, "The LinkTK page was closed or reloaded."),
      );
      this.browserStates.delete(socket);
      [...this.controllerSelections.entries()].forEach(([controller, sessionId]) => {
        if (!this.hasSession(sessionId)) this.controllerSelections.delete(controller);
      });
      this.broadcastBrowserState();
    });
    socket.on("error", () => {});
  }

  attachController(socket) {
    this.controllerSockets.add(socket);
    this.controllerSequence += 1;
    const controllerId = `ai-${this.controllerSequence}`;
    this.controllerStates.set(socket, {
      controllerId,
      label: `AI controller ${this.controllerSequence}`,
      connectedAt: Date.now(),
    });
    this.controllerSelections.set(socket, "");
    sendMessage(socket, {
      type: "agent:control-ready",
      controllerId,
      controllerLabel: this.controllerStates.get(socket).label,
      browserCount: this.browserSockets.size,
      controllers: this.controllerSockets.size,
      sessions: this.sessionSummaries(),
    });
    this.broadcastControllerState();

    socket.on("message", (raw) => {
      const message = parseMessage(raw);
      if (!message) return;
      if (message.type === "agent:request") {
        this.forwardRequest(socket, message);
      } else if (message.type === "agent:list-sessions") {
        sendMessage(socket, {
          type: "agent:sessions",
          id: String(message.id || ""),
          sessions: this.sessionSummaries(),
        });
      } else if (message.type === "agent:select-session") {
        this.selectSession(socket, message);
      } else if (message.type === "agent:claim-session") {
        this.claimSession(socket, message);
      } else if (message.type === "agent:release-session") {
        this.releaseSession(socket, message);
      } else if (message.type === "agent:list-leases") {
        sendMessage(socket, {
          type: "agent:leases",
          id: String(message.id || ""),
          controllerId,
          leases: this.activeLeaseSummaries(),
        });
      }
    });

    socket.on("close", () => {
      this.controllerSockets.delete(socket);
      const controller = this.controllerStates.get(socket);
      this.controllerStates.delete(socket);
      this.controllerSelections.delete(socket);
      if (controller?.controllerId) {
        let changed = false;
        [...this.sessionLeases.entries()].forEach(([sessionId, lease]) => {
          if (lease.controllerId !== controller.controllerId) return;
          this.sessionLeases.delete(sessionId);
          this.broadcastLeaseState(sessionId, null);
          changed = true;
        });
        if (changed) this.broadcastBrowserState();
      }
      [...this.pending.values()]
        .filter((request) => request.controller === socket)
        .forEach((request) =>
          this.withdrawPending(
            request,
            "The AI controller disconnected; the operation was withdrawn.",
            "controller-disconnected",
          ),
        );
      this.broadcastControllerState();
    });
    socket.on("error", () => {});
  }

  uniqueSessionId(requestedSessionId, socket) {
    const fallback = `ui-${this.browserSequence}`;
    const candidate = requestedSessionId || fallback;
    const conflict = [...this.browserStates.entries()].some(
      ([otherSocket, browser]) =>
        otherSocket !== socket && browser.sessionId === candidate,
    );
    return conflict ? `${candidate}-${this.browserSequence}` : candidate;
  }

  hasSession(sessionId) {
    return [...this.browserStates.values()].some(
      (browser) => browser.sessionId === sessionId,
    );
  }

  getSession(sessionId) {
    for (const [socket, browser] of this.browserStates.entries()) {
      if (browser.sessionId === sessionId) return { socket, browser };
    }
    return null;
  }

  sessionSummaries() {
    return [...this.browserStates.entries()]
      .map(([socket, browser]) => ({
        sessionId: browser.sessionId,
        label: browser.label || "LinkTK page",
        capabilities: browser.capabilities || {},
        state: browser.state || {},
        registeredAt: browser.registeredAt || 0,
        lease: this.getActiveLease(browser.sessionId),
      }))
      .sort((left, right) => left.registeredAt - right.registeredAt);
  }

  getActiveLease(sessionId) {
    const lease = this.sessionLeases.get(String(sessionId || ""));
    if (!lease) return null;
    if (lease.expiresAt && lease.expiresAt <= Date.now()) {
      this.sessionLeases.delete(String(sessionId || ""));
      return null;
    }
    return { ...lease };
  }

  activeLeaseSummaries() {
    return [...this.sessionLeases.keys()]
      .map((sessionId) => {
        const lease = this.getActiveLease(sessionId);
        if (!lease) return null;
        const session = this.getSession(sessionId)?.browser;
        return {
          ...lease,
          sessionLabel: session?.label || "LinkTK page",
        };
      })
      .filter(Boolean);
  }

  broadcastLeaseState(sessionId, lease) {
    const target = this.getSession(sessionId)?.browser;
    const message = {
      type: "agent:lease",
      sessionId,
      lease: lease || null,
    };
    if (target?.socket) sendMessage(target.socket, message);
    this.controllerSockets.forEach((socket) =>
      sendMessage(socket, {
        type: "agent:lease-update",
        sessionId,
        lease: lease || null,
        leases: this.activeLeaseSummaries(),
      }),
    );
  }

  claimSession(socket, message) {
    const controller = this.controllerStates.get(socket) || {};
    const sessionId = String(
      message.sessionId || this.controllerSelections.get(socket) || "",
    ).trim();
    const selected = this.getSession(sessionId);
    if (!selected) {
      sendMessage(socket, {
        type: "agent:session-claimed",
        id: String(message.id || ""),
        ok: false,
        error: sessionId
          ? `AI session "${sessionId}" was not found.`
          : "Provide a sessionId to claim, or select a default session first.",
        leases: this.activeLeaseSummaries(),
      });
      return;
    }

    const existing = this.getActiveLease(sessionId);
    const force = Boolean(message.force);
    if (
      existing &&
      existing.controllerId !== controller.controllerId &&
      existing.mode === "exclusive" &&
      !force
    ) {
      sendMessage(socket, {
        type: "agent:session-claimed",
        id: String(message.id || ""),
        ok: false,
        error: `Session "${sessionId}" is held exclusively by ${existing.controllerLabel || existing.controllerId}. Release it first, or take over with force.`,
        lease: existing,
        leases: this.activeLeaseSummaries(),
      });
      return;
    }

    const ttlMs = Math.max(
      10000,
      Math.min(MAX_LEASE_MS, Number(message.ttlMs) || DEFAULT_LEASE_MS),
    );
    this.leaseSequence += 1;
    const lease = {
      leaseId: `lease-${this.leaseSequence}`,
      sessionId,
      mode: message.mode === "shared" ? "shared" : "exclusive",
      controllerId: controller.controllerId || "",
      controllerLabel: controller.label || controller.controllerId || "AI controller",
      acquiredAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      ttlMs,
    };
    this.sessionLeases.set(sessionId, lease);
    this.controllerSelections.set(socket, sessionId);
    sendMessage(socket, {
      type: "agent:session-claimed",
      id: String(message.id || ""),
      ok: true,
      lease,
      leases: this.activeLeaseSummaries(),
    });
    this.broadcastLeaseState(sessionId, lease);
    this.broadcastBrowserState();
  }

  releaseSession(socket, message) {
    const controller = this.controllerStates.get(socket) || {};
    const sessionId = String(
      message.sessionId || this.controllerSelections.get(socket) || "",
    ).trim();
    const lease = this.getActiveLease(sessionId);
    if (!sessionId || !lease) {
      sendMessage(socket, {
        type: "agent:session-released",
        id: String(message.id || ""),
        ok: true,
        released: false,
        leases: this.activeLeaseSummaries(),
      });
      return;
    }
    if (
      lease.controllerId !== controller.controllerId &&
      !Boolean(message.force)
    ) {
      sendMessage(socket, {
        type: "agent:session-released",
        id: String(message.id || ""),
        ok: false,
        error: `The lease of session "${sessionId}" belongs to ${lease.controllerLabel || lease.controllerId}.`,
        lease,
        leases: this.activeLeaseSummaries(),
      });
      return;
    }
    this.sessionLeases.delete(sessionId);
    sendMessage(socket, {
      type: "agent:session-released",
      id: String(message.id || ""),
      ok: true,
      released: true,
      sessionId,
      leases: this.activeLeaseSummaries(),
    });
    this.broadcastLeaseState(sessionId, null);
    this.broadcastBrowserState();
  }

  selectSession(socket, message) {
    const sessionId = String(message.sessionId || "").trim();
    if (!sessionId) {
      sendMessage(socket, {
        type: "agent:session-selected",
        id: String(message.id || ""),
        ok: false,
        error: "Provide a sessionId to select.",
        sessions: this.sessionSummaries(),
      });
      return;
    }

    const selected = this.getSession(sessionId);
    if (!selected) {
      sendMessage(socket, {
        type: "agent:session-selected",
        id: String(message.id || ""),
        ok: false,
        error: `AI session "${sessionId}" was not found.`,
        sessions: this.sessionSummaries(),
      });
      return;
    }

    this.controllerSelections.set(socket, sessionId);
    sendMessage(socket, {
      type: "agent:session-selected",
      id: String(message.id || ""),
      ok: true,
      session: {
        sessionId: selected.browser.sessionId,
        label: selected.browser.label || "LinkTK page",
        capabilities: selected.browser.capabilities || {},
        state: selected.browser.state || {},
        registeredAt: selected.browser.registeredAt || 0,
        lease: this.getActiveLease(selected.browser.sessionId),
      },
      controllerId: this.controllerStates.get(socket)?.controllerId || "",
      sessions: this.sessionSummaries(),
    });
  }

  findBrowser(message, controller) {
    const requestedTransport =
      message.params?._routeTransport || message.params?.transport;
    const transport = ["network", "ssh"].includes(requestedTransport)
      ? requestedTransport
      : "serial";
    let candidates = [...this.browserSockets].filter((socket) => {
      const browser = this.browserStates.get(socket);
      if (!browser || browser.client !== "ui") return false;
      if (transport === "ssh") return browser.capabilities?.ssh !== false;
      if (transport === "network") return browser.capabilities?.network !== false;
      return browser.capabilities?.serial !== false;
    });

    const requestedSessionId = String(
      message.params?.sessionId || this.controllerSelections.get(controller) || "",
    ).trim();
    if (requestedSessionId) {
      candidates = candidates.filter(
        (socket) => this.browserStates.get(socket)?.sessionId === requestedSessionId,
      );
    }

    if (candidates.length === 1) {
      return { browser: candidates[0], sessionId: this.browserStates.get(candidates[0])?.sessionId || "" };
    }

    if (!candidates.length) {
      return {
        error: requestedSessionId
          ? `Session "${requestedSessionId}" is currently unavailable or closed.`
          : "No LinkTK page is available. Open a LinkTK page and keep it online.",
        sessions: this.sessionSummaries(),
      };
    }

    return {
      error: "Multiple LinkTK pages detected. Call linktk_sessions first, then use linktk_select_session to pick the target session.",
      sessions: this.sessionSummaries(),
    };
  }

  forwardRequest(controller, message) {
    const id = String(message.id || randomUUID());
    const selection = this.findBrowser(message, controller);
    if (selection.error) {
      sendMessage(controller, {
        type: "agent:result",
        id,
        ok: false,
        error: selection.error,
        result: selection.sessions ? { sessions: selection.sessions } : undefined,
      });
      return;
    }
    const browser = selection.browser;
    const controllerState = this.controllerStates.get(controller) || {};
    const lease = this.getActiveLease(selection.sessionId);
    const command = String(message.command || "");
    const readOnlyCommand =
      command === "sftp_download_to_file"
        ? isReadOnlyAgentTransfer(command, message.params || {})
        : READ_ONLY_COMMANDS.has(command);
    if (
      lease &&
      lease.mode === "exclusive" &&
      lease.controllerId !== controllerState.controllerId &&
      !readOnlyCommand
    ) {
      sendMessage(controller, {
        type: "agent:result",
        id,
        ok: false,
        error: `Session "${selection.sessionId}" is held exclusively by ${lease.controllerLabel || lease.controllerId}; the write operation was rejected.`,
        result: {
          lease,
          leases: this.activeLeaseSummaries(),
        },
      });
      return;
    }

    const timeoutMs = requestTimeout(message);
    const deadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => {
      const request = this.pending.get(id);
      if (request) {
        this.withdrawPending(
          request,
          `The AI operation timed out after ${timeoutMs} ms; it was withdrawn.`,
          "timeout",
        );
      }
    }, timeoutMs);
    timer.unref?.();

    this.pending.set(id, {
      id,
      controller,
      browser,
      sessionId: selection.sessionId,
      controllerId: controllerState.controllerId || "",
      timer,
    });
    sendMessage(browser, {
      type: "agent:command",
      id,
      sessionId: selection.sessionId,
      controllerId: controllerState.controllerId || "",
      controllerLabel: controllerState.label || controllerState.controllerId || "",
      command: message.command,
      params: message.params || {},
      timeoutMs,
      deadline,
    });
  }

  resolvePending(message) {
    const request = this.pending.get(String(message.id));
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(request.id);
    sendMessage(request.controller, {
      type: "agent:result",
      id: request.id,
      ok: Boolean(message.ok),
      result: message.result,
      error: message.error,
    });
  }

  rejectPending(request, error) {
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(request.id);
    sendMessage(request.controller, {
      type: "agent:result",
      id: request.id,
      ok: false,
      error,
    });
  }

  withdrawPending(request, error, reasonCode = "withdrawn") {
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(request.id);
    sendMessage(request.browser, {
      type: "agent:command-withdraw",
      id: request.id,
      reason: error,
      reasonCode,
    });
    sendMessage(request.controller, {
      type: "agent:result",
      id: request.id,
      ok: false,
      error,
      result: {
        withdrawn: true,
        reasonCode,
      },
    });
  }

  broadcastControllerState() {
    const message = {
      type: "agent:controller",
      connected: this.controllerSockets.size > 0,
      count: this.controllerSockets.size,
      controllers: [...this.controllerStates.values()].map((controller) => ({
        ...controller,
      })),
    };
    this.browserSockets.forEach((socket) => sendMessage(socket, message));
    this.controllerSockets.forEach((socket) =>
      sendMessage(socket, {
        type: "agent:controllers",
        count: this.controllerSockets.size,
        browserCount: this.browserSockets.size,
        controllers: [...this.controllerStates.values()].map((controller) => ({
          ...controller,
        })),
      }),
    );
  }

  broadcastBrowserState() {
    const sessions = this.sessionSummaries();
    this.controllerSockets.forEach((socket) =>
      sendMessage(socket, {
        type: "agent:sessions",
        sessions,
        browserCount: this.browserSockets.size,
        leases: this.activeLeaseSummaries(),
      }),
    );
    const message = {
      type: "agent:browser",
      count: this.browserSockets.size,
    };
    this.controllerSockets.forEach((socket) => sendMessage(socket, message));
  }
}

export function agentBridgePlugin(options = {}) {
  const bridge = new AgentBridge(options);
  const attachMcpConfigMiddleware = (server) => {
    if (!server.middlewares?.use) return;
    server.middlewares.use((request, response, next) => {
      const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
      if (pathname !== MCP_CONFIG_PATH) {
        next();
        return;
      }
      if (request.method !== "GET") {
        response.statusCode = 405;
        response.end("Method Not Allowed");
        return;
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          mcpServers: {
            linktk: {
              command: process.execPath,
              args: [join(PROJECT_ROOT, "tools", "linktk-mcp.mjs")],
            },
          },
        }),
      );
    });
  };
  return {
    name: "linktk-agent-bridge",
    configureServer(server) {
      bridge.attach(server.httpServer);
      attachMcpConfigMiddleware(server);
    },
    configurePreviewServer(server) {
      bridge.attach(server.httpServer);
      attachMcpConfigMiddleware(server);
    },
  };
}
