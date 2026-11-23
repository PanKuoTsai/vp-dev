const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
function reveal(el){const t=el.closest('[data-module]');if(t&&t.dataset.module&&vscode)vscode.postMessage({type:'reveal',module:t.dataset.module});}
const post=m=>{if(vscode)vscode.postMessage(m);};
const ADDR=/^(0x[0-9A-Fa-f]+|\d+|\$\{[A-Za-z_]\w*\}(\s*[+-]\s*(0x[0-9A-Fa-f]+|\d+))?)$/;
function rowsOf(box,skip){const out=[];for(const tr of box.querySelectorAll('tr.img-row')){if(tr===skip)continue;const orig=Number(tr.dataset.orig);
  if(tr.dataset.kind==='raw'){out.push({orig,kind:'raw'});continue;}
  out.push({orig,kind:tr.querySelector('.img-kind').value,file:tr.querySelector('.img-file').value.trim(),address:tr.querySelector('.img-addr').value.trim()});}return out;}
function submit(box,skip){const err=box.querySelector('.form-error');err.textContent='';const rows=rowsOf(box,skip);
  for(const r of rows){if(r.kind==='bin'&&!ADDR.test(r.address)){err.textContent='"'+r.address+'" is not a valid load address. Use hex such as 0x80000000, a decimal number, or ${NAME} with an optional +offset.';return;}}
  post({type:'setImages',module:box.dataset.loader,rows});}
// The view is re-rendered after every edit, so the selection, tabs, filters,
// scroll position and focused field are kept in the webview state.
const S=Object.assign({module:null,filters:{},scopes:{},scroll:0,focus:null,dock:'map',itab:'params',ol:''},(vscode&&vscode.getState())||{});
S.scopes=S.scopes||{};S.filters=S.filters||{};S.adv=S.adv||{};
const save=()=>{if(vscode)vscode.setState(S);};
const narrow=()=>window.matchMedia('(max-width:660px)').matches;
const panelOf=m=>document.querySelector('.mod-panel[data-panel="'+CSS.escape(m)+'"]');
const bodyOf=(p,scope)=>p.querySelector('.p-scope-body[data-scope="'+CSS.escape(scope)+'"]');
const indexOf=el=>{const b=el.closest('.p-scope-body');return b&&b.dataset.scope!=='all'?b.dataset.scope:null;};
function setItab(p,tab){const has=p.querySelector('.itab-body[data-tab="'+tab+'"]');if(!has)tab='params';
  p.querySelectorAll('.itab').forEach(b=>b.classList.toggle('on',b.dataset.tab===tab));
  p.querySelectorAll('.itab-body').forEach(b=>{b.hidden=b.dataset.tab!==tab;});}
let dtAsked=false;
function askDeviceTree(against){const p=document.querySelector('.dt-pane');if(p&&dtAsked){const s=p.querySelector('.dt-stats');if(s)s.textContent='working…';}
  dtAsked=true;post({type:'deviceTree',against:against||S.dt||'auto'});}
function setDock(id){if(!document.querySelector('.dock-body[data-dock="'+id+'"]'))id='map';
  if(id==='dt'&&!dtAsked)askDeviceTree();
  document.querySelectorAll('.dtab').forEach(b=>b.classList.toggle('on',b.dataset.dock===id));
  document.querySelectorAll('.dock-body').forEach(b=>{b.hidden=b.dataset.dock!==id;});S.dock=id;save();
  if(typeof txWatch==='function'){txWatch(id==='tx');if(id==='tx')txDraw(true);}}
S.multi=Array.isArray(S.multi)?S.multi:[];
function showMulti(){const many=S.multi.length>=2;const mp=document.querySelector('.multi-panel');
  document.querySelectorAll('.node,.ol-item').forEach(n=>n.classList.toggle('multi',S.multi.includes(n.dataset.module)));
  if(!mp)return;mp.hidden=!many;
  if(many){document.querySelectorAll('.mod-panel').forEach(x=>{x.hidden=true;});document.querySelectorAll('.node.selected,.ol-item.selected').forEach(n=>n.classList.remove('selected'));const h=document.querySelector('.insp-empty');if(h)h.hidden=true;
    mp.querySelector('.multi-count').textContent=S.multi.length+' modules selected';const ul=mp.querySelector('.multi-list');ul.textContent='';
    for(const m of S.multi){const li=document.createElement('li');li.textContent=m;ul.append(li);}}
  else if(S.module&&panelOf(S.module)){panelOf(S.module).hidden=false;document.querySelectorAll('.node,.ol-item').forEach(n=>n.classList.toggle('selected',n.dataset.module===S.module));}else{const h=document.querySelector('.insp-empty');if(h)h.hidden=false;}}
function toggleMulti(m){if(!S.multi.length&&S.module&&S.module!==m)S.multi.push(S.module);
  const k=S.multi.indexOf(m);if(k>=0)S.multi.splice(k,1);else S.multi.push(m);save();showMulti();}
S.sig=S.sig||'selected';
function setHot(m){document.querySelectorAll('.sig').forEach(l=>l.classList.toggle('on',!!m&&(l.dataset.a===m||l.dataset.b===m)));}
function setSig(mode){S.sig=mode;save();document.body.classList.toggle('sig-all',mode==='all');document.body.classList.toggle('sig-off',mode==='off');
  document.querySelectorAll('.sig-btn').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.sig===mode)));}
document.addEventListener('pointerover',e=>{const n=e.target.closest&&e.target.closest('.node');if(n&&!drag)setHot(n.dataset.module);});
document.addEventListener('pointerout',e=>{const n=e.target.closest&&e.target.closest('.node');if(n&&!(e.relatedTarget&&n.contains(e.relatedTarget)))setHot(S.module);});
function select(m,scroll){const p=panelOf(m);if(!p)return false;
  setHot(m);
  if(S.multi.length){S.multi=[];showMulti();}
  document.querySelectorAll('.mod-panel').forEach(x=>{x.hidden=x!==p;});
  document.querySelectorAll('.node').forEach(n=>n.classList.toggle('selected',n.dataset.module===m));
  document.querySelectorAll('.ol-item').forEach(n=>n.classList.toggle('selected',n.dataset.module===m));
  const h=document.querySelector('.insp-empty');if(h)h.hidden=true;
  setItab(p,S.itab);
  S.module=m;save();if(scroll&&narrow())p.scrollIntoView({block:'nearest'});if(S.dock==='tx'&&typeof txDraw==='function')txDraw();return true;}
function applyFilter(p){const f=p.querySelector('.p-filter');const q=f?f.value.trim().toLowerCase():'';let n=0;
  p.querySelectorAll('.p-scope-body').forEach(b=>b.querySelectorAll('.p-row').forEach(r=>{const show=!q||r.dataset.filter.includes(q);r.hidden=!show;if(show&&!b.hidden)n++;}));
  p.querySelector('.p-none').hidden=n>0||!q;}
function setScope(p,scope){const sel=p.querySelector('.p-scope');if(!sel||!bodyOf(p,scope))return;sel.value=scope;
  p.querySelectorAll('.p-scope-body').forEach(b=>{b.hidden=b.dataset.scope!==scope;});
  const help=p.querySelector('.p-scope-help');if(help)help.hidden=scope==='all';
  document.querySelectorAll('.node[data-module="'+CSS.escape(p.dataset.panel)+'"] rect.core').forEach(r=>r.classList.toggle('on',r.dataset.index===scope));
  S.scopes[p.dataset.panel]=scope;save();applyFilter(p);}
function rowInput(m,name,index){const p=panelOf(m);const b=p&&bodyOf(p,index===null||index===undefined?'all':String(index));
  return b&&b.querySelector('.p-row[data-name="'+CSS.escape(name)+'"] .p-input');}
/* fmtAddr, parseAddress, lookupAddress and routeFor of lib/webview/view.js are put here when the page is made */
const ROUTES=JSON.parse((document.getElementById('vp-routes')||{textContent:'{"inst":{},"regions":{}}'}).textContent);
// The block that shows a module: its own, else the collapsed subsystem it is in.
function visNode(base){let b=base;while(b){const n=document.querySelector('.diagram .node:not(.bus)[data-module="'+CSS.escape(b)+'"]');if(n)return n;const i=b.lastIndexOf('.');if(i<0)break;b=b.slice(0,i);}return null;}
const busNode=b=>document.querySelector('.diagram .node.bus[data-module="'+CSS.escape(b)+'"]');
const boxOf=n=>{const r=n.querySelector('rect.box');return{x:+r.getAttribute('x'),y:+r.getAttribute('y'),w:+r.getAttribute('width'),h:+r.getAttribute('height')};};
function clearRoute(){document.querySelectorAll('.diagram .route').forEach(x=>x.classList.remove('route'));document.querySelectorAll('.route-line').forEach(x=>x.remove());document.body.classList.remove('routing');}
// Light up initiator -> bus(es) -> target and draw a line along the wires. Returns the route, or null.
function drawRoute(spec){clearRoute();const r=spec&&routeFor(ROUTES,spec);if(!r)return null;
  const t=visNode(r.target);if(!t)return r;const f=r.from?visNode(r.from):null;const bars=r.buses.map(busNode).filter(Boolean);
  [t,f,...bars].forEach(n=>{if(n)n.classList.add('route');});
  let tile=null;if(f&&r.index!==null&&r.index!==undefined){tile=f.querySelector('rect.core[data-index="'+r.index+'"]');if(tile)tile.classList.add('route');}
  document.body.classList.add('routing');
  const tb=boxOf(t);const ys=bars.map(b=>{const x=boxOf(b);return x.y+x.h/2;});const pts=[];
  // Below a bar, a block hangs from the spine 14 px to its left.
  const hang=(b,y)=>b.y>y;
  if(f&&f!==t){const fb=boxOf(f);
    if(ys.length&&hang(fb,ys[0])){pts.push([fb.x,fb.y+fb.h/2],[fb.x-14,fb.y+fb.h/2],[fb.x-14,ys[0]]);}
    else{const fx=tile?+tile.getAttribute('x')+(+tile.getAttribute('width'))/2:fb.x+fb.w/2;pts.push([fx,tile?+tile.getAttribute('y')+12:fb.y+fb.h]);if(ys.length)pts.push([fx,ys[0]]);}}
  const last=ys.length?ys[ys.length-1]:null;
  const sx=last!==null&&hang(tb,last)?tb.x-14:tb.x+tb.w/2;
  if(!pts.length&&ys.length)pts.push([Math.min(sx,tb.x+tb.w/2)-40,ys[0]]);
  ys.forEach(y=>pts.push([sx,y]));
  if(last!==null&&hang(tb,last))pts.push([sx,tb.y+tb.h/2],[tb.x,tb.y+tb.h/2]);else pts.push([sx,last!==null&&tb.y+tb.h<last?tb.y+tb.h:tb.y]);
  const clean=pts.filter((p,i)=>!i||p[0]!==pts[i-1][0]||p[1]!==pts[i-1][1]);
  if(clean.length>1){const svg=t.ownerSVGElement;const line=document.createElementNS('http://www.w3.org/2000/svg','path');line.setAttribute('class','route-line');
    line.setAttribute('d','M'+clean.map(p=>p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' L'));line.setAttribute('marker-end','url(#vp-arrow-route)');svg.appendChild(line);}
  return r;}
const specOf=el=>({region:el.dataset.routeRegion,from:el.dataset.routeFrom||null,bus:el.dataset.routeBus||null});
const routeName=(r,spec)=>(spec.initiator||(r.from?r.from+(r.index!==null&&r.index!==undefined?'_'+r.index:'')+(r.port?'.'+r.port:''):'any initiator'))+' → '+r.buses.join(' › ')+(r.buses.length?' → ':'')+r.region;
// The route kept on screen (S.route), shown again after every render.
function pinRoute(spec,scroll){S.route=spec||null;save();if(typeof TX!=='undefined'&&TX.pinned){TX.pinned=0;document.querySelectorAll('tr.tx-row.pinned').forEach(x=>x.classList.remove('pinned'));}const bar=document.querySelector('.route-bar');
  document.querySelectorAll('.routable.pinned').forEach(x=>x.classList.remove('pinned'));
  const r=drawRoute(spec);
  document.body.classList.toggle('route-pinned',!!r);
  if(bar){bar.hidden=!r;if(r){bar.querySelector('.route-text').textContent=routeName(r,spec);bar.querySelector('.route-detail').textContent=spec.detail||'';bar.title=routeName(r,spec)+(spec.detail?'\n'+spec.detail:'');}}
  if(!r){if(spec){S.route=null;save();}return;}
  document.querySelectorAll('.routable').forEach(x=>{const o=specOf(x);if(o.region===r.region&&(o.from||null)===(r.from||null))x.classList.add('pinned');});
  if(scroll){const t=visNode(r.target);if(t)t.scrollIntoView({block:'nearest',inline:'nearest'});}}
const previewRoute=el=>drawRoute(specOf(el));
const restoreRoute=()=>{if(S.route)drawRoute(S.route);else clearRoute();};
document.addEventListener('pointerover',e=>{const el=e.target.closest&&e.target.closest('[data-route-region]');if(el)previewRoute(el);});
document.addEventListener('pointerout',e=>{const el=e.target.closest&&e.target.closest('[data-route-region]');if(el&&!(e.relatedTarget&&el.contains(e.relatedTarget)))restoreRoute();});
document.addEventListener('focusin',e=>{const el=e.target.closest&&e.target.closest('[data-route-region]');if(el)previewRoute(el);});
document.addEventListener('focusout',e=>{const el=e.target.closest&&e.target.closest('[data-route-region]');if(el)restoreRoute();});
// The Transactions tab: the running simulation's accesses, polled by the extension while the tab is open.
const TX={all:[],frozen:null,follow:true,state:null,watching:false,pinned:0,mark:{from:0,to:0}};
const TXKEEP=5000,TXSHOW=400;
const txModule=point=>{const i=point.lastIndexOf('.');return i<0?point:point.slice(0,i);};
const txIniBase=name=>{const i=name.lastIndexOf('.');const n=i<0?name:name.slice(0,i);const hit=ROUTES.inst[n];return hit?hit[0]:n;};
const under=(b,m)=>b===m||b.startsWith(m+'.');
function txWatch(on){if(TX.watching===on)return;TX.watching=on;post({type:'txWatch',on});}
function txSpec(r){return{region:r.point,initiator:r.initiator||undefined,detail:(r.dir==='W'?'write ':'read ')+r.address+(r.length?' · '+r.length+' byte'+(r.length===1?'':'s'):'')+(r.value?' · '+r.value:'')+' · '+Number(r.time).toFixed(6)+' s · #'+r.seq+(r.initiator?'':' · initiator unknown')};}
function txDraw(arrived){const body=document.querySelector('.tx-rows');if(!body)return;
  const st=TX.state;const empty=document.querySelector('.tx-empty');const status=document.querySelector('.tx-status');
  const live=!!(st&&st.connected);status.className='status tx-status '+(live&&st.recordingProbes?'live':'idle');
  document.querySelector('.tx-state').textContent=!st?'Waiting…':st.connected?(st.recordingProbes?st.recordingProbes+' of '+st.probes+' probes recording':st.probes?'No probe recording':'No probes'):st.mine?'Not connected':'Not running';
  const cnt=document.querySelector('.dtab[data-dock="tx"] .count');if(cnt)cnt.textContent=TX.all.length?String(TX.all.length):'–';
  empty.textContent='';const btn=(cmd,label)=>{const b=document.createElement('button');b.className='run-cmd';b.dataset.command=cmd;b.textContent=label;return b;};
  if(st&&st.other){empty.append('The running simulation is '+st.other+', not this platform.');}
  else if(st&&!st.connected&&!TX.all.length){empty.append('No simulation of this platform is running. Start it with tracing to see its bus accesses here.');empty.append(btn('startTrace','Start Simulation with Tracing…'));}
  else if(st&&st.connected&&!st.recordingProbes&&!TX.all.length){empty.append(st.probes?'No probe is recording yet.':'This simulation has no probes.');if(st.probes)empty.append(btn('probes','Choose probes…'));}
  else if(st&&st.connected&&!TX.all.length){empty.append('No accesses yet.');}
  const sel=document.querySelector('.tx-sel').checked&&S.module;const dir=document.querySelector('.tx-dir').value;
  const src=TX.frozen||TX.all;const rows=[];
  for(let i=src.length-1;i>=0&&rows.length<TXSHOW;i--){const r=src[i];if(dir&&r.dir!==dir)continue;
    if(sel&&!under(txModule(r.point),S.module)&&!(r.initiator&&under(txIniBase(r.initiator),S.module)))continue;rows.push(r);}
  rows.reverse();
  document.querySelector('.tx-shown').textContent=src.length?(rows.length===TXSHOW?'newest '+TXSHOW+' shown':rows.length+' shown')+' of '+src.length+(TX.frozen?' · Follow off':''):'';
  body.textContent='';const frag=document.createDocumentFragment();
  for(const r of rows){const tr=document.createElement('tr');tr.dataset.seq=r.seq;const since=r.seq>TX.mark.from&&r.seq<=TX.mark.to;tr.className=(r.status!=='OK'&&r.dir!=='S'?'err ':'')+(r.dir!=='S'?'tx-row routable':'')+(r.seq===TX.pinned?' pinned':'')+(since?' since':'');
    if(r.dir!=='S'){tr.tabIndex=0;tr.title='Hover to see the route, click to keep it';}
    const cell=(t,c)=>{const td=document.createElement('td');if(c)td.className=c;td.textContent=t;tr.append(td);return td;};
    cell(Number(r.time).toFixed(9),'num');cell(r.dir==='S'?'':r.initiator||'–','ini');cell(r.point,'');
    const pill=document.createElement('span');pill.className='pill '+r.dir;pill.textContent=r.dir==='S'?(r.value==='1'?'signal ↑':'signal ↓'):r.dir==='W'?'write':'read';cell('','').append(pill);
    cell(r.address,'');cell(r.value||'','');frag.append(tr);}
  body.append(frag);
  if(arrived&&TX.follow&&!TX.frozen){const sc=document.querySelector('.tx-scroll');sc.scrollTop=sc.scrollHeight;}}
let txPending=false,txArrived=false;const txSchedule=(arrived)=>{txArrived=txArrived||!!arrived;if(!txPending){txPending=true;requestAnimationFrame(()=>{txPending=false;const a=txArrived;txArrived=false;txDraw(a);});}};
const txRecord=tr=>{const seq=Number(tr.dataset.seq);const src=TX.frozen||TX.all;for(let i=src.length-1;i>=0;i--)if(src[i].seq===seq)return src[i];return null;};
document.addEventListener('pointerover',e=>{const tr=e.target.closest&&e.target.closest('tr.tx-row');if(tr){const r=txRecord(tr);if(r)drawRoute(txSpec(r));}});
document.addEventListener('pointerout',e=>{const tr=e.target.closest&&e.target.closest('tr.tx-row');if(tr&&!(e.relatedTarget&&tr.contains(e.relatedTarget)))restoreRoute();});
function txPin(tr){const r=txRecord(tr);if(!r)return;if(TX.pinned===r.seq)pinRoute(null);else{pinRoute(txSpec(r));TX.pinned=r.seq;tr.classList.add('pinned');post({type:'txRegister',address:r.address});}}
document.addEventListener('click',e=>{const tr=e.target.closest&&e.target.closest('tr.tx-row');if(tr){txPin(tr);return;}
  if(e.target.closest&&e.target.closest('.tx-follow')){TX.follow=!TX.follow;TX.frozen=TX.follow?null:TX.all.slice();e.target.closest('.tx-follow').setAttribute('aria-pressed',String(TX.follow));txDraw(TX.follow);}});
document.addEventListener('keydown',e=>{const tr=e.target.closest&&e.target.closest('tr.tx-row');if(tr&&(e.key==='Enter'||e.key===' ')){e.preventDefault();e.stopPropagation();txPin(tr);}},true);
document.addEventListener('change',e=>{if(e.target.matches('.tx-sel,.tx-dir')){S.tx={sel:document.querySelector('.tx-sel').checked,dir:document.querySelector('.tx-dir').value};save();txDraw();}});
window.addEventListener('message',ev=>{const m=ev.data;if(!m)return;
  if(m.type==='txState'){TX.state=m;txSchedule();}
  else if(m.type==='stopMark'){TX.mark={from:Number(m.from)||0,to:Number(m.to)||0};txSchedule();}
  else if(m.type==='tx'){if(m.reset){TX.all=[];TX.frozen=TX.follow?null:[];}TX.all.push(...(m.records||[]));if(TX.all.length>TXKEEP)TX.all=TX.all.slice(TX.all.length-TXKEEP);txSchedule(true);}});
const REGIONS=JSON.parse((document.getElementById('vp-regions')||{textContent:'[]'}).textContent).map(r=>Object.assign(r,{start:BigInt(r.start),end:BigInt(r.end)}));
function findAddress(text){const out=document.querySelector('.addr-result');if(!out)return;out.textContent='';
  document.querySelectorAll('tr.hit,.node.hit').forEach(x=>x.classList.remove('hit'));
  if(!text.trim())return;const a=parseAddress(text);const span=(cls,t)=>{const s=document.createElement('span');if(cls)s.className=cls;s.textContent=t;return s;};
  if(a===null){out.append(span('bad','Not an address: use hex such as 0x1000_0010, or decimal.'));return;}
  const res=lookupAddress(REGIONS,a);
  if(!res.length){out.append(span('bad',fmtAddr(a)+' is not mapped on any bus.'));return;}
  for(const r of res){const b=document.createElement('button');b.className='goto-mod';b.dataset.module=r.hit.base;b.textContent=r.hit.instance+'.'+r.hit.port;
    const rb=document.createElement('button');rb.className='route-pin';rb.dataset.region=r.hit.instance+'.'+r.hit.port;rb.dataset.bus=r.bus;rb.textContent='Route';rb.title='Show the route to it in the diagram';
    out.append(span('mono',fmtAddr(a)+' →'),b,rb,span('muted','offset '+fmtAddr(r.hit.offset)+' · on '+r.bus+(r.shadowed.length?' · shadows '+r.shadowed.map(x=>x.instance+' (priority '+x.priority+')').join(', '):'')));
    document.querySelectorAll('tr[data-region="'+CSS.escape(r.hit.instance+'.'+r.hit.port)+'"]').forEach(x=>x.classList.add('hit'));
    document.querySelectorAll('.node[data-module="'+CSS.escape(r.hit.base)+'"]').forEach(x=>x.classList.add('hit'));}}
function filterOutline(q){q=q.trim().toLowerCase();document.querySelectorAll('.ol-group').forEach(g=>{let n=0;
  g.querySelectorAll('.ol-item').forEach(i=>{const show=!q||i.dataset.filter.includes(q);i.hidden=!show;if(show)n++;});g.hidden=n===0;});}
document.addEventListener('input',e=>{
  if(e.target.matches('.p-filter')){const p=e.target.closest('.mod-panel');S.filters[p.dataset.panel]=e.target.value;save();applyFilter(p);}
  if(e.target.matches('.ol-filter')){S.ol=e.target.value;save();filterOutline(e.target.value);}
  if(e.target.matches('.addr-find')){S.find=e.target.value;save();findAddress(e.target.value);}});
document.addEventListener('focusin',e=>{const p=e.target.closest('.mod-panel');
  S.focus=p&&e.target.matches('.p-input,.p-filter')?{panel:p.dataset.panel,index:e.target.matches('.p-filter')?null:indexOf(e.target),name:e.target.matches('.p-filter')?null:e.target.closest('.p-row').dataset.name}:null;save();});
window.addEventListener('scroll',()=>{S.scroll=window.scrollY;save();},{passive:true});
window.addEventListener('message',ev=>{const m=ev.data;
  if(m&&m.type==='route'){pinRoute(m.spec,true);return;}
  if(m&&m.type==='deviceTree'){const p=document.querySelector('.dt-pane');if(p)p.innerHTML=m.html;S.dt=m.against;save();return;}
  if(!m||m.type!=='paramError')return;const el=rowInput(m.module,m.name,m.index);if(!el)return;
  select(m.module,false);S.itab='params';setItab(panelOf(m.module),'params');setScope(panelOf(m.module),m.index===null||m.index===undefined?'all':String(m.index));
  const adv=el.closest('details');if(adv)adv.open=true;
  el.closest('.p-row').querySelector('.p-error').textContent=m.message;el.classList.add('invalid');el.focus();});
document.addEventListener('change',e=>{
  if(e.target.matches('.p-scope'))return setScope(e.target.closest('.mod-panel'),e.target.value);
  if(e.target.matches('.dt-against'))return askDeviceTree(e.target.value);
  if(!e.target.matches('.p-input'))return;const row=e.target.closest('.p-row');const p=e.target.closest('.mod-panel');
  row.querySelector('.p-error').textContent='';e.target.classList.remove('invalid');
  post({type:'setParam',module:p.dataset.panel,index:indexOf(e.target),name:row.dataset.name,kind:e.target.dataset.kind,input:e.target.value});});
// Drag from one block to another to connect them.
let drag=null,dragged=false;
const svgPoint=(svg,e)=>{const p=svg.createSVGPoint();p.x=e.clientX;p.y=e.clientY;return p.matrixTransform(svg.getScreenCTM().inverse());};
const nodeAt=e=>{const el=document.elementFromPoint(e.clientX,e.clientY);return el&&el.closest('.node');};
document.addEventListener('pointerdown',e=>{dragged=false;const n=e.target.closest('.node');if(!n||e.button!==0)return;const svg=n.ownerSVGElement;const r=n.querySelector('rect');
  drag={from:n,svg,x0:e.clientX,y0:e.clientY,cx:+r.getAttribute('x')+(+r.getAttribute('width'))/2,cy:+r.getAttribute('y')+(+r.getAttribute('height'))/2,line:null,over:null};});
document.addEventListener('pointermove',e=>{if(!drag)return;if(!drag.line){if(Math.hypot(e.clientX-drag.x0,e.clientY-drag.y0)<6)return;
    drag.line=document.createElementNS('http://www.w3.org/2000/svg','line');drag.line.setAttribute('class','drag-line');drag.line.setAttribute('x1',drag.cx);drag.line.setAttribute('y1',drag.cy);drag.svg.appendChild(drag.line);}
  const p=svgPoint(drag.svg,e);drag.line.setAttribute('x2',p.x);drag.line.setAttribute('y2',p.y);
  const over=nodeAt(e);const target=over&&over!==drag.from?over:null;if(drag.over&&drag.over!==target)drag.over.classList.remove('drop');if(target)target.classList.add('drop');drag.over=target;});
document.addEventListener('pointerup',e=>{if(!drag)return;const d=drag;drag=null;if(!d.line)return;d.line.remove();dragged=true;
  if(d.over){d.over.classList.remove('drop');select(d.from.dataset.module,false);post({type:'connect',module:d.from.dataset.module,peer:d.over.dataset.module});}});
document.addEventListener('dblclick',e=>{if(e.target.closest('.sub-toggle'))return;const n=e.target.closest('.node,.ol-item');if(n)reveal(n);});
document.addEventListener('click',e=>{const t=e.target.closest('button,a,.node,.seg,tr[data-module],li[data-module]')||e.target;
  if(t.matches('.p-reset'))return post({type:'resetParam',module:t.closest('.mod-panel').dataset.panel,index:indexOf(t),name:t.closest('.p-row').dataset.name});
  if(t.matches('.show-json'))return post({type:'reveal',module:t.dataset.module});
  if(t.matches('.delete-module'))return post({type:'deleteModule',module:t.dataset.module});
  if(t.matches('.connect'))return post({type:'connect',module:t.dataset.module,port:t.dataset.port});
  if(t.matches('.unbind'))return post({type:'disconnect',module:t.dataset.module,key:t.dataset.key,scope:t.dataset.scope===''?null:t.dataset.scope});
  if(t.matches('.run-cmd'))return post({type:'command',command:t.dataset.command});
  const tg=e.target.closest&&e.target.closest('.sub-toggle');if(tg){e.stopPropagation();return post({type:'toggleSubsystem',module:tg.dataset.module});}
  if(t.matches('.dt-write')){const s=document.querySelector('.dt-stats');if(s)s.textContent='writing…';return post({type:'deviceTreeWrite',against:S.dt||'auto'});}
  if(t.matches('.itab')){S.itab=t.dataset.tab;save();return setItab(t.closest('.mod-panel'),t.dataset.tab);}
  if(t.matches('.dtab'))return setDock(t.dataset.dock);
  if(t.matches('.sig-btn'))return setSig(t.dataset.sig);
  if(t.matches('[data-dock-open]')){setDock(t.dataset.dockOpen);document.querySelector('.dock').scrollIntoView({block:'nearest'});return;}
  if(dragged){dragged=false;if(t.closest('.node')){e.stopPropagation();return;}}
  if(t.matches('.add-module'))return post({type:'addModule',container:t.dataset.container||''});
  if(t.matches('.toggle-sub'))return post({type:'toggleSubsystem',module:t.dataset.module});
  if(t.matches('.route-clear'))return pinRoute(null);
  if(t.matches('.route-pin'))return pinRoute({region:t.dataset.region,bus:t.dataset.bus,detail:'any initiator on '+t.dataset.bus},true);
  if(t.matches('.goto')){e.preventDefault();select(t.dataset.module,true);return;}
  {const rt=e.target.closest&&e.target.closest('.routable[data-route-region]');if(rt&&!e.target.closest('a,button')){const o=specOf(rt);const same=S.route&&S.route.region===o.region&&(S.route.from||null)===o.from&&!S.route.initiator;return pinRoute(same?null:o);}}
  const many=e.ctrlKey||e.metaKey||e.shiftKey;
  if(many&&(t.matches('.ol-item')||t.closest('.node'))){const m=(t.matches('.ol-item')?t:t.closest('.node')).dataset.module;if(m){e.preventDefault();toggleMulti(m);}return;}
  if(t.matches('.group-modules')){const ms=S.multi.slice();S.multi=[];save();return post({type:'groupModules',modules:ms});}
  if(t.matches('.multi-clear')){S.multi=[];save();return showMulti();}
  if(t.matches('.swap-module'))return post({type:'swapModule',module:t.dataset.module});
  if(t.matches('.ol-item')||t.matches('.goto-mod')){select(t.dataset.module,true);return;}
  // A core tile: that one instance, with Applies to set to it.
  const core=e.target.closest&&e.target.closest('rect.core');
  if(core){const m=core.closest('.node').dataset.module;select(m,true);const p=panelOf(m);if(p)setScope(p,core.dataset.index);return;}
  const n=t.closest('.node');if(n){select(n.dataset.module,true);return;}
  if(t.closest('.mod-panel'))return;
  const r=t.closest('tr[data-module],li[data-module],.seg[data-module]');if(r&&r.dataset.module)select(r.dataset.module,false);},true);
if(S.tx){const c=document.querySelector('.tx-sel');if(c)c.checked=!!S.tx.sel;const d=document.querySelector('.tx-dir');if(d)d.value=S.tx.dir||'';}
setDock(S.dock);
setSig(S.sig);
{const given=document.body.dataset.route?JSON.parse(document.body.dataset.route):null;
  // A route sent while the view was hidden arrives in the page; one already shown stays in the state.
  if(given&&given.id!==S.routeId){S.routeId=given.id;S.route=given.spec;}
  if(S.route)pinRoute(S.route,!!given&&given.spec===S.route);}
document.querySelectorAll('details.advanced').forEach(d=>{const v=S.adv[d.dataset.panel];if(v!==undefined)d.open=v;});
document.addEventListener('toggle',e=>{if(e.target.matches&&e.target.matches('details.advanced')){S.adv[e.target.dataset.panel]=e.target.open;save();}},true);
const olf=document.querySelector('.ol-filter');if(olf&&S.ol){olf.value=S.ol;filterOutline(S.ol);}
const af=document.querySelector('.addr-find');if(af&&S.find){af.value=S.find;findAddress(S.find);}
const justAdded=!!document.body.dataset.select&&select(document.body.dataset.select,false);
if(justAdded)S.focus=null;
else if(S.module&&!select(S.module,false))S.module=null;
document.querySelectorAll('.mod-panel').forEach(p=>{const f=p.querySelector('.p-filter');const v=S.filters[p.dataset.panel];if(f&&v)f.value=v;
  const sc=S.scopes[p.dataset.panel];if(sc&&sc!=='all')setScope(p,sc);else applyFilter(p);});
if(S.multi.length)showMulti();
if(S.focus){const p=panelOf(S.focus.panel);const el=p&&!p.hidden&&(S.focus.name?rowInput(S.focus.panel,S.focus.name,S.focus.index):p.querySelector('.p-filter'));if(el)el.focus({preventScroll:true});}
if(justAdded){const n=document.querySelector('.node[data-module="'+CSS.escape(document.body.dataset.select)+'"]');if(n)n.scrollIntoView({block:'nearest'});}else window.scrollTo(0,S.scroll||0);
document.addEventListener('change',e=>{const box=e.target.closest('.loader');if(box&&e.target.matches('.img-kind,.img-file,.img-addr')){
  if(e.target.matches('.img-kind')){const a=e.target.closest('tr').querySelector('.img-addr');if(e.target.value==='bin'&&!a.value)a.value=document.body.dataset.defaultAddress;}
  submit(box);}});
document.addEventListener('click',e=>{const t=e.target;const box=t.closest('.loader');
  if(t.matches('.img-browse'))return post({type:'browseImage',module:box.dataset.loader,index:Number(t.closest('tr').dataset.orig)});
  if(t.matches('.img-remove'))return submit(box,t.closest('tr'));
  if(t.matches('.img-add'))return post({type:'addImage',module:box.dataset.loader});
  if(t.matches('.add-loader'))return post({type:'addLoader'});
  if(t.matches('.sym-browse'))return post({type:'browseSymbols'});
  if(t.matches('.sym-clear'))return post({type:'clearSymbols'});
  if(t.closest('input,select,button,label,.loader,.symbols,.mod-panel,.node,.outline,.dtabs,.head,.stats'))return;
  reveal(t);});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&S.route&&!e.target.closest('input,select,textarea')){pinRoute(null);return;}
  const rt=e.target.closest('.routable[data-route-region]');if(rt&&!e.target.closest('a,button')&&(e.key==='Enter'||e.key===' ')){e.preventDefault();pinRoute(specOf(rt));return;}
  const tg=e.target.closest('.sub-toggle');if(tg&&(e.key==='Enter'||e.key===' ')){e.preventDefault();e.stopPropagation();post({type:'toggleSubsystem',module:tg.dataset.module});return;}
  const n=e.target.closest('.node');if(n&&(e.key==='Enter'||e.key===' ')){e.preventDefault();select(n.dataset.module,true);}});
