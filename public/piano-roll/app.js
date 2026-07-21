import {
  clamp,
  gridStepsPerBeat,
  hitTestNotes,
  moveNote,
  nudgeNote,
  playbackBeatForVoice,
  projectClipOccurrences,
  resizeNoteRight,
  snapBeat,
  velocityFromLanePosition
} from "/piano-roll/clip-editor-core.js";
import { createClipDraftStore } from "/piano-roll/clip-draft-store.js";
import { createPlaybackUpdateControl } from "/shared/playback-update-control.js";

const $ = (id) => document.getElementById(id);
const ui = { block:$("block"), player:$("player"), clip:$("clip"), grid:$("grid"), zoomX:$("zoom-x"), zoomY:$("zoom-y"), chase:$("chase"), fold:$("fold"), revert:$("revert"), dirty:$("dirty"), editing:$("editing"), playing:$("playing"), selection:$("selection"), status:$("status"), playbackUpdate:$("playback-update"), roll:$("roll"), velocity:$("velocity"), rollScroll:$("roll-scroll"), velocityScroll:$("velocity-scroll"), velocityValue:$("velocity-value") };
const ctx = ui.roll.getContext("2d"); const vctx = ui.velocity.getContext("2d");
const draftStore=createClipDraftStore();
const state = { score:null, snapshot:null, draft:null, clipId:"", selected:-1, dirty:false, stale:false, saving:false, pendingSaves:new Set(), saveTimer:null, chasing:false, folded:false, drag:null, playback:null, playbackGeneration:0, playbackRequest:null, rnboTargets:[], timingContracts:[], dpr:Math.max(1,devicePixelRatio||1), left:58, top:22, minPitch:36, maxPitch:84 };
createPlaybackUpdateControl({ root:ui.playbackUpdate, getBlockId:()=>ui.block.value });

const clone = (value) => structuredClone(value);
const assignmentId = (value) => typeof value === "string" ? value : value?.clipId || "";
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

async function loadScore(preserve=false){
  try { const [response,timingResponse]=await Promise.all([fetch("/score",{cache:"no-store"}),fetch("/playback/timing-contracts",{cache:"no-store"})]); if(!response.ok) throw new Error(`HTTP ${response.status}`); const score=await response.json();
    if(timingResponse.ok){const timing=await timingResponse.json();state.timingContracts=timing.contracts||[];}
    if(preserve && score.version === state.score?.version){ state.score=score;if(followChase())return; updateLabels(); render(); return; }
    state.score=score;draftStore.reconcile(score);populateSelectors(preserve);loadClip(true);const entry=activeDraftEntry();status(entry?.stale?`${state.clipId} changed on the server. Revert before continuing or review it in Event List.`:`Score revision ${score.scoreRevision ?? score.version}. ${draftStore.dirtyCount()} unsaved clip draft${draftStore.dirtyCount()===1?"":"s"}.`);render();
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
  sizeCanvas(ui.roll,width,height); sizeCanvas(ui.velocity,width,112); render();
}
function sizeCanvas(canvas,w,h){ canvas.style.width=`${w}px`;canvas.style.height=`${h}px`;canvas.width=Math.round(w*state.dpr);canvas.height=Math.round(h*state.dpr); }
function prep(context){ context.setTransform(state.dpr,0,0,state.dpr,0,0); context.clearRect(0,0,context.canvas.width/state.dpr,context.canvas.height/state.dpr); }
function render(){ if(!state.draft)return; drawRoll(); drawVelocity(); }
function drawRoll(){ prep(ctx); const w=ui.roll.width/state.dpr,h=ui.roll.height/state.dpr,rh=rowHeight(),bw=beatWidth(),beats=timelineBeats(),ts=timeSignature(),pitches=visiblePitches(); ctx.fillStyle="#10141d";ctx.fillRect(0,0,w,h);
  pitches.forEach((pitch,row)=>{ const y=state.top+row*rh; const black=[1,3,6,8,10].includes(pitch%12); ctx.fillStyle=black?"#171b25":"#1c212c";ctx.fillRect(state.left,y,w-state.left,rh);ctx.strokeStyle="#2b3240";ctx.strokeRect(0,y,state.left,rh);ctx.fillStyle=black?"#aab2c3":"#dce4f2";ctx.font="11px system-ui";ctx.textAlign="right";ctx.fillText(pitchName(pitch),state.left-8,y+rh*.68); });
  for(let beat=0;beat<=beats;beat+=gridStep()){ const x=state.left+beat*bw; const whole=Math.abs(beat-Math.round(beat))<1e-6; const bar=whole&&Math.round(beat)%ts.numerator===0; ctx.strokeStyle=bar?"#5d687b":whole?"#3d4657":"#272e3a";ctx.lineWidth=bar?1.5:1;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke(); if(whole){ctx.fillStyle="#98a2b5";ctx.textAlign="left";ctx.fillText(`${Math.floor(beat/ts.numerator)+1}.${Math.round(beat)%ts.numerator+1}`,x+4,14);} }
  drawReferences(); drawFocusedOccurrences(); drawWiper(ctx,h); }
function drawReferences(){ const block=state.score?.mesostructure?.[ui.block.value]; for(const [player,assignment] of Object.entries(block?.players||{})){const id=assignmentId(assignment);if(id===state.clipId)continue;const clip=state.score?.clips?.[id];for(const occurrence of projectClipOccurrences(clip?.notes||[],{clipDuration:clipBeats(clip),timelineDuration:timelineBeats(),playbackType:clip?.playbackType}))drawBar(occurrence.note,playerColor(player),occurrence.alias?.1:.16,false,occurrence.alias);}}
function drawFocusedOccurrences(){ const occurrences=projectClipOccurrences(state.draft.notes||[],{clipDuration:clipBeats(),timelineDuration:timelineBeats(),playbackType:state.draft.playbackType});for(const occurrence of occurrences){if(occurrence.alias)drawBar(occurrence.note,playerColor(ui.player.value),.32,false,true);} (state.draft.notes||[]).forEach((note,index)=>drawNote(note,index)); }
function drawNote(note,index){ drawBar(note,playerColor(ui.player.value),index===state.selected?1:.82,index===state.selected); }
function drawBar(note,color,alpha,selected,alias=false){ const row=rowForPitch(note.pitch);if(row<0)return;const x=state.left+Number(note.start_time)*beatWidth(), y=state.top+row*rowHeight()+2, width=Math.max(5,Number(note.duration)*beatWidth()),height=rowHeight()-4;ctx.globalAlpha=alpha;ctx.fillStyle=color;ctx.fillRect(x,y,width,height);ctx.globalAlpha=1;if(alias){ctx.save();ctx.setLineDash([5,4]);ctx.strokeStyle=color;ctx.strokeRect(x+.5,y+.5,width-1,height-1);ctx.restore();}if(selected){ctx.strokeStyle="#fff";ctx.lineWidth=2;ctx.strokeRect(x,y,width,height);ctx.fillStyle="#fff";ctx.fillRect(x+width-5,y,5,height);} }
function drawVelocity(){ prep(vctx);const w=ui.velocity.width/state.dpr,h=112;vctx.fillStyle="#10141d";vctx.fillRect(0,0,w,h);for(let beat=0;beat<=timelineBeats();beat+=1){const x=state.left+beat*beatWidth();vctx.strokeStyle="#303746";vctx.beginPath();vctx.moveTo(x,0);vctx.lineTo(x,h);vctx.stroke();}(state.draft.notes||[]).forEach((note,index)=>{const x=state.left+Number(note.start_time)*beatWidth()+2,width=Math.max(5,Math.min(14,Number(note.duration)*beatWidth()-4)),height=clamp(Number(note.velocity),1,127)/127*102;vctx.fillStyle=index===state.selected?"#fff":playerColor(ui.player.value);vctx.globalAlpha=index===state.selected?1:.72;vctx.fillRect(x,108-height,width,height);});vctx.globalAlpha=1;drawWiper(vctx,h);}
function drawWiper(context,height){const beat=playbackBeatForVoice({playback:state.playback,blockId:ui.block.value,voiceId:ui.player.value,assignment:state.score?.assignments?.[ui.player.value],targets:state.rnboTargets,contracts:state.timingContracts});if(!Number.isFinite(beat))return;const x=state.left+clamp(beat,0,timelineBeats())*beatWidth();context.save();context.strokeStyle="#ffd166";context.lineWidth=2;context.beginPath();context.moveTo(x,0);context.lineTo(x,height);context.stroke();context.restore();}
function pitchName(p){const names=["C","C♯","D","E♭","E","F","F♯","G","A♭","A","B♭","B"];return `${names[p%12]}${Math.floor(p/12)-1}`;}

function pointer(event,lane){ const rect=event.currentTarget.getBoundingClientRect(); return {x:event.clientX-rect.left,y:event.clientY-rect.top}; }
function hitNote(x,y){ return hitTestNotes(state.draft?.notes||[], { pitch:pitchForY(y), time:(x-state.left)/beatWidth() }); }
ui.roll.addEventListener("pointerdown",event=>{ if(!state.clipId)return;ui.roll.focus({preventScroll:true});const wasDirty=state.dirty,pitches=visiblePitches(); const p=pointer(event);const hit=hitNote(p.x,p.y);ui.roll.setPointerCapture(event.pointerId);if(hit){state.selected=hit.index;const right=state.left+(Number(hit.note.start_time)+Number(hit.note.duration))*beatWidth();state.drag={kind:right-p.x<=9?"resize":"move",start:p,note:clone(hit.note),wasDirty,pitches};}else{const start=Math.max(0,snap((p.x-state.left)/beatWidth()));const pitch=pitchForY(p.y,pitches)??60;mutate(()=>{state.draft.notes.push({note_id:nextNoteId(),pitch,start_time:start,duration:gridStep(),velocity:100,mute:0,probability:1,velocity_deviation:0,release_velocity:64});state.selected=state.draft.notes.length-1;});state.drag={kind:"resize",start:p,note:clone(selectedNote()),wasDirty,created:true,pitches};}updateSelection();render();});
ui.roll.addEventListener("pointermove",event=>{if(!state.drag)return;const p=pointer(event),dx=(p.x-state.drag.start.x)/beatWidth();mutate(()=>{let next;if(state.drag.kind==="move"){const targetPitch=pitchForY(p.y,state.drag.pitches);next=moveNote(state.drag.note,{deltaTime:dx,deltaPitch:targetPitch-Number(state.drag.note.pitch),subdivision:Number(ui.grid.value),clipDuration:clipBeats()});}else next=resizeNoteRight(state.drag.note,{deltaTime:dx,subdivision:Number(ui.grid.value),clipDuration:clipBeats()});state.draft.notes[state.selected]=next;});});
ui.roll.addEventListener("pointerup",()=>state.drag=null);ui.roll.addEventListener("pointercancel",cancelDrag);
ui.velocity.addEventListener("pointerdown",event=>{const p=pointer(event);const nearest=(state.draft?.notes||[]).map((n,i)=>({i,d:Math.abs(state.left+Number(n.start_time)*beatWidth()-p.x)})).sort((a,b)=>a.d-b.d)[0];if(nearest&&nearest.d<18)state.selected=nearest.i;if(!selectedNote())return;ui.velocity.setPointerCapture(event.pointerId);state.drag={kind:"velocity",note:clone(selectedNote()),wasDirty:state.dirty};editVelocity(p.y);});
ui.velocity.addEventListener("pointermove",event=>{if(state.drag?.kind==="velocity")editVelocity(pointer(event).y);});ui.velocity.addEventListener("pointerup",()=>state.drag=null);ui.velocity.addEventListener("pointercancel",cancelDrag);
function editVelocity(y){if(!selectedNote())return;mutate(()=>selectedNote().velocity=velocityFromLanePosition(y,112));}
function nextNoteId(){return Math.max(0,...(state.draft?.notes||[]).map((n,i)=>Number(noteId(n,i))||0))+1;}
function cancelDrag(){if(!state.drag)return;if(state.drag.created)state.draft.notes.splice(state.selected,1);else if(state.drag.note&&selectedNote())state.draft.notes[state.selected]=state.drag.note;const entry=activeDraftEntry();if(entry){entry.dirty=state.drag.wasDirty;entry.draft=state.draft;}state.drag=null;if(state.selected>=state.draft.notes.length)state.selected=state.draft.notes.length-1;markDirty();updateSelection();render();}

ui.roll.addEventListener("keydown",event=>{const note=selectedNote();if(event.key==="Escape"){state.selected=-1;updateSelection();render();return;}if(!note)return;if(event.key==="Delete"||event.key==="Backspace"){event.preventDefault();mutate(()=>{state.draft.notes.splice(state.selected,1);state.selected=Math.min(state.selected,state.draft.notes.length-1);});return;}const directions={ArrowLeft:"left",ArrowRight:"right",ArrowUp:"up",ArrowDown:"down"};const direction=directions[event.key];if(!direction)return;event.preventDefault();mutate(()=>{state.draft.notes[state.selected]=nudgeNote(note,{direction,resize:event.shiftKey,subdivision:Number(ui.grid.value),clipDuration:clipBeats()});});});

async function loadPlayback(){if(state.playbackRequest)return;const controller=new AbortController();state.playbackRequest=controller;try{const response=await fetch("/playback/snapshot",{cache:"no-store",signal:controller.signal});if(!response.ok)return;const snapshot=await response.json();if(!Number.isInteger(snapshot.generation)||snapshot.generation<=state.playbackGeneration)return;state.playbackGeneration=snapshot.generation;state.rnboTargets=Object.values(snapshot.targets||{});state.timingContracts=snapshot.timingContracts||[];state.playback={...(snapshot.playback||{}),playing:Boolean(snapshot.transport?.running)};followChase();const beat=playbackBeatForVoice({playback:state.playback,blockId:ui.block.value,voiceId:ui.player.value,assignment:state.score?.assignments?.[ui.player.value],targets:state.rnboTargets,contracts:state.timingContracts});ui.playing.textContent=state.playback.playing?`${state.playback.activeBlockId}${Number.isFinite(beat)?` · beat ${fmt(beat)}`:""}`:"Stopped";render();}catch(error){if(error?.name!=="AbortError")console.warn("Playback snapshot refresh failed",error);}finally{if(state.playbackRequest===controller)state.playbackRequest=null;}}

ui.block.addEventListener("change",()=>{populateSelectors(true);loadClip();resize();});ui.player.addEventListener("change",()=>{setOptions(ui.clip,clipsForPlayer(),clipsForPlayer()[0]||"");loadClip();resize();});ui.clip.addEventListener("change",()=>{loadClip();resize();});
ui.chase.addEventListener("change",()=>{state.chasing=ui.chase.checked;ui.block.disabled=state.chasing;if(state.chasing)followChase();});
ui.fold.addEventListener("click",()=>{state.folded=!state.folded;ui.fold.setAttribute("aria-pressed",String(state.folded));ui.rollScroll.scrollTop=0;resize();});
ui.revert.addEventListener("click",()=>{const entry=draftStore.revert(state.clipId);state.snapshot=entry.snapshot;state.draft=entry.draft;state.selected=-1;markDirty();updateSelection();resize();status(`Reverted ${state.clipId} to its last server snapshot.`);});
[ui.grid,ui.zoomX,ui.zoomY].forEach(control=>control.addEventListener("input",resize));ui.rollScroll.addEventListener("scroll",()=>{ui.velocityScroll.scrollLeft=ui.rollScroll.scrollLeft;});addEventListener("resize",resize);addEventListener("beforeunload",event=>{clearTimeout(state.saveTimer);if(draftStore.hasDirty()){event.preventDefault();event.returnValue="";}});
setInterval(()=>loadScore(true),5000);setInterval(loadPlayback,250);await loadScore();await loadPlayback();resize();
