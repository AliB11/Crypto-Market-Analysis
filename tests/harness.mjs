/* =====================================================================
   tests/harness.mjs — زمینه‌ی مشترک اجرای app.js در Node

   چرا؟ هم آزمون دروازه (gate.test.mjs) و هم آزمون تاریخی (backtest.mjs)
   باید «همان کدی را اجرا کنند که در مرورگر اجرا می‌شود»، اما با داده‌ی
   ساختگی و بدون شبکه. این فایل DOM ساختگی، fetch جعلی و جداسازی کد را
   یک‌جا می‌سازد تا هیچ آزمونی مجبور نباشد منطق را دوباره پیاده کند
   (پیاده‌سازی دوباره‌ی منطق = آزمونِ نسخه‌ی بدلی، نه محصول).
   ===================================================================== */
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

export const MODULES=['analytics.js','market-data.js','short-engine.js','app.js'];

export const DEFAULT_EXPORTS='state,gate,mon,perf,REGIMES,GATE_STATES,GATE_RULES,GATE_STRICT,bestList,applyMarketContext,'
  +'evalMarketGate,evalCoinGate,gatePermit,gateRank,gateStats,gateBadge,detectEvents,perfCycle,perfOpen,renderAll,'
  +'exportCSV,renderGate,renderRegime,renderBest,renderList,renderModalInfo,renderCmp,renderAlerts,renderPerf,'
  +'syncGateUI,loadAll,setMon,shorts,shortCycle,updateShortPlans,renderShorts,exportShortCSV,shortCoinFresh,shortOptions,shortFresh,shortFreshKey,refreshModal,tick,pushAlert,marketRows,analyze,computeIndicatorsInWorker,'
  +'renderFNG,fngValue,buildSignalPayload,setSide,sideView,sideCounts,renderDual,renderSideTabs,renderApiPreview,SIGNAL_SCHEMA_VERSION,'
  +'deriveMarketData,enrichmentCandidates,refreshDerivatives,runEnrichment,attachCachedMarketData,mdStatusText,enrichCycle,updateMdStatus,'
  +'Analytics,MarketData,CROWD,ShortEngine,openReplay,replayControl,stopReplay,renderReplayBar,findReplayRec,replayKindFor,regimeCommit,fnv1a,gapSectionHtml,openModal';

function ctx2d(){
  const noop=()=>{};
  return {clearRect:noop,beginPath:noop,arc:noop,stroke:noop,moveTo:noop,lineTo:noop,closePath:noop,
    fill:noop,fillRect:noop,fillText:noop,setLineDash:noop,save:noop,restore:noop,clip:noop,rect:noop,
    measureText:()=>({width:10}),createLinearGradient:()=>({addColorStop:noop}),scale:noop,translate:noop,
    quadraticCurveTo:noop,bezierCurveTo:noop,drawImage:noop,getImageData:()=>({data:new Uint8ClampedArray(4)}),
    putImageData:noop,font:'',textAlign:'',fillStyle:'',strokeStyle:'',lineWidth:1,lineCap:'',lineJoin:'',globalAlpha:1};
}
function makeEl(tag='div'){
  const el={
    tagName:String(tag).toUpperCase(), children:[], dataset:{}, _cls:new Set(),
    style:{setProperty(){},removeProperty(){}}, textContent:'', innerHTML:'', value:'', checked:true,
    href:'', download:'', clientWidth:320, clientHeight:90, width:320, height:100,
    classList:{ add:(...c)=>c.forEach(x=>el._cls.add(x)), remove:(...c)=>c.forEach(x=>el._cls.delete(x)),
      contains:c=>el._cls.has(c),
      toggle:(c,f)=>{ const on=f===undefined?!el._cls.has(c):!!f; on?el._cls.add(c):el._cls.delete(c); return on; } },
    querySelector:sel=>els.get(sel)||els.set(sel,makeEl()).get(sel),
    querySelectorAll:()=>[], getContext:()=>ctx2d(),
    getBoundingClientRect:()=>({left:0,top:0,right:320,bottom:90,width:320,height:90}),
    addEventListener(){}, removeEventListener(){},
    /* Attributes are stored for real: assertions on aria-* and data-side would be vacuous otherwise. */
    _attrs:new Map(),
    setAttribute(k,v){ el._attrs.set(String(k),String(v)); },
    getAttribute:k=>el._attrs.has(String(k))?el._attrs.get(String(k)):null,
    removeAttribute(k){ el._attrs.delete(String(k)); },
    appendChild(c){ el.children.push(c); return c; }, removeChild(){}, focus(){}, click(){},
    toDataURL:()=>'data:,'
  };
  return el;
}
export const els=new Map();

export function makeStorage(){
  const m=new Map();
  return {getItem:k=>(m.has(k)?m.get(k):null), setItem:(k,v)=>m.set(k,String(v)), removeItem:k=>m.delete(k), clear:()=>m.clear(), _raw:m};
}

/* omit: حذف عمدی یک ماژول (مثلاً وقتی script مرورگر بارگذاری نشده) تا رفتار
   «تخریب نرم» واقعاً آزمون شود، نه اینکه فقط در کد ادعا شود. */
/* هر نام با گارد typeof صادر می‌شود تا حذف عمدی یک ماژول (سناریوی
   «اسکریپت بارگذاری نشد») خودِ هارنس را نشکند و آزمون واقعاً اجرا شود. */
function appCode(exportsList, omit=[]){
  const read=f=>readFileSync(new URL('../'+f,import.meta.url),'utf8');
  const names=exportsList.split(',').map(x=>x.trim()).filter(Boolean)
    .map(n=>`${n}:typeof ${n}!=='undefined'?${n}:null`);
  return MODULES.filter(f=>!omit.includes(f)).map(read).join('\n')
    +`\n;globalThis.__api={${names.join(',')}, trd:typeof tradable!=='undefined'?tradable:null};`;
}

/* boot — یک نسخه‌ی کامل از برنامه در زمینه‌ی Node بالا می‌آورد.
   coins/global/fng: پاسخ‌های جعلی بازار.  network: کلیدهای اختیاری برای
   مشتقات (deriv)، کندل (ohlc)، سری حجم (chart) و خطای عمومی (fail).
   hooks: توابعی که به ازای شناسه، پاسخ تاریخی برمی‌گردانند (برای بک‌تست). */
export function boot(opts={}){
  const {coins=[], global={data:{ total_market_cap:{usd:2.5e12}, total_volume:{usd:9e10},
      market_cap_change_percentage_24h_usd:1.2, market_cap_percentage:{btc:54.1, eth:16.2} }},
    fng={data:[{value:'52', value_classification:'Neutral'}]}, network={}, gateCfg={}, store=makeStorage(),
    exportsList=DEFAULT_EXPORTS, hooks={}, omit=[]} = opts;
  const code=appCode(exportsList, omit);
  if(gateCfg.mode) store.setItem('cb_gate_v1', JSON.stringify(gateCfg));
  els.clear();

  let csvText=null; const notices=[];
  class Blob{ constructor(parts){ csvText=parts.join(''); } }
  const sideTabEls=['long','short','both'].map(side=>{
    const b=makeEl('button'); b.dataset.side=side; return b;
  });
  const document={
    querySelector:sel=>{ if(!els.has(sel)) els.set(sel,makeEl()); return els.get(sel); },
    querySelectorAll:sel=>String(sel).includes('side-tab')?sideTabEls:[],
    addEventListener(){}, removeEventListener(){},
    createElement:t=>makeEl(t), body:makeEl('body'), documentElement:makeEl('html')
  };
  /* همان شیء شبکه‌ای که به آزمون برگردانده می‌شود، دست‌نخورده استفاده می‌شود؛
     وگرنه تست‌ها پرچم‌ها را روی یک نسخه عوض می‌کنند و fetch چیز دیگری می‌بیند. */
  const net=network || {};
  if(net.fail===undefined) net.fail=false;
  if(net.md===undefined) net.md=false;
  if(net.deriv===undefined) net.deriv=null;
  /* شمارنده‌ی فراخوان‌ها: بدون آن نمی‌توان ثابت کرد «بارگذاری مجدد هیچ
     فراخوان تازه‌ای نمی‌زند» یا «بودجه رعایت شده است». */
  net.hits=net.hits||{markets:0, global:0, fng:0, deriv:0, ohlc:0, chart:0, other:0};
  const sandbox={
    document, console, Blob, AbortController, URL:{createObjectURL:()=>'blob:stub', revokeObjectURL(){}},
    localStorage:store, setTimeout, clearTimeout, setInterval:()=>0, clearInterval:()=>{},
    requestAnimationFrame:cb=>{ try{ cb(0); }catch(e){} return 0; },
    Notification:class {static permission='granted'; static async requestPermission(){return 'granted';} constructor(title,body){notices.push({title,body});}},
    addEventListener(){}, removeEventListener(){},
    navigator:{userAgent:'node'}, performance:{now:()=>Date.now()},
    fetch:async url=>{
      if(net.fail)throw new Error('test offline');
      const u=String(url);
      if(u.includes('/derivatives')){ net.hits.deriv++; return {ok:true, status:200, json:async()=>net.deriv||[]}; }
      const ohlc=u.match(/\/coins\/([^/?]+)\/ohlc/);
      if(ohlc){ net.hits.ohlc++; return {ok:true, status:200, json:async()=>hooks.ohlc?hooks.ohlc(decodeURIComponent(ohlc[1])):[]}; }
      const chart=u.match(/\/coins\/([^/?]+)\/market_chart/);
      if(chart){ net.hits.chart++; return {ok:true, status:200, json:async()=>hooks.chart?hooks.chart(decodeURIComponent(chart[1])):{prices:[],total_volumes:[]}}; }
      if(u.includes('/coins/markets')){ net.hits.markets++; return {ok:true, status:200, json:async()=>coins}; }
      if(u.includes('/global')){ net.hits.global++; return {ok:true, status:200, json:async()=>global}; }
      if(u.includes('alternative.me')){ net.hits.fng++; return {ok:true, status:200, json:async()=>fng}; }
      net.hits.other++;
      return {ok:true, status:200, json:async()=>({prices:[]})};
    }
  };
  sandbox.location={hash:'',protocol:'https:'};
  sandbox.history={replaceState(){}};
  sandbox.window=sandbox; sandbox.globalThis=sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, {filename:'index.html'});
  return {api:sandbox.__api, getCsv:()=>csvText, store, network:net, notices, sandbox, sideTabEls};
}

/* settled — منتظر می‌ماند تا برنامه داده را تحلیل کرده باشد */
export async function settled(api, tries=400){
  for(let i=0;i<tries;i++){
    if(api.state.coins.length && api.state.regime && api.state.gate) return;
    await new Promise(r=>setTimeout(r,2));
  }
  throw new Error('برنامه با داده‌ی ساختگی راه نیفتاد (state.coins/state.gate خالی ماند)');
}

/* کندل ۴ساعته‌ی ساختگی با تایم‌استمپ واقعی؛ برای آزمون‌های غنی‌سازی */
export function ohlcFixture(id, hours=30, t0=1700000000000){
  const out=[]; let p=100, s=id.length+7;
  const rnd=()=>{ s=(s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; };
  const step=4*3600000, n=Math.floor(hours/4);
  for(let i=0;i<n;i++){
    p*= 1+(rnd()-0.5)*0.01+0.0004;
    out.push([t0+i*step, p-0.2, p+1.2, p-1.2, p]);
  }
  return out;
}
export function chartFixture(id, hours=168, t0=1700000000000){
  const prices=[], total_volumes=[]; let p=100, s=id.length+13;
  const rnd=()=>{ s=(s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; };
  for(let i=0;i<hours;i++){
    p*= 1+(rnd()-0.5)*0.006;
    prices.push([t0+i*3600000, Number(p.toFixed(6))]);
    total_volumes.push([t0+i*3600000, 1000*(1+((i%24===23)?1.5:0))]);
  }
  return {prices, total_volumes};
}
