export function createRealtimeTopicBroker(definitions) {
  const states = new Map(Object.entries(definitions).map(([name, definition]) => [name, {
    definition,
    sequence: 0,
    subscribers: new Set(),
    unsubscribe: null
  }]));

  return {
    topics(role = "observer") {
      return [...states.entries()]
        .filter(([, state]) => isAuthorized(state.definition, role))
        .map(([name, state]) => ({ name, version: state.definition.version ?? 1 }));
    },
    async current(name, role = "observer") {
      const state = requireTopic(states, name, role);
      const payload = await state.definition.publisher.current();
      return topicMessage(name, state, "snapshot", payload);
    },
    subscribe(name, role, observer) {
      const state = requireTopic(states, name, role);
      state.subscribers.add(observer);
      if (!state.unsubscribe) {
        state.unsubscribe = state.definition.publisher.subscribe((message) => {
          state.sequence += 1;
          const published = topicMessage(name, state, message.event, serializablePayload(message.payload));
          for (const subscriber of state.subscribers) subscriber(published);
        });
      }
      return () => {
        state.subscribers.delete(observer);
        if (!state.subscribers.size && state.unsubscribe) {
          state.unsubscribe();
          state.unsubscribe = null;
        }
      };
    },
    close() {
      for (const state of states.values()) {
        state.subscribers.clear();
        state.unsubscribe?.();
        state.unsubscribe = null;
      }
    }
  };
}

function requireTopic(states, name, role) {
  const state = states.get(name);
  if (!state) throw protocolError("unknown_topic", `unknown realtime topic '${name}'`);
  if (!isAuthorized(state.definition, role)) {
    throw protocolError("topic_forbidden", `role '${role}' cannot subscribe to '${name}'`);
  }
  return state;
}

function isAuthorized(definition, role) {
  return !definition.roles || definition.roles.includes(role);
}

function topicMessage(topic, state, eventType, payload) {
  return {
    topic,
    topicVersion: state.definition.version ?? 1,
    sequence: state.sequence,
    eventType,
    payload
  };
}

function serializablePayload(payload) {
  if (payload instanceof Error) return { error: payload.message };
  return payload;
}

function protocolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
