export function createRnboOscAdapter(config) {
  if (!config.rnbo.enabled) {
    return {
      enabled: false,
      attach() {}
    };
  }

  return {
    enabled: true,
    attach(store) {
      store.events.on("change", (event) => {
        // Placeholder until the RNBO score transport is finalized.
        console.log(`[rnbo] ${event.type} v${event.version} -> ${config.rnbo.host}:${config.rnbo.port}`);
      });
    }
  };
}
