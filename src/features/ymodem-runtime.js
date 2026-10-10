// Module: YMODEM session lifecycle and the file transfer entry points.
// Owns: session creation, send/receive, cancel, progress, and the file download.
// Depends on: core, the ymodem protocol, serial-runtime, macro, bridge, ymodem UI, toast.
// Called by: the app.js YMODEM workspace and the Agent command adapter.

import { YmodemCancelledError, YmodemSession } from "../ymodem.js";
import { els } from "../core/dom.js";
import { errorMessage } from "../core/errors.js";
import { t } from "../core/i18n.js";
import { state } from "../core/state.js";
import { formatBytes } from "../lib/format.js";
import { stopBridge } from "./bridge.js";
import { stopMacroPlayback, stopMacroRecording } from "./macro.js";
import { sendPayload } from "./serial-runtime.js";
import { showToast } from "./toast.js"
import { appendYmodemLog, resetYmodemProgress, setYmodemBadge, updateYmodemProgress, updateYmodemUI } from "./ymodem.js"

function createYmodemSession() {
  return new YmodemSession({
    write: (bytes) =>
      sendPayload(bytes, {
        fromYmodem: true,
        recordLog: false,
      }),
    onProgress: updateYmodemProgress,
    onLog: (level, message) => appendYmodemLog(message, level),
  });
}

async function runYmodemTransfer(
  direction,
  transfer,
  { signal, throwOnError = false } = {},
) {
  if (!state.connected || !state.writer) {
    showToast(t("serial.openPortFirst"), "error");
    return null;
  }
  if (state.ymodemBusy) {
    showToast(t("ymodem.error.busy"), "info");
    return null;
  }
  if (state.macroRecording) {
    stopMacroRecording({ notify: false });
  }
  if (state.macroPlaybackActive) {
    stopMacroPlayback();
  }
  stopBridge({ silent: true });

  const session = createYmodemSession();
  state.ymodemSession = session;
  state.ymodemBusy = true;
  els.ymodemLog.replaceChildren();
  resetYmodemProgress(
    direction === "send"
      ? t("ymodem.progress.prepareSend")
      : t("ymodem.progress.prepareReceive"),
  );
  setYmodemBadge(t("ymodem.badge.busy"), "busy");
  updateYmodemUI();

  const cancelOnAbort = () => {
    void session.cancel({
      sendCan: true,
      reason: t("agent.cancelled"),
    });
  };
  signal?.addEventListener("abort", cancelOnAbort, { once: true });

  try {
    const result = await transfer(session);
    setYmodemBadge(t("ymodem.badge.done"), "success");
    state.ymodemLastResult = result
      ? {
          direction,
          filename: result.filename,
          size: result.size,
          blocks: result.blocks,
          blockSize: result.blockSize,
          completedAt: Date.now(),
        }
      : null;
    state.ymodemLastError = "";
    return result;
  } catch (error) {
    state.ymodemLastError = errorMessage(error, t("ymodem.error.failed"));
    if (error instanceof YmodemCancelledError) {
      setYmodemBadge(t("ymodem.badge.cancelled"), "idle");
      appendYmodemLog(error.message, "warn");
      showToast(error.message, "info");
    } else {
      setYmodemBadge(t("ymodem.badge.failed"), "error");
      const message = errorMessage(error, t("ymodem.error.failed"));
      appendYmodemLog(message, "error");
      showToast(message, "error");
    }
    if (throwOnError) throw error;
    return null;
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort);
    state.ymodemBusy = false;
    state.ymodemSession = null;
    updateYmodemUI();
  }
}

async function startYmodemSend() {
  if (!state.ymodemFile) {
    showToast(t("ymodem.error.chooseFile"), "info");
    return;
  }

  const file = state.ymodemFile;
  let data;
  try {
    data = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    showToast(errorMessage(error, t("ymodem.error.readFailed")), "error");
    return;
  }

  const result = await runYmodemTransfer("send", (session) =>
    session.send(data, {
      filename: file.name,
      blockSize: state.ymodemBlockSize,
    }),
  );

  if (result) {
    appendYmodemLog(
      t("ymodem.log.sendDone", {
        filename: result.filename,
        size: formatBytes(result.size),
      }),
      "info",
    );
    showToast(t("ymodem.toast.sendDone", { size: formatBytes(result.size) }), "success");
  }
}

async function startYmodemReceive() {
  const result = await runYmodemTransfer("receive", (session) => session.receive());
  if (!result) return;

  appendYmodemLog(
    t("ymodem.log.receiveDone", {
      filename: result.filename,
      size: formatBytes(result.size),
    }),
    "info",
  );
  const blob = new Blob([result.data], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = result.filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  showToast(t("ymodem.toast.receiveDone", { filename: result.filename }), "success");
}

async function cancelYmodemTransfer() {
  if (!state.ymodemSession?.active) return;
  await state.ymodemSession.cancel({
    sendCan: true,
    reason: t("ymodem.cancelledByUser"),
  });
}

export { cancelYmodemTransfer, createYmodemSession, runYmodemTransfer, startYmodemReceive, startYmodemSend };
