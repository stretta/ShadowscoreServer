import assert from "node:assert/strict";
import test from "node:test";

import {
  genericControlModel,
  genericOscEditorGroups,
  parameterGroup,
  targetParameterSignature
} from "../public/shared/generic-osc-editor.js";

function fmTwoOpTarget(overrides = {}) {
  return {
    id: "wren:fmtwoop:main",
    app: "fmtwoop",
    exportName: "FMTwoOp",
    label: "Fmtwoop 21",
    status: "online",
    sendable: true,
    parameters: [
      { name: "OctaveBias", path: "OctaveBias", type: "f", value: 2, min: -10, max: 10, meta: { display_precision: "0", edit_as: "int", edit_step: "1", unit: "octs" } },
      { name: "ModulatorRatio", path: "ModulatorRatio", type: "f", value: 1, min: 0, max: 20, meta: { display_precision: "1", edit_step: ".1" } },
      { name: "ModulationIndex", path: "ModulationIndex", type: "f", value: 1, min: 0, max: 20, meta: { display_precision: "2", edit_step: ".05" } }
    ],
    ...overrides
  };
}

test("generic editor groups uncovered live RNBO exports by app and exact parameter signature", () => {
  const fm = fmTwoOpTarget();
  const sameExport = fmTwoOpTarget({ id: "heron:fmtwoop:main", label: "Fmtwoop 9" });
  const changedExport = fmTwoOpTarget({
    id: "robin:fmtwoop:main",
    parameters: [...fm.parameters, { name: "Feedback", path: "Feedback", type: "f", value: 0, min: 0, max: 1 }]
  });
  const specialized = { ...fmTwoOpTarget({ id: "wren:plate:main", app: "plate", exportName: "Plate" }) };

  const groups = genericOscEditorGroups([fm, sameExport, changedExport, specialized], ["plate"]);
  const matchingGroup = groups.find((group) => group.targets.length === 2);
  const changedGroup = groups.find((group) => group.targets.length === 1);

  assert.equal(groups.length, 2);
  assert.equal(matchingGroup.label, "FMTwoOp");
  assert.match(matchingGroup.route, /^\/editors\/generic\?app=fmtwoop&signature=v1-/);
  assert.equal(changedGroup.targets.length, 1);
});

test("generic compatibility ignores current values and presentation metadata", () => {
  const original = fmTwoOpTarget();
  const changedPresentation = fmTwoOpTarget({ parameters: original.parameters.map((param) => ({ ...param, value: 17, displayName: `Pretty ${param.name}`, unit: "new" })) });
  const changedRange = fmTwoOpTarget({ parameters: original.parameters.map((param, index) => index === 0 ? { ...param, max: 12 } : param) });

  assert.equal(targetParameterSignature(original), targetParameterSignature(changedPresentation));
  assert.notEqual(targetParameterSignature(original), targetParameterSignature(changedRange));
});

test("generic controls honor FMTwoOp integer, fractional step, and precision metadata", () => {
  const [octave, ratio, index] = fmTwoOpTarget().parameters.map(genericControlModel);

  assert.deepEqual({ kind: octave.kind, step: octave.step, precision: octave.precision, unit: octave.unit }, { kind: "range", step: 1, precision: 0, unit: "octs" });
  assert.deepEqual({ kind: ratio.kind, step: ratio.step, precision: ratio.precision }, { kind: "range", step: 0.1, precision: 1 });
  assert.deepEqual({ kind: index.kind, step: index.step, precision: index.precision }, { kind: "range", step: 0.05, precision: 2 });
});

test("generic controls reserve switches for explicit two-state parameters", () => {
  assert.equal(genericControlModel({ name: "Clock", type: "s", value: "On", values: ["Off", "On"] }).kind, "boolean");
  assert.equal(genericControlModel({ name: "Mix", type: "f", value: 0.5, min: 0, max: 1 }).kind, "range");
  assert.equal(genericControlModel({ name: "Enabled", type: "f", value: 1, min: 0, max: 1, steps: 2 }).kind, "boolean");
});

test("generic controls derive safe sections from nested parameter paths", () => {
  assert.equal(parameterGroup({ name: "Attack", path: "Synth/AmpEnv/Attack" }), "Synth / Amp Env");
  assert.equal(parameterGroup({ name: "Ratio", path: "Ratio" }), "Parameters");
});
