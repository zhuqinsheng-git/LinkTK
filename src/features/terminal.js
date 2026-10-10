// Module: The xterm terminal instance, fit handling, and keyboard input sending.
// Owns: terminal construction, search/fit addons, local echo, and input forwarding.
// Depends on: xterm, core, macro; serial sending is injected by app.js.
// Called by: app.js initialization and Macro playback.

import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import { textEncoder } from "../core/constants.js";
import { els, hasExternalTextEntryFocus } from "../core/dom.js";
import { t } from "../core/i18n.js";
import { state } from "../core/state.js";
import { recordTerminalMacroInput } from "./macro.js";

let serialInputSender = null;

function initializeTerminal({ sendSerialPayload } = {}) {
  if (typeof sendSerialPayload !== "function") {
    throw new TypeError("initializeTerminal requires sendSerialPayload.");
  }
  serialInputSender = sendSerialPayload;
  if (state.terminal) return;

  const monoFont = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  const terminal = new Terminal({
    // The search addon uses marker and decoration APIs to highlight matches.
    allowProposedApi: true,
    allowTransparency: false,
    cursorBlink: true,
    cursorStyle: "bar",
    convertEol: true,
    fontFamily: monoFont || "Consolas, monospace",
    fontSize: 14,
    fontWeight: "400",
    lineHeight: 1.3,
    scrollback: 12000,
    smoothScrollDuration: 80,
    theme: {
      background: "#173a5e",
      foreground: "#f5f5f5",
      cursor: "#9dbb4e",
      cursorAccent: "#173a5e",
      selectionBackground: "#566b83",
      black: "#183047",
      red: "#c75f59",
      green: "#9dbb4e",
      yellow: "#d7b35f",
      blue: "#78a9d4",
      magenta: "#b98ac7",
      cyan: "#57a7a4",
      white: "#f5f5f5",
      brightBlack: "#8c8c8c",
      brightRed: "#df7b74",
      brightGreen: "#c3dc7c",
      brightYellow: "#ebcb7e",
      brightBlue: "#8fc1eb",
      brightMagenta: "#d0a5e2",
      brightCyan: "#7fd0cd",
      brightWhite: "#ffffff",
    },
  });
  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon({ highlightLimit: 1000 });
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  terminal.open(els.terminalMount);
  terminal.onData((data) => {
    void sendTerminalInput(data);
  });

  state.terminal = terminal;
  state.terminalFitAddon = fitAddon;
  state.terminalSearchAddon = searchAddon;
  searchAddon.onDidChangeResults(({ resultCount, resultIndex }) => {
    const hasResults = resultCount > 0;
    const position = hasResults ? `${Math.max(resultIndex, 0) + 1} / ${resultCount}` : "0 / 0";
    els.terminalKeywordPreviousButton.disabled = !hasResults;
    els.terminalKeywordNextButton.disabled = !hasResults;
    els.terminalKeywordNextButton.dataset.resultCount = String(resultCount);
    els.terminalKeywordNextButton.dataset.resultIndex = String(resultIndex);
    els.terminalKeywordPreviousButton.title = t("serial.search.prevWithPosition", { position });
    els.terminalKeywordNextButton.title = t("serial.search.nextWithPosition", { position });
  });
  state.terminalResizeObserver = new ResizeObserver(() => fitTerminal());
  state.terminalResizeObserver.observe(els.terminalViewport);
}

function fitTerminal({ focus = false, respectActiveTextEntry = false } = {}) {
  if (!state.terminal || !state.terminalFitAddon || state.consoleView !== "terminal") return;

  requestAnimationFrame(() => {
    try {
      state.terminalFitAddon.fit();
      if (focus && !(respectActiveTextEntry && hasExternalTextEntryFocus())) {
        state.terminal.focus();
      }
    } catch {
      // The terminal may be between visibility and layout states.
    }
  });
}

async function sendTerminalInput(data) {
  if (!state.connected || !state.writer || state.ymodemBusy) return false;
  recordTerminalMacroInput(data);
  if (state.terminalLocalEcho && state.terminal) {
    state.terminal.write(data.replace(/\r(?!\n)/g, "\r\n"));
  }
  return serialInputSender(textEncoder.encode(data), { recordLog: false });
}

export { fitTerminal, initializeTerminal, sendTerminalInput };
