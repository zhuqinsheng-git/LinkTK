import dgram from "node:dgram";
import net from "node:net";
import { WebSocketServer } from "ws";

const NETWORK_PATH = "/__network";
const OPEN = 1;

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Port must be between 1 and 65535.");
  }
  return port;
}

function parseHost(value) {
  const host = String(value || "").trim();
  return host || "127.0.0.1";
}

function normalizePayload(value) {
  if (!Array.isArray(value)) return Buffer.alloc(0);
  return Buffer.from(value.map((byte) => Number(byte) & 0xff));
}

function remoteAddress(socketOrInfo) {
  const directAddress = socketOrInfo?.address;
  const directPort = socketOrInfo?.port;
  const address =
    typeof directAddress === "string" ? directAddress : socketOrInfo?.remoteAddress || "";
  const port = typeof directPort === "number" ? directPort : socketOrInfo?.remotePort || "";
  return address && port ? `${address}:${port}` : address || "";
}

class NetworkSession {
  constructor(socket) {
    this.ws = socket;
    this.protocol = null;
    this.role = null;
    this.host = "";
    this.port = 0;
    this.tcpServer = null;
    this.tcpSocket = null;
    this.tcpPeers = new Set();
    this.udpSocket = null;
    this.lastUdpRemote = null;
    this.disposed = false;
    this.stopping = false;
  }

  async handle(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      this.sendError("Malformed network bridge message.");
      return;
    }

    try {
      if (message.type === "network:start") {
        await this.start(message);
      } else if (message.type === "network:stop") {
        await this.stop();
      } else if (message.type === "network:send") {
        this.send(normalizePayload(message.payload));
      }
    } catch (error) {
      this.sendError(error.message || "Network operation failed.");
    }
  }

  async start({ protocol, role, host, port }) {
    const nextProtocol = protocol === "udp" ? "udp" : "tcp";
    const nextRole = role === "server" ? "server" : "client";
    const nextHost = parseHost(host);
    const nextPort = parsePort(port);

    await this.stop({ silent: true });
    this.protocol = nextProtocol;
    this.role = nextRole;
    this.host = nextHost;
    this.port = nextPort;

    this.sendStatus("starting", nextRole === "server" ? "Starting server..." : "Connecting...");

    if (nextProtocol === "tcp" && nextRole === "server") {
      await this.startTcpServer();
    } else if (nextProtocol === "tcp") {
      await this.startTcpClient();
    } else if (nextRole === "server") {
      await this.startUdpServer();
    } else {
      await this.startUdpClient();
    }
  }

  async startTcpServer() {
    const server = net.createServer((socket) => this.attachTcpPeer(socket));
    this.tcpServer = server;

    server.on("error", (error) => {
      if (!this.stopping) this.sendStatus("error", `TCP server error: ${error.message}`);
    });

    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once("error", onError);
      server.listen(this.port, this.host, () => {
        server.off("error", onError);
        resolve();
      });
    });

    this.sendStatus("connected", "TCP server started.", {
      connections: 0,
    });
  }

  attachTcpPeer(socket) {
    const remote = remoteAddress(socket);
    this.tcpPeers.add(socket);
    this.sendStatus("connected", "TCP client connected.", {
      connections: this.tcpPeers.size,
      remote,
    });

    socket.on("data", (data) => this.sendData(data, remote));
    socket.on("error", (error) => {
      if (!this.stopping) this.sendError(`TCP client error: ${error.message}`);
    });
    socket.on("close", () => {
      this.tcpPeers.delete(socket);
      if (!this.stopping) {
        this.sendStatus("connected", "TCP client disconnected.", {
          connections: this.tcpPeers.size,
        });
      }
    });
  }

  async startTcpClient() {
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.tcpSocket = socket;

    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        resolve();
      });
    });

    const remote = remoteAddress(socket);
    socket.on("data", (data) => this.sendData(data, remote));
    socket.on("error", (error) => {
      if (!this.stopping) this.sendStatus("error", `TCP connection error: ${error.message}`);
    });
    socket.on("close", () => {
      if (!this.stopping) this.sendStatus("closed", "TCP connection closed.");
    });

    this.sendStatus("connected", "TCP connection established.", {
      connections: 1,
      remote,
    });
  }

  async startUdpServer() {
    const socket = dgram.createSocket("udp4");
    this.udpSocket = socket;

    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      socket.once("error", onError);
      socket.bind(this.port, this.host, () => {
        socket.off("error", onError);
        resolve();
      });
    });

    socket.on("message", (data, info) => {
      this.lastUdpRemote = { address: info.address, port: info.port };
      this.sendData(data, remoteAddress(info));
    });
    socket.on("error", (error) => {
      if (!this.stopping) this.sendStatus("error", `UDP server error: ${error.message}`);
    });

    this.sendStatus("connected", "UDP server started.", {
      connections: 0,
    });
  }

  async startUdpClient() {
    const socket = dgram.createSocket("udp4");
    this.udpSocket = socket;

    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      socket.once("error", onError);
      socket.bind(0, "0.0.0.0", () => {
        socket.off("error", onError);
        const onConnectError = (error) => reject(error);
        socket.once("error", onConnectError);
        socket.connect(this.port, this.host, () => {
          socket.off("error", onConnectError);
          resolve();
        });
      });
    });

    socket.on("message", (data, info) => {
      this.lastUdpRemote = { address: info.address, port: info.port };
      this.sendData(data, remoteAddress(info));
    });
    socket.on("error", (error) => {
      if (!this.stopping) this.sendStatus("error", `UDP client error: ${error.message}`);
    });

    this.sendStatus("connected", "UDP connection established.", {
      remote: `${this.host}:${this.port}`,
    });
  }

  send(payload) {
    if (!payload.byteLength) throw new Error("Send payload is empty.");

    if (this.protocol === "tcp" && this.role === "server") {
      let count = 0;
      this.tcpPeers.forEach((socket) => {
        if (!socket.destroyed && socket.writable) {
          socket.write(payload);
          count += 1;
        }
      });
      if (!count) throw new Error("No connected TCP client.");
      return;
    }

    if (this.protocol === "tcp" && this.tcpSocket?.writable) {
      this.tcpSocket.write(payload);
      return;
    }

    if (this.protocol === "udp" && this.udpSocket) {
      const onSent = (error) => {
        if (error && !this.disposed) this.sendError(`UDP send failed: ${error.message}`);
      };

      if (this.role === "client") {
        this.udpSocket.send(payload, onSent);
        return;
      }

      const target = this.lastUdpRemote;
      if (!target) throw new Error("The UDP server has not received client data yet, so the target address is unknown.");
      this.udpSocket.send(payload, target.port, target.address, onSent);
      return;
    }

    throw new Error("Network session is not connected.");
  }

  async stop({ silent = false } = {}) {
    this.stopping = true;

    if (this.tcpServer) {
      const server = this.tcpServer;
      this.tcpServer = null;
      server.close();
    }

    this.tcpPeers.forEach((socket) => socket.destroy());
    this.tcpPeers.clear();

    if (this.tcpSocket) {
      const socket = this.tcpSocket;
      this.tcpSocket = null;
      socket.destroy();
    }

    if (this.udpSocket) {
      const socket = this.udpSocket;
      this.udpSocket = null;
      await new Promise((resolve) => {
        try {
          socket.close(resolve);
        } catch {
          resolve();
        }
      });
    }

    this.lastUdpRemote = null;
    this.stopping = false;

    if (!silent && !this.disposed) {
      this.sendStatus("idle", "Network session stopped.");
    }
  }

  sendData(bytes, remote = "") {
    this.sendMessage({
      type: "network:data",
      bytes: [...bytes],
      remote,
      at: Date.now(),
    });
  }

  sendStatus(state, message, extra = {}) {
    this.sendMessage({
      type: "network:status",
      state,
      message,
      protocol: this.protocol,
      role: this.role,
      host: this.host,
      port: this.port,
      ...extra,
    });
  }

  sendError(message) {
    this.sendMessage({ type: "network:error", message });
  }

  sendMessage(message) {
    if (this.ws.readyState !== OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  async dispose() {
    if (this.disposed) return;
    await this.stop({ silent: true });
    this.disposed = true;
    this.ws = null;
  }
}

class NetworkBridge {
  constructor() {
    this.sessions = new Set();
    this.servers = new Set();
  }

  attach(httpServer) {
    if (!httpServer || this.servers.has(httpServer)) return;

    const webSocketServer = new WebSocketServer({ noServer: true });
    const onUpgrade = (request, socket, head) => {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      if (pathname !== NETWORK_PATH) return;

      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit("connection", webSocket, request);
      });
    };

    httpServer.on("upgrade", onUpgrade);
    webSocketServer.on("connection", (socket) => {
      const session = new NetworkSession(socket);
      this.sessions.add(session);
      socket.send(JSON.stringify({ type: "network:ready" }));
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

export function networkBridgePlugin() {
  const bridge = new NetworkBridge();
  return {
    name: "serial-workbench-network-bridge",
    configureServer(server) {
      bridge.attach(server.httpServer);
    },
    configurePreviewServer(server) {
      bridge.attach(server.httpServer);
    },
  };
}
