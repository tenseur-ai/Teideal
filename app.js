const STORE_KEY = "teideal-board-v1";
const STATUS = {todo:"To Do", inprogress:"In Progress", done:"Done"};
const TEST_LABEL = {notrun:"Not run", Passed:"Passed", Failed:"Failed"};
const REL_LABEL = {"mvp":"MVP","phase-2":"Phase 2","phase-3":"Phase 3"};

const epicByKey = {};
DATA.epics.sort((a,b)=>parseInt(a.code.slice(1))-parseInt(b.code.slice(1)));
DATA.epics.forEach((e,i)=>{ e.color = `hsl(${Math.round(i*360/DATA.epics.length+190)%360} 55% 50%)`; epicByKey[e.key]=e; });
const stories = DATA.stories.sort((a,b)=>a.order-b.order);
const storyByKey = Object.fromEntries(stories.map(s=>[s.key,s]));

/* ---------- state ---------- */
function freshState(){
  const st = {v:1, stories:{}};
  stories.forEach(s=>{ st.stories[s.key] = {status:"todo", ac:s.ac.map(()=>false), tests:Object.fromEntries(s.tests.map(t=>[t.id,"notrun"])), history:[]}; });
  return st;
}
function loadState(){
  const base = freshState();
  if(typeof EMBEDDED_STATE !== "undefined" && EMBEDDED_STATE){
    mergeInto(base, EMBEDDED_STATE);
    return base;
  }
  try{
    const raw = localStorage.getItem(STORE_KEY);
    if(raw){ mergeInto(base, JSON.parse(raw)); }
  }catch(e){ /* storage unavailable: run in memory */ }
  return base;
}
function mergeInto(base, saved){
  if(!saved || !saved.stories) return;
  for(const k in base.stories){
    const s = saved.stories[k]; if(!s) continue;
    const b = base.stories[k];
    if(STATUS[s.status]) b.status = s.status;
    if(Array.isArray(s.ac)) b.ac = b.ac.map((_,i)=>!!s.ac[i]);
    if(s.tests) for(const t in b.tests) if(TEST_LABEL[s.tests[t]]) b.tests[t]=s.tests[t];
    if(Array.isArray(s.history)) b.history = s.history.slice(-50);
  }
}
let state = loadState();
function save(){ try{ localStorage.setItem(STORE_KEY, JSON.stringify(state)); }catch(e){} }

/* ---------- Artifact runtime: shared live state ---------- */
const CSS_TEXT = "\n:root{\n  --bg:#EEF1F4;--col:#E2E7EC;--card:#FFFFFF;--ink:#16212B;--muted:#586878;--line:#CCD5DE;\n  --accent:#0E6B6B;--accent-ink:#FFFFFF;--pass:#2F7D4E;--fail:#B53B3B;--pending:#C3CCD5;--focus:#0E6B6B;\n  --radius-card:6px;--radius-col:10px;\n  font-family:system-ui,-apple-system,\"Segoe UI\",Roboto,\"Helvetica Neue\",Arial,sans-serif;\n  color:var(--ink);background:var(--bg);\n  color-scheme:light;\n}\n@media (prefers-color-scheme:dark){:root:not([data-theme=\"light\"]){\n  --bg:#141A20;--col:#1B232B;--card:#232D37;--ink:#E4EAF0;--muted:#98A7B4;--line:#33404C;\n  --accent:#3AAFA9;--accent-ink:#0C1A1A;--pass:#4DB07B;--fail:#E26463;--pending:#45525E;--focus:#3AAFA9;\n  color-scheme:dark;\n}}\n:root[data-theme=\"dark\"]{\n  --bg:#141A20;--col:#1B232B;--card:#232D37;--ink:#E4EAF0;--muted:#98A7B4;--line:#33404C;\n  --accent:#3AAFA9;--accent-ink:#0C1A1A;--pass:#4DB07B;--fail:#E26463;--pending:#45525E;--focus:#3AAFA9;\n  color-scheme:dark;\n}\n*{box-sizing:border-box}\nbody{margin:0;min-height:100vh;background:var(--bg);font-size:14px;line-height:1.45;font-variant-numeric:tabular-nums}\nbutton,input,select{font:inherit;color:inherit}\n:focus-visible{outline:2px solid var(--focus);outline-offset:2px}\nheader.top{display:flex;align-items:center;gap:24px;padding:14px 24px;border-bottom:1px solid var(--line);flex-wrap:wrap}\n.brand{display:flex;align-items:baseline;gap:10px}\n.brand h1{margin:0;font-size:19px;font-weight:700;letter-spacing:-.01em}\n.brand span{color:var(--muted);font-size:13px}\nnav.tabs{display:flex;gap:4px}\nnav.tabs button{background:none;border:0;padding:8px 12px;border-radius:6px;cursor:pointer;color:var(--muted);font-weight:550}\nnav.tabs button[aria-selected=\"true\"]{color:var(--ink);background:var(--col)}\n.top-actions{margin-left:auto;display:flex;gap:8px;align-items:center}\n.btn{border:1px solid var(--line);background:var(--card);padding:6px 11px;border-radius:6px;cursor:pointer;font-size:13px}\n.btn:hover{border-color:var(--muted)}\n.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}\n.toolbar{display:flex;gap:10px;align-items:center;padding:14px 24px 0;flex-wrap:wrap}\n.toolbar input[type=search]{min-width:240px}\n.toolbar select{max-width:340px}\n.toolbar input,.toolbar select{border:1px solid var(--line);background:var(--card);border-radius:6px;padding:6px 9px}\n.toolbar .summary{margin-left:auto;color:var(--muted);font-size:13px}\nmain{padding:14px 24px 32px}\n.view[hidden]{display:none}\n\n/* Board */\n.board{display:grid;grid-template-columns:repeat(3,minmax(260px,1fr));gap:14px;align-items:start}\n.column{min-width:0;background:var(--col);border-radius:var(--radius-col);display:flex;flex-direction:column;max-height:calc(100vh - 150px);min-height:200px}\n.column header{display:flex;align-items:baseline;gap:8px;padding:12px 14px 8px}\n.column h2{margin:0;font-size:14px;font-weight:650}\n.column .count{color:var(--muted);font-size:13px}\n.column .pts{margin-left:auto;color:var(--muted);font-size:12px}\n.lane{padding:4px 10px 12px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;flex:1;border-radius:0 0 var(--radius-col) var(--radius-col);transition:background .12s}\n.lane.drop{background:color-mix(in srgb,var(--accent) 12%,transparent)}\n.lane .empty{color:var(--muted);font-size:13px;padding:18px 6px;text-align:center}\n\n.card{background:var(--card);border-radius:var(--radius-card);padding:10px 11px 9px;border:1px solid transparent;cursor:grab;position:relative;border-left:4px solid var(--epic)}\n.card:hover{border-color:var(--line);border-left-color:var(--epic)}\n.card.dragging{opacity:.45}\n.card .row1{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)}\n.card .order{font-weight:700;color:var(--ink);min-width:28px}\n.card .prio{margin-left:auto;font-size:11px;padding:1px 6px;border-radius:4px;border:1px solid var(--line)}\n.prio.Highest{color:var(--fail);border-color:color-mix(in srgb,var(--fail) 45%,transparent)}\n.prio.High{color:#B7791F;border-color:color-mix(in srgb,#B7791F 45%,transparent)}\n.card h3{font-size:14px;font-weight:560;margin:5px 0 7px;line-height:1.35}\n.card .epic{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.meters{display:grid;gap:5px;margin:9px 0 7px}\n.meter{display:grid;grid-template-columns:62px 1fr 34px;align-items:center;gap:8px;font-size:12px;color:var(--muted)}\n.meter .val{text-align:right;color:var(--ink);font-weight:600}\n.meter.complete .val{color:var(--pass)}\n.ticks{display:flex;gap:2px;height:7px}\n.ticks i{flex:1;border-radius:2px;background:var(--pending)}\n.ticks i.ok{background:var(--pass)}\n.ticks i.bad{background:var(--fail)}\n.card .foot{display:flex;gap:8px;font-size:12px;color:var(--muted)}\n.card .foot .rel{margin-left:auto}\n\n/* Tables */\n.table-wrap{overflow-x:auto;background:var(--card);border-radius:var(--radius-col);border:1px solid var(--line)}\ntable{border-collapse:collapse;width:100%;font-size:13px}\nth,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}\nth{position:sticky;top:0;background:var(--card);font-weight:650;color:var(--muted);font-size:12px;white-space:nowrap}\ntbody tr:hover td{background:color-mix(in srgb,var(--col) 60%,transparent)}\ntd.num{text-align:right;white-space:nowrap}\ntd.key{white-space:nowrap;color:var(--muted)}\ntr.group td{background:var(--col);font-weight:650;color:var(--ink)}\n.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;white-space:nowrap;border:1px solid var(--line)}\n.pill.todo{color:var(--muted)}\n.pill.inprogress{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 50%,transparent)}\n.pill.done,.pill.Passed{color:var(--pass);border-color:color-mix(in srgb,var(--pass) 50%,transparent)}\n.pill.Failed{color:var(--fail);border-color:color-mix(in srgb,var(--fail) 50%,transparent)}\n.pill.notrun{color:var(--muted)}\n.linkish{background:none;border:0;padding:0;cursor:pointer;text-align:left;color:inherit;text-decoration:underline;text-decoration-color:var(--line);text-underline-offset:3px}\n.linkish:hover{text-decoration-color:var(--ink)}\n.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--epic);margin-right:6px;vertical-align:1px}\n\n/* Dialog */\ndialog{border:0;border-radius:12px;padding:0;width:min(760px,94vw);max-height:90vh;background:var(--card);color:var(--ink)}\ndialog::backdrop{background:rgba(10,16,22,.45)}\n.dlg{display:flex;flex-direction:column;max-height:90vh}\n.dlg-head{padding:18px 22px 12px;border-bottom:1px solid var(--line)}\n.dlg-head .meta{display:flex;gap:10px;align-items:center;color:var(--muted);font-size:13px;flex-wrap:wrap}\n.dlg-head h2{margin:6px 0 10px;font-size:19px;line-height:1.3}\n.dlg-head select{border:1px solid var(--line);background:var(--card);border-radius:6px;padding:5px 8px}\n.dlg-body{padding:6px 22px 20px;overflow-y:auto}\n.dlg-body h3{font-size:14px;margin:18px 0 8px;display:flex;align-items:baseline;gap:10px}\n.dlg-body h3 .sub{color:var(--muted);font-weight:500;font-size:13px}\n.dlg-body h3 .btn{margin-left:auto;padding:3px 8px;font-size:12px}\n.desc p{margin:0 0 8px;max-width:72ch}\n.desc h4{margin:12px 0 4px;font-size:13px}\n.checklist{list-style:none;margin:0;padding:0;display:grid;gap:6px}\n.checklist label{display:grid;grid-template-columns:20px 22px 1fr;gap:6px;align-items:start;cursor:pointer}\n.checklist input{margin-top:3px;accent-color:var(--pass)}\n.checklist .n{color:var(--muted);font-size:12px;padding-top:2px}\n.checklist .done-text{color:var(--muted);text-decoration:line-through}\n.tests{list-style:none;margin:0;padding:0;display:grid;gap:8px}\n.tests li{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;padding:8px 10px;border:1px solid var(--line);border-radius:8px}\n.tests .t-meta{font-size:12px;color:var(--muted)}\n.seg{display:inline-flex;border:1px solid var(--line);border-radius:6px;overflow:hidden}\n.seg button{border:0;background:none;padding:4px 9px;font-size:12px;cursor:pointer;color:var(--muted)}\n.seg button+button{border-left:1px solid var(--line)}\n.seg button[aria-pressed=\"true\"].notrun{background:var(--col);color:var(--ink)}\n.seg button[aria-pressed=\"true\"].Passed{background:var(--pass);color:#fff}\n.seg button[aria-pressed=\"true\"].Failed{background:var(--fail);color:#fff}\n.history{font-size:12px;color:var(--muted);list-style:none;padding:0;margin:0;display:grid;gap:3px}\n.note{font-size:12px;color:var(--muted)}\n.dlg-foot{padding:12px 22px;border-top:1px solid var(--line);display:flex;justify-content:flex-end}\n\n.toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(20px);background:var(--ink);color:var(--bg);padding:10px 16px;border-radius:8px;font-size:13px;opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;max-width:90vw;z-index:10}\n.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}\n.stats{display:flex;gap:22px;flex-wrap:wrap;margin:0 0 12px;font-size:13px;color:var(--muted)}\n.stats b{color:var(--ink);font-size:15px;margin-right:4px}\n\n@media (max-width:900px){\n  .board{grid-template-columns:minmax(0,1fr)}\n  .toolbar input[type=search]{min-width:0;flex:1}\n  .column{max-height:none}\n  header.top,.toolbar,main{padding-left:12px;padding-right:12px}\n}\n@media (prefers-reduced-motion:reduce){*{transition:none!important}}\n";
const SHELL_HTML = "\n<header class=\"top\">\n  <div class=\"brand\"><h1>Teideal</h1><span>TEID delivery board</span></div>\n  <nav class=\"tabs\" role=\"tablist\">\n    <button role=\"tab\" aria-selected=\"true\" data-view=\"board\">Board</button>\n    <button role=\"tab\" aria-selected=\"false\" data-view=\"order\">Implementation order</button>\n    <button role=\"tab\" aria-selected=\"false\" data-view=\"trace\">Traceability</button>\n  </nav>\n  <div class=\"top-actions\">\n    <button class=\"btn\" id=\"exportState\" title=\"Download your progress as a JSON file\">Export progress</button>\n    <button class=\"btn\" id=\"importState\" title=\"Load progress from a JSON file\">Import progress</button>\n    <input type=\"file\" id=\"importFile\" accept=\"application/json\" hidden>\n    <button class=\"btn\" id=\"resetState\" title=\"Move every story back to To Do and clear all progress\">Reset</button>\n  </div>\n</header>\n\n<div class=\"toolbar\" id=\"filters\">\n  <input type=\"search\" id=\"q\" placeholder=\"Search stories, keys or tests\" aria-label=\"Search\">\n  <select id=\"fEpic\" aria-label=\"Epic\"><option value=\"\">All epics</option></select>\n  <select id=\"fRelease\" aria-label=\"Release\">\n    <option value=\"\">All releases</option><option value=\"mvp\">MVP</option><option value=\"phase-2\">Phase 2</option><option value=\"phase-3\">Phase 3</option>\n  </select>\n  <select id=\"fTest\" aria-label=\"Test result\" hidden>\n    <option value=\"\">All test results</option><option value=\"notrun\">Not run</option><option value=\"Passed\">Passed</option><option value=\"Failed\">Failed</option>\n  </select>\n  <button class=\"btn\" id=\"exportCsv\" hidden>Export CSV</button>\n  <span class=\"summary\" id=\"summary\"></span>\n</div>\n\n<main>\n  <section class=\"view\" id=\"view-board\">\n    <div class=\"board\">\n      <div class=\"column\" data-status=\"todo\"><header><h2>To Do</h2><span class=\"count\"></span><span class=\"pts\"></span></header><div class=\"lane\" data-status=\"todo\"></div></div>\n      <div class=\"column\" data-status=\"inprogress\"><header><h2>In Progress</h2><span class=\"count\"></span><span class=\"pts\"></span></header><div class=\"lane\" data-status=\"inprogress\"></div></div>\n      <div class=\"column\" data-status=\"done\"><header><h2>Done</h2><span class=\"count\"></span><span class=\"pts\"></span></header><div class=\"lane\" data-status=\"done\"></div></div>\n    </div>\n  </section>\n  <section class=\"view\" id=\"view-order\" hidden>\n    <div class=\"stats\" id=\"orderStats\"></div>\n    <div class=\"table-wrap\"><table><thead><tr>\n      <th>#</th><th>Key</th><th>Story</th><th>Epic</th><th>Points</th><th>Status</th><th>Criteria</th><th>Tests</th>\n    </tr></thead><tbody id=\"orderBody\"></tbody></table></div>\n  </section>\n  <section class=\"view\" id=\"view-trace\" hidden>\n    <div class=\"stats\" id=\"traceStats\"></div>\n    <div class=\"table-wrap\"><table><thead><tr>\n      <th>Epic</th><th>Story</th><th>#</th><th>Release</th><th>Story status</th><th>Test</th><th>Covers</th><th>Type</th><th>Result</th>\n    </tr></thead><tbody id=\"traceBody\"></tbody></table></div>\n  </section>\n</main>\n\n<dialog id=\"dlg\"><div class=\"dlg\" id=\"dlgInner\"></div></dialog>\n<div class=\"toast\" id=\"toast\" role=\"status\" aria-live=\"polite\"></div>\n\n";
const SKELETON_HEAD = "<!doctype html><html><head><meta charset=utf8><meta name=viewport content=\"width=device-width,initial-scale=1,viewport-fit=cover\"><style>:root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}html{scroll-padding-top:env(safe-area-inset-top,0px)}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f5;color:#141413}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style></head>";
function bodyTemplate(dataObj, stateObj){
  const stateJson = stateObj ? JSON.stringify(stateObj) : "null";
  return "<title>Teideal board<\/title>\n<style>" + CSS_TEXT + "<\/style>\n" + SHELL_HTML +
    "\n<script>window.DATA=" + JSON.stringify(dataObj) + ";window.EMBEDDED_STATE=" + stateJson + ";<\/script>" +
    "\n<script src=\"app.js\"><\/script>";
}
function buildDocument(stateObj){
  return SKELETON_HEAD + "<body>" + bodyTemplate(DATA, stateObj) + "<\/body><\/html>";
}
let artifactApi = null, downloadsApi = null, readOnly = false;
(async () => {
  try{
    if(window.claude && window.claude.use){
      artifactApi = await window.claude.use("artifact");
      downloadsApi = await window.claude.use("downloads");
    }
  }catch(e){ /* no runtime available: standalone file, localStorage only */ }
})();
let publishing = false, publishQueued = false, warnedReadOnly = false;
async function persistArtifact(){
  if(!artifactApi || readOnly) return;
  if(publishing){ publishQueued = true; return; }
  publishing = true;
  try{
    await artifactApi.publish(buildDocument(state));
  }catch(e){
    if(e && (e.code === "not_writer" || e.code === "not_granted" || e.code === "consent_required")){
      readOnly = true;
      if(!warnedReadOnly){ warnedReadOnly = true; toast("You have view-only access to this board; your changes are kept in this browser only."); }
    }
    /* "conflict" is routine: the shell is already reloading every open view to the winner. */
  }finally{
    publishing = false;
    if(publishQueued){ publishQueued = false; persistArtifact(); }
  }
}

/* ---------- progress & workflow rules ---------- */
function progress(key){
  const st = state.stories[key], s = storyByKey[key];
  const acDone = st.ac.filter(Boolean).length;
  const tv = s.tests.map(t=>st.tests[t.id]);
  const passed = tv.filter(v=>v==="Passed").length, failed = tv.filter(v=>v==="Failed").length;
  const touched = acDone>0 || tv.some(v=>v!=="notrun");
  return {acDone, acTotal:s.ac.length, passed, failed, testTotal:s.tests.length,
          complete: acDone===s.ac.length && passed===s.tests.length, touched};
}
function logMove(key, from, to, why){
  state.stories[key].history.push({t:new Date().toISOString(), from, to, why});
}
function setStatus(key, to, why){
  const st = state.stories[key]; if(st.status===to) return;
  logMove(key, st.status, to, why); st.status = to;
}
/* Called after criteria or tests change: moves the card to reflect the work. */
function autoMove(key){
  const st = state.stories[key], p = progress(key);
  if(p.complete && st.status!=="done"){ setStatus(key,"done","All criteria met and all tests passed"); toast(`${key} moved to Done: all criteria met and all tests passed.`); }
  else if(!p.complete && st.status==="done"){ setStatus(key,"inprogress","Work reopened"); toast(`${key} moved back to In Progress: it no longer meets the definition of done.`); }
  else if(p.touched && st.status==="todo"){ setStatus(key,"inprogress","Work started"); toast(`${key} moved to In Progress.`); }
}
/* Manual moves (drag and drop or status menu). Done requires the definition of done. */
function manualMove(key, to){
  const st = state.stories[key]; if(st.status===to) return true;
  if(to==="done"){
    const p = progress(key);
    if(!p.complete){
      toast(`${key} can't move to Done yet: ${p.acDone}/${p.acTotal} criteria complete, ${p.passed}/${p.testTotal} tests passed.`);
      return false;
    }
  }
  setStatus(key, to, "Moved manually"); return true;
}

/* ---------- helpers ---------- */
const $ = s=>document.querySelector(s);
const esc = s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let toastTimer;
function toast(msg){ const t=$("#toast"); t.textContent=msg; t.classList.add("show"); clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove("show"),3200); }
function ticks(n, fn){ let h=""; for(let i=0;i<n;i++) h+=`<i class="${fn(i)}"></i>`; return `<span class="ticks" aria-hidden="true">${h}</span>`; }
function meters(key){
  const s=storyByKey[key], st=state.stories[key], p=progress(key);
  const acC = p.acDone===p.acTotal, tC = p.passed===p.testTotal;
  return `<div class="meters">
    <div class="meter ${acC?"complete":""}" title="Acceptance criteria complete"><span>Criteria</span>${ticks(p.acTotal,i=>st.ac[i]?"ok":"")}<span class="val">${p.acDone}/${p.acTotal}</span></div>
    <div class="meter ${tC?"complete":""}" title="Tests passed${p.failed?`, ${p.failed} failing`:""}"><span>Tests</span>${ticks(p.testTotal,i=>{const v=st.tests[s.tests[i].id];return v==="Passed"?"ok":v==="Failed"?"bad":""})}<span class="val">${p.passed}/${p.testTotal}</span></div>
  </div>`;
}

/* ---------- filters ---------- */
const fEpic=$("#fEpic");
DATA.epics.forEach(e=>fEpic.insertAdjacentHTML("beforeend",`<option value="${e.key}">${esc(e.code)} ${esc(e.name)}</option>`));
function storyMatches(s){
  const q=$("#q").value.trim().toLowerCase(), ep=fEpic.value, rel=$("#fRelease").value;
  if(ep && s.epic!==ep) return false;
  if(rel && s.release!==rel) return false;
  if(q){
    const e=epicByKey[s.epic];
    const hay=(s.key+" "+s.summary+" "+e.code+" "+e.name+" "+s.tests.map(t=>t.id+" "+t.title).join(" ")).toLowerCase();
    if(!hay.includes(q)) return false;
  }
  return true;
}

/* ---------- board ---------- */
function renderBoard(){
  const cols={todo:[],inprogress:[],done:[]};
  stories.filter(storyMatches).forEach(s=>cols[state.stories[s.key].status].push(s));
  for(const status in cols){
    const col=document.querySelector(`.column[data-status="${status}"]`), lane=col.querySelector(".lane"), list=cols[status];
    col.querySelector(".count").textContent=list.length;
    col.querySelector(".pts").textContent=list.reduce((a,s)=>a+s.points,0)+" pts";
    lane.innerHTML = list.length ? list.map(cardHtml).join("") :
      `<div class="empty">${status==="todo"?"Nothing left to start.":status==="inprogress"?"Drag a story here, or tick a criterion to start it.":"Stories land here when every criterion is met and every test passes."}</div>`;
  }
  const all=stories.filter(storyMatches), done=all.filter(s=>state.stories[s.key].status==="done");
  $("#summary").textContent=`${done.length} of ${all.length} stories done, ${done.reduce((a,s)=>a+s.points,0)} of ${all.reduce((a,s)=>a+s.points,0)} points`;
}
function cardHtml(s){
  const e=epicByKey[s.epic];
  return `<article class="card" draggable="true" tabindex="0" data-key="${s.key}" style="--epic:${e.color}" aria-label="${esc(s.key+" "+s.summary)}">
    <div class="row1"><span class="order" title="Implementation order">#${s.order}</span><span>${s.key}</span><span class="prio ${s.priority}">${s.priority}</span></div>
    <h3>${esc(s.summary)}</h3>
    <div class="epic" title="${esc(e.code+" "+e.name)}">${esc(e.code)} ${esc(e.name)}</div>
    ${meters(s.key)}
    <div class="foot"><span>${s.points} pts</span><span class="rel">${REL_LABEL[s.release]}</span></div>
  </article>`;
}
let dragKey=null;
document.addEventListener("dragstart",ev=>{ const c=ev.target.closest(".card"); if(!c) return; dragKey=c.dataset.key; c.classList.add("dragging"); ev.dataTransfer.setData("text/plain",dragKey); ev.dataTransfer.effectAllowed="move"; });
document.addEventListener("dragend",ev=>{ const c=ev.target.closest(".card"); if(c) c.classList.remove("dragging"); document.querySelectorAll(".lane.drop").forEach(l=>l.classList.remove("drop")); });
document.querySelectorAll(".lane").forEach(lane=>{
  lane.addEventListener("dragover",ev=>{ ev.preventDefault(); lane.classList.add("drop"); });
  lane.addEventListener("dragleave",ev=>{ if(!lane.contains(ev.relatedTarget)) lane.classList.remove("drop"); });
  lane.addEventListener("drop",ev=>{
    ev.preventDefault(); lane.classList.remove("drop");
    const key=ev.dataTransfer.getData("text/plain")||dragKey; if(!key) return;
    if(manualMove(key,lane.dataset.status)){ save(); renderAll(); toast(`${key} moved to ${STATUS[lane.dataset.status]}.`); persistArtifact(); }
  });
});
document.addEventListener("click",ev=>{
  const c=ev.target.closest(".card"); if(c){ openStory(c.dataset.key); return; }
  const l=ev.target.closest("[data-open]"); if(l) openStory(l.dataset.open);
});
document.addEventListener("keydown",ev=>{ const c=ev.target.closest&&ev.target.closest(".card"); if(c && (ev.key==="Enter"||ev.key===" ")){ ev.preventDefault(); openStory(c.dataset.key); } });

/* ---------- story dialog ---------- */
const dlg=$("#dlg");
let openKey=null;
function descHtml(text){
  return text.split(/\n{2,}/).map(block=>{
    const m=block.match(/^\*(.+?)\*\n?([\s\S]*)$/);
    if(m) return `<h4>${esc(m[1])}</h4>${m[2]?`<p>${esc(m[2]).replace(/\n/g,"<br>")}</p>`:""}`;
    return `<p>${esc(block).replace(/\n/g,"<br>")}</p>`;
  }).join("");
}
function openStory(key){ openKey=key; renderDialog(); if(!dlg.open) dlg.showModal(); }
function renderDialog(){
  const s=storyByKey[openKey], st=state.stories[openKey], e=epicByKey[s.epic], p=progress(openKey);
  $("#dlgInner").innerHTML = `
  <div class="dlg-head">
    <div class="meta"><span><span class="dot" style="--epic:${e.color}"></span>${esc(e.code)} ${esc(e.name)}</span><span>${s.key}</span><span>#${s.order} in build order</span><span>${s.priority}</span><span>${s.points} pts</span><span>${REL_LABEL[s.release]}</span></div>
    <h2>${esc(s.summary)}</h2>
    <label>Status <select id="dStatus">${Object.entries(STATUS).map(([k,v])=>`<option value="${k}" ${st.status===k?"selected":""}>${v}</option>`).join("")}</select></label>
    ${meters(openKey)}
  </div>
  <div class="dlg-body">
    <div class="desc">${descHtml(s.desc)}</div>
    <h3>Acceptance criteria <span class="sub">${p.acDone} of ${p.acTotal} complete</span><button class="btn" id="acAll">${p.acDone===p.acTotal?"Clear all":"Mark all complete"}</button></h3>
    <ul class="checklist">${s.ac.map((a,i)=>`<li><label><input type="checkbox" data-ac="${i}" ${st.ac[i]?"checked":""}><span class="n">${i+1}</span><span class="${st.ac[i]?"done-text":""}">${esc(a)}</span></label></li>`).join("")}</ul>
    <h3>Tests <span class="sub">${p.passed} of ${p.testTotal} passed${p.failed?`, ${p.failed} failing`:""}</span><button class="btn" id="tAll">${p.passed===p.testTotal?"Reset all":"Mark all passed"}</button></h3>
    <ul class="tests">${s.tests.map(t=>`<li><div><div>${esc(t.title)}</div><div class="t-meta">${t.id}, ${t.type}, covers criterion ${t.ac}</div></div>
      <div class="seg" role="group" aria-label="Result for ${t.id}">${["notrun","Passed","Failed"].map(v=>`<button class="${v}" data-test="${t.id}" data-val="${v}" aria-pressed="${st.tests[t.id]===v}">${TEST_LABEL[v]}</button>`).join("")}</div></li>`).join("")}</ul>
    <h3>History</h3>
    ${st.history.length?`<ul class="history">${st.history.slice().reverse().map(h=>`<li>${new Date(h.t).toLocaleString()}: ${STATUS[h.from]} to ${STATUS[h.to]} (${esc(h.why)})</li>`).join("")}</ul>`:`<p class="note">No moves yet. Tick a criterion or record a test result to start this story.</p>`}
    ${s.provisional?`<p class="note">This story comes from the missing-stories import file. Its key assumes that file is imported next into TEID; check it after import.</p>`:""}
  </div>
  <div class="dlg-foot"><button class="btn primary" id="dClose">Close</button></div>`;
}
dlg.addEventListener("click",ev=>{
  if(ev.target===dlg){ dlg.close(); return; }
  const key=openKey, st=state.stories[key], s=storyByKey[key];
  if(ev.target.id==="dClose"){ dlg.close(); return; }
  if(ev.target.id==="acAll"){ const all=st.ac.every(Boolean); st.ac=st.ac.map(()=>!all); afterChange(key); return; }
  if(ev.target.id==="tAll"){ const all=s.tests.every(t=>st.tests[t.id]==="Passed"); s.tests.forEach(t=>st.tests[t.id]=all?"notrun":"Passed"); afterChange(key); return; }
  const tb=ev.target.closest("[data-test]"); if(tb){ st.tests[tb.dataset.test]=tb.dataset.val; afterChange(key); }
});
dlg.addEventListener("change",ev=>{
  const key=openKey, st=state.stories[key];
  if(ev.target.matches("[data-ac]")){ st.ac[+ev.target.dataset.ac]=ev.target.checked; afterChange(key); }
  if(ev.target.id==="dStatus"){ if(manualMove(key,ev.target.value)){ save(); renderAll(); renderDialog(); persistArtifact(); } else ev.target.value=st.status; }
});
dlg.addEventListener("close",()=>{ openKey=null; });
function afterChange(key){ autoMove(key); save(); renderAll(); renderDialog(); persistArtifact(); }

/* ---------- implementation order ---------- */
function renderOrder(){
  const list=stories.filter(storyMatches);
  let html="", cur=null;
  list.forEach(s=>{
    if(s.release!==cur){
      cur=s.release;
      const g=list.filter(x=>x.release===cur), d=g.filter(x=>state.stories[x.key].status==="done");
      html+=`<tr class="group"><td colspan="8">${REL_LABEL[cur]}: ${d.length} of ${g.length} stories done, ${d.reduce((a,x)=>a+x.points,0)} of ${g.reduce((a,x)=>a+x.points,0)} points</td></tr>`;
    }
    const e=epicByKey[s.epic], st=state.stories[s.key], p=progress(s.key);
    html+=`<tr><td class="num">${s.order}</td><td class="key">${s.key}</td><td><button class="linkish" data-open="${s.key}">${esc(s.summary)}</button></td>
      <td><span class="dot" style="--epic:${e.color}"></span>${esc(e.code)} ${esc(e.name)}</td><td class="num">${s.points}</td>
      <td><span class="pill ${st.status}">${STATUS[st.status]}</span></td><td class="num">${p.acDone}/${p.acTotal}</td><td class="num">${p.passed}/${p.testTotal}</td></tr>`;
  });
  $("#orderBody").innerHTML=html||`<tr><td colspan="8">No stories match these filters. Clear the search or choose another epic or release.</td></tr>`;
  const allPts=stories.reduce((a,s)=>a+s.points,0), donePts=stories.filter(s=>state.stories[s.key].status==="done").reduce((a,s)=>a+s.points,0);
  const next=stories.find(s=>state.stories[s.key].status==="todo");
  $("#orderStats").innerHTML=`<span><b>${Math.round(100*donePts/allPts)}%</b>of all points done</span><span><b>${stories.filter(s=>state.stories[s.key].status==="inprogress").length}</b>in progress</span>`+
    (next?`<span>Next to start: <button class="linkish" data-open="${next.key}">#${next.order} ${esc(next.summary)}</button></span>`:"");
  $("#summary").textContent=`${list.length} stories`;
}

/* ---------- traceability ---------- */
function traceRows(){
  const q=$("#q").value.trim().toLowerCase(), ep=fEpic.value, rel=$("#fRelease").value, tr=$("#fTest").value;
  const rows=[];
  DATA.epics.forEach(e=>{
    if(ep && e.key!==ep) return;
    stories.filter(s=>s.epic===e.key).forEach(s=>{
      if(rel && s.release!==rel) return;
      const st=state.stories[s.key];
      s.tests.forEach(t=>{
        const r={e,s,t,st,res:st.tests[t.id]};
        if(tr && r.res!==tr) return;
        if(q && !(e.code+" "+e.name+" "+s.key+" "+s.summary+" "+t.id+" "+t.title).toLowerCase().includes(q)) return;
        rows.push(r);
      });
    });
  });
  return rows;
}
function renderTrace(){
  const rows=traceRows();
  $("#traceBody").innerHTML = rows.length ? rows.map(({e,s,t,st,res})=>`<tr>
    <td><span class="dot" style="--epic:${e.color}"></span>${e.key} ${esc(e.code)} ${esc(e.name)}</td>
    <td><button class="linkish" data-open="${s.key}">${s.key} ${esc(s.summary)}</button></td>
    <td class="num">${s.order}</td><td>${REL_LABEL[s.release]}</td>
    <td><span class="pill ${st.status}">${STATUS[st.status]}</span></td>
    <td><span class="key">${t.id}</span><br>${esc(t.title)}</td>
    <td>Criterion ${t.ac}${st.ac[t.ac-1]?" (met)":""}</td><td>${t.type}</td>
    <td><span class="pill ${res}">${TEST_LABEL[res]}</span></td></tr>`).join("")
    : `<tr><td colspan="9">No rows match these filters. Clear the search or choose another filter.</td></tr>`;
  const allTests=stories.reduce((a,s)=>a+s.tests.length,0);
  const passed=stories.reduce((a,s)=>a+s.tests.filter(t=>state.stories[s.key].tests[t.id]==="Passed").length,0);
  const failed=stories.reduce((a,s)=>a+s.tests.filter(t=>state.stories[s.key].tests[t.id]==="Failed").length,0);
  $("#traceStats").innerHTML=`<span><b>${DATA.epics.length}</b>epics</span><span><b>${stories.length}</b>stories</span><span><b>${allTests}</b>tests</span><span><b>${passed}</b>passed</span><span><b>${failed}</b>failing</span>`;
  $("#summary").textContent=`${rows.length} rows`;
}
function csvCell(v){ v=String(v??""); return /[",\n]/.test(v)?`"${v.replace(/"/g,'""')}"`:v; }
$("#exportCsv").addEventListener("click",()=>{
  const head=["Epic key","Epic","Story key","Story","Implementation order","Release","Story status","Criteria complete","Tests passed","Test ID","Test","Covers criterion","Criterion met","Test type","Test result"];
  const lines=[head.join(",")].concat(traceRows().map(({e,s,t,st,res})=>{ const p=progress(s.key);
    return [e.key,e.code+" "+e.name,s.key,s.summary,s.order,REL_LABEL[s.release],STATUS[st.status],`${p.acDone}/${p.acTotal}`,`${p.passed}/${p.testTotal}`,t.id,t.title,t.ac,st.ac[t.ac-1]?"Yes":"No",t.type,TEST_LABEL[res]].map(csvCell).join(",");}));
  download("teideal-traceability.csv", lines.join("\n"), "text/csv");
});

/* ---------- tabs, persistence buttons ---------- */
let view="board";
document.querySelectorAll("nav.tabs button").forEach(b=>b.addEventListener("click",()=>{
  view=b.dataset.view;
  document.querySelectorAll("nav.tabs button").forEach(x=>x.setAttribute("aria-selected",x===b));
  document.querySelectorAll(".view").forEach(v=>v.hidden=v.id!=="view-"+view);
  $("#fTest").hidden=view!=="trace"; $("#exportCsv").hidden=view!=="trace";
  renderAll();
}));
["q","fEpic","fRelease","fTest"].forEach(id=>$("#"+id).addEventListener("input",renderAll));
function download(name,text,type){ const a=document.createElement("a"); a.href=URL.createObjectURL(new Blob([text],{type})); a.download=name; document.body.appendChild(a); a.click(); setTimeout(()=>{URL.revokeObjectURL(a.href); a.remove();},500); }
async function saveFile(filename,data,type,fallbackMessage){
  if(downloadsApi){
    try{ const r=await downloadsApi.save({filename,data}); toast(r.status==="saved"?`${filename} saved.`:`${filename} sent.`); return; }
    catch(e){ if(e && e.code==="declined") return; }
  }
  download(filename,data,type);
  if(fallbackMessage) toast(fallbackMessage);
}
$("#exportState").addEventListener("click",()=>{ saveFile(`teideal-progress-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(state,null,1), "application/json", "Progress exported."); });
$("#importState").addEventListener("click",()=>$("#importFile").click());
$("#importFile").addEventListener("change",async ev=>{
  const f=ev.target.files[0]; if(!f) return;
  try{ const saved=JSON.parse(await f.text()); const base=freshState(); mergeInto(base,saved); state=base; save(); renderAll(); toast("Progress imported."); persistArtifact(); }
  catch(e){ toast("That file isn't a Teideal progress export. Choose a JSON file created with Export progress."); }
  ev.target.value="";
});
let resetArm=null;
$("#resetState").addEventListener("click",ev=>{
  if(!resetArm){
    ev.target.textContent="Click again to reset";
    resetArm=setTimeout(()=>{ resetArm=null; ev.target.textContent="Reset"; },4000);
    return;
  }
  clearTimeout(resetArm); resetArm=null; ev.target.textContent="Reset";
  state=freshState(); save(); renderAll(); toast("Board reset."); persistArtifact();
});

function renderAll(){ if(view==="board") renderBoard(); else if(view==="order") renderOrder(); else renderTrace(); }
renderAll();
