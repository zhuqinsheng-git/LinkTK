// Module: AI console, device profile dialog, and task/evidence actions.
// Owns: AI dialogs, MCP config copy, profile editing, evidence export, and session control UI.
// Depends on: core, features/log-view.js, features/toast.js, agent/runtime.js, operations.js, catalog.js.
// Called by: app.js event bindings.

import { els } from "../core/dom.js";
import { errorMessage } from "../core/errors.js";
import { t } from "../core/i18n.js";
import { persistAgentSessionLabel, state } from "../core/state.js";
import { copyTextToClipboard } from "../features/log-view.js";
import { showToast } from "../features/toast.js";
import { createTaskFromAgentOperation, deleteDeviceProfileForAgent, deleteTaskTemplateForAgent, getAgentEvidenceForOperation, selectDeviceProfileForAgent, upsertDeviceProfileForAgent } from "./catalog.js";
import { settleAgentApproval } from "./operations.js";
import { getAgentCapabilities, getAgentSessionLabel, getAgentStatusSnapshot, publishAgentState, renderAgentActivity, updateAgentLeaseSummary, updateAgentUI } from "./runtime.js";

function openAgentActivityDialog() {
  setAgentActivityView("records");
  state.agentActivityLastSeenSequence = state.agentOperationSequence;
  renderAgentActivity();
  if (!els.agentActivityDialog.open) {
    if (window.matchMedia("(max-width: 680px)").matches) {
      els.agentActivityDialog.showModal();
    } else {
      els.agentActivityDialog.show();
    }
  }
  state.agentActivityOpen = true;
  if (state.agentActivityLeaseTimer) {
    window.clearInterval(state.agentActivityLeaseTimer);
  }
  state.agentActivityLeaseTimer = window.setInterval(updateAgentLeaseSummary, 1000);
}

function setAgentActivityView(view, { focus = false } = {}) {
  const normalized = view === "control" ? "control" : "records";
  state.agentActivityView = normalized;
  if (els.agentActivityRecordsPanel) {
    els.agentActivityRecordsPanel.hidden = normalized !== "records";
  }
  if (els.agentActivityControlPanel) {
    els.agentActivityControlPanel.hidden = normalized !== "control";
  }
  els.agentActivityTabButtons.forEach((button) => {
    const active = button.dataset.agentActivityView === normalized;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    if (active && focus) button.focus();
  });
  if (normalized === "records") {
    state.agentActivityLastSeenSequence = Math.max(
      state.agentActivityLastSeenSequence,
      state.agentOperationSequence,
    );
    renderAgentActivity();
  }
}

function closeAgentActivityDialog() {
  if (els.agentActivityDialog.open) els.agentActivityDialog.close();
  state.agentActivityOpen = false;
  if (state.agentActivityLeaseTimer) {
    window.clearInterval(state.agentActivityLeaseTimer);
    state.agentActivityLeaseTimer = null;
  }
}

function getAgentControlWebSocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/__agent-control`;
}

async function copyMcpConfigToClipboard() {
  const button = els.agentCopyMcpConfigButton;
  if (button) button.disabled = true;
  try {
    const response = await fetch("/__linktk/mcp-config", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(t("agent.mcp.readFailed"));
    const config = await response.json();
    const server = config?.mcpServers?.linktk;
    if (!server?.command || !Array.isArray(server.args)) {
      throw new Error(t("agent.mcp.configIncomplete"));
    }
    server.env = {
      ...(server.env || {}),
      LINKTK_AGENT_URL: getAgentControlWebSocketUrl(),
    };
    await copyTextToClipboard(
      JSON.stringify(config, null, 2),
      t("agent.mcp.configCopied"),
    );
  } catch (error) {
    showToast(errorMessage(error, t("agent.mcp.copyFailed")), "error");
  } finally {
    if (button) button.disabled = false;
  }
}

function textareaLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function openAgentDeviceProfileDialog(profileId = state.activeDeviceProfileId) {
  if (!els.agentDeviceProfileDialog) return;
  const requestedProfileId = profileId === undefined ? state.activeDeviceProfileId : profileId;
  const profile = requestedProfileId
    ? state.deviceProfiles.find((item) => item.id === requestedProfileId) || null
    : null;
  if (els.agentProfileSelect) {
    els.agentProfileSelect.replaceChildren();
    const newOption = document.createElement("option");
    newOption.value = "";
    newOption.textContent = t("agent.profile.newOption");
    els.agentProfileSelect.append(newOption);
    state.deviceProfiles.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = `${item.name}${item.board ? ` · ${item.board}` : ""}`;
      els.agentProfileSelect.append(option);
    });
    els.agentProfileSelect.value = profile?.id || "";
  }
  els.agentProfileNameInput.value = profile?.name || "";
  els.agentProfileBoardInput.value = profile?.board || "";
  els.agentProfileTransport.value = profile?.transport || "any";
  els.agentProfileShellType.value = profile?.shellType || "linux";
  els.agentProfileLineEnding.value = profile?.lineEnding || "lf";
  els.agentProfilePromptPattern.value = profile?.promptPattern || "";
  els.agentProfileLoginPromptPattern.value = profile?.loginPromptPattern || "";
  els.agentProfileStartupPattern.value = profile?.startupPattern || "";
  els.agentProfileDescription.value = profile?.description || "";
  els.agentProfileCommonCommands.value = (profile?.commonCommands || []).join("\n");
  els.agentProfileDangerousPatterns.value = (profile?.dangerousPatterns || []).join("\n");
  els.agentDeviceProfileDialog.dataset.profileId = profile?.id || "";
  els.agentProfileDeleteButton.disabled = !profile?.id;
  if (!els.agentDeviceProfileDialog.open) els.agentDeviceProfileDialog.showModal();
}

function closeAgentDeviceProfileDialog() {
  if (els.agentDeviceProfileDialog?.open) els.agentDeviceProfileDialog.close();
}

function saveAgentDeviceProfileFromDialog() {
  try {
    const result = upsertDeviceProfileForAgent({
      profileId: els.agentDeviceProfileDialog.dataset.profileId || undefined,
      name: els.agentProfileNameInput.value,
      board: els.agentProfileBoardInput.value,
      transport: els.agentProfileTransport.value,
      shellType: els.agentProfileShellType.value,
      lineEnding: els.agentProfileLineEnding.value,
      promptPattern: els.agentProfilePromptPattern.value,
      loginPromptPattern: els.agentProfileLoginPromptPattern.value,
      startupPattern: els.agentProfileStartupPattern.value,
      description: els.agentProfileDescription.value,
      commonCommands: textareaLines(els.agentProfileCommonCommands.value),
      dangerousPatterns: textareaLines(els.agentProfileDangerousPatterns.value),
    });
    selectDeviceProfileForAgent({ profileId: result.profile.profileId });
    renderAgentActivity();
    closeAgentDeviceProfileDialog();
    showToast(t("agent.profile.saved"), "success");
  } catch (error) {
    showToast(errorMessage(error, t("agent.profile.saveFailed")), "error");
  }
}

function deleteAgentDeviceProfileFromDialog() {
  const profileId = els.agentDeviceProfileDialog.dataset.profileId;
  if (!profileId) return;
  try {
    deleteDeviceProfileForAgent({ profileId });
    renderAgentActivity();
    closeAgentDeviceProfileDialog();
    showToast(t("agent.profile.deleted"), "info");
  } catch (error) {
    showToast(errorMessage(error, t("agent.profile.deleteFailed")), "error");
  }
}

function downloadJsonFile(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function showAgentEvidence(operationId) {
  try {
    const evidence = getAgentEvidenceForOperation(operationId);
    downloadJsonFile(`linktk-evidence-${operationId}.json`, evidence);
    showToast(t("agent.evidence.exported"), "success");
  } catch (error) {
    showToast(errorMessage(error, t("agent.evidence.exportFailed")), "error");
  }
}

function saveAgentTaskFromOperationFromUI(operationId) {
  const operation = state.agentOperations.get(String(operationId || ""));
  if (!operation) return;
  const suggested = t("agent.tasks.suggestedName", { label: operation.label }).slice(0, 80);
  const name = window.prompt(t("agent.tasks.namePrompt"), suggested);
  if (name === null) return;
  try {
    const result = createTaskFromAgentOperation({ operationId, name });
    renderAgentActivity();
    showToast(t("agent.tasks.saved", { name: result.template.name }), "success");
  } catch (error) {
    showToast(errorMessage(error, t("agent.tasks.saveFailed")), "error");
  }
}

function deleteAgentTaskFromUI(taskId) {
  try {
    deleteTaskTemplateForAgent({ taskId });
    renderAgentActivity();
    showToast(t("agent.tasks.deleted"), "info");
  } catch (error) {
    showToast(errorMessage(error, t("agent.tasks.deleteFailed")), "error");
  }
}

function renameAgentSession() {
  const next = window.prompt(t("agent.session.renamePrompt"), getAgentSessionLabel());
  if (next === null) return;
  persistAgentSessionLabel(next);
  void state.agentBridge?.register({
    client: "ui",
    sessionId: state.agentSessionId,
    label: getAgentSessionLabel(),
    capabilities: getAgentCapabilities(),
    state: getAgentStatusSnapshot(),
  });
  publishAgentState();
  updateAgentUI();
}

function setAgentPaused(paused) {
  state.agentPaused = Boolean(paused);
  if (state.agentPaused && state.agentPendingApproval) {
    settleAgentApproval(false);
  }
  publishAgentState();
  updateAgentUI();
  showToast(t(state.agentPaused ? "agent.paused.on" : "agent.paused.off"), "info");
}

export { closeAgentActivityDialog, closeAgentDeviceProfileDialog, copyMcpConfigToClipboard, deleteAgentDeviceProfileFromDialog, deleteAgentTaskFromUI, downloadJsonFile, getAgentControlWebSocketUrl, openAgentActivityDialog, openAgentDeviceProfileDialog, renameAgentSession, saveAgentDeviceProfileFromDialog, saveAgentTaskFromOperationFromUI, setAgentActivityView, setAgentPaused, showAgentEvidence, textareaLines };
