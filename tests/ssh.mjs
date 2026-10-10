import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import ssh2 from "ssh2";
import WebSocket from "ws";

const { Server } = ssh2;
const {
  sftp: { OPEN_MODE, STATUS_CODE },
} = ssh2.utils;
const root = fileURLToPath(new URL("..", import.meta.url));
const agentToken = "linktk-ssh-test-token-0123456789";
const browserCandidates = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
const browserPath = browserCandidates.find(existsSync);
if (!browserPath) {
  throw new Error("No Edge or Chrome executable was found for the SSH UI test.");
}
const artifacts = join(root, "artifacts");
mkdirSync(artifacts, { recursive: true });
const remoteRoot = mkdtempSync(join(tmpdir(), "linktk-ssh-sftp-"));
const localRoot = mkdtempSync(join(tmpdir(), "linktk-ssh-local-"));
let slowReadPath = "";
let slowWritePath = "";
let slowReadDelayMs = 500;
writeFileSync(join(remoteRoot, "hello.txt"), "hello from sftp\n", "utf8");

function resolveRemotePath(value) {
  const raw = String(value ?? ".").replace(/\\/g, "/");
  const relative = raw.replace(/^\/+/, "");
  const candidate = resolve(remoteRoot, relative || ".");
  if (candidate !== remoteRoot && !candidate.startsWith(`${remoteRoot}${sep}`)) {
    throw new Error("Path escapes the test root.");
  }
  return candidate;
}

function remoteAttrs(filePath) {
  const stats = statSync(filePath);
  return {
    mode:
      (stats.isDirectory() ? constants.S_IFDIR : constants.S_IFREG) |
      (stats.isDirectory() ? 0o755 : 0o644),
    uid: 0,
    gid: 0,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
  };
}

function attachSftpServer(session) {
  session.on("sftp", (accept) => {
    const sftp = accept();
    const handles = new Map();
    let nextHandle = 1;

    const createHandle = (value) => {
      const handle = Buffer.alloc(4);
      const id = nextHandle++;
      handle.writeUInt32BE(id, 0, true);
      handles.set(id, value);
      return handle;
    };
    const readHandle = (handle) =>
      handle?.length === 4 ? handles.get(handle.readUInt32BE(0, true)) : null;
    const fail = (reqid, error) => {
      const code =
        error?.code === "ENOENT"
          ? STATUS_CODE.NO_SUCH_FILE
          : error?.code === "EACCES"
            ? STATUS_CODE.PERMISSION_DENIED
            : STATUS_CODE.FAILURE;
      sftp.status(reqid, code, error?.message || "");
    };

    sftp.on("REALPATH", (reqid, path) => {
      sftp.name(reqid, [
        {
          filename: path.startsWith("/") ? path : `/${path}`,
          longname: path,
          attrs: {},
        },
      ]);
    });

    sftp.on("STAT", (reqid, path) => {
      try {
        sftp.attrs(reqid, remoteAttrs(resolveRemotePath(path)));
      } catch (error) {
        fail(reqid, error);
      }
    });

    sftp.on("LSTAT", (reqid, path) => {
      try {
        sftp.attrs(reqid, remoteAttrs(resolveRemotePath(path)));
      } catch (error) {
        fail(reqid, error);
      }
    });

    sftp.on("OPEN", (reqid, filename, flags) => {
      try {
        const filePath = resolveRemotePath(filename);
        const writable = Boolean(flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND));
        const readable = Boolean(flags & OPEN_MODE.READ);
        const openFlags = writable
          ? flags & OPEN_MODE.TRUNC
            ? "w"
            : "a"
          : readable
            ? "r"
            : "r";
        const fd = openSync(filePath, openFlags);
        sftp.handle(
          reqid,
          createHandle({ type: "file", fd, filePath, closed: false }),
        );
      } catch (error) {
        fail(reqid, error);
      }
    });

    sftp.on("READ", (reqid, handle, offset, length) => {
      const state = readHandle(handle);
      if (!state || state.type !== "file") {
        sftp.status(reqid, STATUS_CODE.FAILURE);
        return;
      }
      try {
        const buffer = Buffer.alloc(length);
        const bytesRead = readSync(state.fd, buffer, 0, length, offset);
        const respond = () => {
          if (!sftp.readable || state.closed) return;
          try {
            if (bytesRead === 0) {
              sftp.status(reqid, STATUS_CODE.EOF);
            } else {
              sftp.data(reqid, buffer.subarray(0, bytesRead));
            }
          } catch {
            // The client may have cancelled and closed the channel.
          }
        };
        if (slowReadPath && state.filePath.endsWith(slowReadPath)) {
          setTimeout(respond, slowReadDelayMs);
        } else {
          respond();
        }
      } catch (error) {
        fail(reqid, error);
      }
    });

    sftp.on("WRITE", (reqid, handle, offset, data) => {
      const state = readHandle(handle);
      if (!state || state.type !== "file") {
        sftp.status(reqid, STATUS_CODE.FAILURE);
        return;
      }
      try {
        writeSync(state.fd, data, 0, data.length, offset);
        const respond = () => {
          if (!sftp.readable || state.closed) return;
          try {
            sftp.status(reqid, STATUS_CODE.OK);
          } catch {
            // The client may have cancelled and closed the channel.
          }
        };
        if (slowWritePath && state.filePath.includes(slowWritePath)) {
          setTimeout(respond, 500);
        } else {
          respond();
        }
      } catch (error) {
        fail(reqid, error);
      }
    });

    sftp.on("FSTAT", (reqid, handle) => {
      const state = readHandle(handle);
      if (!state || state.type !== "file") {
        sftp.status(reqid, STATUS_CODE.FAILURE);
        return;
      }
      try {
        const stats = fstatSync(state.fd);
        sftp.attrs(reqid, {
          mode:
            (stats.isDirectory() ? constants.S_IFDIR : constants.S_IFREG) |
            (stats.isDirectory() ? 0o755 : 0o644),
          uid: 0,
          gid: 0,
          size: stats.size,
          atime: Math.floor(stats.atimeMs / 1000),
          mtime: Math.floor(stats.mtimeMs / 1000),
        });
      } catch (error) {
        fail(reqid, error);
      }
    });

    sftp.on("CLOSE", (reqid, handle) => {
      const state = readHandle(handle);
      if (!state) {
        sftp.status(reqid, STATUS_CODE.FAILURE);
        return;
      }
      try {
        if (state.type === "file") {
          state.closed = true;
          closeSync(state.fd);
        }
        handles.delete(handle.readUInt32BE(0, true));
        sftp.status(reqid, STATUS_CODE.OK);
      } catch (error) {
        fail(reqid, error);
      }
    });

    sftp.on("OPENDIR", (reqid, path) => {
      try {
        const filePath = resolveRemotePath(path);
        const entries = readdirSync(filePath).map((name) => {
          const entryPath = join(filePath, name);
          return {
            filename: name,
            longname: name,
            attrs: remoteAttrs(entryPath),
          };
        });
        sftp.handle(reqid, createHandle({ type: "dir", entries, sent: false }));
      } catch (error) {
        fail(reqid, error);
      }
    });

    sftp.on("READDIR", (reqid, handle) => {
      const state = readHandle(handle);
      if (!state || state.type !== "dir") {
        sftp.status(reqid, STATUS_CODE.FAILURE);
        return;
      }
      if (state.sent) {
        sftp.status(reqid, STATUS_CODE.EOF);
        return;
      }
      state.sent = true;
      sftp.name(reqid, state.entries);
    });

    sftp.on("MKDIR", (reqid, path) => {
      try {
        mkdirSync(resolveRemotePath(path));
        sftp.status(reqid, STATUS_CODE.OK);
      } catch (error) {
        fail(reqid, error);
      }
    });

    sftp.on("RMDIR", (reqid, path) => {
      try {
        rmSync(resolveRemotePath(path), { recursive: true, force: false });
        sftp.status(reqid, STATUS_CODE.OK);
      } catch (error) {
        fail(reqid, error);
      }
    });

    sftp.on("REMOVE", (reqid, path) => {
      try {
        unlinkSync(resolveRemotePath(path));
        sftp.status(reqid, STATUS_CODE.OK);
      } catch (error) {
        fail(reqid, error);
      }
    });

    sftp.on("RENAME", (reqid, from, to) => {
      try {
        renameSync(resolveRemotePath(from), resolveRemotePath(to));
        sftp.status(reqid, STATUS_CODE.OK);
      } catch (error) {
        fail(reqid, error);
      }
    });
  });
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(url, childOutput) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The Vite server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Vite server did not start.\n${childOutput.value}`);
}

function waitForMessage(messages, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const inspect = () => {
      const message = [...messages].reverse().find(predicate);
      if (message) {
        resolve(message);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(
          new Error(
            `Timed out waiting for SSH message:\n${messages
              .slice(-20)
              .map((message) => JSON.stringify(message))
              .join("\n")}`,
          ),
        );
        return;
      }
      setTimeout(inspect, 25);
    };
    inspect();
  });
}

function sendSshRequest(socket, messages, payload, timeoutMs = 8000) {
  const requestId = `request-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  socket.send(JSON.stringify({ ...payload, requestId }));
  return waitForMessage(
    messages,
    (message) => message.requestId === requestId,
    timeoutMs,
  );
}

function sendSshTransfer(socket, messages, payload, timeoutMs = 20000) {
  const transferId = `transfer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  socket.send(JSON.stringify({ ...payload, transferId }));
  return waitForMessage(
    messages,
    (message) =>
      (message.type === "sftp:transfer-result" ||
        message.type === "sftp:transfer-error") &&
      message.transferId === transferId,
    timeoutMs,
  );
}

async function requestAgentCommand(command, params = {}, timeoutMs = 15000) {
  const socket = new WebSocket(`ws://127.0.0.1:${vitePort}/__agent-control`, {
    headers: {
      "x-linktk-agent-token": agentToken,
    },
  });
  const messages = [];
  socket.on("message", (raw) => {
    try {
      messages.push(JSON.parse(raw.toString()));
    } catch {
      // Ignore malformed messages; the waiter below will surface a timeout.
    }
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await waitForMessage(messages, (message) => message.type === "agent:control-ready");
  const id = `agent-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  socket.send(
    JSON.stringify({
      type: "agent:request",
      id,
      command,
      params,
      timeoutMs,
    }),
  );
  try {
    const result = await waitForMessage(
      messages,
      (message) => message.type === "agent:result" && message.id === id,
      timeoutMs + 2000,
    );
    if (!result.ok) throw new Error(result.error || `${command} failed.`);
    return result.result;
  } finally {
    socket.close();
  }
}

function decodeBase64(value) {
  return Buffer.from(String(value || ""), "base64").toString("utf8");
}

const vitePort = await getFreePort();
const sshPort = await getFreePort();
const childOutput = { value: "" };
const vite = spawn(
  process.execPath,
  [
    join(root, "node_modules", "vite", "bin", "vite.js"),
    "--host",
    "127.0.0.1",
    "--port",
    String(vitePort),
  ],
  {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      LINKTK_AGENT_TOKEN: agentToken,
    },
  },
);
vite.stdout.on("data", (chunk) => {
  childOutput.value += chunk.toString();
});
vite.stderr.on("data", (chunk) => {
  childOutput.value += chunk.toString();
});

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: {
    type: "pkcs1",
    format: "pem",
  },
  publicKeyEncoding: {
    type: "spki",
    format: "pem",
  },
});

let activeStream = null;
let lastPty = null;
const sshServer = new Server({ hostKeys: [privateKey] }, (client) => {
  client.on("authentication", (context) => {
    if (
      context.method === "password" &&
      context.username === "tester" &&
      context.password === "secret"
    ) {
      context.accept();
    } else {
      context.reject();
    }
  });

  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      attachSftpServer(session);
      session.on("pty", (acceptPty, _reject, info) => {
        lastPty = info;
        acceptPty();
      });
      session.on("window-change", (acceptWindow, _reject, info) => {
        if (typeof acceptWindow === "function") acceptWindow();
        if (activeStream) {
          activeStream.write(`WINDOW:${info.cols}x${info.rows}\n`);
        }
      });
      session.on("shell", (acceptShell) => {
        const stream = acceptShell();
        activeStream = stream;
        let inputBuffer = "";
        stream.write("MOCK_SSH_READY\n");
        stream.on("data", (chunk) => {
          inputBuffer += chunk.toString("utf8");
          let lineBreak = inputBuffer.search(/[\r\n]/);
          while (lineBreak >= 0) {
            const command = inputBuffer.slice(0, lineBreak);
            inputBuffer = inputBuffer.slice(lineBreak + 1).replace(/^\n/, "");
            stream.write(`REMOTE:${command}\n`);
            lineBreak = inputBuffer.search(/[\r\n]/);
          }
        });
        stream.on("close", () => {
          if (activeStream === stream) activeStream = null;
        });
      });
    });
  });
});

let socket;
let browser;

try {
  await waitForServer(`http://127.0.0.1:${vitePort}`, childOutput);
  await new Promise((resolve, reject) => {
    sshServer.once("error", reject);
    sshServer.listen(sshPort, "127.0.0.1", resolve);
  });

  socket = new WebSocket(`ws://127.0.0.1:${vitePort}/__ssh`);
  const messages = [];
  const rawMessages = [];
  socket.on("message", (raw) => {
    const text = raw.toString();
    rawMessages.push(text);
    messages.push(JSON.parse(text));
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  await waitForMessage(messages, (message) => message.type === "ssh:ready");

  socket.send(
    JSON.stringify({
      type: "ssh:connect",
      host: "127.0.0.1",
      port: sshPort,
      username: "tester",
      password: "secret",
      cols: 100,
      rows: 30,
    }),
  );

  const connected = await waitForMessage(
    messages,
    (message) => message.type === "ssh:status" && message.state === "connected",
  );
  if (!connected.fingerprint) {
    throw new Error("SSH connected status did not include a host fingerprint.");
  }
  if (lastPty?.cols !== 100 || lastPty?.rows !== 30) {
    throw new Error(`SSH pty size mismatch: ${JSON.stringify(lastPty)}`);
  }

  await waitForMessage(
    messages,
    (message) =>
      message.type === "ssh:data" &&
      decodeBase64(message.data).includes("MOCK_SSH_READY"),
  );

  socket.send(JSON.stringify({ type: "ssh:input", data: "hello\n" }));
  await waitForMessage(
    messages,
    (message) =>
      message.type === "ssh:data" &&
      decodeBase64(message.data).includes("REMOTE:hello"),
  );

  socket.send(JSON.stringify({ type: "ssh:resize", cols: 132, rows: 40 }));
  await waitForMessage(
    messages,
    (message) =>
      message.type === "ssh:data" &&
      decodeBase64(message.data).includes("WINDOW:132x40"),
  );

  const initialList = await sendSshRequest(socket, messages, {
    type: "sftp:list",
    path: ".",
  });
  if (!initialList.entries?.some((entry) => entry.name === "hello.txt")) {
    throw new Error(`SFTP list did not return hello.txt: ${JSON.stringify(initialList)}`);
  }

  await sendSshRequest(socket, messages, {
    type: "sftp:mkdir",
    path: "bridge-dir",
  });
  const uploadTransferId = `upload-${Date.now()}`;
  await sendSshRequest(socket, messages, {
    type: "sftp:upload-start",
    transferId: uploadTransferId,
    path: "bridge.txt",
    size: 16,
  });
  await sendSshRequest(socket, messages, {
    type: "sftp:upload-chunk",
    transferId: uploadTransferId,
    data: Buffer.from("bridge upload\n", "utf8").toString("base64"),
  });
  await sendSshRequest(socket, messages, {
    type: "sftp:upload-end",
    transferId: uploadTransferId,
  });
  if (readFileSync(join(remoteRoot, "bridge.txt"), "utf8") !== "bridge upload\n") {
    throw new Error("SFTP upload did not write the expected content.");
  }

  const inlineOverwriteConflict = await sendSshRequest(socket, messages, {
    type: "sftp:upload-start",
    transferId: `upload-conflict-${Date.now()}`,
    path: "bridge.txt",
    size: 16,
  });
  if (
    inlineOverwriteConflict.type !== "sftp:error" ||
    !String(inlineOverwriteConflict.message).includes("EEXIST")
  ) {
    throw new Error(`Inline upload overwrite protection did not take effect: ${JSON.stringify(inlineOverwriteConflict)}`);
  }
  const overwriteUploadTransferId = `upload-overwrite-${Date.now()}`;
  await sendSshRequest(socket, messages, {
    type: "sftp:upload-start",
    transferId: overwriteUploadTransferId,
    path: "bridge.txt",
    size: 16,
    overwrite: true,
  });
  await sendSshRequest(socket, messages, {
    type: "sftp:upload-chunk",
    transferId: overwriteUploadTransferId,
    data: Buffer.from("bridge upload\n", "utf8").toString("base64"),
  });
  await sendSshRequest(socket, messages, {
    type: "sftp:upload-end",
    transferId: overwriteUploadTransferId,
  });

  await sendSshRequest(socket, messages, {
    type: "sftp:rename",
    from: "bridge.txt",
    to: join("bridge-dir", "bridge-renamed.txt"),
  });
  const downloadTransferId = `download-${Date.now()}`;
  const downloadReady = await sendSshRequest(socket, messages, {
    type: "sftp:download-start",
    transferId: downloadTransferId,
    path: join("bridge-dir", "bridge-renamed.txt"),
  });
  if (downloadReady.name !== "bridge-renamed.txt") {
    throw new Error(`SFTP download name mismatch: ${JSON.stringify(downloadReady)}`);
  }
  await waitForMessage(
    messages,
    (message) =>
      message.type === "sftp:download-end" &&
      message.transferId === downloadTransferId,
  );
  const downloaded = messages
    .filter(
      (message) =>
        message.type === "sftp:download-data" &&
        message.transferId === downloadTransferId,
    )
    .map((message) => decodeBase64(message.data))
    .join("");
  if (downloaded !== "bridge upload\n") {
    throw new Error(`SFTP download content mismatch: ${JSON.stringify(downloaded)}`);
  }

  const directUploadBytes = Buffer.alloc(1536 * 1024, 0x5a);
  const directUploadSource = join(localRoot, "direct-upload-source.bin");
  const directDownloadTarget = join(localRoot, "direct-download-target.bin");
  writeFileSync(directUploadSource, directUploadBytes);
  const directUploadResult = await sendSshTransfer(socket, messages, {
    type: "sftp:upload-from-local",
    localPath: directUploadSource,
    path: "direct-upload.bin",
    size: directUploadBytes.byteLength,
  });
  if (directUploadResult.type !== "sftp:transfer-result") {
    throw new Error(`Direct upload failed: ${JSON.stringify(directUploadResult)}`);
  }
  const remoteDirectUpload = readFileSync(join(remoteRoot, "direct-upload.bin"));
  if (!remoteDirectUpload.equals(directUploadBytes)) {
    throw new Error("Remote content does not match after direct upload.");
  }

  const directUploadConflict = await sendSshTransfer(socket, messages, {
    type: "sftp:upload-from-local",
    localPath: directUploadSource,
    path: "direct-upload.bin",
    size: directUploadBytes.byteLength,
  });
  if (
    directUploadConflict.type !== "sftp:transfer-error" ||
    !String(directUploadConflict.message).includes("EEXIST")
  ) {
    throw new Error(`Direct upload overwrite protection did not take effect: ${JSON.stringify(directUploadConflict)}`);
  }
  const directUploadOverwriteResult = await sendSshTransfer(socket, messages, {
    type: "sftp:upload-from-local",
    localPath: directUploadSource,
    path: "direct-upload.bin",
    size: directUploadBytes.byteLength,
    overwrite: true,
  });
  if (directUploadOverwriteResult.type !== "sftp:transfer-result") {
    throw new Error(`Explicit-overwrite direct upload failed: ${JSON.stringify(directUploadOverwriteResult)}`);
  }
  if (!readFileSync(join(remoteRoot, "direct-upload.bin")).equals(directUploadBytes)) {
    throw new Error("Remote content does not match after explicit-overwrite direct upload.");
  }

  const directDownloadResult = await sendSshTransfer(socket, messages, {
    type: "sftp:download-to-file",
    path: "direct-upload.bin",
    localPath: directDownloadTarget,
    maxBytes: directUploadBytes.byteLength,
  });
  if (directDownloadResult.type !== "sftp:transfer-result") {
    throw new Error(`Direct download failed: ${JSON.stringify(directDownloadResult)}`);
  }
  if (!readFileSync(directDownloadTarget).equals(directUploadBytes)) {
    throw new Error("Local content does not match after direct download.");
  }

  const overwriteConflict = await sendSshTransfer(socket, messages, {
    type: "sftp:download-to-file",
    path: "direct-upload.bin",
    localPath: directDownloadTarget,
    maxBytes: directUploadBytes.byteLength,
  });
  if (
    overwriteConflict.type !== "sftp:transfer-error" ||
    !String(overwriteConflict.message).includes("EEXIST")
  ) {
    throw new Error(`Download overwrite protection did not take effect: ${JSON.stringify(overwriteConflict)}`);
  }
  if (!readFileSync(directDownloadTarget).equals(directUploadBytes)) {
    throw new Error("The original file changed after the download overwrite was rejected.");
  }

  const overwriteResult = await sendSshTransfer(socket, messages, {
    type: "sftp:download-to-file",
    path: "direct-upload.bin",
    localPath: directDownloadTarget,
    maxBytes: directUploadBytes.byteLength,
    overwrite: true,
  });
  if (overwriteResult.type !== "sftp:transfer-result") {
    throw new Error(`Explicit-overwrite download failed: ${JSON.stringify(overwriteResult)}`);
  }

  const relativePathResult = await sendSshTransfer(socket, messages, {
    type: "sftp:download-to-file",
    path: "direct-upload.bin",
    localPath: "relative-download.bin",
    maxBytes: directUploadBytes.byteLength,
  });
  if (
    relativePathResult.type !== "sftp:transfer-error" ||
    !String(relativePathResult.message).includes("absolute path")
  ) {
    throw new Error(`Relative local path was not rejected: ${JSON.stringify(relativePathResult)}`);
  }

  const slowDownloadRemotePath = join(remoteRoot, "slow-download.bin");
  const cancelDownloadLocalPath = join(localRoot, "cancel-download.bin");
  writeFileSync(slowDownloadRemotePath, Buffer.alloc(4 * 1024 * 1024, 0x44));
  slowReadPath = "slow-download.bin";
  const cancelDownloadId = `cancel-download-${Date.now()}`;
  socket.send(
    JSON.stringify({
      type: "sftp:download-to-file",
      transferId: cancelDownloadId,
      path: "slow-download.bin",
      localPath: cancelDownloadLocalPath,
      maxBytes: 4 * 1024 * 1024,
    }),
  );
  await waitForMessage(
    messages,
    (message) =>
      message.type === "sftp:transfer-begin" &&
      message.transferId === cancelDownloadId,
  );
  socket.send(
    JSON.stringify({
      type: "sftp:transfer-cancel",
      transferId: cancelDownloadId,
    }),
  );
  const cancelDownloadResult = await waitForMessage(
    messages,
    (message) =>
      message.type === "sftp:operation-result" &&
      message.action === "cancel-transfer" &&
      message.transferId === cancelDownloadId,
  );
  if (cancelDownloadResult.transferId !== cancelDownloadId) {
    throw new Error(`Download cancellation did not return a confirmation: ${JSON.stringify(cancelDownloadResult)}`);
  }
  slowReadPath = "";
  await new Promise((resolve) => setTimeout(resolve, 700));
  if (existsSync(cancelDownloadLocalPath)) {
    throw new Error("The target file still exists after cancelling the download.");
  }
  if (
    readdirSync(localRoot).some((name) => name.includes(".linktk-part"))
  ) {
    throw new Error("Local temp file was not cleaned up after cancelling the download.");
  }

  const disconnectUploadLocalPath = join(localRoot, "disconnect-upload.bin");
  writeFileSync(disconnectUploadLocalPath, Buffer.alloc(4 * 1024 * 1024, 0x55));
  slowWritePath = ".linktk-part";
  const disconnectUploadId = `disconnect-upload-${Date.now()}`;
  socket.send(
    JSON.stringify({
      type: "sftp:upload-from-local",
      transferId: disconnectUploadId,
      localPath: disconnectUploadLocalPath,
      path: "disconnect-upload.bin",
      size: 4 * 1024 * 1024,
    }),
  );
  await waitForMessage(
    messages,
    (message) =>
      message.type === "sftp:transfer-begin" &&
      message.transferId === disconnectUploadId,
  );
  socket.send(JSON.stringify({ type: "ssh:disconnect" }));
  await waitForMessage(
    messages,
    (message) => message.type === "ssh:status" && message.state === "idle",
  );
  await new Promise((resolve) => setTimeout(resolve, 900));
  slowWritePath = "";
  if (
    readdirSync(remoteRoot).some(
      (name) => name.includes(".linktk-part") || name === "disconnect-upload.bin",
    )
  ) {
    throw new Error("Remote upload temp or target files were not cleaned up after the SSH disconnect.");
  }

  socket.send(
    JSON.stringify({
      type: "ssh:connect",
      host: "127.0.0.1",
      port: sshPort,
      username: "tester",
      password: "secret",
      cols: 100,
      rows: 30,
    }),
  );
  await waitForMessage(
    messages,
    (message) => message.type === "ssh:status" && message.state === "connected",
  );

  await sendSshRequest(socket, messages, {
    type: "sftp:delete",
    path: join("bridge-dir", "bridge-renamed.txt"),
  });
  await sendSshRequest(socket, messages, {
    type: "sftp:delete",
    path: "bridge-dir",
    isDirectory: true,
  });

  socket.send(JSON.stringify({ type: "ssh:disconnect" }));
  await waitForMessage(
    messages,
    (message) => message.type === "ssh:status" && message.state === "idle",
  );

  socket.close();
  socket = null;

  browser = await chromium.launch({
    executablePath: browserPath,
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  // This suite asserts Chinese UI strings, so the page runs in zh-CN
  // (the app itself defaults to English since the i18n change).
  await page.addInitScript(() => {
    const settings = JSON.parse(localStorage.getItem("linktk.settings.v1") || "{}");
    localStorage.setItem(
      "linktk.settings.v1",
      JSON.stringify({ ...settings, uiLanguage: "zh-CN" }),
    );
  });
  await page.goto(`http://127.0.0.1:${vitePort}`, { waitUntil: "networkidle" });
  await page.locator('[data-workspace-mode="network"]').click();
  await page.locator('[data-network-protocol="ssh"]').click();
  await page.waitForFunction(
    () => !document.querySelector("#sshConnectionSummary").hidden,
  );

  const initialUiState = await page.evaluate(() => ({
    monitorHidden: document.querySelector("#networkMonitorPanel").hidden,
    sendHidden: document.querySelector("#networkSendPanel").hidden,
    quickSendHidden: document.querySelector("#networkQuickSendSection").hidden,
    statsHidden: document.querySelector("#networkStatsSection").hidden,
    sshPanelVisible: !document.querySelector("#sshTerminalPanel").hidden,
    summaryVisible: !document.querySelector("#sshConnectionSummary").hidden,
    connectText: document.querySelector("#networkConnectButton span").textContent.trim(),
  }));
  if (
    !initialUiState.monitorHidden ||
    !initialUiState.sendHidden ||
    !initialUiState.quickSendHidden ||
    !initialUiState.statsHidden ||
    !initialUiState.sshPanelVisible ||
    !initialUiState.summaryVisible ||
    initialUiState.connectText !== "连接设置"
  ) {
    throw new Error(`SSH workspace layout is incorrect: ${JSON.stringify(initialUiState)}`);
  }

  await page.locator("#networkConnectButton").click();
  await page.waitForFunction(() => document.querySelector("#sshConnectDialog").open, null, {
    timeout: 5000,
  });
  await page.locator("#sshAlias").fill("local-test");
  await page.locator("#sshHost").fill("203.0.113.136");
  await page.locator("#sshPort").fill(String(sshPort));
  await page.locator("#sshUsername").fill("tester");
  await page.locator("#sshPassword").fill("secret");
  await page.locator("#sshSavePasswordToggle").check({ force: true });
  await page.locator("#saveSshPresetButton").click();
  const savedPreset = await page.evaluate(() => {
    const select = document.querySelector("#sshPresetSelect");
    const stored = JSON.parse(localStorage.getItem("linktk.settings.v1") || "{}");
    return {
      value: select.value,
      selectedText: select.selectedOptions?.[0]?.textContent || "",
      preset: stored.sshPresets?.find((item) => item.id === select.value),
    };
  });
  if (
    !savedPreset.value ||
    savedPreset.selectedText !== "local-test" ||
    savedPreset.preset?.password !== "secret"
  ) {
    throw new Error(`SSH preset was not stored correctly: ${JSON.stringify(savedPreset)}`);
  }
  await page.locator("#sshHost").fill("10.0.0.1");
  await page.locator("#sshPresetSelect").selectOption("");
  await page.locator("#sshPresetSelect").selectOption(savedPreset.value);
  const appliedPreset = await page.evaluate(() => ({
    host: document.querySelector("#sshHost").value,
    port: document.querySelector("#sshPort").value,
    username: document.querySelector("#sshUsername").value,
    password: document.querySelector("#sshPassword").value,
  }));
  if (
    appliedPreset.host !== "203.0.113.136" ||
    appliedPreset.port !== String(sshPort) ||
    appliedPreset.username !== "tester" ||
    appliedPreset.password !== "secret"
  ) {
    throw new Error(`SSH preset was not applied correctly: ${JSON.stringify(appliedPreset)}`);
  }
  const hostFieldFit = await page.locator("#sshHost").evaluate((input) => {
    const style = getComputedStyle(input);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const textWidth = context.measureText(input.value).width;
    const available =
      input.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight) -
      2;
    return {
      value: input.value,
      textWidth,
      available,
    };
  });
  if (hostFieldFit.textWidth > hostFieldFit.available) {
    throw new Error(`SSH host input is too narrow: ${JSON.stringify(hostFieldFit)}`);
  }
  const portFieldFit = await page.locator("#sshPort").evaluate((input) => {
    const style = getComputedStyle(input);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const textWidth = context.measureText(input.value).width;
    const available =
      input.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight) -
      2;
    return {
      value: input.value,
      textWidth,
      available,
    };
  });
  if (portFieldFit.textWidth > portFieldFit.available) {
    throw new Error(`SSH port input is too narrow: ${JSON.stringify(portFieldFit)}`);
  }
  await page.locator("#sshHost").fill("127.0.0.1");
  await page.locator("#confirmSshConnectDialogButton").click();
  await page.waitForFunction(
    () => document.querySelector("#networkHeaderStatusText").textContent === "SSH 已连接",
    null,
    { timeout: 8000 },
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector("#sshTerminalMount .xterm-accessibility-tree")
        ?.textContent.includes("MOCK_SSH_READY"),
    null,
    { timeout: 8000 },
  );
  await page.waitForFunction(
    () => document.querySelector("#agentStateText")?.textContent === "AI 就绪",
    null,
    { timeout: 8000 },
  );

  await page.locator("#sshFileButton").click();
  await page.waitForFunction(
    () => document.querySelector("#sshFileDialog").open,
    null,
    { timeout: 8000 },
  );
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".ssh-file-row__name")].some(
        (element) => element.textContent === "hello.txt",
      ),
    null,
    { timeout: 8000 },
  );
  const fileExplorerLayout = await page.evaluate(() => {
    const workspace = document.querySelector(".ssh-file-workspace");
    const places = document.querySelector(".ssh-file-places");
    const headers = [...document.querySelectorAll(".ssh-file-list-header span")].map(
      (element) => element.textContent.trim(),
    );
    return {
      workspaceDisplay: workspace ? getComputedStyle(workspace).display : "",
      placesWidth: places?.getBoundingClientRect().width || 0,
      headers,
    };
  });
  if (
    fileExplorerLayout.workspaceDisplay !== "grid" ||
    fileExplorerLayout.placesWidth < 120 ||
    fileExplorerLayout.headers.join("|") !== "名称|大小 (KB)|修改时间"
  ) {
    throw new Error(`SSH file explorer layout is incorrect: ${JSON.stringify(fileExplorerLayout)}`);
  }
  const placesText = await page.locator(".ssh-file-places").textContent();
  if (placesText.includes("主目录") || placesText.includes("根目录")) {
    throw new Error(`Legacy SFTP locations are still visible: ${placesText}`);
  }
  await page.locator("#sshFileAddPlaceButton").click();
  await page.waitForFunction(
    () => document.querySelectorAll(".ssh-file-place-item").length === 1,
    null,
    { timeout: 5000 },
  );
  const storedQuickPaths = await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem("linktk.settings.v1") || "{}");
    return stored.sshPresets?.find((preset) => preset.alias === "local-test")?.quickPaths || [];
  });
  if (!storedQuickPaths.includes("/")) {
    throw new Error(`SSH quick path was not stored: ${JSON.stringify(storedQuickPaths)}`);
  }
  await page.locator(".ssh-file-place-delete").click();
  await page.waitForFunction(
    () => document.querySelectorAll(".ssh-file-place-item").length === 0,
    null,
    { timeout: 5000 },
  );
  await page.locator("#closeSshFileButton").click();
  await page.waitForFunction(() => !document.querySelector("#sshFileDialog")?.open);

  await page.locator("#agentActivityButton").click();
  await page.waitForFunction(() => document.querySelector("#agentActivityDialog")?.open);
  await page.locator("#agentActivityControlTab").click();
  await page.locator("#agentApprovalMode").selectOption("confirm-writes");
  await page.locator("#closeAgentActivityButton").click();
  await page.waitForFunction(() => !document.querySelector("#agentActivityDialog")?.open);
  await page.evaluate(() => {
    window.__agentApprovalOpenCount = 0;
    const dialog = document.querySelector("#agentApprovalDialog");
    const originalShowModal = dialog.showModal.bind(dialog);
    dialog.showModal = (...args) => {
      window.__agentApprovalOpenCount += 1;
      return originalShowModal(...args);
    };
  });

  const localAgentUploadPath = join(localRoot, "agent-direct-upload.bin");
  const localAgentDownloadPath = join(localRoot, "agent-direct-download.bin");
  const localAgentBytes = Buffer.alloc(1280 * 1024, 0x33);
  writeFileSync(localAgentUploadPath, localAgentBytes);

  const directAgentUploadPromise = requestAgentCommand("sftp_upload_from_file", {
    transport: "ssh",
    path: "agent-direct.bin",
    localPath: localAgentUploadPath,
    size: localAgentBytes.byteLength,
  });
  await page.waitForFunction(() => document.querySelector("#agentApprovalDialog")?.open);
  await page.locator("#agentApprovalAllowButton").click();
  const directAgentUpload = await directAgentUploadPromise;
  if (Number(directAgentUpload.bytes) !== localAgentBytes.byteLength) {
    throw new Error(`AI direct upload returned an incorrect size: ${JSON.stringify(directAgentUpload)}`);
  }
  if (!readFileSync(join(remoteRoot, "agent-direct.bin")).equals(localAgentBytes)) {
    throw new Error("AI direct upload did not write the correct remote content.");
  }

  await page.evaluate(() => {
    window.__agentApprovalOpenCount = 0;
  });
  const directAgentDownload = await requestAgentCommand("sftp_download_to_file", {
    transport: "ssh",
    path: "agent-direct.bin",
    localPath: localAgentDownloadPath,
    maxBytes: localAgentBytes.byteLength,
  });
  const newPathDownloadApprovalCount = await page.evaluate(
    () => window.__agentApprovalOpenCount,
  );
  if (newPathDownloadApprovalCount !== 0) {
    throw new Error(
      `Downloading to a new path should not open an approval dialog: ${newPathDownloadApprovalCount}`,
    );
  }
  if (
    Number(directAgentDownload.bytes) !== localAgentBytes.byteLength ||
    !readFileSync(localAgentDownloadPath).equals(localAgentBytes)
  ) {
    throw new Error(`AI direct download result is incorrect: ${JSON.stringify(directAgentDownload)}`);
  }

  let downloadConflictError = "";
  try {
    await requestAgentCommand("sftp_download_to_file", {
      transport: "ssh",
      path: "agent-direct.bin",
      localPath: localAgentDownloadPath,
      maxBytes: localAgentBytes.byteLength,
    });
  } catch (error) {
    downloadConflictError = error.message;
  }
  if (!downloadConflictError.includes("EEXIST")) {
    throw new Error(`AI download overwrite protection did not take effect: ${downloadConflictError || "no error"}`);
  }

  const cancelledAgentDownloadPath = join(
    localRoot,
    "agent-cancelled-download.bin",
  );
  slowReadPath = "slow-download.bin";
  slowReadDelayMs = 1500;
  const cancelledDownloadStart = await requestAgentCommand("operation_start", {
    command: "sftp_download_to_file",
    params: {
      transport: "ssh",
      path: "slow-download.bin",
      localPath: cancelledAgentDownloadPath,
      maxBytes: 4 * 1024 * 1024,
    },
  });
  const cancelledDownloadOperationId =
    cancelledDownloadStart?.operation?.operationId ||
    cancelledDownloadStart?.activeOperationId;
  if (!cancelledDownloadOperationId) {
    throw new Error(
      `Cancelled download did not return an operationId: ${JSON.stringify(cancelledDownloadStart)}`,
    );
  }
  await page.waitForFunction(
    () => !document.querySelector("#sshFileCancelButton")?.hidden,
    null,
    { timeout: 8000 },
  );
  await requestAgentCommand("operation_cancel", {
    operationId: cancelledDownloadOperationId,
    transport: "ssh",
  });
  let cancelledDownloadOperation = null;
  const cancelDeadline = Date.now() + 8000;
  while (Date.now() < cancelDeadline) {
    cancelledDownloadOperation = await requestAgentCommand("operation_status", {
      operationId: cancelledDownloadOperationId,
      transport: "ssh",
    });
    if (
      (cancelledDownloadOperation?.status ||
        cancelledDownloadOperation?.operation?.status) === "cancelled"
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  slowReadPath = "";
  slowReadDelayMs = 500;
  if (
    (cancelledDownloadOperation?.status ||
      cancelledDownloadOperation?.operation?.status) !== "cancelled"
  ) {
    throw new Error(
      `Cancelling download did not enter the cancelled state: ${JSON.stringify(cancelledDownloadOperation)}`,
    );
  }
  if (existsSync(cancelledAgentDownloadPath)) {
    throw new Error("The target file still exists after the AI cancelled the download.");
  }
  if (
    readdirSync(localRoot).some((name) => name.includes(".linktk-part"))
  ) {
    throw new Error("Local temp file was not cleaned up after the AI cancelled the download.");
  }

  const overwriteAgentDownloadPromise = requestAgentCommand("sftp_download_to_file", {
    transport: "ssh",
    path: "agent-direct.bin",
    localPath: localAgentDownloadPath,
    overwrite: true,
    maxBytes: localAgentBytes.byteLength,
  });
  await page.waitForFunction(() => document.querySelector("#agentApprovalDialog")?.open);
  await page.locator("#agentApprovalAllowButton").click();
  const overwriteAgentDownload = await overwriteAgentDownloadPromise;
  if (Number(overwriteAgentDownload.bytes) !== localAgentBytes.byteLength) {
    throw new Error(
      `AI explicit-overwrite download result is incorrect: ${JSON.stringify(overwriteAgentDownload)}`,
    );
  }

  await page.evaluate(() => {
    window.__agentApprovalOpenCount = 0;
  });

  const uploadBytes = Buffer.from("approval-scope-upload", "utf8");
  const chunkSize = Math.ceil(uploadBytes.length / 3);
  const uploadChunks = [0, chunkSize, chunkSize * 2].map((offset) =>
    uploadBytes.subarray(offset, offset + chunkSize),
  );
  const beginUploadPromise = requestAgentCommand("sftp_upload_begin", {
    transport: "ssh",
    path: "approval-scope.bin",
    size: uploadBytes.byteLength,
  });
  await page.waitForFunction(() => document.querySelector("#agentApprovalDialog")?.open);
  await page.locator("#agentApprovalAllowButton").click();
  const uploadSession = await beginUploadPromise;
  if (!uploadSession?.uploadId) {
    throw new Error(`SFTP upload begin did not return an uploadId: ${JSON.stringify(uploadSession)}`);
  }

  for (const chunk of uploadChunks) {
    const chunkPromise = requestAgentCommand("sftp_upload_chunk", {
      transport: "ssh",
      uploadId: uploadSession.uploadId,
      dataBase64: chunk.toString("base64"),
    });
    const approvalOpened = await Promise.race([
      chunkPromise.then(() => false),
      page
        .waitForFunction(() => document.querySelector("#agentApprovalDialog")?.open, null, {
          timeout: 1200,
        })
        .then(() => true)
        .catch(() => false),
    ]);
    if (approvalOpened) {
      throw new Error("sftp_upload_chunk requested approval again within the same uploadId.");
    }
    await chunkPromise;
  }

  const endUploadPromise = requestAgentCommand("sftp_upload_end", {
    transport: "ssh",
    uploadId: uploadSession.uploadId,
  });
  const endApprovalOpened = await Promise.race([
    endUploadPromise.then(() => false),
    page
      .waitForFunction(() => document.querySelector("#agentApprovalDialog")?.open, null, {
        timeout: 1200,
      })
      .then(() => true)
      .catch(() => false),
  ]);
  if (endApprovalOpened) {
    throw new Error("sftp_upload_end requested approval again within the same uploadId.");
  }
  await endUploadPromise;
  if (
    readFileSync(join(remoteRoot, "approval-scope.bin"), "utf8") !==
    uploadBytes.toString("utf8")
  ) {
    throw new Error("Approval-scoped upload did not write the correct content.");
  }

  const approvalOpenCount = await page.evaluate(
    () => window.__agentApprovalOpenCount,
  );
  if (approvalOpenCount !== 1) {
    throw new Error(`SFTP chunked upload approval count is incorrect: ${approvalOpenCount}`);
  }
  const uploadOperations = await requestAgentCommand("operation_list", {
    transport: "ssh",
    limit: 10,
  });
  const beginOperation = uploadOperations.operations?.find(
    (operation) => operation.command === "sftp_upload_begin",
  );
  const chunkOperations =
    uploadOperations.operations?.filter(
      (operation) => operation.command === "sftp_upload_chunk",
    ) || [];
  const endOperation = uploadOperations.operations?.find(
    (operation) => operation.command === "sftp_upload_end",
  );
  if (
    beginOperation?.approval !== "approved-once" ||
    chunkOperations.length !== 3 ||
    chunkOperations.some((operation) => operation.approval !== "approved-scope") ||
    endOperation?.approval !== "approved-scope"
  ) {
    throw new Error(
      `SFTP chunked upload approval records are incorrect: ${JSON.stringify({
        begin: beginOperation?.approval,
        chunks: chunkOperations.map((operation) => operation.approval),
        end: endOperation?.approval,
      })}`,
    );
  }

  await page.evaluate(() => {
    window.__agentApprovalOpenCount = 0;
  });

  const ttlUploadBytes = Buffer.from("ttl-scope-upload", "utf8");
  const ttlBeginUploadPromise = requestAgentCommand("sftp_upload_begin", {
    transport: "ssh",
    path: "approval-scope-ttl.bin",
    size: ttlUploadBytes.byteLength,
  });
  await page.waitForFunction(() => document.querySelector("#agentApprovalDialog")?.open);
  await page.locator("#agentApprovalAllowButton").click();
  const ttlUploadSession = await ttlBeginUploadPromise;
  if (!ttlUploadSession?.uploadId) {
    throw new Error(`TTL upload begin did not return an uploadId: ${JSON.stringify(ttlUploadSession)}`);
  }

  await page.evaluate(() => {
    window.__agentApprovalOpenCount = 0;
    window.__linktkRealDateNow = Date.now.bind(Date);
    const base = window.__linktkRealDateNow();
    Date.now = () => base + 5 * 60 * 1000 + 1000;
  });
  const ttlChunkPromise = requestAgentCommand("sftp_upload_chunk", {
    transport: "ssh",
    uploadId: ttlUploadSession.uploadId,
    dataBase64: ttlUploadBytes.toString("base64"),
  }).then(
    (result) => ({ ok: true, result }),
    (error) => ({ ok: false, error: error.message }),
  );
  try {
    await page.waitForFunction(
      () => document.querySelector("#agentApprovalDialog")?.open,
      null,
      { timeout: 8000 },
    );
  } finally {
    await page.evaluate(() => {
      if (window.__linktkRealDateNow) {
        Date.now = window.__linktkRealDateNow;
        delete window.__linktkRealDateNow;
      }
    });
  }
  await page.locator("#agentApprovalAllowButton").click();
  const ttlChunkResult = await ttlChunkPromise;
  if (!ttlChunkResult.ok) {
    throw new Error(`Chunk after TTL expiry did not execute successfully: ${ttlChunkResult.error}`);
  }
  const ttlApprovalCount = await page.evaluate(
    () => window.__agentApprovalOpenCount,
  );
  if (ttlApprovalCount !== 1) {
    throw new Error(`Approval was not re-requested after TTL expiry: ${ttlApprovalCount}`);
  }

  await page.evaluate(() => {
    window.__agentApprovalOpenCount = 0;
  });
  const interruptedBytes = Buffer.from("interrupted-scope", "utf8");
  const interruptedBeginUploadPromise = requestAgentCommand("sftp_upload_begin", {
    transport: "ssh",
    path: "approval-scope-interrupted.bin",
    size: interruptedBytes.byteLength + 4,
  });
  await page.waitForFunction(() => document.querySelector("#agentApprovalDialog")?.open);
  await page.locator("#agentApprovalAllowButton").click();
  const interruptedUploadSession = await interruptedBeginUploadPromise;
  if (!interruptedUploadSession?.uploadId) {
    throw new Error(
      `Interrupted upload begin did not return an uploadId: ${JSON.stringify(interruptedUploadSession)}`,
    );
  }

  await page.evaluate(() => {
    window.__agentApprovalOpenCount = 0;
  });
  await requestAgentCommand("sftp_upload_chunk", {
    transport: "ssh",
    uploadId: interruptedUploadSession.uploadId,
    dataBase64: interruptedBytes.toString("base64"),
  });
  let interruptedEndError = "";
  try {
    await requestAgentCommand("sftp_upload_end", {
      transport: "ssh",
      uploadId: interruptedUploadSession.uploadId,
    });
  } catch (error) {
    interruptedEndError = error.message;
  }
  if (!interruptedEndError.includes("AI 上传数据不完整")) {
    throw new Error(`Upload interruption was not identified correctly: ${interruptedEndError || "no error"}`);
  }
  const interruptedApprovalCountBeforeRetry = await page.evaluate(
    () => window.__agentApprovalOpenCount,
  );
  if (interruptedApprovalCountBeforeRetry !== 0) {
    throw new Error(
      `Approval should not be re-requested before the upload fails: ${interruptedApprovalCountBeforeRetry}`,
    );
  }

  const retryInterruptedChunkPromise = requestAgentCommand("sftp_upload_chunk", {
    transport: "ssh",
    uploadId: interruptedUploadSession.uploadId,
    dataBase64: interruptedBytes.toString("base64"),
  }).then(
    (result) => ({ ok: true, result }),
    (error) => ({ ok: false, error: error.message }),
  );
  await page.waitForFunction(
    () => document.querySelector("#agentApprovalDialog")?.open,
    null,
    { timeout: 8000 },
  );
  await page.locator("#agentApprovalAllowButton").click();
  const retryInterruptedChunkResult = await retryInterruptedChunkPromise;
  if (
    retryInterruptedChunkResult.ok ||
    !retryInterruptedChunkResult.error.includes("AI 上传会话不存在或已结束")
  ) {
    throw new Error(
      `Chunk after upload failure did not go through approval again: ${JSON.stringify(retryInterruptedChunkResult)}`,
    );
  }
  const interruptedApprovalCountAfterRetry = await page.evaluate(
    () => window.__agentApprovalOpenCount,
  );
  if (interruptedApprovalCountAfterRetry !== 1) {
    throw new Error(
      `Chunk re-approval count after upload failure is incorrect: ${interruptedApprovalCountAfterRetry}`,
    );
  }

  await page.evaluate(() => {
    window.__agentApprovalOpenCount = 0;
  });
  const disconnectBytes = Buffer.from("disconnect-scope", "utf8");
  const disconnectBeginUploadPromise = requestAgentCommand("sftp_upload_begin", {
    transport: "ssh",
    path: "approval-scope-disconnect.bin",
    size: disconnectBytes.byteLength,
  });
  await page.waitForFunction(() => document.querySelector("#agentApprovalDialog")?.open);
  await page.locator("#agentApprovalAllowButton").click();
  const disconnectUploadSession = await disconnectBeginUploadPromise;
  if (!disconnectUploadSession?.uploadId) {
    throw new Error(
      `Disconnect-test begin did not return an uploadId: ${JSON.stringify(disconnectUploadSession)}`,
    );
  }

  await page.evaluate(() => {
    window.__agentApprovalOpenCount = 0;
  });
  if (await page.locator("#sshFileDialog").evaluate((dialog) => dialog.open)) {
    await page.locator("#closeSshFileButton").click();
    await page.waitForFunction(
      () => !document.querySelector("#sshFileDialog")?.open,
      null,
      { timeout: 8000 },
    );
  }
  await page.locator("#networkConnectButton").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#networkConnectButton span")?.textContent ===
      "连接设置",
    null,
    { timeout: 8000 },
  );
  await page.locator("#networkConnectButton").click();
  await page.waitForFunction(
    () => document.querySelector("#sshConnectDialog")?.open,
    null,
    { timeout: 8000 },
  );
  await page.locator("#confirmSshConnectDialogButton").click();
  await page.waitForFunction(
    () => document.querySelector("#networkHeaderStatusText")?.textContent === "SSH 已连接",
    null,
    { timeout: 8000 },
  );
  await page.locator("#sshFileButton").click();
  await page.waitForFunction(
    () => document.querySelector("#sshFileDialog")?.open,
    null,
    { timeout: 8000 },
  );

  const reconnectChunkPromise = requestAgentCommand("sftp_upload_chunk", {
    transport: "ssh",
    uploadId: disconnectUploadSession.uploadId,
    dataBase64: disconnectBytes.toString("base64"),
  }).then(
    (result) => ({ ok: true, result }),
    (error) => ({ ok: false, error: error.message }),
  );
  await page.waitForFunction(
    () => document.querySelector("#agentApprovalDialog")?.open,
    null,
    { timeout: 8000 },
  );
  await page.locator("#agentApprovalAllowButton").click();
  const reconnectChunkResult = await reconnectChunkPromise;
  if (!reconnectChunkResult.ok) {
    throw new Error(
      `Chunk after SSH reconnect did not execute successfully: ${reconnectChunkResult.error}`,
    );
  }
  const disconnectApprovalCount = await page.evaluate(
    () => window.__agentApprovalOpenCount,
  );
  if (disconnectApprovalCount !== 1) {
    throw new Error(`Approval was not re-requested after SSH disconnect: ${disconnectApprovalCount}`);
  }

  await page.waitForFunction(
    () => document.querySelector("#sshFileDialog")?.open,
    null,
    { timeout: 8000 },
  );
  await page.locator("#sshFileUploadInput").setInputFiles({
    name: "ui-upload.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("uploaded from ui\n", "utf8"),
  });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".ssh-file-row__name")].some(
        (element) => element.textContent === "ui-upload.txt",
      ),
    null,
    { timeout: 8000 },
  );
  if (readFileSync(join(remoteRoot, "ui-upload.txt"), "utf8") !== "uploaded from ui\n") {
    throw new Error("SSH file dialog upload did not reach the SFTP test server.");
  }

  const helloRow = page
    .locator(".ssh-file-row")
    .filter({ has: page.locator(".ssh-file-row__name", { hasText: "hello.txt" }) });
  await helloRow.click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#sshFileDownloadButton").click();
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  if (
    download.suggestedFilename() !== "hello.txt" ||
    readFileSync(downloadedPath, "utf8") !== "hello from sftp\n"
  ) {
    throw new Error("SSH file dialog download did not return the expected file.");
  }
  await page.screenshot({
    path: join(artifacts, "ssh-file-panel.png"),
    fullPage: true,
  });
  await page.locator("#closeSshFileButton").click();

  const sshInput = page.locator("#sshTerminalMount .xterm-helper-textarea");
  await sshInput.focus();
  await sshInput.pressSequentially("ui-hello", { delay: 20 });
  await sshInput.press("Enter");
  try {
    await page.waitForFunction(
      () =>
        document
          .querySelector("#sshTerminalMount .xterm-accessibility-tree")
          ?.textContent.includes("REMOTE:ui-hello"),
      null,
      { timeout: 8000 },
    );
  } catch (error) {
    const debug = await page.evaluate(() => ({
      active: document.activeElement?.outerHTML || "",
      terminalText:
        document.querySelector("#sshTerminalMount .xterm-accessibility-tree")?.textContent || "",
      status: document.querySelector("#networkHeaderStatusText")?.textContent || "",
    }));
    throw new Error(`${error.message}\n${JSON.stringify(debug)}`);
  }
  await page.screenshot({
    path: join(artifacts, "ssh-workbench.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  await page.screenshot({
    path: join(artifacts, "ssh-workbench-mobile.png"),
    fullPage: true,
  });

  console.log(
    "SSH test passed: shell, presets, absolute paths, quick places, SFTP transfer, resize, and disconnect are working.",
  );
} catch (error) {
  throw new Error(
    `${error.stack || error.message}\nVite output:\n${childOutput.value}`,
  );
} finally {
  await browser?.close();
  socket?.close();
  await new Promise((resolve) => sshServer.close(resolve));
  vite.kill();
  rmSync(remoteRoot, { recursive: true, force: true });
  rmSync(localRoot, { recursive: true, force: true });
}
