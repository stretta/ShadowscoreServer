const UPGRADE_HANDLED = Symbol.for("shadowscore.websocket.upgrade.handled");

export function markWebSocketUpgradeHandled(request) {
  request[UPGRADE_HANDLED] = true;
}

export function attachUnknownWebSocketFallback(server) {
  const onUpgrade = (request, socket) => {
    setImmediate(() => {
      if (request[UPGRADE_HANDLED] || socket.destroyed) return;
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
    });
  };
  server.on("upgrade", onUpgrade);
  return () => server.off("upgrade", onUpgrade);
}
