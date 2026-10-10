// Module: shared browser/mock harness for the LinkTK test suites.
// Extracted from tests/smoke.mjs so tests/screenshots.mjs can reuse the same
// dev-server boot, Edge/Chrome discovery, mock Web Serial port and utilities
// instead of keeping a drifting second copy.

import { spawn } from "node:child_process";
import dgram from "node:dgram";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

export function findBrowserPath() {
  const browserPath = EDGE_CANDIDATES.find(existsSync);
  if (!browserPath) {
    throw new Error("No Edge or Chrome browser available for testing.");
  }
  return browserPath;
}

// Starts the vite dev server on `port` and returns the child process plus a
// readiness poller. Pass the same agentToken to the Agent CLI/MCP processes so
// they authenticate against this instance.
export async function startDevServer({ root, port, agentToken }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  // --strictPort: if the port is already taken (e.g. a stale dev server from an
  // aborted run), fail loudly instead of silently testing against that server.
  const server = spawn(
    process.execPath,
    [
      join(root, "node_modules", "vite", "bin", "vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(agentToken ? { LINKTK_AGENT_TOKEN: agentToken } : {}),
      },
    },
  );

  let serverOutput = "";
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });

  async function waitForServer() {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(baseUrl);
        if (response.ok) return;
      } catch {
        // Server is still starting.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Dev server startup timed out.\n${serverOutput}`);
  }

  return { server, baseUrl, waitForServer, output: () => serverOutput };
}

// One init script for every page: a mock clipboard, a mock File System Access
// directory picker, and a mock Web Serial port exposing window.__serialMock.
// Pass options through addInitScript(initPageMocks, { uiLanguage, ... }) —
// Playwright serializes the function source, so closure state does not travel.
export function initPageMocks(options = {}) {
  const uiLanguage = options.uiLanguage || "en";
  const agentApprovalMode = options.agentApprovalMode || "trusted";
  const settings = JSON.parse(localStorage.getItem("linktk.settings.v1") || "{}");
  localStorage.setItem(
    "linktk.settings.v1",
    JSON.stringify({ ...settings, agentApprovalMode, uiLanguage }),
  );
  window.__copiedText = "";
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text) => {
        window.__copiedText = String(text);
      },
    },
  });

  window.__autoSaveFiles = new Map();
  Object.defineProperty(window, "showDirectoryPicker", {
    configurable: true,
    value: async () => ({
      name: "mock-auto-save",
      requestPermission: async () => "granted",
      getFileHandle: async (name) => ({
        createWritable: async () => {
          let position = 0;
          return {
            seek: async (offset) => {
              position = Number(offset) || 0;
            },
            write: async (data) => {
              const text = String(data);
              const current = window.__autoSaveFiles.get(name) || "";
              window.__autoSaveFiles.set(
                name,
                `${current.slice(0, position)}${text}${current.slice(position + text.length)}`,
              );
              position += text.length;
            },
            close: async () => {},
          };
        },
      }),
    }),
  });

  const encoder = new TextEncoder();
  const listeners = new Map();

  class MockSerialPort {
    constructor() {
      this.isOpen = false;
      this.readController = null;
      this.readableStream = null;
      this.writableStream = null;
    }

    async open(options) {
      this.options = options;
      this.isOpen = true;
      this.readableStream = new ReadableStream({
        start: (controller) => {
          this.readController = controller;
        },
      });
      this.writableStream = new WritableStream({
        write: (chunk) => {
          window.__serialMock.written.push([...chunk]);
          void window.__notifySerialWrite?.([...chunk]);
        },
      });
    }

    async close() {
      this.isOpen = false;
      try {
        this.readController?.close();
      } catch {
        // The reader may already have cancelled the stream.
      }
      this.readController = null;
      this.readableStream = null;
      this.writableStream = null;
    }

    get readable() {
      return this.isOpen ? this.readableStream : null;
    }

    get writable() {
      return this.isOpen ? this.writableStream : null;
    }

    getInfo() {
      return {
        usbVendorId: 0x1a86,
        usbProductId: 0x7523,
      };
    }

    async setSignals(signals) {
      this.signals = signals;
    }
  }

  const port = new MockSerialPort();
  const serial = {
    getPorts: async () => [port],
    requestPort: async () => port,
    addEventListener: (type, callback) => {
      listeners.set(type, callback);
    },
    removeEventListener: (type) => {
      listeners.delete(type);
    },
  };

  Object.defineProperty(navigator, "serial", {
    configurable: true,
    get: () => serial,
  });

  window.__serialMock = {
    port,
    written: [],
    emit(text) {
      if (!port.readController) throw new Error("Mock serial port is not open yet.");
      port.readController.enqueue(encoder.encode(text));
    },
    emitBytes(bytes) {
      if (!port.readController) throw new Error("Mock serial port is not open yet.");
      port.readController.enqueue(new Uint8Array(bytes));
    },
  };
}

// Builds a runAgentCli(args, { timeoutMs }) bound to one dev-server instance.
export function makeAgentCli({ root, port, agentToken, defaultTimeoutMs = 15000 }) {
  return async function runAgentCli(args, { timeoutMs = defaultTimeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(root, "tools", "linktk-agent.mjs"), ...args], {
        cwd: root,
        env: {
          ...process.env,
          LINKTK_AGENT_URL: `ws://127.0.0.1:${port}/__agent-control`,
          LINKTK_AGENT_TOKEN: agentToken,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Agent CLI timed out: ${args.join(" ")}\n${stdout}\n${stderr}`));
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(
            new Error(
              `Agent CLI exited with failure (code=${code}, signal=${signal || "none"}): ${args.join(" ")}\n${stdout}\n${stderr}`,
            ),
          );
        }
      });
    });
  };
}

export async function waitForValue(page, selector, expected) {
  await page.waitForFunction(
    ({ selector, expected }) => document.querySelector(selector)?.textContent?.includes(expected),
    { selector, expected },
  );
}

export async function getFreeTcpPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function getFreeUdpPort() {
  const socket = dgram.createSocket("udp4");
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", resolve);
  });
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

export async function showSerialControlGroup(targetPage, group) {
  const tab = targetPage.locator(`[data-serial-control-group="${group}"]`);
  if (await tab.isVisible()) {
    await tab.click();
    await targetPage.waitForFunction(
      (activeGroup) =>
        document.querySelector("#serialControlPanel")?.dataset.activeGroup === activeGroup,
      group,
    );
  }
  if (group === "connection") {
    for (const sectionId of ["#portSection", "#serialSettingsSection"]) {
      const collapsed = await targetPage
        .locator(sectionId)
        .evaluate((element) => element.classList.contains("is-collapsed"));
      if (collapsed) {
        await targetPage
          .locator(`${sectionId} .section-collapse-button`)
          .evaluate((element) => element.click());
      }
    }
  }
}
