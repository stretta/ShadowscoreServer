import test from "node:test";
import assert from "node:assert/strict";
import { activatePreparedBlockTransition } from "../src/playback/block-transition.mjs";

test("section transition activates the prepared table without interrupting transport phase", async () => {
  const sequence = [];
  const result = await activatePreparedBlockTransition({
    nextBlockId: "B",
    rnbo: {
      async applyBlockUpdate(blockId, options) {
        sequence.push(`active:${blockId}:${options.activationMode}:${options.boundary}:${options.reusePrepared}`);
        return { state: "active", activations: [{ targetId: "finch", transactionId: 1201 }] };
      }
    }
  });

  assert.deepEqual(sequence, ["active:B:continue:next-cycle:true"]);
  assert.equal(result.action, "ActivatePrepared");
  assert.deepEqual(result.writes, []);
  assert.equal(result.activations[0].transactionId, 1201);
});

test("section transition prefers the cached READY fast path", async () => {
  const sequence = [];
  const result = await activatePreparedBlockTransition({
    nextBlockId: "B",
    rnbo: {
      async activatePreparedBlock(blockId, options) {
        sequence.push(`fast:${blockId}:${options.boundary}`);
        return { state: "active", fastPath: true, activations: [{ targetId: "finch", transactionId: 1202 }] };
      },
      async applyBlockUpdate() {
        sequence.push("slow");
        throw new Error("slow path should not run");
      }
    }
  });

  assert.deepEqual(sequence, ["fast:B:next-cycle"]);
  assert.equal(result.update.fastPath, true);
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
