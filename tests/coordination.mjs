import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { agentBridgePlugin } from "../server/agent-bridge.js";

const testToken = "linktk-test-token-0123456789abcdef";
const httpServer = createServer();
httpServer.listen(0, "127.0.0.1");
await once(httpServer, "listening");

const address = httpServer.address();
const baseUrl = `ws://127.0.0.1:${address.port}`;
const pageOrigin = `http://127.0.0.1:${address.port}`;
const plugin = agentBridgePlugin({ token: testToken });
plugin.configureServer({ httpServer });

function createClient(path, options = {}) {
  const socket = new WebSocket(`${baseUrl}${path}`, options);
  const messages = [];
  const waiters = new Set();

  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });

  return {
    socket,
    messages,
    async open() {
      if (socket.readyState === WebSocket.OPEN) return;
      await once(socket, "open");
    },
    send(message) {
      socket.send(JSON.stringify(message));
    },
    waitFor(predicate, timeoutMs = 5000) {
      const existing = [...messages].reverse().find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(
              new Error(
                `Timed out waiting for coordination message:\n${messages
                  .slice(-20)
                  .map((message) => JSON.stringify(message))
                  .join("\n")}`,
              ),
            );
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      socket.close();
      await once(socket, "close");
    },
  };
}

function expectUpgradeRejected(path, statusCode, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl}${path}`, options);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`Timed out waiting for HTTP ${statusCode} on ${path}.`));
    }, 5000);
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      assert.equal(response.statusCode, statusCode);
      response.resume();
      socket.close();
      resolve();
    });
    socket.once("open", () => {
      clearTimeout(timer);
      socket.terminate();
      reject(new Error(`Expected HTTP ${statusCode} on ${path}, but the socket opened.`));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const controllerHeaders = {
  headers: {
    "x-linktk-agent-token": testToken,
  },
};
const browser = createClient("/__agent", { origin: pageOrigin });
const controllerA = createClient("/__agent-control", controllerHeaders);
const controllerB = createClient("/__agent-control", controllerHeaders);
const controllerC = createClient("/__agent-control", controllerHeaders);

try {
  await expectUpgradeRejected("/__agent-control", 401);
  await expectUpgradeRejected("/__agent-control", 401, {
    headers: {
      "x-linktk-agent-token": "wrong-token-0123456789abcdef",
    },
  });
  await expectUpgradeRejected("/__agent", 403, {
    origin: "http://malicious.example",
  });

  await Promise.all([
    browser.open(),
    controllerA.open(),
    controllerB.open(),
    controllerC.open(),
  ]);
  await browser.waitFor((message) => message.type === "agent:bridge-ready");
  const controllerAReady = await controllerA.waitFor(
    (message) => message.type === "agent:control-ready",
  );
  const controllerBReady = await controllerB.waitFor(
    (message) => message.type === "agent:control-ready",
  );
  await controllerC.waitFor((message) => message.type === "agent:control-ready");

  browser.send({
    type: "agent:register",
    client: "ui",
    sessionId: "board-a",
    label: "Coordination Board A",
    capabilities: { serial: true, network: false, ssh: true },
    state: { workspaceMode: "serial" },
  });
  await browser.waitFor((message) => message.type === "agent:registered");
  await controllerA.waitFor(
    (message) =>
      message.type === "agent:sessions" &&
      message.sessions?.some((session) => session.sessionId === "board-a"),
  );

  const claimId = randomUUID();
  controllerA.send({
    type: "agent:claim-session",
    id: claimId,
    sessionId: "board-a",
    mode: "exclusive",
  });
  const claimed = await controllerA.waitFor(
    (message) => message.type === "agent:session-claimed" && message.id === claimId,
  );
  assert.equal(claimed.ok, true);
  assert.equal(claimed.lease.controllerId, controllerAReady.controllerId);

  const rejectedWriteId = randomUUID();
  controllerB.send({
    type: "agent:request",
    id: rejectedWriteId,
    command: "send",
    params: {
      transport: "serial",
      sessionId: "board-a",
      data: "SHOULD_NOT_REACH_BOARD",
    },
  });
  const rejectedWrite = await controllerB.waitFor(
    (message) => message.type === "agent:result" && message.id === rejectedWriteId,
  );
  assert.equal(rejectedWrite.ok, false);
  assert.match(rejectedWrite.error, /exclusive/i);
  assert.equal(
    browser.messages.some(
      (message) =>
        message.type === "agent:command" && message.command === "send",
    ),
    false,
  );

  const leasedDownloadId = randomUUID();
  controllerB.send({
    type: "agent:request",
    id: leasedDownloadId,
    command: "sftp_download_to_file",
    params: {
      transport: "ssh",
      sessionId: "board-a",
      path: "/tmp/leased.bin",
      localPath: "D:\\tmp\\leased.bin",
      overwrite: false,
    },
  });
  const forwardedLeasedDownload = await browser.waitFor(
    (message) =>
      message.type === "agent:command" && message.id === leasedDownloadId,
  );
  browser.send({
    type: "agent:response",
    id: forwardedLeasedDownload.id,
    ok: true,
    result: { forwarded: true },
  });
  const leasedDownloadResult = await controllerB.waitFor(
    (message) =>
      message.type === "agent:result" && message.id === leasedDownloadId,
  );
  assert.equal(leasedDownloadResult.ok, true);
  assert.equal(leasedDownloadResult.result.forwarded, true);

  const overwriteDownloadId = randomUUID();
  controllerB.send({
    type: "agent:request",
    id: overwriteDownloadId,
    command: "sftp_download_to_file",
    params: {
      transport: "ssh",
      sessionId: "board-a",
      path: "/tmp/existing.bin",
      localPath: "D:\\tmp\\existing.bin",
      overwrite: true,
    },
  });
  const overwriteDownloadResult = await controllerB.waitFor(
    (message) =>
      message.type === "agent:result" && message.id === overwriteDownloadId,
  );
  assert.equal(overwriteDownloadResult.ok, false);
  assert.match(overwriteDownloadResult.error, /exclusive/i);
  assert.equal(
    browser.messages.some(
      (message) =>
        message.type === "agent:command" &&
        message.id === overwriteDownloadId,
    ),
    false,
  );

  const readId = randomUUID();
  controllerB.send({
    type: "agent:request",
    id: readId,
    command: "status",
    params: { transport: "serial", sessionId: "board-a" },
  });
  const forwardedRead = await browser.waitFor(
    (message) => message.type === "agent:command" && message.id === readId,
  );
  browser.send({
    type: "agent:response",
    id: forwardedRead.id,
    ok: true,
    result: { connected: true, board: "board-a" },
  });
  const readResult = await controllerB.waitFor(
    (message) => message.type === "agent:result" && message.id === readId,
  );
  assert.equal(readResult.ok, true);
  assert.equal(readResult.result.connected, true);

  const routedReadId = randomUUID();
  controllerB.send({
    type: "agent:request",
    id: routedReadId,
    command: "status",
    params: {
      transport: "network",
      _routeTransport: "serial",
      sessionId: "board-a",
    },
  });
  const routedRead = await browser.waitFor(
    (message) => message.type === "agent:command" && message.id === routedReadId,
  );
  browser.send({
    type: "agent:response",
    id: routedRead.id,
    ok: true,
    result: { routed: true },
  });
  const routedReadResult = await controllerB.waitFor(
    (message) => message.type === "agent:result" && message.id === routedReadId,
  );
  assert.equal(routedReadResult.ok, true);
  assert.equal(routedReadResult.result.routed, true);

  const timeoutWithdrawId = randomUUID();
  controllerB.send({
    type: "agent:request",
    id: timeoutWithdrawId,
    command: "status",
    params: { transport: "serial", sessionId: "board-a" },
    timeoutMs: 1000,
  });
  await browser.waitFor(
    (message) => message.type === "agent:command" && message.id === timeoutWithdrawId,
  );
  const timeoutWithdraw = await browser.waitFor(
    (message) =>
      message.type === "agent:command-withdraw" && message.id === timeoutWithdrawId,
  );
  assert.equal(timeoutWithdraw.reasonCode, "timeout");
  const timeoutResult = await controllerB.waitFor(
    (message) => message.type === "agent:result" && message.id === timeoutWithdrawId,
  );
  assert.equal(timeoutResult.ok, false);
  assert.equal(timeoutResult.result.withdrawn, true);
  assert.equal(timeoutResult.result.reasonCode, "timeout");

  const afterTimeoutId = randomUUID();
  controllerB.send({
    type: "agent:request",
    id: afterTimeoutId,
    command: "status",
    params: { transport: "serial", sessionId: "board-a" },
  });
  const afterTimeout = await browser.waitFor(
    (message) => message.type === "agent:command" && message.id === afterTimeoutId,
  );
  browser.send({
    type: "agent:response",
    id: afterTimeout.id,
    ok: true,
    result: { afterWithdraw: true },
  });
  const afterTimeoutResult = await controllerB.waitFor(
    (message) => message.type === "agent:result" && message.id === afterTimeoutId,
  );
  assert.equal(afterTimeoutResult.ok, true);
  assert.equal(afterTimeoutResult.result.afterWithdraw, true);

  const disconnectWithdrawId = randomUUID();
  controllerC.send({
    type: "agent:request",
    id: disconnectWithdrawId,
    command: "status",
    params: { transport: "serial", sessionId: "board-a" },
    timeoutMs: 10000,
  });
  await browser.waitFor(
    (message) => message.type === "agent:command" && message.id === disconnectWithdrawId,
  );
  await controllerC.close();
  const disconnectWithdraw = await browser.waitFor(
    (message) =>
      message.type === "agent:command-withdraw" && message.id === disconnectWithdrawId,
  );
  assert.equal(disconnectWithdraw.reasonCode, "controller-disconnected");

  const releaseId = randomUUID();
  controllerA.send({
    type: "agent:release-session",
    id: releaseId,
    sessionId: "board-a",
  });
  const released = await controllerA.waitFor(
    (message) => message.type === "agent:session-released" && message.id === releaseId,
  );
  assert.equal(released.released, true);

  const reclaimId = randomUUID();
  controllerB.send({
    type: "agent:claim-session",
    id: reclaimId,
    sessionId: "board-a",
    mode: "exclusive",
  });
  const reclaimed = await controllerB.waitFor(
    (message) => message.type === "agent:session-claimed" && message.id === reclaimId,
  );
  assert.equal(reclaimed.ok, true);
  assert.equal(reclaimed.lease.controllerId, controllerBReady.controllerId);

  const takeoverId = randomUUID();
  controllerA.send({
    type: "agent:claim-session",
    id: takeoverId,
    sessionId: "board-a",
    mode: "exclusive",
    force: true,
  });
  const takeover = await controllerA.waitFor(
    (message) => message.type === "agent:session-claimed" && message.id === takeoverId,
  );
  assert.equal(takeover.ok, true);
  assert.equal(takeover.lease.controllerId, controllerAReady.controllerId);

  console.log(
    "Coordination test passed: leases, concurrent read-only queries, timeout/controller-disconnect withdrawal, release, and forced takeover work.",
  );
} finally {
  await Promise.allSettled([
    browser.close(),
    controllerA.close(),
    controllerB.close(),
    controllerC.close(),
  ]);
  await new Promise((resolve) => httpServer.close(resolve));
}
