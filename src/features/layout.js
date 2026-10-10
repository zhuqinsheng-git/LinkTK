// Module: Serial control panel and responsive layout state.
// Owns: control groups, collapsible sections, mobile default layout, and the network send panel collapse.
// Depends on: core, quick-send, macro, ymodem, network.
// Called by: app.js.

import { els } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { persistSettings } from "../core/settings.js";
import { state } from "../core/state.js";
import { setMacroCollapsed } from "./macro.js";
import { scrollNetworkToLatest } from "./network.js";
import { setNetworkQuickSendCollapsed, setQuickSendCollapsed } from "./quick-send.js";
import { setYmodemCollapsed } from "./ymodem.js";

function setControlPanelGroup(group, { persist = true } = {}) {
  const normalized = ["connection", "commands", "automation", "transfer"].includes(group)
    ? group
    : "connection";
  state.controlPanelGroup = normalized;
  if (els.serialControlPanel) {
    els.serialControlPanel.dataset.activeGroup = normalized;
  }
  els.serialControlTabs.forEach((button) => {
    const active = button.dataset.serialControlGroup === normalized;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (normalized === "commands") setQuickSendCollapsed(false, { persist: false });
  if (normalized === "automation") setMacroCollapsed(false, { persist: false });
  if (normalized === "transfer") setYmodemCollapsed(false, { persist: false });
  if (persist) persistSettings();
}

function setPanelSectionCollapsed(
  section,
  content,
  toggleButton,
  collapsed,
  { persist = true } = {},
) {
  if (!section || !content || !toggleButton) return;
  const isCollapsed = Boolean(collapsed);
  section.classList.toggle("is-collapsed", isCollapsed);
  toggleButton.setAttribute("aria-expanded", String(!isCollapsed));
  const label = section.querySelector(".section-heading h2")?.textContent || t("layout.panel");
  const action = isCollapsed
    ? t("layout.expandLabel", { label })
    : t("layout.collapseLabel", { label });
  toggleButton.title = action;
  toggleButton.setAttribute("aria-label", action);
  if (persist) persistSettings();
}

function setPortSectionCollapsed(collapsed, options = {}) {
  setPanelSectionCollapsed(
    els.portSection,
    els.portSectionContent,
    els.portSectionToggleButton,
    collapsed,
    options,
  );
}

function setSerialSettingsCollapsed(collapsed, options = {}) {
  setPanelSectionCollapsed(
    els.serialSettingsSection,
    els.serialSettingsContent,
    els.serialSettingsToggleButton,
    collapsed,
    options,
  );
}

function applyMobileLayoutDefaults() {
  if (
    state.mobileDefaultsApplied ||
    !window.matchMedia("(max-width: 680px)").matches
  ) {
    return;
  }
  state.mobileDefaultsApplied = true;
  setPortSectionCollapsed(true, { persist: false });
  setSerialSettingsCollapsed(true, { persist: false });
  setQuickSendCollapsed(true, { persist: false });
  setMacroCollapsed(true, { persist: false });
  setYmodemCollapsed(true, { persist: false });
}

function setNetworkSendPanelCollapsed(collapsed, { persist = true } = {}) {
  state.networkSendPanelCollapsed = Boolean(collapsed);
  els.networkSendPanel.classList.toggle("is-collapsed", state.networkSendPanelCollapsed);
  els.networkToggleSendPanelButton.setAttribute(
    "aria-pressed",
    String(state.networkSendPanelCollapsed),
  );
  els.networkToggleSendPanelButton.title = state.networkSendPanelCollapsed
    ? t("net.send.expandArea")
    : t("net.send.collapseArea");
  els.networkToggleSendPanelButton.setAttribute(
    "aria-label",
    els.networkToggleSendPanelButton.title,
  );
  if (state.networkAutoScroll && !state.networkFollowSuspended) {
    scrollNetworkToLatest();
  }
  if (persist) persistSettings();
}

export { applyMobileLayoutDefaults, setControlPanelGroup, setNetworkSendPanelCollapsed, setPanelSectionCollapsed, setPortSectionCollapsed, setSerialSettingsCollapsed };
