// Module: AI control-channel wiring, command dispatch, and UI task replay.
// Owns: control channel registration/reconnect, command/withdraw message dispatch, and task replay entry.
// Depends on: agent.js, agent/operations.js, agent/runtime.js, core/state.js, toast, errors.
// Called by: app.js initialization and event binding; the transaction executor is injected by app.js.

import { AgentBridgeClient } from "../agent.js";
import { errorMessage } from "../core/errors.js";
import { t } from "../core/i18n.js";
import { state } from "../core/state.js";
import { showToast } from "../features/toast.js";
import { getAgentCommandRisk, withdrawAgentOperation } from "./operations.js";
import { getAgentCapabilities, getAgentSessionLabel, getAgentStatusSnapshot, publishAgentState, renderAgentActivity, updateAgentUI } from "./runtime.js";

let executeAgentCommand = null;
let startAgentOperation = null;
let runAgentOperation = null;

function initializeAgentBridgeController({
  executeAgentCommand: executeAgentCommandCallback,
  startAgentOperation: startAgentOperationCallback,
  runAgentOperation: runAgentOperationCallback,
} = {}) {
  if (
    typeof executeAgentCommandCallback !== "function" ||
    typeof startAgentOperationCallback !== "function" ||
    typeof runAgentOperationCallback !== "function"
  ) {
    throw new TypeError(
      "initializeAgentBridgeController requires executeAgentCommand, startAgentOperation and runAgentOperation.",
    );
  }
  executeAgentCommand = executeAgentCommandCallback;
  startAgentOperation = startAgentOperationCallback;
  runAgentOperation = runAgentOperationCallback;
}

function runAgentTaskFromUI(taskId) {
  const template = state.taskTemplates.find((item) => item.id === taskId);
  if (!template) return;
  try {
    startAgentOperation("task_run", { taskId });
    renderAgentActivity();
    showToast(t("agent.tasks.replayStarted", { name: template.name }), "info");
  } catch (error) {
    showToast(errorMessage(error, t("agent.tasks.replayFailed")), "error");
  }
}

async function handleAgentCommand(message) {
  const command = String(message.command || "");
  const params = message.params || {};
  const controller = {
    id: String(message.controllerId || ""),
    label: String(message.controllerLabel || ""),
  };
  if (controller.id) {
    state.agentLastController = controller;
    state.agentLease = params._lease || state.agentLease;
  }
  try {
    if (["snapshot", "operation_status", "operation_list", "operation_cancel"].includes(command)) {
      const result = await executeAgentCommand(command, params);
      state.agentBridge?.respond(message.id, { ok: true, result });
      return;
    }

    if (command === "operation_start") {
      const nestedCommand = String(params.command || "");
      const nestedParams = params.params || {};
      const nestedReadOnly = getAgentCommandRisk(nestedCommand, nestedParams) === "read";
      if (!nestedReadOnly && state.agentActiveOperationId) {
        throw new Error(t("agent.busy.anotherRunning"));
      }
      const operation = startAgentOperation(
        nestedCommand,
        nestedParams,
        {
          controller,
          requestId: message.id,
          timeoutMs: message.timeoutMs,
          deadline: message.deadline,
        },
      );
      state.agentBridge?.respond(message.id, {
        ok: true,
        result: {
          operation,
          activeOperationId: operation.operationId,
        },
      });
      return;
    }

    const result = await runAgentOperation(command, params, {
      controller,
      requestId: message.id,
      timeoutMs: message.timeoutMs,
      deadline: message.deadline,
    });
    state.agentBridge?.respond(message.id, { ok: true, result });
  } catch (error) {
    state.agentBridge?.respond(message.id, {
      ok: false,
      error: errorMessage(error, t("agent.failed")),
    });
  }
}

function initializeAgentBridge() {
  const client = new AgentBridgeClient({
    onReady: () => {
      state.agentBridgeReady = true;
      state.agentBridgeError = "";
      updateAgentUI();
      void client
        .register({
          client: "ui",
          sessionId: state.agentSessionId,
          label: getAgentSessionLabel(),
          capabilities: getAgentCapabilities(),
          state: getAgentStatusSnapshot(),
        })
        .catch((error) => {
          state.agentBridgeError = errorMessage(error, t("agent.bridge.registerFailed"));
          updateAgentUI();
        });
    },
    onRegistered: () => {
      state.agentBridgeReady = true;
      state.agentBridgeError = "";
      publishAgentState();
      updateAgentUI();
    },
    onControllerState: (message) => {
      state.agentControllerConnected = Boolean(message.connected);
      publishAgentState();
      updateAgentUI();
    },
    onLeaseState: (message) => {
      if (message.sessionId === state.agentSessionId) {
        state.agentLease = message.lease || null;
      }
      publishAgentState();
      updateAgentUI();
      renderAgentActivity();
    },
    onCommand: handleAgentCommand,
    onWithdraw: (message) =>
      withdrawAgentOperation(message.id, message.reason, message.reasonCode),
    onError: (message) => {
      state.agentBridgeError = message;
      updateAgentUI();
    },
    onConnectionState: (connected) => {
      if (!connected) {
        state.agentBridgeReady = false;
        state.agentControllerConnected = false;
      }
      publishAgentState();
      updateAgentUI();
    },
  });
  state.agentBridge = client;
  updateAgentUI();
  void client.connect().catch((error) => {
    state.agentBridgeError = errorMessage(error, t("agent.bridge.connectFailed"));
    updateAgentUI();
  });
}

export { initializeAgentBridge, initializeAgentBridgeController, runAgentTaskFromUI };
