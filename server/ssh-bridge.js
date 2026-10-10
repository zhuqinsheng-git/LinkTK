import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  resolve as resolveLocalPath,
} from "node:path";
import ssh2 from "ssh2";
import { WebSocketServer } from "ws";

const { Client } = ssh2;
const { STATUS_CODE } = ssh2.utils.sftp;
const SSH_PATH = "/__ssh";
const OPEN = 1;
const SFTP_FLOW_CHUNK = 32 * 1024;
const SFTP_FLOW_MIN_CHUNK = 32 * 1024;
const SFTP_FLOW_CONCURRENCY = 64;
const SFTP_FLOW_MAX_CONCURRENCY = 64;
const TRANSFER_PROGRESS_INTERVAL_MS = 200;

function sendMessage(socket, message, callback) {
  if (socket?.readyState === OPEN) {
    socket.send(JSON.stringify(message), callback);
  } else {
    callback?.(new Error("SSH bridge connection is closed."));
  }
}

function parsePort(value, fallback = 22) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SSH port must be between 1 and 65535.");
  }
  return port || fallback;
}

function parseSize(value, fallback) {
  const size = Number.parseInt(value, 10);
  return Number.isInteger(size) && size > 0 ? size : fallback;
}

function sftpCall(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (error, ...values) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(values.length <= 1 ? values[0] : values);
    });
  });
}

function normalizeRemotePath(value) {
  const raw = String(value ?? "").trim().replace(/\\/g, "/");
  if (!raw) return ".";

  const absolute = raw.startsWith("/");
  const parts = [];

  raw.split("/").forEach((part) => {
    if (!part || part === ".") return;
    if (part === "..") {
      if (parts.length && parts.at(-1) !== "..") {
        parts.pop();
      } else if (!absolute) {
        parts.push(part);
      }
      return;
    }
    parts.push(part);
  });

  if (absolute) return parts.length ? `/${parts.join("/")}` : "/";
  return parts.length ? parts.join("/") : ".";
}

function parentRemotePath(value) {
  const path = normalizeRemotePath(value);
  if (path === "/") return path;
  const absolute = path.startsWith("/");
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  if (absolute) return `/${parts.join("/")}` || "/";
  return parts.join("/") || ".";
}

function joinRemotePath(base, name) {
  const normalized = normalizeRemotePath(base);
  const cleanName = normalizeRemotePath(name).split("/").filter(Boolean).at(-1);
  if (!cleanName || cleanName === "." || cleanName === "..") {
    throw new Error("File name must not be empty.");
  }
  if (normalized === ".") return cleanName;
  if (normalized === "/") return `/${cleanName}`;
  return `${normalized}/${cleanName}`;
}

function isDirectoryMode(mode) {
  return (Number(mode) & 0o170000) === 0o040000;
}

function remoteBasename(value) {
  const path = normalizeRemotePath(value);
  return path === "/" ? "/" : path.split("/").filter(Boolean).at(-1) || path;
}

function createTransferAbortError() {
  const error = new Error("File transfer was cancelled.");
  error.name = "AbortError";
  return error;
}

function createStatusError(message, code = "EFAIL") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeLocalPath(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.includes("\0")) {
    throw new Error("Local path must not be empty.");
  }
  if (!isAbsolute(raw)) {
    throw new Error("Local path must be an absolute path.");
  }
  const normalized = resolveLocalPath(raw);
  const root = parse(normalized).root;
  if (normalized === root) {
    throw new Error("Local path must not be the root directory.");
  }
  return normalized;
}

function isBlockedLocalPath(localPath) {
  if (process.platform === "win32") {
    const lower = localPath.toLowerCase();
    return (
      lower.startsWith("\\\\") ||
      lower.startsWith("\\\\.\\") ||
      lower.startsWith("\\\\?\\globalroot")
    );
  }
  return (
    localPath === "/proc" ||
    localPath.startsWith("/proc/") ||
    localPath === "/sys" ||
    localPath.startsWith("/sys/") ||
    localPath === "/dev" ||
    localPath.startsWith("/dev/")
  );
}

async function validateLocalUploadPath(value) {
  const requested = normalizeLocalPath(value);
  if (isBlockedLocalPath(requested)) {
    throw new Error("Access to this local system path is not allowed.");
  }
  let stats;
  try {
    stats = await fs.lstat(requested);
  } catch (error) {
    throw createStatusError(`Local file does not exist: ${requested}`, error?.code || "ENOENT");
  }
  if (stats.isSymbolicLink()) {
    throw new Error("AI file transfers are not allowed to use local symbolic links.");
  }
  const canonical = await fs.realpath(requested);
  stats = await fs.stat(canonical);
  if (!stats.isFile()) {
    throw new Error(`Local path is not a regular file: ${canonical}`);
  }
  return canonical;
}

async function validateLocalDownloadPath(value, { overwrite = false } = {}) {
  const requested = normalizeLocalPath(value);
  if (isBlockedLocalPath(requested)) {
    throw new Error("Access to this local system path is not allowed.");
  }
  const parent = dirname(requested);
  const parentStats = await fs.stat(parent).catch((error) => {
    throw createStatusError(`Local directory does not exist: ${parent}`, error?.code || "ENOENT");
  });
  if (!parentStats.isDirectory()) {
    throw new Error(`Local parent path is not a directory: ${parent}`);
  }
  const canonicalParent = await fs.realpath(parent);
  const target = join(canonicalParent, basename(requested));
  let existing = null;
  try {
    existing = await fs.lstat(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (existing) {
    if (existing.isSymbolicLink()) {
      throw new Error("AI file transfers are not allowed to overwrite local symbolic links.");
    }
    if (!existing.isFile()) {
      throw new Error(`Local target is not a regular file: ${target}`);
    }
    if (!overwrite) {
      throw createStatusError(
        `Local file already exists (EEXIST); pass overwrite=true to replace it: ${target}`,
        "EEXIST",
      );
    }
  }
  return { path: target, exists: Boolean(existing) };
}

function makeTransferTempPath(localPath, transferId) {
  const safeId = String(transferId || randomUUID())
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 96);
  return join(dirname(localPath), `.${basename(localPath)}.${safeId}.linktk-part`);
}

function makeRemoteTempPath(remotePath, transferId) {
  const normalized = normalizeRemotePath(remotePath);
  const safeId = String(transferId || randomUUID())
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 96);
  return `${normalized}.${safeId}.linktk-part`;
}

function negotiateSftpChunkSize(sftp, direction, requested) {
  const requestedSize = Math.max(
    SFTP_FLOW_MIN_CHUNK,
    Number.parseInt(requested, 10) || SFTP_FLOW_CHUNK,
  );
  const negotiated = Number(
    direction === "read" ? sftp?._maxReadLen : sftp?._maxWriteLen,
  );
  const limit =
    Number.isFinite(negotiated) && negotiated > 0
      ? negotiated
      : SFTP_FLOW_MIN_CHUNK;
  return Math.max(4096, Math.min(requestedSize, limit));
}

async function closeSftpHandle(sftp, handle) {
  if (!handle) return;
  await sftpCall(sftp, "close", handle).catch(() => {});
}

async function readSftpChunk(sftp, handle, buffer, length, position) {
  return new Promise((resolve, reject) => {
    sftp.read(handle, buffer, 0, length, position, (error, bytesRead, data) => {
      if (error) {
        if (error.code === STATUS_CODE.EOF) {
          resolve(0);
          return;
        }
        reject(error);
        return;
      }
      const dataLength = Buffer.isBuffer(data) ? data.length : 0;
      resolve(Number.isInteger(bytesRead) ? bytesRead : dataLength);
    });
  });
}

async function replaceRemoteFile(sftp, tempPath, targetPath) {
  const target = normalizeRemotePath(targetPath);
  let targetExists = false;
  try {
    const attrs = await sftpCall(sftp, "stat", target);
    targetExists = Boolean(attrs);
  } catch (error) {
    if (error?.code !== STATUS_CODE.NO_SUCH_FILE) throw error;
  }

  if (!targetExists) {
    await sftpCall(sftp, "rename", tempPath, target);
    return;
  }

  let extensionError = null;
  try {
    await sftpCall(sftp, "ext_openssh_rename", tempPath, target);
    return;
  } catch (error) {
    extensionError = error;
  }
  try {
    await sftpCall(sftp, "rename", tempPath, target);
    return;
  } catch (error) {
    throw extensionError || error;
  }
}

async function assertRemoteUploadTargetAvailable(sftp, targetPath, overwrite) {
  if (overwrite) return;
  const target = normalizeRemotePath(targetPath);
  try {
    await sftpCall(sftp, "stat", target);
  } catch (error) {
    if (error?.code === STATUS_CODE.NO_SUCH_FILE) return;
    throw error;
  }
  throw new Error(
    `Remote file already exists (EEXIST); pass overwrite=true to replace it: ${target}`,
  );
}

class SshSession {
  constructor(socket) {
    this.ws = socket;
    this.client = null;
    this.stream = null;
    this.generation = 0;
    this.disposed = false;
    this.connected = false;
    this.fingerprint = "";
    this.config = null;
    this.sftp = null;
    this.sftpPromise = null;
    this.transfers = new Map();
    this.messageQueue = Promise.resolve();
  }

  handle(raw) {
    this.messageQueue = this.messageQueue
      .then(() => this.processMessage(raw))
      .catch((error) => {
        this.sendError(error.message || "SSH operation failed.");
      });
    return this.messageQueue;
  }

  async processMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      this.sendError("Malformed SSH bridge message.");
      return;
    }

    try {
      if (message.type === "ssh:connect") {
        await this.start(message);
      } else if (String(message.type || "").startsWith("sftp:")) {
        await this.handleSftp(message);
      } else if (message.type === "ssh:input") {
        this.input(String(message.data ?? ""));
      } else if (message.type === "ssh:resize") {
        this.resize(message.cols, message.rows);
      } else if (message.type === "ssh:disconnect") {
        await this.stop();
      }
    } catch (error) {
      if (String(message.type || "").startsWith("sftp:")) {
        if (
          message.transferId &&
          (message.type === "sftp:download-to-file" ||
            message.type === "sftp:upload-from-local")
        ) {
          this.sendTransferError(
            message.transferId,
            error.message || "SFTP file transfer failed.",
            message.requestId,
          );
          return;
        }
        this.sendMessage({
          type: "sftp:error",
          requestId: message.requestId || "",
          transferId: message.transferId || "",
          message: error.message || "SFTP operation failed.",
        });
      } else {
        this.sendError(error.message || "SSH operation failed.");
      }
    }
  }

  async start(message) {
    const host = String(message.host || "").trim();
    const username = String(message.username || "").trim();
    const password = String(message.password ?? "");
    const privateKey = String(message.privateKey ?? "");
    const passphrase = String(message.passphrase ?? "");
    const port = parsePort(message.port, 22);

    if (!host) throw new Error("SSH host must not be empty.");
    if (!username) throw new Error("SSH username must not be empty.");
    if (!password && !privateKey) throw new Error("Provide an SSH password or private key.");

    await this.stop({ silent: true, preserveGeneration: true });
    const generation = this.generation + 1;
    this.generation = generation;
    this.connected = false;
    this.fingerprint = "";
    this.config = {
      host,
      port,
      username,
      cols: parseSize(message.cols, 80),
      rows: parseSize(message.rows, 24),
    };

    this.sendStatus("connecting", `Connecting to ${username}@${host}:${port} ...`);

    const client = new Client();
    this.client = client;

    const isCurrent = () => !this.disposed && this.generation === generation;
    const config = {
      host,
      port,
      username,
      password: password || undefined,
      privateKey: privateKey || undefined,
      passphrase: passphrase || undefined,
      readyTimeout: 15000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
      hostHash: "sha256",
      hostVerifier: (hash) => {
        if (isCurrent()) this.fingerprint = hash;
        return true;
      },
    };

    if (password) config.tryKeyboard = true;

    client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
      if (isCurrent() && password) {
        finish(prompts.map(() => password));
      } else {
        finish([]);
      }
    });

    client.on("ready", () => {
      client.setNoDelay(true);
      if (!isCurrent()) return;
      client.shell(
        {
          term: "xterm-256color",
          cols: this.config.cols,
          rows: this.config.rows,
          width: 0,
          height: 0,
        },
        (error, stream) => {
          if (!isCurrent()) return;
          if (error) {
            this.sendError(`SSH terminal failed to start: ${error.message}`);
            this.sendStatus("error", "SSH terminal failed to start.");
            void this.stop({ silent: true });
            return;
          }

          this.stream = stream;
          this.connected = true;
          stream.on("data", (data) => {
            if (isCurrent()) this.sendData(data);
          });
          stream.stderr.on("data", (data) => {
            if (isCurrent()) this.sendData(data);
          });
          stream.on("close", (code, signal) => {
            if (!isCurrent()) return;
            this.sendMessage({
              type: "ssh:exit",
              code: Number.isInteger(code) ? code : null,
              signal: signal || "",
            });
            this.sendStatus("closed", "SSH session has ended.");
            this.connected = false;
            this.stream = null;
          });
          stream.on("error", (streamError) => {
            if (isCurrent()) this.sendError(`SSH terminal error: ${streamError.message}`);
          });
          this.sendStatus(
            "connected",
            `Connected to ${username}@${host}:${port}`,
            { fingerprint: this.fingerprint },
          );
        },
      );
    });

    client.on("error", (error) => {
      if (!isCurrent()) return;
      this.connected = false;
      this.sendError(`SSH connection failed: ${error.message}`);
      this.sendStatus("error", `SSH connection failed: ${error.message}`);
    });

    client.on("close", () => {
      if (!isCurrent()) return;
      if (this.connected) this.sendStatus("closed", "SSH connection closed.");
      this.connected = false;
      this.stream = null;
      this.sftp = null;
      this.sftpPromise = null;
      void this.cleanupTransfers();
      this.client = null;
    });

    client.connect(config);
  }

  input(data) {
    if (!this.connected || !this.stream?.writable) {
      throw new Error("SSH session is not connected.");
    }
    this.stream.write(data);
  }

  resize(cols, rows) {
    if (!this.stream) return;
    const width = parseSize(cols, 80);
    const height = parseSize(rows, 24);
    this.stream.setWindow(height, width, 0, 0);
  }

  async getSftp() {
    if (!this.connected || !this.client) {
      throw new Error("SSH session is not connected.");
    }
    if (this.sftp) return this.sftp;
    if (this.sftpPromise) return this.sftpPromise;

    const client = this.client;
    const generation = this.generation;
    this.sftpPromise = new Promise((resolve, reject) => {
      client.sftp((error, sftp) => {
        this.sftpPromise = null;
        if (error) {
          reject(new Error(`SFTP failed to start: ${error.message}`));
          return;
        }
        if (!this.connected || this.generation !== generation) {
          try {
            sftp.end();
          } catch {
            // The channel may already be closed.
          }
          reject(new Error("SSH session has ended."));
          return;
        }
        this.sftp = sftp;
        sftp.on("close", () => {
          if (this.sftp === sftp) {
            this.sftp = null;
            this.sftpPromise = null;
          }
        });
        sftp.on("error", (sftpError) => {
          if (this.sftp === sftp) {
            this.sftp = null;
            this.sftpPromise = null;
          }
          this.sendError(`SFTP error: ${sftpError.message}`);
        });
        resolve(sftp);
      });
    });
    return this.sftpPromise;
  }

  async resolveRemotePath(sftp, value) {
    const path = normalizeRemotePath(value);
    if (path.startsWith("/")) return path;
    const resolved = await sftpCall(sftp, "realpath", path);
    const candidate =
      typeof resolved === "string"
        ? resolved
        : Array.isArray(resolved)
          ? resolved[0]?.filename
          : resolved?.filename;
    if (!candidate) return path;
    const absolute = normalizeRemotePath(candidate);
    return absolute.startsWith("/") ? absolute : normalizeRemotePath(`/${absolute}`);
  }

  createTransferState(
    transferId,
    { localTempPath = "", remoteTempPath = "", sftp } = {},
  ) {
    const state = {
      cancelled: false,
      localTempPath,
      remoteTempPath,
      localHandle: null,
      remoteHandle: null,
      cleaned: false,
    };
    const cleanup = async () => {
      if (state.cleaned) return;
      state.cleaned = true;
      if (state.localHandle) {
        await state.localHandle.close().catch(() => {});
        state.localHandle = null;
      }
      if (state.remoteHandle) {
        await closeSftpHandle(sftp, state.remoteHandle);
        state.remoteHandle = null;
      }
      if (state.localTempPath) {
        await fs.unlink(state.localTempPath).catch(() => {});
      }
      if (state.remoteTempPath && sftp) {
        await sftpCall(sftp, "unlink", state.remoteTempPath).catch(() => {});
      }
    };
    return {
      state,
      transfer: {
        kind: "local-flow",
        cancel() {
          state.cancelled = true;
        },
        cleanup,
      },
    };
  }

  async startLocalDownload(message) {
    const sftp = await this.getSftp();
    const transferId = String(message.transferId || randomUUID());
    if (this.transfers.has(transferId)) {
      throw new Error("Duplicate SFTP transfer id.");
    }
    const path = await this.resolveRemotePath(sftp, message.path);
    const attrs = await sftpCall(sftp, "stat", path);
    if (isDirectoryMode(attrs?.mode)) {
      throw new Error("SFTP does not support downloading folders directly yet.");
    }
    const total = Math.max(0, Number(attrs?.size) || 0);
    const maxBytes = Number(message.maxBytes);
    if (Number.isFinite(maxBytes) && maxBytes > 0 && total > maxBytes) {
      throw new Error(`Remote file exceeds the ${maxBytes} byte limit.`);
    }
    const overwrite = message.overwrite === true;
    const localTarget = await validateLocalDownloadPath(message.localPath, {
      overwrite,
    });
    const tempPath = makeTransferTempPath(localTarget.path, transferId);
    const { state, transfer } = this.createTransferState(transferId, {
      localTempPath: tempPath,
      sftp,
    });
    this.transfers.set(transferId, transfer);
    try {
      state.localHandle = await fs.open(tempPath, "wx");
      state.remoteHandle = await sftpCall(sftp, "open", path, "r");
    } catch (error) {
      this.transfers.delete(transferId);
      await transfer.cleanup();
      throw error;
    }
    const chunkSize = negotiateSftpChunkSize(sftp, "read", message.chunkSize);
    const concurrency = Math.max(
      1,
      Math.min(
        SFTP_FLOW_MAX_CONCURRENCY,
        Number.parseInt(message.concurrency, 10) || SFTP_FLOW_CONCURRENCY,
      ),
    );
    this.sendMessage({
      type: "sftp:transfer-begin",
      requestId: message.requestId || "",
      transferId,
      direction: "download",
      name: remoteBasename(path),
      total,
      chunkSize,
      concurrency,
    });
    void this.runLocalDownload({
      sftp,
      transferId,
      path,
      target: localTarget.path,
      tempPath,
      total,
      chunkSize,
      concurrency,
      state,
      transfer,
    }).catch((error) => {
      this.sendTransferError(transferId, error.message || "Local download failed.");
    });
  }

  async runLocalDownload({
    sftp,
    transferId,
    path,
    target,
    tempPath,
    total,
    chunkSize,
    concurrency,
    state,
    transfer,
  }) {
    const startedAt = Date.now();
    let done = 0;
    let nextOffset = 0;
    let lastProgressAt = 0;
    const emitProgress = (force = false) => {
      const now = Date.now();
      if (!force && now - lastProgressAt < TRANSFER_PROGRESS_INTERVAL_MS) return;
      lastProgressAt = now;
      this.sendMessage({
        type: "sftp:transfer-progress",
        transferId,
        direction: "download",
        done,
        total,
      });
    };
    const claimRange = () => {
      if (nextOffset >= total) return null;
      const offset = nextOffset;
      const length = Math.min(chunkSize, total - offset);
      nextOffset += length;
      return { offset, length };
    };

    try {
      const workers = Array.from({ length: concurrency }, async () => {
        while (true) {
          if (state.cancelled) throw createTransferAbortError();
          const range = claimRange();
          if (!range) return;
          let written = 0;
          while (written < range.length) {
            if (state.cancelled) throw createTransferAbortError();
            const buffer = Buffer.allocUnsafe(range.length - written);
            const bytesRead = await readSftpChunk(
              sftp,
              state.remoteHandle,
              buffer,
              buffer.length,
              range.offset + written,
            );
            if (state.cancelled) throw createTransferAbortError();
            if (!bytesRead) {
              throw new Error("Remote file read ended early.");
            }
            await state.localHandle.write(
              buffer,
              0,
              bytesRead,
              range.offset + written,
            );
            written += bytesRead;
            done += bytesRead;
            emitProgress();
          }
        }
      });
      await Promise.all(workers);
      if (state.cancelled) throw createTransferAbortError();
      if (done !== total) {
        throw new Error(`Local download size mismatch: expected ${total} bytes, got ${done} bytes.`);
      }
      await state.localHandle.close();
      state.localHandle = null;
      await closeSftpHandle(sftp, state.remoteHandle);
      state.remoteHandle = null;
      await fs.rename(tempPath, target);
      state.localTempPath = "";
      this.transfers.delete(transferId);
      emitProgress(true);
      this.sendMessage({
        type: "sftp:transfer-result",
        transferId,
        direction: "download",
        path,
        localPath: target,
        name: remoteBasename(path),
        bytes: done,
        ms: Date.now() - startedAt,
      });
    } catch (error) {
      this.transfers.delete(transferId);
      await transfer.cleanup();
      throw state.cancelled ? createTransferAbortError() : error;
    }
  }

  async startLocalUpload(message) {
    const sftp = await this.getSftp();
    const transferId = String(message.transferId || randomUUID());
    if (this.transfers.has(transferId)) {
      throw new Error("Duplicate SFTP transfer id.");
    }
    const localPath = await validateLocalUploadPath(message.localPath);
    const localStats = await fs.stat(localPath);
    const total = Math.max(0, Number(localStats.size) || 0);
    const declaredSize = Number(message.size);
    if (
      Number.isFinite(declaredSize) &&
      declaredSize > 0 &&
      declaredSize !== total
    ) {
      throw new Error(`Local file size changed: expected ${declaredSize} bytes, got ${total} bytes.`);
    }
    const path = await this.resolveRemotePath(sftp, message.path);
    await assertRemoteUploadTargetAvailable(
      sftp,
      path,
      message.overwrite === true,
    );
    const tempPath = makeRemoteTempPath(path, transferId);
    const { state, transfer } = this.createTransferState(transferId, {
      remoteTempPath: tempPath,
      sftp,
    });
    state.localPath = localPath;
    this.transfers.set(transferId, transfer);
    try {
      state.localHandle = await fs.open(localPath, "r");
      state.remoteHandle = await sftpCall(sftp, "open", tempPath, "wx");
    } catch (error) {
      this.transfers.delete(transferId);
      await transfer.cleanup();
      throw error;
    }
    const chunkSize = negotiateSftpChunkSize(sftp, "write", message.chunkSize);
    const concurrency = Math.max(
      1,
      Math.min(
        SFTP_FLOW_MAX_CONCURRENCY,
        Number.parseInt(message.concurrency, 10) || SFTP_FLOW_CONCURRENCY,
      ),
    );
    this.sendMessage({
      type: "sftp:transfer-begin",
      requestId: message.requestId || "",
      transferId,
      direction: "upload",
      name: remoteBasename(path),
      total,
      chunkSize,
      concurrency,
    });
    void this.runLocalUpload({
      sftp,
      transferId,
      path,
      tempPath,
      total,
      chunkSize,
      concurrency,
      state,
      transfer,
    }).catch((error) => {
      this.sendTransferError(transferId, error.message || "Local upload failed.");
    });
  }

  async runLocalUpload({
    sftp,
    transferId,
    path,
    tempPath,
    total,
    chunkSize,
    concurrency,
    state,
    transfer,
  }) {
    const startedAt = Date.now();
    let done = 0;
    let nextOffset = 0;
    let lastProgressAt = 0;
    const emitProgress = (force = false) => {
      const now = Date.now();
      if (!force && now - lastProgressAt < TRANSFER_PROGRESS_INTERVAL_MS) return;
      lastProgressAt = now;
      this.sendMessage({
        type: "sftp:transfer-progress",
        transferId,
        direction: "upload",
        done,
        total,
      });
    };
    const claimRange = () => {
      if (nextOffset >= total) return null;
      const offset = nextOffset;
      const length = Math.min(chunkSize, total - offset);
      nextOffset += length;
      return { offset, length };
    };

    try {
      const workers = Array.from({ length: concurrency }, async () => {
        while (true) {
          if (state.cancelled) throw createTransferAbortError();
          const range = claimRange();
          if (!range) return;
          let written = 0;
          while (written < range.length) {
            if (state.cancelled) throw createTransferAbortError();
            const buffer = Buffer.allocUnsafe(range.length - written);
            const readResult = await state.localHandle.read(
              buffer,
              0,
              buffer.length,
              range.offset + written,
            );
            if (state.cancelled) throw createTransferAbortError();
            if (!readResult.bytesRead) {
              throw new Error("Local file read ended early.");
            }
            await sftpCall(
              sftp,
              "write",
              state.remoteHandle,
              buffer,
              0,
              readResult.bytesRead,
              range.offset + written,
            );
            written += readResult.bytesRead;
            done += readResult.bytesRead;
            emitProgress();
          }
        }
      });
      await Promise.all(workers);
      if (state.cancelled) throw createTransferAbortError();
      if (done !== total) {
        throw new Error(`Local upload size mismatch: expected ${total} bytes, got ${done} bytes.`);
      }
      await state.localHandle.close();
      state.localHandle = null;
      await closeSftpHandle(sftp, state.remoteHandle);
      state.remoteHandle = null;
      await replaceRemoteFile(sftp, tempPath, path);
      state.remoteTempPath = "";
      this.transfers.delete(transferId);
      emitProgress(true);
      this.sendMessage({
        type: "sftp:transfer-result",
        transferId,
        direction: "upload",
        path,
        bytes: done,
        name: remoteBasename(path),
        ms: Date.now() - startedAt,
      });
    } catch (error) {
      this.transfers.delete(transferId);
      await transfer.cleanup();
      throw state.cancelled ? createTransferAbortError() : error;
    }
  }

  async handleSftp(message) {
    const sftp = await this.getSftp();
    const requestId = String(message.requestId || "");

    if (message.type === "sftp:download-to-file") {
      await this.startLocalDownload(message);
      return;
    }

    if (message.type === "sftp:upload-from-local") {
      await this.startLocalUpload(message);
      return;
    }

    if (message.type === "sftp:transfer-cancel") {
      const transferId = String(message.transferId || "");
      await this.destroyTransfer(transferId);
      this.sendMessage({
        type: "sftp:operation-result",
        requestId,
        transferId,
        action: "cancel-transfer",
      });
      return;
    }

    if (message.type === "sftp:list") {
      const path = await this.resolveRemotePath(sftp, message.path);
      const list = await sftpCall(sftp, "readdir", path);
      const entries = list
        .filter((entry) => entry?.filename && entry.filename !== "." && entry.filename !== "..")
        .map((entry) => ({
          name: entry.filename,
          mode: Number(entry.attrs?.mode) || 0,
          size: Number(entry.attrs?.size) || 0,
          mtime: Number(entry.attrs?.mtime) || 0,
          isDirectory: isDirectoryMode(entry.attrs?.mode),
        }));
      this.sendMessage({
        type: "sftp:list-result",
        requestId,
        path,
        entries,
      });
      return;
    }

    if (message.type === "sftp:mkdir") {
      const path = normalizeRemotePath(message.path);
      await sftpCall(sftp, "mkdir", path);
      this.sendMessage({ type: "sftp:operation-result", requestId, action: "mkdir", path });
      return;
    }

    if (message.type === "sftp:rename") {
      const from = normalizeRemotePath(message.from);
      const to = normalizeRemotePath(message.to);
      await sftpCall(sftp, "rename", from, to);
      this.sendMessage({
        type: "sftp:operation-result",
        requestId,
        action: "rename",
        path: to,
        from,
      });
      return;
    }

    if (message.type === "sftp:delete") {
      const path = normalizeRemotePath(message.path);
      const action = message.isDirectory ? "rmdir" : "unlink";
      await sftpCall(sftp, action, path);
      this.sendMessage({ type: "sftp:operation-result", requestId, action: "delete", path });
      return;
    }

    if (message.type === "sftp:upload-start") {
      const transferId = String(message.transferId || "");
      if (!transferId) throw new Error("SFTP upload requires a transfer id.");
      if (this.transfers.has(transferId)) throw new Error("Duplicate SFTP upload transfer id.");
      const path = normalizeRemotePath(message.path);
      await assertRemoteUploadTargetAvailable(
        sftp,
        path,
        message.overwrite === true,
      );
      const stream = sftp.createWriteStream(path, { flags: "w", mode: 0o666 });
      await new Promise((resolve, reject) => {
        stream.once("open", resolve);
        stream.once("error", reject);
      });
      this.transfers.set(transferId, { kind: "upload", stream });
      stream.on("error", (streamError) => {
        if (this.transfers.get(transferId)?.stream === stream) {
          this.transfers.delete(transferId);
          this.sendMessage({
            type: "sftp:transfer-error",
            transferId,
            message: `Upload failed: ${streamError.message}`,
          });
        }
      });
      this.sendMessage({
        type: "sftp:upload-ready",
        requestId,
        transferId,
        path,
        size: Number(message.size) || 0,
      });
      return;
    }

    if (message.type === "sftp:upload-chunk") {
      const transferId = String(message.transferId || "");
      const transfer = this.transfers.get(transferId);
      if (!transfer || transfer.kind !== "upload" || !transfer.stream?.writable) {
        throw new Error("The SFTP upload session has ended.");
      }
      const data = Buffer.from(String(message.data || ""), "base64");
      await new Promise((resolve, reject) => {
        transfer.stream.write(data, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      this.sendMessage({
        type: "sftp:chunk-result",
        requestId,
        transferId,
        bytes: data.length,
      });
      return;
    }

    if (message.type === "sftp:upload-end") {
      const transferId = String(message.transferId || "");
      const transfer = this.transfers.get(transferId);
      if (!transfer || transfer.kind !== "upload") {
        throw new Error("The SFTP upload session does not exist.");
      }
      const stream = transfer.stream;
      await new Promise((resolve, reject) => {
        const onClose = () => {
          stream.off("error", onError);
          resolve();
        };
        const onError = (error) => {
          stream.off("close", onClose);
          reject(error);
        };
        stream.once("close", onClose);
        stream.once("error", onError);
        stream.close();
      });
      this.transfers.delete(transferId);
      this.sendMessage({
        type: "sftp:operation-result",
        requestId,
        transferId,
        action: "upload",
      });
      return;
    }

    if (message.type === "sftp:upload-cancel") {
      const transferId = String(message.transferId || "");
      await this.destroyTransfer(transferId);
      this.sendMessage({
        type: "sftp:operation-result",
        requestId,
        transferId,
        action: "cancel-upload",
      });
      return;
    }

    if (message.type === "sftp:download-start") {
      const transferId = String(message.transferId || "");
      if (!transferId) throw new Error("SFTP download requires a transfer id.");
      if (this.transfers.has(transferId)) throw new Error("Duplicate SFTP download transfer id.");
      const path = normalizeRemotePath(message.path);
      const attrs = await sftpCall(sftp, "stat", path);
      if (isDirectoryMode(attrs?.mode)) {
        throw new Error("SFTP does not support downloading folders directly yet.");
      }
      const stream = sftp.createReadStream(path);
      const transfer = { kind: "download", stream };
      this.transfers.set(transferId, transfer);
      stream.on("data", (chunk) => {
        if (this.transfers.get(transferId) !== transfer) return;
        stream.pause();
        this.sendMessage(
          {
            type: "sftp:download-data",
            transferId,
            data: Buffer.from(chunk).toString("base64"),
          },
          (error) => {
            if (error) {
              void this.destroyTransfer(transferId);
              return;
            }
            if (this.transfers.get(transferId) === transfer) stream.resume();
          },
        );
      });
      stream.on("end", () => {
        if (this.transfers.get(transferId) !== transfer) return;
        this.transfers.delete(transferId);
        this.sendMessage({
          type: "sftp:download-end",
          transferId,
          path,
          size: Number(attrs?.size) || 0,
        });
      });
      stream.on("error", (streamError) => {
        if (this.transfers.get(transferId) !== transfer) return;
        this.transfers.delete(transferId);
        this.sendMessage({
          type: "sftp:transfer-error",
          transferId,
          message: `Download failed: ${streamError.message}`,
        });
      });
      stream.pause();
      this.sendMessage(
        {
          type: "sftp:download-ready",
          requestId,
          transferId,
          path,
          name: remoteBasename(path),
          size: Number(attrs?.size) || 0,
        },
        () => {
          if (this.transfers.get(transferId) === transfer) stream.resume();
        },
      );
      return;
    }

    if (message.type === "sftp:download-cancel") {
      const transferId = String(message.transferId || "");
      await this.destroyTransfer(transferId);
      this.sendMessage({
        type: "sftp:operation-result",
        requestId,
        transferId,
        action: "cancel-download",
      });
      return;
    }

    throw new Error(`Unsupported SFTP operation: ${message.type}`);
  }

  async destroyTransfer(transferId) {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return;
    this.transfers.delete(transferId);
    try {
      transfer.stream?.destroy();
    } catch {
      // The stream may already have ended.
    }
    transfer.cancel?.();
    if (transfer.cleanup) await transfer.cleanup();
  }

  async cleanupTransfers() {
    await Promise.all(
      [...this.transfers.keys()].map((transferId) =>
        this.destroyTransfer(transferId),
      ),
    );
  }

  async stop({ silent = false, preserveGeneration = false } = {}) {
    if (!preserveGeneration) this.generation += 1;
    const stream = this.stream;
    const client = this.client;
    this.stream = null;
    this.client = null;
    this.connected = false;
    this.sftp = null;
    this.sftpPromise = null;
    await this.cleanupTransfers();

    if (stream) {
      try {
        stream.end();
      } catch {
        // The server may already have closed the channel.
      }
    }
    if (client) {
      try {
        client.end();
      } catch {
        // The socket may already be closed.
      }
    }

    if (!silent && !this.disposed) {
      this.sendStatus("idle", "SSH session stopped.");
    }
  }

  sendData(data) {
    const bytes = Buffer.from(data);
    this.sendMessage({
      type: "ssh:data",
      data: bytes.toString("base64"),
      at: Date.now(),
    });
  }

  sendStatus(state, message, extra = {}) {
    this.sendMessage({
      type: "ssh:status",
      state,
      message,
      host: this.config?.host || "",
      port: this.config?.port || null,
      ...extra,
    });
  }

  sendError(message) {
    this.sendMessage({ type: "ssh:error", message });
  }

  sendTransferError(transferId, message, requestId = "") {
    this.sendMessage({
      type: "sftp:transfer-error",
      requestId: String(requestId || ""),
      transferId: String(transferId || ""),
      message: String(message || "SFTP file transfer failed."),
    });
  }

  sendMessage(message, callback) {
    sendMessage(this.ws, message, callback);
  }

  async dispose() {
    if (this.disposed) return;
    await this.stop({ silent: true });
    this.disposed = true;
    this.ws = null;
  }
}

class SshBridge {
  constructor() {
    this.sessions = new Set();
    this.servers = new Set();
  }

  attach(httpServer) {
    if (!httpServer || this.servers.has(httpServer)) return;

    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: 2 * 1024 * 1024,
    });
    const onUpgrade = (request, socket, head) => {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      if (pathname !== SSH_PATH) return;
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit("connection", webSocket, request);
      });
    };

    httpServer.on("upgrade", onUpgrade);
    webSocketServer.on("connection", (socket) => {
      const session = new SshSession(socket);
      this.sessions.add(session);
      socket.send(JSON.stringify({ type: "ssh:ready" }));
      socket.on("message", (message) => void session.handle(message));
      socket.on("close", () => {
        this.sessions.delete(session);
        void session.dispose();
      });
      socket.on("error", () => {});
    });

    httpServer.once("close", () => {
      this.servers.delete(httpServer);
      httpServer.off("upgrade", onUpgrade);
      webSocketServer.close();
      this.sessions.forEach((session) => void session.dispose());
      this.sessions.clear();
    });

    this.servers.add(httpServer);
  }
}

export function sshBridgePlugin() {
  const bridge = new SshBridge();
  return {
    name: "linktk-ssh-bridge",
    configureServer(server) {
      bridge.attach(server.httpServer);
    },
    configurePreviewServer(server) {
      bridge.attach(server.httpServer);
    },
  };
}
