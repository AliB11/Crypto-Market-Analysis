/* =====================================================================
   آزمون لایه‌ی «دروازه‌ی رژیم» (Regime Gateway)
   اجرا:  node tests/gate.test.mjs

   این آزمون app.js واقعی را بدون تغییر در یک زمینه‌ی Node با DOM ساختگی
   اجرا می‌کند و سپس با داده‌ی
   ساختگیِ بازار (سناریوی ریسک‌پذیر و ریسک‌گریز) کل زنجیره‌ی
   analyze → applyMarketContext → دروازه → رتبه‌بندی/هشدار/کارنامه/CSV
   را می‌سنجد. یعنی همان کدی اجرا می‌شود که در مرورگر اجرا می‌شود.
   ===================================================================== */
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {market} from './fixtures.mjs';

/* ------------------------- DOM ساختگی ------------------------- */
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
    // Attributes are stored for real: assertions on aria-*/data-side would be vacuous otherwise.
    _attrs:new Map(),
    setAttribute(k,v){ el._attrs.set(String(k),String(v)); },
    getAttribute:k=>el._attrs.has(String(k))?el._attrs.get(String(k)):null,
    removeAttribute(k){ el._attrs.delete(String(k)); },
    appendChild(c){ el.children.push(c); return c; }, removeChild(){}, focus(){}, click(){},
    toDataURL:()=>'data:,'
  };
  return el;
}
const els=new Map();

function makeStorage(){
  const m=new Map();
  return {getItem:k=>(m.has(k)?m.get(k):null), setItem:(k,v)=>m.set(k,String(v)), removeItem:k=>m.delete(k), clear:()=>m.clear()};
}

/* داده‌ی ساختگی بازار — سری قیمتی ساعتگی ۷ روزه */
/* ------------------------- اجرای اسکریپت واقعی برنامه ------------------------- */
const EXPORTS='state,gate,mon,perf,REGIMES,GATE_STATES,GATE_RULES,GATE_STRICT,bestList,applyMarketContext,'
  +'evalMarketGate,evalCoinGate,gatePermit,gateRank,gateStats,gateBadge,detectEvents,perfCycle,perfOpen,'
  +'exportCSV,renderGate,renderRegime,renderBest,renderList,renderModalInfo,renderCmp,renderAlerts,renderPerf,'
  +'syncGateUI,loadAll,setMon,shorts,shortCycle,updateShortPlans,renderShorts,exportShortCSV,shortCoinFresh,shortOptions,shortFresh,shortFreshKey,refreshModal,tick,pushAlert,marketRows,analyze,computeIndicatorsInWorker,'
  +'renderFNG,fngValue,buildSignalPayload,setSide,sideView,sideCounts,renderDual,renderSideTabs,renderApiPreview,SIGNAL_SCHEMA_VERSION';

function appCode(){
  const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
  return readFileSync(new URL('../short-engine.js',import.meta.url),'utf8')+'\n'+app
    +`\n;globalThis.__api={${EXPORTS}, trd:typeof tradable!=='undefined'?tradable:null};`;
}

function boot(kind, gateCfg={}, existingStore=null){
  const code=appCode();

  const store=existingStore||makeStorage();
  if(gateCfg.mode) store.setItem('cb_gate_v1', JSON.stringify(gateCfg));
  els.clear();

  let csvText=null; const network={fail:false}; const notices=[];
  class Blob{ constructor(parts){ csvText=parts.join(''); } }
  // Stand-in side tabs so tablist wiring and aria state can be asserted for real.
  const sideTabEls=['long','short','both'].map(side=>{
    const b=makeEl('button'); b.dataset.side=side; return b;
  });
  const document={
    querySelector:sel=>{ if(!els.has(sel)) els.set(sel,makeEl()); return els.get(sel); },
    querySelectorAll:sel=>String(sel).includes('side-tab')?sideTabEls:[],
    addEventListener(){}, removeEventListener(){},
    createElement:t=>makeEl(t), body:makeEl('body'), documentElement:makeEl('html')
  };
  const sandbox={
    document, console, Blob, AbortController, URL:{createObjectURL:()=>'blob:stub', revokeObjectURL(){}},
    localStorage:store, setTimeout, clearTimeout, setInterval:()=>0, clearInterval:()=>{},
    requestAnimationFrame:cb=>{ try{ cb(0); }catch(e){} return 0; },
    Notification:class {static permission='granted'; static async requestPermission(){return 'granted';} constructor(title,body){notices.push({title,body});}},
    addEventListener(){}, removeEventListener(){},
    navigator:{userAgent:'node'}, performance:{now:()=>Date.now()},
    fetch:async url=>{
      if(network.fail)throw new Error('test offline');
      const u=String(url);
      if(u.includes('/coins/markets')) return {ok:true, status:200, json:async()=>market(kind)};
      if(u.includes('/global')) return {ok:true, status:200, json:async()=>({data:{
        total_market_cap:{usd:2.5e12}, total_volume:{usd:9e10}, market_cap_change_percentage_24h_usd:1.2,
        market_cap_percentage:{btc:54.1, eth:16.2}}})};
      if(u.includes('alternative.me')) return {ok:true, status:200, json:async()=>({data:[{value:kind==='riskon'?'62':'41', value_classification:'Greed'}]})};
      return {ok:true, status:200, json:async()=>({prices:[]})};
    }
  };
  sandbox.location={hash:'',protocol:'https:'};
  sandbox.history={replaceState(){}};
  sandbox.window=sandbox; sandbox.globalThis=sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, {filename:'index.html'});
  return {api:sandbox.__api, getCsv:()=>csvText, store,network,notices,sandbox,sideTabEls};
}

async function settled(api, tries=200){
  for(let i=0;i<tries;i++){
    if(api.state.coins.length && api.state.regime && api.state.gate) return;
    await new Promise(r=>setTimeout(r,5));
  }
  throw new Error('برنامه با داده‌ی ساختگی راه نیفتاد (state.coins/state.gate خالی ماند)');
}

/* ------------------------- آزمون‌ها ------------------------- */
const results=[];
function test(name, fn){ results.push([name, fn]); }

test('دروازه در بازار ریسک‌پذیر: کلان «باز» و دست‌کم یک ارز مجاز', async ()=>{
  const {api}=boot('riskon'); await settled(api);
  assert.equal(api.state.regime.k, 'riskon', `رژیم محاسبه‌شده: ${api.state.regime.k} (pts=${api.state.regime.pts})`);
  assert.equal(api.state.gate.macro, 'open');
  assert.equal(api.state.gate.state, 'open');
  const open=api.state.coins.filter(c=>c.a.gate && c.a.gate.state==='open');
  assert.ok(open.length>0, 'در بازار ریسک‌پذیر هیچ ارزی مجوز ورود نگرفت');
  open.forEach(c=>assert.ok(c.a.gate.fails.length===0, `${c.id} با وجود نقص مجوز گرفته`));
  const s=api.state.gate.stats;
  assert.equal(s.open+s.watch+s.blocked+s.exempt, s.total, 'جمع آمار دروازه با تعداد کل نمی‌خواند');
  assert.equal(s.exempt, 2, 'استیبل‌کوین و توکن رَپ‌شده باید مستثنا شوند');
});

test('دروازه در بازار ریسک‌گریز: کلان «بسته» و ورودهای بی‌تأیید مسدود', async ()=>{
  const {api}=boot('riskoff'); await settled(api);
  assert.equal(api.state.regime.k, 'riskoff', `رژیم محاسبه‌شده: ${api.state.regime.k} (pts=${api.state.regime.pts})`);
  assert.equal(api.state.gate.macro, 'closed');
  assert.equal(api.state.gate.state, 'blocked');
  const blocked=api.state.coins.filter(c=>c.a.gate && c.a.gate.state==='blocked');
  assert.ok(blocked.length>0, 'در بازار ریزشی هیچ ارزی مسدود نشد');
  blocked.forEach(c=>assert.ok(c.a.gate.reasons.length>0, `${c.id} بدون دلیل مسدود شده`));
  // هر ارز «مجاز» در رژیم بسته باید آستانه‌های سخت همان رژیم را داشته باشد
  api.state.coins.filter(c=>c.a.gate && c.a.gate.state==='open').forEach(c=>{
    const r=api.GATE_RULES.closed;
    assert.ok(c.a.buyScore>=r.score, `${c.id} با امتیاز ${c.a.buyScore} در رژیم بسته مجوز گرفته`);
    assert.ok(c.a.rrNow>=r.rrNow, `${c.id} با R/R ${c.a.rrNow} در رژیم بسته مجوز گرفته`);
    assert.ok(c.id==='bitcoin' || c.a.rs7>=r.rs7, `${c.id} با RS ${c.a.rs7} در رژیم بسته مجوز گرفته`);
  });
});

test('gatePermit: مسدود = بدون مجوز، باز = مجوز، مستثنا = بی‌اثر', async ()=>{
  const {api}=boot('riskoff'); await settled(api);
  const byId=id=>api.state.coins.find(c=>c.id===id);
  const blocked=api.state.coins.find(c=>c.a.gate && c.a.gate.state==='blocked');
  assert.equal(api.gatePermit(blocked,'any'), false);
  assert.equal(api.gatePermit(blocked,'open'), false);
  const usdt=byId('tether');
  assert.equal(usdt.a.gate.exempt, true, 'استیبل‌کوین باید مستثنا باشد');
  assert.equal(api.gatePermit(usdt,'open'), true);
});

test('حالت خاموش: دروازه فقط نمایشی است و هیچ‌چیز فیلتر نمی‌شود', async ()=>{
  const {api}=boot('riskoff',{mode:'off'}); await settled(api);
  assert.equal(api.gate.mode, 'off', 'حالت ذخیره‌شده در localStorage خوانده نشد');
  assert.equal(api.state.gate.state, 'open', 'در حالت خاموش وضعیت مؤثر باید «باز» باشد');
  assert.equal(api.state.gate.macro, 'closed', 'وضعیت کلان واقعی باید همچنان گزارش شود');
  const blocked=api.state.coins.filter(c=>c.a.gate && c.a.gate.state==='blocked');
  assert.ok(blocked.length>0, 'وضعیت ارزی باید حتی در حالت خاموش محاسبه و نمایش داده شود');
  blocked.forEach(c=>assert.equal(api.gatePermit(c,'open'), true, 'در حالت خاموش هیچ ارزی نباید فیلتر شود'));
});

test('حالت سخت‌گیرانه: آستانه‌ها بالاتر و مجوزها کمتر', async ()=>{
  const auto=boot('riskon'); await settled(auto.api);
  const strict=boot('riskon',{mode:'strict'}); await settled(strict.api);
  const bAuto=auto.api.state.coins.find(c=>c.id==='solana').a;
  const bStr=strict.api.state.coins.find(c=>c.id==='solana').a;
  assert.ok(bStr.gate.need.score >= bAuto.gate.need.score + 6,
    `آستانه‌ی امتیاز در حالت سخت‌گیرانه بالاتر نرفت (${bAuto.gate.need.score} → ${bStr.gate.need.score})`);
  const nAuto=auto.api.state.coins.filter(c=>c.a.gate.state==='open').length;
  const nStr=strict.api.state.coins.filter(c=>c.a.gate.state==='open').length;
  assert.ok(nStr<=nAuto, `حالت سخت‌گیرانه مجوز بیشتری داد (${nAuto} → ${nStr})`);
  assert.equal(strict.api.state.gate.macro, 'watch', 'در حالت سخت‌گیرانه بازار «باز» باید به «انتخابی» تبدیل شود');
});

test('رتبه‌بندی بهترین‌ها: مسدودها ته جدول و فیلتر «فقط مجازها» کار می‌کند', async ()=>{
  const {api}=boot('riskon'); await settled(api);
  const all=api.bestList(25);
  // نکته: آرایه‌های برگشتی از زمینه‌ی vm هم‌نوع آرایه‌ی Node نیستند، پس کپی محلی می‌گیریم
  const ranks=[...all.map(c=>api.gateRank(c))];
  assert.deepEqual(ranks, [...ranks].sort((x,y)=>x-y), 'مسدودها پیش از مجازها در جدول آمده‌اند');
  assert.equal(ranks[0], 0, 'اولین ردیف جدول باید یک ارز مجاز باشد');
  assert.deepEqual([...all.map(c=>c.a.gate.state)].slice(0,1), ['open']);
  api.gate.onlyApproved=true;
  const only=api.bestList(25);
  assert.ok(only.length>0 && only.length<=all.length);
  only.forEach(c=>assert.equal(c.a.gate.state,'open', `${c.id} بدون مجوز در فهرست «فقط مجازها» است`));
  api.gate.onlyApproved=false;
});

test('هشدارها: سیگنال خرید مسدود به هشدار «دروازه بسته» تبدیل می‌شود', async ()=>{
  const {api}=boot('riskoff'); await settled(api);
  const c=api.state.coins.find(x=>x.a.gate && x.a.gate.state==='blocked' && x.id!=='bitcoin');
  api.mon.alerts.length=0;
  api.mon.filter='all';
  api.mon.prev={};
  api.state.coins.forEach(x=>{ api.mon.prev[x.id]={cat:'hold',score:50,buyScore:50,buyState:'wait',
    rsi:50,cross:null,macdCross:null,price:x.current_price,tp1:x.current_price*1.2,stop:x.current_price*0.8}; });
  c.a.buyState='now';                       // ورود به محدوده خرید در بازار بسته
  api.detectEvents();
  const buy=api.mon.alerts.filter(a=>a.kind==='buy' && a.id===c.id);
  const risk=api.mon.alerts.filter(a=>a.kind==='risk' && a.id===c.id && /دروازه/.test(a.text));
  assert.equal(buy.length, 0, 'برای ارز مسدود هشدار تشویق به خرید ثبت شد');
  assert.equal(risk.length, 1, `هشدار مسدودسازی دروازه ثبت نشد — رویدادها: ${api.mon.alerts.map(a=>a.text).join(' | ')}`);
});

test('هشدار تغییر وضعیت دروازه ثبت می‌شود', async ()=>{
  const {api}=boot('riskon'); await settled(api);
  api.mon.alerts.length=0;
  api.mon.prevGate='blocked';
  api.detectEvents();
  const flip=api.mon.alerts.filter(a=>/دروازه‌ی رژیم/.test(a.text) && /باز شد/.test(a.text));
  assert.equal(flip.length, 1, 'رویداد «باز شدن دروازه» ثبت نشد');
});

test('کارنامه‌ی عملکرد: فقط سیگنال دارای مجوز ثبت می‌شود', async ()=>{
  const {api}=boot('riskoff'); await settled(api);
  api.perf.rec.length=0;
  const blocked=api.state.coins.find(c=>c.a.gate.state==='blocked' && c.a.ok && api.trd(c));
  blocked.a.cat='sbuy'; blocked.a.buyScore=85; blocked.a.tp1=blocked.current_price*1.05; blocked.a.stop=blocked.current_price*0.95;
  api.perfCycle();
  assert.equal(api.perf.rec.some(r=>r.id===blocked.id), false, 'سیگنال مسدود در کارنامه ثبت شد');
  api.gate.mode='off';
  api.perfCycle();
  assert.equal(api.perf.rec.some(r=>r.id===blocked.id), true, 'در حالت خاموش باید سیگنال ثبت شود');
});

test('خروجی CSV: ستون دروازه با تعداد ستون‌های سرستون می‌خواند', async ()=>{
  const {api, getCsv}=boot('riskon'); await settled(api);
  api.exportCSV();
  const csv=getCsv();
  assert.ok(csv && csv.length>0, 'exportCSV چیزی تولید نکرد');
  const lines=csv.replace(/^\uFEFF/,'').split('\r\n');
  const head=lines[0].split(',');
  assert.ok(head.includes('دروازه‌ی رژیم'), 'ستون دروازه در سرستون CSV نیست');
  assert.ok(head.includes('دلیل دروازه'), 'ستون دلیل دروازه در CSV نیست');
  const split=s=>{ const out=[]; let cur='',q=false;
    for(const ch of s){ if(ch==='"'){q=!q;continue;} if(ch===','&&!q){out.push(cur);cur='';continue;} cur+=ch; }
    out.push(cur); return out; };
  const rows=lines.slice(1).filter(Boolean).map(split);
  assert.ok(rows.length>0);
  rows.forEach(r=>assert.equal(r.length, head.length, `تعداد ستون ردیف (${r.length}) با سرستون (${head.length}) نمی‌خواند`));
  const gi=head.indexOf('دروازه‌ی رژیم');
  rows.forEach(r=>assert.ok(['باز','انتخابی','بسته','مستثنا'].includes(r[gi]), `مقدار نامعتبر دروازه در CSV: ${r[gi]}`));
});

test('رندر: پنل دروازه، کارت‌ها، جدول‌ها و مودال بدون خطا و با محتوای درست', async ()=>{
  const {api}=boot('riskon'); await settled(api);
  api.renderRegime(); api.renderBest(); api.renderList(); api.renderCmp(); api.renderAlerts(); api.renderPerf();
  const box=document_el('gateBox');
  assert.match(box.innerHTML, /دروازه‌ی رژیم/, 'پنل دروازه رندر نشد');
  assert.match(box.innerHTML, /مجاز:/, 'آمار دروازه در پنل نیست');
  const tbl=document_el('bestTblWrap');
  assert.match(tbl.innerHTML, /<th[^>]*>دروازه<\/th>/, 'ستون دروازه در جدول بهترین‌ها نیست');
  assert.match(document_el('grid').innerHTML, /gbadge/, 'نشان دروازه روی کارت ارزها نیست');
  api.state.view='table'; api.renderList();
  assert.match(document_el('listSec').innerHTML, /<th[^>]*>دروازه<\/th>/, 'ستون دروازه در جدول ارزها نیست');
  const sol=api.state.coins.find(c=>c.id==='solana');
  api.renderModalInfo(sol);
  assert.match(document_el('mbuy').innerHTML, /دروازه‌ی رژیم/, 'جعبه‌ی دروازه در مودال نیست');
  assert.match(document_el('mbuy').innerHTML, /آستانه‌های فعلی دروازه/, 'آستانه‌های دروازه در مودال نیست');
  api.syncGateUI();
  assert.equal(document_el('gateMode').value, 'auto', 'حالت دروازه در کنترل تنظیمات همگام نشد');
});

function document_el(sel){ return els.get('#'+sel) || null; }


/* Integration tests run the real app and the independent short engine together. */
async function shortFixture(){
  const booted=boot('riskoff');await settled(booted.api);
  const api=booted.api,c=api.state.coins.find(c=>c.id==='solana');
  Object.assign(c,{current_price:99});
  Object.assign(c.a,{ok:true,kind:'asset',prices:[],sma20:100,sma50:110,ema20:101,support:95,resist:101,low7:90,dvol:1,slopeH:-0.2,macd:-2,sig:-1,hist:-1,histPrev:-0.5,rsi:45,rsiPrev:46,rs7:-2,volRatio:0.1,ch24:-2,buyScore:0,buyState:'wait'});
  api.state.coins=[c,api.state.coins.find(x=>x.id==='bitcoin')];api.state.regime={k:'riskoff',fng:40,btcAvailable:true};
  api.state.liveData=true;api.state.dataAt=Date.now();api.perf.rec=[];api.shorts.records=[];api.shorts.enabled=true;
  return {...booted,c};
}
test('شورت: انتظار، ورود تأییدشده، سطوح ثابت، هدف و جلوگیری از تکرار',async()=>{
 const {api,c}=await shortFixture();api.shortCycle();
 assert.equal(api.shorts.records.length,1);const r=api.shorts.records[0];assert.equal(r.status,'waiting');assert.equal(r.fill,undefined);
 const stop=r.stop;c.current_price=100;api.shortCycle();assert.equal(r.status,'active');assert.equal(r.fill,100);
 api.shortCycle();assert.equal(api.shorts.records.length,1);
 c.a.resist=120;c.current_price=94;api.shortCycle();assert.equal(r.status,'win');assert.equal(r.ret,6);assert.equal(r.stop,stop);
 assert.ok(api.mon.alerts.some(a=>a.kind==='short'));
 assert.equal(api.shorts.records.length,1);
});
test('شورت: آفلاین، تاریخ منبع کهنه و تعارض لانگ مانع ورود می‌شوند',async()=>{
 const {api,c}=await shortFixture();api.state.liveData=false;api.shortCycle();assert.equal(api.shorts.records.length,0);
 api.state.liveData=true;c.last_updated=new Date(Date.now()-3600000).toISOString();api.shortCycle();assert.equal(api.shorts.records.length,0);
 c.last_updated=new Date().toISOString();api.perf.rec=[{id:c.id,open:true}];api.shortCycle();assert.equal(api.shorts.records.length,0);
 api.perf.rec=[];api.shortCycle();assert.equal(api.shorts.records.length,1);
 c.current_price=100;api.shortCycle();c.a.tp1=110;c.a.stop=90;api.perfOpen(c);assert.equal(api.perf.rec.length,0);
});
test('شورت: پیش‌فرض خاموش، CSV جهت‌دار و نمایش مودال',async()=>{
 const initial=boot('riskoff');await settled(initial.api);assert.equal(initial.api.shorts.enabled,false);
 const {api,c,getCsv,store}=await shortFixture();api.shortCycle();api.renderShorts();api.renderModalInfo(c);
 assert.match(document_el('mshort').innerHTML,/شورت/);assert.match(document_el('shortPanel').innerHTML,/منتظر پولبک/);
 api.exportShortCSV();assert.match(getCsv(),/"side","version"/);assert.match(getCsv(),/short-pullback-v1/);
 assert.equal(JSON.parse(store.getItem('cb_short_v1')).records[0].side,'short');
});


test('بازبینی: ورود منتظر بر اساس سطوح ثابت، نه اهداف جابه‌جاشده',async()=>{
 const {api,c}=await shortFixture();api.shortCycle();const r=api.shorts.records[0];
 c.current_price=100;c.a.support=90;c.a.low7=90;api.shortCycle();
 assert.equal(c.a.plans.short.valid,false);assert.equal(r.status,'active');assert.equal(r.tp1,95);assert.equal(r.stop,101.2525);
});
test('بازبینی: ثبت خرید قوی نیز با شورت تعارض دارد، حتی زیر امتیاز ۷۸',async()=>{
 const {api,c}=await shortFixture();c.a.cat='sbuy';c.a.buyScore=70;c.a.tp1=110;c.a.stop=90;c.a.gate={state:'open'};
 api.shortCycle();assert.equal(api.shorts.records.length,0);
});
test('بازبینی: خطای شبکه، کش و زمان منبع ناقص هر دو کارنامه را متوقف می‌کند',async()=>{
 const {api,c,network}=await shortFixture();c.current_price=100;api.shortCycle();
 api.perf.rec=[{id:c.id,open:true,p0:100,tp1:101,stop:99,t0:Date.now()-8*86400000}];
 const before=JSON.stringify(api.shorts.records),longBefore=JSON.stringify(api.perf.rec);
 network.fail=true;await api.loadAll();assert.equal(api.state.loading,false);assert.equal(api.state.liveData,false);
 assert.equal(JSON.stringify(api.shorts.records),before);assert.equal(JSON.stringify(api.perf.rec),longBefore);
 delete c.last_updated;assert.equal(api.shortCoinFresh(c),false);
 c.last_updated='invalid';assert.equal(api.shortCoinFresh(c),false);
});
test('بازبینی: فیلتر فقط شورت اعلان مخفی لانگ تولید نمی‌کند',async()=>{
 const {api,c,notices}=await shortFixture();api.mon.notif=true;api.mon.sound=false;api.mon.filter='short';
 api.pushAlert(c,'buy','long','#fff',true);assert.equal(notices.length,0);
 api.pushAlert(c,'short','short','#fff',true);assert.equal(notices.length,1);
 api.mon.filter='buy';api.pushAlert(c,'short','short','#fff',true);assert.equal(notices.length,1);
});
test('بازبینی: زمان منبع مستقل از زمان واکشی و داده BTC کنترل می‌شود',async()=>{
 const {api,c}=await shortFixture();api.state.regime.btcAvailable=false;api.shortCycle();assert.equal(api.shorts.records.length,0);
 api.state.regime.btcAvailable=true;const before=api.shortFreshKey();c.last_updated=new Date(Date.now()-3600000).toISOString();
 assert.notEqual(api.shortFreshKey(),before);api.tick();assert.equal(c.a.plans.short.state,'blocked');
 assert.ok(c.a.plans.short.gate.reasons.some(r=>r.includes('تازه')));
 c.last_updated=new Date().toISOString();api.state.coins.find(x=>x.id==='bitcoin').last_updated=new Date(Date.now()-3600000).toISOString();
 api.updateShortPlans();assert.ok(c.a.plans.short.gate.reasons.some(r=>r.includes('بیت‌کوین')));
});
test('بازبینی: داده خراب حذف می‌شود و شکست ساخت Worker به مسیر اصلی برمی‌گردد',async()=>{
 const {api,c,sandbox}=await shortFixture();
 assert.equal(api.marketRows([null,{}, {...c,current_price:Infinity}]).length,0);
 assert.equal(api.marketRows([{...c,sparkline_in_7d:{price:{}}}])[0].sparkline_in_7d.price.length,0);
 sandbox.Worker=class {constructor(){throw new Error('Worker disabled');}};
 assert.equal(await api.computeIndicatorsInWorker([c]),null);
});
test('بازبینی: برابری اندیکاتورها در Worker و مسیر اصلی با ورودی آلوده',async()=>{
 const {api}=boot('riskon');await settled(api);
 let posted;const w=vm.createContext({self:{postMessage:v=>posted=v}});
 vm.runInContext(readFileSync(new URL('../indicator-worker.js',import.meta.url),'utf8'),w);
 const c=market('riskon')[1];c.sparkline_in_7d.price.splice(20,0,null,NaN,-1,0,'100');
 w.self.onmessage({data:{id:1,series:[c.sparkline_in_7d.price]}});
 const main=api.analyze(c),worker=api.analyze(c,posted.result[0]);
 for(const key of ['rsi','hist','sma20','sma50','buyScore','entry','stop'])assert.equal(main[key],worker[key],key);
});

/* ------------------------- تب‌ها، شاخص ترس و طمع، خروجی JSON ------------------------- */

test('باگ رفع‌شده: شاخص ترس و طمع واقعاً رندر می‌شود و روی placeholder نمی‌ماند',async()=>{
  const {api,sandbox}=boot('riskon');await settled(api);
  // پیش از رفع باگ، renderFNG هرگز صدا زده نمی‌شد و این مقدارها دست‌نخورده می‌ماندند.
  const val=sandbox.document.querySelector('#fngVal').textContent;
  const txt=sandbox.document.querySelector('#fngTxt').textContent;
  assert.equal(val,62,`مقدار شاخص رندر نشد (${val})`);
  assert.equal(txt,'طمع',`طبقه‌بندی شاخص رندر نشد (${txt})`);
  assert.ok(sandbox.document.querySelector('#fngHint').textContent.length>0,'راهنمای شاخص خالی ماند');
  assert.equal(api.state.regime.fng,62,'مقدار شاخص به رژیم بازار نرسید');
});

test('شاخص ترس و طمع: مقدار نامعتبر به NaN تبدیل نمی‌شود',async()=>{
  const {api,sandbox}=boot('riskon');await settled(api);
  for(const bad of [{value:'abc'},{value:null},{value:'150'},{value:'-3'},null]){
    api.state.fng=bad;
    assert.equal(api.fngValue(),null,`مقدار نامعتبر ${JSON.stringify(bad)} باید null شود`);
    api.renderFNG();
    const shown=sandbox.document.querySelector('#fngVal').textContent;
    assert.equal(shown,'—',`مقدار نامعتبر روی گیج نشت کرد: ${shown}`);
    assert.ok(!String(shown).includes('NaN'),'NaN در رابط ظاهر شد');
  }
  api.state.fng={value:'0'};assert.equal(api.fngValue(),0,'صفر یک مقدار معتبر است');
  api.state.fng={value:100};assert.equal(api.fngValue(),100,'۱۰۰ یک مقدار معتبر است');
});

test('باگ رفع‌شده: فیلتر هشدار «فقط شورت» پس از بارگذاری مجدد حفظ می‌شود',async()=>{
  const {api,store}=boot('riskon');await settled(api);
  api.mon.filter='short';
  store.setItem('cb_mon_v1',JSON.stringify({on:true,iv:90,sound:false,notif:false,filter:'short'}));
  // بارگذاری دوباره‌ی برنامه با همان حافظه
  const reloaded=boot('riskon',{},store);
  assert.equal(reloaded.api.mon.filter,'short','انتخاب «فقط شورت» پس از رفرش دور ریخته شد');
});

test('تب‌ها: پیش‌فرض لانگ، تعویض درست، و ماندگاری در حافظه',async()=>{
  const {api,store,sandbox}=boot('riskon');await settled(api);
  assert.equal(api.sideView.cur,'long','تب پیش‌فرض باید لانگ باشد');
  assert.equal(sandbox.document.querySelector('main').getAttribute('data-side'),'long');
  api.setSide('short');
  assert.equal(api.sideView.cur,'short');
  assert.equal(store.getItem('cb_side_v1'),'short','تب انتخابی ذخیره نشد');
  api.setSide('garbage');
  assert.equal(api.sideView.cur,'long','مقدار نامعتبر باید به لانگ برگردد');
});

test('تب‌ها: موتور مستقل از تب فعال کار می‌کند (کارنامه‌ی تب پنهان متوقف نمی‌شود)',async()=>{
  const {api}=boot('riskoff');await settled(api);
  api.setSide('long'); // شورت پنهان است
  const c=api.state.coins.find(c=>c.id!=='bitcoin'&&api.trd(c));
  api.shorts.enabled=true;
  api.updateShortPlans();
  const before=JSON.stringify(api.state.coins.map(c=>c.a.plans&&c.a.plans.short&&c.a.plans.short.state));
  api.shortCycle();   // باید بدون توجه به تب فعال اجرا شود
  const after=JSON.stringify(api.state.coins.map(c=>c.a.plans&&c.a.plans.short&&c.a.plans.short.state));
  assert.ok(before.length>2&&after.length>2,'پلن‌های شورت در تب پنهان محاسبه نشدند');
  assert.ok(c.a.plans.short,'پلن شورت در تب پنهان ساخته نشد');
  // کلید تازگی باید به‌روز شده باشد، وگرنه tick هر ثانیه کل بازار را از نو می‌سازد
  assert.equal(api.state.shortFreshDisplayed,api.shortFreshKey(),'کلید تازگی به‌روز نشد — نشت CPU در tick');
});

test('خروجی JSON: ساختار نسخه‌دار با تمام پارامترهای ورود و اهداف',async()=>{
  const {api}=boot('riskon');await settled(api);
  const p=api.buildSignalPayload({side:'both',filter:'approved'});
  assert.equal(p.schemaVersion,api.SIGNAL_SCHEMA_VERSION);
  assert.equal(p.source,'coingecko');
  assert.ok(p.dataAsOf,'dataAsOf باید برای مصرف ماشینی وجود داشته باشد');
  assert.equal(typeof p.dataFresh,'boolean');
  assert.equal(p.count,p.signals.length,'شمارش با تعداد سیگنال‌ها نمی‌خواند');
  assert.ok(p.market.regime,'زمینه‌ی بازار در خروجی نیست');
  assert.equal(p.market.fng,62,'شاخص ترس و طمع در خروجی نیست');
  assert.ok(p.disclaimer.length>10,'سلب مسئولیت در payload نیست');
  const long=p.signals.find(s=>s.side==='long');
  assert.ok(long,'هیچ سیگنال لانگی در بازار ریسک‌پذیر تولید نشد');
  assert.equal(long.strategyVersion,'legacy-long-v1');
  for(const k of ['best','low','high','avg']) assert.ok(Number.isFinite(long.entry[k]),`entry.${k} عددی نیست`);
  for(const k of ['stop','tp1','tp2']) assert.ok(Number.isFinite(long.exit[k]),`exit.${k} عددی نیست`);
  assert.ok(long.exit.stop<long.entry.best,'حد ضرر باید زیر ورود باشد');
  assert.ok(long.exit.tp1>long.entry.best&&long.exit.tp2>long.exit.tp1,'ترتیب اهداف نادرست است');
  assert.equal(long.entry.ladder.length,3,'پلکان سه‌مرحله‌ای در خروجی نیست');
  assert.equal(long.entry.ladder.reduce((s,x)=>s+x.weight,0),100,'مجموع وزن پله‌ها ۱۰۰ نیست');
  assert.ok(long.disclaimer.length>10,'سلب مسئولیت در سیگنال نیست');
  // خروجی باید سریال‌پذیر و بدون NaN/undefined باشد
  const text=JSON.stringify(p);
  assert.ok(!text.includes('NaN')&&!text.includes('undefined'),'خروجی JSON مقدار نامعتبر دارد');
  assert.deepEqual(JSON.parse(text).count,p.count,'خروجی قابل بازخوانی نیست');
});

test('خروجی JSON: فیلتر جهت و «فقط مجاز» واقعاً اعمال می‌شود',async()=>{
  const {api}=boot('riskon');await settled(api);
  assert.ok(api.buildSignalPayload({side:'long',filter:'approved'}).signals.every(s=>s.side==='long'));
  assert.ok(api.buildSignalPayload({side:'short',filter:'all'}).signals.every(s=>s.side==='short'));
  const approved=api.buildSignalPayload({side:'long',filter:'approved'});
  const all=api.buildSignalPayload({side:'long',filter:'all'});
  assert.ok(all.count>=approved.count,'فیلتر «همه» نباید کمتر از «فقط مجاز» باشد');
  approved.signals.forEach(s=>assert.equal(s.gate.state,'open',`${s.id} بدون مجوز در خروجی «فقط مجاز» آمد`));
  // استیبل‌کوین و رَپ‌شده هرگز نباید در خروجی ماشینی باشند
  all.signals.forEach(s=>assert.ok(!['tether','usd-coin','wrapped-bitcoin'].includes(s.id),`${s.id} باید مستثنا باشد`));
});

test('خروجی JSON در بازار ریزشی: شورت‌ها با نسخه‌ی مستقل و هندسه‌ی معتبر',async()=>{
  const {api}=boot('riskoff');await settled(api);
  const p=api.buildSignalPayload({side:'short',filter:'all'});
  p.signals.forEach(s=>{
    assert.equal(s.side,'short');
    assert.equal(s.strategyVersion,'short-pullback-v1','نسخه‌ی استراتژی شورت نادرست است');
    if(s.valid){
      assert.ok(s.exit.stop>s.entry.best,'در شورت حد ضرر باید بالای ورود باشد');
      assert.ok(s.exit.tp1<s.entry.best&&s.exit.tp2<s.exit.tp1,'ترتیب اهداف شورت نادرست است');
    }
  });
});

/* ------------------------- اجرا ------------------------- */
let pass=0, fail=0;
for(const [name, fn] of results){
  try{ await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch(e){ console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}
console.log(`\n${pass} آزمون موفق، ${fail} آزمون ناموفق (از ${results.length})`);
process.exit(fail?1:0);
