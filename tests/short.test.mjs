import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const ctx=vm.createContext({});
vm.runInContext(readFileSync(new URL('../short-engine.js',import.meta.url),'utf8'),ctx);
const E=ctx.ShortEngine;
const regime={k:'riskoff',fng:40};
const opts={fresh:true,mode:'auto'};
const coin=()=>({id:'test',current_price:100,a:{ok:true,kind:'asset',prices:[],sma20:100,sma50:110,ema20:101,support:95,resist:101,low7:90,dvol:1,slopeH:-0.2,macd:-2,sig:-1,hist:-1,histPrev:-0.5,rsi:45,rsiPrev:46,rs7:-2,volRatio:0.1,ch24:-2}});
const plan=(c=coin(),r=regime,o=opts)=>E.plan(c,r,o);
test('bearish pullback produces independent ready short and valid geometry',()=>{
 const c=coin(),before=JSON.stringify(c),p=plan(c);
 assert.equal(p.state,'ready');assert.equal(p.side,'short');assert.equal(JSON.stringify(c),before);
 assert.ok(p.stop>p.entry&&p.entry>p.tp1&&p.tp1>p.tp2&&p.tp2>0);
 assert.ok(p.rr>=1.5);assert.equal(p.rr,p.rrNow);
});
test('below the zone means waiting, not a market fill',()=>{const c=coin();c.current_price=99;assert.equal(plan(c).state,'waiting');});
test('stale data and conflicts cannot bypass the off mode',()=>{
 assert.equal(plan(coin(),regime,{fresh:false,mode:'off'}).state,'blocked');
 assert.equal(plan(coin(),regime,{...opts,mode:'off',conflict:true}).state,'blocked');
});
test('bullish, unknown and extreme fear regimes block fresh shorts',()=>{
 for(const r of [{k:'riskon',fng:50},null,{k:'riskoff',fng:10}])assert.equal(plan(coin(),r).state,'blocked');
});
test('strict thresholds are stricter, off disables only macro checks',()=>{
 const strict=plan(coin(),regime,{...opts,mode:'strict'});assert.equal(strict.gate.need.rr,2);assert.equal(strict.gate.need.score,78);
 assert.equal(plan(coin(),{k:'riskoff',fng:10},{...opts,mode:'off'}).state,'ready');
});
test('oversold, bullish divergence, crash and illiquidity are rejected',()=>{
 for(const patch of [{rsi:20},{diverg:'bull'},{diverg:'hBull'},{ch24:-20},{volRatio:0}]){
 const c=coin();Object.assign(c.a,patch);assert.equal(plan(c,regime,{...opts,mode:'off'}).state,'blocked');}
});
test('missing second support does not fabricate a target',()=>{const c=coin();c.a.low7=95;const p=plan(c);assert.equal(p.valid,false);assert.equal(p.state,'blocked');});
test('invalid data and excluded assets cannot create a plan',()=>{
 for(const v of [0,-1,NaN,Infinity]){const c=coin();c.current_price=v;assert.equal(plan(c).valid,false);}
 for(const kind of ['stable','wrapped']){const c=coin();c.a.kind=kind;assert.equal(plan(c).valid,false);}
});
test('sizing is positive, bounded by capital, no leverage',()=>{
 const p=plan(),v=E.position(p,{cap:1000,pct:2});assert.ok(v.units>0);assert.ok(v.notional<=1000);assert.ok(v.loss<=20);
 assert.equal(E.position(p,{cap:1000,pct:-1}),null);assert.equal(E.position({...p,stop:90},{cap:1000,pct:2}),null);
});
const record=()=>({...plan(),status:'active',fill:100,opened:1000,created:1000,last:100,peak:100,trough:100});
test('falling prices win, rising prices stop out; return signs and excursions',()=>{
 const win=record();assert.equal(E.advance(win,94,2000),'win');assert.equal(win.ret,6);assert.equal(win.mfe,6);assert.equal(win.mae,0);
 const loss=record();assert.equal(E.advance(loss,103,2000),'loss');assert.equal(loss.ret,-3);assert.equal(loss.mae,-3);
 assert.equal(E.advance(win,200,3000),null);assert.equal(win.ret,6);
});
test('waiting cannot win or fill without fresh confirmation, expires after 24h',()=>{
 const r={...record(),status:'waiting'};assert.equal(E.advance(r,100,2000),null);assert.equal(r.status,'waiting');
 assert.equal(E.advance(r,100,1000+86400000),'cancelled');assert.equal(r.ret,undefined);
 const broken={...record(),status:'waiting'};assert.equal(E.advance(broken,94,2000),'cancelled');
});
test('seven-day expiry and invalid observations',()=>{
 const r=record();assert.equal(E.advance(r,NaN,2000),null);assert.equal(E.advance(r,99,1000+7*86400000),'expired');assert.equal(r.ret,1);
});
test('randomized geometry remains finite and consistent',()=>{
 for(let i=1;i<=300;i++){
 const c=coin(),scale=i/7; for(const key of ['sma20','sma50','ema20','support','resist','low7'])c.a[key]*=scale;c.current_price*=scale;
 const p=plan(c);assert.ok(p.valid);assert.ok(p.stop>p.entry&&p.entry>p.tp1&&p.tp1>p.tp2);
 for(const k of ['rr','rrNow','riskPct','score'])assert.ok(Number.isFinite(p[k]));
 }
});

test('review: frozen levels remain usable when newly computed supports merge',()=>{
 const c=coin(),old=plan(c);c.a.support=90;c.a.low7=90;
 assert.equal(plan(c).valid,false);
 const p=plan(c,regime,{...opts,levels:old});assert.equal(p.state,'ready');assert.equal(p.tp1,95);
 // v2: قیمت بالاتر از باند = اجرای بهترِ شورت، پس «ready» باقی می‌ماند و باطل نمی‌شود
 c.current_price=100.3;const p2=plan(c,regime,{...opts,levels:old});
 assert.equal(p2.state,'ready');assert.equal(p2.betterFill,true);
 // ولی چسبیدن به حد ضرر یا عبور از آن همچنان مسدود است
 c.current_price=101.3;assert.equal(plan(c,regime,{...opts,levels:old}).state,'blocked');
 c.current_price=100.75;assert.match(plan(c,regime,{...opts,levels:old}).gate.reasons.join('|'),/خیلی نزدیک/);
});
test('v2: rally INTO the zone must not cancel the setup on re-validation',()=>{
 // قیمت در حال پولبک به ناحیه است: RSI و هیستو بالا می‌روند — ذاتِ یک rebound
 const atEntry=plan(coin());                                   // ستاپ معتبر در قیمت ۱۰۰
 const c=coin();c.current_price=100.15;
 Object.assign(c.a,{rsi:51,rsiPrev:48,hist:-0.9,histPrev:-1.1}); // مومنتومِ لحظه‌ای صعودی
 const fresh=plan(c);
 assert.notEqual(fresh.state,'ready');
 assert.match(fresh.gate.reasons.join('|'),/کاهش مومنتوم/);     // ساختِ تازه: شرط زمان ساخت همچنان پابرجاست
 const rv=plan(c,regime,{...opts,levels:atEntry});
 assert.equal(rv.state,'ready','اعتبارسنجیِ ورود نباید با شرطِ زمانِ ساخت مسدود شود');
 assert.ok(rv.score>=atEntry.score,'کف امتیازِ زمان ساخت اعمال نشد');
});
test('v2: strong momentum re-acceleration kills the waiting short (pullback became breakout)',()=>{
 const atEntry=plan(coin());
 const c=coin();c.current_price=100;Object.assign(c.a,{macd:1.5,sig:0.5,hist:0.9,histPrev:0.4,rsi:68,rsiPrev:64});
 assert.equal(plan(c,regime,{...opts,levels:atEntry}).state,'blocked');
 assert.match(plan(c,regime,{...opts,levels:atEntry}).gate.reasons.join('|'),/شکست قدرتمند/);
});
test('v2: legacy v1 records restore; unknown versions still rejected',()=>{
 const rec={...plan(coin()),side:'short',version:'short-pullback-v1',id:'x',sym:'X',status:'waiting',created:1000};
 assert.equal(E.restoreRecords([rec]).length,1,'رکوردهای v1 باید پس از ارتقا خوانده شوند');
 assert.equal(E.restoreRecords([{...rec,version:'short-pullback-v0'}]).length,0);
});
test('review: NaN RSI/history/relative strength and missing BTC never pass',()=>{
 for(const k of ['rsi','rsiPrev','hist','histPrev','rs7','ch24']){const c=coin();c.a[k]=NaN;assert.equal(plan(c).state,'blocked');}
 assert.equal(plan(coin(),regime,{...opts,mode:'off',benchmarkFresh:false}).state,'blocked');
 assert.equal(plan(coin(),{k:'unknown'}).state,'blocked');
});
test('review: record restore rejects corruption without losing valid neighbors',()=>{
 const good={...record(),id:'test',sym:'TST'};
 const restored=E.restoreRecords([null,{},good,{...good,status:'evil'},{...good,stop:1},{...good,fill:null}]);
 assert.equal(restored.length,1);assert.equal(restored[0].id,'test');
 assert.equal(E.restoreRecords({}).length,0);
});
test('review: full live capacity keeps no closed records; never drops live trades',()=>{
 const live=Array.from({length:300},(_,i)=>({...record(),id:String(i),sym:'TST'}));
 const closed={...record(),status:'cancelled',closed:2000,id:'closed',sym:'TST'};
 assert.equal(E.keepRecords([closed,...live]).length,300);
 assert.equal(E.keepRecords([...live,{...live[0],id:'extra'},closed]).length,301);
 assert.equal(E.restoreRecords(live).length,300);
});
test('review: position refuses invalid targets and overflow',()=>{
 assert.equal(E.position({...plan(),tp1:NaN},{cap:1000,pct:2}),null);
 assert.equal(E.position({...plan(),tp1:110},{cap:1000,pct:2}),null);
 assert.equal(E.position({...plan(),entry:Number.MIN_VALUE,stop:Number.MIN_VALUE*2,tp1:Number.MIN_VALUE},{cap:1e308,pct:100}),null);
});
test('🔻 continuation lane: momoDown بدون مقاومت، ورود بازار با بافر نوسانی',()=>{
  const mk=down=>{const c=coin();c.current_price=102;c.a.resist=99;c.a.ema20=101;if(down)c.a.momoDown=true;return c;};
  const p=plan(mk(true));
  assert.equal(p.valid,true,p.gate.reasons.join('|'));
  assert.equal(p.state,'ready'); assert.equal(p.lane,'continuation');
  assert.equal(p.entry,102); assert.ok(p.stop>102);
  assert.ok(p.rr>=1.5&&p.rrNow>0&&p.tp1===95&&p.tp2===90);
  const b=plan(mk(false));
  assert.equal(b.state,'blocked');
  assert.ok(b.gate.reasons.some(t=>t.includes('مقاومت')),'بدون پرچم، نبود مقاومت همان دلیل رد سابق است');
});
test('🪜 ladder: ۵۰٪ روی TP1، حد ضرر سر‌به‌سر، بازده ترکیبی در سه سناریو',()=>{
  const mk=()=>({...plan(),status:'active',fill:100,entry:100,tp1:95,tp2:90,stop:101.25,opened:0,created:0,last:100,peak:100,trough:100,ladder:true});
  const a=mk();
  assert.equal(E.advance(a,95,1000),'half');
  assert.equal(a.half,'tp1'); assert.equal(a.realized1,2.5); assert.equal(a.stop,100); assert.equal(a.halfPx,95);
  assert.equal(E.advance(a,100.1,2000),'be');
  assert.ok(Math.abs(a.ret-2.45)<1e-9,`ret=${a.ret}`);
  const b=mk(); E.advance(b,95,1000);
  assert.equal(E.advance(b,90,2000),'win');
  assert.ok(Math.abs(b.ret-7.5)<1e-9,`ret=${b.ret}`); assert.equal(b.blended,true);
  const c=mk(); E.advance(c,95,1000);
  assert.equal(E.advance(c,94,7*86400000+1),'expired');
  assert.ok(Math.abs(c.ret-(2.5+(6/100*100)*0.5))<1e-9,`ret=${c.ret}`);
});
test('🪜 بدون پرچم پلکانی، برخورد به TP1 همان بردِ کامل v2 است',()=>{
  const r={...plan(),status:'active',fill:100,entry:100,tp1:95,tp2:90,stop:101.25,opened:0,created:0,last:100,peak:100,trough:100};
  assert.equal(E.advance(r,94,2000),'win');
  assert.equal(r.ret,6); assert.equal(r.half,undefined);
});
test('💸 خالص: کارمزد دو‌طرف کسر و فاندینگ (به نفع شورت) اضافه می‌شود؛ فاندینگ منفی جریمه است',()=>{
  const mk=fa=>({...plan(),status:'active',fill:100,entry:100,tp1:95,tp2:90,stop:101.25,opened:0,created:0,
    last:100,peak:100,trough:100,feePct:0.1,fundingAnnual:fa});
  const a=mk(36.5); assert.equal(E.advance(a,94,86400000),'win');
  assert.equal(a.costPct,0.2);
  assert.ok(Math.abs(a.fundingPnlPct-36.5/365)<1e-12);
  assert.ok(Math.abs(a.retNet-(6-0.2+36.5*1/365))<1e-9,`net=${a.retNet}`);
  const b=mk(-36.5); assert.equal(E.advance(b,94,86400000),'win');
  assert.ok(Math.abs(b.retNet-(6-0.2-36.5/365))<1e-9,`net=${b.retNet}`);
  const longHold=mk(36.5); longHold.opened=0; assert.equal(E.advance(longHold,99.5,8*86400000),'expired');
  assert.ok(Math.abs(longHold.fundingPnlPct-36.5*7/365)<1e-12,'فاندینگ روی ۷ روز سقف می‌خورد');
});
test('🗄️ restore: وضعیت‌های be/half پذیرفته و هندسه نیمه‌بسته سخت بررسی می‌شود',()=>{
  const now=Date.now();
  const base={id:'x',sym:'X',side:'short',version:'short-pullback-v2',created:now-7200e3,opened:now-7200e3,
    entry:100,entryLo:99.8,entryHi:100.2,fill:100,peak:100,trough:95,last:96,tp1:95,tp2:90,half:'tp1',halfPx:95,halfT:now-3600e3,realized1:2.5};
  const ok={...base,status:'be',stop:100,closed:now,exit:100.1,ret:2.45,mfe:5,mae:0};
  assert.equal(E.restoreRecords([ok]).length,1);
  assert.equal(E.restoreRecords([{...ok,stop:103}]).length,0,'حدِ یک رکورد نیمه‌بسته نمی‌تواند بالای entryHi باشد');
  assert.equal(E.restoreRecords([{...ok,halfPx:undefined}]).length,0,'نیمه‌بسته بدون halfPx معتبر نیست');
  const live={...base,status:'half',stop:100};
  assert.equal(E.restoreRecords([live]).length,1,'نیمه‌بسته‌ی در جریان باید زنده بماند');
});
