// Module: Global toast queue.
// Owns: message de-duplication, queueing, expiry, and rendering.
// Depends on: lucide, core/dom.js, core/state.js.
// Called by: feature modules and app.js.

import { Activity, Check, TriangleAlert, createIcons } from "lucide";
import { els } from "../core/dom.js";
import { t, tCount } from "../core/i18n.js";
import { state } from "../core/state.js";

function removeToastFromQueue(id) {
  const index = state.toastQueue.findIndex((item) => item.id === id);
  if (index < 0) return;
  const [removed] = state.toastQueue.splice(index, 1);
  if (removed?.timer) window.clearTimeout(removed.timer);
  renderToastQueue();
}

function scheduleToastExpiry(item) {
  if (item.timer) window.clearTimeout(item.timer);
  item.timer = window.setTimeout(
    () => removeToastFromQueue(item.id),
    item.type === "error" ? 5600 : 3600,
  );
}

function renderToastQueue() {
  if (!els.toastRegion) return;
  els.toastRegion.replaceChildren();
  const visibleLimit = window.matchMedia("(max-width: 680px)").matches ? 1 : 2;
  const visible = state.toastQueue.slice(-visibleLimit).reverse();
  visible.forEach((item) => {
    const toast = document.createElement("div");
    toast.className = `toast toast--${item.type}`;
    toast.dataset.toastId = item.id;

    const iconName =
      item.type === "success" ? "check" : item.type === "error" ? "triangle-alert" : "activity";
    const icon = document.createElement("i");
    icon.setAttribute("data-lucide", iconName);

    const text = document.createElement("span");
    text.textContent = item.count > 1 ? `${item.message} ×${item.count}` : item.message;
    toast.append(icon, text);
    els.toastRegion.append(toast);
  });

  const hiddenCount = Math.max(0, state.toastQueue.length - visible.length);
  if (hiddenCount > 0) {
    const overflow = document.createElement("div");
    overflow.className = "toast toast--more";
    overflow.textContent = tCount("toast.moreItems", hiddenCount);
    els.toastRegion.append(overflow);
  }

  createIcons({
    icons: { Activity, Check, TriangleAlert },
  });
}

function showToast(message, type = "info") {
  const normalizedMessage = String(message || "").trim() || t("toast.done");
  const existing = [...state.toastQueue]
    .reverse()
    .find((item) => item.message === normalizedMessage && item.type === type);
  if (existing) {
    existing.count += 1;
    scheduleToastExpiry(existing);
    renderToastQueue();
    return;
  }

  state.toastSequence += 1;
  const item = {
    id: `toast-${state.toastSequence}`,
    message: normalizedMessage,
    type,
    count: 1,
    timer: null,
  };
  state.toastQueue.push(item);
  while (state.toastQueue.length > 6) {
    const removed = state.toastQueue.shift();
    if (removed?.timer) window.clearTimeout(removed.timer);
  }
  scheduleToastExpiry(item);
  renderToastQueue();
}

export { removeToastFromQueue, renderToastQueue, scheduleToastExpiry, showToast };
