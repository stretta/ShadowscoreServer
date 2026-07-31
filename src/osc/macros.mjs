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
  const targets = Array.from(targetsById.values());
  return macro.steps.flatMap((step, index) => {
    if (step.target) {
      return validateExpandedStep(step, index, targetsById.get(step.target));
    }
    const matches = targets.filter((target) => matchesWhere(target, step.where, step.param));
    if (!matches.length) {
      return [{
        index,
        target: "",
        selector: step.where,
        address: "",
        param: step.param,
        args: step.args,
        ok: false,
        status: "missing",
        error: `OSC macro selector matched no targets exposing '${step.param}'`
      }];
    }
    return matches.map((target) => validateExpandedStep(step, index, target));
  });
}

export function resolveMacroStepAddress(step, target) {
  if (step.address) {
    return step.address;
  }
  if (!step.param) {
    return "";
  }
  return parameterForTarget(target, step.param)?.address ?? "";
}

export function normalizeMacro(document) {
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
  const where = normalizeWhere(step.where);
  if (Boolean(target) === Boolean(where)) throw new Error("macro step requires exactly one of target or where");
  const address = stringField(step.address);
  const param = stringField(step.param ?? step.parameter);
  if (!address && !param) {
    throw new Error("macro step address or param is required");
  }
  if (address && !address.startsWith("/")) {
    throw new Error("macro step address must start with /");
  }
  if (where && address) throw new Error("semantic macro steps must use param, not address");
  if (where?.parameter && where.parameter !== param) {
    throw new Error("macro selector parameter must match step param");
  }
  if (!Array.isArray(step.args)) {
    throw new Error("macro step args must be an array");
  }
  return { ...(target ? { target } : { where }), ...(address ? { address } : { param }), args: step.args };
}

function normalizeWhere(document) {
  if (document === undefined || document === null) return null;
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("macro step where must be an object");
  }
  const allowed = new Set(["app", "capability", "status", "parameter"]);
  const unknown = Object.keys(document).find((name) => !allowed.has(name));
  if (unknown) throw new Error(`macro step where contains unknown field '${unknown}'`);
  const where = Object.fromEntries(Object.entries(document)
    .map(([name, value]) => [name, stringField(value)])
    .filter(([, value]) => value));
  if (!Object.keys(where).length) throw new Error("macro step where must include at least one selector");
  return where;
}

function validateExpandedStep(step, index, target) {
  const address = resolveMacroStepAddress(step, target);
  const rangeError = parameterRangeError(step, target);
  const ok = Boolean(target?.sendable) && Boolean(address) && !rangeError;
  return {
    index,
    target: target?.id ?? step.target ?? "",
    ...(step.where ? { selector: step.where } : {}),
    address,
    param: step.param,
    args: step.args,
    ok,
    status: target?.status ?? "missing",
    error: ok ? "" : rangeError || validationError(step, target, address)
  };
}

function matchesWhere(target, where, paramName) {
  if (where.app && target.app !== cleanToken(where.app)) return false;
  if (where.capability && !(target.capabilities ?? []).includes(cleanToken(where.capability))) return false;
  if (where.status && target.status !== cleanToken(where.status)) return false;
  const parameter = where.parameter || paramName;
  return !parameter || Boolean(parameterForTarget(target, parameter));
}

function parameterRangeError(step, target) {
  if (!step.param || !target) return "";
  const parameter = parameterForTarget(target, step.param);
  const value = step.args.length === 1 ? Number(step.args[0]) : NaN;
  if (!Number.isFinite(value) || !parameter) return "";
  if (Number.isFinite(Number(parameter.min)) && value < Number(parameter.min)) {
    return `value ${value} is below '${step.param}' minimum ${parameter.min} on '${target.id}'`;
  }
  if (Number.isFinite(Number(parameter.max)) && value > Number(parameter.max)) {
    return `value ${value} is above '${step.param}' maximum ${parameter.max} on '${target.id}'`;
  }
  return "";
}

function parameterForTarget(target, name) {
  return (target?.parameters ?? []).find((entry) => (entry.key ?? entry.name) === name)
    ?? (target?.parameters ?? []).find((entry) => entry.name === name);
}

function validationError(step, target, address) {
  if (!target) {
    return `OSC target '${step.target}' is missing`;
  }
  if (!target.sendable) {
    return `OSC target '${target.id ?? step.target ?? ""}' is ${target.status ?? "unavailable"}`;
  }
  if (step.param && !address) {
    return `OSC target '${target.id ?? step.target ?? ""}' does not expose parameter '${step.param}'`;
  }
  return `OSC macro step for '${target.id ?? step.target ?? ""}' is invalid`;
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

function cleanToken(value) {
  return stringField(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}
