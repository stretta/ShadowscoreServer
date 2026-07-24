import assert from "node:assert/strict";
import test from "node:test";
import { suggestedDuplicateBlockId } from "../public/shared/block-id.js";

test("duplicate block suggestions stay within the source family and skip occupied ids", () => {
  assert.equal(suggestedDuplicateBlockId("A", ["A"]), "A1");
  assert.equal(suggestedDuplicateBlockId("A", ["A", "A1"]), "A2");
  assert.equal(suggestedDuplicateBlockId("A1", ["A", "A1"]), "A2");
  assert.equal(suggestedDuplicateBlockId("A1", ["A", "A1", "A2"]), "A3");
  assert.equal(suggestedDuplicateBlockId("Verse", ["Verse", "Verse1"]), "Verse2");
  assert.equal(suggestedDuplicateBlockId("Verse7", ["Verse7", "Verse8"]), "Verse9");
});
