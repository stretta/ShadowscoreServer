export function createSerializedOperationQueue() {
  let tail = Promise.resolve();
  let active = false;
  let queued = 0;

  return {
    run(operation) {
      if (typeof operation !== "function") {
        return Promise.reject(new TypeError("serialized operation must be a function"));
      }
      const previous = tail.catch(() => undefined);
      let release;
      tail = new Promise((resolve) => {
        release = resolve;
      });
      queued += 1;
      return previous.then(async () => {
        queued -= 1;
        active = true;
        try {
          return await operation();
        } finally {
          active = false;
          release();
        }
      });
    },
    status() {
      return { active, queued };
    }
  };
}
