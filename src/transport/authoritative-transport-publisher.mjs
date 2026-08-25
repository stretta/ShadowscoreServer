import { createLoadedPublisher } from "../realtime/publisher.mjs";

export function createAuthoritativeTransportPublisher(loadSnapshot, options = {}) {
  return createLoadedPublisher(loadSnapshot, {
    ...options,
    intervalMs: options.intervalMs ?? 500
  });
}
