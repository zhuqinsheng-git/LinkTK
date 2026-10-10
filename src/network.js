import { t } from "./core/i18n.js";

export class NetworkBridgeClient {
  constructor({
    onReady = () => {},
    onStatus = () => {},
    onData = () => {},
    onError = () => {},
    onClose = () => {},
  } = {}) {
    this.onReady = onReady;
    this.onStatus = onStatus;
    this.onData = onData;
    this.onError = onError;
    this.onClose = onClose;
    this.socket = null;
    this.connectPromise = null;
    this.closedByUser = false;
  }

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect() {
    if (this.connected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    this.closedByUser = false;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/__network`);
    this.socket = socket;

    this.connectPromise = new Promise((resolve, reject) => {
      socket.addEventListener("open", () => {
        this.connectPromise = null;
        resolve();
      });
      socket.addEventListener("error", () => {
        this.connectPromise = null;
        reject(new Error(t("net.bridge.connectFailed")));
      });
      socket.addEventListener("message", (event) => this.handleMessage(event.data));
      socket.addEventListener("close", () => {
        this.connectPromise = null;
        this.socket = null;
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
      this.onError(t("net.bridge.invalidMessage"));
      return;
    }

    if (message.type === "network:ready") {
      this.onReady();
    } else if (message.type === "network:status") {
      this.onStatus(message);
    } else if (message.type === "network:data") {
      this.onData(new Uint8Array(message.bytes || []), message.remote || "", message.at);
    } else if (message.type === "network:error") {
      this.onError(message.message || t("net.bridge.operationFailed"));
    }
  }

  async start({ protocol, role, host, port }) {
    await this.sendCommand({
      type: "network:start",
      protocol,
      role,
      host,
      port,
    });
  }

  async stop() {
    await this.sendCommand({ type: "network:stop" });
  }

  async send(bytes) {
    await this.sendCommand({
      type: "network:send",
      payload: [...bytes],
    });
  }

  async sendCommand(message) {
    await this.connect();
    this.socket.send(JSON.stringify(message));
  }

  close() {
    this.closedByUser = true;
    this.socket?.close();
    this.socket = null;
  }
}
