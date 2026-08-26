import test from "node:test";
import assert from "node:assert/strict";
import { rnboFlowControlEvidence, rnboScoreDeliveryProfile, rnboTargetTransferConcurrency } from "../src/playback/rnbo-flow-control.mjs";

test("RNBO flow control keeps unadvertised receivers on one-row pacing", () => {
  const config = { rnbo: { sendBatchSize: 8, sendDelayMs: 5, oscQuery: { enabled: true } } };
  const target = { capabilities: {} };
  assert.deepEqual(rnboScoreDeliveryProfile(config, target, 0), {
    attempt: 0,
    batchSize: 1,
    delayMs: 5,
    mode: "normal"
  });
  assert.deepEqual(rnboFlowControlEvidence(config, target, { batchSize: 1 }), {
    requestedBatchSize: 8,
    effectiveBatchSize: 1,
    boundedIngestionAdvertised: false,
    receiverMaxBatchSize: 1,
    acknowledgement: "none"
  });
});

test("RNBO flow control requires bounded ingestion, commit ACK, and ACK polling", () => {
  const target = { capabilities: {
    boundedScoreBatchIngestion: true,
    maxScoreBatchRows: 4,
    scoreBatchAcknowledgement: "commit"
  } };
  const enabled = { rnbo: { sendBatchSize: 8, sendDelayMs: 0, ack: { enabled: true } } };
  assert.equal(rnboScoreDeliveryProfile(enabled, target, 0).batchSize, 4);
  assert.equal(rnboScoreDeliveryProfile(enabled, target, 1).batchSize, 2);
  assert.equal(rnboScoreDeliveryProfile({ rnbo: { ...enabled.rnbo, ack: { enabled: false } } }, target, 0).batchSize, 1);
  assert.equal(rnboScoreDeliveryProfile(enabled, {
    capabilities: { ...target.capabilities, scoreBatchAcknowledgement: "none" }
  }, 0).batchSize, 1);
});

test("RNBO target fanout defaults to two and remains explicitly configurable", () => {
  assert.equal(rnboTargetTransferConcurrency({ rnbo: {} }), 2);
  assert.equal(rnboTargetTransferConcurrency({ rnbo: { maxConcurrentScoreTransfers: 1 } }), 1);
  assert.equal(rnboTargetTransferConcurrency({ rnbo: { maxConcurrentScoreTransfers: 200 } }), 64);
});
