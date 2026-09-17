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
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {market} from './fixtures.mjs';

/* ------------------------- زمینه‌ی اجرا ------------------------- */
import {boot as harnessBoot, makeStorage, settled, els} from './harness.mjs';

/* کندل ۴ساعته‌ی ساختگی: روند صعودی با دامنه‌ی مشخص تا ATR غیرصفر بدهد و
   «کف پیوت» داشته باشد؛ آخرین کندل یک شکست سقف با فاصله‌ی واقعی می‌سازد. */
function ohlcFixture(id){
  const out=[]; let p=100;
  for(let i=0;i<90;i++){
    const drift=(i<70?0.4:-0.2);
    p+=drift;
    out.push([1700000000000+i*4*3600000, p-0.2, p+1.2, p-1.2, p]);
  }
  p+=6; out.push([1700000000000+90*4*3600000, p-6, p+1, p-7, p]);   // کندل شکست سقف (۶ کندل اخیر)
  return out;
}
function chartFixture(id){
  const prices=[], total_volumes=[]; let p=100;
  for(let i=0;i<168;i++){
    p=p*(1+Math.sin(i/9)*0.002+0.0005);
    const v=1000*(1+((i%24===23)?2.5:0));
    prices.push([1700000000000+i*3600000, Number(p.toFixed(6))]);
    total_volumes.push([1700000000000+i*3600000, v]);
  }
  return {prices, total_volumes};
}
/* پوشش نازک روی زمینه‌ی مشترک: همان امضای قبلی boot(kind, gateCfg, store)
   تا آزمون‌های موجود دست‌نخورده بمانند. پرچم‌های شبکه پس از boot هم قابل
   تغییرند (fetch همان شیء را می‌خواند). */
function boot(kind, gateCfg={}, existingStore=null){
  const network={md:false, deriv:null, fail:false};
  return harnessBoot({
    coins:market(kind), gateCfg, store:existingStore||makeStorage(), network,
    /* شاخص ترس/طمع بخشی از سناریوست: ریسک‌پذیر = طمع، ریسک‌گریز = ترس */
    fng:{data:[{value:kind==='riskon'?'62':'41', value_classification:kind==='riskon'?'Greed':'Fear'}]},
    hooks:{ ohlc:id=>network.md?ohlcFixture(id):[], chart:id=>network.md?chartFixture(id):{prices:[],total_volumes:[]} }
  });
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

/* ------------------------- لایه‌ی داده‌ی غنی‌شده ------------------------- */

test('لایه‌ی داده: در نبود داده‌ی غنی‌شده هیچ میدان تازه‌ای فعال نمی‌شود',async()=>{
  const {api}=boot('riskon');await settled(api);
  const btc=api.state.coins.find(c=>c.id==='bitcoin');
  assert.equal(btc.a.atr,null);
  assert.equal(btc.a.mdQuality,'base');
  assert.equal(btc.a.crowd,null);
  assert.equal(btc.a.fundingAnnual,null);
  /* صف غنی‌سازی پر می‌شود ولی بدون شبکه چیزی کش نمی‌شود */
  assert.ok(api.enrichmentCandidates().length>0,'نامزدهای غنی‌سازی باید وجود داشته باشند');
});

test('مشتقات: فاندینگ داغ + OI صعودی امتیاز خرید را کم می‌کند و دروازه را می‌بندد',async()=>{
  const base=boot('riskon'); await settled(base.api);
  const baseBtc=base.api.state.coins.find(c=>c.id==='bitcoin').a.buyScore;

  const {api,network}=boot('riskon');
  network.deriv=[
    {market:'Binance (Futures)',symbol:'BTCUSDT',index_id:'BTC',contract_type:'perpetual',funding_rate:0.0008,open_interest:5e9,volume_24h:2e9,basis:0.4,spread:0.02},
    {market:'OKX',symbol:'BTC-USDT-SWAP',index_id:'BTC',contract_type:'perpetual',funding_rate:0.0009,open_interest:3e9,volume_24h:1e9,basis:0.5,spread:0.03},
    {market:'Bybit',symbol:'SOLUSDT',index_id:'SOL',contract_type:'perpetual',funding_rate:0.0004,open_interest:4e8,volume_24h:2e8,basis:0.2,spread:0.02}
  ];
  await settled(api);
  await api.enrichCycle();
  const btc=api.state.coins.find(c=>c.id==='bitcoin');
  assert.ok(btc.a.fundingAnnual>50,`فاندینگ سالانه محاسبه نشد: ${btc.a.fundingAnnual}`);
  assert.equal(btc.a.derivVenues,2);
  assert.equal(btc.a.crowd.side,'long');
  assert.equal(btc.a.crowd.level,'hot');
  assert.ok(btc.a.buyScore<baseBtc,`امتیاز خرید باید با ازدحام داغ کم شود (${btc.a.buyScore} در برابر ${baseBtc})`);
  assert.ok(btc.a.ctx.some(x=>String(x.t).includes('ازدحام')),'دلیل ازدحام باید در زمینه‌ی بازار بیاید');
  assert.ok(btc.a.gate.reasons.concat(btc.a.gate.fails||[]).some(r=>String(r).includes('ازدحام')),
    'دروازه باید ازدحام داغ را به‌عنوان مانع ثبت کند');
  assert.notEqual(btc.a.gate.state,'open');
  /* ارزی که فاندینگ متوسط دارد نباید تنبیه شود */
  const sol=api.state.coins.find(c=>c.id==='solana');
  assert.ok(!sol.a.crowd || sol.a.crowd.level!=='hot','ازدحام گرم نباید مثل داغ رفتار کند');
});

test('مشتقات: فاندینگ منفی عمیق در شورت به‌عنوان ریسک اسکوییز دیده می‌شود',async()=>{
  const {api,network}=boot('riskoff');
  network.deriv=[
    {market:'Binance (Futures)',symbol:'SOLUSDT',index_id:'SOL',contract_type:'perpetual',funding_rate:-0.0012,open_interest:4e8,volume_24h:2e8,basis:-0.5,spread:0.02},
    {market:'Bybit',symbol:'SOL-USDT',index_id:'SOL',contract_type:'perpetual',funding_rate:-0.001,open_interest:3e8,volume_24h:1e8,basis:-0.4,spread:0.03}
  ];
  await settled(api);
  await api.enrichCycle();
  const sol=api.state.coins.find(c=>c.id==='solana');
  assert.equal(sol.a.crowd.side,'short');
  assert.equal(sol.a.crowd.level,'hot');
  const plan=sol.a.plans && sol.a.plans.short;
  if(plan && plan.score>=60){
    const text=(plan.reasons||[]).join(' | ');
    assert.ok(/اسکوییز|ازدحام/.test(text)||plan.blocked,`پلن شورت باید ریسک اسکوییز را منعکس کند: ${text}`);
  }
});

test('غنی‌سازی: کندل ۴ساعته ATR و ساختار را فعال می‌کند، سری حجم تأیید حجم می‌آورد',async()=>{
  const {api,network}=boot('riskon');
  network.md=true;
  await settled(api);
  await api.enrichCycle();                                   // فراخوان کندل
  const withOhlc=api.state.coins.filter(c=>c.md && c.md.ohlc);
  assert.ok(withOhlc.length>=1,'هیچ ارزی غنی نشد');
  const c1=withOhlc[0];
  assert.ok(c1.a.atr!=null && c1.a.atr>0,`ATR محاسبه نشد: ${c1.a.atr}`);
  assert.equal(c1.a.mdQuality,'partial');
  assert.ok(Number.isFinite(c1.a.atrStopMult),'حد ضرر باید نسبت به ATR گزارش شود');
  assert.ok(c1.a.stop<c1.a.avgEntry,'حد ضرر باید زیر میانگین ورود بماند');
  api.MarketData.resetBudget();                              // شبیه‌سازی گذر زمان
  await api.enrichCycle();                                   // فراخوان سری حجم (همان ارز یا ارز بعدی)
  const full=api.state.coins.filter(c=>c.md && c.md.ohlc && c.md.series);
  assert.ok(full.length>=1,'سری حجم واکشی نشد');
  const c2=full[0];
  assert.equal(c2.a.mdQuality,'full');
  assert.ok(c2.a.volZ!=null || c2.a.mfi!=null,'میدان‌های حجم‌محور محاسبه نشدند');
  assert.ok(api.mdStatusText().includes('غنی‌شده'),'متن وضعیت داده باید شمارش غنی‌شده‌ها را بگوید');
  /* ارز غنی‌شده باید امتیاز تکنیکال واقعی‌تری داشته باشد: سیگنال‌های تازه ثبت شده‌اند */
  assert.ok(c2.a.signals.some(s=>/Supertrend|ADX|MFI|CMF|شکست|حجم/.test(String(s.t))),
    'سیگنال‌های مبتنی بر داده‌ی غنی‌شده در فهرست نیستند');
});

test('غنی‌شده‌ها: شکست سقف ۲۴ ساعته با تأیید حجم سیگنال خرید می‌سازد',async()=>{
  const {api,network}=boot('riskon');
  network.md=true;
  await settled(api);
  for(let i=0;i<3;i++){ api.MarketData.resetBudget(); await api.enrichCycle(); }
  const brk=api.state.coins.filter(c=>c.md && c.a.brk24 && c.a.brk24.state==='up');
  assert.ok(brk.length>=1,'داده‌ی ساختگی باید حداقل یک شکست سقف بسازد');
  const c=brk[0];
  assert.ok(c.a.volZ!=null,`حجم نسبی برای ارز شکست‌کرده محاسبه نشد (${c.a.volZ})`);
  assert.ok(c.a.signals.some(s=>String(s.t).includes('شکست سقف ۲۴ ساعته')),'سیگنال شکست در فهرست نیست');
});

test('غنی‌سازی: خطای شبکه صف را اشباع نمی‌کند و cool‌دان فعال می‌شود',async()=>{
  const {api,network}=boot('riskon');
  network.md=false;                                          // کندل و سری حجم پاسخ خالی می‌دهند
  await settled(api);
  await api.enrichCycle();
  const q1=api.MarketData.pendingIds();
  assert.ok(q1.length>0,'صف باید پر بماند');
  const failed=q1.filter(id=>api.MarketData.next()===null||true);
  assert.ok(failed.length>0);
  /* پس از سه خطا، ارز از صف برنامه‌ریزی حذف می‌شود */
  const id=q1[0];
  api.MarketData.fail(id); api.MarketData.fail(id); api.MarketData.fail(id);
  api.MarketData.plan([{ id, p:1 }]);
  assert.ok(!api.MarketData.pendingIds().includes(id),'ارز سه‌بار-خطاخورده باید از صف رها شود');
});

/* ------------------------- آزمون‌های رگرسیون بازبینی نهایی ------------------------- */

test('رگرسیون: صف غنی‌سازی قفل نمی‌شود و به همه‌ی نامزدها می‌رسد',async()=>{
  const {api, network}=boot('riskon');
  network.md=true;
  await settled(api);
  const candidates=api.enrichmentCandidates().length;
  assert.ok(candidates>=3,'برای این آزمون به چند نامزد نیاز داریم');
  for(let i=0;i<4*candidates+4;i++){ api.MarketData.resetBudget(); await api.runEnrichment(); }
  const full=api.state.coins.filter(c=>c.md&&c.md.ohlc&&c.md.series).length;
  assert.ok(full>=candidates,`از ${candidates} نامزد فقط ${full} ارز کاملاً غنی شد — صف قفل شده است`);
  assert.equal(api.enrichmentCandidates().length,0,'ارزهای غنی‌شده باید از فهرست نامزدها بیرون بروند');
  assert.equal(api.MarketData.next(),null,'صف پس از کامل شدن کار باید خالی بماند');
});

test('رگرسیون: کش تحلیل داده‌ی غنی‌شده را ذخیره نمی‌کند ولی بارگذاری مجدد آن را برمی‌گرداند',async()=>{
  const network={md:true, deriv:null, fail:false};
  const store=makeStorage();
  const first=harnessBoot({
    coins:market('riskon'), store, network,
    hooks:{ ohlc:id=>ohlcFixture(id), chart:id=>chartFixture(id) }
  });
  await settled(first.api);
  for(let i=0;i<16;i++){ first.api.MarketData.resetBudget(); await first.api.runEnrichment(); }
  const enriched=first.api.state.coins.filter(c=>c.md&&c.md.ohlc).length;
  assert.ok(enriched>=3,`پیش‌نیاز آزمون: چند ارز غنی‌شده لازم است (شد ${enriched})`);
  const payload=store.getItem('cb_cache')||'';
  assert.ok(payload.length>0,'کش تحلیل نوشته نشده است');
  assert.doesNotMatch(payload,/"ohlc"|_mdDerived/,'بلوک داده‌ی غنی‌شده نباید در کش تحلیل تکرار شود');
  assert.doesNotMatch(payload,/"md":/,'بلوک md نباید در کش تحلیل ذخیره شود');
  /* بارگذاری مجدد با همان حافظه: داده باید از کش خودِ لایه‌ی داده بنشیند، بدون فراخوان تازه */
  const second=harnessBoot({
    coins:market('riskon'), store, network:{md:true, deriv:null, fail:false},
    hooks:{ ohlc:id=>ohlcFixture(id), chart:id=>chartFixture(id) }
  });
  await settled(second.api);
  const attached=second.api.state.coins.filter(c=>c.md&&c.md.ohlc).length;
  assert.ok(attached>=enriched,`پس از بارگذاری مجدد فقط ${attached} از ${enriched} ارز غنی برگشت`);
  assert.equal(second.network.hits.ohlc,0,'بارگذاری مجدد نباید کندل تازه واکشی کند');
  assert.equal(second.network.hits.chart,0,'بارگذاری مجدد نباید سری حجم تازه واکشی کند');
  assert.ok(second.api.state.coins.find(c=>c.md&&c.md.ohlc).a.atr>0,'ATR باید از داده‌ی کش‌شده محاسبه شود');
});

test('رگرسیون: نبود ماژول‌های لایه‌ی داده برنامه را نمی‌شکند',async()=>{
  for(const omit of [['market-data.js'],['analytics.js'],['market-data.js','analytics.js']]){
    const {api}=harnessBoot({coins:market('riskon'), omit, store:makeStorage(), network:{md:true}});
    await settled(api);
    await api.enrichCycle();
    api.renderAll();
    const btc=api.state.coins.find(c=>c.id==='bitcoin');
    assert.equal(btc.a.mdQuality,'base',`با حذف ${omit.join('+')} باید تحلیل روی داده‌ی پایه بماند`);
    assert.equal(btc.a.atr,null);
    assert.ok(btc.a.gate&&btc.a.gate.state,'دروازه باید کار کند');
    assert.ok(api.state.coins.length>5,`تحلیل باید ادامه پیدا کند (${api.state.coins.length} ارز)`);
  }
});

/* ------------------------- اجرا ------------------------- */
let pass=0, fail=0;
for(const [name, fn] of results){
  try{ await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch(e){ console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}
console.log(`\n${pass} آزمون موفق، ${fail} آزمون ناموفق (از ${results.length})`);
process.exit(fail?1:0);
