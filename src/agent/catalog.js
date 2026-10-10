// Module: AI device profiles, task templates, and evidence.
// Owns: profile/task template normalization, queries, CRUD, and evidence package generation.
// Depends on: core, agent/runtime.js, agent/operations.js, features/payload.js.
// Called by: app.js AI command implementations and settings initialization.

import { MAX_DEVICE_PROFILES, MAX_TASK_TEMPLATES, TEMPLATE_VARIABLE_PATTERN } from "../core/constants.js";
import { formatDateTime, t, tCount } from "../core/i18n.js";
import { persistSettings } from "../core/settings.js";
import { state } from "../core/state.js";
import { getAgentOperationForStatus } from "./operations.js";
import { getActiveDeviceProfile, publishAgentState, renderAgentActivity, serializeAgentOperation, updateAgentUI } from "./runtime.js";

function normalizeDeviceProfiles(value) {
  const profiles = Array.isArray(value) ? value : [];
  return profiles
    .slice(0, MAX_DEVICE_PROFILES)
    .map((profile, index) => {
      const name = String(profile?.name || "").trim().slice(0, 80);
      if (!name) return null;
      const transport = ["any", "serial", "network", "ssh"].includes(profile?.transport)
        ? profile.transport
        : "any";
      const shellType = ["linux", "rtos", "uboot", "raw"].includes(profile?.shellType)
        ? profile.shellType
        : "linux";
      const lineEnding = ["none", "lf", "cr", "crlf"].includes(profile?.lineEnding)
        ? profile.lineEnding
        : "lf";
      const normalizeList = (items, limit) =>
        (Array.isArray(items) ? items : [])
          .map((item) => String(item || "").trim().slice(0, 400))
          .filter(Boolean)
          .slice(0, limit);
      return {
        id: String(
          profile?.id || `device-profile-${index + 1}-${Date.now()}`,
        ).slice(0, 120),
        name,
        board: String(profile?.board || "").trim().slice(0, 120),
        transport,
        shellType,
        lineEnding,
        promptPattern: String(profile?.promptPattern || "").trim().slice(0, 400),
        loginPromptPattern: String(profile?.loginPromptPattern || "").trim().slice(0, 400),
        startupPattern: String(profile?.startupPattern || "").trim().slice(0, 400),
        description: String(profile?.description || "").trim().slice(0, 1000),
        commonCommands: normalizeList(profile?.commonCommands, 50),
        dangerousPatterns: normalizeList(profile?.dangerousPatterns, 50),
        createdAt: Number(profile?.createdAt) || Date.now(),
        updatedAt: Number(profile?.updatedAt) || Date.now(),
      };
    })
    .filter(Boolean);
}

function normalizeAgentStep(step, index = 0) {
  const command = String(step?.command || "").trim();
  if (!command || command === "transaction_execute" || command === "task_run") return null;
  return {
    id: String(step?.id || `step-${index + 1}`).slice(0, 120),
    label: String(step?.label || "").slice(0, 120),
    command,
    params:
      step?.params && typeof step.params === "object"
        ? JSON.parse(JSON.stringify(step.params))
        : {},
    continueOnError: Boolean(step?.continueOnError),
  };
}

function normalizeTaskTemplates(value) {
  const templates = Array.isArray(value) ? value : [];
  return templates
    .slice(0, MAX_TASK_TEMPLATES)
    .map((template, index) => {
      const name = String(template?.name || "").trim().slice(0, 80);
      if (!name) return null;
      const steps = (Array.isArray(template?.steps) ? template.steps : [])
        .map(normalizeAgentStep)
        .filter(Boolean)
        .slice(0, 50);
      if (!steps.length) return null;
      return {
        id: String(
          template?.id || `task-template-${index + 1}-${Date.now()}`,
        ).slice(0, 120),
        name,
        description: String(template?.description || "").trim().slice(0, 1000),
        profileId: String(template?.profileId || "").slice(0, 120),
        transport: ["any", "serial", "network", "ssh"].includes(template?.transport)
          ? template.transport
          : "any",
        steps,
        atomic: template?.atomic !== false,
        allowIrreversible: Boolean(template?.allowIrreversible),
        createdAt: Number(template?.createdAt) || Date.now(),
        updatedAt: Number(template?.updatedAt) || Date.now(),
      };
    })
    .filter(Boolean);
}

function findDeviceProfileForAgent(params = {}) {
  const profileId = String(params.profileId || params.id || "").trim();
  const name = String(params.name || "").trim();
  if (profileId) {
    return state.deviceProfiles.find((profile) => profile.id === profileId) || null;
  }
  if (!name) return null;
  const exact = state.deviceProfiles.find((profile) => profile.name === name);
  if (exact) return exact;
  const expected = name.toLowerCase();
  return (
    state.deviceProfiles.find((profile) => profile.name.toLowerCase() === expected) ||
    null
  );
}

function serializeDeviceProfile(profile) {
  if (!profile) return null;
  return {
    profileId: profile.id,
    name: profile.name,
    board: profile.board,
    transport: profile.transport,
    shellType: profile.shellType,
    lineEnding: profile.lineEnding,
    promptPattern: profile.promptPattern,
    loginPromptPattern: profile.loginPromptPattern,
    startupPattern: profile.startupPattern,
    description: profile.description,
    commonCommands: [...profile.commonCommands],
    dangerousPatterns: [...profile.dangerousPatterns],
    active: profile.id === state.activeDeviceProfileId,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function listDeviceProfilesForAgent() {
  return {
    activeProfileId: state.activeDeviceProfileId,
    profiles: state.deviceProfiles.map(serializeDeviceProfile),
  };
}

function selectDeviceProfileForAgent(params = {}) {
  const requested = String(params.profileId || params.name || "").trim();
  if (!requested) {
    state.activeDeviceProfileId = "";
  } else {
    const profile = findDeviceProfileForAgent(params);
    if (!profile) throw new Error(t("agent.profile.notFound", { name: requested }));
    state.activeDeviceProfileId = profile.id;
  }
  persistSettings();
  publishAgentState();
  updateAgentUI();
  renderAgentActivity();
  return {
    activeProfileId: state.activeDeviceProfileId,
    profile: serializeDeviceProfile(getActiveDeviceProfile()),
  };
}

function upsertDeviceProfileForAgent(params = {}) {
  const input = normalizeDeviceProfiles([
    {
      ...params,
      id: params.profileId || params.id || undefined,
      createdAt: params.createdAt,
      updatedAt: Date.now(),
    },
  ])[0];
  if (!input) throw new Error(t("agent.profile.nameRequired"));
  const existingIndex = state.deviceProfiles.findIndex(
    (profile) =>
      profile.id === input.id ||
      (!input.id && profile.name.toLowerCase() === input.name.toLowerCase()),
  );
  if (existingIndex >= 0) {
    const existing = state.deviceProfiles[existingIndex];
    input.id = existing.id;
    input.createdAt = existing.createdAt;
    state.deviceProfiles.splice(existingIndex, 1, input);
  } else {
    if (state.deviceProfiles.length >= MAX_DEVICE_PROFILES) {
      throw new Error(t("agent.profile.limit", { count: MAX_DEVICE_PROFILES }));
    }
    input.id =
      input.id ||
      crypto.randomUUID?.() ||
      `device-profile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    state.deviceProfiles.push(input);
  }
  persistSettings();
  publishAgentState();
  updateAgentUI();
  return {
    profile: serializeDeviceProfile(input),
    activeProfileId: state.activeDeviceProfileId,
  };
}

function deleteDeviceProfileForAgent(params = {}) {
  const profile = findDeviceProfileForAgent(params);
  if (!profile) throw new Error(t("agent.profile.deleteNotFound"));
  state.deviceProfiles = state.deviceProfiles.filter((item) => item.id !== profile.id);
  state.taskTemplates = state.taskTemplates.map((template) =>
    template.profileId === profile.id ? { ...template, profileId: "" } : template,
  );
  if (state.activeDeviceProfileId === profile.id) state.activeDeviceProfileId = "";
  persistSettings();
  publishAgentState();
  updateAgentUI();
  return { deletedProfileId: profile.id, activeProfileId: state.activeDeviceProfileId };
}

function findTaskTemplateForAgent(params = {}) {
  const taskId = String(params.taskId || params.id || "").trim();
  const name = String(params.name || "").trim();
  if (taskId) return state.taskTemplates.find((template) => template.id === taskId) || null;
  if (!name) return null;
  const exact = state.taskTemplates.find((template) => template.name === name);
  if (exact) return exact;
  const expected = name.toLowerCase();
  return (
    state.taskTemplates.find((template) => template.name.toLowerCase() === expected) ||
    null
  );
}

function serializeTaskTemplate(template) {
  if (!template) return null;
  return {
    taskId: template.id,
    name: template.name,
    description: template.description,
    profileId: template.profileId,
    transport: template.transport,
    steps: template.steps.map((step) => ({
      id: step.id,
      label: step.label,
      command: step.command,
      params: JSON.parse(JSON.stringify(step.params)),
      continueOnError: step.continueOnError,
    })),
    atomic: template.atomic,
    allowIrreversible: template.allowIrreversible,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

function listTaskTemplatesForAgent() {
  return {
    templates: state.taskTemplates.map(serializeTaskTemplate),
  };
}

function createTaskTemplateForAgent(params = {}) {
  const input = normalizeTaskTemplates([
    {
      ...params,
      id: params.taskId || params.id || undefined,
      createdAt: params.createdAt,
      updatedAt: Date.now(),
    },
  ])[0];
  if (!input) throw new Error(t("agent.tasks.nameStepsRequired"));
  const existingIndex = state.taskTemplates.findIndex(
    (template) =>
      template.id === input.id ||
      (!input.id && template.name.toLowerCase() === input.name.toLowerCase()),
  );
  if (existingIndex >= 0) {
    const existing = state.taskTemplates[existingIndex];
    input.id = existing.id;
    input.createdAt = existing.createdAt;
    state.taskTemplates.splice(existingIndex, 1, input);
  } else {
    if (state.taskTemplates.length >= MAX_TASK_TEMPLATES) {
      throw new Error(t("agent.tasks.limit", { count: MAX_TASK_TEMPLATES }));
    }
    input.id =
      input.id ||
      crypto.randomUUID?.() ||
      `task-template-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    state.taskTemplates.push(input);
  }
  persistSettings();
  publishAgentState();
  updateAgentUI();
  return { template: serializeTaskTemplate(input) };
}

function deleteTaskTemplateForAgent(params = {}) {
  const template = findTaskTemplateForAgent(params);
  if (!template) throw new Error(t("agent.tasks.deleteNotFound"));
  state.taskTemplates = state.taskTemplates.filter((item) => item.id !== template.id);
  persistSettings();
  publishAgentState();
  updateAgentUI();
  return { deletedTaskId: template.id };
}

function createTaskFromAgentOperation(params = {}) {
  const operation = getAgentOperationForStatus(params.operationId);
  if (!operation) throw new Error(t("agent.tasks.operationNotFound"));
  const steps =
    operation.command === "transaction_execute" && Array.isArray(operation.params?.steps)
      ? operation.params.steps
      : [
          {
            label: operation.label,
            command: operation.command,
            params: operation.params || {},
          },
        ];
  const name = String(
    params.name ||
      `${operation.label} ${formatDateTime(new Date(), { hour12: false })}`,
  )
    .trim()
    .slice(0, 80);
  return createTaskTemplateForAgent({
    name,
    description:
      String(params.description || "").trim() ||
      t("agent.tasks.fromOperation", { id: operation.id }),
    profileId: operation.evidence?.before?.deviceProfile?.profileId || state.activeDeviceProfileId,
    transport: operation.evidence?.request?.transport || "any",
    steps,
    atomic: operation.command === "transaction_execute" ? operation.params?.atomic !== false : false,
    allowIrreversible:
      operation.command === "transaction_execute"
        ? Boolean(operation.params?.allowIrreversible)
        : true,
  });
}

function replaceTaskVariables(value, variables = {}) {
  if (typeof value === "string") {
    return value.replace(TEMPLATE_VARIABLE_PATTERN, (match, name) =>
      Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : match,
    );
  }
  if (Array.isArray(value)) return value.map((item) => replaceTaskVariables(item, variables));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceTaskVariables(item, variables)]),
    );
  }
  return value;
}

function redactAgentEvidence(value, key = "") {
  if (/password|passphrase|privateKey/i.test(key)) return t("agent.param.redacted");
  if (typeof value === "string") {
    if (/base64$/i.test(key) && value.length > 200) {
      return tCount("agent.param.chars", value.length);
    }
    return value.length > 20000 ? `${value.slice(0, 20000)}...` : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactAgentEvidence(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactAgentEvidence(childValue, childKey),
      ]),
    );
  }
  return value;
}

function getAgentEvidenceForOperation(operationId = "") {
  const operation = getAgentOperationForStatus(operationId);
  if (!operation) throw new Error(t("agent.evidence.operationNotFound"));
  const taskTemplate =
    operation.command === "task_run" ? findTaskTemplateForAgent(operation.params || {}) : null;
  const replayTemplate =
    taskTemplate
      ? {
          name: taskTemplate.name,
          transport: taskTemplate.transport,
          profileId: taskTemplate.profileId,
          steps: redactAgentEvidence(serializeTaskTemplate(taskTemplate).steps),
          atomic: taskTemplate.atomic,
          allowIrreversible: taskTemplate.allowIrreversible,
        }
      : operation.command === "transaction_execute" && Array.isArray(operation.params?.steps)
      ? {
          name: operation.params.name || operation.label,
          transport: operation.evidence?.request?.transport || "any",
          profileId: operation.evidence?.before?.deviceProfile?.profileId || "",
          steps: redactAgentEvidence(operation.params.steps),
          atomic: operation.params.atomic !== false,
          allowIrreversible: Boolean(operation.params.allowIrreversible),
        }
      : {
          name: operation.label,
          transport: operation.evidence?.request?.transport || "any",
          profileId: operation.evidence?.before?.deviceProfile?.profileId || "",
          steps: [
            {
              label: operation.label,
              command: operation.command,
              params: redactAgentEvidence(operation.params || {}),
            },
          ],
          atomic: false,
          allowIrreversible: true,
        };
  return {
    evidenceVersion: 1,
    generatedAt: new Date().toISOString(),
    operation: serializeAgentOperation(operation, { includeResult: true }),
    request: redactAgentEvidence(operation.evidence?.request || {
      command: operation.command,
      params: operation.params,
    }),
    before: operation.evidence?.before || null,
    after: operation.evidence?.after || null,
    result: redactAgentEvidence(operation.result),
    error: operation.error || "",
    replayTemplate,
  };
}

export { createTaskFromAgentOperation, createTaskTemplateForAgent, deleteDeviceProfileForAgent, deleteTaskTemplateForAgent, findDeviceProfileForAgent, findTaskTemplateForAgent, getAgentEvidenceForOperation, listDeviceProfilesForAgent, listTaskTemplatesForAgent, normalizeAgentStep, normalizeDeviceProfiles, normalizeTaskTemplates, redactAgentEvidence, replaceTaskVariables, selectDeviceProfileForAgent, serializeDeviceProfile, serializeTaskTemplate, upsertDeviceProfileForAgent };
