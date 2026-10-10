// Module: Macro list, editing, and agent CRUD.
// Owns: macro normalization, recorded-step editing, list rendering, and the list/create/delete ForAgent paths.
// Depends on: lucide, lib/format.js, core/dom.js, core/i18n.js, core/settings.js, core/state.js, toast.js.
// Called by: app.js; the playback send path is still wired up by app.js pending the serial-send module extraction.

import { Pencil, Play, Trash2, createIcons } from "lucide";
import { MAX_MACROS, MAX_MACRO_STEPS } from "../core/constants.js";
import { $, $$, createLucideIcon, els } from "../core/dom.js";
import { t, tCount } from "../core/i18n.js";
import { persistSettings } from "../core/settings.js";
import { state } from "../core/state.js";
import { bytesToHex } from "../lib/format.js";
import { showToast } from "./toast.js";

function normalizeMacroNumber(value, fallback, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(max, Math.round(numeric)));
}

function normalizeMacroSteps(value) {
  const steps = Array.isArray(value) ? value : [];
  return steps
    .slice(0, MAX_MACRO_STEPS)
    .map((step) => {
      const type = step?.type === "hex" ? "hex" : "text";
      const data = String(step?.data ?? "");
      return data ? { type, data } : null;
    })
    .filter(Boolean);
}

function normalizeMacros(value) {
  const macros = Array.isArray(value) ? value : [];
  return macros
    .slice(0, MAX_MACROS)
    .map((macro, index) => {
      const steps = normalizeMacroSteps(macro?.steps);
      if (!steps.length) return null;
      return {
        id: String(macro?.id || `macro-${index + 1}-${Date.now()}`),
        name: String(macro?.name || `Macro ${index + 1}`).slice(0, 60),
        commandDelay: normalizeMacroNumber(macro?.commandDelay, 500, 60000),
        characterDelay: normalizeMacroNumber(macro?.characterDelay, 0, 5000),
        steps,
      };
    })
    .filter(Boolean);
}

function setMacroCollapsed(collapsed, { persist = true } = {}) {
  state.macroCollapsed = Boolean(collapsed);
  els.macroSection.classList.toggle("is-collapsed", state.macroCollapsed);
  els.macroToggleButton.setAttribute("aria-expanded", String(!state.macroCollapsed));
  if (persist) persistSettings();
}

function formatMacroStepPreview(step) {
  if (step.type === "hex") return step.data;
  return step.data
    .replace(/\r\n/g, "RETURN+LF")
    .replace(/\r/g, "RETURN")
    .replace(/\n/g, "LF")
    .replace(/\t/g, "TAB")
    .replace(/[\u0000-\u001f\u007f]/g, (character) => {
      const code = character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
      return `\\x${code}`;
    });
}

function renderMacroList() {
  els.macroList.replaceChildren();

  if (!state.macros.length) {
    const empty = document.createElement("p");
    empty.className = "macro-empty";
    empty.textContent = t("macro.emptyList");
    els.macroList.append(empty);
    updateMacroUI();
    return;
  }

  const fragment = document.createDocumentFragment();
  state.macros.forEach((macro) => {
    const row = document.createElement("div");
    row.className = "macro-item";
    row.dataset.macroId = macro.id;

    const playButton = document.createElement("button");
    playButton.className = "macro-item__play";
    playButton.type = "button";
    playButton.dataset.macroAction = "play";
    playButton.title = t("macro.playTitle", { name: macro.name });
    playButton.setAttribute("aria-label", t("macro.playTitle", { name: macro.name }));

    const playIcon = createLucideIcon("play");
    const text = document.createElement("span");
    text.className = "macro-item__text";

    const name = document.createElement("strong");
    name.textContent = macro.name;
    const meta = document.createElement("span");
    meta.textContent = tCount("macro.meta", macro.steps.length, {
      commandDelay: macro.commandDelay,
      characterDelay: macro.characterDelay,
    });
    text.append(name, meta);
    playButton.append(playIcon, text);

    const editButton = document.createElement("button");
    editButton.className = "quick-command-action";
    editButton.type = "button";
    editButton.dataset.macroAction = "edit";
    editButton.title = t("macro.editTitle");
    editButton.setAttribute("aria-label", t("macro.editAria", { name: macro.name }));
    editButton.append(createLucideIcon("pencil"));

    const deleteButton = document.createElement("button");
    deleteButton.className = "quick-command-action quick-command-action--delete";
    deleteButton.type = "button";
    deleteButton.dataset.macroAction = "delete";
    deleteButton.title = t("macro.deleteTitle");
    deleteButton.setAttribute("aria-label", t("macro.deleteAria", { name: macro.name }));
    deleteButton.append(createLucideIcon("trash-2"));

    row.append(playButton, editButton, deleteButton);
    fragment.append(row);
  });

  els.macroList.append(fragment);
  createIcons({ icons: { Pencil, Play, Trash2 } });
  updateMacroUI();
}

function updateMacroUI() {
  const recording = state.macroRecording;
  const playback = state.macroPlaybackActive;
  const connected = state.connected;
  const startIcon = $(".macro-record-icon-start", els.macroRecordButton);
  const stopIcon = $(".macro-record-icon-stop", els.macroRecordButton);

  els.macroRecordButton.disabled = playback || (!recording && (!connected || state.ymodemBusy));
  els.macroRecordButton.classList.toggle("is-recording", recording);
  $("span", els.macroRecordButton).textContent = recording
    ? t("macro.stopRecording")
    : t("macro.record.start");
  if (startIcon) startIcon.hidden = recording;
  if (stopIcon) stopIcon.hidden = !recording;

  els.macroStopButton.hidden = !playback;
  els.macroRecordState.dataset.state = recording
    ? "recording"
    : playback
      ? "playing"
      : "idle";
  els.macroRecordState.textContent = recording
    ? state.macroRecordingMode === "terminal"
      ? t("macro.state.terminalRecording")
      : t("macro.state.recordingLog")
    : playback
      ? t("macro.state.playing")
      : t("macro.state.idle");
  els.macroRecordState.classList.toggle("mini-badge--idle", !recording && !playback);

  $$(".macro-item button", els.macroList).forEach((button) => {
    button.disabled = recording || playback;
  });
}

function appendMacroRecordedStep(step) {
  if (!state.macroRecording || !step?.data) return;
  if (state.macroRecordedSteps.length >= MAX_MACRO_STEPS) {
    showToast(t("macro.limitSteps", { count: MAX_MACRO_STEPS }), "info");
    return;
  }
  state.macroRecordedSteps.push(step);
  updateMacroUI();
}

function recordTerminalMacroInput(data) {
  if (
    !state.macroRecording ||
    state.macroRecordingMode !== "terminal" ||
    state.macroPlaybackActive ||
    !data
  ) {
    return;
  }

  appendMacroRecordedStep({ type: "text", data });
}

function recordTerminalMacroPayload(payload) {
  if (
    !state.macroRecording ||
    state.macroRecordingMode !== "terminal" ||
    state.macroPlaybackActive ||
    !payload?.byteLength
  ) {
    return;
  }
  appendMacroRecordedStep({ type: "hex", data: bytesToHex(payload) });
}

function recordLogMacroCommand(payload) {
  if (
    !state.macroRecording ||
    state.macroRecordingMode !== "log" ||
    state.macroPlaybackActive ||
    !payload?.byteLength
  ) {
    return;
  }
  appendMacroRecordedStep({ type: "hex", data: bytesToHex(payload) });
}

function startMacroRecording() {
  if (!state.connected || !state.writer) {
    showToast(t("serial.openPortFirst"), "error");
    return;
  }
  if (state.ymodemBusy) {
    showToast(t("macro.ymodemBusy"), "info");
    return;
  }
  if (state.macroPlaybackActive) {
    showToast(t("macro.stopPlaybackFirst"), "info");
    return;
  }

  state.macroRecording = true;
  state.macroRecordingMode = state.consoleView;
  state.macroRecordedSteps = [];
  updateMacroUI();
  showToast(
    state.macroRecordingMode === "terminal"
      ? t("macro.recordingTerminal")
      : t("macro.recordingLog"),
    "info",
  );
}

function stopMacroRecording({ notify = true } = {}) {
  if (!state.macroRecording) return;

  const steps = state.macroRecordedSteps.map((step) => ({ ...step }));
  state.macroRecording = false;
  state.macroRecordingMode = null;
  state.macroRecordedSteps = [];

  if (!steps.length) {
    updateMacroUI();
    if (notify) showToast(t("macro.nothingRecorded"), "info");
    return;
  }

  if (state.macros.length >= MAX_MACROS) {
    updateMacroUI();
    if (notify) showToast(t("macro.limitTotal", { count: MAX_MACROS }), "info");
    return;
  }

  let number = 1;
  const names = new Set(state.macros.map((macro) => macro.name));
  while (names.has(`Macro ${number}`)) number += 1;

  state.macros.unshift({
    id: crypto.randomUUID?.() || `macro-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: `Macro ${number}`,
    commandDelay: 500,
    characterDelay: 0,
    steps,
  });
  persistSettings();
  renderMacroList();
  updateMacroUI();

  if (notify) {
    showToast(tCount("macro.savedWithSteps", steps.length), "success");
  }
}

function openMacroEditor(id) {
  const macro = state.macros.find((item) => item.id === id);
  if (!macro || state.macroRecording || state.macroPlaybackActive) return;

  state.macroEditingId = id;
  els.macroNameInput.value = macro.name;
  els.macroCommandDelayInput.value = String(macro.commandDelay);
  els.macroCharacterDelayInput.value = String(macro.characterDelay);
  renderMacroEditorSteps(macro.steps);
  els.macroEditorDialog.showModal();
}

function renderMacroEditorSteps(steps) {
  els.macroStepCount.textContent = tCount("macro.stepCount", steps.length);
  els.macroStepList.replaceChildren();

  steps.forEach((step, index) => {
    const row = document.createElement("div");
    row.className = "macro-step";

    const label = document.createElement("span");
    label.className = "macro-step__index";
    label.textContent = String(index + 1).padStart(2, "0");

    const type = document.createElement("span");
    type.className = "macro-step__type";
    type.textContent = step.type === "hex" ? "HEX" : "TEXT";

    const preview = document.createElement("code");
    preview.className = "macro-step__preview";
    preview.textContent = formatMacroStepPreview(step);

    row.append(label, type, preview);
    els.macroStepList.append(row);
  });
}

function closeMacroEditor() {
  state.macroEditingId = null;
  if (els.macroEditorDialog.open) {
    els.macroEditorDialog.close();
  }
}

function saveMacroEditor() {
  const macro = state.macros.find((item) => item.id === state.macroEditingId);
  if (!macro) {
    closeMacroEditor();
    return;
  }

  macro.name = els.macroNameInput.value.trim().slice(0, 60) || macro.name;
  macro.commandDelay = normalizeMacroNumber(
    els.macroCommandDelayInput.value,
    macro.commandDelay,
    60000,
  );
  macro.characterDelay = normalizeMacroNumber(
    els.macroCharacterDelayInput.value,
    macro.characterDelay,
    5000,
  );
  persistSettings();
  renderMacroList();
  closeMacroEditor();
  showToast(t("macro.settingsSaved"), "success");
}

function deleteMacro(id) {
  if (state.macroRecording || state.macroPlaybackActive) return;
  const index = state.macros.findIndex((macro) => macro.id === id);
  if (index < 0) return;
  const [macro] = state.macros.splice(index, 1);
  persistSettings();
  renderMacroList();
  showToast(t("macro.deleted", { name: macro.name }), "info");
}

function stopMacroPlayback() {
  if (!state.macroPlaybackActive) return;
  state.macroPlaybackActive = false;
  state.macroPlaybackToken += 1;
  updateMacroUI();
  showToast(t("macro.playbackStopped"), "info");
}

function serializeMacro(macro) {
  return {
    id: macro.id,
    name: macro.name,
    commandDelay: macro.commandDelay,
    characterDelay: macro.characterDelay,
    steps: macro.steps.map((step) => ({ ...step })),
  };
}

function getMacroForAgent(params = {}) {
  const id = String(params.macroId || params.id || "").trim();
  const name = String(params.name || "").trim();
  if (id) return state.macros.find((macro) => macro.id === id) || null;
  if (!name) return null;
  const exact = state.macros.find((macro) => macro.name === name);
  if (exact) return exact;
  const expected = name.toLowerCase();
  return state.macros.find((macro) => macro.name.toLowerCase() === expected) || null;
}

function listMacrosForAgent() {
  return {
    maxMacros: MAX_MACROS,
    maxSteps: MAX_MACRO_STEPS,
    recording: state.macroRecording,
    playbackActive: state.macroPlaybackActive,
    macros: state.macros.map(serializeMacro),
  };
}

function createMacroForAgent(params = {}) {
  const steps = normalizeMacroSteps(params.steps);
  if (!steps.length) throw new Error(t("macro.error.noSteps"));
  if (state.macros.length >= MAX_MACROS) {
    throw new Error(t("macro.limitTotal", { count: MAX_MACROS }));
  }
  const name = String(params.name || "").trim().slice(0, 60);
  if (!name) throw new Error(t("macro.error.nameRequired"));
  if (state.macros.some((macro) => macro.name === name)) {
    throw new Error(t("macro.error.nameTaken", { name }));
  }
  const macro = {
    id: crypto.randomUUID?.() || `macro-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    commandDelay: normalizeMacroNumber(params.commandDelay, 500, 60000),
    characterDelay: normalizeMacroNumber(params.characterDelay, 0, 5000),
    steps,
  };
  state.macros.unshift(macro);
  persistSettings();
  renderMacroList();
  updateMacroUI();
  showToast(t("macro.agentCreated", { name }), "success");
  return serializeMacro(macro);
}

function deleteMacroForAgent(params = {}) {
  const macro = getMacroForAgent(params);
  if (!macro) throw new Error(t("macro.error.notFound"));
  if (state.macroRecording || state.macroPlaybackActive) {
    throw new Error(t("macro.error.deleteBusy"));
  }
  const index = state.macros.findIndex((item) => item.id === macro.id);
  state.macros.splice(index, 1);
  persistSettings();
  renderMacroList();
  updateMacroUI();
  showToast(t("macro.agentDeleted", { name: macro.name }), "info");
  return { deleted: serializeMacro(macro) };
}

export { appendMacroRecordedStep, closeMacroEditor, createMacroForAgent, deleteMacro, deleteMacroForAgent, formatMacroStepPreview, getMacroForAgent, listMacrosForAgent, normalizeMacroNumber, normalizeMacroSteps, normalizeMacros, openMacroEditor, recordLogMacroCommand, recordTerminalMacroInput, recordTerminalMacroPayload, renderMacroEditorSteps, renderMacroList, saveMacroEditor, serializeMacro, setMacroCollapsed, startMacroRecording, stopMacroPlayback, stopMacroRecording, updateMacroUI };
