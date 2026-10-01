/* =====================================================================
   آزمون‌های «تحکیم» — قفلِ رفعِ نقص‌هایی که در بررسی ۳۶۰ درجه پیدا شد
   اجرا:  node tests/hardening.test.mjs

   هر آزمون دقیقاً یک بازگشتِ با_known را می‌بندد: نقصی که برطرف شده و
   اگر کسی دوباره آن را وارد کند، همین‌جا می‌شکند.
   ===================================================================== */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {boot as harnessBoot, makeStorage, settled, els} from './harness.mjs';
import {market} from './fixtures.mjs';

const appSrc = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const DAY = 864e5, HOUR = 3600e3;
const wait = ms => new Promise(r=>setTimeout(r, ms));

function start(o={}){
  const store = o.store || makeStorage();
  if(o.seed) Object.entries(o.seed).forEach(([k,v])=>store.setItem(k, v));
  const res = harnessBoot({
    coins:o.coins || market(o.kind||'riskon'), store, network:o.network||{},
    global:o.global, fng:o.fng || {data:[{value:'62', value_classification:'Greed'}]},
    hooks:{ ohlc:()=>[], chart:()=>({prices:[],total_volumes:[]}) }, omit:o.omit||[]
  });
  return res;
}
const results=[];
function test(name, fn){ results.push([name, fn]); }

/* ---------- ۱) طبقه‌بندی دارایی: نمادِ پایه نباید «رَپ‌شده» بخورد ---------- */
test('TAO و نمادهای پایه دارایی‌اند؛ wBTC/stETH/‌Hype استیک‌شده می‌مانند', async ()=>{
  const {api} = start();
  await settled(api); await wait(40);
  const kind = (symbol, name) => api.assetKind({symbol, name, id:symbol, current_price:100,
    sparkline_in_7d:{price:[100,101]}, market_cap:1e9});
  assert.equal(kind('tao','Bittensor'), 'asset', 'TAO نماد پایه است، نه رَپ‌شده');
  assert.equal(kind('hype','Hyperliquid'), 'asset', 'HYPE — تله‌ی قدیمی: «be» داخل hype بود');
  assert.equal(kind('btc','Bitcoin'), 'asset');
  assert.equal(kind('eth','Ethereum'), 'asset');
  assert.equal(kind('sol','Solana'), 'asset');
  assert.equal(kind('avax','Avalanche'), 'asset');
  assert.equal(kind('wbtc','Wrapped Bitcoin'), 'wrapped');
  assert.equal(kind('wtao','Wrapped Bittensor'), 'wrapped', 'باید با نام چک شود، نه فقط نماد');
  assert.equal(kind('sttao','Staked Bittensor'), 'wrapped');
  assert.equal(kind('weth','WETH'), 'wrapped');
  assert.equal(kind('steth','Lido Staked Ether'), 'wrapped');
  assert.equal(kind('wbnb','Wrapped BNB'), 'wrapped');
  assert.equal(kind('cbbtc','Coinbase Wrapped BTC'), 'wrapped');
  assert.equal(kind('beth','Beatcoin'), 'wrapped');
  assert.equal(kind('msol','Marinade Staked Sol'), 'wrapped');

  /* TAO باید در دروازه و رتبه‌بندی بماند، و رَپ‌شده مستثنا */
  const coins = market('riskon').map(c=>c.id==='solana' ? {...c, symbol:'tao', name:'Bittensor', id:'bittensor'} : c);
  const b2 = start({coins}); await settled(b2.api); await wait(40);
  const tao = b2.api.state.coins.find(c=>c.id==='bittensor');
  assert.ok(tao, 'بیتننسور از فهرست حذف نشود');
  assert.equal(tao.a.kind, 'asset');
  assert.notEqual(tao.a.gate.state, 'exempt', 'دارایی پایه از دروازه مستثنا نمی‌شود');
  assert.ok(b2.api.bestList(25).some(c=>c.id==='bittensor'), 'TAO باید در رتبه‌بندی باشد');
  const w = b2.api.state.coins.find(c=>c.id==='wrapped-steth');
  assert.equal(w.a.kind, 'wrapped');
  assert.equal(w.a.gate.state, 'exempt', 'رَپ‌شده مستثنا است');
  assert.ok(!b2.api.bestList(25).some(c=>c.id==='wrapped-steth'), 'رَپ‌شده در رتبه‌بندی نیست');
});

/* ---------- ۲) globalTrend: آرگومان دوم «ساعت» است نه timestamp ---------- */
test('روند سلطه با پنجره‌ی ۲۴ ساعته خوانده می‌شود، نه «قدیمی‌ترین نمونه»', async ()=>{
  const now = Date.now();
  const hist = [
    {t: now - 90*HOUR, btcDom:53.5, mcap:2.0e12, vol:9e10, ch24:0},     // دامنه‌ی پایین‌تر، بازار کوچک‌تر
    {t: now - 30*HOUR, btcDom:56.0, mcap:2.4e12, vol:9e10, ch24:0}      // ۳۰ ساعت پیش: دامنه‌ی بالاتر
  ];
  const b = start({seed:{'cbmd:hist': JSON.stringify(hist)}});
  await settled(b.api); await wait(60);
  assert.ok(b.api.state.globalTrend, 'روند باید ساخته شود');
  assert.ok(b.api.state.globalTrend.spanHours >= 24 && b.api.state.globalTrend.spanHours <= 40,
    `پنجره باید نزدیک ۲۴ ساعت باشد، نه ۹۰: ${b.api.state.globalTrend.spanHours}`);
  assert.ok(b.api.state.regime.why.some(w=>/چرخش به نفع آلت‌ها/.test(w)),
    'شرط «دامنه رو به کاهش + بازار رو به رشد» باید در دلایل باشد: ' + b.api.state.regime.why.join(' | '));
});

/* ---------- ۳) کارنامه‌ی لانگ: پرشدن ظرفیت، معامله‌ی باز را حذف نکند ---------- */
test('ظرفیت کارنامه با حذف رکورد باز پر نمی‌شود', ()=>{
  const b = start(); const {api} = b;
  const open = Array.from({length:320}, (_,i)=>({id:'open'+i, sym:'O', side:'long', open:true, created:Date.now(), entry:1, stop:0.9, tp1:1.1, last:1}));
  api.perf.rec = open.slice();
  assert.equal(api.perfTrim(), 320, 'رکوردهای باز هیچ‌وقت حذف نمی‌شوند');
  api.perfSave();
  const back = JSON.parse(b.store.getItem('cb_perf_v1'));
  assert.equal(back.length, 320, 'ذخیره هم نباید بازها را کم کند');
  /* وقتی همه بسته‌اند، همان ظرفیت ۳۰۰ تایی رعایت می‌شود */
  api.perf.rec = Array.from({length:320}, (_,i)=>({id:'c'+i, sym:'C', side:'long', open:false, created:Date.now(), ret:1}));
  assert.equal(api.perfTrim(), 300);
  assert.equal(api.perf.rec[api.perf.rec.length-1].id, 'c319', 'تازه‌ترین‌ها می‌مانند');
});

/* ---------- ۴) CSV: نام/نماد شروع‌شده با = + @ - اجرا نشود ---------- */
test('CSV اصلی هم مثل CSV شورت در برابر تزریق فرمول خنثی می‌شود', async ()=>{
  const coins = market('riskon').map(c=>c.id==='chainlink'
    ? {...c, name:'=HYPERLINK("http://x")', symbol:'@evil', id:'evil'} : c);
  const b = start({coins}); await settled(b.api); await wait(40);
  b.api.exportCSV();
  const csv = b.getCsv();
  assert.ok(csv, 'CSV ساخته نشد');
  const row = csv.split('\r\n').find(l=>l.includes('HYPERLINK'));
  assert.ok(row, 'ردیف ارز مخرب در CSV نیست');
  assert.ok(/'=HYPERLINK/.test(row), 'سلول باید با آپاستروف خنثی شود: ' + row.slice(0,60));
  assert.ok(/'@EVIL/.test(row), 'نماد هم خنثی شود: ' + row.slice(0,60));
});

/* ---------- ۵) صدا: یک AudioContext مشترک، نه یکی به‌ازای هر اعلان ---------- */
test('اعلان‌های پشت‌سرهم source جدیدِ AudioContext نمی‌سازند', async ()=>{
  const b = start(); await settled(b.api); await wait(40);
  let created = 0, resumed = 0;
  b.sandbox.AudioContext = class{
    constructor(){ created++; this.state = 'suspended'; this.destination = {}; this.currentTime = 0; }
    resume(){ resumed++; return Promise.resolve(); }
    createOscillator(){ return {connect(){}, start(){}, stop(){}, frequency:{value:0, setValueAtTime(){}, exponentialRampToValueAtTime(){}}}; }
    createGain(){ return {connect(){}, gain:{value:0, setValueAtTime(){}, exponentialRampToValueAtTime(){}}}; }
  };
  b.api.mon.sound = true;
  for(let i=0;i<7;i++) b.api.beep();
  assert.equal(created, 1, `ساخت context به‌ازای هر اعلان برمی‌گردد (${created} بار)`);
  assert.ok(resumed >= 1, 'context معلق باید resume شود وگرنه بی‌صداست');
});

/* ---------- ۶) رندر: حتی یک NaN/undefined در رابط راه ندارد ---------- */
test('ارز با داده‌ی ناکافی: نه NaN در جدول اندیکاتور، نه undefined در باند', async ()=>{
  const coins = market('riskon').map(c=>c.id==='cardano' ? {...c, sparkline_in_7d:{price:[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20]}, price_change_percentage_7d_in_currency:undefined} : c);
  const b = start({coins}); await settled(b.api); await wait(60);
  const bad = b.api.state.coins.find(c=>c.a.ok===false);
  assert.ok(bad, 'سناریو باید ارزی با تحلیل ناکافی بسازد');
  b.api.openModal(bad.id);
  ['mkv','msig','mbuy','mmkt','mshort','mhead','mpred'].forEach(sel=>{
    const html = els.get('#'+sel)?.innerHTML || '';
    assert.doesNotMatch(html, /NaN|undefined/, `نشت ${sel}: ` + (html.match(/.{0,40}(NaN|undefined).{0,20}/)||[''])[0]);
  });
  assert.ok(/—/.test(els.get('#mkv').innerHTML), 'به‌جای عددِ نبود، خط تیره باید باشد');
});

test('MACD کوچک به شکل 1e-8 نمایش داده نمی‌شود', ()=>{
  const b = start();
  const f = b.api.fmtTiny;
  assert.equal(f(1.23e-8), '1.23×10^-8');
  assert.equal(f(-4.5e-9), '-4.50×10^-9');
  assert.equal(f(0), '0');
  assert.equal(f(12.345), '12.35');
  assert.equal(f(0.00123456), '0.00123456');
  assert.equal(f(null), '—');
  assert.equal(f(NaN), '—');
  assert.equal(f(undefined), '—');
  assert.doesNotMatch(f(1e-8), /e[-+]/, 'نمایش علمی خام نباید بماند');
});

test('sparkline با یک نقطه نمی‌شکند و بی‌نقطه هیچ نمی‌کشد', ()=>{
  const b = start();
  const drawn = [];
  const cv = {clientWidth:300, clientHeight:60, width:0, height:0,
    getContext:()=>({scale(){}, beginPath(){}, moveTo(x,y){drawn.push([x,y]);}, lineTo(x,y){drawn.push([x,y]);}, stroke(){}, clearRect(){}, fillRect(){}, fill(){}, closePath(){}, setLineDash(){}, createLinearGradient:()=>({addColorStop(){}}), fillStyle:'', strokeStyle:'', lineWidth:1})};
  b.api.sparkline(cv, [], '#fff');
  assert.equal(drawn.length, 0, 'بدون نقطه نباید چیزی رسم شود');
  b.api.sparkline(cv, [5], '#fff');
  assert.equal(drawn.length, 0, 'با یک نقطه خط نمی‌کشیم (تقسیم بر صفر)');
});

/* ---------- ۷) نمای کلی با پاسخ ناقص /global ---------- */
test('پاسخ ناقص /global کل رندر را با استثنا نمی‌خواباند', async ()=>{
  const b = start({global:{data:{ market_cap_percentage:{} }}});
  await settled(b.api); await wait(60);
  assert.equal(els.get('#s-mcap').textContent, '—');
  assert.equal(els.get('#s-vol').textContent, '—');
  assert.equal(els.get('#s-dom').textContent, '—');
  assert.ok(b.api.state.coins.length, 'با وجود نقصِ /global، بازار باید تحلیل شود');
});

/* ---------- ۸) کلید مرتب‌سازیِ بیات ---------- */
test('کلید مرتب‌سازی ناشناخته (میراث نسخه‌ی قبل) فهرست را بهم نمی‌ریزد', async ()=>{
  const b = start({seed:{cb_sort:'mcap'}}); await settled(b.api); await wait(40);
  assert.equal(b.api.state.sort, 'mcap', 'مقدار ذخیره‌شده باید همان بماند (بی‌اعتباری در مصرف رفع می‌شود)');
  const l = b.api.filtered();
  for(let i=1;i<l.length;i++) assert.ok(l[i-1].a.buyScore >= l[i].a.buyScore,
    `بدون مرتب‌سازِ معتبر باید به «امتیاز خرید» برگردد: ${l[i-1].a.buyScore} < ${l[i].a.buyScore}`);
});

/* ---------- ۹) چیپِ غلط املایی «ازدحام لاگ» ---------- */
test('برچسب ازدحام درست نوشته می‌شود و در شکافِ مجوز هم نمایش داده می‌شود', async ()=>{
  assert.doesNotMatch(appSrc, /ازدحام لاگ/, 'غلط املایی برگشته است');
  const b = start(); await settled(b.api); await wait(40);
  const c = b.api.state.coins.find(x=>x.a.ok && x.a.gate && !x.a.gate.exempt);
  c.a.gate.gap.crowd = 1; c.a.gate.need = c.a.gate.need || {score:60, rrNow:1, rs7:0, states:['now']};
  c.a.gate.state = 'blocked';
  const html = b.api.gapSectionHtml([c]);
  assert.ok(/ازدحام لانگ/.test(html), 'چیپ در بخش شکاف نیست: ' + html.slice(0,120));
});

/* ---------- ۱۰) ارجاع به فیلدِ ناموجود در خلاصه‌ی خروجی ---------- */
test('خلاصه‌ی خروجی JSON از فیلدِ موجود (dataAsOf) ساعت را می‌خواند', async ()=>{
  assert.doesNotMatch(appSrc, /payload\.dataAt/, 'ارجاع به فیلدِ ناموجود برگشته است');
  const b = start(); await settled(b.api); await wait(40);
  const p = b.api.buildSignalPayload({side:'long', filter:'all'});
  assert.ok(p.dataAsOf, 'dataAsOf باید پر باشد');
  b.api.renderApiPreview();
  assert.ok(!/NaN|undefined|Invalid/.test(els.get('#apiSummary').innerHTML), els.get('#apiSummary').innerHTML.slice(0,160));
});

/* ---------- ۱۱) حافظه: هیچ نوشتنی بدون گارد نیست ---------- */
test('حافظه‌ی پر/مسدود برنامه را نمی‌شکند و تاریخچه بی‌حد رشد نمی‌کند', async ()=>{
  const b = start(); await settled(b.api); await wait(60);
  /* بدترین حالت: localStorage روی هر نوشتن پرتاب کند */
  const boom = ()=>{ throw new Error('QuotaExceededError'); };
  b.store.setItem = boom; b.store.removeItem = boom;
  assert.doesNotThrow(()=>b.api.perfSave(), 'کارنامه نباید با حافظه‌ی خراب بسوزد');
  b.api.mon.prev['ghost-coin'] = {price:1, cat:'buy'};
  assert.ok('ghost-coin' in b.api.mon.prev);
  await b.api.loadAll(false);
  await wait(60);
  assert.ok(!('ghost-coin' in b.api.mon.prev), 'مقایسه‌گرِ ارزِ حذف‌شده باید پاک شود');
  els.get('#clearAl').onclick();
});

/* ---------- ۱۲) شناسه‌ی ارز در HTML باید escape شود ---------- */
test('شناسه‌ی ارز فرار می‌کند؛ تزریق در هیچ بخشی از رابط نمی‌شوند', async ()=>{
  const weird = 'a"><img src=x onerror=alert(1)>';
  const coins = market('riskon').map(c=>c.id==='cardano' ? {...c, id:weird} : c);
  const b = start({coins}); await settled(b.api); await wait(60);
  const c = b.api.state.coins.find(x=>x.id===weird);
  assert.ok(c, 'ارز باید در فهرست باشد');
  try{ await b.api.openModal(weird); }catch(e){ assert.fail('باز کردن مودال با شناسه‌ی غیرمعمول نباید بترکد: ' + e.message); }
  for(const [sel, el] of els){
    if(!el || typeof el.innerHTML !== 'string' || !el.innerHTML) continue;
    assert.ok(!el.innerHTML.includes('<img src=x onerror'), `تزریق در ${sel}`);
  }
});

/* ---------- ۱۳) اعلان مرورگر: اجازه‌ی پس‌گرفته‌شده ---------- */
test('اعلان فقط وقتی ساخته می‌شود که مرورگر هنوز اجازه داده باشد', async ()=>{
  assert.match(appSrc, /mon\.notif && typeof Notification!=='undefined' && Notification\.permission!=='granted'/,
    'بازبینی اجازه در بوت حذف شده است');
  const b = start(); await settled(b.api); await wait(60);
  let sent = 0;
  b.sandbox.Notification = class{ constructor(){ sent++; } static permission='denied'; };
  b.api.mon.notif = true;                       // سوییچِ ذخیره‌شده از نسخه‌ی قبل
  const c = b.api.state.coins.find(x=>x.a.ok);
  b.api.pushAlert(c, 'buy', 'تست', '#fff', true);
  assert.equal(sent, 0, 'با permission=denied نباید Notification ساخته شود');
  b.sandbox.Notification.permission = 'granted';
  b.api.pushAlert(c, 'buy', 'تست ۲', '#fff', true);
  assert.ok(sent >= 1, 'با اجازه‌ی معتبر باید اعلان برود');
});

/* ---------- ۱۴) شرط مرده در اتصال داده‌ی کش‌شده ---------- */
test('فیلتر نوع دارایی در اتصال کش، از خود داده خوانده می‌شود', async ()=>{
  assert.doesNotMatch(appSrc, /if\(!c \|\| c\.kind && c\.kind !== 'asset'\) return;/, 'شرط مرده برگشته است');
  const b = start(); await settled(b.api); await wait(40);
  /* توکن رَپ‌شده نباید از کشِ غنی‌سازی داده بگیرد */
  const wrapped = {id:'wrapped-bitcoin', symbol:'wbtc', name:'Wrapped Bitcoin', current_price:60000, market_cap:1e10,
    total_volume:1e9, market_cap_rank:10, high_24h:61000, low_24h:59000, ath:70000, ath_change_percentage:-14,
    circulating_supply:1e5, total_supply:1e5, last_updated:new Date().toISOString(),
    price_change_percentage_24h_in_currency:1, price_change_percentage_7d_in_currency:2,
    sparkline_in_7d:{price:Array.from({length:168},(_,i)=>60000+i)}};
  assert.equal(b.api.assetKind(wrapped), 'wrapped');
});

/* ------------------------- اجرا ------------------------- */
let pass=0, fail=0;
for(const [name, fn] of results){
  try{ await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch(e){ console.log(`  ❌ ${name}\n     ${String(e.message).split('\n').slice(0,4).join('\n     ')}`); fail++; }
}
console.log(`\n${pass} آزمون موفق، ${fail} آزمون ناموفق (از ${results.length})`);
process.exit(fail?1:0);
