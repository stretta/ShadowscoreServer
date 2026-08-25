import crypto from "node:crypto";
import { attachWebSocketEndpoint } from "../realtime/websocket-endpoint.mjs";
import { createCollaborationHub } from "./protocol-v1.mjs";

export { createCollaborationHub } from "./protocol-v1.mjs";

export function attachWebSocketCollaboration(server, store, config, options = {}) {
  const hub = options.hub ?? createCollaborationHub(store, config);
  const clientsById = new Map();
  const endpoint = attachWebSocketEndpoint(server, {
    ...options,
    path: options.path ?? "/collab",
    messageMode: "json",
    onConnection(connection, request) {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      const clientId = url.searchParams.get("clientId") || crypto.randomUUID();
      clientsById.get(clientId)?.close(4001, "replaced by newer connection");
      const client = {
        id: clientId,
        onClose: null,
        onMessage: null,
        sendJson(payload) {
          connection.sendJson(payload, { critical: true });
        },
        close(code = 1000, reason = "") {
          connection.close(code, reason);
        }
      };
      clientsById.set(clientId, client);
      connection.onMessage = (payload) => client.onMessage?.(payload);
      connection.onClose = () => {
        if (clientsById.get(clientId) === client) clientsById.delete(clientId);
        client.onClose?.();
      };
      hub.addClient(client);
    }
  });

  return {
    ...hub,
    close() {
      hub.close();
      clientsById.clear();
      endpoint.close();
    },
    getConnectionCount() {
      return endpoint.getConnectionCount();
    }
  };
}
