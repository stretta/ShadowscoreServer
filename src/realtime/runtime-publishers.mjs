export function runtimePublisher(runtime, name, create) {
  runtime.realtimePublishers ??= new Map();
  if (!runtime.realtimePublishers.has(name)) {
    runtime.realtimePublishers.set(name, create());
  }
  return runtime.realtimePublishers.get(name);
}

export function closeRuntimePublishers(runtime) {
  for (const publisher of runtime.realtimePublishers?.values?.() ?? []) {
    publisher?.close?.();
  }
  runtime.realtimePublishers?.clear?.();
}
