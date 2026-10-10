// Module: generates the illustrated tutorial screenshots into docs/images/{en,zh-CN}/.
// Usage: npm run screenshots   (requires Edge or Chrome; reuses the same mock Web
// Serial harness as tests/smoke.mjs so the screenshots never drift from the tests).

import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import {
  findBrowserPath,
  getFreeTcpPort,
  initPageMocks,
  makeAgentCli,
  showSerialControlGroup,
  startDevServer,
} from "./harness/browser-mocks.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = 4175;
const agentToken = "linktk-screenshots-token-0123456789abcdef";
const outDir = join(root, "docs", "images");
const browserPath = findBrowserPath();
const runAgentCli = makeAgentCli({ root, port, agentToken });

const { server, baseUrl, waitForServer } = await startDevServer({ root, port, agentToken });

let browser;
let peerSocket = null;

async function capture(page, locale, name) {
  await settle(page);
  const dir = join(outDir, locale);
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, name) });
  console.log(`  captured ${locale}/${name}`);
}

// Park the cursor in the middle of the viewport (no control under it, so no
// hover tooltip) and let any transient toast expire before taking a shot.
// The extra move + pause lets Chromium retire a native title tooltip that was
// showing for the last-clicked button.
async function settle(page) {
  const viewport = page.viewportSize();
  const centerX = Math.floor(viewport.width / 2);
  const centerY = Math.floor(viewport.height / 2);
  await page.mouse.move(centerX, centerY);
  await page.mouse.move(centerX + 1, centerY + 1);
  await page.waitForTimeout(500);
  await page
    .waitForFunction(() => (document.querySelector("#toastRegion")?.children.length ?? 0) === 0, null, {
      timeout: 10000,
    })
    .catch(() => {
      console.warn("  (a toast was still visible; capturing with it)");
    });
}

async function captureLocator(locator, locale, name) {
  await settle(locator.page());
  const dir = join(outDir, locale);
  mkdirSync(dir, { recursive: true });
  await locator.screenshot({ path: join(dir, name) });
  console.log(`  captured ${locale}/${name}`);
}

async function render(locale) {
  console.log(`rendering ${locale}...`);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  await context.addInitScript(initPageMocks, { uiLanguage: locale, agentApprovalMode: "trusted" });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(baseUrl, { waitUntil: "networkidle" });

  // 01 Serial overview: connect the mock port, exchange a request/response pair.
  await showSerialControlGroup(page, "connection");
  await page.waitForFunction(() => document.querySelector("#portSelect")?.value === "0");
  await page.locator("#baudRate").selectOption("115200");
  await page.locator("#connectButton").click();
  // Move the pointer off the button immediately: its title flips to "Close serial
  // port" once the port opens, and Chromium pops a native tooltip for a title that
  // changes under the cursor. That tooltip survives later mouse moves and would end
  // up in the screenshot.
  await page.mouse.move(720, 500);
  await page.waitForFunction(() => window.__serialMock.port.isOpen === true);
  if (await page.locator("#sendPanel").evaluate((element) => element.classList.contains("is-collapsed"))) {
    await page.locator("#toggleSendPanelButton").click();
    await page.waitForFunction(() => !document.querySelector("#sendPanel").classList.contains("is-collapsed"));
  }
  await page.locator("#sendInput").fill("AT+INFO");
  await page.locator("#sendButton").click();
  await page.evaluate(() => window.__serialMock.emit("EVB-A1 bootloader v2.1\r\nboard: EVB-A1-net1  soc: SSD202\r\n"));
  await page.evaluate(() => window.__serialMock.emit("link: eth0 up, 100M full-duplex\r\n"));
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#logContent .log-entry__data")].some((element) =>
      element.textContent.includes("100M full-duplex"),
    ),
  );
  await page.waitForTimeout(300);
  await capture(page, locale, "01-serial-overview.png");

  // 02 Quick send list.
  await showSerialControlGroup(page, "commands");
  await page.locator("#quickCommandList .quick-command-input").first().fill("help");
  await page.locator("#addQuickCommandButton").click();
  await page.locator("#quickCommandList .quick-command-input").nth(1).fill("AT+VERSION");
  await page.locator('#quickCommandList [data-quick-action="send"]').first().click();
  await page.evaluate(() => window.__serialMock.emit("\r\nlinktk shell ready\r\n"));
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#logContent .log-entry__data")].some((element) =>
      element.textContent.includes("linktk shell ready"),
    ),
  );
  await page.waitForTimeout(300);
  await capture(page, locale, "02-quick-send.png");

  // 03 Macro: seed one real macro through the Agent CLI, then show the Automation tab.
  await runAgentCli([
    "macro-create",
    "--name",
    "Boot",
    "--steps",
    JSON.stringify([{ type: "text", data: "help\r" }]),
  ]);
  await showSerialControlGroup(page, "automation");
  try {
    await page.waitForFunction(
      () => document.querySelector("#macroList")?.textContent?.includes("Boot"),
      null,
      { timeout: 5000 },
    );
  } catch {
    console.warn("  (macro list did not show the seeded macro in time; capturing as-is)");
  }
  await capture(page, locale, "03-macro.png");

  // 04 YMODEM file transfer with a file queued for sending.
  await showSerialControlGroup(page, "transfer");
  await page.locator("#ymodemFileInput").setInputFiles({
    name: "firmware.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(Array.from({ length: 8192 }, (_, index) => index & 0xff)),
  });
  await page.waitForFunction(() => !document.querySelector("#ymodemSendButton").disabled);
  await page.waitForTimeout(200);
  await capture(page, locale, "04-ymodem.png");

  // 05 Terminal with a typed command and its response.
  await page.locator('[data-console-view="terminal"]').click();
  await page.waitForFunction(() => !document.querySelector("#terminalViewport").hidden);
  const localEcho = page.locator("#terminalLocalEcho");
  if (!(await localEcho.isChecked())) {
    await page.locator("label:has(#terminalLocalEcho)").click();
  }
  await page.locator("#terminalMount").click();
  await page.keyboard.type("uname -a");
  await page.keyboard.press("Enter");
  await page.evaluate(() => window.__serialMock.emit("Linux evb-a1 5.10.61 #1 SMP armv7l GNU/Linux\r\n"));
  await page.evaluate(() => window.__serialMock.emit("root@evb-a1:~# "));
  await page.waitForTimeout(400);
  await capture(page, locale, "05-terminal.png");
  await page.locator('[data-console-view="log"]').click();
  await page.waitForFunction(() => document.querySelector("#terminalViewport").hidden);

  // 06 Display settings dialog.
  await page.locator("#serialDisplaySettingsButton").click();
  await page.waitForFunction(() => document.querySelector("#displaySettingsDialog").open);
  await page.waitForTimeout(250);
  await capture(page, locale, "06-display-settings.png");
  await page.locator("#confirmDisplaySettingsButton").click();
  await page.waitForFunction(() => !document.querySelector("#displaySettingsDialog").open);

  // 07 AI activity: run one real AI write through the Agent CLI, then open the panel.
  await runAgentCli(["send", "--text", "AT+AI-CHECK", "--ending", "lf"]);
  await page.waitForFunction(() => !document.querySelector("#agentActivityCount")?.hidden);
  await page.locator("#agentActivityButton").click();
  await page.waitForFunction(() => document.querySelector("#agentActivityDialog")?.open);
  await page.waitForFunction(() => document.querySelector("#agentActivityList .agent-activity-item"));
  await page.waitForTimeout(300);
  await capture(page, locale, "07-agent-activity.png");
  await page.locator("#closeAgentActivityButton").click();
  await page.waitForFunction(() => !document.querySelector("#agentActivityDialog")?.open);

  // 08 TCP server with a real peer, so the peer color marker and RX data show.
  await page.locator('[data-workspace-mode="network"]').click();
  await page.waitForFunction(() => !document.querySelector("#networkWorkspace").hidden);
  await page.locator('[data-network-protocol="tcp"]').click();
  await page.locator('[data-network-role="server"]').click();
  const tcpPort = await getFreeTcpPort();
  await page.locator("#networkHost").fill("127.0.0.1");
  await page.locator("#networkPort").fill(String(tcpPort));
  await page.locator("#networkConnectButton").click();
  await page.mouse.move(720, 700); // same tooltip guard as scenario 01
  peerSocket = connect({ host: "127.0.0.1", port: tcpPort });
  peerSocket.on("error", (error) => console.warn(`  (peer socket error: ${error.message})`));
  await once(peerSocket, "connect");
  peerSocket.write("HELLO FROM PEER\r\n");
  await page.waitForFunction(() => document.querySelector("#networkLinkCounter")?.textContent.trim() === "1");
  await page.waitForFunction(() =>
    document.querySelector("#networkLogContent")?.textContent.includes("HELLO FROM PEER"),
  );
  await page.waitForTimeout(300);
  await capture(page, locale, "08-tcp-server.png");

  // 09 Network send area with template variables.
  await page.locator("#networkSendInput").fill("STATUS BOARD=");
  await page.locator("#networkTemplateButton").click();
  await page.waitForFunction(() => document.querySelector("#templateVariablesDialog").open);
  await page.locator("#addTemplateVariableButton").click();
  const templateRow = page.locator(".template-variable-row").first();
  await templateRow.locator('[data-template-field="name"]').fill("board");
  await templateRow.locator('[data-template-field="value"]').fill("EVB-A1");
  await page.locator('[data-template-token="counter"]').click();
  await page.locator('[data-template-action="insert"]').click();
  await page.waitForTimeout(250);
  await capture(page, locale, "09-network-template.png");
  await page.locator("#saveTemplateVariablesButton").click();
  await page.waitForFunction(() => !document.querySelector("#templateVariablesDialog").open);

  // 10 Language switcher (top-bar clip; this image documents the bilingual UI itself).
  await captureLocator(page.locator(".topbar__actions"), locale, "10-language-switcher.png");

  // 11 Mobile 390px serial view.
  await page.locator('[data-workspace-mode="serial"]').click();
  await page.waitForFunction(() => !document.querySelector("#serialWorkspace").hidden);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await capture(page, locale, "11-mobile-serial.png");

  if (peerSocket) {
    peerSocket.end();
    peerSocket = null;
  }
  await context.close();
  if (pageErrors.length) {
    throw new Error(`Page runtime error(s) while rendering ${locale}:\n${pageErrors.join("\n")}`);
  }
}

try {
  await waitForServer();
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  for (const locale of ["en", "zh-CN"]) {
    await render(locale);
  }
  console.log("Screenshots written to docs/images/{en,zh-CN}.");
} finally {
  if (peerSocket) peerSocket.end();
  await browser?.close();
  server.kill();
}
