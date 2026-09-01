"""Good Faith Finance — research agent demo server.

Zero third-party dependencies: python3 app.py → http://localhost:8777
The OpenRouter API key is entered in the UI and stored in the USER'S HOME
directory (~/.gff_research_config.json) — never inside this folder, so the
project can be zipped and shared with no secrets in it.
"""
from __future__ import annotations

import json
import re
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from pipeline import Pipeline, hunt_tree_value, parse_money, validate_tree

PORT = 8777
CONFIG_PATH = Path.home() / ".gff_research_config.json"
RUNS_DIR = Path(__file__).parent / "runs"
RUNS_DIR.mkdir(exist_ok=True)

RUNS: dict[str, dict] = {}
for f in sorted(RUNS_DIR.glob("*.json")):
    try:
        RUNS[f.stem] = json.loads(f.read_text(encoding="utf-8"))
    except Exception:
        pass


def load_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_config(cfg: dict):
    CONFIG_PATH.write_text(json.dumps(cfg), encoding="utf-8")


def persist(run_id: str):
    (RUNS_DIR / f"{run_id}.json").write_text(json.dumps(RUNS[run_id]), encoding="utf-8")


def start_run(question: str, ticker: str | None) -> str:
    cfg = load_config()
    run_id = uuid.uuid4().hex[:10]
    RUNS[run_id] = {"id": run_id, "question": question, "ticker": ticker, "status": "running",
                    "log": [], "report": "", "findings": [], "created": time.strftime("%Y-%m-%d %H:%M")}

    def log(msg: str):
        RUNS[run_id]["log"].append(msg)

    def work():
        try:
            pipe = Pipeline(cfg.get("api_key", ""), cfg.get("model", "google/gemini-3.7-flash"),
                            log, int(cfg.get("max_rounds", 4)))
            result = pipe.run(question, ticker)
            RUNS[run_id].update(status="done", report=result["report"],
                                findings=result["findings"], tree=result.get("tree"))
        except Exception as e:
            RUNS[run_id]["status"] = "error"
            log(f"❌ Run failed: {e}")
        persist(run_id)

    threading.Thread(target=work, daemon=True).start()
    return run_id


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        if self.path == "/":
            body = PAGE.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/api/config":
            cfg = load_config()
            self._json({"has_key": bool(cfg.get("api_key")), "model": cfg.get("model", "google/gemini-3.7-flash"),
                        "max_rounds": cfg.get("max_rounds", 4)})
        elif self.path == "/api/runs":
            self._json([{"id": r["id"], "question": r["question"], "status": r["status"],
                         "created": r.get("created", ""), "findings": len(r.get("findings", []))}
                        for r in sorted(RUNS.values(), key=lambda x: x.get("created", ""), reverse=True)])
        elif m := re.match(r"^/api/run/(\w+)$", self.path):
            run = RUNS.get(m.group(1))
            self._json(run or {"error": "not found"}, 200 if run else 404)
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path == "/api/config":
            body = self._read()
            cfg = load_config()
            for k in ("api_key", "model", "max_rounds"):
                if body.get(k) not in (None, ""):
                    cfg[k] = body[k]
            save_config(cfg)
            self._json({"ok": True, "has_key": bool(cfg.get("api_key"))})
        elif m := re.match(r"^/api/run/(\w+)/tree/hunt$", self.path):
            # Targeted hunt for one node+period cell: {"path": [...], "period": "FY2020"}
            run = RUNS.get(m.group(1))
            if not run or not run.get("tree"):
                return self._json({"error": "run or tree not found"}, 404)
            cfg = load_config()
            if not cfg.get("api_key"):
                return self._json({"error": "Set your OpenRouter API key first."}, 400)
            body = self._read()
            try:
                result = hunt_tree_value(cfg["api_key"], cfg.get("model", "google/gemini-3.7-flash"),
                                         run, body.get("path") or [], body.get("period") or "latest")
            except Exception as e:
                return self._json({"error": str(e)}, 500)
            persist(run["id"])
            self._json({"ok": True, "found": result["found"], "value": result["value"],
                        "tree": run["tree"], "findings": run["findings"]})
        elif m := re.match(r"^/api/run/(\w+)/tree$", self.path):
            # Manual value entry: {"path": [node names root→target], "period": "FY2024"|"latest", "value": "$3.4B"}
            run = RUNS.get(m.group(1))
            if not run or not run.get("tree"):
                return self._json({"error": "run or tree not found"}, 404)
            body = self._read()
            value = str(body.get("value", "")).strip()
            if parse_money(value) is None:
                return self._json({"error": 'Value must look like money — e.g. "$3.4B", "~$450M".'}, 400)
            node = run["tree"]
            for name in (body.get("path") or [])[1:]:  # path[0] is the root itself
                node = next((c for c in node.get("children") or [] if c.get("name") == name), None)
                if node is None:
                    return self._json({"error": f"node not found: {name}"}, 404)
            period = body.get("period") or "latest"
            if period == "latest":
                node["value"] = value
            else:
                node.setdefault("periods", {})[period] = value
            node.setdefault("manual_labels", [])
            if period not in node["manual_labels"]:
                node["manual_labels"].append(period)
            warnings = validate_tree(run["tree"])
            persist(run["id"])
            self._json({"ok": True, "tree": run["tree"], "warnings": warnings})
        elif self.path == "/api/run":
            body = self._read()
            if not body.get("question", "").strip():
                return self._json({"error": "question required"}, 400)
            if not load_config().get("api_key"):
                return self._json({"error": "Set your OpenRouter API key first (top bar)."}, 400)
            run_id = start_run(body["question"].strip(), (body.get("ticker") or "").strip() or None)
            self._json({"id": run_id})
        else:
            self._json({"error": "not found"}, 404)


PAGE = r"""<!doctype html><html><head><meta charset="utf-8">
<title>Good Faith Finance — Research Agents</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--bg:#0c1210;--panel:#121a17;--panel2:#18231f;--border:#23312b;--text:#e7efe9;--muted:#8ba398;--accent:#34d399}
*{box-sizing:border-box;margin:0}body{background:var(--bg);color:var(--text);font:14px/1.5 system-ui,sans-serif;padding:20px}
.wrap{max-width:1200px;margin:0 auto}h1{font-size:20px}h1 span{color:var(--accent)}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px;margin-top:14px}
input,select{background:var(--panel2);border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--text);font-size:13px}
button{background:var(--accent);border:none;border-radius:8px;padding:8px 14px;color:#06281c;font-weight:600;cursor:pointer;font-size:13px}
button.ghost{background:var(--panel2);color:var(--text);border:1px solid var(--border)}
button:disabled{opacity:.5;cursor:not-allowed}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.grid{display:grid;grid-template-columns:280px 1fr;gap:14px}
.runitem{padding:8px 10px;border-radius:8px;cursor:pointer;font-size:13px}
.runitem:hover,.runitem.active{background:var(--panel2)}
.log{background:#0a0f0d;border:1px solid var(--border);border-radius:8px;padding:10px;font:11.5px/1.6 ui-monospace,monospace;color:var(--muted);max-height:260px;overflow:auto;white-space:pre-wrap}
.report{line-height:1.7}.report h2{color:var(--accent);font-size:17px;margin:18px 0 6px;border-bottom:1px solid var(--border);padding-bottom:3px}
.report table{border-collapse:collapse;margin:8px 0;font-size:12.5px}.report td,.report th{border:1px solid var(--border);padding:3px 8px}
.report a.cite{color:var(--accent);font-weight:700;text-decoration:none;cursor:pointer}
.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:10.5px;font-weight:700;background:var(--panel2);color:var(--muted)}
.finding{border:1px solid var(--border);background:var(--panel2);border-radius:8px;padding:8px 10px;margin-top:6px;font-size:12.5px}
.muted{color:var(--muted)}.small{font-size:12px}
#panel{position:fixed;right:12px;top:12px;bottom:12px;width:330px;background:var(--panel);border:1px solid var(--accent);border-radius:12px;padding:14px;overflow:auto;display:none;z-index:9}
</style></head><body><div class="wrap">
<h1><span>Good Faith</span> Finance — Research Agents</h1>
<p class="muted small">Multi-agent stock research: planner → SEC XBRL grounding + metric hunter → parallel scrapers (YouTube, web, news, EDGAR, Hacker News) → claim extractor → story-editor loop → insight agent → cited report. Every claim traces to a dated source.</p>

<div class="card row" id="cfg">
  <input id="key" type="password" placeholder="OpenRouter API key (stored in your home dir, never in this folder)" style="flex:1;min-width:240px">
  <input id="model" style="width:190px" placeholder="model" value="google/gemini-3.7-flash">
  <select id="rounds"><option>2</option><option selected>4</option><option>6</option><option>8</option></select>
  <button onclick="saveCfg()">Save</button><span id="cfgmsg" class="small muted"></span>
</div>

<div class="card row">
  <input id="q" style="flex:1;min-width:280px" placeholder='Research question — e.g. "Is Adobe a value trap or a bargain?"'>
  <input id="ticker" style="width:110px" placeholder="Ticker (opt)">
  <button id="go" onclick="launch()">🚀 Launch agents</button>
</div>

<div class="grid">
  <div class="card"><b class="small">Runs</b><div id="runs"></div></div>
  <div>
    <div class="card" id="logcard" style="display:none"><b class="small" id="status"></b><div class="log" id="log"></div></div>
    <div class="card" id="treecard" style="display:none"><div class="row"><b class="small" style="flex:1">🌳 Information tree — how the money flows (drag to pan · scroll to zoom · click nodes)</b><span id="periods" class="row"></span></div>
      <div id="treevp" style="position:relative;height:340px;overflow:hidden;background:#0a0f0d;border:1px solid var(--border);border-radius:8px;margin-top:8px;cursor:grab;touch-action:none"></div></div>
    <div class="card" id="reportcard" style="display:none"><div class="report" id="report"></div></div>
    <div class="card" id="findingscard" style="display:none"><b class="small">Findings</b><div id="findings"></div></div>
  </div>
</div>
</div>
<div id="panel"></div>
<script>
let current=null, timer=null, run=null;
const $=id=>document.getElementById(id);
async function j(url,opts){const r=await fetch(url,opts);return r.json()}
async function saveCfg(){const b={api_key:$('key').value,model:$('model').value,max_rounds:+$('rounds').value};
  const r=await j('/api/config',{method:'POST',body:JSON.stringify(b)});$('key').value='';
  $('cfgmsg').textContent=r.has_key?'✓ key saved (home dir)':'no key set';loadCfg();}
async function loadCfg(){const c=await j('/api/config');$('model').value=c.model;$('rounds').value=c.max_rounds;
  $('key').placeholder=c.has_key?'API key saved ✓ — paste to replace':'OpenRouter API key (stored in your home dir, never in this folder)';}
async function launch(){const q=$('q').value.trim();if(!q)return;
  const r=await j('/api/run',{method:'POST',body:JSON.stringify({question:q,ticker:$('ticker').value})});
  if(r.error)return alert(r.error);openRun(r.id);loadRuns();}
async function loadRuns(){const rs=await j('/api/runs');$('runs').innerHTML=rs.map(r=>
  `<div class="runitem ${r.id===current?'active':''}" onclick="openRun('${r.id}')">${r.question.slice(0,42)}<br>
   <span class="muted" style="font-size:11px">${r.status==='running'?'● running':r.status} · ${r.findings} findings</span></div>`).join('')||'<p class="muted small">none yet</p>';}
async function openRun(id){current=id;clearInterval(timer);await refresh();timer=setInterval(async()=>{
  if(run&&run.status!=='running'){clearInterval(timer);return}await refresh();loadRuns();},2500);loadRuns();}
async function refresh(){run=await j('/api/run/'+current);
  $('logcard').style.display='block';$('status').textContent=run.status.toUpperCase()+' — '+run.question;
  $('log').textContent=run.log.join('\n');if(run.status==='running')$('log').scrollTop=$('log').scrollHeight;
  if(run.report){$('reportcard').style.display='block';$('report').innerHTML=md(run.report);}
  else $('reportcard').style.display='none';
  if(run.tree){$('treecard').style.display='block';renderTree(run.tree);}
  else $('treecard').style.display='none';
  if(run.findings&&run.findings.length){$('findingscard').style.display='block';
    $('findings').innerHTML=run.findings.map(f=>fhtml(f)).join('');}
}
function fhtml(f){return `<div class="finding" id="f${f.n}"><a class="cite">[${f.n}]</a> <span class="badge">${f.source}</span>
  ${f.date?`<span class="muted" style="font-size:11px">📅 ${f.date}</span>`:''} <span class="muted">rel ${f.relevance}/10</span><br>
  ${esc(f.claim)}${f.numbers?`<br><span style="color:var(--accent);font-family:monospace">${esc(f.numbers)}</span>`:''}
  ${f.quote?`<br><i class="muted">“${esc(f.quote.slice(0,200))}”</i>`:''}
  ${f.url?`<br><a href="${f.url}" target="_blank" style="color:var(--accent);font-size:11.5px">open source ↗</a>`:''}</div>`}
function esc(s){return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')}
function md(src){ // tiny markdown renderer: headings, bold, tables, lists, [n] citations
  // Defensive LaTeX cleanup — the writer is told plain-text-only, but strip any leakage.
  src=src.replace(/\$\$([\s\S]*?)\$\$/g,(_,t)=>' '+t.replace(/\\text\{([^}]*)\}/g,'$1')
      .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g,'($1) / ($2)')
      .replace(/\\quad|\\[a-zA-Z]+/g,' ').replace(/[{}]/g,'').replace(/\s+/g,' ').trim()+' ');
  const lines=src.split('\n');let out='',intable=false,inlist=false;
  const inline=s=>esc(s).replace(/\*\*(.+?)\*\*/g,'<b>$1</b>').replace(/\[(\d+)\]/g,'<a class="cite" onclick="cite($1)">[$1]</a>');
  for(const ln of lines){
    if(/^\s*\|/.test(ln)){const cells=ln.split('|').slice(1,-1).map(c=>c.trim());
      if(cells.every(c=>/^:?-+:?$/.test(c)))continue;
      if(!intable){out+='<table>';intable=true}
      out+='<tr>'+cells.map(c=>'<td>'+inline(c)+'</td>').join('')+'</tr>';continue}
    if(intable){out+='</table>';intable=false}
    if(/^## /.test(ln)){out+='<h2>'+inline(ln.slice(3))+'</h2>';continue}
    if(/^[-*] /.test(ln)){if(!inlist){out+='<ul style="margin:4px 0 4px 18px">';inlist=true}
      out+='<li>'+inline(ln.slice(2))+'</li>';continue}
    if(inlist){out+='</ul>';inlist=false}
    if(ln.trim())out+='<p style="margin:6px 0">'+inline(ln)+'</p>';}
  if(intable)out+='</table>';if(inlist)out+='</ul>';return out}
function cite(n){const f=(run.findings||[]).find(x=>x.n===n);if(!f)return;const p=$('panel');
  p.style.display='block';p.innerHTML=`<div class="row" style="justify-content:space-between"><b style="color:var(--accent)">[${n}]</b>
  <button class="ghost" onclick="$('panel').style.display='none'">✕</button></div>`+fhtml(f);}
// ---- information tree: tidy layout + pan/zoom canvas (no libraries) ----
let treeRendered=null, treePeriod=null;   // treePeriod null = latest values
function periodLabels(root){ // union of every node's period labels, root's order first
  const seen=[];(function w(n){for(const k of Object.keys(n.periods||{}))if(!seen.includes(k))seen.push(k);
    (n.children||[]).forEach(w)})(root);return seen}
// Status of a node under a period: value | didn't-exist-yet | cannot-find.
// "since" (launch/acquisition year from findings) separates honest absence
// from a research gap: pre-existence is n/a, post-existence missing is RED.
function periodStatus(n,label){
  if(label===null)return {v:n.value||'',kind:'ok'};
  const pv=(n.periods||{})[label];
  if(pv)return {v:pv,kind:'ok',manual:(n.manual_labels||[]).includes(label)};
  const py=(String(label).match(/20\d\d/)||[])[0], sy=(String(n.since||'').match(/20\d\d/)||[])[0];
  if(py&&sy&&+py<+sy)return {kind:'na',since:sy};
  // Honest distinction: red "cannot find" ONLY after a targeted hunt ran and
  // failed; before that the cell is simply "not searched yet".
  if((n.searched_periods||{})[label]==='not_found')return {kind:'searched_missing'};
  return {kind:'missing'};
}
function nodeValue(n){
  const s=periodStatus(n,treePeriod);
  if(s.kind==='ok')return {v:s.v+(s.manual?' ✎':''),dim:false,color:null};
  if(s.kind==='na')return {v:`n/a (since ${s.since})`,dim:true,color:'var(--muted)'};
  if(s.kind==='searched_missing')return {v:'cannot find (searched)',dim:false,color:'#f87171'};
  return {v:'not searched — click to hunt',dim:true,color:'var(--muted)'};
}
function renderTree(root){
  const key=run.id+'|'+treePeriod;
  if(treeRendered===key)return; treeRendered=key;   // re-render on run or period change
  (function annotate(n,path){n._path=[...path,n.name];(n.children||[]).forEach(c=>annotate(c,n._path))})(root,[]);
  // Period selector: click through quarters/years and watch the tree change.
  // (DOM listeners, not inline onclick — labels would break attribute quoting.)
  const labels=periodLabels(root);
  const pbox=$('periods');pbox.innerHTML='';
  for(const p of [...labels,null]){
    const b=document.createElement('button');b.className='ghost';
    b.style.cssText='padding:3px 8px;font-size:11px'+((p===treePeriod)?';border-color:var(--accent);color:var(--accent)':'');
    b.textContent=p===null?'latest':p;
    b.onclick=()=>{treePeriod=p;renderTree(root)};
    pbox.appendChild(b)}
  const W=168,H=70,GX=12,LH=118;                          // node + level geometry
  // Tidy-tree layout: leaves claim horizontal slots, parents center over children.
  const nodes=[];let leaf=0,maxD=0;
  (function place(n,d){maxD=Math.max(maxD,d);
    const kids=(n.children||[]).slice(0,8);
    const self={n,x:0,y:d*LH,parent:null};
    if(!kids.length){self.x=leaf*(W+GX);leaf++}
    else{const ks=kids.map(k=>{const c=place(k,d+1);c.parent=self;return c});
      self.x=(ks[0].x+ks[ks.length-1].x)/2}
    nodes.push(self);return self})(root,0);
  const w=Math.max(1,leaf)*(W+GX)-GX, h=(maxD+1)*LH;
  const vp=$('treevp');vp.innerHTML='';
  const inner=document.createElement('div');
  inner.style.cssText=`position:absolute;width:${w}px;height:${h}px;transform-origin:0 0`;
  // Curved connectors behind the nodes.
  let svg=`<svg width="${w}" height="${h}" style="position:absolute;inset:0;pointer-events:none">`;
  for(const l of nodes)if(l.parent){
    const px=l.parent.x+W/2,py=l.parent.y+H,cx=l.x+W/2,cy=l.y,my=(py+cy)/2;
    svg+=`<path d="M ${px} ${py} C ${px} ${my}, ${cx} ${my}, ${cx} ${cy}" fill="none" stroke="rgba(52,211,153,.35)" stroke-width="1.5"/>`}
  inner.innerHTML=svg+'</svg>';
  nodes.forEach((l,i)=>{const el=document.createElement('div');
    el.style.cssText=`position:absolute;left:${l.x}px;top:${l.y}px;width:${W}px;height:${H}px;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:5px 8px;overflow:hidden;cursor:pointer;font-size:11px;line-height:1.3`;
    const nv=nodeValue(l.n);
    const warn=(l.n.warnings||[]).length?'<span title="validation warning — see node details" style="color:#f87171"> ⚠</span>':'';
    el.innerHTML=`<b>${esc(l.n.name).slice(0,60)}</b>${warn}<br><span style="color:${nv.color||(nv.dim?'var(--muted)':l.n.estimated?'#fbbf24':'var(--accent)')};font-family:monospace">${esc(nv.v)}</span>${l.n.estimated&&!nv.dim&&!nv.color?'<span style="color:#fbbf24;font-size:8px"> est</span>':''}<span class="muted"> ${treePeriod===null?esc(l.n.share||''):''}</span>${l.n.growth&&treePeriod===null?`<br><span style="color:#fbbf24;font-size:10px">${esc(l.n.growth)}</span>`:''}`;
    el.onmouseenter=()=>el.style.borderColor='var(--accent)';
    el.onmouseleave=()=>el.style.borderColor='var(--border)';
    el.onclick=()=>{if(!drag.moved)showNode(l.n)};
    inner.appendChild(el)});
  vp.appendChild(inner);
  // Pan (drag) + zoom (wheel), starting at a readable scale centered on the root.
  const view={x:0,y:10,s:Math.max(Math.min((vp.clientWidth-30)/w,(vp.clientHeight-20)/h,1.1),.55)};
  view.x=vp.clientWidth/2-(w/2)*view.s;
  const apply=()=>inner.style.transform=`translate(${view.x}px,${view.y}px) scale(${view.s})`;apply();
  const drag={on:false,moved:false,px:0,py:0,ox:0,oy:0};
  vp.onpointerdown=e=>{drag.on=true;drag.moved=false;drag.px=e.clientX;drag.py=e.clientY;drag.ox=view.x;drag.oy=view.y};
  vp.onpointermove=e=>{if(!drag.on)return;const dx=e.clientX-drag.px,dy=e.clientY-drag.py;
    if(Math.abs(dx)+Math.abs(dy)>4)drag.moved=true;
    if(drag.moved){view.x=drag.ox+dx;view.y=drag.oy+dy;apply()}};
  vp.onpointerup=()=>drag.on=false;vp.onpointerleave=()=>drag.on=false;
  vp.addEventListener('wheel',e=>{e.preventDefault();
    const f=e.deltaY<0?1.12:1/1.12,s=Math.min(2.2,Math.max(.3,view.s*f));
    const r=vp.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
    view.x=mx-((mx-view.x)/view.s)*s;view.y=my-((my-view.y)/view.s)*s;view.s=s;apply()},{passive:false});
}
function showNode(n){const p=$('panel');p.style.display='block';
  p.innerHTML=`<div class="row" style="justify-content:space-between"><b>${esc(n.name)}</b>
    <button class="ghost" onclick="$('panel').style.display='none'">✕</button></div>
    <p style="margin:6px 0">${n.value?`<span style="color:${n.estimated?'#fbbf24':'var(--accent)'};font-family:monospace"><b>${esc(n.value)}</b></span>`:''}
    ${n.share?`<span class="badge">${esc(n.share)} of total</span>`:''} ${n.growth?`<span class="badge">${esc(n.growth)}</span>`:''}</p>
    ${n.note?`<p class="small muted">${esc(n.note)}</p>`:''}
    ${n.estimated?`<p class="small" style="border:1px solid #fbbf2466;border-radius:8px;padding:6px;margin-top:6px"><b style="color:#fbbf24;font-size:10px">ESTIMATE — HOW IT WAS DERIVED</b><br>${esc(n.basis||'Triangulated from the findings.')}</p>`:''}
    ${(n.warnings||[]).length?`<p class="small" style="border:1px solid #f8717166;border-radius:8px;padding:6px;margin-top:6px;color:#f87171"><b style="font-size:10px">⚠ VALIDATION</b><br>${n.warnings.map(esc).join('<br>')}</p>`:''}
    ${periodTable(n)}
    ${(n.citations||[]).length?`<p class="small" style="margin-top:6px">Sources: ${n.citations.map(c=>`<a class="cite" onclick="cite(${c})">[${c}]</a>`).join(' ')}</p>`:''}`}
// Full period table with honest statuses + manual entry per period.
function periodTable(n){
  const labels=[...periodLabels(run.tree)];
  const rows=[['latest',null],...labels.map(p=>[p,p])].map(([disp,lab])=>{
    const s=lab===null?{v:n.value||'',kind:n.value?'ok':'missing',manual:(n.manual_labels||[]).includes('latest')}:periodStatus(n,lab);
    let cell;
    if(s.kind==='ok')cell=`<span style="font-family:monospace;color:var(--accent)">${esc(s.v)}${s.manual?' ✎':''}</span>`;
    else if(s.kind==='na')cell=`<span class="muted">n/a — didn't exist yet (since ${s.since})</span>`;
    else if(s.kind==='searched_missing')cell=`<span style="color:#f87171">cannot find — searched, likely undisclosed</span>`;
    else cell=`<span class="muted">not searched yet</span>`;
    const pid='ed_'+disp.replace(/[^a-zA-Z0-9]/g,'');
    const pathAttr=JSON.stringify(n._path||[n.name]);
    const perAttr=disp==='latest'?'latest':disp;
    const huntBtn=(s.kind==='missing'||s.kind==='searched_missing')
      ?`<button class="ghost" style="padding:2px 6px;font-size:10px" data-path='${pathAttr}' data-period="${perAttr}" onclick="huntTreeValue(this)" title="Run targeted searches for exactly this value">🔍</button>`:'';
    return `<tr><td style="border:1px solid var(--border);padding:2px 6px" class="muted">${esc(disp)}</td>
      <td style="border:1px solid var(--border);padding:2px 6px">${cell}</td>
      <td style="border:1px solid var(--border);padding:2px 4px;white-space:nowrap">${huntBtn}
        <input id="${pid}" placeholder="$…" style="width:64px;padding:2px 4px;font-size:11px">
        <button class="ghost" style="padding:2px 6px;font-size:10px" data-path='${pathAttr}' data-period="${perAttr}" data-input="${pid}" onclick="saveTreeValue(this)">set</button></td></tr>`});
  return `<table style="border-collapse:collapse;margin-top:8px;font-size:11.5px;width:100%">${rows.join('')}</table>
    <p class="muted" style="font-size:10px;margin-top:4px">✎ = manually entered · red = existed but no data found · type a value (e.g. $3.4B) and “set” to fill or correct</p>`}
async function huntTreeValue(btn){
  const path=JSON.parse(btn.dataset.path), period=btn.dataset.period;
  btn.textContent='⏳';btn.disabled=true;
  const r=await j('/api/run/'+current+'/tree/hunt',{method:'POST',body:JSON.stringify({path,period})});
  if(r.error){btn.textContent='🔍';btn.disabled=false;return alert(r.error)}
  run.tree=r.tree;run.findings=r.findings;treeRendered=null;renderTree(run.tree);
  $('findings').innerHTML=run.findings.map(f=>fhtml(f)).join('');
  let node=run.tree;for(const nm of path.slice(1))node=(node.children||[]).find(c=>c.name===nm)||node;
  showNode(node);
}
async function saveTreeValue(btn){
  const path=JSON.parse(btn.dataset.path), period=btn.dataset.period, value=$(btn.dataset.input).value.trim();
  if(!value)return;
  const r=await j('/api/run/'+current+'/tree',{method:'POST',body:JSON.stringify({path,period,value})});
  if(r.error)return alert(r.error);
  run.tree=r.tree;treeRendered=null;renderTree(run.tree);
  let node=run.tree;for(const nm of path.slice(1))node=(node.children||[]).find(c=>c.name===nm)||node;
  showNode(node);
}
loadCfg();loadRuns();
</script></body></html>"""


class Server(ThreadingHTTPServer):
    # Fail loudly if the port is taken. The http.server default (SO_REUSEADDR)
    # lets multiple processes silently share a port on Windows, which leaves
    # zombie servers answering requests with stale code.
    allow_reuse_address = False


if __name__ == "__main__":
    # ASCII-only console output — Windows cp1252 terminals choke on unicode.
    print(f"Good Faith Finance research demo -> http://localhost:{PORT}")
    print(f"API key is entered in the UI and stored at {CONFIG_PATH} (never in this folder).")
    try:
        Server(("127.0.0.1", PORT), Handler).serve_forever()
    except OSError:
        raise SystemExit(f"Port {PORT} is already in use — is the demo already running?")
