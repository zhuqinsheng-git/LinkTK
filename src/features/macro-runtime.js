// Module: Macro playback, step delays, and agent playback.
// Owns: command/character delays, serial and terminal sends, playback cancel, and result stats.
// Depends on: core, macro, payload, toast, terminal; send callbacks are injected by app.js.
// Called by: app.js macro UI and the Agent command adapter.

import { state } from "../core/state.js";
import { errorMessage } from "../core/errors.js";
import { t } from "../core/i18n.js";
import { getMacroForAgent, normalizeMacroNumber, serializeMacro, stopMacroPlayback, updateMacroUI } from "./macro.js";
import { buildPayloadFromValue, parseHexInput } from "./payload.js";
import { sendPayload } from "./serial-runtime.js";
import { sendTerminalInput } from "./terminal.js";
import { showToast } from "./toast.js";

function waitMacroDelay(delay, token, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    if (delay <= 0) {
      resolve(token === state.macroPlaybackToken && state.macroPlaybackActive);
      return;
    }
    const timer = window.setTimeout(() => {
      resolve(token === state.macroPlaybackToken && state.macroPlaybackActive);
    }, delay);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        resolve(false);
      },
      { once: true },
    );
  });
}

async function sendMacroStep(step, token, characterDelay, signal) {
  const cancelled = () =>
    signal?.aborted ||
    token !== state.macroPlaybackToken ||
    !state.macroPlaybackActive;
  if (cancelled()) return false;

  if (step.type === "hex") {
    let bytes;
    try {
      bytes = parseHexInput(step.data);
    } catch (error) {
      showToast(errorMessage(error, t("macro.error.hexInvalid")), "error");
      return false;
    }

    if (characterDelay <= 0) return sendPayload(bytes);

    for (let index = 0; index < bytes.length; index += 1) {
      if (cancelled()) return false;
      const sent = await sendPayload(new Uint8Array([bytes[index]]), {
        separateLog: false,
      });
      if (!sent) return false;
      if (
        index < bytes.length - 1 &&
        (await waitMacroDelay(characterDelay, token, signal)) === false
      ) {
        return false;
      }
    }
    return true;
  }

  const characters = characterDelay > 0 ? Array.from(step.data) : [step.data];
  for (let index = 0; index < characters.length; index += 1) {
    if (cancelled()) return false;
    const sent = await sendTerminalInput(characters[index]);
    if (!sent) return false;
    if (
      index < characters.length - 1 &&
      (await waitMacroDelay(characterDelay, token, signal)) === false
    ) {
      return false;
    }
  }
  return true;
}

function macroStepUsesCommandDelay(step) {
  if (step.type === "hex") return true;
  return Array.from(step.data).some((character) => {
    const code = character.charCodeAt(0);
    return character === "\r" || character === "\n" || (code < 0x20 && character !== "\t");
  });
}

async function playMacro(id) {
  const macro = state.macros.find((item) => item.id === id);
  if (!macro) return;
  if (!state.connected || !state.writer) {
    showToast(t("serial.openPortFirst"), "error");
    return;
  }
  if (state.macroRecording || state.macroPlaybackActive) return;
  if (state.ymodemBusy) {
    showToast(t("macro.ymodemPlayback"), "info");
    return;
  }

  const token = state.macroPlaybackToken + 1;
  state.macroPlaybackToken = token;
  state.macroPlaybackActive = true;
  updateMacroUI();
  showToast(t("macro.playbackStarted", { name: macro.name }), "info");

  let completed = true;
  for (let index = 0; index < macro.steps.length; index += 1) {
    const step = macro.steps[index];
    const sent = await sendMacroStep(step, token, macro.characterDelay);
    if (!sent) {
      completed = false;
      break;
    }
    if (index < macro.steps.length - 1) {
      const delay = macroStepUsesCommandDelay(step)
        ? macro.commandDelay
        : macro.characterDelay;
      const continued = await waitMacroDelay(delay, token);
      if (!continued) {
        completed = false;
        break;
      }
    }
  }

  if (token === state.macroPlaybackToken) {
    state.macroPlaybackActive = false;
    updateMacroUI();
    if (completed) showToast(t("macro.playbackDone", { name: macro.name }), "success");
  }
}

async function runMacroForAgent(params = {}, context = {}) {
  const macro = getMacroForAgent(params);
  if (!macro) throw new Error(t("macro.error.notFound"));
  if (!state.connected || !state.writer) throw new Error(t("serial.openPortFirst"));
  if (state.macroRecording) throw new Error(t("macro.error.recording"));
  if (state.macroPlaybackActive) throw new Error(t("macro.error.playing"));
  if (state.ymodemBusy) throw new Error(t("macro.ymodemPlayback"));

  const commandDelay = normalizeMacroNumber(
    params.commandDelay,
    macro.commandDelay,
    60000,
  );
  const characterDelay = normalizeMacroNumber(
    params.characterDelay,
    macro.characterDelay,
    5000,
  );
  const token = state.macroPlaybackToken + 1;
  state.macroPlaybackToken = token;
  state.macroPlaybackActive = true;
  updateMacroUI();
  showToast(t("macro.agentPlaying", { name: macro.name }), "info");

  let completed = true;
  let stepsSent = 0;
  try {
    for (let index = 0; index < macro.steps.length; index += 1) {
      const step = macro.steps[index];
      if (context.signal?.aborted) {
        completed = false;
        break;
      }
      const sent = await sendMacroStep(step, token, characterDelay, context.signal);
      if (!sent) {
        completed = false;
        break;
      }
      stepsSent += 1;
      if (index < macro.steps.length - 1) {
        const delay = macroStepUsesCommandDelay(step) ? commandDelay : characterDelay;
        const continued = await waitMacroDelay(delay, token, context.signal);
        if (!continued) {
          completed = false;
          break;
        }
      }
    }
  } finally {
    if (token === state.macroPlaybackToken) {
      state.macroPlaybackActive = false;
      updateMacroUI();
    }
  }

  if (!completed) {
    if (context.signal?.aborted) {
      throw new DOMException(t("agent.cancelled"), "AbortError");
    }
    throw new Error(t("macro.error.interrupted"));
  }

  showToast(t("macro.playbackDone", { name: macro.name }), "success");
  return {
    macro: serializeMacro(macro),
    completed: true,
    stepsSent,
  };
}

export { macroStepUsesCommandDelay, playMacro, runMacroForAgent, sendMacroStep, waitMacroDelay };
