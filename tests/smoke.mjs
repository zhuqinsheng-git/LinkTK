import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { YmodemSession } from "../src/ymodem.js";
import {
  findBrowserPath,
  getFreeTcpPort,
  getFreeUdpPort,
  initPageMocks,
  makeAgentCli,
  showSerialControlGroup,
  startDevServer,
  waitForValue,
} from "./harness/browser-mocks.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = 4173;
const baseUrl = `http://127.0.0.1:${port}`;
const agentToken = "linktk-smoke-token-0123456789abcdef";
const browserPath = findBrowserPath();
const runAgentCli = makeAgentCli({ root, port, agentToken });

const { server, waitForServer } = await startDevServer({ root, port, agentToken });

let browser;
let remoteYmodemReceiver = null;

try {
  await waitForServer();
  browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });

  // This suite asserts Chinese UI strings, so every page in this context runs in
  // zh-CN (the app itself defaults to English since the i18n change).
  await context.addInitScript(initPageMocks, { uiLanguage: "zh-CN", agentApprovalMode: "trusted" });

  const page = await context.newPage();
  await page.exposeFunction("__notifySerialWrite", (bytes) => {
    remoteYmodemReceiver?.push(Uint8Array.from(bytes));
  });

  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  if ((await page.locator("#headerConnectButton").count()) !== 0) {
    throw new Error("Duplicate serial connect buttons are still present in the top bar.");
  }
  if (!(await page.locator("#headerStatus").isVisible())) {
    throw new Error("Serial workspace did not show the top-bar connection status.");
  }
  if (await page.locator("#networkHeaderStatus").isVisible()) {
    throw new Error("Serial workspace should not show the network top-bar status.");
  }
  const desktopLayoutState = await page.evaluate(() => {
    const controlPanel = document.querySelector("#serialWorkspace .control-panel");
    const consoleArea = document.querySelector("#serialWorkspace .console-area");
    const bridgeButton = document.querySelector("#bridgeButton");
    const networkSwitch = document.querySelector('[data-workspace-mode="network"]');
    const controlRect = controlPanel.getBoundingClientRect();
    const consoleRect = consoleArea.getBoundingClientRect();
    const bridgeRect = bridgeButton.getBoundingClientRect();
    const networkSwitchRect = networkSwitch.getBoundingClientRect();
    const bridgeStyle = getComputedStyle(bridgeButton);
    const switchStyle = getComputedStyle(networkSwitch);
    const bridgeTextRange = document.createRange();
    bridgeTextRange.selectNodeContents(bridgeButton);
    const bridgeTextRect = bridgeTextRange.getBoundingClientRect();
    return {
      controlLeft: controlRect.left,
      consoleLeft: consoleRect.left,
      bridgeLeft: bridgeRect.left,
      networkSwitchRight: networkSwitchRect.right,
      bridgeHeight: bridgeRect.height,
      switchHeight: networkSwitchRect.height,
      bridgeFontSize: bridgeStyle.fontSize,
      switchFontSize: switchStyle.fontSize,
      bridgeCenter: bridgeRect.left + bridgeRect.width / 2,
      bridgeTextCenter: bridgeTextRect.left + bridgeTextRect.width / 2,
    };
  });
  if (desktopLayoutState.controlLeft <= desktopLayoutState.consoleLeft) {
    throw new Error(`Control panel did not move to the right of the receive area: ${JSON.stringify(desktopLayoutState)}`);
  }
  if (desktopLayoutState.bridgeLeft <= desktopLayoutState.networkSwitchRight) {
    throw new Error(`Bridge button did not move to the right of the serial/network toggle: ${JSON.stringify(desktopLayoutState)}`);
  }
  if (
    Math.abs(desktopLayoutState.bridgeHeight - desktopLayoutState.switchHeight) > 1 ||
    desktopLayoutState.bridgeFontSize !== desktopLayoutState.switchFontSize
  ) {
    throw new Error(`Bridge button and workspace toggle differ in size or font size: ${JSON.stringify(desktopLayoutState)}`);
  }
  if (Math.abs(desktopLayoutState.bridgeCenter - desktopLayoutState.bridgeTextCenter) > 1) {
    throw new Error(`Bridge label is not centered: ${JSON.stringify(desktopLayoutState)}`);
  }
  const baudOptionCount = await page.locator("#baudRate option").count();
  if (baudOptionCount < 20) {
    throw new Error(`Too few common baud-rate options: ${baudOptionCount}`);
  }
  await page.locator("#baudRate").selectOption("9600");
  await page.locator("#baudRate").selectOption("115200");

  await showSerialControlGroup(page, "commands");
  const quickInputFont = await page
    .locator("#quickCommandList .quick-command-input")
    .first()
    .evaluate((element) => getComputedStyle(element).fontSize);
  const receiveFont = await page
    .locator("#logContent")
    .evaluate((element) => getComputedStyle(element).fontSize);
  if (quickInputFont !== receiveFont) {
    throw new Error(`Quick-send font does not match the receive area: ${quickInputFont} / ${receiveFont}`);
  }

  await showSerialControlGroup(page, "connection");
  await page.waitForFunction(() => document.querySelector("#portSelect")?.value === "0");
  const portOptionText = await page.locator('#portSelect option[value="0"]').textContent();
  // Port labels are hardware identifiers (never localized): the mock declares
  // VID 1A86 / PID 7523, so the option must show the concrete USB Serial label
  // rather than any generic fallback name.
  if (!/USB Serial/i.test(portOptionText) || !/1A86/i.test(portOptionText)) {
    throw new Error(`Port list does not show the concrete device label: ${portOptionText}`);
  }
  await page.locator("#baudRate").selectOption("9600");
  await page.locator("#saveSerialPresetButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#serialPresetSelect option").length === 2);
  const serialPresetId = await page.locator("#serialPresetSelect").inputValue();
  if (!serialPresetId) {
    throw new Error("Saved serial connection preset was not auto-selected.");
  }
  await page.locator("#baudRate").selectOption("115200");
  await page.locator("#serialPresetSelect").selectOption(serialPresetId);
  await page.waitForFunction(() => document.querySelector("#baudRate").value === "9600");
  await page.locator("#deleteSerialPresetButton").click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#serialPresetSelect option").length === 1 &&
      document.querySelector("#deleteSerialPresetButton").disabled,
  );
  await page.locator("#baudRate").selectOption("115200");
  await page.locator("#connectButton").click();
  await waitForValue(page, "#headerStatusText", "已连接");
  if (await page.locator("#lineEnding").isDisabled()) {
    throw new Error("Line-ending selector was incorrectly locked after serial connect.");
  }
  await page.locator("#lineEnding").selectOption("lf");
  await page.waitForFunction(() => document.querySelector("#lineEnding").value === "lf");
  await page.locator("#lineEnding").selectOption("crlf");
  await page.waitForFunction(() => document.querySelector("#lineEnding").value === "crlf");

  await showSerialControlGroup(page, "commands");
  await page.locator("#quickSendToggleButton").click();
  await page.waitForFunction(() => document.querySelector("#quickSendSection").classList.contains("is-collapsed"));
  await page.locator("#quickSendToggleButton").click();
  await page.waitForFunction(() => !document.querySelector("#quickSendSection").classList.contains("is-collapsed"));

  await showSerialControlGroup(page, "transfer");
  if ((await page.locator("#ymodemSection").count()) !== 1) {
    throw new Error("YMODEM file transfer area was not rendered.");
  }
  await page.locator("#ymodemToggleButton").click();
  await page.waitForFunction(() => document.querySelector("#ymodemSection").classList.contains("is-collapsed"));
  await page.locator("#ymodemToggleButton").click();
  await page.waitForFunction(() => !document.querySelector("#ymodemSection").classList.contains("is-collapsed"));

  await page.locator("#ymodemFileInput").setInputFiles({
    name: "firmware.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from([0x01, 0x02, 0x03, 0x04]),
  });
  await page.waitForFunction(() => !document.querySelector("#ymodemSendButton").disabled);
  await page.locator('[data-ymodem-mode="receive"]').click();
  await page.waitForFunction(() => !document.querySelector("#ymodemReceivePane").hidden);
  await page.locator('[data-ymodem-mode="send"]').click();
  await page.waitForFunction(() => !document.querySelector("#ymodemSendPane").hidden);

  await showSerialControlGroup(page, "commands");
  const quickCommandRows = page.locator("#quickCommandList .quick-command-row");
  if ((await quickCommandRows.count()) !== 1) {
    throw new Error("Serial quick-send should have exactly one entry after init.");
  }
  await page.locator("#quickCommandList .quick-command-input").first().fill("AT");
  await page.locator("#addQuickCommandButton").click();
  if ((await quickCommandRows.count()) !== 2) {
    throw new Error("Failed to add a serial quick-send entry.");
  }
  await quickCommandRows.nth(1).locator('[data-quick-action="delete"]').click();
  if ((await quickCommandRows.count()) !== 1) {
    throw new Error("Failed to remove a serial quick-send entry.");
  }
  await page.locator('#quickCommandList [data-quick-action="send"]').first().click();
  await page.waitForFunction(() => window.__serialMock.written.length === 1);

  const firstWrite = await page.evaluate(() => window.__serialMock.written[0]);
  if (firstWrite.join(",") !== "65,84,13,10") {
    throw new Error(`Quick-send AT bytes are incorrect: ${firstWrite.join(",")}`);
  }

  await page.evaluate(() => window.__serialMock.emit("OK\r\n"));
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".log-entry__data")].some((element) =>
      element.textContent.includes("OK"),
    ),
  );
  const compactLogMetrics = await page
    .locator("#logContent .log-entry")
    .filter({ hasText: "OK" })
    .last()
    .evaluate((entry) => {
      const style = getComputedStyle(entry);
      return {
        lineHeight: Number.parseFloat(style.lineHeight),
        paddingTop: Number.parseFloat(style.paddingTop),
        paddingBottom: Number.parseFloat(style.paddingBottom),
        marginTop: Number.parseFloat(style.marginTop),
        marginBottom: Number.parseFloat(style.marginBottom),
      };
    });
  if (
    compactLogMetrics.lineHeight > 19.5 ||
    compactLogMetrics.paddingTop > 4 ||
    compactLogMetrics.paddingBottom > 4 ||
    compactLogMetrics.marginTop > 2 ||
    compactLogMetrics.marginBottom > 2
  ) {
    throw new Error(`Log area is still too loose: ${JSON.stringify(compactLogMetrics)}`);
  }

  await page.locator('[data-receive-mode="hex"]').click();
  await page.evaluate(() => window.__serialMock.emitBytes([0xaa, 0x55, 0x01]));
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".log-entry__data")].some(
      (element) => element.textContent.trim() === "AA 55 01",
    ),
  );

  await page.locator('[data-send-mode="hex"]').click();
  if (await page.locator("#sendPanel").evaluate((element) => element.classList.contains("is-collapsed"))) {
    await page.locator("#toggleSendPanelButton").click();
    await page.waitForFunction(() => !document.querySelector("#sendPanel").classList.contains("is-collapsed"));
  }
  await page.locator("#sendInput").fill("01 02 FF");
  await page.locator("#sendButton").click();
  await page.waitForFunction(() => window.__serialMock.written.length === 2);

  const secondWrite = await page.evaluate(() => window.__serialMock.written[1]);
  if (secondWrite.join(",") !== "1,2,255") {
    throw new Error(`HEX send bytes are incorrect: ${secondWrite.join(",")}`);
  }

  await waitForValue(page, "#rxCounter", "7 B");
  await waitForValue(page, "#txCounter", "7 B");
  if ((await page.locator("#logContent .log-entry--tx").count()) === 0) {
    throw new Error("TX send log did not appear in the receive area.");
  }
  if ((await page.locator(".log-entry__meta").count()) !== 0) {
    throw new Error("Log entries still show per-entry byte or frame counts.");
  }

  await page.locator("#showRxToggle").uncheck();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#logContent .log-entry--rx")].every((entry) =>
      entry.classList.contains("is-filtered-out"),
    ),
  );
  await page.locator("#showRxToggle").check();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#logContent .log-entry--rx")].every(
      (entry) => !entry.classList.contains("is-filtered-out"),
    ),
  );

  await page.locator('[data-receive-mode="text"]').click();
  await page.locator("#serialDisplaySettingsButton").click();
  await page.waitForFunction(() => document.querySelector("#displaySettingsDialog").open);
  await page.locator('[data-timestamp-mode="elapsed"]').click();
  await page.locator("#confirmDisplaySettingsButton").click();
  await page.evaluate(() => window.__serialMock.emit("TIMESTAMP-MODE\r\n"));
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".log-entry")].some(
      (entry) =>
        entry.querySelector(".log-entry__data")?.textContent.includes("TIMESTAMP-MODE") &&
        entry.querySelector(".log-entry__time")?.textContent.trim().startsWith("+"),
      ),
  );

  await page.locator("#serialDisplaySettingsButton").click();
  await page.waitForFunction(() => document.querySelector("#displaySettingsDialog").open);
  await page.locator('[data-timestamp-mode="absolute"]').click();
  await page.locator("label:has(#dualModeToggle)").click();
  await page.locator("#confirmDisplaySettingsButton").click();
  const serialDualState = await page.evaluate(() => {
    const entry = [...document.querySelectorAll("#logContent .log-entry")].find((item) =>
      item.querySelector(".log-entry__data")?.textContent.includes("OK"),
    );
    const alternate = entry?.querySelector(".log-entry__alternate");
    return {
      contentDual: document.querySelector("#logContent").classList.contains("is-dual"),
      alternate: alternate?.textContent || "",
      alternateDisplay: alternate ? getComputedStyle(alternate).display : "none",
    };
  });
  if (
    !serialDualState.contentDual ||
    serialDualState.alternateDisplay === "none" ||
    !serialDualState.alternate.includes("4F 4B")
  ) {
    throw new Error(`Serial dual-column HEX/text display is incorrect: ${JSON.stringify(serialDualState)}`);
  }
  await page.locator("#serialDisplaySettingsButton").click();
  await page.waitForFunction(() => document.querySelector("#displaySettingsDialog").open);
  await page.locator("label:has(#dualModeToggle)").click();
  await page.locator("#confirmDisplaySettingsButton").click();

  await page.locator("#autoSaveButton").click();
  await page.waitForFunction(() => document.querySelector("#autoSaveDialog").open);
  for (const selector of [
    "#autoSaveEnabledToggle",
    "#autoSaveRotationMode",
    "#autoSaveLimitInput",
    "#chooseAutoSaveDirectoryButton",
  ]) {
    if ((await page.locator(selector).count()) !== 1) {
      throw new Error(`Auto-save settings are missing control: ${selector}`);
    }
  }
  await page.locator("#chooseAutoSaveDirectoryButton").click();
  await page.locator(".auto-save-dialog .switch").click();
  await page.locator("#saveAutoSaveButton").click();
  await page.waitForFunction(() => !document.querySelector("#autoSaveDialog").open);
  await page.evaluate(() => window.__serialMock.emit("AUTO-SAVE-TOKEN\r\n"));
  await page.waitForFunction(
    () => [...window.__autoSaveFiles.values()].some((text) => text.includes("AUTO-SAVE-TOKEN")),
    null,
    { timeout: 5000 },
  );
  await page.locator("#autoSaveButton").click();
  await page.waitForFunction(() => document.querySelector("#autoSaveDialog").open);
  await page.locator(".auto-save-dialog .switch").click();
  await page.locator("#saveAutoSaveButton").click();
  await page.waitForFunction(() => !document.querySelector("#autoSaveDialog").open);

  await page.locator('[data-receive-mode="text"]').click();
  await page.evaluate(() => window.__serialMock.emit("COPY-TOKEN\r\n"));
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".log-entry__data")].some((element) =>
      element.textContent.includes("COPY-TOKEN"),
    ),
  );
  const serialCopyRow = page.locator(".log-entry").filter({ hasText: "COPY-TOKEN" }).last();
  await serialCopyRow.locator(".log-entry__data").click();
  await page.waitForFunction(() => window.__copiedText.includes("COPY-TOKEN"));
  const serialCopiedTime = (
    await serialCopyRow.locator(".log-entry__time").textContent()
  ).trim();
  if (!serialCopiedTime) {
    throw new Error("Copied test log entry has no timestamp.");
  }
  await serialCopyRow.locator(".log-entry__time").click();
  await page.waitForFunction(
    (expected) => window.__copiedText === expected,
    serialCopiedTime,
  );

  const artifacts = join(root, "artifacts");
  mkdirSync(artifacts, { recursive: true });

  if (!(await page.locator("#serialTemplateButton").isDisabled())) {
    throw new Error("Template variable button was not disabled in HEX send mode.");
  }
  await page.locator('[data-send-mode="text"]').click();
  await page.locator("#sendInput").fill("COUNT=");
  await page.locator("#serialTemplateButton").click();
  await page.waitForFunction(() => document.querySelector("#templateVariablesDialog").open);
  await page.locator("#addTemplateVariableButton").click();
  const serialTemplateRow = page.locator(".template-variable-row").first();
  await serialTemplateRow.locator('[data-template-field="name"]').fill("device");
  await serialTemplateRow.locator('[data-template-field="value"]').fill("COM9");
  await page.locator('[data-template-token="counter"]').click();
  await serialTemplateRow.locator('[data-template-action="insert"]').click();
  await page.screenshot({
    path: join(artifacts, "serial-workbench-template-variables.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(artifacts, "serial-workbench-template-variables-mobile.png"),
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#saveTemplateVariablesButton").click();
  await page.waitForFunction(
    () => !document.querySelector("#templateVariablesDialog").open,
  );
  if ((await page.locator("#sendInput").inputValue()) !== "COUNT={{counter}}{{device}}") {
    throw new Error("Template variable was not inserted into the send area as expected.");
  }

  await page.locator("#sendInput").fill("COUNT={{counter}} DEV={{device}}");
  let templateWriteCount = await page.evaluate(() => window.__serialMock.written.length);
  await page.locator("#sendButton").click();
  await page.waitForFunction(
    (previousCount) => window.__serialMock.written.length > previousCount,
    templateWriteCount,
  );
  let templateWrite = await page.evaluate(
    (index) => window.__serialMock.written[index],
    templateWriteCount,
  );
  if (Buffer.from(templateWrite).toString() !== "COUNT=1 DEV=COM9\r\n") {
    throw new Error(`Serial template variable resolution is incorrect: ${Buffer.from(templateWrite).toString()}`);
  }

  templateWriteCount = await page.evaluate(() => window.__serialMock.written.length);
  await page.locator("#sendButton").click();
  await page.waitForFunction(
    (previousCount) => window.__serialMock.written.length > previousCount,
    templateWriteCount,
  );
  templateWrite = await page.evaluate(
    (index) => window.__serialMock.written[index],
    templateWriteCount,
  );
  if (Buffer.from(templateWrite).toString() !== "COUNT=2 DEV=COM9\r\n") {
    throw new Error(`Serial send counter did not increment: ${Buffer.from(templateWrite).toString()}`);
  }

  await showSerialControlGroup(page, "commands");
  await page.locator("#quickCommandList .quick-command-input").first().fill("QUICK={{device}}");
  templateWriteCount = await page.evaluate(() => window.__serialMock.written.length);
  await page.locator('#quickCommandList [data-quick-action="send"]').first().click();
  await page.waitForFunction(
    (previousCount) => window.__serialMock.written.length > previousCount,
    templateWriteCount,
  );
  templateWrite = await page.evaluate(
    (index) => window.__serialMock.written[index],
    templateWriteCount,
  );
  if (Buffer.from(templateWrite).toString() !== "QUICK=COM9\r\n") {
    throw new Error(`Quick-send did not resolve template variables: ${Buffer.from(templateWrite).toString()}`);
  }

  await page.locator("#sendInput").fill("AUTO={{counter}}");
  await page.locator("#autoSendInterval").fill("10");
  templateWriteCount = await page.evaluate(() => window.__serialMock.written.length);
  await page.locator("#autoSendButton").click();
  await page.waitForFunction(
    (previousCount) => window.__serialMock.written.length >= previousCount + 2,
    templateWriteCount,
  );
  await page.locator("#autoSendButton").click();
  await page.waitForFunction(
    () => document.querySelector("#autoSendButton").getAttribute("aria-pressed") === "false",
  );
  templateWrite = await page.evaluate(
    (index) => window.__serialMock.written[index],
    templateWriteCount,
  );
  if (Buffer.from(templateWrite).toString() !== "AUTO=3\r\n") {
    throw new Error(`Auto-send precheck wrongly consumed a template counter: ${Buffer.from(templateWrite).toString()}`);
  }

  await page.locator("#sendInput").fill("COUNTED");
  await page.locator("#autoSendCount").fill("2");
  await page.locator("#autoSendInterval").fill("10");
  templateWriteCount = await page.evaluate(() => window.__serialMock.written.length);
  await page.locator("#autoSendButton").click();
  await page.waitForFunction(
    () => document.querySelector("#autoSendButton").getAttribute("aria-pressed") === "false",
  );
  const countedWrites = await page.evaluate((previousCount) =>
    window.__serialMock.written
      .slice(previousCount)
      .map((bytes) => new TextDecoder().decode(Uint8Array.from(bytes))),
  templateWriteCount);
  if (countedWrites.length !== 2 || countedWrites.some((text) => text !== "COUNTED\r\n")) {
    throw new Error(`Count-based auto-send result is incorrect: ${JSON.stringify(countedWrites)}`);
  }
  await page.locator("#autoSendCount").fill("0");

  await page.locator("#sendInput").fill("PING");
  await page.locator("#serialResponseTestButton").click();
  await page.waitForFunction(() => document.querySelector("#responseTestDialog").open);
  await page.locator("#responseExpectedInput").fill("OK");
  await page.locator("#responseTimeoutInput").fill("500");
  let responseWriteCount = await page.evaluate(() => window.__serialMock.written.length);
  await page.locator("#startResponseTestButton").click();
  await page.waitForFunction(
    (previousCount) => window.__serialMock.written.length > previousCount,
    responseWriteCount,
  );
  await page.evaluate(() => window.__serialMock.emit("boot OK\r\n"));
  await page.waitForFunction(
    () => document.querySelector("#responseTestBadge").textContent === "成功",
  );
  const responseLatency = Number.parseFloat(
    await page.locator("#responseLatency").textContent(),
  );
  if (!Number.isFinite(responseLatency)) {
    throw new Error("A successful response test did not show a valid latency.");
  }
  await page.screenshot({
    path: join(artifacts, "serial-workbench-response-test.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(artifacts, "serial-workbench-response-test-mobile.png"),
  });
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.locator("#responseExpectedInput").fill("NEVER");
  await page.locator("#responseTimeoutInput").fill("80");
  responseWriteCount = await page.evaluate(() => window.__serialMock.written.length);
  await page.locator("#startResponseTestButton").click();
  await page.waitForFunction(
    (previousCount) => window.__serialMock.written.length > previousCount,
    responseWriteCount,
  );
  await page.waitForFunction(
    () => document.querySelector("#responseTestBadge").textContent === "超时",
  );
  await page.locator("#closeResponseTestDialogButton").click();
  await page.waitForFunction(() => !document.querySelector("#responseTestDialog").open);

  await page.locator("#sendInput").fill("HIST-ONE");
  responseWriteCount = await page.evaluate(() => window.__serialMock.written.length);
  await page.locator("#sendButton").click();
  await page.waitForFunction(
    (previousCount) => window.__serialMock.written.length > previousCount,
    responseWriteCount,
  );
  await page.locator("#sendInput").fill("HIST-TWO");
  responseWriteCount = await page.evaluate(() => window.__serialMock.written.length);
  await page.locator("#sendButton").click();
  await page.waitForFunction(
    (previousCount) => window.__serialMock.written.length > previousCount,
    responseWriteCount,
  );
  await page.locator("#sendInput").fill("DRAFT");
  await page.locator("#sendInput").press("ArrowUp");
  await page.waitForFunction(
    () => document.querySelector("#sendInput").value === "HIST-TWO",
  );
  await page.locator("#sendInput").press("ArrowUp");
  await page.waitForFunction(
    () => document.querySelector("#sendInput").value === "HIST-ONE",
  );
  await page.locator("#sendInput").press("ArrowDown");
  await page.waitForFunction(
    () => document.querySelector("#sendInput").value === "HIST-TWO",
  );
  await page.locator("#sendInput").press("ArrowDown");
  await page.waitForFunction(
    () => document.querySelector("#sendInput").value === "DRAFT",
  );
  const storedSerialHistory = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("linktk.settings.v1") || "{}")
        .serialSendHistory || [],
  );
  if (storedSerialHistory.at(-1) !== "HIST-TWO") {
    throw new Error(`Serial send history was not persisted: ${JSON.stringify(storedSerialHistory)}`);
  }
  await page.locator("#clearInputButton").click();

  await showSerialControlGroup(page, "connection");
  if (await page.locator("#dataBits").isVisible()) {
    throw new Error("Data bits should stay hidden on the main screen while advanced serial settings are closed.");
  }
  await page.locator("#openAdvancedSerialSettingsButton").click();
  await page.waitForFunction(() => document.querySelector("#advancedSerialSettingsDialog").open);
  if (!(await page.locator("#dataBits").isVisible())) {
    throw new Error("Advanced serial settings dialog did not show data-bit options.");
  }
  await page.screenshot({
    path: join(artifacts, "serial-workbench-more-settings.png"),
    fullPage: true,
  });
  await page.locator("#confirmAdvancedSerialSettingsButton").click();
  await page.waitForFunction(() => !document.querySelector("#advancedSerialSettingsDialog").open);

  await page.locator('[data-receive-mode="text"]').click();
  await page.evaluate(() =>
    window.__serialMock.emit("AWBus:\u001b[32m[hpm_pin]                 [OK]\u001b[0m\r\n"),
  );
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".log-entry__data")].some((element) =>
      element.textContent.includes("AWBus:[hpm_pin]                 [OK]"),
    ),
  );

  const ansiState = await page.evaluate(() => {
    const entry = [...document.querySelectorAll(".log-entry__data")].find((element) =>
      element.textContent.includes("AWBus:"),
    );
    const coloredSegment = [...entry.querySelectorAll("span")].find((element) =>
      element.textContent.includes("[hpm_pin]"),
    );
    return {
      text: entry.textContent,
      color: getComputedStyle(coloredSegment).color,
    };
  });

  if (ansiState.text.includes("[32m") || ansiState.text.includes("[0m")) {
    throw new Error(`ANSI control codes are still visible: ${ansiState.text}`);
  }
  if (ansiState.color !== "rgb(157, 187, 78)") {
    throw new Error(`ANSI green was not rendered correctly: ${ansiState.color}`);
  }

  await page.evaluate(() => window.__serialMock.emitBytes([...new TextEncoder().encode("SPLIT:\u001b[3")]));
  await page.waitForTimeout(40);
  await page.evaluate(() => window.__serialMock.emitBytes([...new TextEncoder().encode("2mGO\u001b[0m\r\n")]));
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".log-entry__data")].some((element) =>
      element.textContent.includes("SPLIT:GO"),
    ),
  );

  await page.locator("#serialDisplaySettingsButton").click();
  await page.waitForFunction(() => document.querySelector("#displaySettingsDialog").open);
  await page.locator("label:has(#ansiToggle)").click();
  await page.locator("#confirmDisplaySettingsButton").click();
  await page.evaluate(() => window.__serialMock.emit("ERR \u001b[31mFAIL\u001b[0m\r\n"));
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".log-entry__data")].some((element) =>
      element.textContent.includes("ERR FAIL"),
    ),
  );

  const plainAnsiState = await page.evaluate(() => {
    const entry = [...document.querySelectorAll(".log-entry__data")].find((element) =>
      element.textContent.includes("ERR FAIL"),
    );
    return {
      text: entry.textContent,
      childSpans: entry.querySelectorAll("span").length,
    };
  });

  if (plainAnsiState.text.includes("[31m") || plainAnsiState.childSpans !== 0) {
    throw new Error(`ANSI control codes or color nodes are still present after disabling colors: ${JSON.stringify(plainAnsiState)}`);
  }

  await page.locator("#keywordInput").fill("OK");
  await page.waitForFunction(
    () => document.querySelectorAll("#logContent mark.log-keyword-highlight").length >= 2,
  );
  const keywordHighlightState = await page.evaluate(() => {
    const marks = [...document.querySelectorAll("#logContent mark.log-keyword-highlight")];
    return {
      markCount: marks.length,
      background: marks[0] ? getComputedStyle(marks[0]).backgroundColor : "",
      filterDisabled: document.querySelector("#keywordFilterButton")?.disabled,
    };
  });
  if (
    keywordHighlightState.markCount < 2 ||
    keywordHighlightState.background === "rgba(0, 0, 0, 0)" ||
    keywordHighlightState.filterDisabled
  ) {
    throw new Error(`Serial keyword highlighting was not enabled correctly: ${JSON.stringify(keywordHighlightState)}`);
  }

  await page.locator("#keywordFilterButton").click();
  await page.waitForFunction(
    () => document.querySelector("#keywordFilterButton").getAttribute("aria-pressed") === "true",
  );
  const keywordFilterState = await page.evaluate(() => {
    const entries = [...document.querySelectorAll("#logContent .log-entry")];
    const hidden = entries.filter((entry) => entry.classList.contains("is-filtered-out"));
    const visible = entries.filter((entry) => !entry.classList.contains("is-filtered-out"));
    return {
      hiddenCount: hidden.length,
      visibleCount: visible.length,
      visibleAllMatch: visible.every((entry) => entry.textContent.includes("OK")),
    };
  });
  if (
    keywordFilterState.hiddenCount === 0 ||
    keywordFilterState.visibleCount === 0 ||
    !keywordFilterState.visibleAllMatch
  ) {
    throw new Error(`Serial keyword filter result is incorrect: ${JSON.stringify(keywordFilterState)}`);
  }

  await page.locator("#keywordFilterButton").click();
  await page.locator("#keywordInput").fill("");
  await page.waitForFunction(
    () =>
      !document.querySelector("#logContent .log-entry.is-filtered-out") &&
      !document.querySelector("#logContent mark.log-keyword-highlight"),
  );

  await page.evaluate(() => window.__serialMock.emit("alpha ALPHA alphabet alphabetALPHA\r\n"));
  await page.waitForFunction(() =>
    document.querySelector("#logContent")?.textContent.includes("alphabetALPHA"),
  );
  await page.locator("#keywordInput").fill("alpha");
  await page.waitForFunction(
    () => document.querySelectorAll("#logContent mark.log-keyword-highlight").length === 5,
  );
  await page.locator("#keywordConfigButton").click();
  await page.waitForFunction(() => document.querySelector("#filterConfigDialog").open);
  await page.locator("#keywordCaseSensitiveToggle").check({ force: true });
  await page.waitForFunction(
    () => document.querySelectorAll("#logContent mark.log-keyword-highlight").length === 3,
  );
  const keywordOptionSync = await page.evaluate(() =>
    [
      "#keywordConfigButton",
      "#networkKeywordConfigButton",
      "#terminalKeywordConfigButton",
    ].every((selector) => document.querySelector(selector)?.getAttribute("aria-pressed") === "true"),
  );
  if (!keywordOptionSync) {
    throw new Error("Filter settings did not sync across serial, network, and terminal.");
  }
  await page.locator("#keywordWholeWordToggle").check({ force: true });
  await page.waitForFunction(
    () => document.querySelectorAll("#logContent mark.log-keyword-highlight").length === 1,
  );
  await page.locator("#keywordWholeWordToggle").uncheck({ force: true });
  await page.locator("#keywordCaseSensitiveToggle").uncheck({ force: true });
  await page.locator("#confirmFilterConfigButton").click();
  await page.waitForFunction(() => !document.querySelector("#filterConfigDialog").open);
  await page.locator("#keywordInput").fill("");
  await page.waitForFunction(
    () =>
      document.querySelector("#keywordConfigButton")?.getAttribute("aria-pressed") === "false" &&
      !document.querySelector("#logContent mark.log-keyword-highlight"),
  );

  await page.evaluate(() => {
    for (let index = 0; index < 120; index += 1) {
      window.__serialMock.emit(`LINE ${String(index).padStart(3, "0")}\r\n`);
    }
  });
  await page.waitForTimeout(350);

  const scrollState = await page.evaluate(() => {
    const viewport = document.querySelector("#consoleViewport");
    const lineGroups = [...document.querySelectorAll(".log-entry")].filter((element) =>
      element.textContent.includes("LINE "),
    );
    return {
      clientHeight: viewport.clientHeight,
      scrollHeight: viewport.scrollHeight,
      documentHeight: document.documentElement.scrollHeight,
      windowHeight: window.innerHeight,
      lineGroupCount: lineGroups.length,
      blockCount: lineGroups.filter(
        (element) => !element.classList.contains("is-group-continuation"),
      ).length,
      directionLabelCount: lineGroups.filter(
        (element) => element.querySelector(".log-entry__direction")?.textContent.trim(),
      ).length,
      timestampCount: lineGroups.filter(
        (element) => element.querySelector(".log-entry__time")?.textContent?.trim(),
      ).length,
      visibleTimes: lineGroups
        .map((element) => element.querySelector(".log-entry__time")?.textContent?.trim())
        .filter(Boolean),
      firstMarginBottom: getComputedStyle(lineGroups[0]).marginBottom,
      secondMarginTop: getComputedStyle(lineGroups[1]).marginTop,
      firstDataWidth:
        lineGroups[0].querySelector(".log-entry__data")?.getBoundingClientRect().width || 0,
      firstLineText: lineGroups[0]?.querySelector(".log-entry__data")?.textContent || "",
      lastLineText:
        lineGroups.at(-1)?.querySelector(".log-entry__data")?.textContent || "",
    };
  });

  if (scrollState.lineGroupCount !== 120 || scrollState.blockCount > 1) {
    throw new Error(`Consecutive RX data was not merged into one color block: ${JSON.stringify(scrollState)}`);
  }
  if (scrollState.directionLabelCount > 1) {
    throw new Error(`The same RX block shows the direction label more than once: ${JSON.stringify(scrollState)}`);
  }
  if (
    !scrollState.firstLineText.includes("LINE 000") ||
    !scrollState.lastLineText.includes("LINE 119")
  ) {
    throw new Error(`Consecutive RX data is incomplete: ${JSON.stringify(scrollState)}`);
  }
  if (
    scrollState.timestampCount < 1 ||
    scrollState.visibleTimes.some(
      (time, index) => index > 0 && time === scrollState.visibleTimes[index - 1],
    )
  ) {
    throw new Error(`The same timestamp is displayed more than once: ${JSON.stringify(scrollState)}`);
  }
  if (scrollState.firstMarginBottom !== "0px" || scrollState.secondMarginTop !== "0px") {
    throw new Error(`Merged RX blocks still contain split gaps: ${JSON.stringify(scrollState)}`);
  }
  if (scrollState.firstDataWidth < 300) {
    throw new Error(`Merged RX data column width is abnormal: ${JSON.stringify(scrollState)}`);
  }
  if (scrollState.scrollHeight <= scrollState.clientHeight) {
    throw new Error(`Receive area did not become an internal scroll container: ${JSON.stringify(scrollState)}`);
  }
  if (scrollState.documentHeight > scrollState.windowHeight + 2) {
    throw new Error(`Receive data stretched the page: ${JSON.stringify(scrollState)}`);
  }

  await page.evaluate(() => {
    const viewport = document.querySelector("#consoleViewport");
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event("scroll"));
  });
  await page.waitForFunction(() => !document.querySelector("#followLatestButton").hidden);

  const followState = await page.evaluate(() => ({
    toggleChecked: document.querySelector("#autoScrollToggle").checked,
    returnButtonVisible: !document.querySelector("#followLatestButton").hidden,
  }));

  if (!followState.toggleChecked || !followState.returnButtonVisible) {
    throw new Error(`Manual scrolling wrongly cancelled follow mode: ${JSON.stringify(followState)}`);
  }

  await page.locator("#followLatestButton").click();
  await page.waitForFunction(() => document.querySelector("#followLatestButton").hidden);

  await page.evaluate(() =>
    window.__serialMock.emit("MULTI-HEADER\r\nMULTI-BODY\r\nMULTI-DONE\r\n"),
  );
  await page.waitForFunction(() =>
    ["MULTI-HEADER", "MULTI-BODY", "MULTI-DONE"].every((line) =>
      [...document.querySelectorAll(".log-entry")].some(
        (entry) => entry.querySelector(".log-entry__data")?.textContent.includes(line),
      ),
    ),
  );

  const multilineTimestampState = await page.evaluate(() => {
    const entries = [...document.querySelectorAll(".log-entry")].filter((entry) => {
      const text = entry.querySelector(".log-entry__data")?.textContent || "";
      return text.includes("MULTI-");
    });
    return {
      count: entries.length,
      blockCount: entries.filter(
        (entry) => !entry.classList.contains("is-group-continuation"),
      ).length,
      directionLabelCount: entries.filter(
        (entry) => entry.querySelector(".log-entry__direction")?.textContent.trim(),
      ).length,
      timestampCount: entries.filter(
        (entry) => entry.querySelector(".log-entry__time")?.textContent.trim(),
      ).length,
    };
  });

  if (multilineTimestampState.count !== 3) {
    throw new Error(`A multi-line batch was not split into separate timestamp blocks: ${JSON.stringify(multilineTimestampState)}`);
  }
  if (multilineTimestampState.blockCount > 1) {
    throw new Error(`A multi-line RX batch was not merged into one color block: ${JSON.stringify(multilineTimestampState)}`);
  }
  if (multilineTimestampState.directionLabelCount > 1) {
    throw new Error(`Direction or timestamp display is incorrect for a multi-line batch: ${JSON.stringify(multilineTimestampState)}`);
  }

  await page.locator('[data-console-view="terminal"]').click();
  await page.waitForFunction(() => !document.querySelector("#terminalViewport").hidden);
  await page.locator("#terminalMount").click();

  const writeCountBeforeTerminal = await page.evaluate(() => window.__serialMock.written.length);
  await page.keyboard.type("help");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (previousCount) => window.__serialMock.written.length > previousCount,
    writeCountBeforeTerminal,
  );

  const terminalWrites = await page.evaluate((previousCount) =>
    window.__serialMock.written.slice(previousCount).flat(),
  writeCountBeforeTerminal);

  if (terminalWrites.join(",") !== "104,101,108,112,13") {
    throw new Error(`Terminal keyboard input bytes are incorrect: ${terminalWrites.join(",")}`);
  }

  await page.evaluate(() =>
    window.__serialMock.emit(
      "help\r\nCommands: help, version, reset\r\n\u001b[32mOK\u001b[0m\r\n",
    ),
  );
  await page.waitForFunction(() =>
    document.querySelector(".xterm-rows")?.textContent.includes("Commands: help, version, reset"),
  );
  if (!(await page.locator("#terminalKeywordInput").isVisible())) {
    throw new Error("Terminal mode did not show the keyword search control.");
  }
  await page.locator("#terminalKeywordInput").click();
  await page.waitForTimeout(300);
  const terminalKeywordFocus = await page.evaluate(() => ({
    activeId: document.activeElement?.id,
    terminalFocused: document.querySelector(".xterm-helper-textarea") === document.activeElement,
  }));
  if (terminalKeywordFocus.activeId !== "terminalKeywordInput") {
    throw new Error(`Terminal keyword input could not keep focus: ${JSON.stringify(terminalKeywordFocus)}`);
  }
  await page.keyboard.type("help");
  await page.waitForFunction(
    () => Number(document.querySelector("#terminalKeywordNextButton").dataset.resultCount || 0) > 0,
  );
  const terminalSearchState = await page.evaluate(() => ({
    resultCount: Number(document.querySelector("#terminalKeywordNextButton").dataset.resultCount || 0),
    previousDisabled: document.querySelector("#terminalKeywordPreviousButton").disabled,
    nextDisabled: document.querySelector("#terminalKeywordNextButton").disabled,
  }));
  if (
    terminalSearchState.resultCount < 1 ||
    terminalSearchState.previousDisabled ||
    terminalSearchState.nextDisabled
  ) {
    throw new Error(`Terminal keyword search found no match: ${JSON.stringify(terminalSearchState)}`);
  }
  await page.locator("#terminalKeywordInput").fill("");
  await page.waitForFunction(
    () => document.querySelector("#terminalKeywordNextButton").dataset.resultCount === "0",
  );

  await showSerialControlGroup(page, "automation");
  await page.locator("#macroRecordButton").click();
  await page.waitForFunction(() =>
    document.querySelector("#macroRecordState").textContent.includes("终端录制中"),
  );
  await page.locator("#terminalMount").click();
  await page.keyboard.type("version");
  await page.keyboard.press("Enter");
  await page.keyboard.type("reset");
  await page.keyboard.press("Enter");
  if (await page.locator("#sendPanel").evaluate((element) => element.classList.contains("is-collapsed"))) {
    await page.locator("#toggleSendPanelButton").click();
    await page.waitForFunction(() => !document.querySelector("#sendPanel").classList.contains("is-collapsed"));
  }
  await page.locator('[data-send-mode="text"]').click();
  await page.locator("#sendInput").fill("PANEL");
  const writeCountBeforeTerminalSendPanel = await page.evaluate(
    () => window.__serialMock.written.length,
  );
  await page.locator("#sendButton").click();
  await page.waitForFunction(
    (previousCount) => window.__serialMock.written.length > previousCount,
    writeCountBeforeTerminalSendPanel,
  );
  await page.locator("#macroRecordButton").click();
  await page.waitForFunction(() => document.querySelectorAll(".macro-item").length === 1);

  await page.locator('.macro-item [data-macro-action="edit"]').click();
  await page.waitForFunction(() => document.querySelector("#macroEditorDialog").open);
  await page.waitForFunction(
    () => document.querySelector("#macroStepCount")?.textContent === "15 个步骤",
  );
  const macroStepPreviews = await page.locator(".macro-step__preview").allTextContents();
  if (macroStepPreviews.filter((preview) => preview === "RETURN").length !== 2) {
    throw new Error(`Terminal macro did not record RETURN as its own step: ${macroStepPreviews.join(",")}`);
  }
  if (macroStepPreviews.at(-1) !== "50 41 4E 45 4C 0D 0A") {
    throw new Error(`Terminal macro did not record the send-area content: ${macroStepPreviews.at(-1)}`);
  }
  await page.locator("#macroCommandDelayInput").fill("20");
  await page.locator("#macroCharacterDelayInput").fill("1");
  await page.screenshot({
    path: join(artifacts, "serial-workbench-macro-editor.png"),
    fullPage: true,
  });
  await page.locator("#macroEditorSaveButton").click();
  await page.waitForFunction(() => !document.querySelector("#macroEditorDialog").open);

  const macroMeta = await page.locator(".macro-item__text span").first().textContent();
  if (!macroMeta.includes("命令 20 ms") || !macroMeta.includes("字符 1 ms")) {
    throw new Error(`Macro interval settings were not saved: ${macroMeta}`);
  }

  const writeCountBeforeMacroPlayback = await page.evaluate(() => window.__serialMock.written.length);
  await page.locator('.macro-item [data-macro-action="play"]').click();
  await page.waitForFunction(
    () => document.querySelector("#macroRecordState").textContent === "待机",
  );
  const macroPlaybackBytes = await page.evaluate(
    (previousCount) => window.__serialMock.written.slice(previousCount).flat(),
    writeCountBeforeMacroPlayback,
  );
  if (
    macroPlaybackBytes.join(",") !==
    "118,101,114,115,105,111,110,13,114,101,115,101,116,13,80,65,78,69,76,13,10"
  ) {
    throw new Error(`Macro playback bytes are incorrect: ${macroPlaybackBytes.join(",")}`);
  }

  await page.screenshot({
    path: join(artifacts, "serial-workbench-terminal.png"),
    fullPage: true,
  });

  await page.locator('[data-console-view="log"]').click();
  await page.waitForFunction(() => document.querySelector("#terminalViewport").hidden);

  await page.locator('[data-send-mode="text"]').click();
  if (await page.locator("#sendPanel").evaluate((element) => element.classList.contains("is-collapsed"))) {
    await page.locator("#toggleSendPanelButton").click();
    await page.waitForFunction(() => !document.querySelector("#sendPanel").classList.contains("is-collapsed"));
  }
  await page.locator("#macroRecordButton").click();
  await page.waitForFunction(() =>
    document.querySelector("#macroRecordState").textContent.includes("日志录制中"),
  );
  await page.locator("#sendInput").fill("MACRO-LOG");
  const writeCountBeforeLogMacroRecord = await page.evaluate(
    () => window.__serialMock.written.length,
  );
  await page.locator("#sendButton").click();
  await page.waitForFunction(
    (previousCount) => window.__serialMock.written.length > previousCount,
    writeCountBeforeLogMacroRecord,
  );
  await page.locator("#macroRecordButton").click();
  await page.waitForFunction(() => document.querySelectorAll(".macro-item").length === 2);

  const writeCountBeforeLogMacroPlayback = await page.evaluate(
    () => window.__serialMock.written.length,
  );
  await page.locator('.macro-item [data-macro-action="play"]').first().click();
  await page.waitForFunction((previousCount) => {
    const bytes = window.__serialMock.written.slice(previousCount).flat();
    return bytes.join(",") === "77,65,67,82,79,45,76,79,71,13,10";
  }, writeCountBeforeLogMacroPlayback);

  const macroAgentSessionId = await page.evaluate(() =>
    sessionStorage.getItem("linktk.agent.session-id"),
  );
  if (!macroAgentSessionId) {
    throw new Error("Macro page has no usable AI sessionId.");
  }
  const agentMacroSteps = [{ type: "text", data: "ARN\r" }];
  const macroCreateResult = await runAgentCli([
    "macro-create",
    "--session",
    macroAgentSessionId,
    "--name",
    "AI-MACRO",
    "--steps",
    JSON.stringify(agentMacroSteps),
  ]);
  if (!macroCreateResult.stdout.includes("AI-MACRO")) {
    throw new Error(`Agent CLI did not create the macro: ${macroCreateResult.stdout}`);
  }
  const writeCountBeforeAgentMacro = await page.evaluate(
    () => window.__serialMock.written.length,
  );
  const macroRunResult = await runAgentCli([
    "macro-run",
    "--session",
    macroAgentSessionId,
    "--name",
    "AI-MACRO",
  ]);
  if (!macroRunResult.stdout.includes('"completed": true')) {
    throw new Error(`Agent CLI did not finish macro playback: ${macroRunResult.stdout}`);
  }
  const agentMacroBytes = await page.evaluate(
    (previousCount) =>
      window.__serialMock.written.slice(previousCount).flat(),
    writeCountBeforeAgentMacro,
  );
  if (agentMacroBytes.join(",") !== "65,82,78,13") {
    throw new Error(`Agent CLI Macro playback bytes are incorrect: ${agentMacroBytes.join(",")}`);
  }

  const ymodemPayload = new Uint8Array(4097);
  for (let index = 0; index < ymodemPayload.length; index += 1) {
    ymodemPayload[index] = (index * 19 + 7) & 0xff;
  }

  await showSerialControlGroup(page, "transfer");
  await page.locator('[data-ymodem-mode="send"]').click();
  await page.locator("#ymodemFileInput").setInputFiles({
    name: "firmware.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(ymodemPayload),
  });
  await page.locator("#ymodemSendButton").click();
  await page.waitForFunction(() => document.querySelector("#ymodemStateBadge").textContent === "传输中");

  remoteYmodemReceiver = new YmodemSession({
    write: async (bytes) => {
      await page.evaluate((values) => window.__serialMock.emitBytes(values), [...bytes]);
      return true;
    },
  });
  const receivedYmodemFile = await remoteYmodemReceiver.receive();
  remoteYmodemReceiver = null;

  if (
    receivedYmodemFile.filename !== "firmware.bin" ||
    receivedYmodemFile.size !== ymodemPayload.byteLength ||
    receivedYmodemFile.data.some((byte, index) => byte !== ymodemPayload[index])
  ) {
    throw new Error(`Browser YMODEM send path verification failed: ${JSON.stringify({
      filename: receivedYmodemFile.filename,
      size: receivedYmodemFile.size,
    })}`);
  }
  await page.waitForFunction(() => document.querySelector("#ymodemStateBadge").textContent === "已完成");

  const agentYmodemPayload = new Uint8Array(1537);
  for (let index = 0; index < agentYmodemPayload.length; index += 1) {
    agentYmodemPayload[index] = (index * 11 + 3) & 0xff;
  }
  const agentYmodemPath = join(artifacts, "agent-ymodem-send.bin");
  writeFileSync(agentYmodemPath, Buffer.from(agentYmodemPayload));
  const serialAgentSessionId = await page.evaluate(() =>
    sessionStorage.getItem("linktk.agent.session-id"),
  );
  if (!serialAgentSessionId) {
    throw new Error("Serial page has no usable AI sessionId.");
  }
  remoteYmodemReceiver = new YmodemSession({
    write: async (bytes) => {
      await page.evaluate((values) => window.__serialMock.emitBytes(values), [...bytes]);
      return true;
    },
  });
  const agentYmodemPromise = runAgentCli([
    "ymodem-send",
    "--session",
    serialAgentSessionId,
    "--file",
    agentYmodemPath,
    "--name",
    "agent-firmware.bin",
    "--block-size",
    "128",
  ]);
  const receivedAgentYmodemFile = await remoteYmodemReceiver.receive();
  remoteYmodemReceiver = null;
  await agentYmodemPromise;
  if (
    receivedAgentYmodemFile.filename !== "agent-firmware.bin" ||
    receivedAgentYmodemFile.size !== agentYmodemPayload.byteLength ||
    receivedAgentYmodemFile.data.some((byte, index) => byte !== agentYmodemPayload[index])
  ) {
    throw new Error(`Agent CLI YMODEM send path verification failed: ${JSON.stringify({
      filename: receivedAgentYmodemFile.filename,
      size: receivedAgentYmodemFile.size,
    })}`);
  }

  if (await page.locator("#sendPanel").evaluate((element) => element.classList.contains("is-collapsed"))) {
    await page.locator("#toggleSendPanelButton").click();
    await page.waitForFunction(() => !document.querySelector("#sendPanel").classList.contains("is-collapsed"));
  }

  const receiveHeightBeforeCollapse = await page.locator("#consoleViewport").evaluate((element) => element.clientHeight);
  await page.locator("#toggleSendPanelButton").click();
  await page.waitForFunction(() => document.querySelector("#sendPanel").classList.contains("is-collapsed"));
  const receiveHeightAfterCollapse = await page.locator("#consoleViewport").evaluate((element) => element.clientHeight);

  if (receiveHeightAfterCollapse <= receiveHeightBeforeCollapse + 40) {
    throw new Error(
      `Receive area did not visibly grow after collapsing the send area: ${receiveHeightBeforeCollapse} -> ${receiveHeightAfterCollapse}`,
    );
  }

  await page.screenshot({
    path: join(artifacts, "serial-workbench-desktop.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayoutOrder = await page.evaluate(() => {
    const monitor = document.querySelector(".console-area").getBoundingClientRect();
    const controls = document.querySelector(".control-panel").getBoundingClientRect();
    const toolbarText = [...document.querySelectorAll(".toolbar-group button, .toolbar-group label")]
      .map((element) => getComputedStyle(element).whiteSpace);
    return {
      monitorTop: monitor.top,
      controlsTop: controls.top,
      toolbarWraps: toolbarText.some((value) => value !== "nowrap"),
    };
  });
  if (
    mobileLayoutOrder.monitorTop >= mobileLayoutOrder.controlsTop ||
    mobileLayoutOrder.toolbarWraps
  ) {
    throw new Error(`Mobile monitor order or toolbar wrapping does not match expectations: ${JSON.stringify(mobileLayoutOrder)}`);
  }
  const mobileStatusLabels = await page.evaluate(() =>
    ["agentState", "headerStatus", "networkHeaderStatus"].map((id) => {
      const element = document.getElementById(id);
      return getComputedStyle(element, "::after").content.replaceAll('"', "");
    }),
  );
  if (mobileStatusLabels.join(",") !== "AI,串,网") {
    throw new Error(`Mobile status-dot short labels are incorrect: ${mobileStatusLabels.join(",")}`);
  }
  await page.evaluate(() => {
    ["agentState", "headerStatus", "networkHeaderStatus"].forEach((id) => {
      document.getElementById(id)?.click();
    });
  });
  await page.waitForFunction(() => {
    const visibleToasts = document.querySelectorAll(
      "#toastRegion .toast:not(.toast--more)",
    );
    const overflowToast = document.querySelector("#toastRegion .toast--more");
    return (
      visibleToasts.length === 1 &&
      String(overflowToast?.textContent || "").includes("还有")
    );
  });
  await page.screenshot({
    path: join(artifacts, "serial-workbench-mobile.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });

  await waitForValue(page, "#agentStateText", "AI 就绪");
  const agentReadyStyle = await page.evaluate(() => {
    const state = document.querySelector("#agentState");
    const lamp = state?.querySelector(".status-pill__lamp");
    return {
      state: state?.dataset.state || "",
      lampColor: lamp ? getComputedStyle(lamp).backgroundColor : "",
      lampShadow: lamp ? getComputedStyle(lamp).boxShadow : "",
    };
  });
  if (
    agentReadyStyle.state !== "ready" ||
    agentReadyStyle.lampColor !== "rgb(157, 187, 78)" ||
    agentReadyStyle.lampShadow === "none"
  ) {
    throw new Error(`AI ready state did not show the green indicator: ${JSON.stringify(agentReadyStyle)}`);
  }
  // Non-ASCII on purpose: this exercises UTF-8 sequences split across serial chunks.
  const splitUnicodeText = "周报.md";
  const splitUnicodeBytes = [
    ...new TextEncoder().encode(splitUnicodeText),
  ];
  const splitUnicodeBaselineCli = await runAgentCli(["read", "--limit", "1"]);
  const splitUnicodeBaselineOutput = JSON.parse(splitUnicodeBaselineCli.stdout);
  const splitUnicodeSince = Number(splitUnicodeBaselineOutput.result?.cursor);
  if (!splitUnicodeBaselineOutput.ok || !Number.isFinite(splitUnicodeSince)) {
    throw new Error(`Could not get the baseline cursor for the split UTF-8 test: ${splitUnicodeBaselineCli.stdout}`);
  }
  const splitUnicodeWait = runAgentCli([
    "wait",
    "--since",
    String(splitUnicodeSince),
    "--expect",
    splitUnicodeText,
    "--timeout",
    "5000",
  ]);
  await page.waitForTimeout(150);
  await page.evaluate(
    (bytes) => window.__serialMock.emitBytes([bytes[0]]),
    splitUnicodeBytes,
  );
  await page.waitForTimeout(60);
  await page.evaluate(
    (bytes) => window.__serialMock.emitBytes(bytes.slice(1)),
    splitUnicodeBytes,
  );
  const splitUnicodeOutput = JSON.parse((await splitUnicodeWait).stdout);
  if (
    !splitUnicodeOutput.ok ||
    !splitUnicodeOutput.result?.matched ||
    splitUnicodeOutput.result.text?.includes("\uFFFD") ||
    !splitUnicodeOutput.result.text?.includes(splitUnicodeText) ||
    splitUnicodeOutput.result.events?.some((event) => event.text?.includes("\uFFFD"))
  ) {
    throw new Error(`Split UTF-8 text decoding or matching failed: ${JSON.stringify(splitUnicodeOutput)}`);
  }

  const agentProbeWriteCount = await page.evaluate(() => window.__serialMock.written.length);
  const agentProbePromise = runAgentCli([
    "exec",
    "--text",
    "agent-probe",
    "--expect",
    "AGENT_OK",
    "--timeout",
    "5000",
  ]);
  await page.waitForFunction(
    (previousCount) =>
      window.__serialMock.written
        .slice(previousCount)
        .some((bytes) => new TextDecoder().decode(Uint8Array.from(bytes)).includes("agent-probe")),
    agentProbeWriteCount,
    { timeout: 5000 },
  );
  await page.evaluate(() => window.__serialMock.emit("AGENT_OK\r\n"));
  const agentProbeCli = await agentProbePromise;
  const agentProbeOutput = JSON.parse(agentProbeCli.stdout);
  if (
    !agentProbeOutput.ok ||
    !agentProbeOutput.result?.matched ||
    !agentProbeOutput.result.text.includes("AGENT_OK")
  ) {
    throw new Error(`Agent CLI serial round-trip failed: ${agentProbeCli.stdout}`);
  }
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#logContent .log-entry.is-agent")].some((entry) =>
      entry.querySelector(".log-entry__data")?.textContent.includes("agent-probe"),
    ),
  );
  const agentLogState = await page.evaluate(() => {
    const entry = [...document.querySelectorAll("#logContent .log-entry.is-agent")].find((item) =>
      item.querySelector(".log-entry__data")?.textContent.includes("agent-probe"),
    );
    return {
      direction: entry?.querySelector(".log-entry__direction")?.textContent || "",
      borderColor: entry ? getComputedStyle(entry).borderLeftColor : "",
    };
  });
  if (agentLogState.direction !== "AI" || agentLogState.borderColor === "rgba(0, 0, 0, 0)") {
    throw new Error(`AI send log entry has no distinct styling: ${JSON.stringify(agentLogState)}`);
  }

  const agentStatusCli = await runAgentCli(["status"]);
  const agentStatusOutput = JSON.parse(agentStatusCli.stdout);
  const agentSessionId = agentStatusOutput.result?.session?.id || "";
  if (!agentSessionId) {
    throw new Error(`Agent CLI status is missing the session ID: ${agentStatusCli.stdout}`);
  }
  const unreadBeforeOpen = await page.evaluate(() => {
    const badge = document.querySelector("#agentActivityCount");
    return {
      hidden: Boolean(badge?.hidden),
      count: Number(badge?.textContent || 0),
    };
  });
  if (unreadBeforeOpen.hidden || unreadBeforeOpen.count < 1) {
    throw new Error(`AI record button did not show the unread operation count: ${JSON.stringify(unreadBeforeOpen)}`);
  }
  await page.locator("#agentActivityButton").click();
  await page.waitForFunction(() => document.querySelector("#agentActivityDialog")?.open);
  await page.waitForFunction(() => document.querySelector("#agentActivityCount")?.hidden);
  const agentActivityLayout = await page.evaluate(() => {
    const dialog = document.querySelector("#agentActivityDialog");
    const monitor = document.querySelector("#receivePanel");
    const list = document.querySelector("#agentActivityList");
    const recordsPanel = document.querySelector("#agentActivityRecordsPanel");
    return {
      modal: dialog.matches(":modal"),
      monitorVisible: Boolean(monitor && monitor.getClientRects().length),
      listVisible: Boolean(list && list.getClientRects().length),
      recordsHeight: recordsPanel?.getBoundingClientRect().height || 0,
    };
  });
  if (
    agentActivityLayout.modal ||
    !agentActivityLayout.monitorVisible ||
    !agentActivityLayout.listVisible ||
    agentActivityLayout.recordsHeight < 360
  ) {
    throw new Error(`AI activity did not open as a non-modal, side-by-side long panel: ${JSON.stringify(agentActivityLayout)}`);
  }
  const agentActivityScroll = await page.evaluate(() => {
    const list = document.querySelector("#agentActivityList");
    const dummies = Array.from({ length: 80 }, (_, index) => {
      const item = document.createElement("div");
      item.className = "agent-activity-item";
      item.style.minHeight = "82px";
      item.textContent = `history record ${index}`;
      return item;
    });
    list.append(...dummies);
    const canOverflow = list.scrollHeight > list.clientHeight + 20;
    list.scrollTop = list.scrollHeight;
    const scrolled = list.scrollTop > 0;
    const result = {
      canOverflow,
      scrolled,
      clientHeight: list.clientHeight,
      scrollHeight: list.scrollHeight,
      scrollTop: list.scrollTop,
    };
    dummies.forEach((item) => item.remove());
    return result;
  });
  if (!agentActivityScroll.canOverflow || !agentActivityScroll.scrolled) {
    throw new Error(`AI activity list does not scroll vertically: ${JSON.stringify(agentActivityScroll)}`);
  }
  const firstActivity = page.locator("#agentActivityList .agent-activity-item").first();
  if ((await firstActivity.locator(":scope > .agent-activity-item__main > span").count()) !== 0) {
    throw new Error("AI activity cards still show a duplicated parameter summary.");
  }
  const firstActivitySummary = firstActivity
    .locator(".agent-activity-item__details summary")
    .first();
  await firstActivitySummary.click();
  await page.waitForFunction(() =>
    document.querySelector("#agentActivityList details")?.open,
  );
  await page.waitForTimeout(650);
  if (!(await firstActivity.locator("details").first().evaluate((element) => element.open))) {
    throw new Error("After expanding operation parameters, a list refresh collapsed the details again.");
  }
  await firstActivitySummary.click();
  await page.waitForFunction(() =>
    !document.querySelector("#agentActivityList details")?.open,
  );
  const activitySessionId = await page.locator("#agentSessionIdText").textContent();
  const activitySessionIdTitle = await page.locator("#agentSessionIdText").getAttribute("title");
  if (
    !activitySessionId?.includes(agentSessionId.slice(-8)) ||
    activitySessionIdTitle !== agentSessionId
  ) {
    throw new Error(`AI activity panel shows an incorrect session ID: ${activitySessionId}`);
  }
  await page.locator("#agentActivityControlTab").click();
  await page.waitForFunction(() => !document.querySelector("#agentActivityControlPanel")?.hidden);
  await page.locator("#agentCopyMcpConfigButton").click();
  await page.waitForFunction(() => window.__copiedText.includes('"mcpServers"'));
  const copiedMcpConfig = await page.evaluate(() => JSON.parse(window.__copiedText));
  const copiedLinkTkServer = copiedMcpConfig?.mcpServers?.linktk;
  if (
    copiedLinkTkServer?.command !== process.execPath ||
    !/[\\/]tools[\\/]linktk-mcp\.mjs$/.test(copiedLinkTkServer?.args?.[0] || "") ||
    !copiedLinkTkServer?.env?.LINKTK_AGENT_URL?.endsWith("/__agent-control")
  ) {
    throw new Error(`One-click-copied MCP config is incomplete: ${JSON.stringify(copiedMcpConfig)}`);
  }
  await page.locator("#agentApprovalMode").selectOption("confirm-writes");

  const approvedWriteCount = await page.evaluate(() => window.__serialMock.written.length);
  const approvedSendPromise = runAgentCli([
    "send",
    "--text",
    "approval-probe",
    "--ending",
    "lf",
  ]);
  await page.waitForFunction(() => document.querySelector("#agentApprovalDialog")?.open);
  const approvalCommand = await page.locator("#agentApprovalCommand").textContent();
  if (!approvalCommand?.includes("串口发送")) {
    throw new Error(`AI approval dialog did not show the correct operation: ${approvalCommand}`);
  }
  await page.locator("#agentApprovalAllowButton").click();
  const approvedSendResult = JSON.parse((await approvedSendPromise).stdout);
  if (!approvedSendResult.ok) {
    throw new Error(`AI send still failed after a one-time approval: ${approvedSendResult.error}`);
  }
  await page.waitForFunction(
    (previousCount) =>
      window.__serialMock.written
        .slice(previousCount)
        .some((bytes) => new TextDecoder().decode(Uint8Array.from(bytes)).includes("approval-probe")),
    approvedWriteCount,
  );

  const deniedWriteCount = await page.evaluate(() => window.__serialMock.written.length);
  const deniedSendPromise = runAgentCli([
    "send",
    "--text",
    "denied-probe",
    "--ending",
    "lf",
  ]).catch((error) => error);
  await page.waitForFunction(() => document.querySelector("#agentApprovalDialog")?.open);
  await page.locator("#agentApprovalDenyButton").click();
  const deniedSendResult = await deniedSendPromise;
  if (!(deniedSendResult instanceof Error) || !deniedSendResult.message.includes("用户拒绝")) {
    throw new Error(`Denying an AI write operation did not return a clear error: ${deniedSendResult?.message || "unknown result"}`);
  }
  if ((await page.evaluate(() => window.__serialMock.written.length)) !== deniedWriteCount) {
    throw new Error("The serial port was still written after denying the AI write operation.");
  }

  const withdrawnWriteCount = await page.evaluate(() => window.__serialMock.written.length);
  const timedOutSendPromise = runAgentCli([
    "send",
    "--text",
    "late-approval-probe",
    "--ending",
    "lf",
    "--timeout",
    "1",
  ], { timeoutMs: 12000 }).catch((error) => error);
  await page.waitForFunction(() => document.querySelector("#agentApprovalDialog")?.open);
  const timedOutSendResult = await timedOutSendPromise;
  if (
    !(timedOutSendResult instanceof Error) ||
    !timedOutSendResult.message.includes("timed out")
  ) {
    throw new Error(`AI timeout did not produce a failure result: ${timedOutSendResult?.message || "unknown result"}`);
  }
  await page.waitForFunction(
    () => !document.querySelector("#agentApprovalDialog")?.open,
    null,
    { timeout: 5000 },
  );
  await page.evaluate(() => document.querySelector("#agentApprovalAllowButton")?.click());
  await page.waitForTimeout(300);
  if ((await page.evaluate(() => window.__serialMock.written.length)) !== withdrawnWriteCount) {
    throw new Error("A withdrawn AI operation still wrote to the serial port after a late approval.");
  }
  const withdrawnSnapshotCli = await runAgentCli(["snapshot"]);
  const withdrawnAgentSnapshot = JSON.parse(withdrawnSnapshotCli.stdout).result?.agent;
  if (
    !withdrawnAgentSnapshot ||
    withdrawnAgentSnapshot.commandActive ||
    withdrawnAgentSnapshot.activeOperationId ||
    withdrawnAgentSnapshot.pendingApproval
  ) {
    throw new Error(`AI write lock or approval state was not released after withdrawal: ${withdrawnSnapshotCli.stdout}`);
  }
  const withdrawnOperationsCli = await runAgentCli([
    "operations",
    "--session",
    agentSessionId,
    "--limit",
    "10",
  ]);
  const withdrawnOperation = JSON.parse(withdrawnOperationsCli.stdout).result?.operations?.find(
    (operation) =>
      operation.command === "send" &&
      operation.paramsSummary?.includes("late-approval-probe"),
  );
  if (
    withdrawnOperation?.status !== "withdrawn" ||
    withdrawnOperation.errorCode !== "approval-timeout"
  ) {
    throw new Error(`Timed-out operation was not recorded as withdrawn: ${withdrawnOperationsCli.stdout}`);
  }

  const cancelledWriteCount = await page.evaluate(() => window.__serialMock.written.length);
  const cancelWhileWaitingPromise = runAgentCli([
    "send",
    "--text",
    "cancel-approval-probe",
    "--ending",
    "lf",
    "--timeout",
    "30",
  ], { timeoutMs: 20000 }).catch((error) => error);
  await page.waitForFunction(() => document.querySelector("#agentApprovalDialog")?.open);
  const waitingOperationsCli = await runAgentCli(["operations", "--limit", "5"]);
  const waitingOperation = JSON.parse(waitingOperationsCli.stdout).result?.operations?.find(
    (operation) => operation.status === "waiting_approval",
  );
  if (!waitingOperation?.operationId) {
    throw new Error(`No AI operation waiting for approval was found: ${waitingOperationsCli.stdout}`);
  }
  await runAgentCli(["operation-cancel", "--id", waitingOperation.operationId]);
  const cancelWhileWaitingResult = await cancelWhileWaitingPromise;
  if (
    !(cancelWhileWaitingResult instanceof Error) ||
    !cancelWhileWaitingResult.message.includes("取消")
  ) {
    throw new Error(`Cancelling a pending-approval operation from the controller did not return a cancelled result: ${cancelWhileWaitingResult?.message || "unknown result"}`);
  }
  if ((await page.evaluate(() => window.__serialMock.written.length)) !== cancelledWriteCount) {
    throw new Error("The serial port was still written after cancelling the pending approval.");
  }
  const cancelledOperationsCli = await runAgentCli(["operations", "--limit", "5"]);
  const cancelledOperation = JSON.parse(cancelledOperationsCli.stdout).result?.operations?.find(
    (operation) => operation.operationId === waitingOperation.operationId,
  );
  if (
    cancelledOperation?.status !== "cancelled" ||
    cancelledOperation.error?.includes("用户拒绝")
  ) {
    throw new Error(`A cancelled pending approval was wrongly recorded as denied: ${cancelledOperationsCli.stdout}`);
  }

  await page.locator("#agentApprovalMode").selectOption("trusted");
  await page.locator("#agentPauseButton").click();
  await page.waitForFunction(() => document.querySelector("#agentStateText")?.textContent === "AI 已暂停");
  const pausedSendResult = await runAgentCli([
    "send",
    "--text",
    "paused-probe",
    "--ending",
    "lf",
  ]).catch((error) => error);
  if (!(pausedSendResult instanceof Error) || !pausedSendResult.message.includes("暂停")) {
    throw new Error(`Write operation was not blocked after pausing the AI: ${pausedSendResult?.message || "unknown result"}`);
  }
  await page.locator("#agentPauseButton").click();
  await page.waitForFunction(
    () => document.querySelector("#agentStateText")?.textContent === "AI 就绪",
  );
  const operationStartCli = await runAgentCli([
    "operation-start",
    "--command",
    "wait",
    "--params",
    JSON.stringify({ expect: "OPERATION_NEVER", timeoutMs: 20000 }),
  ]);
  const operationStartOutput = JSON.parse(operationStartCli.stdout);
  const operationId =
    operationStartOutput.result?.operationId ||
    operationStartOutput.result?.operation?.operationId;
  if (!operationId) {
    throw new Error(`Background operation did not return an operationId: ${operationStartCli.stdout}`);
  }
  const runningOperationCli = await runAgentCli([
    "operation-status",
    "--id",
    operationId,
  ]);
  const runningOperationOutput = JSON.parse(runningOperationCli.stdout);
  if (!["queued", "running"].includes(runningOperationOutput.result?.status)) {
    throw new Error(`Background operation status is incorrect: ${runningOperationCli.stdout}`);
  }

  const concurrentWriteCount = await page.evaluate(() => window.__serialMock.written.length);
  const concurrentWriteCli = await runAgentCli([
    "send",
    "--session",
    agentSessionId,
    "--text",
    "WHILE-READ-OPERATION",
    "--ending",
    "lf",
  ]);
  if (!JSON.parse(concurrentWriteCli.stdout).ok) {
    throw new Error(`A read-only background operation blocked a write operation: ${concurrentWriteCli.stdout}`);
  }
  await page.waitForFunction(
    (previousCount) =>
      window.__serialMock.written
        .slice(previousCount)
        .some((bytes) =>
          new TextDecoder().decode(Uint8Array.from(bytes)).includes("WHILE-READ-OPERATION"),
        ),
    concurrentWriteCount,
  );

  await runAgentCli(["operation-cancel", "--id", operationId]);
  let cancelledOperationStatus = "";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const statusCli = await runAgentCli(["operation-status", "--id", operationId]);
    cancelledOperationStatus = JSON.parse(statusCli.stdout).result?.status || "";
    if (cancelledOperationStatus === "cancelled") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (cancelledOperationStatus !== "cancelled") {
    throw new Error(`Background operation did not enter the cancelled state: ${cancelledOperationStatus}`);
  }

  const writeOperationStartCli = await runAgentCli([
    "operation-start",
    "--command",
    "exec",
    "--params",
    JSON.stringify({
      data: "CONCURRENT-WRITE-OPERATION",
      pattern: "WRITE_OPERATION_NEVER",
      ending: "lf",
      timeoutMs: 20000,
    }),
  ]);
  const writeOperationOutput = JSON.parse(writeOperationStartCli.stdout);
  const writeOperationId =
    writeOperationOutput.result?.operationId ||
    writeOperationOutput.result?.operation?.operationId;
  if (!writeOperationId) {
    throw new Error(`Write operation did not return an operationId: ${writeOperationStartCli.stdout}`);
  }
  const concurrentReadCli = await runAgentCli([
    "read",
    "--session",
    agentSessionId,
    "--limit",
    "1",
  ]);
  if (!JSON.parse(concurrentReadCli.stdout).ok) {
    throw new Error(`Write operation blocked read-only observation: ${concurrentReadCli.stdout}`);
  }
  await runAgentCli(["operation-cancel", "--id", writeOperationId]);

  const activityText = await page.locator("#agentActivityList").textContent();
  if (!activityText?.includes("串口发送")) {
    throw new Error(`AI activity panel did not record the operation: ${activityText}`);
  }

  const profileUpsertCli = await runAgentCli([
    "device-profile-upsert",
    "--session",
    agentSessionId,
    "--name",
    "Smoke RTOS",
    "--board",
    "Smoke Board",
    "--transport",
    "serial",
    "--shell-type",
    "rtos",
    "--line-ending",
    "crlf",
    "--dangerous-patterns",
    JSON.stringify(["rm -rf"]),
  ]);
  const profileUpsertOutput = JSON.parse(profileUpsertCli.stdout);
  if (!profileUpsertOutput.ok || profileUpsertOutput.result?.profile?.name !== "Smoke RTOS") {
    throw new Error(`Device profile save failed: ${profileUpsertCli.stdout}`);
  }
  const profileSelectCli = await runAgentCli([
    "device-profile-select",
    "--session",
    agentSessionId,
    "--name",
    "Smoke RTOS",
  ]);
  if (!JSON.parse(profileSelectCli.stdout).ok) {
    throw new Error(`Device profile selection failed: ${profileSelectCli.stdout}`);
  }
  await page.waitForFunction(
    () => document.querySelector("#agentDeviceProfileName")?.textContent === "Smoke RTOS",
  );
  const profileWriteCount = await page.evaluate(() => window.__serialMock.written.length);
  await runAgentCli([
    "send",
    "--session",
    agentSessionId,
    "--text",
    "PROFILE-LINE",
  ]);
  const profileWrite = await page.waitForFunction(
    (previousCount) => {
      const added = window.__serialMock.written.slice(previousCount);
      return added.some((bytes) => new TextDecoder().decode(Uint8Array.from(bytes)).includes("PROFILE-LINE\r\n"));
    },
    profileWriteCount,
  ).then(() => true).catch(() => false);
  if (!profileWrite) {
    throw new Error("Device profile CRLF line ending was not applied to serial sends.");
  }

  const taskSteps = [
    {
      label: "Smoke task send",
      command: "send",
      params: { data: "TASK-PLAY", ending: "lf" },
    },
  ];
  const taskCreateCli = await runAgentCli([
    "task-create",
    "--session",
    agentSessionId,
    "--name",
    "Smoke Task",
    "--steps",
    JSON.stringify(taskSteps),
    "--allow-partial",
    "--allow-irreversible",
  ]);
  const taskCreateOutput = JSON.parse(taskCreateCli.stdout);
  if (!taskCreateOutput.ok || taskCreateOutput.result?.template?.name !== "Smoke Task") {
    throw new Error(`Task template save failed: ${taskCreateCli.stdout}`);
  }
  const taskWriteCount = await page.evaluate(() => window.__serialMock.written.length);
  const taskRunCli = await runAgentCli([
    "task-run",
    "--session",
    agentSessionId,
    "--name",
    "Smoke Task",
  ]);
  const taskRunOutput = JSON.parse(taskRunCli.stdout);
  if (!taskRunOutput.ok || taskRunOutput.result?.transaction?.status !== "succeeded") {
    throw new Error(`Task template playback failed: ${taskRunCli.stdout}`);
  }
  await page.waitForFunction(
    (previousCount) =>
      window.__serialMock.written
        .slice(previousCount)
        .some((bytes) => new TextDecoder().decode(Uint8Array.from(bytes)).includes("TASK-PLAY")),
    taskWriteCount,
  );
  const taskCountText = await page.locator("#agentTaskCount").textContent();
  if (!taskCountText?.includes("1 个任务模板")) {
    throw new Error(`AI activity panel did not show the task template count: ${taskCountText}`);
  }

  const operationListCli = await runAgentCli([
    "operations",
    "--session",
    agentSessionId,
    "--limit",
    "10",
  ]);
  const taskOperation = JSON.parse(operationListCli.stdout).result?.operations?.find(
    (item) => item.command === "task_run",
  );
  if (!taskOperation?.operationId) {
    throw new Error(`No operation record found for the task playback: ${operationListCli.stdout}`);
  }
  const evidenceCli = await runAgentCli([
    "evidence",
    "--session",
    agentSessionId,
    "--id",
    taskOperation.operationId,
  ]);
  const evidenceOutput = JSON.parse(evidenceCli.stdout);
  if (
    !evidenceOutput.ok ||
    evidenceOutput.result?.operation?.operationId !== taskOperation.operationId ||
    !evidenceOutput.result?.replayTemplate?.steps?.length
  ) {
    throw new Error(`Operation evidence bundle is incomplete: ${evidenceCli.stdout}`);
  }

  const readTransactionCli = await runAgentCli([
    "transaction-execute",
    "--session",
    agentSessionId,
    "--name",
    "Smoke read-only transaction",
    "--steps",
    JSON.stringify([
      {
        label: "Read current event buffer",
        command: "read",
        params: { limit: 1 },
      },
    ]),
  ]);
  const readTransactionOutput = JSON.parse(readTransactionCli.stdout);
  if (
    !readTransactionOutput.ok ||
    readTransactionOutput.result?.transaction?.status !== "succeeded"
  ) {
    throw new Error(`Read-only atomic transaction failed: ${readTransactionCli.stdout}`);
  }
  await runAgentCli([
    "operation-start",
    "--command",
    "status",
    "--params",
    JSON.stringify({
      diagnostic: JSON.stringify({ transactionId: "smoke-transaction", status: "ok" }),
    }),
  ]);
  await page.waitForFunction(() => {
    const text = document.querySelector("#agentActivityList")?.textContent || "";
    return text.includes('"diagnostic"') && text.includes("smoke-transaction") && text.includes('"steps"');
  });
  const agentActivitySummaryText = await page.locator("#agentActivityList").textContent();
  if (agentActivitySummaryText?.includes("[object Object]")) {
    throw new Error(`AI operation parameter summary still shows object placeholder text: ${agentActivitySummaryText}`);
  }
  await page.locator("#agentActivityRecordsTab").click();
  await page.waitForFunction(() => !document.querySelector("#agentActivityRecordsPanel")?.hidden);
  await page.screenshot({
    path: join(artifacts, "agent-activity-desktop.png"),
    fullPage: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(artifacts, "agent-activity-mobile-final.png"),
    fullPage: false,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#closeAgentActivityButton").click();

  const serialPortsCli = await runAgentCli([
    "serial-ports",
    "--session",
    agentSessionId,
  ]);
  const serialPortsOutput = JSON.parse(serialPortsCli.stdout);
  if (
    !serialPortsOutput.ok ||
    serialPortsOutput.result?.authorizedPorts?.length !== 1 ||
    !serialPortsOutput.result.authorizedPorts[0].label
  ) {
    throw new Error(`Agent CLI did not read the authorized serial port: ${serialPortsCli.stdout}`);
  }
  const serialPresetsCli = await runAgentCli([
    "serial-presets",
    "--session",
    agentSessionId,
  ]);
  if (!JSON.parse(serialPresetsCli.stdout).ok) {
    throw new Error(`Agent CLI failed to read serial presets: ${serialPresetsCli.stdout}`);
  }
  await runAgentCli([
    "serial-disconnect",
    "--session",
    agentSessionId,
  ]);
  await page.waitForFunction(() => document.querySelector("#portStateBadge").textContent !== "已连接");
  const serialConnectCli = await runAgentCli([
    "serial-connect",
    "--session",
    agentSessionId,
    "--port-index",
    "0",
    "--baud",
    "115200",
  ]);
  const serialConnectOutput = JSON.parse(serialConnectCli.stdout);
  if (!serialConnectOutput.ok || serialConnectOutput.result?.connected !== true) {
    throw new Error(`Agent CLI did not reconnect the serial port: ${serialConnectCli.stdout}`);
  }
  await page.waitForFunction(() => document.querySelector("#portStateBadge").textContent === "已连接");

  await page.keyboard.press("Control+L");
  await page.waitForFunction(() => document.activeElement?.id === "consoleViewport");
  await page.locator('[data-send-mode="text"]').click();
  if (await page.locator("#sendPanel").evaluate((element) => element.classList.contains("is-collapsed"))) {
    await page.locator("#toggleSendPanelButton").click();
    await page.waitForFunction(() => !document.querySelector("#sendPanel").classList.contains("is-collapsed"));
  }
  await page.locator("#sendInput").fill("SHORTCUT-SEND");
  await page.locator("#consoleViewport").focus();
  const shortcutWriteCount = await page.evaluate(() => window.__serialMock.written.length);
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(
    (previousCount) => window.__serialMock.written.length > previousCount,
    shortcutWriteCount,
  );
  await page.keyboard.press("Control+K");
  await page.waitForFunction(
    () => document.querySelector("#logContent")?.childElementCount === 0,
  );

  async function openNetworkPage() {
    const networkPage = await context.newPage();
    networkPage.on("pageerror", (error) => pageErrors.push(error.message));
    networkPage.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });
    await networkPage.goto(baseUrl, { waitUntil: "networkidle" });
    await networkPage.locator('[data-workspace-mode="network"]').click();
    await networkPage.waitForFunction(() => !document.querySelector("#networkWorkspace").hidden);
    if (!(await networkPage.locator("#networkHeaderStatus").isVisible())) {
      throw new Error("Network workspace did not show the top-bar connection status.");
    }
    if (await networkPage.locator("#headerStatus").isVisible()) {
      throw new Error("Network workspace still shows the serial top-bar status.");
    }
    for (const selector of [
      "#networkShowRxToggle",
      "#networkShowTxToggle",
      "#networkShowSysToggle",
      '[data-network-timestamp-mode="absolute"]',
      "#networkDualModeToggle",
      "#networkAutoSaveButton",
      "#networkAutoSendButton",
      "#networkAutoSendCount",
      "#networkAutoSendInterval",
      "#networkPauseButton",
      "#networkToggleSendPanelButton",
      "#networkFollowLatestButton",
    ]) {
      if ((await networkPage.locator(selector).count()) !== 1) {
        throw new Error(`Network workspace is missing control: ${selector}`);
      }
    }
    return networkPage;
  }

  const networkServerPage = await openNetworkPage();
  const networkClientPage = await openNetworkPage();
  const tcpPort = await getFreeTcpPort();

  await networkServerPage.locator('[data-network-protocol="tcp"]').click();
  await networkServerPage.locator('[data-network-role="server"]').click();
  await networkServerPage.locator("#networkHost").fill("127.0.0.1");
  await networkServerPage.locator("#networkPort").fill(String(tcpPort));
  await networkServerPage.locator("#saveNetworkPresetButton").click();
  await networkServerPage.waitForFunction(
    () => document.querySelectorAll("#networkPresetSelect option").length === 2,
  );
  const networkPresetId = await networkServerPage.locator("#networkPresetSelect").inputValue();
  if (!networkPresetId) {
    throw new Error("Saved network connection preset was not auto-selected.");
  }
  await networkServerPage.locator("#networkPort").fill(String(tcpPort + 1));
  await networkServerPage.locator("#networkPresetSelect").selectOption(networkPresetId);
  await networkServerPage.waitForFunction(
    (expectedPort) => document.querySelector("#networkPort").value === String(expectedPort),
    tcpPort,
  );
  await networkServerPage.locator("#deleteNetworkPresetButton").click();
  await networkServerPage.waitForFunction(
    () =>
      document.querySelectorAll("#networkPresetSelect option").length === 1 &&
      document.querySelector("#deleteNetworkPresetButton").disabled,
  );
  await networkServerPage.locator("#networkConnectButton").click();
  await networkServerPage.waitForFunction(() => document.querySelector("#networkStateBadge").textContent === "已连接");
  await waitForValue(networkServerPage, "#networkHeaderStatusText", "客户端 0");

  await networkClientPage.locator('[data-network-protocol="tcp"]').click();
  await networkClientPage.locator('[data-network-role="client"]').click();
  await networkClientPage.locator("#networkHost").fill("127.0.0.1");
  await networkClientPage.locator("#networkPort").fill(String(tcpPort));
  await networkClientPage.locator("#networkConnectButton").click();
  await networkClientPage.waitForFunction(() => document.querySelector("#networkStateBadge").textContent === "已连接");
  await networkServerPage.waitForFunction(() => document.querySelector("#networkLinkCounter").textContent === "1");
  await waitForValue(networkServerPage, "#networkHeaderStatusText", "客户端 1");

  const networkAgentSessionId = await networkServerPage.evaluate(() =>
    sessionStorage.getItem("linktk.agent.session-id"),
  );
  if (!networkAgentSessionId) {
    throw new Error("Network page has no usable AI sessionId.");
  }
  await runAgentCli([
    "network-send",
    "--session",
    networkAgentSessionId,
    "--text",
    "AGENT-NET-ROUNDTRIP",
    "--ending",
    "lf",
  ]);
  await networkClientPage.waitForFunction(() =>
    document.querySelector("#networkLogContent")?.textContent.includes("AGENT-NET-ROUNDTRIP"),
  );
  await networkClientPage.locator("#networkSendInput").fill("AGENT-NET-ACK");
  await networkClientPage.locator("#networkSendButton").click();
  const networkWaitResult = await runAgentCli([
    "network-wait",
    "--session",
    networkAgentSessionId,
    "--expect",
    "AGENT-NET-ACK",
    "--timeout",
    "3000",
  ]);
  if (!networkWaitResult.stdout.includes('"matched": true')) {
    throw new Error(`Agent CLI did not wait for a network response: ${networkWaitResult.stdout}`);
  }

  await networkServerPage.locator("#networkSendInput").fill("NET={{counter}} DEV={{device}}");
  await networkServerPage.locator("#networkSendButton").click();
  await networkClientPage.waitForFunction(() =>
    document.querySelector("#networkLogContent")?.textContent.includes("NET=1 DEV=COM9"),
  );
  await networkServerPage.locator("#networkSendInput").fill("NET={{counter}}");
  await networkServerPage.locator("#networkSendButton").click();
  await networkClientPage.waitForFunction(() =>
    document.querySelector("#networkLogContent")?.textContent.includes("NET=2"),
  );

  await networkServerPage.locator("#networkShowTxToggle").uncheck();
  await networkServerPage.waitForFunction(() =>
    [...document.querySelectorAll("#networkLogContent .log-entry--tx")].every((entry) =>
      entry.classList.contains("is-filtered-out"),
    ),
  );
  await networkServerPage.locator("#networkShowTxToggle").check();
  await networkServerPage.locator("#networkDisplaySettingsButton").click();
  await networkServerPage.waitForFunction(() => document.querySelector("#displaySettingsDialog").open);
  await networkServerPage.locator("label:has(#networkDualModeToggle)").click();
  await networkServerPage.locator("#confirmDisplaySettingsButton").click();
  const networkDualState = await networkServerPage.evaluate(() => {
    const entry = [...document.querySelectorAll("#networkLogContent .log-entry")].find((item) =>
      item.querySelector(".log-entry__data")?.textContent.includes("NET=2"),
    );
    const alternate = entry?.querySelector(".log-entry__alternate");
    return {
      contentDual: document.querySelector("#networkLogContent").classList.contains("is-dual"),
      alternate: alternate?.textContent || "",
      alternateDisplay: alternate ? getComputedStyle(alternate).display : "none",
    };
  });
  if (
    !networkDualState.contentDual ||
    networkDualState.alternateDisplay === "none" ||
    !networkDualState.alternate.includes("4E 45 54 3D 32")
  ) {
    throw new Error(`Network dual-column HEX/text display is incorrect: ${JSON.stringify(networkDualState)}`);
  }
  await networkServerPage.locator("#networkDisplaySettingsButton").click();
  await networkServerPage.waitForFunction(() => document.querySelector("#displaySettingsDialog").open);
  await networkServerPage.locator("label:has(#networkDualModeToggle)").click();
  await networkServerPage.locator("#confirmDisplaySettingsButton").click();

  const networkCopyRow = networkServerPage
    .locator("#networkLogContent .log-entry")
    .filter({ hasText: "NET=1 DEV=COM9" })
    .last();
  await networkCopyRow.locator(".log-entry__data").click();
  await networkServerPage.waitForFunction(() =>
    window.__copiedText.includes("NET=1 DEV=COM9"),
  );

  await networkServerPage.locator("#networkSendInput").fill("PING-ACK");
  await networkServerPage.locator("#networkResponseTestButton").click();
  await networkServerPage.waitForFunction(
    () => document.querySelector("#responseTestDialog").open,
  );
  await networkServerPage.locator("#responseExpectedInput").fill("ACK-OK");
  await networkServerPage.locator("#responseTimeoutInput").fill("500");
  await networkServerPage.locator("#startResponseTestButton").click();
  await networkClientPage.waitForFunction(() =>
    document.querySelector("#networkLogContent")?.textContent.includes("PING-ACK"),
  );
  await networkClientPage.locator("#networkSendInput").fill("ACK-OK");
  await networkClientPage.locator("#networkSendButton").click();
  await networkServerPage.waitForFunction(
    () => document.querySelector("#responseTestBadge").textContent === "成功",
  );
  await networkServerPage.locator("#closeResponseTestDialogButton").click();
  await networkServerPage.waitForFunction(
    () => !document.querySelector("#responseTestDialog").open,
  );

  await networkServerPage.locator("#networkSendInput").fill("HIST-NET-ONE");
  await networkServerPage.locator("#networkSendButton").click();
  await networkClientPage.waitForFunction(() =>
    document.querySelector("#networkLogContent")?.textContent.includes("HIST-NET-ONE"),
  );
  await networkServerPage.locator("#networkSendInput").fill("HIST-NET-TWO");
  await networkServerPage.locator("#networkSendButton").click();
  await networkClientPage.waitForFunction(() =>
    document.querySelector("#networkLogContent")?.textContent.includes("HIST-NET-TWO"),
  );
  await networkServerPage.locator("#networkSendInput").fill("NET-DRAFT");
  await networkServerPage.locator("#networkSendInput").press("ArrowUp");
  await networkServerPage.waitForFunction(
    () => document.querySelector("#networkSendInput").value === "HIST-NET-TWO",
  );
  await networkServerPage.locator("#networkSendInput").press("ArrowDown");
  await networkServerPage.waitForFunction(
    () => document.querySelector("#networkSendInput").value === "NET-DRAFT",
  );
  const storedNetworkHistory = await networkServerPage.evaluate(
    () =>
      JSON.parse(localStorage.getItem("linktk.settings.v1") || "{}")
        .networkSendHistory || [],
  );
  if (storedNetworkHistory.at(-1) !== "HIST-NET-TWO") {
    throw new Error(`Network send history was not persisted: ${JSON.stringify(storedNetworkHistory)}`);
  }
  await networkServerPage.locator("#networkClearInputButton").click();

  await page.locator('[data-workspace-mode="network"]').click();
  await page.locator('[data-network-protocol="tcp"]').click();
  await page.locator('[data-network-role="client"]').click();
  await page.locator("#networkHost").fill("127.0.0.1");
  await page.locator("#networkPort").fill(String(tcpPort));
  await page.locator("#networkConnectButton").click();
  await page.waitForFunction(() => document.querySelector("#networkStateBadge").textContent === "已连接");

  await page.locator("#bridgeButton").click();
  await page.waitForFunction(() => document.querySelector("#bridgeDialog").open);
  if (
    !(await page.locator("#bridgeSerialToNetworkToggle").isChecked()) ||
    !(await page.locator("#bridgeNetworkToSerialToggle").isChecked())
  ) {
    throw new Error("Link bridge default direction is not enabled.");
  }
  await page.locator("#bridgeToggleButton").click();
  await page.waitForFunction(() => document.querySelector("#bridgeButtonText").textContent === "停止桥接");

  await page.evaluate(() => window.__serialMock.emit("BRIDGE-SERIAL-TO-NET\r\n"));
  await networkServerPage.waitForFunction(() =>
    document.querySelector("#networkLogContent")?.textContent.includes("BRIDGE-SERIAL-TO-NET"),
  );
  const peerColorState = await networkServerPage.evaluate(() => {
    const entry = [...document.querySelectorAll("#networkLogContent .log-entry--rx")].find(
      (item) => item.textContent.includes("BRIDGE-SERIAL-TO-NET"),
    );
    const marker = entry?.querySelector(".log-entry__remote-color");
    const peers = [...document.querySelectorAll("#networkPeerList .network-peer")].map(
      (item) => ({
        remote: item.dataset.remote,
        color: getComputedStyle(item.querySelector(".network-peer__swatch")).backgroundColor,
      }),
    );
    return {
      dataText: entry?.querySelector(".log-entry__data")?.textContent || "",
      firstClass: entry?.firstElementChild?.className || "",
      markerRemote: marker?.dataset.remote || "",
      markerColor: marker ? getComputedStyle(marker).backgroundColor : "",
      markerVisibility: marker ? getComputedStyle(marker).visibility : "",
      peers,
    };
  });
  if (peerColorState.dataText.includes("[127.0.0.1:")) {
    throw new Error(`Network log still shows the remote address prefix: ${peerColorState.dataText}`);
  }
  if (!peerColorState.firstClass.includes("log-entry__remote-color")) {
    throw new Error("Network log block does not put the remote color first.");
  }
  if (!peerColorState.peers.length || peerColorState.markerVisibility !== "visible") {
    throw new Error(`Remote color list or legend was not displayed: ${JSON.stringify(peerColorState)}`);
  }
  const listedPeer = peerColorState.peers.find(
    (peer) => peer.remote === peerColorState.markerRemote,
  );
  if (!listedPeer || listedPeer.color !== peerColorState.markerColor) {
    throw new Error(`Remote list colors do not match the log legend: ${JSON.stringify(peerColorState)}`);
  }

  await networkServerPage.locator("#networkSendInput").fill("BRIDGE-NET-TO-SERIAL");
  await networkServerPage.locator("#networkSendButton").click();
  await page.waitForFunction(() => {
    const text = new TextDecoder().decode(
      new Uint8Array(window.__serialMock.written.flat()),
    );
    return text.includes("BRIDGE-NET-TO-SERIAL");
  });

  await page.locator("#bridgeToggleButton").click();
  await page.waitForFunction(() => document.querySelector("#bridgeButtonText").textContent === "桥接");
  const bridgeCounters = await page.evaluate(() => ({
    serialToNetwork: document.querySelector("#bridgeSerialToNetworkCounter").textContent,
    networkToSerial: document.querySelector("#bridgeNetworkToSerialCounter").textContent,
  }));
  if (bridgeCounters.serialToNetwork === "0 B" || bridgeCounters.networkToSerial === "0 B") {
    throw new Error(`Link bridge counters did not update: ${JSON.stringify(bridgeCounters)}`);
  }
  await page.locator("#confirmBridgeDialogButton").click();
  const bridgeAgentStatus = await runAgentCli([
    "bridge-status",
    "--session",
    serialAgentSessionId,
  ]);
  if (
    !bridgeAgentStatus.stdout.includes('"serialReady": true') ||
    !bridgeAgentStatus.stdout.includes('"networkReady": true')
  ) {
    throw new Error(`Agent CLI bridge preconditions are incorrect: ${bridgeAgentStatus.stdout}`);
  }
  const bridgeAgentStart = await runAgentCli([
    "bridge-start",
    "--session",
    serialAgentSessionId,
  ]);
  if (!bridgeAgentStart.stdout.includes('"active": true')) {
    throw new Error(`Agent CLI did not start the bridge: ${bridgeAgentStart.stdout}`);
  }
  await page.evaluate(() => window.__serialMock.emit("AGENT-BRIDGE-FORWARD\r\n"));
  await networkServerPage.waitForFunction(() =>
    document.querySelector("#networkLogContent")?.textContent.includes("AGENT-BRIDGE-FORWARD"),
  );
  const bridgeAgentStop = await runAgentCli([
    "bridge-stop",
    "--session",
    serialAgentSessionId,
  ]);
  if (!bridgeAgentStop.stdout.includes('"active": false')) {
    throw new Error(`Agent CLI did not stop the bridge: ${bridgeAgentStop.stdout}`);
  }
  await page.locator("#networkConnectButton").click();

  await networkServerPage.locator("#networkToggleSendPanelButton").click();
  await networkServerPage.waitForFunction(() =>
    document.querySelector("#networkSendPanel").classList.contains("is-collapsed"),
  );
  await networkServerPage.locator("#networkToggleSendPanelButton").click();
  await networkServerPage.waitForFunction(() =>
    !document.querySelector("#networkSendPanel").classList.contains("is-collapsed"),
  );

  await networkServerPage.locator("#networkAutoSendInterval").fill("100");
  await networkServerPage.locator("#networkSendInput").fill("AUTO-PING");
  await networkServerPage.locator("#networkAutoSendButton").click();
  await networkClientPage.waitForFunction(
    () =>
      (document.querySelector("#networkLogContent")?.textContent.match(/AUTO-PING/g) || [])
        .length >= 2,
  );
  const autoSendTimestamps = await networkServerPage
    .locator("#networkLogContent .log-entry--tx")
    .evaluateAll((entries) =>
      entries
        .filter((entry) => entry.textContent.includes("AUTO-PING"))
        .map((entry) => entry.querySelector(".log-entry__time")?.textContent?.trim())
        .filter(Boolean),
    );
  if (autoSendTimestamps.length < 2) {
    throw new Error(`Auto-send did not keep a timestamp for each send: ${autoSendTimestamps.length}`);
  }
  await networkServerPage.locator("#networkAutoSendButton").click();
  await networkServerPage.waitForFunction(
    () => document.querySelector("#networkAutoSendButton").getAttribute("aria-pressed") === "false",
  );

  await networkServerPage.locator("#networkSendInput").fill("COUNTED-NET");
  await networkServerPage.locator("#networkAutoSendCount").fill("2");
  await networkServerPage.locator("#networkAutoSendInterval").fill("10");
  await networkServerPage.locator("#networkAutoSendButton").click();
  await networkServerPage.waitForFunction(
    () => document.querySelector("#networkAutoSendButton").getAttribute("aria-pressed") === "false",
  );
  const countedNetworkEntries = await networkServerPage
    .locator("#networkLogContent .log-entry--tx")
    .evaluateAll((entries) =>
      entries.filter((entry) =>
        entry.querySelector(".log-entry__data")?.textContent.includes("COUNTED-NET"),
      ).length,
    );
  if (countedNetworkEntries !== 2) {
    throw new Error(`Count-based network auto-send result is incorrect: ${countedNetworkEntries}`);
  }
  await networkServerPage.locator("#networkAutoSendCount").fill("0");

  await networkClientPage.locator("#networkPauseButton").click();
  await networkClientPage.waitForFunction(
    () => document.querySelector("#networkPauseButton").getAttribute("aria-pressed") === "true",
  );
  await networkClientPage.locator("#networkPauseButton").click();
  await networkClientPage.waitForFunction(
    () => document.querySelector("#networkPauseButton").getAttribute("aria-pressed") === "false",
  );

  await networkServerPage.locator("#networkQuickSendToggleButton").click();
  await networkServerPage.waitForFunction(() =>
    document.querySelector("#networkQuickSendSection").classList.contains("is-collapsed"),
  );
  await networkServerPage.locator("#networkQuickSendToggleButton").click();
  await networkServerPage.waitForFunction(() =>
    !document.querySelector("#networkQuickSendSection").classList.contains("is-collapsed"),
  );
  await networkServerPage
    .locator("#networkQuickCommandList .quick-command-input")
    .first()
    .fill("PING-FROM-SERVER");
  await networkServerPage
    .locator('#networkQuickCommandList [data-quick-action="send"]')
    .first()
    .click();
  await networkClientPage.waitForFunction(() =>
    document.querySelector("#networkLogContent")?.textContent.includes("PING-FROM-SERVER"),
  );

  await networkClientPage.locator("#networkSendInput").fill("PONG-FROM-CLIENT");
  await networkClientPage.locator("#networkSendButton").click();
  await networkServerPage.waitForFunction(() =>
    document.querySelector("#networkLogContent")?.textContent.includes("PONG-FROM-CLIENT"),
  );
  await networkServerPage.locator("#networkKeywordInput").fill("PING");
  await networkServerPage.waitForFunction(
    () => document.querySelectorAll("#networkLogContent mark.log-keyword-highlight").length > 0,
  );
  await networkServerPage.locator("#networkKeywordFilterButton").click();
  await networkServerPage.waitForFunction(
    () =>
      document
        .querySelector("#networkKeywordFilterButton")
        .getAttribute("aria-pressed") === "true",
  );
  const networkKeywordFilterState = await networkServerPage.evaluate(() => {
    const entries = [...document.querySelectorAll("#networkLogContent .log-entry")];
    const visible = entries.filter((entry) => !entry.classList.contains("is-filtered-out"));
    return {
      hasHidden: entries.some((entry) => entry.classList.contains("is-filtered-out")),
      hasVisible: visible.length > 0,
      visibleAllMatch: visible.every((entry) => entry.textContent.includes("PING")),
    };
  });
  if (
    !networkKeywordFilterState.hasHidden ||
    !networkKeywordFilterState.hasVisible ||
    !networkKeywordFilterState.visibleAllMatch
  ) {
    throw new Error(`Network keyword filter result is incorrect: ${JSON.stringify(networkKeywordFilterState)}`);
  }
  await networkServerPage.locator("#networkKeywordFilterButton").click();
  await networkServerPage.locator("#networkKeywordInput").fill("");
  await networkServerPage.waitForFunction(
    () =>
      !document.querySelector("#networkLogContent .log-entry.is-filtered-out") &&
      !document.querySelector("#networkLogContent mark.log-keyword-highlight"),
  );
  const peerColors = await networkServerPage.evaluate(() =>
    [...document.querySelectorAll("#networkPeerList .network-peer")].map((item) => ({
      remote: item.dataset.remote,
      color: getComputedStyle(item.querySelector(".network-peer__swatch")).backgroundColor,
    })),
  );
  if (
    peerColors.length < 2 ||
    new Set(peerColors.map((peer) => peer.color)).size !== peerColors.length
  ) {
    throw new Error(`Different remote addresses were not assigned different colors: ${JSON.stringify(peerColors)}`);
  }

  await networkClientPage.locator("#networkConnectButton").click();
  await networkClientPage.waitForFunction(() => document.querySelector("#networkStateBadge").textContent !== "已连接");
  await waitForValue(networkServerPage, "#networkHeaderStatusText", "客户端 0");
  await networkServerPage.locator("#networkConnectButton").click();
  await networkServerPage.waitForFunction(() => document.querySelector("#networkStateBadge").textContent !== "已连接");

  const udpPort = await getFreeUdpPort();
  await networkServerPage.locator('[data-network-protocol="udp"]').click();
  await networkServerPage.locator('[data-network-role="server"]').click();
  await networkServerPage.locator("#networkPort").fill(String(udpPort));
  await networkServerPage.locator("#networkConnectButton").click();
  await networkServerPage.waitForFunction(() => document.querySelector("#networkStateBadge").textContent === "已连接");
  await waitForValue(networkServerPage, "#networkHeaderStatusText", "监听中");

  await networkClientPage.locator('[data-network-protocol="udp"]').click();
  await networkClientPage.locator('[data-network-role="client"]').click();
  await networkClientPage.locator("#networkPort").fill(String(udpPort));
  await networkClientPage.locator("#networkConnectButton").click();
  await networkClientPage.waitForFunction(() => document.querySelector("#networkStateBadge").textContent === "已连接");
  await waitForValue(networkClientPage, "#networkHeaderStatusText", "已连接");

  await networkClientPage.locator("#networkSendInput").fill("UDP-HELLO");
  await networkClientPage.locator("#networkSendButton").click();
  await networkServerPage.waitForFunction(() =>
    document.querySelector("#networkLogContent")?.textContent.includes("UDP-HELLO"),
  );

  await networkServerPage.locator("#networkSendInput").fill("UDP-ACK");
  await networkServerPage.locator("#networkSendButton").click();
  await networkClientPage.waitForFunction(() =>
    document.querySelector("#networkLogContent")?.textContent.includes("UDP-ACK"),
  );

  await networkServerPage.screenshot({
    path: join(artifacts, "serial-workbench-network.png"),
    fullPage: true,
  });
  await networkServerPage.setViewportSize({ width: 390, height: 844 });
  await networkServerPage.screenshot({
    path: join(artifacts, "serial-workbench-network-mobile.png"),
    fullPage: true,
  });

  await networkClientPage.close();
  await networkServerPage.close();

  const terminalStartContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await terminalStartContext.addInitScript(() => {
    try {
      localStorage.setItem(
        "serial-web-assistant.settings.v1",
        JSON.stringify({ consoleView: "terminal" }),
      );
    } catch {
      // The init script also runs before the target origin is available.
    }
  });
  const terminalStartPage = await terminalStartContext.newPage();
  terminalStartPage.on("pageerror", (error) => pageErrors.push(error.message));
  await terminalStartPage.goto(baseUrl, { waitUntil: "networkidle" });
  await terminalStartPage.waitForFunction(() => !document.querySelector("#terminalViewport").hidden);
  await terminalStartPage.locator('[data-console-view="log"]').click();
  await terminalStartPage.waitForFunction(
    () =>
      document.querySelector("#terminalViewport").hidden &&
      !document.querySelector("#consoleViewport").hidden &&
      document.querySelector("#receivePanel").dataset.consoleView === "log",
  );
  await terminalStartContext.close();

  if (pageErrors.length) {
    throw new Error(`Page runtime error(s):\n${pageErrors.join("\n")}`);
  }

  console.log(
    "Smoke test passed: Agent CLI serial round-trip, send history, log copy, template variables, response testing, Macro recording/playback, quick send, YMODEM, TCP/UDP, ANSI colors, and terminal rendering are working.",
  );
} finally {
  await browser?.close();
  server.kill();
}
