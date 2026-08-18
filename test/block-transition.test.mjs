import test from "node:test";
import assert from "node:assert/strict";
import { activatePreparedBlockTransition } from "../src/playback/block-transition.mjs";

test("section transition activates the prepared table without interrupting transport phase", async () => {
  const sequence = [];
  const result = await activatePreparedBlockTransition({
    nextBlockId: "B",
    rnbo: {
      async applyBlockUpdate(blockId, options) {
        sequence.push(`active:${blockId}:${options.activationMode}:${options.reusePrepared}`);
        return { state: "active", activations: [{ targetId: "finch", transactionId: 1201 }] };
      }
    }
  });

  assert.deepEqual(sequence, ["active:B:continue:true"]);
  assert.equal(result.action, "ActivatePrepared");
  assert.deepEqual(result.writes, []);
  assert.equal(result.activations[0].transactionId, 1201);
});

test("section transition never commits when activation is incomplete", async () => {
  await assert.rejects(
    activatePreparedBlockTransition({
      nextBlockId: "B",
      rnbo: { async applyBlockUpdate() { return { state: "saved-not-active" }; } }
    }),
    /did not reach ACTIVE/
  );
});
