import assert from "node:assert/strict";
import test from "node:test";
import { createClipDraftStore } from "../public/piano-roll/clip-draft-store.js";

const clip = (pitch) => ({ notes: [{ note_id: 1, pitch, start_time: 0, duration: 1, velocity: 100 }] });

test("draft store preserves independent dirty clips across context switches", () => {
  const store = createClipDraftStore();
  const first = store.open("a", clip(60), 1);
  first.draft.notes[0].pitch = 61;
  store.markDirty("a");
  const second = store.open("b", clip(70), 1);
  second.draft.notes[0].pitch = 71;
  store.markDirty("b");
  assert.equal(store.get("a").draft.notes[0].pitch, 61);
  assert.equal(store.get("b").draft.notes[0].pitch, 71);
  assert.equal(store.dirtyCount(), 2);
});

test("unrelated server changes safely rebase a dirty clip", () => {
  const store = createClipDraftStore();
  const entry = store.open("a", clip(60), 1);
  entry.draft.notes[0].pitch = 61;
  store.markDirty("a");
  store.reconcile({ version: 2, clips: { a: clip(60), b: clip(72) } });
  assert.equal(entry.baseVersion, 2);
  assert.equal(entry.stale, false);
  assert.equal(entry.draft.notes[0].pitch, 61);
});

test("same-clip server changes mark a dirty draft stale", () => {
  const store = createClipDraftStore();
  const entry = store.open("a", clip(60), 1);
  entry.draft.notes[0].pitch = 61;
  store.markDirty("a");
  store.reconcile({ version: 2, clips: { a: clip(62) } });
  assert.equal(entry.stale, true);
  assert.equal(entry.baseVersion, 1);
  assert.equal(entry.draft.notes[0].pitch, 61);
  assert.equal(store.revert("a").draft.notes[0].pitch, 62);
  assert.equal(store.get("a").baseVersion, 2);
});

test("revert and save clear clip-specific conflict state", () => {
  const store = createClipDraftStore();
  const entry = store.open("a", clip(60), 1);
  entry.draft.notes[0].pitch = 61;
  store.markDirty("a");
  assert.equal(store.revert("a").draft.notes[0].pitch, 60);
  const saved = store.saved("a", clip(63), 3);
  assert.equal(saved.dirty, false);
  assert.equal(saved.stale, false);
  assert.equal(saved.baseVersion, 3);
});
