import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const serverPath = fileURLToPath(new URL("../tools/linktk-mcp.mjs", import.meta.url));

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
}

const requestedAlias = option("alias") || process.env.LINKTK_SSH_ALIAS || "";
const requestedPresetId = option("preset-id") || "";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: root,
  env: {
    ...process.env,
    LINKTK_AGENT_URL:
      process.env.LINKTK_AGENT_URL || "ws://127.0.0.1:5173/__agent-control",
  },
  stderr: "pipe",
});
const client = new Client({ name: "linktk-mcp-demo", version: "1.0.0" });

async function callTool(name, args = {}) {
  const response = await client.callTool({ name, arguments: args });
  const text = response.content?.find((item) => item.type === "text")?.text || "";
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { text };
  }
  if (response.isError) {
    throw new Error(`${name}: ${payload.error || text || "MCP tool execution failed."}`);
  }
  return payload;
}

function report(step, message) {
  console.log(`[${step}] ${message}`);
}

let uploadedPath = "";
const localUploadPath = join(
  tmpdir(),
  `linktk-mcp-upload-${process.pid}-${Date.now()}.txt`,
);
const localDownloadPath = join(
  tmpdir(),
  `linktk-mcp-download-${process.pid}-${Date.now()}.txt`,
);
let connected = false;

try {
  await client.connect(transport);

  report("1/8", "Reading the LinkTK session snapshot");
  const snapshot = await callTool("linktk_snapshot");
  console.log(JSON.stringify(snapshot.ssh || {}, null, 2));

  report("2/8", "Reading available SSH targets");
  const targets = await callTool("linktk_targets", { transport: "ssh" });
  const presets = targets.ssh?.presets?.presets || [];
  console.log(JSON.stringify({ presets }, null, 2));
  const preset =
    presets.find(
      (item) =>
        (requestedPresetId && item.id === requestedPresetId) ||
        (requestedAlias && item.alias === requestedAlias),
    ) ||
    presets.find((item) => item.hasSavedPassword) ||
    presets[0];
  if (!preset) throw new Error("No usable SSH preset in the LinkTK page.");

  if (snapshot.ssh?.connected) {
    connected = true;
    report(
      "3/8",
      `SSH already connected; reusing the current session ${snapshot.ssh.username}@${snapshot.ssh.host}:${snapshot.ssh.port}`,
    );
  } else {
    report("3/8", `Connecting SSH with preset "${preset.alias}"`);
    const connection = await callTool("linktk_connect", {
      transport: "ssh",
      presetId: preset.id,
      presetName: preset.alias,
    });
    connected = true;
    console.log(JSON.stringify(connection, null, 2));
  }

  report("4/8", "Running a unique marker command to verify the remote shell");
  const marker = `LINKTK_MCP_${Date.now()}`;
  const shellResult = await callTool("linktk_execute", {
    transport: "ssh",
    data: `printf "LINKTK_%s\\n" ${marker.replace("LINKTK_", "")}`,
    expect: marker,
    mode: "contains",
    waitForResponse: true,
    ending: "lf",
    timeoutMs: 8000,
    captureMs: 120,
  });
  if (!shellResult.matched) throw new Error(`Remote command did not confirm completion: ${JSON.stringify(shellResult)}`);
  report("4/8", `Remote shell OK; matched ${marker}`);

  const content = `LinkTK MCP demo ${new Date().toISOString()}\n`;
  writeFileSync(localUploadPath, content, "utf8");
  report("5/8", "Preparing a local temp file");
  uploadedPath = `/tmp/linktk-mcp-demo-${Date.now()}.txt`;
  report("6/8", `Uploaded temp file ${uploadedPath}`);
  const upload = await callTool("linktk_transfer_file", {
    direction: "upload",
    protocol: "sftp",
    localPath: localUploadPath,
    remotePath: uploadedPath,
  });
  console.log(JSON.stringify(upload, null, 2));

  report("7/8", "Reading the file remotely and downloading it back locally");
  const remoteRead = await callTool("linktk_execute", {
    transport: "ssh",
    data: `cat ${uploadedPath}`,
    expect: "LinkTK MCP demo",
    mode: "contains",
    waitForResponse: true,
    ending: "lf",
    timeoutMs: 8000,
    captureMs: 120,
  });
  if (!remoteRead.matched) throw new Error(`Remote file read failed: ${JSON.stringify(remoteRead)}`);

  const download = await callTool("linktk_transfer_file", {
    direction: "download",
    protocol: "sftp",
    remotePath: uploadedPath,
    localPath: localDownloadPath,
    maxBytes: 4096,
  });
  const downloaded = readFileSync(localDownloadPath, "utf8");
  if (downloaded !== content) {
    throw new Error(`Downloaded content does not match: ${JSON.stringify(downloaded)}`);
  }
  report("7/8", `Remote read and download match: ${download.bytes} bytes total`);

  report("8/8", "Deleting the temp file");
  await callTool("linktk_execute", {
    transport: "ssh",
    data: `rm -f ${uploadedPath}`,
    waitForResponse: false,
    ending: "lf",
  });
  uploadedPath = "";

  console.log(
    JSON.stringify(
      {
        ok: true,
        preset: preset.alias,
        marker,
        remoteFile: "upload, verify, download, and delete all completed",
      },
      null,
      2,
    ),
  );
} finally {
  if (uploadedPath && connected) {
    try {
      await callTool("linktk_execute", {
        transport: "ssh",
        data: `rm -f ${uploadedPath}`,
        waitForResponse: false,
        ending: "lf",
      });
    } catch {
      // Keep the original demo failure.
    }
  }
  for (const path of [localUploadPath, localDownloadPath]) {
    if (existsSync(path)) unlinkSync(path);
  }
  await client.close();
}
