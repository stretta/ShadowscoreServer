import { DEFAULT_SCALE, normalizeScale, normalizeTtid, scaleToTtid } from "../harmonic/scale.mjs";
import { DEFAULT_SWING, DEFAULT_SWING_AMT, normalizeSwing, normalizeSwingAmt } from "../sequencer/swing.mjs";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const WIZARD_MATERIAL_MODES = new Set(["empty", "first-block", "all-blocks"]);
const WIZARD_COLORS = ["#6ee7b7", "#60a5fa", "#f59e0b", "#f472b6", "#a78bfa", "#22d3ee", "#fb7185", "#a3e635"];

export function createWizardScoreInitializationRequest(options = {}) {
  if (!isObject(options)) throw new Error("score initialization wizard options must be an object");
  const playerDocuments = options.players === undefined
    ? Array.from({ length: boundedWizardCount(options.playerCount, "playerCount") }, (_, index) => ({
        id: `player-${index + 1}`,
        label: `Player ${index + 1}`
      }))
    : requiredArray(options.players, "players").map((player, index) => {
        if (!isObject(player)) throw new Error(`players[${index}] must be an object`);
        return {
          id: validId(player.id ?? `player-${index + 1}`, `players[${index}].id`),
          label: cleanString(player.label) || `Player ${index + 1}`,
          color: cleanString(player.color) || WIZARD_COLORS[index % WIZARD_COLORS.length]
        };
      });
  const blockCount = boundedWizardCount(options.blockCount, "blockCount");
  const bars = boundedWizardCount(options.blockBars ?? 1, "blockBars", 64);
  const tempo = positiveTempo(options.tempo, "tempo", 120);
  const material = cleanString(options.material) || "empty";
  if (!WIZARD_MATERIAL_MODES.has(material)) {
    throw new Error("material must be 'empty', 'first-block', or 'all-blocks'");
  }

  const players = playerDocuments.map((player, index) => ({
    ...player,
    color: player.color || WIZARD_COLORS[index % WIZARD_COLORS.length]
  }));
  const blocks = Array.from({ length: blockCount }, (_, blockIndex) => {
    const id = wizardBlockId(blockIndex);
    return {
      id,
      tempo,
      duration: { bars },
      players: Object.fromEntries(players.map((player) => [player.id, `${id.toLowerCase()}-${player.id}`]))
    };
  });
  const clips = blocks.flatMap((block, blockIndex) => players.map((player, playerIndex) => ({
    id: block.players[player.id],
    notes: wizardNotes(material, blockIndex, playerIndex),
    duration: { bars },
    playbackType: "looped",
    context: {
      clip: { TimeSignature: { numerator: 4, denominator: 4 } },
      scale: structuredClone(DEFAULT_SCALE),
      grid: { subdivision: 4 },
      seed: 0
    },
    behavior: {
      initialization: {
        placeholder: true,
        material
      }
    }
  })));

  return {
    name: cleanString(options.name) || `${players.length}-player ${blocks.length}-block score`,
    context: defaultContext(),
    players,
    clips,
    blocks,
    macrostructure: { blocks: blocks.map(({ id }) => id) },
    oscRoles: []
  };
}

export function createScoreInitializationPlan(request, options = {}) {
  if (!isObject(request)) throw new Error("score initialization request must be an object");

  const players = requiredArray(request.players, "players").map(normalizePlayer);
  const clips = optionalArray(request.clips, "clips").map(normalizeClip);
  const legacyTempo = normalizeLegacyTempo(request.macrostructure?.tempo);
  const blocks = requiredArray(request.blocks, "blocks").map((block, index) => normalizeBlock(block, index, legacyTempo));
  const oscRoles = optionalArray(request.oscRoles, "oscRoles").map(normalizeOscRole);

  assertUnique(players, "player");
  assertUnique(clips, "clip");
  assertUnique(blocks, "block");
  assertUnique(oscRoles, "OSC role");

  const playerIds = new Set(players.map(({ id }) => id));
  const clipIds = new Set(clips.map(({ id }) => id));
  const blockIds = new Set(blocks.map(({ id }) => id));
  for (const block of blocks) {
    for (const [playerId, clipId] of Object.entries(block.players)) {
      if (!playerIds.has(playerId)) throw new Error(`block '${block.id}' references unknown player '${playerId}'`);
      if (!clipIds.has(clipId)) throw new Error(`block '${block.id}' player '${playerId}' references unknown clip '${clipId}'`);
    }
  }

  const macrostructure = normalizeMacrostructure(request.macrostructure, blocks.map(({ id }) => id));
  for (const blockId of macrostructure.blocks) {
    if (!blockIds.has(blockId)) throw new Error(`macrostructure references unknown block '${blockId}'`);
  }

  const context = isObject(request.context) ? structuredClone(request.context) : defaultContext();
  const score = {
    ensembleId: cleanString(options.ensembleId),
    version: 0,
    scoreRevision: 0,
    structureRevision: 0,
    scoreInitialization: {
      schemaVersion: 1,
      name: cleanString(request.name),
      exactPlayers: true
    },
    context,
    clips: Object.fromEntries(clips.map(({ id, ...clip }) => [id, clip])),
    mesostructure: Object.fromEntries(blocks.map(({ id, ...block }) => [id, { ...block, oscLayers: {} }])),
    macrostructure,
    structureState: {
      activeBlockId: macrostructure.blocks[0] ?? blocks[0]?.id ?? "",
      macroIndex: 0
    },
    assignments: Object.fromEntries(players.map(({ id, assignment }) => [id, assignment])),
    oscAssignments: Object.fromEntries(oscRoles.map(({ id, ...assignment }) => [id, assignment])),
    oscClips: {},
    voices: Object.fromEntries(players.map(({ id }) => [id, { version: 0, notes: [] }]))
  };
  const summary = {
    name: cleanString(request.name),
    playerCount: players.length,
    clipCount: clips.length,
    noteCount: clips.reduce((total, clip) => total + clip.notes.length, 0),
    blockCount: blocks.length,
    macroEntryCount: macrostructure.blocks.length,
    oscRoleCount: oscRoles.length,
    emptyOscLayerSlotCount: blocks.length * oscRoles.length,
    deviceMappingCount: 0,
    playerIds: players.map(({ id }) => id),
    clipIds: clips.map(({ id }) => id),
    blockIds: blocks.map(({ id }) => id),
    macroOrder: [...macrostructure.blocks],
    oscRoleIds: oscRoles.map(({ id }) => id)
  };
  return { summary, score };
}

function normalizePlayer(document, index) {
  if (!isObject(document)) throw new Error(`players[${index}] must be an object`);
  const id = validId(document.id, `players[${index}].id`);
  if (document.assignment !== undefined && !isObject(document.assignment)) {
    throw new Error(`player '${id}' assignment must be an object`);
  }
  const assignment = document.assignment ?? {};
  assertNoRuntimeMapping(document, ["deviceId", "clientId", "rnboTargetId", "rnboHost", "rnboPort", "rnboAddress"], `player '${id}'`);
  assertNoRuntimeMapping(assignment, ["deviceId", "clientId", "rnboTargetId", "rnboHost", "rnboPort", "rnboAddress"], `player '${id}'`);
  return {
    id,
    assignment: {
      assignee: cleanString(assignment.assignee ?? document.assignee),
      deviceId: "",
      clientId: null,
      rnboTargetId: "",
      rnboHost: "",
      rnboPort: null,
      rnboAddress: "",
      label: cleanString(assignment.label ?? document.label),
      color: cleanString(assignment.color ?? document.color),
      locked: false,
      routingStatus: "",
      routingMessage: ""
    }
  };
}

function normalizeClip(document, index) {
  if (!isObject(document)) throw new Error(`clips[${index}] must be an object`);
  const id = validId(document.id, `clips[${index}].id`);
  if (document.notes !== undefined && !Array.isArray(document.notes)) throw new Error(`clip '${id}' notes must be an array`);
  if (document.context !== undefined && !isObject(document.context)) throw new Error(`clip '${id}' context must be an object`);
  if (document.duration !== undefined && !isObject(document.duration)) throw new Error(`clip '${id}' duration must be an object`);
  if (document.behavior !== undefined && !isObject(document.behavior)) throw new Error(`clip '${id}' behavior must be an object`);
  return {
    id,
    notes: structuredClone(document.notes ?? []),
    context: structuredClone(document.context ?? defaultContext()),
    duration: structuredClone(document.duration ?? { bars: 1 }),
    playbackType: cleanString(document.playbackType) || "looped",
    behavior: structuredClone(document.behavior ?? {})
  };
}

function normalizeBlock(document, index, fallbackTempo = 120) {
  if (!isObject(document)) throw new Error(`blocks[${index}] must be an object`);
  const id = validId(document.id, `blocks[${index}].id`);
  if (document.duration !== undefined && !isObject(document.duration)) throw new Error(`block '${id}' duration must be an object`);
  if (document.scale !== undefined && !isObject(document.scale)) throw new Error(`block '${id}' scale must be an object`);
  if (document.players !== undefined && !isObject(document.players)) throw new Error(`block '${id}' players must be an object`);
  const players = Object.fromEntries(Object.entries(document.players ?? {}).map(([playerId, assignment]) => [
    validId(playerId, `block '${id}' player id`),
    validId(typeof assignment === "string" ? assignment : assignment?.clipId, `block '${id}' player '${playerId}' clipId`)
  ]));
  return {
    id,
    tempo: positiveTempo(document.tempo, `block '${id}' tempo`, fallbackTempo),
    duration: structuredClone(document.duration ?? { bars: 1 }),
    scale: normalizeScale(document.scale ?? DEFAULT_SCALE),
    ttid: document.ttid === undefined ? scaleToTtid(document.scale ?? DEFAULT_SCALE) : normalizeTtid(document.ttid),
    swing: normalizeSwing(document.swing ?? DEFAULT_SWING),
    swingAmt: normalizeSwingAmt(document.swingAmt ?? DEFAULT_SWING_AMT),
    players
  };
}

function normalizeOscRole(document, index) {
  if (!isObject(document)) throw new Error(`oscRoles[${index}] must be an object`);
  const id = validId(document.id, `oscRoles[${index}].id`);
  assertNoRuntimeMapping(document, ["deviceId", "oscTargetId"], `OSC role '${id}'`);
  const app = cleanToken(document.app);
  if (!app) throw new Error(`OSC role '${id}' app is required`);
  return {
    id,
    label: cleanString(document.label),
    app,
    deviceId: "",
    oscTargetId: "",
    ignoreRecall: Boolean(document.ignoreRecall),
    ignoreScale: Boolean(document.ignoreScale),
    locked: false,
    routingStatus: "",
    routingMessage: ""
  };
}

function normalizeMacrostructure(document, defaultBlocks) {
  if (document !== undefined && !isObject(document)) throw new Error("macrostructure must be an object");
  const value = document ?? {};
  const blocks = value.blocks === undefined ? defaultBlocks : requiredArray(value.blocks, "macrostructure.blocks").map((id, index) => validId(id, `macrostructure.blocks[${index}]`));
  return { blocks };
}

function normalizeLegacyTempo(value) {
  if (value === undefined || value === null || value === "") return 120;
  return positiveTempo(value, "macrostructure tempo", 120);
}

function positiveTempo(value, field, fallback) {
  const candidate = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(candidate) || candidate <= 0) throw new Error(`${field} must be a positive number`);
  return candidate;
}

function boundedWizardCount(value, field, maximum = 32) {
  const candidate = Number(value);
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw new Error(`${field} must be an integer from 1 through ${maximum}`);
  }
  return candidate;
}

function wizardBlockId(index) {
  let value = index + 1;
  let id = "";
  while (value > 0) {
    value -= 1;
    id = String.fromCharCode(65 + (value % 26)) + id;
    value = Math.floor(value / 26);
  }
  return id;
}

function wizardNotes(material, blockIndex, playerIndex) {
  if (material === "empty" || (material === "first-block" && blockIndex > 0)) return [];
  return [{
    pitch: 48 + (playerIndex % 24),
    start_time: 0,
    duration: 0.25,
    velocity: 100
  }];
}

function assertUnique(entries, label) {
  const seen = new Set();
  for (const { id } of entries) {
    if (seen.has(id)) throw new Error(`duplicate ${label} id '${id}'`);
    seen.add(id);
  }
}

function assertNoRuntimeMapping(document, fields, label) {
  const field = fields.find((name) => document[name] !== undefined && document[name] !== null && document[name] !== "");
  if (field) throw new Error(`${label} cannot set ${field}; initialize structure first and use rig discovery/onboarding for live mappings`);
}

function requiredArray(value, field) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty array`);
  return value;
}

function optionalArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value;
}

function validId(value, field) {
  const id = cleanString(value);
  if (!id) throw new Error(`${field} is required`);
  if (!ID_PATTERN.test(id)) throw new Error(`${field} must start with a letter or number and contain only letters, numbers, '.', '_', ':', or '-'`);
  return id;
}

function cleanToken(value) {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function cleanString(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function defaultContext() {
  return { clip: {}, scale: structuredClone(DEFAULT_SCALE), grid: {}, seed: 0 };
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
