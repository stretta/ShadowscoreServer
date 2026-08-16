import test from "node:test";
import assert from "node:assert/strict";
import { activatePreparedBlockTransition } from "../src/playback/block-transition.mjs";

test("section transition requires ACTIVE before resetting every client to stage zero", async () => {
  const sequence = [];
  const result = await activatePreparedBlockTransition({
    nextBlockId: "B",
    rnbo: {
      async applyBlockUpdate(blockId, options) {
        sequence.push(`active:${blockId}:${options.activationMode}:${options.reusePrepared}`);
        return { state: "active", activations: [{ targetId: "finch", transactionId: 1201 }] };
      }
    },
    async resetPhase() {
      sequence.push("phase:SetStage:0");
      return [{ targetId: "finch", value: 0 }];
    }
  });

  assert.deepEqual(sequence, ["active:B:continue:true", "phase:SetStage:0"]);
  assert.equal(result.action, "ActivatePrepared");
  assert.deepEqual(result.writes, [{ targetId: "finch", value: 0 }]);
  assert.equal(result.activations[0].transactionId, 1201);
});

test("section transition never resets phase or commits when activation is incomplete", async () => {
  let resetCount = 0;
  await assert.rejects(
    activatePreparedBlockTransition({
      nextBlockId: "B",
      rnbo: { async applyBlockUpdate() { return { state: "saved-not-active" }; } },
      async resetPhase() { resetCount += 1; return []; }
    }),
    /did not reach ACTIVE/
  );
  assert.equal(resetCount, 0);
});
