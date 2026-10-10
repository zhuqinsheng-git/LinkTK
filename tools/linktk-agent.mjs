#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { WebSocket } from "ws";
import { readAgentToken } from "../server/agent-auth.js";

const DEFAULT_URL = process.env.LINKTK_AGENT_URL || "ws://127.0.0.1:5173/__agent-control";

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      result._.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function numberOption(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function requiredData(args) {
  const data = args.text ?? args.data ?? args._[1];
  if (data === undefined || data === null || String(data).length === 0) {
    throw new Error("Missing data to send; use --text or --hex.");
  }
  return String(data);
}

function buildCommand(args) {
  const command = args._[0] || "status";
  const timeoutMs = Math.max(1000, numberOption(args.timeout, 5000));

  if (command === "status") {
    return { command, params: {}, timeoutMs: timeoutMs + 5000 };
  }

  if (command === "snapshot") {
    return { command: "snapshot", params: {}, timeoutMs: timeoutMs + 5000 };
  }

  if (command === "operations") {
    return {
      command: "operation_list",
      params: { limit: numberOption(args.limit, 20) },
      timeoutMs: timeoutMs + 5000,
    };
  }

  if (command === "operation-status") {
    return {
      command: "operation_status",
      params: {
        operationId: String(args.id || args["operation-id"] || ""),
      },
      timeoutMs: timeoutMs + 5000,
    };
  }

  if (command === "operation-cancel") {
    return {
      command: "operation_cancel",
      params: {
        operationId: String(args.id || args["operation-id"] || ""),
      },
      timeoutMs: timeoutMs + 5000,
    };
  }

  if (command === "operation-start") {
    const targetCommand = String(args.command || args._[1] || "").trim();
    if (!targetCommand) throw new Error("operation-start requires --command.");
    let operationParams = {};
    if (args.params) {
      try {
        operationParams = JSON.parse(String(args.params));
      } catch {
        throw new Error("--params must be a JSON object.");
      }
    }
    return {
      command: "operation_start",
      params: {
        command: targetCommand,
        params: operationParams,
      },
      timeoutMs: timeoutMs + 5000,
    };
  }

  if (command === "device-profiles") {
    return { command: "device_profile_list", params: {}, timeoutMs: timeoutMs + 5000 };
  }

  if (command === "device-profile-select") {
    return {
      command: "device_profile_select",
      params: {
        profileId: args["profile-id"] ? String(args["profile-id"]) : undefined,
        name: args.name ? String(args.name) : undefined,
      },
      timeoutMs: timeoutMs + 5000,
    };
  }

  if (command === "device-profile-upsert") {
    let commonCommands = [];
    let dangerousPatterns = [];
    try {
      if (args["common-commands"]) commonCommands = JSON.parse(String(args["common-commands"]));
      if (args["dangerous-patterns"]) {
        dangerousPatterns = JSON.parse(String(args["dangerous-patterns"]));
      }
    } catch {
      throw new Error("--common-commands and --dangerous-patterns must be JSON arrays.");
    }
    return {
      command: "device_profile_upsert",
      params: {
        profileId: args["profile-id"] ? String(args["profile-id"]) : undefined,
        name: String(args.name || ""),
        board: String(args.board || ""),
        transport: String(args.transport || "any"),
        shellType: String(args["shell-type"] || "linux"),
        lineEnding: String(args["line-ending"] || "lf"),
        promptPattern: String(args["prompt-pattern"] || ""),
        loginPromptPattern: String(args["login-prompt-pattern"] || ""),
        startupPattern: String(args["startup-pattern"] || ""),
        description: String(args.description || ""),
        commonCommands,
        dangerousPatterns,
      },
      timeoutMs: timeoutMs + 5000,
    };
  }

  if (command === "device-profile-delete") {
    return {
      command: "device_profile_delete",
      params: {
        profileId: args["profile-id"] ? String(args["profile-id"]) : undefined,
        name: args.name ? String(args.name) : undefined,
      },
      timeoutMs: timeoutMs + 5000,
    };
  }

  if (command === "transactions") {
    return {
      command: "transaction_list",
      params: { limit: numberOption(args.limit, 20) },
      timeoutMs: timeoutMs + 5000,
    };
  }

  if (command === "transaction-execute") {
    let steps;
    try {
      steps = JSON.parse(String(args.steps || "[]"));
    } catch {
      throw new Error("--steps must be a JSON array.");
    }
    return {
      command: "transaction_execute",
      params: {
        name: String(args.name || "CLI transaction"),
        steps,
        atomic: !args["allow-partial"],
        allowIrreversible: Boolean(args["allow-irreversible"]),
        stopOnError: !args["continue-on-error"],
      },
      timeoutMs: 30 * 60 * 1000,
    };
  }

  if (command === "tasks") {
    return { command: "task_template_list", params: {}, timeoutMs: timeoutMs + 5000 };
  }

  if (command === "task-run") {
    return {
      command: "task_run",
      params: {
        taskId: args["task-id"] ? String(args["task-id"]) : undefined,
        name: args.name ? String(args.name) : undefined,
        atomic: args["allow-partial"] ? false : undefined,
        allowIrreversible: args["allow-irreversible"] ? true : undefined,
      },
      timeoutMs: 30 * 60 * 1000,
    };
  }

  if (command === "task-create") {
    let steps;
    try {
      steps = JSON.parse(String(args.steps || "[]"));
    } catch {
      throw new Error("--steps must be a JSON array.");
    }
    return {
      command: "task_create",
      params: {
        taskId: args["task-id"] ? String(args["task-id"]) : undefined,
        name: String(args.name || ""),
        description: String(args.description || ""),
        profileId: String(args["profile-id"] || ""),
        transport: String(args.transport || "any"),
        steps,
        atomic: !args["allow-partial"],
        allowIrreversible: Boolean(args["allow-irreversible"]),
      },
      timeoutMs: timeoutMs + 10000,
    };
  }

  if (command === "task-from-operation") {
    return {
      command: "task_create_from_operation",
      params: {
        operationId: args.id ? String(args.id) : undefined,
        name: args.name ? String(args.name) : undefined,
        description: String(args.description || ""),
      },
      timeoutMs: timeoutMs + 10000,
    };
  }

  if (command === "task-delete") {
    return {
      command: "task_delete",
      params: {
        taskId: args["task-id"] ? String(args["task-id"]) : undefined,
        name: args.name ? String(args.name) : undefined,
      },
      timeoutMs: timeoutMs + 5000,
    };
  }

  if (command === "evidence") {
    return {
      command: "evidence_get",
      params: { operationId: args.id ? String(args.id) : undefined },
      timeoutMs: timeoutMs + 5000,
    };
  }

  if (command === "send") {
    return {
      command,
      params: {
        data: requiredData(args),
        encoding: args.hex ? "hex" : String(args.encoding || "text"),
        ending: args.ending ? String(args.ending) : undefined,
      },
      timeoutMs: timeoutMs + 5000,
    };
  }

  if (command === "read") {
    return {
      command,
      params: {
        since: numberOption(args.since, 0),
        limit: numberOption(args.limit, 200),
        timeoutMs: numberOption(args.wait ?? args.timeout, 0),
      },
      timeoutMs: timeoutMs + 5000,
    };
  }

  if (command === "wait") {
    return {
      command,
      params: {
        since: numberOption(args.since, 0),
        pattern: String(args.expect ?? args.pattern ?? ""),
        mode: String(args.mode || "contains"),
        caseSensitive: Boolean(args["case-sensitive"]),
        direction: String(args.direction || "rx"),
        timeoutMs,
      },
      timeoutMs: timeoutMs + 5000,
    };
  }

  if (command === "exec") {
    return {
      command,
      params: {
        data: requiredData(args),
        encoding: args.hex ? "hex" : String(args.encoding || "text"),
        ending: args.ending ? String(args.ending) : undefined,
        pattern: String(args.expect ?? args.pattern ?? ""),
        mode: String(args.mode || "contains"),
        caseSensitive: Boolean(args["case-sensitive"]),
        timeoutMs,
        captureMs: Math.max(0, numberOption(args["capture-ms"], 120)),
      },
      timeoutMs: timeoutMs + 5000,
    };
  }

  if (command === "serial-status") {
    return { command: "serial_status", params: {}, timeoutMs: timeoutMs + 5000 };
  }

  if (command === "serial-ports") {
    return { command: "serial_ports", params: {}, timeoutMs: timeoutMs + 10000 };
  }

  if (command === "serial-presets") {
    return { command: "serial_presets", params: {}, timeoutMs: timeoutMs + 5000 };
  }

  if (command === "serial-connect") {
    return {
      command: "serial_connect",
      params: {
        presetId: args["preset-id"] ? String(args["preset-id"]) : undefined,
        name: args.name ? String(args.name) : undefined,
        portIndex: args["port-index"] !== undefined
          ? numberOption(args["port-index"], undefined)
          : undefined,
        portName: args.port ? String(args.port) : undefined,
        baudRate: args.baud !== undefined ? numberOption(args.baud, 115200) : undefined,
        dataBits: args["data-bits"] !== undefined ? numberOption(args["data-bits"], 8) : undefined,
        stopBits: args["stop-bits"] !== undefined ? numberOption(args["stop-bits"], 1) : undefined,
        parity: args.parity ? String(args.parity) : undefined,
        flowControl: args["flow-control"] ? String(args["flow-control"]) : undefined,
        dtr: args["no-dtr"] ? false : undefined,
        rts: args["no-rts"] ? false : undefined,
        forceReconnect: Boolean(args["force-reconnect"]),
      },
      timeoutMs: timeoutMs + 15000,
    };
  }

  if (command === "serial-disconnect") {
    return { command: "serial_disconnect", params: {}, timeoutMs: timeoutMs + 15000 };
  }

  if (command === "network-status") {
    return { command: "network_status", params: {}, timeoutMs: timeoutMs + 5000 };
  }

  if (command === "network-presets") {
    return { command: "network_presets", params: {}, timeoutMs: timeoutMs + 5000 };
  }

  if (command === "network-connect") {
    return {
      command: "network_connect",
      params: {
        protocol: String(args.protocol || "tcp"),
        role: String(args.role || "client"),
        host: args.host ? String(args.host) : undefined,
        port: args.port ? numberOption(args.port, undefined) : undefined,
        presetId: args["preset-id"] ? String(args["preset-id"]) : undefined,
        name: args.name ? String(args.name) : undefined,
        timeoutMs,
      },
      timeoutMs: timeoutMs + 10000,
    };
  }

  if (command === "network-disconnect") {
    return { command: "network_disconnect", params: {}, timeoutMs: timeoutMs + 5000 };
  }

  if (command === "network-send") {
    return {
      command: "network_send",
      params: {
        data: requiredData(args),
        encoding: args.hex ? "hex" : String(args.encoding || "text"),
        ending: args.ending ? String(args.ending) : undefined,
      },
      timeoutMs: timeoutMs + 5000,
    };
  }

  if (command === "network-read") {
    return {
      command: "network_read",
      params: {
        since: numberOption(args.since, 0),
        limit: numberOption(args.limit, 200),
        timeoutMs: numberOption(args.wait ?? args.timeout, 0),
      },
      timeoutMs: timeoutMs + 5000,
    };
  }

  if (command === "network-wait") {
    return {
      command: "network_wait",
      params: {
        since: numberOption(args.since, 0),
        pattern: String(args.expect ?? args.pattern ?? ""),
        mode: String(args.mode || "contains"),
        caseSensitive: Boolean(args["case-sensitive"]),
        direction: String(args.direction || "rx"),
        timeoutMs,
      },
      timeoutMs: timeoutMs + 5000,
    };
  }

  if (command === "network-exec") {
    return {
      command: "network_exec",
      params: {
        data: requiredData(args),
        encoding: args.hex ? "hex" : String(args.encoding || "text"),
        ending: args.ending ? String(args.ending) : undefined,
        pattern: String(args.expect ?? args.pattern ?? ""),
        mode: String(args.mode || "contains"),
        caseSensitive: Boolean(args["case-sensitive"]),
        timeoutMs,
        captureMs: Math.max(0, numberOption(args["capture-ms"], 120)),
      },
      timeoutMs: timeoutMs + 5000,
    };
  }

  if (command === "ymodem-status") {
    return { command: "ymodem_status", params: {}, timeoutMs: timeoutMs + 5000 };
  }

  if (command === "ymodem-send") {
    const file = String(args.file || args._[1] || "").trim();
    if (!file) throw new Error("ymodem-send requires --file.");
    const data = readFileSync(file);
    if (data.byteLength > 16 * 1024 * 1024) {
      throw new Error("YMODEM can send at most 16 MiB per file.");
    }
    return {
      command: "ymodem_send",
      params: {
        filename: String(args.name || file.split(/[\\/]/).at(-1) || "firmware.bin"),
        dataBase64: data.toString("base64"),
        blockSize: numberOption(args["block-size"], 1024) === 128 ? 128 : 1024,
      },
      timeoutMs: 10 * 60 * 1000,
    };
  }

  if (command === "ymodem-receive") {
    return {
      command: "ymodem_receive",
      params: {
        includeData: !args["no-data"],
        maxBytes: numberOption(args["max-bytes"], 1024 * 1024),
      },
      timeoutMs: 10 * 60 * 1000,
    };
  }

  if (command === "ymodem-cancel") {
    return { command: "ymodem_cancel", params: {}, timeoutMs: timeoutMs + 5000 };
  }

  if (command === "macro-list") {
    return { command: "macro_list", params: {}, timeoutMs: timeoutMs + 5000 };
  }

  if (command === "macro-run") {
    return {
      command: "macro_run",
      params: {
        macroId: args.id ? String(args.id) : undefined,
        name: args.name ? String(args.name) : undefined,
        commandDelay: args["command-delay"] !== undefined
          ? numberOption(args["command-delay"], 500)
          : undefined,
        characterDelay: args["character-delay"] !== undefined
          ? numberOption(args["character-delay"], 0)
          : undefined,
      },
      timeoutMs: 10 * 60 * 1000,
    };
  }

  if (command === "macro-create") {
    const name = String(args.name || "").trim();
    if (!name) throw new Error("macro-create requires --name.");
    let steps;
    try {
      steps = JSON.parse(String(args.steps || "[]"));
    } catch {
      throw new Error("--steps must be a JSON array, e.g. \"[{\\\"type\\\":\\\"text\\\",\\\"data\\\":\\\"help\\r\\\"}]\".");
    }
    return {
      command: "macro_create",
      params: {
        name,
        steps,
        commandDelay: numberOption(args["command-delay"], 500),
        characterDelay: numberOption(args["character-delay"], 0),
      },
      timeoutMs: timeoutMs + 5000,
    };
  }

  if (command === "macro-delete") {
    return {
      command: "macro_delete",
      params: {
        macroId: args.id ? String(args.id) : undefined,
        name: args.name ? String(args.name) : undefined,
      },
      timeoutMs: timeoutMs + 5000,
    };
  }

  if (command === "bridge-status") {
    return { command: "bridge_status", params: {}, timeoutMs: timeoutMs + 5000 };
  }

  if (command === "bridge-start") {
    return {
      command: "bridge_start",
      params: {
        serialToNetwork: args["serial-to-network"] !== false,
        networkToSerial: args["network-to-serial"] !== false,
      },
      timeoutMs: timeoutMs + 5000,
    };
  }

  if (command === "bridge-stop") {
    return { command: "bridge_stop", params: {}, timeoutMs: timeoutMs + 5000 };
  }

  throw new Error(`Unknown command: ${command}`);
}

class AgentControlClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.pending = new Map();
    this.ready = null;
  }

  connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.ready) return this.ready;

    const token = readAgentToken();
    if (!token) {
      throw new Error(
        "LinkTK AI control token not found. Start LinkTK first, or set LINKTK_AGENT_TOKEN.",
      );
    }
    const socket = new WebSocket(this.url, {
      headers: {
        "x-linktk-agent-token": token,
      },
    });
    this.socket = socket;
    this.ready = new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", () => reject(new Error(`Unable to connect to ${this.url}`)));
    });

    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (message.type === "agent:sessions") {
        const request = this.pending.get(String(message.id));
        if (!request) return;
        this.pending.delete(String(message.id));
        clearTimeout(request.timer);
        request.resolve(message.sessions || []);
        return;
      }

      if (message.type === "agent:result") {
        const request = this.pending.get(String(message.id));
        if (!request) return;
        this.pending.delete(String(message.id));
        clearTimeout(request.timer);
        if (message.ok) {
          request.resolve(message.result);
        } else {
          request.reject(new Error(message.error || "AI operation failed."));
        }
      }
    });

    socket.on("close", () => {
      this.ready = null;
      this.pending.forEach((request) => {
        clearTimeout(request.timer);
        request.reject(new Error("The AI control connection is closed."));
      });
      this.pending.clear();
    });
    socket.on("error", () => {});
    return this.ready;
  }

  async request(command, params, timeoutMs) {
    await this.connect();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`AI request timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(
        JSON.stringify({
          type: "agent:request",
          id,
          command,
          params,
          timeoutMs,
        }),
      );
    });
  }

  async listSessions(timeoutMs = 10000) {
    await this.connect();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${timeoutMs} ms waiting for the AI session list.`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ type: "agent:list-sessions", id }));
    });
  }

  close() {
    this.socket?.close();
    this.socket = null;
    this.ready = null;
  }
}

function printHelp() {
  console.log(`LinkTK Agent CLI

Usage:
  node tools/linktk-agent.mjs status
  node tools/linktk-agent.mjs sessions
  node tools/linktk-agent.mjs send --text "help" --ending lf
  node tools/linktk-agent.mjs exec --text "uname -a" --expect "$" --timeout 5000
  node tools/linktk-agent.mjs read --wait 1000
  node tools/linktk-agent.mjs wait --expect "login:" --timeout 10000
  node tools/linktk-agent.mjs serial-ports
  node tools/linktk-agent.mjs serial-presets
  node tools/linktk-agent.mjs serial-connect --port COM12 --baud 115200
  node tools/linktk-agent.mjs serial-disconnect
  node tools/linktk-agent.mjs network-status
  node tools/linktk-agent.mjs network-connect --protocol tcp --role client --host 127.0.0.1 --port 9000
  node tools/linktk-agent.mjs network-send --text "PING" --ending lf
  node tools/linktk-agent.mjs network-wait --expect "PONG" --timeout 5000
  node tools/linktk-agent.mjs network-read --wait 1000
  node tools/linktk-agent.mjs ymodem-send --file firmware.bin --block-size 1024
  node tools/linktk-agent.mjs ymodem-receive --output received.bin --max-bytes 1048576
  node tools/linktk-agent.mjs macro-list
  node tools/linktk-agent.mjs macro-run --name "Boot" --command-delay 500
  node tools/linktk-agent.mjs macro-create --name "Boot" --steps "[{\"type\":\"text\",\"data\":\"help\\r\"}]"
  node tools/linktk-agent.mjs bridge-status
  node tools/linktk-agent.mjs bridge-start --serial-to-network --network-to-serial
  node tools/linktk-agent.mjs bridge-stop
  node tools/linktk-agent.mjs operation-start --command wait --params "{\"expect\":\"DONE\",\"timeoutMs\":30000}"
  node tools/linktk-agent.mjs operation-status --id <operationId>
  node tools/linktk-agent.mjs operation-cancel --id <operationId>

Environment variables:
  LINKTK_AGENT_URL  defaults to ws://127.0.0.1:5173/__agent-control
  LINKTK_AGENT_TOKEN  optional; overrides ~/.linktk/agent-token
  --session <sessionId>  target session in multi-page setups
`);
}

function transportForCommand(command) {
  const value = String(command || "");
  if (value.startsWith("network_")) return "network";
  if (value.startsWith("ssh_") || value.startsWith("sftp_")) return "ssh";
  return "serial";
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h || args._[0] === "help") {
  printHelp();
  process.exit(0);
}

const client = new AgentControlClient(String(args.url || DEFAULT_URL));

try {
  const request =
    args._[0] === "sessions"
      ? { command: "sessions", params: {}, timeoutMs: 10000 }
      : buildCommand(args);
  const sessionId = String(args.session || args["session-id"] || "").trim();
  if (sessionId) request.params.sessionId = sessionId;
  if (!request.params.transport && args._[0] !== "sessions") {
    request.params.transport = transportForCommand(
      request.command === "operation_start" ? request.params.command : request.command,
    );
  }
  const result =
    args._[0] === "sessions"
      ? await client.listSessions()
      : await client.request(request.command, request.params, request.timeoutMs);
  if (args._[0] === "ymodem-receive" && args.output && result?.dataBase64) {
    writeFileSync(String(args.output), Buffer.from(result.dataBase64, "base64"));
  }
  console.log(JSON.stringify({ ok: true, command: request.command, result }, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        url: client.url,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  client.close();
}
