// Module: AI transaction history and serialization.
// Owns: transaction creation, trimming, listing, result summaries, and rollback summaries.
// Depends on: core/constants.js, core/state.js, agent/runtime.js.
// Called by: app.js transaction execution and AI command implementations.

import { MAX_AGENT_TRANSACTIONS } from "../core/constants.js";
import { t } from "../core/i18n.js";
import { state } from "../core/state.js";
import { publishAgentState, summarizeAgentResultPreview } from "./runtime.js";

function trimAgentTransactionHistory() {
  while (state.agentTransactions.size > MAX_AGENT_TRANSACTIONS) {
    const oldest = state.agentTransactions.keys().next().value;
    state.agentTransactions.delete(oldest);
  }
}

function createAgentTransaction(name, steps) {
  state.agentTransactionSequence += 1;
  const id =
    crypto.randomUUID?.() ||
    `agent-transaction-${Date.now()}-${state.agentTransactionSequence}`;
  const transaction = {
    id,
    name: String(name || `AI transaction ${state.agentTransactionSequence}`).slice(0, 120),
    status: "running",
    steps: steps.map((step, index) => ({
      ...step,
      id: step.id || `step-${index + 1}`,
    })),
    stepResults: [],
    rollbackStatus: "not-needed",
    startedAt: Date.now(),
    finishedAt: 0,
    error: "",
    result: undefined,
  };
  state.agentTransactions.set(id, transaction);
  trimAgentTransactionHistory();
  publishAgentState();
  return transaction;
}

function serializeAgentTransaction(transaction, { includeResult = false } = {}) {
  if (!transaction) return null;
  return {
    transactionId: transaction.id,
    name: transaction.name,
    status: transaction.status,
    rollbackStatus: transaction.rollbackStatus,
    startedAt: transaction.startedAt,
    finishedAt: transaction.finishedAt,
    durationMs: transaction.finishedAt
      ? Math.max(0, transaction.finishedAt - transaction.startedAt)
      : Math.max(0, Date.now() - transaction.startedAt),
    error: transaction.error,
    steps: transaction.stepResults.map((step) => ({
      stepId: step.stepId,
      label: step.label,
      command: step.command,
      status: step.status,
      attempted: Boolean(step.executionStarted),
      undo: step.undo
        ? {
            kind: step.undo.kind,
            reason: step.undo.reason || "",
            path: step.undo.path || "",
            from: step.undo.from || "",
            to: step.undo.to || "",
            backupBytes: step.undo.bytes?.byteLength || 0,
            summary: transactionUndoSummary(step.undo),
          }
        : null,
      rollback: step.rollback,
      error: step.error,
      result: includeResult ? step.result : undefined,
      resultPreview: step.result ? summarizeAgentResultPreview(step.result) : "",
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
    })),
    ...(includeResult ? { result: transaction.result } : {}),
  };
}

function listAgentTransactions(limit = 20) {
  const count = Math.max(1, Math.min(MAX_AGENT_TRANSACTIONS, Number(limit) || 20));
  return [...state.agentTransactions.values()]
    .slice(-count)
    .reverse()
    .map((transaction) => serializeAgentTransaction(transaction));
}

function transactionUndoSummary(undo) {
  if (!undo) return "";
  if (undo.kind === "not-required") return t("agent.undo.notRequired");
  if (undo.kind === "unsupported") return t("agent.undo.unsupported", { reason: undo.reason });
  if (undo.kind === "restore-file") return t("agent.undo.restoreFile", { path: undo.path });
  if (undo.kind === "delete-file") return t("agent.undo.deleteFile", { path: undo.path });
  if (undo.kind === "rename") return t("agent.undo.renameBack", { path: undo.to });
  if (undo.kind === "mkdir") return t("agent.undo.mkdir", { path: undo.path });
  if (undo.kind === "delete-directory") return t("agent.undo.deleteDirectory", { path: undo.path });
  return undo.kind;
}

export { createAgentTransaction, listAgentTransactions, serializeAgentTransaction, transactionUndoSummary, trimAgentTransactionHistory };
