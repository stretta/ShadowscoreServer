import fs from "node:fs/promises";
import path from "node:path";

export async function listOscMacros(config) {
  return readMacroFile(config);
}

export async function saveOscMacro(config, document) {
  const macro = normalizeMacro(document);
  const macros = await readMacroFile(config);
  const index = macros.findIndex((entry) => entry.id === macro.id);
  if (index === -1) {
    macros.push(macro);
  } else {
    macros[index] = macro;
  }
  await writeMacroFile(config, macros);
  return macro;
}

export async function findOscMacro(config, macroId) {
  const id = stringField(macroId);
  return (await readMacroFile(config)).find((macro) => macro.id === id);
}

export function validateMacro(macro, targetsById) {
  return macro.steps.map((step, index) => {
    const target = targetsById.get(step.target);
    const address = resolveMacroStepAddress(step, target);
    const ok = Boolean(target?.sendable) && Boolean(address);
    return {
      index,
      target: step.target,
      address,
      param: step.param,
      args: step.args,
      ok,
      status: target?.status ?? "missing",
      error: ok ? "" : validationError(step, target, address)
    };
  });
}

export function resolveMacroStepAddress(step, target) {
  if (step.address) {
    return step.address;
  }
  if (!step.param) {
    return "";
  }
  return (target?.parameters ?? []).find((entry) => entry.name === step.param)?.address ?? "";
}

function normalizeMacro(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("macro body must be an object");
  }
  const id = slug(document.id ?? document.label);
  if (!id) {
    throw new Error("macro id is required");
  }
  const steps = Array.isArray(document.steps) ? document.steps.map(normalizeStep) : [];
  if (steps.length === 0) {
    throw new Error("macro steps must include at least one step");
  }
  return {
    id,
    label: stringField(document.label) || id,
    steps
  };
}

function normalizeStep(step) {
  if (!step || typeof step !== "object" || Array.isArray(step)) {
    throw new Error("macro step must be an object");
  }
  const target = stringField(step.target ?? step.targetId);
  if (!target) {
    throw new Error("macro step target is required");
  }
  const address = stringField(step.address);
  const param = stringField(step.param ?? step.parameter);
  if (!address && !param) {
    throw new Error("macro step address or param is required");
  }
  if (address && !address.startsWith("/")) {
    throw new Error("macro step address must start with /");
  }
  if (!Array.isArray(step.args)) {
    throw new Error("macro step args must be an array");
  }
  return { target, ...(address ? { address } : { param }), args: step.args };
}

function validationError(step, target, address) {
  if (!target) {
    return `OSC target '${step.target}' is missing`;
  }
  if (!target.sendable) {
    return `OSC target '${step.target}' is ${target.status ?? "unavailable"}`;
  }
  if (step.param && !address) {
    return `OSC target '${step.target}' does not expose parameter '${step.param}'`;
  }
  return `OSC macro step for '${step.target}' is invalid`;
}

async function readMacroFile(config) {
  const filePath = macroPath(config);
  try {
    const document = JSON.parse(await fs.readFile(filePath, "utf8"));
    return Array.isArray(document.macros) ? document.macros : [];
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeMacroFile(config, macros) {
  const filePath = macroPath(config);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify({ macros }, null, 2)}\n`);
}

function macroPath(config) {
  return path.resolve(config.osc?.macros?.path ?? "data/osc-macros.json");
}

function slug(value) {
  return stringField(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function stringField(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}
