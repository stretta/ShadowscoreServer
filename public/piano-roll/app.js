import {
  assignedClipId,
  clamp,
  gridStepsPerBeat,
  hitTestNoteEntries,
  hitTestNotes,
  moveNote,
  nudgeNote,
  orchestrationDestinations,
  playbackBeatForVoice,
  projectClipOccurrences,
  resizeNoteRight,
  snapBeat,
  velocityFromLanePosition
} from "/piano-roll/clip-editor-core.js";
import { createClipDraftStore } from "/piano-roll/clip-draft-store.js";
import { canvasMetrics } from "/piano-roll/canvas-metrics.js";
import { parseStandardMidiFile } from "/piano-roll/midi-import.js";
import { playheadScrollLeft, shouldFollowPlayhead, timelineGridStep, timelineLabelInterval, zoomAnchorScrollLeft } from "/piano-roll/viewport-scroll.js";
import { createPlaybackUpdateControl } from "/shared/playback-update-control.js";
import { createWiperEstimator } from "/shared/wiper-estimator.js";

const $ = (id) => document.getElementById(id);
const ui = { block:$("block"), player:$("player"), clip:$("clip"), grid:$("grid"), zoomX:$("zoom-x"), zoomY:$("zoom-y"), zoomFit:$("zoom-fit"), chase:$("chase"), scrollChase:$("scroll-chase"), fold:$("fold"), importMidi:$("import-midi"), revert:$("revert"), dirty:$("dirty"), editing:$("editing"), playing:$("playing"), selection:$("selection"), status:$("status"), playbackUpdate:$("playback-update"), roll:$("roll"), velocity:$("velocity"), pitchLabels:$("pitch-labels"), rollWiper:$("roll-wiper"), velocityWiper:$("velocity-wiper"), rollScroll:$("roll-scroll"), velocityScroll:$("velocity-scroll"), velocityValue:$("velocity-value"), noteMenu:$("note-menu"), noteMenuHeading:$("note-menu-heading"), moveTo:$("move-to"), moveToMenu:$("move-to-menu"), midiDialog:$("midi-import-dialog"), midiForm:$("midi-import-form"), midiFile:$("midi-file"), midiSummary:$("midi-summary"), midiWarnings:$("midi-warnings"), midiPreview:$("midi-preview"), midiLanes:$("midi-lanes"), midiApplyTempo:$("midi-apply-tempo"), midiApplyDuration:$("midi-apply-duration"), midiImportStatus:$("midi-import-status"), midiImportCommit:$("midi-import-commit"), midiImportClose:$("midi-import-close"), midiImportCancel:$("midi-import-cancel") };
const ctx = ui.roll.getContext("2d"); const vctx = ui.velocity.getContext("2d");
const draftStore=createClipDraftStore();
const canvasScales=new WeakMap();
const state = { score:null, snapshot:null, draft:null, clipId:"", selected:-1, dirty:false, stale:false, saving:false, pendingSaves:new Set(), saveTimer:null, chasing:false, folded:false, drag:null, menuNote:null, orchestrationBusy:false, midiImport:null, playback:null, playbackGeneration:0, playbackRequest:null, wiperFrame:null, rnboTargets:[], timingContracts:[], dpr:Math.max(1,devicePixelRatio||1), left:58, top:22, minPitch:36, maxPitch:84, lastBeatWidth:72 };
const wiperEstimator=createWiperEstimator({staleAfterMs:3000,correctionMs:900,snapThresholdBeats:.25,deadbandBeats:.015});
createPlaybackUpdateControl({ root:ui.playbackUpdate, getBlockId:()=>ui.block.value });

const clone = (value) => structuredClone(value);
const assignmentId = assignedClipId;
const beatWidth = () => Number(ui.zoomX.value);
const rowHeight = () => Number(ui.zoomY.value);
const snap = (beat) => snapBeat(beat, Number(ui.grid.value));
const gridStep = () => 1 / gridStepsPerBeat(Number(ui.grid.value));
const noteId = (note,index) => note.note_id ?? index + 1;
const signatureFor = (clip) => clip?.context?.clip?.TimeSignature || state.score?.context?.clip?.TimeSignature || {numerator:4,denominator:4};
const clipBeats = (clip=state.draft) => Math.max(1, Number(clip?.duration?.beats || 0) + Number(clip?.duration?.bars || 0) * signatureFor(clip).numerator || maxNoteEnd(clip) || 4);
const blockBeats = () => { const block=state.score?.mesostructure?.[ui.block.value]; return Math.max(1,Number(block?.duration?.beats||0)+Number(block?.duration?.bars||0)*timeSignature().numerator||clipBeats()); };
const timelineBeats = () => Math.max(clipBeats(),blockBeats());
const maxNoteEnd = (clip) => Math.ceil(Math.max(0,...(clip?.notes||[]).map(n=>Number(n.start_time)+Number(n.duration))));
const timeSignature = () => state.draft?.context?.clip?.TimeSignature || state.score?.context?.clip?.TimeSignature || {numerator:4,denominator:4};
const selectedNote = () => state.draft?.notes?.[state.selected];
const referenceNotes = () => Object.values(state.score?.mesostructure?.[ui.block.value]?.players || {})
  .map(assignment => assignmentId(assignment))
  .filter(id => id && id !== state.clipId)
  .flatMap(id => state.score?.clips?.[id]?.notes || []);
const visiblePitches = () => state.folded
  ? [...new Set([...(state.draft?.notes || []), ...referenceNotes()].map(note => clamp(Math.round(Number(note.pitch)),0,127)))].sort((a,b)=>b-a)
  : Array.from({length:state.maxPitch-state.minPitch+1},(_,index)=>state.maxPitch-index);
const pitchForY = (y,pitches=visiblePitches()) => pitches[clamp(Math.floor((y-state.top)/rowHeight()),0,pitches.length-1)];
const rowForPitch = (pitch,pitches=visiblePitches()) => pitches.indexOf(clamp(Math.round(Number(pitch)),0,127));

function setOptions(select, values, selected, label=(v)=>v){ select.replaceChildren(...values.map(value=>{const option=new Option(label(value),value); option.selected=value===selected; return option;})); }
function blocks(){ return Object.keys(state.score?.mesostructure||{}); }
function players(){ const block=state.score?.mesostructure?.[ui.block.value]; return Object.keys(block?.players||{}); }
function clipsForPlayer(){ const assigned=assignmentId(state.score?.mesostructure?.[ui.block.value]?.players?.[ui.player.value]); return assigned ? [assigned] : []; }
function playerColor(player){ return state.score?.assignments?.[player]?.color || "#6ee7ff"; }

function orchestrationNoteEntries(){
  const block=state.score?.mesostructure?.[ui.block.value];
  const entries=[];
  for(const [playerId,assignment] of Object.entries(block?.players||{})){
    const clipId=assignmentId(assignment);
    if(!clipId||clipId===state.clipId)continue;
    const clip=state.score?.clips?.[clipId];
    for(const occurrence of projectClipOccurrences(clip?.notes||[],{clipDuration:clipBeats(clip),timelineDuration:timelineBeats(),playbackType:clip?.playbackType})){
      entries.push({blockId:ui.block.value,playerId,clipId,sourceIndex:occurrence.sourceIndex,occurrenceIndex:occurrence.occurrenceIndex,alias:occurrence.alias,note:occurrence.note,sourceNote:clip.notes[occurrence.sourceIndex]});
    }
  }
  for(const occurrence of projectClipOccurrences(state.draft?.notes||[],{clipDuration:clipBeats(),timelineDuration:timelineBeats(),playbackType:state.draft?.playbackType})){
    entries.push({blockId:ui.block.value,playerId:ui.player.value,clipId:state.clipId,sourceIndex:occurrence.sourceIndex,occurrenceIndex:occurrence.occurrenceIndex,alias:occurrence.alias,note:occurrence.note,sourceNote:state.draft.notes[occurrence.sourceIndex]});
  }
  return entries;
}

function hitOrchestrationNote(x,y){
  return hitTestNoteEntries(orchestrationNoteEntries(),{pitch:pitchForY(y),time:(x-state.left)/beatWidth()});
}

function openNoteMenu(hit,clientX,clientY){
  if(!hit)return;
  state.menuNote={...hit,sourceNote:clone(hit.sourceNote||hit.note)};
  const playerLabel=state.score?.assignments?.[hit.playerId]?.label||hit.playerId;
  ui.noteMenuHeading.textContent=`${pitchName(hit.note.pitch)} · beat ${fmt(hit.note.start_time)} · ${playerLabel} · ${hit.clipId}`;
  renderMoveDestinations();
  ui.moveTo.setAttribute("aria-expanded","false");
  ui.moveToMenu.hidden=true;
  ui.noteMenu.hidden=false;
  ui.noteMenu.style.left=`${clientX}px`;
  ui.noteMenu.style.top=`${clientY}px`;
  ui.noteMenu.classList.remove("open-left");
  const bounds=ui.noteMenu.getBoundingClientRect();
  ui.noteMenu.style.left=`${clamp(clientX,8,innerWidth-bounds.width-8)}px`;
  ui.noteMenu.style.top=`${clamp(clientY,8,innerHeight-bounds.height-8)}px`;
  ui.moveTo.focus({preventScroll:true});
}

function closeNoteMenu(){
  state.menuNote=null;
  ui.noteMenu.hidden=true;
  ui.moveToMenu.hidden=true;
  ui.moveTo.setAttribute("aria-expanded","false");
}

function renderMoveDestinations(){
  const source=state.menuNote;
  const destinations=orchestrationDestinations(state.score,source.blockId,{playerId:source.playerId,clipId:source.clipId});
  const items=destinations.map(destination=>{
    const button=document.createElement("button");
    button.type="button";
    button.role="menuitem";
    button.style.setProperty("--player-color",playerColor(destination.playerId));
    const copy=document.createElement("span");
    const label=document.createElement("span");
    label.textContent=destination.label;
    const detail=document.createElement("small");
    if(destination.state==="current")detail.textContent="current player";
    else if(destination.state==="create")detail.textContent="create part in this section";
    else if(destination.state==="broken")detail.textContent=`missing clip ${destination.clipId}`;
    else if(destination.state==="same-clip")detail.textContent=`already uses ${destination.clipId}`;
    else detail.textContent=`${destination.clipId}${destination.references.length>1?` · shared ${destination.references.length} places`:""}`;
    copy.append(label,detail);button.append(copy);
    button.disabled=["current","broken","same-clip"].includes(destination.state);
    if(!button.disabled)button.addEventListener("click",()=>void moveOrchestrationNote(destination));
    return button;
  });
  if(!destinations.some(destination=>["ready","create"].includes(destination.state)))items.push(contextMenuLink("/admin","Add players in Setup…"));
  if(destinations.some(destination=>destination.state==="broken"))items.push(contextMenuLink("/structure-editor","Review assignments in Arrange…"));
  ui.moveToMenu.replaceChildren(...items);
}

function contextMenuLink(href,label){const link=document.createElement("a");link.href=href;link.role="menuitem";link.textContent=label;return link;}

function openMoveSubmenu(focusFirst=false){
  ui.moveToMenu.hidden=false;
  ui.moveTo.setAttribute("aria-expanded","true");
  const menuBounds=ui.noteMenu.getBoundingClientRect();
  ui.noteMenu.classList.toggle("open-left",menuBounds.right+260>innerWidth);
  if(focusFirst)ui.moveToMenu.querySelector("button:not(:disabled)")?.focus({preventScroll:true});
}

async function settleAutosaves(){
  if(state.drag)throw new Error("Finish the current note gesture before orchestrating.");
  clearTimeout(state.saveTimer);
  for(const clipId of draftStore.dirtyClipIds())state.pendingSaves.add(clipId);
  const deadline=Date.now()+6000;
  while(state.saving||draftStore.hasDirty()){
    if(draftStore.staleCount())throw new Error("Resolve the stale clip draft before orchestrating.");
    if(Date.now()>deadline)throw new Error("Pending clip edits did not finish saving.");
    if(!state.saving){
      if(!state.pendingSaves.size)throw new Error("Pending clip edits could not be saved.");
      await saveNextClip();
    }else await new Promise(resolve=>setTimeout(resolve,25));
  }
}

function openMidiImport(){
  if(!state.score||!ui.block.value)return;
  state.midiImport=null;
  ui.midiForm.reset();
  ui.midiPreview.hidden=true;
  ui.midiLanes.replaceChildren();
  ui.midiWarnings.hidden=true;
  ui.midiWarnings.textContent="";
  ui.midiSummary.textContent=`Import into section ${ui.block.value}. Choose a format 0 or format 1 Standard MIDI file; nothing changes until Import is pressed.`;
  ui.midiImportStatus.textContent="";
  ui.midiImportCommit.disabled=true;
  ui.midiDialog.showModal();
}

async function readMidiFile(){
  const file=ui.midiFile.files?.[0];
  if(!file)return;
  ui.midiImportCommit.disabled=true;
  ui.midiImportStatus.textContent="Reading MIDI…";
  try{
    const parsed=parseStandardMidiFile(await file.arrayBuffer(),{sourceName:file.name});
    state.midiImport=parsed;
    renderMidiPreview(parsed);
    ui.midiImportStatus.textContent="Review every destination before importing.";
    ui.midiImportCommit.disabled=false;
  }catch(error){
    state.midiImport=null;
    ui.midiPreview.hidden=true;
    ui.midiSummary.textContent=`Could not read ${file.name}: ${error.message}`;
    ui.midiImportStatus.textContent="";
  }
}

function renderMidiPreview(parsed){
  const signature=`${parsed.timeSignature.numerator}/${parsed.timeSignature.denominator}`;
  ui.midiSummary.textContent=`${parsed.sourceName} · format ${parsed.format} · ${parsed.trackCount} track${parsed.trackCount===1?"":"s"} · ${parsed.ppq} PPQ · ${parsed.lanes.length} musical lane${parsed.lanes.length===1?"":"s"} · ${fmt(parsed.durationBeats)} beats · ${fmt(parsed.tempo)} BPM · ${signature}`;
  const warnings=[...parsed.warnings,...parsed.lanes.flatMap(lane=>lane.warnings.map(message=>`${lane.label}: ${message}`))];
  ui.midiWarnings.textContent=warnings.join("\n");
  ui.midiWarnings.hidden=warnings.length===0;
  const existingPlayers=Object.keys(state.score?.voices||{});
  ui.midiLanes.replaceChildren(...parsed.lanes.map((lane,index)=>{
    const row=document.createElement("tr");
    row.dataset.laneId=lane.id;
    const source=document.createElement("td");
    const sourceLabel=document.createElement("strong");sourceLabel.textContent=lane.label;
    const detail=document.createElement("small");detail.textContent=`track ${lane.trackIndex+1}${lane.program===undefined?"":` · program ${lane.program}`}${lane.percussion?" · percussion":""}`;
    source.append(sourceLabel,detail);
    const count=document.createElement("td");count.textContent=String(lane.noteCount);
    const range=document.createElement("td");range.textContent=`${pitchName(lane.lowestPitch)}–${pitchName(lane.highestPitch)}`;
    const destination=document.createElement("td");
    const select=document.createElement("select");select.setAttribute("aria-label",`Destination for ${lane.label}`);
    select.append(new Option("Ignore lane",""));
    existingPlayers.forEach(playerId=>select.append(new Option(state.score?.assignments?.[playerId]?.label||playerId,`existing:${playerId}`)));
    select.append(new Option(`New player: ${lane.trackName||lane.label}`,`new:${lane.id}`));
    select.value=index<existingPlayers.length?`existing:${existingPlayers[index]}`:`new:${lane.id}`;
    destination.append(select);row.append(source,count,range,destination);return row;
  }));
  ui.midiPreview.hidden=false;
}

function nextImportedPlayerId(reserved){
  let number=1;
  while(reserved.has(`player-${number}`))number+=1;
  const id=`player-${number}`;
  reserved.add(id);
  return id;
}

async function commitMidiImport(event){
  event.preventDefault();
  const parsed=state.midiImport;
  if(!parsed)return;
  const selectedRows=[...ui.midiLanes.querySelectorAll("tr")].map((row,index)=>({row,lane:parsed.lanes[index],value:row.querySelector("select").value})).filter(entry=>entry.value);
  if(!selectedRows.length){ui.midiImportStatus.textContent="Map at least one MIDI lane to a player.";return;}
  const reservedPlayerIds=new Set(Object.keys(state.score?.voices||{}));
  const destinations=selectedRows.map(({value})=>value.startsWith("new:")?{kind:"new",playerId:nextImportedPlayerId(reservedPlayerIds)}:{kind:"existing",playerId:value.slice(value.indexOf(":")+1)});
  const playerIds=destinations.map(destination=>destination.playerId);
  if(new Set(playerIds).size!==playerIds.length){ui.midiImportStatus.textContent="Each MIDI lane needs a different destination player.";return;}
  state.orchestrationBusy=true;
  ui.midiImportCommit.disabled=true;
  ui.midiFile.disabled=true;
  try{
    ui.midiImportStatus.textContent="Finishing pending note edits…";
    await settleAutosaves();
    ui.midiImportStatus.textContent="Importing fresh player clips…";
    const lanes=selectedRows.map(({lane},index)=>{
      const destination=destinations[index];
      return {...lane,playerId:destination.playerId,createPlayer:destination.kind==="new",playerLabel:lane.trackName||lane.label};
    });
    const response=await fetch("/clips/actions/import-midi-to-players",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({blockId:ui.block.value,sourceName:parsed.sourceName,format:parsed.format,ppq:parsed.ppq,durationBeats:parsed.durationBeats,tempo:parsed.tempo,timeSignature:parsed.timeSignature,applyTempo:ui.midiApplyTempo.checked,applyDuration:ui.midiApplyDuration.checked,lanes,expectedVersion:state.score.version,expectedScoreRevision:state.score.scoreRevision,expectedStructureRevision:state.score.structureRevision})});
    const payload=await response.json();
    if(!response.ok)throw new Error(payload.error||`HTTP ${response.status}`);
    state.score=payload.score;
    draftStore.reconcile(payload.score);
    const firstPlayerId=payload.import.playerIds[0];
    populateSelectors(true);
    if(players().includes(firstPlayerId))ui.player.value=firstPlayerId;
    setOptions(ui.clip,clipsForPlayer(),clipsForPlayer()[0]||"");
    loadClip();resize();
    ui.midiDialog.close();
    status(`Imported ${payload.import.noteCount} notes from ${payload.import.sourceName} into ${payload.import.laneCount} player${payload.import.laneCount===1?"":"s"} in section ${payload.import.blockId}.`);
  }catch(error){
    ui.midiImportStatus.textContent=`Import failed: ${error.message}`;
  }finally{
    state.orchestrationBusy=false;
    ui.midiImportCommit.disabled=false;
    ui.midiFile.disabled=false;
  }
}

async function moveOrchestrationNote(destination){
  if(state.orchestrationBusy||!state.menuNote)return;
  const source=clone(state.menuNote);
  state.orchestrationBusy=true;
  closeNoteMenu();
  try{
    status("Finishing pending edits before moving the note…");
    await settleAutosaves();
    let confirmShared=false;
    let payload;
    for(;;){
      const response=await fetch("/clips/actions/move-note",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({blockId:source.blockId,sourcePlayerId:source.playerId,sourceClipId:source.clipId,noteIndex:source.sourceIndex,noteId:source.sourceNote?.note_id,destinationPlayerId:destination.playerId,expectedVersion:state.score.version,confirmShared})});
      payload=await response.json();
      if(response.ok)break;
      if(payload.code==="shared_clip_confirmation_required"&&!confirmShared){
        const locations=(payload.references||[]).map(reference=>String(reference).replace(":", " clip at ")).join("\n");
        if(!window.confirm(`This move changes a clip shared elsewhere in the score:\n\n${locations}\n\nMove the note anyway?`))return;
        confirmShared=true;
        continue;
      }
      throw new Error(payload.error||`HTTP ${response.status}`);
    }
    state.score=payload.score;
    draftStore.reconcile(payload.score);
    populateSelectors(true);
    loadClip();
    resize();
    const targetLabel=state.score?.assignments?.[destination.playerId]?.label||destination.playerId;
    status(`Moved ${pitchName(source.sourceNote.pitch)} at beat ${fmt(source.sourceNote.start_time)} to ${targetLabel}${payload.move.createdDestinationClip?` and created ${payload.move.destinationClipId}`:""}.`);
  }catch(error){
    status(`Move failed: ${error.message}`,true);
  }finally{
    state.orchestrationBusy=false;
  }
}

async function loadScore(preserve=false){
  if(state.orchestrationBusy)return;
  try { const [response,timingResponse]=await Promise.all([fetch("/score",{cache:"no-store"}),fetch("/playback/timing-contracts",{cache:"no-store"})]); if(!response.ok) throw new Error(`HTTP ${response.status}`); const score=await response.json();
    if(timingResponse.ok){const timing=await timingResponse.json();state.timingContracts=timing.contracts||[];}
    if(preserve && score.version === state.score?.version){ state.score=score;if(followChase())return; updateLabels(); render(); return; }
    closeNoteMenu();state.score=score;draftStore.reconcile(score);populateSelectors(preserve);loadClip(true);const entry=activeDraftEntry();status(entry?.stale?`${state.clipId} changed on the server. Revert before continuing or review it in Event List.`:`Score revision ${score.scoreRevision ?? score.version}. ${draftStore.dirtyCount()} unsaved clip draft${draftStore.dirtyCount()===1?"":"s"}.`);render();
  } catch(error){ status(`Load failed: ${error.message}`,true); }
}
function populateSelectors(preserve){
  const oldBlock=preserve?ui.block.value:""; const chasedBlock=state.chasing?activeBlockId():""; const block=blocks().includes(chasedBlock)?chasedBlock:blocks().includes(oldBlock)?oldBlock:(state.score?.structureState?.activeBlockId||blocks()[0]||""); setOptions(ui.block,blocks(),block);
  const oldPlayer=preserve?ui.player.value:""; const p=players(); setOptions(ui.player,p,p.includes(oldPlayer)?oldPlayer:p[0]||"",v=>state.score?.assignments?.[v]?.label||v);
  const oldClip=preserve?ui.clip.value:""; const c=clipsForPlayer(); setOptions(ui.clip,c,c.includes(oldClip)?oldClip:c[0]||"");
}
function loadClip(preserveSelection=false){ state.clipId=ui.clip.value; const clip=state.score?.clips?.[state.clipId]||{notes:[],duration:{bars:1},playbackType:"looped",context:{clip:{},grid:{subdivision:16}},behavior:{}};const entry=draftStore.open(state.clipId,clip,state.score?.version);state.snapshot=entry.snapshot;state.draft=entry.draft;state.dirty=entry.dirty;state.stale=entry.stale;if(!preserveSelection)state.selected=-1; updateLabels(); markDirty(); }
function activeDraftEntry(){return draftStore.get(state.clipId);}
function activeBlockId(){return state.playback?.activeBlockId||state.score?.structureState?.activeBlockId||"";}
function followChase(){const blockId=activeBlockId();if(!state.chasing||!blockId||blockId===ui.block.value||!blocks().includes(blockId))return false;populateSelectors(true);loadClip();resize();return true;}
function updateLabels(){ ui.editing.textContent=state.clipId?`${ui.block.value} · ${ui.player.options[ui.player.selectedIndex]?.text || ui.player.value} · ${state.clipId}`:"No assigned clip"; ui.playing.textContent=state.score?.structureState?.activeBlockId||"Stopped"; updateSelection(); }
function updateSelection(){ const n=selectedNote(); ui.selection.textContent=n?`#${noteId(n,state.selected)} · ${n.pitch} · ${fmt(n.start_time)} + ${fmt(n.duration)}`:"None"; ui.velocityValue.value=n?String(n.velocity):"—"; }
function markDirty(){const entry=activeDraftEntry();if(entry){state.dirty=entry.dirty;state.stale=entry.stale;}ui.revert.disabled=!state.dirty&&!state.stale;const otherDirty=draftStore.dirtyClipIds().filter(clipId=>clipId!==state.clipId);ui.dirty.textContent=state.stale?"Stale draft":state.saving?"Saving…":state.dirty?"Saving…":otherDirty.length?`${otherDirty.length} saving elsewhere`:"Saved";ui.dirty.title=otherDirty.length?`Pending: ${otherDirty.join(", ")}`:"";ui.dirty.className=`badge${state.stale?" stale":state.dirty||otherDirty.length?" dirty":""}`; }
function mutate(fn){ fn();const entry=draftStore.markDirty(state.clipId);if(entry)entry.draft=state.draft; markDirty();queueAutosave(); updateSelection(); render(); }
function queueAutosave(clipId=state.clipId){if(clipId)state.pendingSaves.add(clipId);clearTimeout(state.saveTimer);state.saveTimer=setTimeout(()=>{if(state.drag){queueAutosave(clipId);return;}void saveNextClip();},300);}
async function saveNextClip(){if(state.saving)return;const clipId=[...state.pendingSaves][0];if(!clipId)return;state.pendingSaves.delete(clipId);const entry=draftStore.get(clipId);if(!entry?.dirty||entry.stale){if(state.pendingSaves.size)queueAutosave();return;}try{state.saving=true;markDirty();status(`Saving ${clipId}…`);const response=await fetch(`/clips/${encodeURIComponent(clipId)}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({clip:clone(entry.draft),expectedVersion:entry.baseVersion})});const payload=await response.json();if(!response.ok)throw new Error(payload.error||`HTTP ${response.status}`);state.score=payload;draftStore.saved(clipId,payload.clips[clipId],payload.version);draftStore.reconcile(payload);if(state.clipId===clipId)loadClip(true);status(`Saved ${clipId} at score revision ${payload.scoreRevision??payload.version}.`);render();}catch(error){entry.stale=/stale|version/i.test(error.message);status(`Autosave failed: ${error.message}`,true);}finally{state.saving=false;markDirty();if(state.pendingSaves.size)queueAutosave();}}
function status(message,error=false){ ui.status.textContent=message; ui.status.style.color=error?"var(--ss-warn)":""; }
function fmt(n){ return Number(n).toFixed(3).replace(/\.0+$|(?<=\.[0-9]*)0+$/g,""); }

function resize(){
  const beats=timelineBeats(); const rows=Math.max(1,visiblePitches().length); const width=Math.max(ui.rollScroll.clientWidth,state.left+beats*beatWidth()+30); const height=Math.max(ui.rollScroll.clientHeight,state.top+rows*rowHeight());
  sizeCanvas(ui.roll,width,height); sizeCanvas(ui.velocity,width,112);ui.rollWiper.style.height=`${height}px`;ui.velocityWiper.style.height="112px";renderPitchLabels(height);render();renderWiperFrame();
}
function renderPitchLabels(height){const rh=rowHeight();ui.pitchLabels.style.height=`${height}px`;ui.pitchLabels.replaceChildren(...visiblePitches().map((pitch,row)=>{const label=document.createElement("span");label.className=`pitch-label${[1,3,6,8,10].includes(pitch%12)?" black":""}`;label.style.top=`${state.top+row*rh}px`;label.style.height=`${rh}px`;label.textContent=pitchName(pitch);return label;}));syncScrollSurfaces();}
function syncScrollSurfaces(){ui.velocityScroll.scrollLeft=ui.rollScroll.scrollLeft;ui.pitchLabels.style.transform=`translate3d(${ui.rollScroll.scrollLeft}px,0,0)`;}
function sizeCanvas(canvas,w,h){ const metrics=canvasMetrics(w,h,{devicePixelRatio:state.dpr});canvas.style.width=`${metrics.cssWidth}px`;canvas.style.height=`${metrics.cssHeight}px`;canvas.width=metrics.width;canvas.height=metrics.height;canvasScales.set(canvas,metrics.scale); }
function prep(context){ const scale=canvasScales.get(context.canvas)||1;context.setTransform(scale,0,0,scale,0,0);context.clearRect(0,0,context.canvas.width/scale,context.canvas.height/scale); }
function render(){ if(!state.draft)return; drawRoll(); drawVelocity(); }
function drawRoll(){ prep(ctx); const scale=canvasScales.get(ui.roll)||1,w=ui.roll.width/scale,h=ui.roll.height/scale,rh=rowHeight(),bw=beatWidth(),beats=timelineBeats(),ts=timeSignature(),pitches=visiblePitches(); ctx.fillStyle="#10141d";ctx.fillRect(0,0,w,h);
  pitches.forEach((pitch,row)=>{ const y=state.top+row*rh; const black=[1,3,6,8,10].includes(pitch%12); ctx.fillStyle=black?"#171b25":"#1c212c";ctx.fillRect(state.left,y,w-state.left,rh);ctx.strokeStyle="#2b3240";ctx.strokeRect(0,y,state.left,rh);ctx.fillStyle=black?"#aab2c3":"#dce4f2";ctx.font="11px system-ui";ctx.textAlign="right";ctx.fillText(pitchName(pitch),state.left-8,y+rh*.68); });
  const lineStep=timelineGridStep(gridStep(),bw),labelInterval=timelineLabelInterval(bw,ts.numerator);for(let beat=0;beat<=beats;beat+=lineStep){ const rounded=Math.round(beat),x=state.left+beat*bw; const whole=Math.abs(beat-rounded)<1e-6; const bar=whole&&rounded%ts.numerator===0; ctx.strokeStyle=bar?"#5d687b":whole?"#3d4657":"#272e3a";ctx.lineWidth=bar?1.5:1;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke(); if(whole&&rounded%labelInterval===0){ctx.fillStyle="#98a2b5";ctx.textAlign="left";ctx.fillText(`${Math.floor(beat/ts.numerator)+1}.${rounded%ts.numerator+1}`,x+4,14);} }
  drawReferences(); drawFocusedOccurrences(); }
function drawReferences(){ const block=state.score?.mesostructure?.[ui.block.value]; for(const [player,assignment] of Object.entries(block?.players||{})){const id=assignmentId(assignment);if(id===state.clipId)continue;const clip=state.score?.clips?.[id];for(const occurrence of projectClipOccurrences(clip?.notes||[],{clipDuration:clipBeats(clip),timelineDuration:timelineBeats(),playbackType:clip?.playbackType}))drawBar(occurrence.note,playerColor(player),occurrence.alias?.1:.16,false,occurrence.alias);}}
function drawFocusedOccurrences(){ const occurrences=projectClipOccurrences(state.draft.notes||[],{clipDuration:clipBeats(),timelineDuration:timelineBeats(),playbackType:state.draft.playbackType});for(const occurrence of occurrences){if(occurrence.alias)drawBar(occurrence.note,playerColor(ui.player.value),.32,false,true);} (state.draft.notes||[]).forEach((note,index)=>drawNote(note,index)); }
function drawNote(note,index){ drawBar(note,playerColor(ui.player.value),index===state.selected?1:.82,index===state.selected); }
function drawBar(note,color,alpha,selected,alias=false){ const row=rowForPitch(note.pitch);if(row<0)return;const x=state.left+Number(note.start_time)*beatWidth(), y=state.top+row*rowHeight()+2, width=Math.max(5,Number(note.duration)*beatWidth()),height=rowHeight()-4;ctx.globalAlpha=alpha;ctx.fillStyle=color;ctx.fillRect(x,y,width,height);ctx.globalAlpha=1;if(alias){ctx.save();ctx.setLineDash([5,4]);ctx.strokeStyle=color;ctx.strokeRect(x+.5,y+.5,width-1,height-1);ctx.restore();}if(selected){ctx.strokeStyle="#fff";ctx.lineWidth=2;ctx.strokeRect(x,y,width,height);ctx.fillStyle="#fff";ctx.fillRect(x+width-5,y,5,height);} }
function drawVelocity(){ prep(vctx);const scale=canvasScales.get(ui.velocity)||1,w=ui.velocity.width/scale,h=112;vctx.fillStyle="#10141d";vctx.fillRect(0,0,w,h);for(let beat=0;beat<=timelineBeats();beat+=1){const x=state.left+beat*beatWidth();vctx.strokeStyle="#303746";vctx.beginPath();vctx.moveTo(x,0);vctx.lineTo(x,h);vctx.stroke();}(state.draft.notes||[]).forEach((note,index)=>{const x=state.left+Number(note.start_time)*beatWidth()+2,width=Math.max(5,Math.min(14,Number(note.duration)*beatWidth()-4)),height=clamp(Number(note.velocity),1,127)/127*102;vctx.fillStyle=index===state.selected?"#fff":playerColor(ui.player.value);vctx.globalAlpha=index===state.selected?1:.72;vctx.fillRect(x,108-height,width,height);});vctx.globalAlpha=1;}
function renderWiperFrame(){const view=wiperEstimator.estimate();const visible=view&&Number.isFinite(view.beat)&&view.blockId===ui.block.value;if(!visible){ui.rollWiper.hidden=true;ui.velocityWiper.hidden=true;return view;}const x=state.left+clamp(view.beat,0,timelineBeats())*beatWidth();const transform=`translate3d(${x}px,0,0)`;ui.rollWiper.style.transform=transform;ui.velocityWiper.style.transform=transform;ui.rollWiper.hidden=false;ui.velocityWiper.hidden=false;if(shouldFollowPlayhead(view)){const next=playheadScrollLeft({mode:ui.scrollChase.value,playheadX:x,scrollLeft:ui.rollScroll.scrollLeft,viewportWidth:ui.rollScroll.clientWidth,contentWidth:ui.roll.scrollWidth,gutterWidth:state.left});if(Math.abs(next-ui.rollScroll.scrollLeft)>=.5){ui.rollScroll.scrollLeft=next;syncScrollSurfaces();}}return view;}
function scheduleWiperFrame(){if(state.wiperFrame!==null)return;state.wiperFrame=requestAnimationFrame(()=>{state.wiperFrame=null;const view=renderWiperFrame();if(view?.running&&!view.stale)scheduleWiperFrame();});}
function pitchName(p){const names=["C","C♯","D","E♭","E","F","F♯","G","A♭","A","B♭","B"];return `${names[p%12]}${Math.floor(p/12)-1}`;}

function pointer(event,lane){ const rect=event.currentTarget.getBoundingClientRect(); return {x:event.clientX-rect.left,y:event.clientY-rect.top}; }
function hitNote(x,y){ return hitTestNotes(state.draft?.notes||[], { pitch:pitchForY(y), time:(x-state.left)/beatWidth() }); }
ui.roll.addEventListener("pointerdown",event=>{ if(!state.clipId||event.button!==0)return;ui.roll.focus({preventScroll:true});const p=pointer(event);if(event.altKey){event.preventDefault();const orchestrationHit=hitOrchestrationNote(p.x,p.y);if(orchestrationHit)openNoteMenu(orchestrationHit,event.clientX,event.clientY);else closeNoteMenu();return;}closeNoteMenu();const wasDirty=state.dirty,pitches=visiblePitches();const hit=hitNote(p.x,p.y);ui.roll.setPointerCapture(event.pointerId);if(hit){state.selected=hit.index;const right=state.left+(Number(hit.note.start_time)+Number(hit.note.duration))*beatWidth();state.drag={kind:right-p.x<=9?"resize":"move",start:p,note:clone(hit.note),wasDirty,pitches};}else{const start=Math.max(0,snap((p.x-state.left)/beatWidth()));const pitch=pitchForY(p.y,pitches)??60;mutate(()=>{state.draft.notes.push({note_id:nextNoteId(),pitch,start_time:start,duration:gridStep(),velocity:100,mute:0,probability:1,velocity_deviation:0,release_velocity:64});state.selected=state.draft.notes.length-1;});state.drag={kind:"resize",start:p,note:clone(selectedNote()),wasDirty,created:true,pitches};}updateSelection();render();});
ui.roll.addEventListener("contextmenu",event=>{const p=pointer(event);const hit=hitOrchestrationNote(p.x,p.y);if(!hit)return;event.preventDefault();openNoteMenu(hit,event.clientX,event.clientY);});
ui.roll.addEventListener("pointermove",event=>{if(!state.drag)return;const p=pointer(event),dx=(p.x-state.drag.start.x)/beatWidth();mutate(()=>{let next;if(state.drag.kind==="move"){const targetPitch=pitchForY(p.y,state.drag.pitches);next=moveNote(state.drag.note,{deltaTime:dx,deltaPitch:targetPitch-Number(state.drag.note.pitch),subdivision:Number(ui.grid.value),clipDuration:clipBeats()});}else next=resizeNoteRight(state.drag.note,{deltaTime:dx,subdivision:Number(ui.grid.value),clipDuration:clipBeats()});state.draft.notes[state.selected]=next;});});
ui.roll.addEventListener("pointerup",()=>state.drag=null);ui.roll.addEventListener("pointercancel",cancelDrag);
ui.velocity.addEventListener("pointerdown",event=>{const p=pointer(event);const nearest=(state.draft?.notes||[]).map((n,i)=>({i,d:Math.abs(state.left+Number(n.start_time)*beatWidth()-p.x)})).sort((a,b)=>a.d-b.d)[0];if(nearest&&nearest.d<18)state.selected=nearest.i;if(!selectedNote())return;ui.velocity.setPointerCapture(event.pointerId);state.drag={kind:"velocity",note:clone(selectedNote()),wasDirty:state.dirty};editVelocity(p.y);});
ui.velocity.addEventListener("pointermove",event=>{if(state.drag?.kind==="velocity")editVelocity(pointer(event).y);});ui.velocity.addEventListener("pointerup",()=>state.drag=null);ui.velocity.addEventListener("pointercancel",cancelDrag);
function editVelocity(y){if(!selectedNote())return;mutate(()=>selectedNote().velocity=velocityFromLanePosition(y,112));}
function nextNoteId(){return Math.max(0,...(state.draft?.notes||[]).map((n,i)=>Number(noteId(n,i))||0))+1;}
function cancelDrag(){if(!state.drag)return;if(state.drag.created)state.draft.notes.splice(state.selected,1);else if(state.drag.note&&selectedNote())state.draft.notes[state.selected]=state.drag.note;const entry=activeDraftEntry();if(entry){entry.dirty=state.drag.wasDirty;entry.draft=state.draft;}state.drag=null;if(state.selected>=state.draft.notes.length)state.selected=state.draft.notes.length-1;markDirty();updateSelection();render();}

ui.roll.addEventListener("keydown",event=>{const note=selectedNote();if((event.key==="ContextMenu"||(event.shiftKey&&event.key==="F10"))&&note){event.preventDefault();const rect=ui.roll.getBoundingClientRect(),row=rowForPitch(note.pitch);openNoteMenu({blockId:ui.block.value,playerId:ui.player.value,clipId:state.clipId,sourceIndex:state.selected,occurrenceIndex:0,alias:false,note,sourceNote:note},rect.left+state.left+(Number(note.start_time)+Number(note.duration))*beatWidth(),rect.top+state.top+(row+.5)*rowHeight());return;}if(event.key==="Escape"){state.selected=-1;updateSelection();render();return;}if(!note)return;if(event.key==="Delete"||event.key==="Backspace"){event.preventDefault();mutate(()=>{state.draft.notes.splice(state.selected,1);state.selected=Math.min(state.selected,state.draft.notes.length-1);});return;}const directions={ArrowLeft:"left",ArrowRight:"right",ArrowUp:"up",ArrowDown:"down"};const direction=directions[event.key];if(!direction)return;event.preventDefault();mutate(()=>{state.draft.notes[state.selected]=nudgeNote(note,{direction,resize:event.shiftKey,subdivision:Number(ui.grid.value),clipDuration:clipBeats()});});});

async function loadPlayback(){if(state.playbackRequest)return;const controller=new AbortController();state.playbackRequest=controller;try{const response=await fetch("/playback/snapshot",{cache:"no-store",signal:controller.signal});if(!response.ok)return;const snapshot=await response.json();const receivedAt=Date.now();if(!Number.isInteger(snapshot.generation)||snapshot.generation<=state.playbackGeneration)return;state.playbackGeneration=snapshot.generation;state.rnboTargets=Object.values(snapshot.targets||{});state.timingContracts=snapshot.timingContracts||[];state.playback={...(snapshot.playback||{}),playing:Boolean(snapshot.transport?.rolling??snapshot.transport?.running)};followChase();const beat=playbackBeatForVoice({playback:state.playback,blockId:ui.block.value,voiceId:ui.player.value,assignment:state.score?.assignments?.[ui.player.value],targets:state.rnboTargets,contracts:state.timingContracts});if(Number.isFinite(beat)){wiperEstimator.update({beat,tempo:snapshot.transport?.tempo,running:state.playback.playing,blockId:state.playback.activeBlockId,observedAt:snapshot.observedAt},receivedAt);}else wiperEstimator.clear();scheduleWiperFrame();ui.playing.textContent=Number.isFinite(beat)?`${state.playback.activeBlockId} · ${state.playback.playing?"":"client "}beat ${fmt(beat)}`:state.playback.playing?state.playback.activeBlockId:"Stopped";}catch(error){if(error?.name!=="AbortError")console.warn("Playback snapshot refresh failed",error);}finally{if(state.playbackRequest===controller)state.playbackRequest=null;}}

ui.block.addEventListener("change",()=>{closeNoteMenu();populateSelectors(true);loadClip();resize();});ui.player.addEventListener("change",()=>{closeNoteMenu();setOptions(ui.clip,clipsForPlayer(),clipsForPlayer()[0]||"");loadClip();resize();});ui.clip.addEventListener("change",()=>{closeNoteMenu();loadClip();resize();});
ui.chase.addEventListener("change",()=>{state.chasing=ui.chase.checked;ui.block.disabled=state.chasing;if(state.chasing)followChase();});
ui.zoomFit.addEventListener("click",()=>{const fit=Math.max(Number(ui.zoomX.min),Math.min(Number(ui.zoomX.max),(ui.rollScroll.clientWidth-state.left-30)/timelineBeats()));ui.zoomX.value=String(fit);ui.rollScroll.scrollLeft=0;state.lastBeatWidth=fit;resize();});
ui.fold.addEventListener("click",()=>{state.folded=!state.folded;ui.fold.setAttribute("aria-pressed",String(state.folded));ui.rollScroll.scrollTop=0;resize();});
ui.importMidi.addEventListener("click",openMidiImport);
ui.midiFile.addEventListener("change",()=>void readMidiFile());
ui.midiForm.addEventListener("submit",event=>void commitMidiImport(event));
ui.midiImportClose.addEventListener("click",()=>ui.midiDialog.close());
ui.midiImportCancel.addEventListener("click",()=>ui.midiDialog.close());
ui.revert.addEventListener("click",()=>{const entry=draftStore.revert(state.clipId);state.snapshot=entry.snapshot;state.draft=entry.draft;state.selected=-1;markDirty();updateSelection();resize();status(`Reverted ${state.clipId} to its last server snapshot.`);});
[ui.grid,ui.zoomY].forEach(control=>control.addEventListener("input",resize));ui.zoomX.addEventListener("input",()=>{const oldBeatWidth=state.lastBeatWidth,newBeatWidth=beatWidth(),oldScrollLeft=ui.rollScroll.scrollLeft;resize();ui.rollScroll.scrollLeft=zoomAnchorScrollLeft({oldBeatWidth,newBeatWidth,scrollLeft:oldScrollLeft,viewportWidth:ui.rollScroll.clientWidth,contentWidth:ui.roll.scrollWidth,gutterWidth:state.left});state.lastBeatWidth=newBeatWidth;syncScrollSurfaces();renderWiperFrame();});ui.rollScroll.addEventListener("scroll",syncScrollSurfaces);addEventListener("resize",resize);addEventListener("beforeunload",event=>{clearTimeout(state.saveTimer);if(draftStore.hasDirty()){event.preventDefault();event.returnValue="";}});
ui.moveTo.addEventListener("mouseenter",()=>openMoveSubmenu());
ui.moveTo.addEventListener("click",()=>openMoveSubmenu(true));
ui.noteMenu.addEventListener("keydown",event=>{if(event.key==="Escape"){event.preventDefault();if(!ui.moveToMenu.hidden){ui.moveToMenu.hidden=true;ui.moveTo.setAttribute("aria-expanded","false");ui.moveTo.focus();}else{closeNoteMenu();ui.roll.focus();}}else if(event.key==="ArrowRight"&&event.target===ui.moveTo){event.preventDefault();openMoveSubmenu(true);}else if(event.key==="ArrowLeft"&&ui.moveToMenu.contains(event.target)){event.preventDefault();ui.moveToMenu.hidden=true;ui.moveTo.setAttribute("aria-expanded","false");ui.moveTo.focus();}});
document.addEventListener("pointerdown",event=>{if(!ui.noteMenu.hidden&&!ui.noteMenu.contains(event.target)&&!event.defaultPrevented)closeNoteMenu();});
document.addEventListener("visibilitychange",()=>{if(!document.hidden)scheduleWiperFrame();});
setInterval(()=>loadScore(true),5000);setInterval(loadPlayback,250);await loadScore();await loadPlayback();resize();
