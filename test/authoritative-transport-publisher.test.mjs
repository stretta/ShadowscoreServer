import assert from "node:assert/strict";
import test from "node:test";
import { createAuthoritativeTransportPublisher } from "../src/transport/authoritative-transport-publisher.mjs";

test("transport publisher shares one snapshot refresh across every observer", async () => {
  let callback = null;
  let intervalCount = 0;
  let clearCount = 0;
  let loads = 0;
  const publisher = createAuthoritativeTransportPublisher(async () => ({ revision: ++loads }), {
    intervalMs: 500,
    timers: {
      setInterval(next) {
        callback = next;
        intervalCount += 1;
        return 1;
      },
      clearInterval() {
        clearCount += 1;
      }
    }
  });
  const one = [];
  const two = [];

  assert.deepEqual(await publisher.current(), { revision: 1 });
  const unsubscribeOne = publisher.subscribe({ snapshot: (snapshot) => one.push(snapshot.revision) });
  const unsubscribeTwo = publisher.subscribe({ snapshot: (snapshot) => two.push(snapshot.revision) });
  assert.equal(intervalCount, 1);

  callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 2);
  assert.deepEqual(one, [2]);
  assert.deepEqual(two, [2]);

  unsubscribeOne();
  assert.equal(clearCount, 0);
  unsubscribeTwo();
  assert.equal(clearCount, 1);
});
