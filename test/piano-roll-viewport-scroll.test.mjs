import test from "node:test";
import assert from "node:assert/strict";
import { playheadScrollLeft, shouldFollowPlayhead, timelineGridStep, timelineLabelInterval, zoomAnchorScrollLeft } from "../public/piano-roll/viewport-scroll.js";

test("page chase advances only after the playhead leaves the visible page", () => {
  const common={mode:"pages",viewportWidth:500,contentWidth:2000,gutterWidth:58};
  assert.equal(playheadScrollLeft({...common,playheadX:499,scrollLeft:0}),0);
  assert.equal(playheadScrollLeft({...common,playheadX:500,scrollLeft:0}),442);
  assert.equal(playheadScrollLeft({...common,playheadX:1700,scrollLeft:442}),1500);
});

test("centered chase naturally traverses the opening and ending half pages", () => {
  const common={mode:"centered",viewportWidth:500,contentWidth:2000,gutterWidth:58};
  assert.equal(playheadScrollLeft({...common,playheadX:120,scrollLeft:0}),0);
  assert.equal(playheadScrollLeft({...common,playheadX:900,scrollLeft:0}),650);
  assert.equal(playheadScrollLeft({...common,playheadX:1900,scrollLeft:650}),1500);
});

test("scroll chase follows any fresh wiper witness, not only macro rolling", () => {
  assert.equal(shouldFollowPlayhead({beat:12,running:false,stale:false}),true);
  assert.equal(shouldFollowPlayhead({beat:12,running:true,stale:true}),false);
  assert.equal(shouldFollowPlayhead({beat:NaN,running:true,stale:false}),false);
});

test("time zoom keeps the beat under the viewport center", () => {
  assert.equal(zoomAnchorScrollLeft({oldBeatWidth:50,newBeatWidth:100,scrollLeft:200,viewportWidth:500,contentWidth:4000,gutterWidth:58}),592);
});

test("overview zoom thins grid lines and ruler labels without changing musical alignment", () => {
  assert.equal(timelineGridStep(0.25,72),0.25);
  assert.equal(timelineGridStep(0.25,4),1);
  assert.equal(timelineLabelInterval(72,4),1);
  assert.equal(timelineLabelInterval(4,4),12);
});
