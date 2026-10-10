// Module: Serial/network expected-response and latency testing.
// Owns: test configuration, dialog state, wait-for-match, timeout, and result display.
// Depends on: core, payload, network, toast; the serial send is injected by app.js.
// Called by: the app.js response test UI and the serial receive loop.

import { els } from "../core/dom.js";
import { errorMessage } from "../core/errors.js";
import { t } from "../core/i18n.js";
import { persistSettings } from "../core/settings.js";
import { state } from "../core/state.js";
import { sendNetworkData } from "./network.js";
import { buildNetworkPayload, buildPayload } from "./payload.js";
import { showToast } from "./toast.js";

let serialPayloadSender = null;

function initializeResponseTest({ sendSerialPayload } = {}) {
  if (typeof sendSerialPayload !== "function") {
    throw new TypeError("initializeResponseTest requires sendSerialPayload.");
  }
  serialPayloadSender = sendSerialPayload;
}

function responseTestConnected(kind) {
  return kind === "network"
    ? state.networkConnected && Boolean(state.networkBridge)
    : state.connected && Boolean(state.writer);
}

function formatResponseLatency(milliseconds) {
  if (!Number.isFinite(milliseconds)) return "--";
  if (milliseconds < 1000) {
    return `${milliseconds < 100 ? milliseconds.toFixed(1) : Math.round(milliseconds)} ms`;
  }
  return `${(milliseconds / 1000).toFixed(2)} s`;
}

function updateResponseTestUI() {
  const test = state.responseTest;
  const connected = responseTestConnected(state.responseTestTarget);
  const labels = {
    idle: t("response.badge.idle"),
    waiting: t("response.status.waiting"),
    success: t("response.status.success"),
    timeout: t("response.status.timeout"),
    cancelled: t("response.status.cancelled"),
    error: t("response.status.error"),
  };

  els.responseTestTargetLabel.textContent =
    state.responseTestTarget === "network"
      ? t("response.target.network")
      : t("response.target.serial");
  els.responseTestBadge.dataset.state = test.status;
  els.responseTestBadge.textContent = labels[test.status] || labels.idle;
  els.responseTestBadge.classList.toggle(
    "mini-badge--idle",
    !["success", "waiting"].includes(test.status),
  );
  els.responseLatency.textContent = formatResponseLatency(test.latency);
  els.responsePreview.textContent = test.preview || t("response.preview");
  els.startResponseTestButton.textContent = test.active
    ? t("response.stop")
    : t("response.sendAndWait");
  els.startResponseTestButton.disabled = !test.active && !connected;

  [els.responseExpectedInput, els.responseTimeoutInput, els.responseCaseSensitiveToggle].forEach(
    (element) => {
      element.disabled = test.active;
    },
  );

  [
    [els.serialResponseTestButton, "serial"],
    [els.networkResponseTestButton, "network"],
  ].forEach(([button, kind]) => {
    const active = test.active && test.kind === kind;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function setResponseTestStatus(status, { latency = null, preview = "" } = {}) {
  state.responseTest.status = status;
  state.responseTest.latency = latency;
  state.responseTest.preview = preview;
  updateResponseTestUI();
}

function openResponseTestDialog(kind) {
  if (state.responseTest.active && state.responseTest.kind !== kind) {
    showToast(t("response.error.stopFirst"), "info");
    return;
  }

  const changedTarget = state.responseTestTarget !== kind;
  state.responseTestTarget = kind;
  if (state.responseTest.active) {
    els.responseExpectedInput.value = state.responseTest.expected;
    els.responseTimeoutInput.value = String(
      Math.round(state.responseTest.timeout || state.responseTimeout),
    );
    els.responseCaseSensitiveToggle.checked = state.responseTest.caseSensitive;
  } else {
    els.responseExpectedInput.value = state.responseExpected;
    els.responseTimeoutInput.value = String(state.responseTimeout);
    els.responseCaseSensitiveToggle.checked = state.responseCaseSensitive;
    if (changedTarget) {
      setResponseTestStatus("idle", { preview: t("response.preview") });
    }
  }

  updateResponseTestUI();
  if (!els.responseTestDialog.open) els.responseTestDialog.showModal();
}

function closeResponseTestDialog() {
  if (els.responseTestDialog.open) els.responseTestDialog.close();
}

function cancelResponseTest({ reason = t("response.result.cancelled"), notify = false } = {}) {
  const test = state.responseTest;
  if (!test.active) return;
  if (test.timer) window.clearTimeout(test.timer);
  test.timer = null;
  test.active = false;
  test.token += 1;
  test.decoder = null;
  setResponseTestStatus("cancelled", { preview: reason });
  if (notify) showToast(reason, "info");
}

function finishResponseTest(token, status, { latency = null, preview = "" } = {}) {
  const test = state.responseTest;
  if (!test.active || token !== test.token) return;
  if (test.timer) window.clearTimeout(test.timer);
  test.timer = null;
  test.active = false;
  test.decoder = null;
  setResponseTestStatus(status, { latency, preview });

  if (status === "success") {
    showToast(
      t("response.result.success", { latency: formatResponseLatency(latency) }),
      "success",
    );
  } else if (status === "timeout") {
    showToast(t("response.result.timeout"), "error");
  }
}

async function startResponseTest() {
  if (state.responseTest.active) {
    cancelResponseTest({ reason: t("response.result.stoppedManually"), notify: true });
    return;
  }

  const kind = state.responseTestTarget;
  if (!responseTestConnected(kind)) {
    showToast(
      kind === "network" ? t("net.error.notConnected") : t("serial.openPortFirst"),
      "error",
    );
    return;
  }

  const expected = els.responseExpectedInput.value.trim();
  if (!expected) {
    showToast(t("response.error.expectedRequired"), "error");
    return;
  }
  const timeout = Math.max(
    10,
    Math.min(120000, Number.parseInt(els.responseTimeoutInput.value, 10) || 1000),
  );
  state.responseExpected = expected.slice(0, 200);
  state.responseTimeout = timeout;
  state.responseCaseSensitive = els.responseCaseSensitiveToggle.checked;
  els.responseExpectedInput.value = state.responseExpected;
  els.responseTimeoutInput.value = String(timeout);
  persistSettings();

  let payload;
  try {
    payload = kind === "network" ? buildNetworkPayload() : buildPayload();
  } catch (error) {
    showToast(errorMessage(error), "error");
    return;
  }
  if (!payload.byteLength) {
    showToast(t("common.emptyPayload"), "info");
    return;
  }

  const test = state.responseTest;
  if (test.timer) window.clearTimeout(test.timer);
  test.token += 1;
  const token = test.token;
  test.active = true;
  test.kind = kind;
  test.expected = state.responseExpected;
  test.timeout = timeout;
  test.caseSensitive = state.responseCaseSensitive;
  test.startedAt = performance.now();
  test.decoder = new TextDecoder("utf-8", { fatal: false });
  test.buffer = "";
  test.timer = window.setTimeout(() => {
    finishResponseTest(token, "timeout", {
      preview: t("response.result.timeoutPreview", {
        timeout,
        expected: state.responseExpected,
      }),
    });
  }, timeout);
  setResponseTestStatus("waiting", {
    preview: t("response.result.waitingPreview", {
      expected: state.responseExpected,
    }),
  });

  const sent =
    kind === "network"
      ? await sendNetworkData(payload)
      : await serialPayloadSender(payload);
  if (!sent && test.active && token === test.token) {
    cancelResponseTest({ reason: t("response.result.sendFailed") });
  }
}

function observeResponseTest(kind, bytes) {
  const test = state.responseTest;
  if (!test.active || test.kind !== kind || !test.decoder || !bytes?.byteLength) return;

  const chunk = test.decoder.decode(bytes, { stream: true });
  if (!chunk) return;
  test.buffer += chunk;
  if (test.buffer.length > 65536) {
    test.buffer = test.buffer.slice(-32768);
  }

  const expected = test.caseSensitive ? test.expected : test.expected.toLowerCase();
  const haystack = test.caseSensitive ? test.buffer : test.buffer.toLowerCase();
  const matchIndex = haystack.indexOf(expected);
  if (matchIndex < 0) return;

  const latency = performance.now() - test.startedAt;
  const start = Math.max(0, matchIndex - 24);
  const end = Math.min(test.buffer.length, matchIndex + test.expected.length + 80);
  const preview = test.buffer
    .slice(start, end)
    .replace(/\s+/g, " ")
    .trim();
  finishResponseTest(test.token, "success", {
    latency,
    preview: t("response.result.matchPreview", { preview }),
  });
}

export { cancelResponseTest, closeResponseTestDialog, finishResponseTest, formatResponseLatency, initializeResponseTest, observeResponseTest, openResponseTestDialog, responseTestConnected, setResponseTestStatus, startResponseTest, updateResponseTestUI };
