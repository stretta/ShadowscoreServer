export function writtenTempoForBlock(score, blockId, fallbackTempo = 120) {
  return positiveTempo(score?.mesostructure?.[blockId]?.tempo, fallbackTempo);
}

export function activeWrittenTempo(score, fallbackTempo = 120) {
  const blocks = score?.macrostructure?.blocks ?? [];
  const macroIndex = Number(score?.structureState?.macroIndex);
  const blockId = score?.structureState?.activeBlockId
    || (Number.isInteger(macroIndex) ? blocks[macroIndex] : "")
    || blocks[0];
  return writtenTempoForBlock(score, blockId, fallbackTempo);
}

function positiveTempo(value, fallbackTempo) {
  const tempo = Number(value);
  if (Number.isFinite(tempo) && tempo > 0) return tempo;
  const fallback = Number(fallbackTempo);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 120;
}
