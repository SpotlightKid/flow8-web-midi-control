/* Flow 8 Web MIDI Remote - v14
 * Change: 48V (phantom) buttons now require a >2s hold to activate, single click to deactivate.
 * Tooltip updated to include 'Click and hold to activate'.
 */

const BOOL_ON=127, BOOL_OFF=0;

/* Controller numbers */
const CC_FADER=7, CC_MUTE=5, CC_SOLO=6;
const CC_GAIN=8, CC_LOWCUT=9, CC_COMP=11;
const CC_PAN=10;
const CC_EQ_LOW=1, CC_EQ_LOWMID=2, CC_EQ_HIMID=3, CC_EQ_HI=4;
const CC_SEND_MON1=14, CC_SEND_MON2=15, CC_SEND_FX1=16, CC_SEND_FX2=17;
const CC_48V=12;

/* Bus channel MIDI channels */
const FX1_CH=11, FX2_CH=12;
const MON1_CH=9, MON2_CH=10;

/* Master bus constants */
const MAIN_BUS_CHANNEL=8, MAIN_BUS_LEVEL_CC=7, MAIN_BUS_LIMITER_CC=8, MAIN_BUS_BALANCE_CC=10;
const FX1_CHANNEL=14, FX2_CHANNEL=15, FX_PARAM1_CC=1, FX_PARAM2_CC=2, SNAPSHOT_CHANNEL=16;
const TAP_TEMPO_CHANNEL=16, TAP_TEMPO_NOTE=60;

const NUM_CHANNELS=7;
const SCENE_KEY='flow8_scene_static_v14';

const FX1_PRESETS=['Ambience','Perc. Reverb 1','Perc. Reverb 2','Guitar Reverb 1','Guitar Reverb 2','Chamber','Room','Concert','Church','Cathedral','Temple','Stadium','Flanger','Soft Chorus','Warm Chorus','Deep Chorus'];
const FX2_PRESETS=['Delay 1/1','Delay 1/2','Delay 1/3','Delay 2/1','Echo 1/1','Echo 1/2','Echo 1/3','Echo 2/1','Wide Echo','Ping Pong','Ping Pong 1/3','Echo R>L','Flanger','Soft Chorus','Warm Chorus','Deep Chorus'];

const DIAL_LABEL_COLOR_MAP={
  fx1:'--accent', fx2:'--accent-alt', mon1:'--accent-green', mon2:'--accent-warm',
  lim:'--accent-red', param1:'--accent',
  gain:'--accent', lowcut:'--accent-alt', comp:'--accent-green',
  'eq-low':'--accent', 'eq-lowmid':'--accent-alt', 'eq-himid':'--accent-green', 'eq-hi':'--accent-warm',
  'fx1-limiter':'--accent-alt', 'fx2-limiter':'--accent-alt',
  'mon1-limiter':'--accent-green', 'mon2-limiter':'--accent-green'
};
const DEFAULT_DIAL_COLOR_VAR='--accent';
const DIAL_RING_THICKNESS_RATIO=0.25;

/* ===== STATE ===== */
let midiAccess,midiOut;
let exclusiveSolo=false, logTaper=false;
const channelState={};
const masterState={ level:110, limiter:0, balance:64 };
let fxState={ fx1:{preset:1,param1:0,param2:0}, fx2:{preset:1,param1:0,param2:0} };
let currentEQChannel=null;

/* Bus pair state (with stereo link) */
const busPairs={
  fx:{ fx1Limiter:0, fx1Level:110, fx2Limiter:0, fx2Level:110 },
  mon:{ mon1Limiter:0, mon1Level:110, mon2Limiter:0, mon2Level:110, stereoLink:false }
};

/* ===== UTIL ===== */
const qs=s=>document.querySelector(s);
const qsa=s=>[...document.querySelectorAll(s)];
function setStatus(m){ const el=qs('#status'); if(el) el.textContent=m; }
function saveJSON(k,v){ localStorage.setItem(k,JSON.stringify(v)); }
function loadJSON(k){ try{return JSON.parse(localStorage.getItem(k));}catch{return null;} }
function clamp(v,a,b){ return v<a?a:v>b?b:v; }
function mapFaderOut(raw){ if(!logTaper) return raw; const n=raw/127; return clamp(Math.round(n**2.2*127),0,127); }
function faderDB(raw){ if(raw===0) return '-70 dB'; const dB=-70+raw*(80/127); return (dB>=0?'+':'')+Math.round(dB)+' dB'; }
function sendDisplay(raw){ if(raw===0)return'OFF'; const dB=-70+raw*(80/127); return (dB>=0?'+':'')+Math.round(dB)+'dB'; }
function percentDisplay(raw,max=127){ return Math.round(raw/max*100)+'%'; }
function panDisplay(raw){ if(raw===64)return'C'; if(raw<64)return'L'+(64-raw); return 'R'+(raw-64); }
function balanceDisplay(v){ return panDisplay(v); }
function gainDisplay(v){ const dB=-20 + v*(80/127); return (dB>=0?'+':'')+Math.round(dB)+'dB'; }
function lowCutDisplay(v){ const hz = 20 + v*(580/127); return Math.round(hz)+'Hz'; }
function compDisplay(v){ return Math.round(v/100*100)+'%'; }
function eqDisplay(v){ const dB=-15 + v*(30/127); return (dB>=0?'+':'')+Math.round(dB)+'dB'; }
function defaultLabelFor(ch){ if(ch===5)return'CH 5/6'; if(ch===6)return'CH 7/8'; if(ch===7)return'USB / BT'; return 'CH '+ch; }

/* ===== INIT CHANNELS ===== */
function initChannels(){
  for(let ch=1; ch<=NUM_CHANNELS; ch++){
    channelState[ch]={
      level:100,mute:false,solo:false,phantom:false,
      fx1:0,fx2:0,mon1:0,mon2:0,pan:64,
      gain:32,lowcut:0,comp:0,
      eq:{ low:64, lowmid:64, himid:64, hi:64 },
      label:defaultLabelFor(ch)
    };
  }
}

/* ===== KNOBS ===== */
function initKnobs(){
  document.documentElement.style.setProperty('--dial-thickness-ratio', DIAL_RING_THICKNESS_RATIO);
  attachKnobHandlers(qsa('.knob'));
}
function attachKnobHandlers(nodes){
  nodes.forEach(knob=>{
    if(knob.__bound) return;
    knob.__bound=true;
    const role=knob.dataset.role;
    const send=knob.dataset.send;
    const ch=knob.dataset.channel?parseInt(knob.dataset.channel,10):null;
    const max=parseInt(knob.dataset.max||'127',10);
    const initial=parseInt(knob.dataset.value||'0',10);
    applyDialColor(knob,role,send);
    setKnobValue(knob,initial,role,max);
    const startDrag=(sy,sv)=>{
      function move(ev){
        const dy=sy-ev.clientY;
        let v=clamp(sv+Math.round(dy/2),0,max);
        setKnobValue(knob,v,role,max);
        knobChanged(v,role,send,ch,max);
      }
      function up(){
        window.removeEventListener('pointermove',move);
        window.removeEventListener('pointerup',up);
        knob.classList.remove('active');
        saveSceneDebounced();
      }
      window.addEventListener('pointermove',move);
      window.addEventListener('pointerup',up);
    };
    knob.addEventListener('pointerdown',e=>{
      e.preventDefault();
      knob.classList.add('active');
      startDrag(e.clientY, parseInt(knob.dataset.value,10));
    });
    knob.addEventListener('wheel',e=>{
      e.preventDefault();
      let v=parseInt(knob.dataset.value,10);
      v+=(e.deltaY<0?1:-1)*(e.shiftKey?10:2);
      v=clamp(v,0,max);
      setKnobValue(knob,v,role,max);
      knobChanged(v,role,send,ch,max);
      saveSceneDebounced();
    },{passive:false});
  });
}
function semanticLabel(role,send){
  if(send) return send;
  if(role==='master-limiter'||
     role==='fx1-limiter'||role==='fx2-limiter'||
     role==='mon1-limiter'||role==='mon2-limiter') return 'lim';
  if(['gain','lowcut','comp','eq-low','eq-lowmid','eq-himid','eq-hi'].includes(role)) return role;
  if(/param1/.test(role)) return 'param1';
  return null;
}
function applyDialColor(knob,role,send){
  const sem=semanticLabel(role,send);
  const v=(sem && DIAL_LABEL_COLOR_MAP[sem])?DIAL_LABEL_COLOR_MAP[sem]:DEFAULT_DIAL_COLOR_VAR;
  knob.style.setProperty('--dial-color',`var(${v})`);
}
function setKnobValue(knob,raw,role,max=127){
  knob.dataset.value=raw;
  knob.style.setProperty('--pct',(raw/max*100));
  const kv=knob.querySelector('.kv');
  if(!kv) return;
  switch(role){
    case 'gain': kv.textContent=gainDisplay(raw); break;
    case 'lowcut': kv.textContent=lowCutDisplay(raw); break;
    case 'comp': kv.textContent=compDisplay(raw); break;
    case 'fx1-param1':
    case 'fx2-param1': kv.textContent=percentDisplay(raw); break;
    case 'eq-low':
    case 'eq-lowmid':
    case 'eq-himid':
    case 'eq-hi': kv.textContent=eqDisplay(raw); break;
    default: kv.textContent=sendDisplay(raw);
  }
}
function knobChanged(value,role,send,channel,max){
  if(send && channel){
    if(send==='mon2' && busPairs.mon.stereoLink) return;
    channelState[channel][send]=value;
    const cc = send==='fx1'?CC_SEND_FX1: send==='fx2'?CC_SEND_FX2: send==='mon1'?CC_SEND_MON1: send==='mon2'?CC_SEND_MON2: null;
    if(cc) sendCC(cc,value,channel);
    return;
  }
  switch(role){
    case 'master-limiter':
      masterState.limiter=value; sendCC(MAIN_BUS_LIMITER_CC,value,MAIN_BUS_CHANNEL); break;
    case 'fx1-param1':
      fxState.fx1.param1=value; sendCC(FX_PARAM1_CC,value,FX1_CHANNEL); break;
    case 'fx2-param1':
      fxState.fx2.param1=value; sendCC(FX_PARAM1_CC,value,FX2_CHANNEL); break;
    case 'gain':
      if(channel && channel<=6){ channelState[channel].gain=value; sendCC(CC_GAIN,value,channel);} break;
    case 'lowcut':
      if(channel && channel<=6){ channelState[channel].lowcut=value; sendCC(CC_LOWCUT,value,channel);} break;
    case 'comp':
      if(channel && channel<=6){ channelState[channel].comp=value; sendCC(CC_COMP,value,channel);} break;
    case 'eq-low':
      if(currentEQChannel){ channelState[currentEQChannel].eq.low=value; sendCC(CC_EQ_LOW,value,currentEQChannel);} break;
    case 'eq-lowmid':
      if(currentEQChannel){ channelState[currentEQChannel].eq.lowmid=value; sendCC(CC_EQ_LOWMID,value,currentEQChannel);} break;
    case 'eq-himid':
      if(currentEQChannel){ channelState[currentEQChannel].eq.himid=value; sendCC(CC_EQ_HIMID,value,currentEQChannel);} break;
    case 'eq-hi':
      if(currentEQChannel){ channelState[currentEQChannel].eq.hi=value; sendCC(CC_EQ_HI,value,currentEQChannel);} break;
    case 'fx1-limiter':
      busPairs.fx.fx1Limiter=value; sendCC(MAIN_BUS_LIMITER_CC,value,FX1_CH); break;
    case 'fx2-limiter':
      busPairs.fx.fx2Limiter=value; sendCC(MAIN_BUS_LIMITER_CC,value,FX2_CH); break;
    case 'mon1-limiter':
      busPairs.mon.mon1Limiter=value; sendCC(MAIN_BUS_LIMITER_CC,value,MON1_CH); break;
    case 'mon2-limiter':
      if(!busPairs.mon.stereoLink){ busPairs.mon.mon2Limiter=value; sendCC(MAIN_BUS_LIMITER_CC,value,MON2_CH); }
      break;
  }
}
function updateSendKnob(channel,send,value){
  if(send==='mon2' && busPairs.mon.stereoLink) return;
  const knob=qs(`.knob.send-knob[data-channel="${channel}"][data-send="${send}"]`);
  if(knob) setKnobValue(knob,value,null,127);
}
function updateInputKnob(channel,role,value){
  const knob=qs(`.knob[data-role="${role}"][data-channel="${channel}"]`);
  if(!knob) return;
  const max=parseInt(knob.dataset.max||'127',10);
  setKnobValue(knob,value,role,max);
}

/* ===== DISPLAY UPDATERS ===== */
function updateLevelReadout(ch){ const el=qs(`#lvl-ch${ch}`); if(el) el.textContent='Lvl: '+faderDB(channelState[ch].level); }
function updatePanReadout(ch){ const el=qs(`#panval-ch${ch}`); if(el) el.textContent='Pan: '+panDisplay(channelState[ch].pan); }
function updateMasterLevelReadout(){ const el=qs('#lvl-master'); if(el) el.textContent='Lvl: '+faderDB(masterState.level); }
function updateBusReadout(id,val){
  const el=qs(`#${id}`); if(el){
    const dB=-70+val*(80/127);
    el.textContent=(dB>=0?'+':'')+Math.round(dB)+' dB';
  }
}

/* ===== EQ DIALOG ===== */
function openEQ(channel){
  currentEQChannel=channel;
  const dlg=qs('#eqDialog'); if(!dlg) return;
  qs('#eqDialogTitle').textContent='EQ – '+(channelState[channel].label||defaultLabelFor(channel));
  ['low','lowmid','himid','hi'].forEach(band=>{
    const knob=qs(`#eq-${band}`);
    knob.dataset.channel=channel;
    const val=channelState[channel].eq[band];
    knob.dataset.value=val;
    setKnobValue(knob,val,'eq-'+band,127);
  });
  if(typeof dlg.showModal==='function') dlg.showModal(); else dlg.classList.remove('hidden');
}
function closeEQ(){
  const dlg=qs('#eqDialog'); if(!dlg)return;
  currentEQChannel=null;
  if(typeof dlg.close==='function') dlg.close(); else dlg.classList.add('hidden');
}
function resetEQ(channel){
  if(!channel) return;
  const flat=64;
  Object.assign(channelState[channel].eq,{low:flat,lowmid:flat,himid:flat,hi:flat});
  ['low','lowmid','himid','hi'].forEach(b=>{
    const knob=qs(`#eq-${b}`);
    if(knob){ knob.dataset.value=flat; setKnobValue(knob,flat,'eq-'+b,127); }
    sendCC(
      b==='low'?CC_EQ_LOW:
      b==='lowmid'?CC_EQ_LOWMID:
      b==='himid'?CC_EQ_HIMID:CC_EQ_HI,
      flat, channel
    );
  });
  saveSceneDebounced();
}

/* ===== STEREO LINK UI ===== */
function applyStereoLinkUI(){
  const linked=busPairs.mon.stereoLink;
  qs('#stereoLinkBtn')?.classList.toggle('active',linked);
  qs('#knob-mon2-limiter')?.closest('.knob-wrap')?.classList.toggle('hidden',linked);
  qs('.mon2-fader-col')?.classList.toggle('hidden',linked);
  qsa('.knob.send-knob[data-send="mon2"]').forEach(kn=>{
    kn.closest('.knob-wrap')?.classList.toggle('hidden',linked);
  });
}

/* ===== PHANTOM (48V) HOLD HANDLERS ===== */
function bindPhantomButtons(){
  qsa('.btn-small.phantom').forEach(btn=>{
    if(btn.__boundPhantom) return;
    btn.__boundPhantom=true;
    let holdTimer=null;
    let holdActivated=false;
    const HOLD_MS=2000;
    const channel=+btn.dataset.channel;

    function activate(){
      channelState[channel].phantom=true;
      sendCC(CC_48V,BOOL_ON,channel);
      btn.classList.add('active');
      holdActivated=true;
      holdTimer=null;
      saveSceneDebounced();
      setStatus(`48V ON (CH ${channel})`);
    }
    function deactivate(){
      channelState[channel].phantom=false;
      sendCC(CC_48V,BOOL_OFF,channel);
      btn.classList.remove('active');
      saveSceneDebounced();
      setStatus(`48V OFF (CH ${channel})`);
    }
    function clearHold(){
      if(holdTimer){
        clearTimeout(holdTimer);
        holdTimer=null;
      }
      btn.classList.remove('hold-arming');
    }

    btn.addEventListener('pointerdown',e=>{
      if(channelState[channel].phantom){
        // Active: will toggle off on pointerup (normal click)
        return;
      }
      holdActivated=false;
      btn.classList.add('hold-arming');
      holdTimer=setTimeout(()=>{
        activate();
        btn.classList.remove('hold-arming');
      },HOLD_MS);
    });

    btn.addEventListener('pointerup',e=>{
      if(channelState[channel].phantom){
        if(holdActivated){
          // Just activated via hold; do not immediately deactivate
          holdActivated=false;
        } else {
          // Normal click to deactivate
          deactivate();
        }
      } else {
        // Not active and released before hold finished -> cancel
        clearHold();
      }
    });
    ['pointerleave','pointercancel'].forEach(ev=>{
      btn.addEventListener(ev,()=>{
        if(!channelState[channel].phantom) clearHold();
      });
    });
  });
}

/* ===== UI BINDINGS ===== */
function bindUI(){
  qsa('.channel-label').forEach(el=>{
    el.addEventListener('input',()=>{
      const label=el.textContent.trim();
      const ch=+el.closest('.channel-strip').dataset.channel;
      channelState[ch].label=label;
      updateChannelTooltips(ch,label);
      saveSceneDebounced();
    });
  });

  qsa('.fader').forEach(f=>{
    f.addEventListener('input',()=>{
      const ch=+f.dataset.channel;
      const val=+f.value;
      channelState[ch].level=val;
      sendCC(CC_FADER,mapFaderOut(val),ch);
      updateLevelReadout(ch);
      saveSceneDebounced();
    });
  });

  qsa('.bus-fader').forEach(f=>{
    f.addEventListener('input',()=>{
      const midiCh=+f.dataset.midiChannel;
      if(midiCh===MON2_CH && busPairs.mon.stereoLink) return;
      const val=+f.value;
      sendCC(CC_FADER,mapFaderOut(val),midiCh);
      const id=f.id.replace('fader-','lvl-');
      updateBusReadout(id,val);
      if(midiCh===FX1_CH) busPairs.fx.fx1Level=val;
      else if(midiCh===FX2_CH) busPairs.fx.fx2Level=val;
      else if(midiCh===MON1_CH) busPairs.mon.mon1Level=val;
      else if(midiCh===MON2_CH) busPairs.mon.mon2Level=val;
      saveSceneDebounced();
    });
  });

  qsa('.pan').forEach(p=>{
    p.addEventListener('input',()=>{
      const ch=+p.dataset.channel;
      const val=+p.value;
      channelState[ch].pan=val;
      updatePanReadout(ch);
      sendCC(CC_PAN,val,ch);
      saveSceneDebounced();
    });
  });

  qsa('.btn-small.mute').forEach(b=>b.addEventListener('click',()=>{
    const ch=+b.dataset.channel;
    channelState[ch].mute=!channelState[ch].mute;
    sendCC(CC_MUTE,channelState[ch].mute?BOOL_ON:BOOL_OFF,ch);
    updateChannelButtons(ch);
    saveSceneDebounced();
  }));
  qsa('.btn-small.solo').forEach(b=>b.addEventListener('click',()=>{
    const ch=+b.dataset.channel;
    const activate=!channelState[ch].solo;
    if(activate && exclusiveSolo){
      for(const k in channelState){
        if(+k!==ch && channelState[k].solo){
          channelState[k].solo=false;
            sendCC(CC_SOLO,BOOL_OFF,+k);
          updateChannelButtons(+k);
        }
      }
    }
    channelState[ch].solo=activate;
    sendCC(CC_SOLO,channelState[ch].solo?BOOL_ON:BOOL_OFF,ch);
    updateChannelButtons(ch);
    saveSceneDebounced();
  }));

  qsa('.reset-btn').forEach(btn=>btn.addEventListener('click',()=>{
    const ch=+btn.dataset.channel;
    Object.assign(channelState[ch],{
      level:100,mute:false,solo:false,phantom:(ch<=2?channelState[ch].phantom:false),
      fx1:0,fx2:0,mon1:0,mon2:0,pan:64,
      gain:32,lowcut:0,comp:0,
      eq:{low:64,lowmid:64,himid:64,hi:64}
    });
    const fader=qs(`#fader-ch${ch}`); if(fader) fader.value=100;
    const pan=qs(`#pan-ch${ch}`); if(pan) pan.value=64;
    updateLevelReadout(ch);
    updatePanReadout(ch);
    ['fx1','fx2','mon1','mon2'].forEach(s=>updateSendKnob(ch,s,0));
    updateInputKnob(ch,'gain',32);
    updateInputKnob(ch,'lowcut',0);
    updateInputKnob(ch,'comp',0);
    if(currentEQChannel===ch){
      ['low','lowmid','himid','hi'].forEach(b=>setKnobValue(qs(`#eq-${b}`),64,'eq-'+b,127));
    }
    sendCC(CC_FADER,mapFaderOut(100),ch);
    sendCC(CC_MUTE,BOOL_OFF,ch);
    sendCC(CC_SOLO,BOOL_OFF,ch);
    sendCC(CC_SEND_FX1,0,ch); sendCC(CC_SEND_FX2,0,ch);
    sendCC(CC_SEND_MON1,0,ch); if(!busPairs.mon.stereoLink) sendCC(CC_SEND_MON2,0,ch);
    sendCC(CC_PAN,64,ch);
    if(ch<=6){
      sendCC(CC_GAIN,32,ch);
      sendCC(CC_LOWCUT,0,ch);
      sendCC(CC_COMP,0,ch);
      sendCC(CC_EQ_LOW,64,ch);
      sendCC(CC_EQ_LOWMID,64,ch);
      sendCC(CC_EQ_HIMID,64,ch);
      sendCC(CC_EQ_HI,64,ch);
    }
    if(ch<=2){
      // Phantom state unchanged (only toggled via hold)
      sendCC(CC_48V,channelState[ch].phantom?BOOL_ON:BOOL_OFF,ch);
    }
    updateChannelButtons(ch);
    saveSceneDebounced();
  }));

  // Master
  qs('#fader-master')?.addEventListener('input',e=>{
    masterState.level=+e.target.value;
    sendCC(MAIN_BUS_LEVEL_CC,mapFaderOut(masterState.level),MAIN_BUS_CHANNEL);
    updateMasterLevelReadout();
    saveSceneDebounced();
  });
  qs('#balance-master')?.addEventListener('input',e=>{
    masterState.balance=+e.target.value;
    qs('#bal-master').textContent='Bal: '+balanceDisplay(masterState.balance);
    sendCC(MAIN_BUS_BALANCE_CC,masterState.balance,MAIN_BUS_CHANNEL);
    saveSceneDebounced();
  });

  // FX presets
  qs('#fx1Preset')?.addEventListener('change',e=>{
    fxState.fx1.preset=+e.target.value;
    sendProgramChange(fxState.fx1.preset,FX1_CHANNEL);
    setStatus(`FX1 → ${FX1_PRESETS[fxState.fx1.preset-1]}`);
    saveSceneDebounced();
  });
  qs('#fx2Preset')?.addEventListener('change',e=>{
    fxState.fx2.preset=+e.target.value;
    sendProgramChange(fxState.fx2.preset,FX2_CHANNEL);
    setStatus(`FX2 → ${FX2_PRESETS[fxState.fx2.preset-1]}`);
    saveSceneDebounced();
  });
  qsa('input[name="fx1-param2"]').forEach(r=>r.addEventListener('change',()=>{
    if(r.checked){ fxState.fx1.param2=+r.value; sendCC(FX_PARAM2_CC,fxState.fx1.param2,FX1_CHANNEL); saveSceneDebounced(); }
  }));
  qsa('input[name="fx2-param2"]').forEach(r=>r.addEventListener('change',()=>{
    if(r.checked){ fxState.fx2.param2=+r.value; sendCC(FX_PARAM2_CC,fxState.fx2.param2,FX2_CHANNEL); saveSceneDebounced(); }
  }));

  // EQ
  qsa('.eq-btn').forEach(b=>b.addEventListener('click',()=>{
    const ch=+b.dataset.eqChannel;
    openEQ(ch);
  }));
  qs('#eqCloseBtn')?.addEventListener('click',closeEQ);
  qs('#eqCloseBtn2')?.addEventListener('click',closeEQ);
  qs('#eqResetBtn')?.addEventListener('click',()=>{ if(currentEQChannel) resetEQ(currentEQChannel); });

  // Stereo Link
  qs('#stereoLinkBtn')?.addEventListener('click',()=>{
    busPairs.mon.stereoLink=!busPairs.mon.stereoLink;
    applyStereoLinkUI();
    saveSceneDebounced();
  });

  // Snapshots
  qsa('#snapshotButtons button').forEach(btn=>btn.addEventListener('click',()=>{
    const sn=+btn.dataset.snapshot;
    sendProgramChange(sn,SNAPSHOT_CHANNEL);
    highlightSnapshot(sn);
  }));

  // Options
  qs('#exclusiveSolo')?.addEventListener('change',e=>{exclusiveSolo=e.target.checked; saveSceneDebounced();});
  qs('#logTaper')?.addEventListener('change',e=>{logTaper=e.target.checked; saveSceneDebounced();});

  // Scene buttons
  qs('#saveSceneBtn')?.addEventListener('click',()=>{saveScene(); setStatus('Scene saved');});
  qs('#loadSceneBtn')?.addEventListener('click',loadScene);
  qs('#clearSceneBtn')?.addEventListener('click',()=>{
    localStorage.removeItem(SCENE_KEY);
    setStatus('Scene cleared');
  });

  // Tabs
  qsa('.tab-bar button').forEach(b=>b.addEventListener('click',()=>{
    qsa('.tab-bar button').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    const tgt=b.dataset.tab;
    qsa('.tab-content').forEach(tc=>tc.classList.toggle('active',tc.id==='tab-'+tgt));
  }));

  // MIDI
  qs('#refreshBtn')?.addEventListener('click',refreshMIDIDevices);
  qs('#panicBtn')?.addEventListener('click',panic);
  qs('#midiOut')?.addEventListener('change',e=>selectMIDIOut(e.target.value));

  // Phantom (48V) special handlers
  bindPhantomButtons();

  // Bind EQ dialog knobs
  attachKnobHandlers(qsa('#eqDialog .knob'));
}

/* ===== TOOLTIP & BUTTON STATE ===== */
function updateChannelTooltips(ch,label){
  qs(`#mute-ch${ch}`)?.setAttribute('title',`Mute channel ${label}`);
  qs(`#solo-ch${ch}`)?.setAttribute('title',`Solo channel ${label}`);
  if(ch<=2){
    qs(`#phantom-ch${ch}`)?.setAttribute('title',`48V channel ${label} (Click and hold to activate)`);
  }
}
function updateChannelButtons(ch){
  qs(`#mute-ch${ch}`)?.classList.toggle('active',channelState[ch].mute);
  qs(`#solo-ch${ch}`)?.classList.toggle('active',channelState[ch].solo);
  if(ch<=2){
    qs(`#phantom-ch${ch}`)?.classList.toggle('active',channelState[ch].phantom);
  }
}

/* ===== SNAPSHOTS ===== */
function highlightSnapshot(n){
  qsa('#snapshotButtons button').forEach(b=>b.classList.toggle('active',+b.dataset.snapshot===n));
}

/* ===== MIDI (Output only) ===== */
async function initMIDI(){
  try{
    midiAccess=await navigator.requestMIDIAccess({sysex:false});
    midiAccess.onstatechange=refreshMIDIDevices;
    refreshMIDIDevices();
    setStatus('MIDI ready (Out only)');
  }catch(e){ setStatus('MIDI failed: '+e.message); }
}
function refreshMIDIDevices(){
  const outSel=qs('#midiOut');
  if(!outSel) return;
  outSel.innerHTML='';
  midiAccess.outputs.forEach(o=>{
    const opt=document.createElement('option'); opt.value=o.id; opt.textContent=o.name; outSel.appendChild(opt);
  });
  if(!midiOut && outSel.options.length){
    let idx=[...outSel.options].findIndex(o=>o.textContent.includes('FLOW 8'));
    if(idx<0) idx=0;
    outSel.selectedIndex=idx;
    selectMIDIOut(outSel.value);
  }
}
function selectMIDIOut(id){
  midiOut=midiAccess.outputs.get(id)||null;
  setStatus(midiOut?'Out: '+midiOut.name:'No Out');
}
function sendCC(cc,val,ch){ if(!midiOut) return; midiOut.send([0xB0|((ch-1)&0x0F), cc&0x7F, val&0x7F]); }
function sendProgramChange(pc,ch){ if(!midiOut) return; midiOut.send([0xC0|((ch-1)&0x0F),(pc-1)&0x7F]); }

/* ===== KNOB RAW UPDATE ===== */
function setKnobRaw(knob,raw,role){
  if(!knob) return;
  const max=parseInt(knob.dataset.max||'127',10);
  knob.dataset.value=raw;
  setKnobValue(knob,raw,role,max);
}

/* ===== SCENE ===== */
let sceneTO;
function saveSceneDebounced(){ clearTimeout(sceneTO); sceneTO=setTimeout(saveScene,300); }
function saveScene(){
  const scene={
    exclusiveSolo, logTaper,
    master:{...masterState},
    busPairs: JSON.parse(JSON.stringify(busPairs)),
    channels:Object.entries(channelState).map(([ch,st])=>({
      channel:+ch,
      ...st,
      name: st.label || defaultLabelFor(+ch)
    })),
    fx: JSON.parse(JSON.stringify(fxState))
  };
  saveJSON(SCENE_KEY,scene);
}
function loadScene(){
  const sc=loadJSON(SCENE_KEY);
  if(!sc){ setStatus('No saved scene'); return; }
  exclusiveSolo=!!sc.exclusiveSolo;
  logTaper=!!sc.logTaper;
  const ex=qs('#exclusiveSolo'); if(ex) ex.checked=exclusiveSolo;
  const lt=qs('#logTaper'); if(lt) lt.checked=logTaper;

  sc.channels?.forEach(c=>{
    if(!channelState[c.channel]) return;
    Object.assign(channelState[c.channel],{
      level:c.level,mute:c.mute,solo:c.solo,phantom:c.phantom,
      fx1:c.fx1,fx2:c.fx2,mon1:c.mon1,mon2:c.mon2,pan:c.pan ?? 64,
      gain:c.gain ?? 32, lowcut:c.lowcut ?? 0, comp:c.comp ?? 0,
      eq:c.eq ?? {low:64,lowmid:64,himid:64,hi:64},
      label:c.name || defaultLabelFor(c.channel)
    });
    const ch=c.channel;
    const fader=qs(`#fader-ch${ch}`); if(fader) fader.value=c.level;
    const pan=qs(`#pan-ch${ch}`); if(pan) pan.value=channelState[ch].pan;
    updateLevelReadout(ch);
    updatePanReadout(ch);
    ['fx1','fx2','mon1','mon2'].forEach(s=>updateSendKnob(ch,s,channelState[ch][s]));
    updateInputKnob(ch,'gain',channelState[ch].gain);
    updateInputKnob(ch,'lowcut',channelState[ch].lowcut);
    updateInputKnob(ch,'comp',channelState[ch].comp);
    const labelEl=qs(`#label-ch${ch}`); if(labelEl) labelEl.textContent=channelState[ch].label;
    updateChannelButtons(ch);
    updateChannelTooltips(ch,channelState[ch].label);
    sendCC(CC_FADER,mapFaderOut(c.level),ch);
    sendCC(CC_MUTE,c.mute?BOOL_ON:BOOL_OFF,ch);
    sendCC(CC_SOLO,c.solo?BOOL_ON:BOOL_OFF,ch);
    sendCC(CC_SEND_FX1,c.fx1,ch);
    sendCC(CC_SEND_FX2,c.fx2,ch);
    sendCC(CC_SEND_MON1,c.mon1,ch);
    if(!busPairs.mon.stereoLink) sendCC(CC_SEND_MON2,c.mon2,ch);
    sendCC(CC_PAN,channelState[ch].pan,ch);
    if(ch<=6){
      sendCC(CC_GAIN,channelState[ch].gain,ch);
      sendCC(CC_LOWCUT,channelState[ch].lowcut,ch);
      sendCC(CC_COMP,channelState[ch].comp,ch);
      sendCC(CC_EQ_LOW,channelState[ch].eq.low,ch);
      sendCC(CC_EQ_LOWMID,channelState[ch].eq.lowmid,ch);
      sendCC(CC_EQ_HIMID,channelState[ch].eq.himid,ch);
      sendCC(CC_EQ_HI,channelState[ch].eq.hi,ch);
    }
    if(ch<=2){
      // Send present phantom state
      sendCC(CC_48V,channelState[ch].phantom?BOOL_ON:BOOL_OFF,ch);
    }
  });

  if(sc.master){
    Object.assign(masterState,sc.master);
    const mf=qs('#fader-master'); if(mf) mf.value=masterState.level;
    const mb=qs('#balance-master'); if(mb) mb.value=masterState.balance;
    updateMasterLevelReadout();
    qs('#bal-master').textContent='Bal: '+balanceDisplay(masterState.balance);
    setKnobRaw(qs('#knob-master-limiter'),masterState.limiter,'master-limiter');
    sendCC(MAIN_BUS_LEVEL_CC,mapFaderOut(masterState.level),MAIN_BUS_CHANNEL);
    sendCC(MAIN_BUS_LIMITER_CC,masterState.limiter,MAIN_BUS_CHANNEL);
    sendCC(MAIN_BUS_BALANCE_CC,masterState.balance,MAIN_BUS_CHANNEL);
  }

  if(sc.busPairs){
    Object.assign(busPairs.fx,{
      fx1Limiter: sc.busPairs.fx.fx1Limiter ?? 0,
      fx1Level: sc.busPairs.fx.fx1Level ?? 110,
      fx2Limiter: sc.busPairs.fx.fx2Limiter ?? 0,
      fx2Level: sc.busPairs.fx.fx2Level ?? 110
    });
    Object.assign(busPairs.mon,{
      mon1Limiter: sc.busPairs.mon.mon1Limiter ?? 0,
      mon1Level: sc.busPairs.mon.mon1Level ?? 110,
      mon2Limiter: sc.busPairs.mon.mon2Limiter ?? 0,
      mon2Level: sc.busPairs.mon.mon2Level ?? 110,
      stereoLink: sc.busPairs.mon.stereoLink ?? false
    });
    setKnobRaw(qs('#knob-fx1-limiter'),busPairs.fx.fx1Limiter,'fx1-limiter');
    setKnobRaw(qs('#knob-fx2-limiter'),busPairs.fx.fx2Limiter,'fx2-limiter');
    setKnobRaw(qs('#knob-mon1-limiter'),busPairs.mon.mon1Limiter,'mon1-limiter');
    if(!busPairs.mon.stereoLink) setKnobRaw(qs('#knob-mon2-limiter'),busPairs.mon.mon2Limiter,'mon2-limiter');
    const fx1=qs('#fader-fx1'); if(fx1){ fx1.value=busPairs.fx.fx1Level; updateBusReadout('lvl-fx1',busPairs.fx.fx1Level); sendCC(CC_FADER,mapFaderOut(busPairs.fx.fx1Level),FX1_CH); }
    const fx2=qs('#fader-fx2'); if(fx2){ fx2.value=busPairs.fx.fx2Level; updateBusReadout('lvl-fx2',busPairs.fx.fx2Level); sendCC(CC_FADER,mapFaderOut(busPairs.fx.fx2Level),FX2_CH); }
    const mon1=qs('#fader-mon1'); if(mon1){ mon1.value=busPairs.mon.mon1Level; updateBusReadout('lvl-mon1',busPairs.mon.mon1Level); sendCC(CC_FADER,mapFaderOut(busPairs.mon.mon1Level),MON1_CH); }
    const mon2=qs('#fader-mon2'); if(mon2){ mon2.value=busPairs.mon.mon2Level; updateBusReadout('lvl-mon2',busPairs.mon.mon2Level); if(!busPairs.mon.stereoLink) sendCC(CC_FADER,mapFaderOut(busPairs.mon.mon2Level),MON2_CH); }
    applyStereoLinkUI();
    sendCC(MAIN_BUS_LIMITER_CC,busPairs.fx.fx1Limiter,FX1_CH);
    sendCC(MAIN_BUS_LIMITER_CC,busPairs.fx.fx2Limiter,FX2_CH);
    sendCC(MAIN_BUS_LIMITER_CC,busPairs.mon.mon1Limiter,MON1_CH);
    if(!busPairs.mon.stereoLink) sendCC(MAIN_BUS_LIMITER_CC,busPairs.mon.mon2Limiter,MON2_CH);
  }else{
    applyStereoLinkUI();
  }

  if(sc.fx){
    fxState=sc.fx;
    const p1=qs('#fx1Preset'); if(p1) p1.value=fxState.fx1.preset;
    const p2=qs('#fx2Preset'); if(p2) p2.value=fxState.fx2.preset;
    setKnobRaw(qs('#knob-fx1-param1'),fxState.fx1.param1,'fx1-param1');
    setKnobRaw(qs('#knob-fx2-param1'),fxState.fx2.param1,'fx2-param1');
    qsa('input[name="fx1-param2"]').forEach(r=>r.checked=(+r.value===fxState.fx1.param2));
    qsa('input[name="fx2-param2"]').forEach(r=>r.checked=(+r.value===fxState.fx2.param2));
  }

  setStatus('Scene loaded');
}

/* ===== PANIC ===== */
function panic(){
  if(!midiOut) return;
  for(let ch=0; ch<16; ch++){
    midiOut.send([0xB0|ch,121,0]);
    midiOut.send([0xB0|ch,123,0]);
    midiOut.send([0xB0|ch,CC_MUTE,BOOL_OFF]);
    midiOut.send([0xB0|ch,CC_SOLO,BOOL_OFF]);
  }
  setStatus('Panic sent');
}

/* ===== INIT ===== */
function init(){
  initChannels();
  bindUI();
  initKnobs();
  initMIDI();
  loadScene();
  for(let ch=1; ch<=NUM_CHANNELS; ch++){
    updateLevelReadout(ch);
    updatePanReadout(ch);
    updateChannelTooltips(ch,channelState[ch].label);
  }
  updateMasterLevelReadout();
  updateBusReadout('lvl-fx1',busPairs.fx.fx1Level);
  updateBusReadout('lvl-fx2',busPairs.fx.fx2Level);
  updateBusReadout('lvl-mon1',busPairs.mon.mon1Level);
  updateBusReadout('lvl-mon2',busPairs.mon.mon2Level);
  applyStereoLinkUI();
  // Ensure phantom buttons reflect state
  qsa('.btn-small.phantom').forEach(b=>{
    const ch=+b.dataset.channel;
    b.classList.toggle('active',channelState[ch].phantom);
  });
}
window.addEventListener('DOMContentLoaded', init);