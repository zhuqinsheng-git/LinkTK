import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocketServer } from "ws";

const root = fileURLToPath(new URL("..", import.meta.url));
const serverPath = fileURLToPath(new URL("../tools/linktk-mcp.mjs", import.meta.url));
const defaultToolNames = [
  "linktk_launch",
  "linktk_sessions",
  "linktk_select_session",
  "linktk_snapshot",
  "linktk_session_claim",
  "linktk_session_release",
  "linktk_leases",
  "linktk_operations",
  "linktk_operation_start",
  "linktk_operation_status",
  "linktk_operation_cancel",
  "linktk_targets",
  "linktk_connect",
  "linktk_disconnect",
  "linktk_execute",
  "linktk_observe",
  "linktk_transfer_file",
  "linktk_bridge",
  "linktk_macro",
  "linktk_device_profile",
  "linktk_transaction",
  "linktk_task",
  "linktk_evidence",
];
const advancedToolNames = [
  "linktk_status",
  "linktk_serial_send",
  "linktk_serial_connect",
  "linktk_sftp_upload_chunk",
  "linktk_ymodem_send",
  "linktk_macro_run",
  "linktk_bridge_start",
  "linktk_device_profile_upsert",
  "linktk_transaction_execute",
  "linktk_task_run",
  "linktk_evidence_get",
];
const controlServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(controlServer, "listening");
const address = controlServer.address();
const controlUrl = `ws://127.0.0.1:${address.port}`;
const controlRequests = [];

controlServer.on("connection", (socket) => {
  socket.on("message", (raw) => {
    const request = JSON.parse(raw.toString());
    controlRequests.push(request);
    if (request.type === "agent:claim-session") {
      socket.send(
        JSON.stringify({
          type: "agent:session-claimed",
          id: request.id,
          ok: true,
          lease: {
            leaseId: "lease-1",
            sessionId: request.sessionId || "session-alpha",
            mode: request.mode,
            controllerId: "ai-1",
            controllerLabel: "AI controller 1",
          },
          leases: [],
        }),
      );
      return;
    }
    if (request.type === "agent:release-session") {
      socket.send(
        JSON.stringify({
          type: "agent:session-released",
          id: request.id,
          ok: true,
          released: true,
          sessionId: request.sessionId || "session-alpha",
          leases: [],
        }),
      );
      return;
    }
    if (request.type === "agent:list-leases") {
      socket.send(
        JSON.stringify({
          type: "agent:leases",
          id: request.id,
          controllerId: "ai-1",
          leases: [],
        }),
      );
      return;
    }
    if (request.type === "agent:list-sessions") {
      socket.send(
        JSON.stringify({
          type: "agent:sessions",
          id: request.id,
          sessions: [
            {
              sessionId: "session-alpha",
              label: "Test Session Alpha",
              capabilities: { serial: true, ssh: true },
              state: { workspaceMode: "serial" },
            },
          ],
        }),
      );
      return;
    }
    if (request.type === "agent:select-session") {
      socket.send(
        JSON.stringify({
          type: "agent:session-selected",
          id: request.id,
          ok: request.sessionId === "session-alpha",
          session:
            request.sessionId === "session-alpha"
              ? {
                  sessionId: "session-alpha",
                  label: "Test Session Alpha",
                }
              : undefined,
          error: request.sessionId === "session-alpha" ? "" : "Test session not found.",
          sessions: [
            {
              sessionId: "session-alpha",
              label: "Test Session Alpha",
              capabilities: { serial: true, ssh: true },
              state: { workspaceMode: "serial" },
            },
          ],
        }),
      );
      return;
    }
    socket.send(
      JSON.stringify({
        type: "agent:result",
        id: request.id,
        ok: true,
        result: {
          command: request.command,
          transport: request.params?.transport,
          routeTransport: request.params?._routeTransport,
        },
      }),
    );
  });
});

function connectClient(env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: root,
    env: {
      ...process.env,
      LINKTK_AGENT_URL: controlUrl,
      LINKTK_AGENT_TOKEN: "linktk-mcp-test-token-0123456789",
      ...env,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "linktk-mcp-test", version: "1.0.0" });
  return { client, transport };
}

async function callJson(client, name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content?.find((item) => item.type === "text")?.text || "";
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { text };
  }
  if (response.isError) {
    throw new Error(`${name}: ${payload.error || text || "MCP tool failed"}`);
  }
  return payload;
}

async function testDefaultSurface() {
  const { client, transport } = connectClient();
  const transferRoot = mkdtempSync(join(tmpdir(), "linktk-mcp-transfer-"));
  const transferPath = join(transferRoot, "business-upload.bin");
  writeFileSync(transferPath, Buffer.alloc(1024 * 1024 + 1, 0x42));
  const inlineTransferPath = join(transferRoot, "business-inline-upload.bin");
  writeFileSync(inlineTransferPath, Buffer.alloc(1024, 0x43));
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    const toolsByName = new Map(tools.tools.map((tool) => [tool.name, tool]));
    assert.deepEqual(names, [...defaultToolNames].sort());
    for (const name of advancedToolNames) {
      assert.ok(!names.includes(name), `Advanced tool leaked into default surface: ${name}`);
    }
    assert.equal(toolsByName.get("linktk_targets").annotations?.readOnlyHint, true);
    assert.equal(toolsByName.get("linktk_execute").annotations?.destructiveHint, true);
    assert.equal(toolsByName.get("linktk_observe").annotations?.readOnlyHint, true);

    const sessionsPayload = await callJson(client, "linktk_sessions");
    assert.equal(sessionsPayload.sessions[0].sessionId, "session-alpha");

    const selectedPayload = await callJson(client, "linktk_select_session", {
      sessionId: "session-alpha",
    });
    assert.equal(selectedPayload.selectedSessionId, "session-alpha");

    const claimPayload = await callJson(client, "linktk_session_claim", {
      sessionId: "session-alpha",
      mode: "exclusive",
    });
    assert.equal(claimPayload.lease.leaseId, "lease-1");

    const releasePayload = await callJson(client, "linktk_session_release", {
      sessionId: "session-alpha",
    });
    assert.equal(releasePayload.released, true);

    const launchPayload = await callJson(client, "linktk_launch", {
      openBrowser: false,
      waitForSession: false,
      selectSingle: true,
    });
    assert.equal(launchPayload.ready, true);
    assert.equal(launchPayload.selectedSessionId, "session-alpha");

    const snapshotPayload = await callJson(client, "linktk_snapshot");
    assert.equal(snapshotPayload.command, "snapshot");
    assert.equal(snapshotPayload.transport, "serial");

    const operationStartPayload = await callJson(client, "linktk_operation_start", {
      command: "ssh_exec",
      params: { data: "uname -a", expect: "Linux" },
    });
    assert.equal(operationStartPayload.command, "operation_start");
    assert.equal(operationStartPayload.transport, "ssh");
    const operationStartRequest = [...controlRequests]
      .reverse()
      .find((request) => request.command === "operation_start");
    assert.ok(
      operationStartRequest?.timeoutMs >= 180000,
      `Background write-operation approval window is too short: ${operationStartRequest?.timeoutMs}`,
    );

    const operationCancelPayload = await callJson(client, "linktk_operation_cancel", {
      operationId: "operation-1",
    });
    assert.equal(operationCancelPayload.command, "operation_cancel");

    const targetsPayload = await callJson(client, "linktk_targets", {
      transport: "serial",
    });
    assert.equal(targetsPayload.serial.ports.command, "serial_ports");
    assert.equal(targetsPayload.serial.presets.command, "serial_presets");

    const connectPayload = await callJson(client, "linktk_connect", {
      transport: "serial",
      portIndex: 0,
      baudRate: 115200,
    });
    assert.equal(connectPayload.command, "serial_connect");
    assert.equal(connectPayload.transport, "serial");

    const executePayload = await callJson(client, "linktk_execute", {
      transport: "serial",
      data: "help",
      ending: "lf",
    });
    assert.equal(executePayload.command, "send");
    assert.equal(executePayload.transport, "serial");
    const executeRequest = [...controlRequests]
      .reverse()
      .find((request) => request.command === "send");
    assert.ok(
      executeRequest?.timeoutMs >= 180000,
      `Write-operation approval window is too short: ${executeRequest?.timeoutMs}`,
    );

    const observePayload = await callJson(client, "linktk_observe", {
      transport: "serial",
      mode: "read",
    });
    assert.equal(observePayload.command, "read");
    assert.equal(observePayload.transport, "serial");
    const observeRequest = [...controlRequests]
      .reverse()
      .find((request) => request.command === "read");
    assert.ok(
      observeRequest?.timeoutMs < 60000,
      `Read-only operations should not use the write-operation approval window: ${observeRequest?.timeoutMs}`,
    );

    const disconnectPayload = await callJson(client, "linktk_disconnect", {
      transport: "serial",
    });
    assert.equal(disconnectPayload.command, "serial_disconnect");

    const profilePayload = await callJson(client, "linktk_device_profile", {
      action: "upsert",
      name: "Network board",
      transport: "network",
    });
    assert.equal(profilePayload.command, "device_profile_upsert");
    assert.equal(profilePayload.transport, "network");
    assert.equal(profilePayload.routeTransport, "serial");

    const transactionPayload = await callJson(client, "linktk_transaction", {
      name: "MCP transaction",
      steps: [{ command: "read", params: {} }],
      atomic: false,
      allowIrreversible: true,
    });
    assert.equal(transactionPayload.command, "transaction_execute");

    const taskPayload = await callJson(client, "linktk_task", {
      action: "create",
      name: "MCP task",
      transport: "ssh",
      steps: [{ command: "read", params: {} }],
      atomic: false,
      allowIrreversible: true,
    });
    assert.equal(taskPayload.command, "task_create");
    assert.equal(taskPayload.transport, "ssh");
    assert.equal(taskPayload.routeTransport, "serial");

    const evidencePayload = await callJson(client, "linktk_evidence", {
      operationId: "operation-1",
    });
    assert.equal(evidencePayload.command, "evidence_get");

    const transferPayload = await callJson(client, "linktk_transfer_file", {
      direction: "upload",
      protocol: "sftp",
      localPath: transferPath,
      remotePath: "/tmp/business-upload.bin",
    });
    assert.equal(transferPayload.command, "sftp_upload_from_file");
    const transferRequest = [...controlRequests]
      .reverse()
      .find((request) => request.command === "sftp_upload_from_file");
    assert.equal(transferRequest?.params?.localPath, transferPath);
    assert.equal(transferRequest?.params?.dataBase64, undefined);
    assert.equal(transferRequest?.params?.overwrite, false);

    await callJson(client, "linktk_transfer_file", {
      direction: "upload",
      protocol: "sftp",
      localPath: transferPath,
      remotePath: "/tmp/business-upload.bin",
      overwrite: true,
    });
    const overwriteTransferRequest = [...controlRequests]
      .reverse()
      .find((request) => request.command === "sftp_upload_from_file");
    assert.equal(overwriteTransferRequest?.params?.overwrite, true);

    const inlineTransferPayload = await callJson(client, "linktk_transfer_file", {
      direction: "upload",
      protocol: "sftp",
      localPath: inlineTransferPath,
      remotePath: "/tmp/business-inline-upload.bin",
      overwrite: true,
    });
    assert.equal(inlineTransferPayload.command, "sftp_upload");
    const inlineTransferRequest = [...controlRequests]
      .reverse()
      .find((request) => request.command === "sftp_upload");
    assert.equal(inlineTransferRequest?.params?.overwrite, true);

    const downloadPath = join(transferRoot, "business-download.bin");
    const downloadPayload = await callJson(client, "linktk_transfer_file", {
      direction: "download",
      protocol: "sftp",
      remotePath: "/tmp/business-upload.bin",
      localPath: downloadPath,
      overwrite: true,
    });
    assert.equal(downloadPayload.command, "sftp_download_to_file");
    const downloadRequest = [...controlRequests]
      .reverse()
      .find((request) => request.command === "sftp_download_to_file");
    assert.equal(downloadRequest?.params?.localPath, downloadPath);
    assert.equal(downloadRequest?.params?.overwrite, true);

    console.log(
      `Default MCP surface passed: ${names.length} business tools, ${advancedToolNames.length} advanced names hidden.`,
    );
  } finally {
    await client.close();
    rmSync(transferRoot, { recursive: true, force: true });
  }
}

async function testAdvancedSurface() {
  const { client, transport } = connectClient({ LINKTK_MCP_ADVANCED: "1" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    const toolsByName = new Map(tools.tools.map((tool) => [tool.name, tool]));
    for (const name of [...defaultToolNames, ...advancedToolNames]) {
      assert.ok(names.includes(name), `Missing advanced MCP tool: ${name}`);
    }
    assert.equal(toolsByName.get("linktk_status").annotations?.readOnlyHint, true);
    assert.equal(toolsByName.get("linktk_serial_send").annotations?.destructiveHint, true);

    const statusPayload = await callJson(client, "linktk_status", {
      transport: "ssh",
    });
    assert.equal(statusPayload.command, "ssh_status");
    assert.equal(statusPayload.transport, "ssh");

    const sendPayload = await callJson(client, "linktk_serial_send", {
      data: "PING",
      ending: "lf",
    });
    assert.equal(sendPayload.command, "send");
    assert.equal(sendPayload.transport, "serial");

    console.log(
      `Advanced MCP surface passed: ${names.length} total tools with low-level protocol access enabled.`,
    );
  } finally {
    await client.close();
  }
}

try {
  await testDefaultSurface();
  await testAdvancedSurface();
} finally {
  controlServer.close();
  await once(controlServer, "close");
}
