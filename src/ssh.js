import { t } from "./core/i18n.js";

const SFTP_CHUNK_SIZE = 256 * 1024;

export class SshBridgeClient {
  constructor({
    onReady = () => {},
    onStatus = () => {},
    onData = () => {},
    onExit = () => {},
    onError = () => {},
    onClose = () => {},
  } = {}) {
    this.onReady = onReady;
    this.onStatus = onStatus;
    this.onData = onData;
    this.onExit = onExit;
    this.onError = onError;
    this.onClose = onClose;
    this.socket = null;
    this.connectPromise = null;
    this.closedByUser = false;
    this.requestSequence = 0;
    this.pendingRequests = new Map();
    this.downloadTasks = new Map();
    this.localTransferTasks = new Map();
  }

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect() {
    if (this.connected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.closedByUser = false;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/__ssh`);
    this.socket = socket;

    this.connectPromise = new Promise((resolve, reject) => {
      socket.addEventListener("open", () => {
        this.connectPromise = null;
        resolve();
      });
      socket.addEventListener("error", () => {
        this.connectPromise = null;
        reject(new Error(t("ssh.bridge.connectFailed")));
      });
      socket.addEventListener("message", (event) => this.handleMessage(event.data));
      socket.addEventListener("close", () => {
        this.connectPromise = null;
        this.socket = null;
        this.rejectPending(new Error(t("ssh.status.bridgeClosed")));
        this.onClose();
      });
    });

    return this.connectPromise;
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      this.onError(t("ssh.bridge.invalidMessage"));
      return;
    }

    if (message.type === "ssh:ready") {
      this.onReady();
    } else if (message.type === "ssh:status") {
      this.onStatus(message);
    } else if (message.type === "ssh:data") {
      this.onData(decodeBase64(message.data || ""));
    } else if (message.type === "ssh:exit") {
      this.onExit(message);
    } else if (message.type === "ssh:error") {
      this.onError(message.message || t("ssh.bridge.operationFailed"));
    } else if (String(message.type || "").startsWith("sftp:")) {
      this.handleSftpMessage(message);
    }
  }

  handleSftpMessage(message) {
    if (message.type === "sftp:error") {
      const error = new Error(message.message || t("ssh.bridge.sftpFailed"));
      const pending = this.pendingRequests.get(message.requestId);
      if (pending) {
        this.pendingRequests.delete(message.requestId);
        clearTimeout(pending.timer);
        pending.reject(error);
        return;
      }
      const localTask = this.localTransferTasks.get(message.transferId);
      if (localTask) {
        this.finishLocalTransfer(message.transferId, error);
        return;
      }
      const task = this.downloadTasks.get(message.transferId);
      if (task) {
        this.finishDownload(message.transferId, error);
        return;
      }
      this.onError(error.message);
      return;
    }

    if (message.type === "sftp:transfer-begin") {
      const task = this.localTransferTasks.get(message.transferId);
      if (task) {
        task.total = Number(message.total) || task.total;
        task.name = String(message.name || task.name);
        task.onProgress?.({
          done: 0,
          total: task.total,
          direction: task.direction,
          name: task.name,
        });
      }
      // Validation errors use sftp:error, while a successful start resolves the
      // request below through the generic requestId handler.
    } else if (message.type === "sftp:transfer-progress") {
      const task = this.localTransferTasks.get(message.transferId);
      if (!task) return;
      task.total = Number(message.total) || task.total;
      task.onProgress?.({
        done: Number(message.done) || 0,
        total: task.total,
        direction: task.direction,
        name: task.name,
      });
      return;
    } else if (message.type === "sftp:transfer-result") {
      const task = this.localTransferTasks.get(message.transferId);
      if (!task) return;
      this.finishLocalTransfer(message.transferId, null, message);
      return;
    } else if (message.type === "sftp:transfer-error") {
      const pending = this.pendingRequests.get(message.requestId);
      if (pending) {
        this.pendingRequests.delete(message.requestId);
        clearTimeout(pending.timer);
        pending.reject(new Error(message.message || t("ssh.bridge.transferFailed")));
      }
      const localTask = this.localTransferTasks.get(message.transferId);
      if (localTask) {
        this.finishLocalTransfer(
          message.transferId,
          new Error(message.message || t("ssh.bridge.transferFailed")),
        );
        return;
      }
      const task = this.downloadTasks.get(message.transferId);
      if (task) {
        this.finishDownload(
          message.transferId,
          new Error(message.message || t("ssh.bridge.transferFailed")),
        );
        return;
      }
      this.onError(message.message || t("ssh.bridge.transferFailed"));
      return;
    }

    if (message.type === "sftp:download-data") {
      const task = this.downloadTasks.get(message.transferId);
      if (!task) return;
      const chunk = decodeBase64(message.data || "");
      task.chunks.push(chunk);
      task.received += chunk.byteLength;
      task.onProgress?.({
        received: task.received,
        total: task.total,
        name: task.name,
      });
      return;
    }

    if (message.type === "sftp:download-end") {
      const task = this.downloadTasks.get(message.transferId);
      if (!task) return;
      task.total = Number(message.size) || task.total;
      this.finishDownload(message.transferId);
      return;
    }

    const pending = this.pendingRequests.get(message.requestId);
    if (!pending) return;
    this.pendingRequests.delete(message.requestId);
    clearTimeout(pending.timer);
    pending.resolve(message);
  }

  async connectSession({ host, port, username, password, privateKey, passphrase, cols, rows }) {
    await this.sendCommand({
      type: "ssh:connect",
      host,
      port,
      username,
      password,
      privateKey,
      passphrase,
      cols,
      rows,
    });
  }

  async input(data) {
    await this.sendCommand({ type: "ssh:input", data: String(data) });
  }

  async resize(cols, rows) {
    await this.sendCommand({ type: "ssh:resize", cols, rows });
  }

  async disconnect() {
    await this.sendCommand({ type: "ssh:disconnect" });
  }

  async listDirectory(path = ".") {
    return this.requestSftp({ type: "sftp:list", path });
  }

  async makeDirectory(path) {
    return this.requestSftp({ type: "sftp:mkdir", path });
  }

  async renameEntry(from, to) {
    return this.requestSftp({ type: "sftp:rename", from, to });
  }

  async deleteEntry(path, isDirectory = false) {
    return this.requestSftp({ type: "sftp:delete", path, isDirectory });
  }

  async uploadFile(
    file,
    remotePath,
    { onProgress = () => {}, signal, overwrite = false } = {},
  ) {
    const transferId = createTransferId("upload");
    await this.requestSftp({
      type: "sftp:upload-start",
      transferId,
      path: remotePath,
      size: file.size,
      overwrite: Boolean(overwrite),
    });

    try {
      let uploaded = 0;
      for (let offset = 0; offset < file.size; offset += SFTP_CHUNK_SIZE) {
        if (signal?.aborted) throw createAbortError();
        const chunk = new Uint8Array(
          await file.slice(offset, offset + SFTP_CHUNK_SIZE).arrayBuffer(),
        );
        await this.requestSftp(
          {
            type: "sftp:upload-chunk",
            transferId,
            data: encodeBase64(chunk),
          },
          60000,
        );
        uploaded += chunk.byteLength;
        onProgress({ uploaded, total: file.size, name: file.name });
      }
      if (signal?.aborted) throw createAbortError();
      await this.requestSftp({ type: "sftp:upload-end", transferId }, 60000);
      onProgress({ uploaded: file.size, total: file.size, name: file.name });
      return { bytes: file.size, name: file.name };
    } catch (error) {
      await this.sendCommand({ type: "sftp:upload-cancel", transferId }).catch(() => {});
      throw error;
    }
  }

  downloadFile(remotePath, { onProgress = () => {}, signal } = {}) {
    const transferId = createTransferId("download");
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        void this.sendCommand({ type: "sftp:download-cancel", transferId }).catch(() => {});
        this.finishDownload(transferId, createAbortError());
      };
      const task = {
        transferId,
        chunks: [],
        received: 0,
        total: 0,
        name: remotePath.split("/").filter(Boolean).at(-1) || "download.bin",
        onProgress,
        resolve,
        reject,
        signal,
        onAbort,
      };
      this.downloadTasks.set(transferId, task);
      signal?.addEventListener("abort", onAbort, { once: true });

      this.requestSftp({ type: "sftp:download-start", transferId, path: remotePath })
        .then((message) => {
          if (this.downloadTasks.get(transferId) !== task) return;
          task.total = Number(message.size) || 0;
          task.name = String(message.name || task.name);
          onProgress({ received: 0, total: task.total, name: task.name });
        })
        .catch((error) => this.finishDownload(transferId, error));
    });
  }

  downloadToLocal({
    remotePath,
    localPath,
    overwrite = false,
    maxBytes,
    onProgress = () => {},
    signal,
  } = {}) {
    const transferId = createTransferId("download-local");
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        void this.sendCommand({
          type: "sftp:transfer-cancel",
          transferId,
        }).catch(() => {});
        this.finishLocalTransfer(transferId, createAbortError());
      };
      const task = {
        transferId,
        direction: "download",
        total: 0,
        name: String(remotePath || "").split("/").filter(Boolean).at(-1) || "download.bin",
        onProgress,
        resolve,
        reject,
        signal,
        onAbort,
      };
      this.localTransferTasks.set(transferId, task);
      signal?.addEventListener("abort", onAbort, { once: true });

      this.requestSftp(
        {
          type: "sftp:download-to-file",
          transferId,
          path: remotePath,
          localPath,
          overwrite: Boolean(overwrite),
          maxBytes,
        },
        20000,
      ).catch((error) => this.finishLocalTransfer(transferId, error));
    });
  }

  uploadFromLocal({
    localPath,
    remotePath,
    size,
    overwrite = false,
    onProgress = () => {},
    signal,
  } = {}) {
    const transferId = createTransferId("upload-local");
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        void this.sendCommand({
          type: "sftp:transfer-cancel",
          transferId,
        }).catch(() => {});
        this.finishLocalTransfer(transferId, createAbortError());
      };
      const task = {
        transferId,
        direction: "upload",
        total: Math.max(0, Number(size) || 0),
        name: String(remotePath || "").split("/").filter(Boolean).at(-1) || "upload.bin",
        onProgress,
        resolve,
        reject,
        signal,
        onAbort,
      };
      this.localTransferTasks.set(transferId, task);
      signal?.addEventListener("abort", onAbort, { once: true });

      this.requestSftp(
        {
          type: "sftp:upload-from-local",
          transferId,
          localPath,
          path: remotePath,
          size,
          overwrite: Boolean(overwrite),
        },
        20000,
      ).catch((error) => this.finishLocalTransfer(transferId, error));
    });
  }

  async requestSftp(message, timeoutMs = 20000) {
    await this.connect();
    const requestId = createRequestId();
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(t("ssh.bridge.transferTimeout")));
      }, timeoutMs);
      this.pendingRequests.set(requestId, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ ...message, requestId }));
      } catch (error) {
        this.pendingRequests.delete(requestId);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  finishDownload(transferId, error = null) {
    const task = this.downloadTasks.get(transferId);
    if (!task) return;
    this.downloadTasks.delete(transferId);
    task.signal?.removeEventListener("abort", task.onAbort);
    if (error) {
      task.reject(error);
      return;
    }
    task.resolve({
      blob: new Blob(task.chunks, { type: "application/octet-stream" }),
      name: task.name,
      size: task.received,
    });
  }

  finishLocalTransfer(transferId, error = null, result = null) {
    const task = this.localTransferTasks.get(transferId);
    if (!task) return;
    this.localTransferTasks.delete(transferId);
    task.signal?.removeEventListener("abort", task.onAbort);
    if (error) {
      task.reject(error);
      return;
    }
    task.resolve(result);
  }

  rejectPending(error) {
    this.pendingRequests.forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(error);
    });
    this.pendingRequests.clear();
    [...this.downloadTasks.keys()].forEach((transferId) =>
      this.finishDownload(transferId, error),
    );
    [...this.localTransferTasks.keys()].forEach((transferId) =>
      this.finishLocalTransfer(transferId, error),
    );
  }

  async sendCommand(message) {
    await this.connect();
    this.socket.send(JSON.stringify(message));
  }

  close() {
    this.closedByUser = true;
    this.rejectPending(new Error(t("ssh.status.bridgeClosed")));
    this.socket?.close();
    this.socket = null;
  }
}

function createRequestId() {
  return crypto.randomUUID?.() || `sftp-request-${Date.now()}-${Math.random()}`;
}

function createTransferId(kind) {
  return `${kind}-${crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`}`;
}

function createAbortError() {
  return new DOMException(t("ssh.bridge.transferCancelled"), "AbortError");
}

function decodeBase64(value) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBase64(bytes) {
  let binary = "";
  const stride = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += stride) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + stride));
  }
  return window.btoa(binary);
}
