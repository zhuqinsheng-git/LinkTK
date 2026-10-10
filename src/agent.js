import { t } from "./core/i18n.js";

export class AgentBridgeClient {
  constructor({
    onReady = () => {},
    onRegistered = () => {},
    onControllerState = () => {},
    onLeaseState = () => {},
    onCommand = () => {},
    onWithdraw = () => {},
    onError = () => {},
    onConnectionState = () => {},
  } = {}) {
    this.onReady = onReady;
    this.onRegistered = onRegistered;
    this.onControllerState = onControllerState;
    this.onLeaseState = onLeaseState;
    this.onCommand = onCommand;
    this.onWithdraw = onWithdraw;
    this.onError = onError;
    this.onConnectionState = onConnectionState;
    this.socket = null;
    this.connectPromise = null;
    this.reconnectTimer = null;
    this.closedByUser = false;
  }

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect() {
    if (this.connected) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.closedByUser = false;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/__agent`);
    this.socket = socket;

    this.connectPromise = new Promise((resolve, reject) => {
      socket.addEventListener("open", () => {
        this.connectPromise = null;
        this.onConnectionState(true);
        resolve();
      });
      socket.addEventListener("error", () => {
        this.connectPromise = null;
        reject(new Error(t("agent.channel.connectFailed")));
      });
      socket.addEventListener("message", (event) => this.handleMessage(event.data));
      socket.addEventListener("close", () => {
        this.connectPromise = null;
        this.socket = null;
        this.onConnectionState(false);
        if (!this.closedByUser) this.scheduleReconnect();
      });
    });

    return this.connectPromise;
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.closedByUser) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => this.scheduleReconnect());
    }, 1200);
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      this.onError(t("agent.channel.invalidMessage"));
      return;
    }

    if (message.type === "agent:bridge-ready") {
      this.onReady(message);
    } else if (message.type === "agent:registered") {
      this.onRegistered(message);
    } else if (message.type === "agent:controller") {
      this.onControllerState(message);
    } else if (message.type === "agent:lease") {
      this.onLeaseState(message);
    } else if (message.type === "agent:command") {
      void this.onCommand(message);
    } else if (message.type === "agent:command-withdraw") {
      this.onWithdraw(message);
    }
  }

  async register(details = {}) {
    await this.connect();
    this.send({
      type: "agent:register",
      ...details,
    });
  }

  async updateState(state, capabilities = undefined) {
    if (!this.connected) return;
    const message = { type: "agent:state", state };
    if (capabilities) message.capabilities = capabilities;
    this.send(message);
  }

  respond(id, { ok, result, error } = {}) {
    if (!this.connected) return;
    this.send({
      type: "agent:response",
      id,
      ok: Boolean(ok),
      result,
      error,
    });
  }

  send(message) {
    if (!this.connected) throw new Error(t("agent.channel.notConnected"));
    this.socket.send(JSON.stringify(message));
  }

  close() {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }
}
