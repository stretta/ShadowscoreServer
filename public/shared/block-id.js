export function suggestedDuplicateBlockId(sourceBlockId, existingBlockIds = []) {
  const source = String(sourceBlockId ?? "");
  const existing = new Set(existingBlockIds);
  const match = source.match(/^(.*?)([1-9][0-9]*)$/);
  const root = match ? match[1] : source;
  let index = match ? Number(match[2]) + 1 : 1;
  while (existing.has(`${root}${index}`)) {
    index += 1;
  }
  return `${root}${index}`;
}
