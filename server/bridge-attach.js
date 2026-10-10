import { WebSocketServer } from "ws";

// Attaches a no-server WebSocket bridge on a fixed upgrade path: connections
// create a session, a single ready message is sent, and closing the HTTP
// server tears everything down. Shared by the SSH and network bridges.
function attachWebSocketBridge(httpServer, { sessions, servers, path, createSession, readyType, maxPayload }) {
  if (!httpServer || servers.has(httpServer)) return;

  const webSocketServer = new WebSocketServer({
    noServer: true,
    ...(maxPayload ? { maxPayload } : {}),
  });
  const onUpgrade = (request, socket, head) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname !== path) return;
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  };

  httpServer.on("upgrade", onUpgrade);
  webSocketServer.on("connection", (socket) => {
    const session = createSession(socket);
    sessions.add(session);
    socket.send(JSON.stringify({ type: readyType }));
    socket.on("message", (message) => void session.handle(message));
    socket.on("close", () => {
      sessions.delete(session);
      void session.dispose();
    });
    socket.on("error", () => {});
  });

  httpServer.once("close", () => {
    servers.delete(httpServer);
    httpServer.off("upgrade", onUpgrade);
    webSocketServer.close();
    sessions.forEach((session) => void session.dispose());
    sessions.clear();
  });

  servers.add(httpServer);
}

export { attachWebSocketBridge };
