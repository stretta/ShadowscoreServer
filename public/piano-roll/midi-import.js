const textDecoder = new TextDecoder("utf-8");

export function parseStandardMidiFile(input, { sourceName = "import.mid" } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const reader = createReader(bytes);
  expectChunk(reader, "MThd");
  const headerLength = reader.u32();
  if (headerLength < 6) throw new Error("Invalid MIDI header length.");
  const format = reader.u16();
  const trackCount = reader.u16();
  const division = reader.u16();
  reader.skip(headerLength - 6);
  if (format > 1) throw new Error(`MIDI format ${format} is not supported; use format 0 or 1.`);
  if (division & 0x8000) throw new Error("SMPTE time division is not supported; use a PPQ MIDI file.");
  if (!division) throw new Error("MIDI PPQ must be greater than zero.");

  const tracks = [];
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    expectChunk(reader, "MTrk");
    const length = reader.u32();
    tracks.push(parseTrack(reader.subreader(length), trackIndex));
  }

  const tempos = tracks.flatMap((track) => track.tempos).sort(byTick);
  const timeSignatures = tracks.flatMap((track) => track.timeSignatures).sort(byTick);
  const warnings = tracks.flatMap((track) => track.warnings);
  if (tempos.length > 1) warnings.push(`The file contains ${tempos.length} tempo events; import uses the first written tempo.`);
  if (timeSignatures.length > 1) warnings.push(`The file contains ${timeSignatures.length} time-signature events; import uses the first meter.`);

  const lanes = tracks.flatMap((track) => buildTrackLanes(track, division));
  const durationBeats = roundBeat(Math.max(0, ...lanes.flatMap((lane) => lane.notes.map((note) => note.start_time + note.duration))));
  return {
    sourceName,
    format,
    ppq: division,
    trackCount,
    durationBeats,
    tempo: tempos.length ? roundBeat(60000000 / tempos[0].microsecondsPerQuarter) : 120,
    tempos: tempos.map((event) => ({ beat: roundBeat(event.tick / division), bpm: roundBeat(60000000 / event.microsecondsPerQuarter) })),
    timeSignature: timeSignatures.length ? { numerator: timeSignatures[0].numerator, denominator: timeSignatures[0].denominator } : { numerator: 4, denominator: 4 },
    timeSignatures: timeSignatures.map((event) => ({ beat: roundBeat(event.tick / division), numerator: event.numerator, denominator: event.denominator })),
    lanes,
    warnings
  };
}

function parseTrack(reader, trackIndex) {
  let tick = 0;
  let runningStatus;
  let trackName = `Track ${trackIndex + 1}`;
  const channelEvents = [];
  const tempos = [];
  const timeSignatures = [];
  const warnings = [];
  while (!reader.done()) {
    tick += reader.variable();
    let status = reader.peek();
    if (status < 0x80) {
      if (runningStatus === undefined) throw new Error(`Track ${trackIndex + 1} uses running status before a channel event.`);
      status = runningStatus;
    } else {
      reader.u8();
      if (status < 0xf0) runningStatus = status;
    }
    if (status === 0xff) {
      runningStatus = undefined;
      const type = reader.u8();
      const data = reader.bytes(reader.variable());
      if (type === 0x03) trackName = cleanText(data) || trackName;
      if (type === 0x51 && data.length === 3) tempos.push({ tick, microsecondsPerQuarter: (data[0] << 16) | (data[1] << 8) | data[2] });
      if (type === 0x58 && data.length >= 2) timeSignatures.push({ tick, numerator: data[0], denominator: 2 ** data[1] });
      if (type === 0x2f) break;
      continue;
    }
    if (status === 0xf0 || status === 0xf7) {
      runningStatus = undefined;
      reader.skip(reader.variable());
      continue;
    }
    if (status >= 0xf0) throw new Error(`Unsupported system event 0x${status.toString(16)} in track ${trackIndex + 1}.`);
    const type = status >> 4;
    const channel = status & 0x0f;
    const data1 = reader.u8();
    const data2 = type === 0x0c || type === 0x0d ? undefined : reader.u8();
    channelEvents.push({ tick, type, channel, data1, data2 });
  }
  return { trackIndex, trackName, endTick: tick, channelEvents, tempos, timeSignatures, warnings };
}

function buildTrackLanes(track, ppq) {
  const channels = new Map();
  for (const event of track.channelEvents) {
    if (!channels.has(event.channel)) channels.set(event.channel, []);
    channels.get(event.channel).push(event);
  }
  return [...channels.entries()].flatMap(([channel, events]) => {
    const active = new Map();
    const notes = [];
    let program;
    let sustainSeen = false;
    for (const event of events) {
      if (event.type === 0x0c) program = event.data1;
      if (event.type === 0x0b && event.data1 === 64) sustainSeen = true;
      const noteOn = event.type === 0x09 && event.data2 > 0;
      const noteOff = event.type === 0x08 || (event.type === 0x09 && event.data2 === 0);
      if (noteOn) {
        const queue = active.get(event.data1) ?? [];
        queue.push(event);
        active.set(event.data1, queue);
      } else if (noteOff) {
        const queue = active.get(event.data1);
        const start = queue?.shift();
        if (!start) continue;
        notes.push({
          note_id: notes.length + 1,
          pitch: event.data1,
          start_time: roundBeat(start.tick / ppq),
          duration: roundBeat(Math.max(1, event.tick - start.tick) / ppq),
          velocity: start.data2,
          release_velocity: event.type === 0x08 ? event.data2 : 64,
          mute: 0,
          probability: 1,
          velocity_deviation: 0
        });
      }
    }
    notes.sort((left, right) => left.start_time - right.start_time || left.pitch - right.pitch);
    notes.forEach((note, index) => { note.note_id = index + 1; });
    if (!notes.length) return [];
    const danglingCount = [...active.values()].reduce((sum, queue) => sum + queue.length, 0);
    const label = `${track.trackName} · ch ${channel + 1}`;
    return [{
      id: `track-${track.trackIndex + 1}-channel-${channel + 1}`,
      trackIndex: track.trackIndex,
      trackName: track.trackName,
      channel: channel + 1,
      label,
      program,
      percussion: channel === 9,
      notes,
      noteCount: notes.length,
      lowestPitch: Math.min(...notes.map((note) => note.pitch)),
      highestPitch: Math.max(...notes.map((note) => note.pitch)),
      warnings: [
        ...(danglingCount ? [`${danglingCount} unmatched note-on event${danglingCount === 1 ? "" : "s"} omitted.`] : []),
        ...(sustainSeen ? ["Sustain pedal events are not baked into note durations."] : [])
      ]
    }];
  });
}

function createReader(bytes) {
  let offset = 0;
  const need = (count) => { if (offset + count > bytes.length) throw new Error("Unexpected end of MIDI file."); };
  return {
    done: () => offset >= bytes.length,
    peek: () => { need(1); return bytes[offset]; },
    u8: () => { need(1); return bytes[offset++]; },
    u16: () => { need(2); const value = (bytes[offset] << 8) | bytes[offset + 1]; offset += 2; return value; },
    u32: () => { need(4); const value = ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0; offset += 4; return value; },
    bytes: (count) => { need(count); const value = bytes.slice(offset, offset + count); offset += count; return value; },
    skip: (count) => { need(count); offset += count; },
    subreader: (count) => { need(count); const value = createReader(bytes.slice(offset, offset + count)); offset += count; return value; },
    variable: () => {
      let value = 0;
      for (let index = 0; index < 4; index += 1) {
        need(1);
        const byte = bytes[offset++];
        value = (value << 7) | (byte & 0x7f);
        if (!(byte & 0x80)) return value;
      }
      throw new Error("Invalid MIDI variable-length value.");
    }
  };
}

function expectChunk(reader, expected) {
  const actual = String.fromCharCode(...reader.bytes(4));
  if (actual !== expected) throw new Error(`Expected ${expected} chunk, found ${actual || "empty data"}.`);
}

function cleanText(bytes) {
  return textDecoder.decode(bytes).replace(/\0/g, "").trim();
}

function byTick(left, right) { return left.tick - right.tick; }
function roundBeat(value) { return Math.round(value * 1e6) / 1e6; }
