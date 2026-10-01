/* =====================================================================
   آزمون یکپارچه‌سازی لایه‌ی On-chain در app.js
   اجرا:  node tests/onchain-app.test.mjs

   سه اصلی که اینجا قفل می‌شوند:
     ۱) نبود داده = بی‌اثرِ کامل (نه صفر). با حذف ماژول، با ۴۰۴ و با حالت
        «خاموش»، همه‌ی امتیازها/دروازه‌ها/رتبه‌ها باید بیت‌به‌بیت یکسان بمانند.
     ۲) لایه فقط حق «سخت‌گیر کردن» دروازه را دارد، نه آسان‌گیر کردن.
     ۳) حالت «فقط نمایش» هیچ عددی را در موتور تغییر نمی‌دهد.
   ===================================================================== */
import assert from 'node:assert/strict';
import {boot as harnessBoot, makeStorage, settled, els} from './harness.mjs';
import {market} from './fixtures.mjs';

const wait = ms => new Promise(r=>setTimeout(r, ms));
const DAY = 864e5;

/* boot — همان زمینه‌ی آزمون دروازه، با دو کنترل تازه: داده‌ی آنچین و حالت لایه */
async function start(kind, o={}){
  const store = o.store || makeStorage();
  if(o.ocMode) store.setItem('cb_oc_v1', JSON.stringify({mode:o.ocMode}));
  const coins = o.coins || market(kind);
  const res = harnessBoot({
    coins, store, network:o.network || {}, gateCfg:o.gateCfg,
    fng:{data:[{value:kind==='riskon'?'62':'41', value_classification:kind==='riskon'?'Greed':'Fear'}]},
    hooks:{ ohlc:()=>[], chart:()=>({prices:[],total_volumes:[]}) },
    omit:o.omit || []
  });
  await settled(res.api);
  await wait(60);                     // چرخه‌ی غنی‌سازیِ بوت هم تمام شود
  await res.api.refreshOnChain();     // صریح و یک‌بار، تا هر دو سناریو هم‌تعداد فراخوان باشند
  res.api.applyMarketContext();
  return res;
}

/* fingerprint = هر چیزی که کاربر از موتور می‌بیند (بدون خودِ داده‌ی خام) */
function fingerprint(api){
  return JSON.stringify({
    regime:[api.state.regime.k, api.state.regime.pts, api.state.regime.breadth],
    gate:[api.state.gate.state, api.state.gate.macro],
    coins:api.state.coins.map(c=>[c.id, c.a.buyScore, c.a.score, c.a.gate?c.a.gate.state:'-',
      c.a.gate&&c.a.gate.gap?c.a.gate.gap.oc:null]).sort(),
    best:api.bestList(25).map(c=>c.id+':'+c.a.buyScore),
    signals:api.buildSignalPayload({side:'both', filter:'all'}).signals
      .map(s=>[s.id, s.side, s.score.buyScore??s.score.shortScore, s.gate?s.gate.state:null])
  });
}

/* ------------------------- داده‌ی آنچین ساختگی ------------------------- */
function stableSeries(daily, n=40, base=1.4e11){
  const now=Date.now(), caps=[];
  for(let i=0;i<n;i++) caps.push([now-(n-1-i)*DAY, base*(1+daily*(i-(n-1)))]);
  return {market_caps:caps};
}
function ocData(o={}){
  const now=Date.now(), base=1e21, hchg=o.hashChg||0;
  return {
    diff:{ difficultyChange:o.diffChange==null?0.4:o.diffChange, progressPercent:40,
      remainingTime:5*DAY, remainingBlocks:1800, expectedBlocks:2016, timeAvg:620e3, previousRetarget:0.9 },
    hash:{ currentHashrate:base, currentDifficulty:1.3e14,
      hashrates:[{timestamp:now/1000-2*86400, avgHashrate:base/(1+hchg)},
                 {timestamp:now/1000-86400,    avgHashrate:base/(1+hchg)},
                 {timestamp:now/1000,          avgHashrate:base}] },
    fees:{ fastestFee:o.fee==null?8:o.fee, halfHourFee:6, hourFee:4, economyFee:2, minimumFee:1 },
    pool:{ count:o.poolTxs==null?60000:o.poolTxs, vsize:2e7, total_fee:5e8 },
    chains:o.chains||[],
    stables:{ tether:o.tether||stableSeries(o.stableDaily==null?0:o.stableDaily),
              'usd-coin':o.usdc||stableSeries(0, 40, 4e10) }
  };
}
const chainRow = (name, gecko, tvl) => ({name, gecko_id:gecko, gasTokenGeckoId:gecko, tokenSymbol:'X', tvl});
const cloneWith = (kind, id, patch) => market(kind).map(c => c.id===id ? {...c, ...patch(c)} : c);

const results=[];
function test(name, fn){ results.push([name, fn]); }

/* ------------------------- ۱) بی‌اثری در نبود داده ------------------------- */
test('حذف ماژول، پاسخ ۴۰۴ و حالت خاموش — هر سه امتیازها را بیت‌به‌بیت یکسان می‌گذارند', async ()=>{
  const none    = await start('riskon', {omit:['onchain.js']});
  const missing = await start('riskon', {network:{oc:false}});
  const off     = await start('riskon', {network:{oc:false}, ocMode:'off'});
  assert.equal(fingerprint(missing.api), fingerprint(none.api),
    'بارگذاری onchain.js بدون هیچ داده‌ای نباید رفتار موتور را عوض کند');
  assert.equal(fingerprint(off.api), fingerprint(none.api), 'حالت خاموش نباید رفتار را عوض کند');
  assert.equal(missing.api.state.oc.market, null, 'بی‌داده یعنی «سنجش‌ناشدنی»، نه صفر');
  assert.equal(missing.api.state.regime.oc, null, 'رژیم نباید چیزی از لایه‌ی بی‌داده بگیرد');
  assert.ok(missing.api.state.coins.every(c=>!c.a.oc), 'بی‌داده نباید a.oc بسازد');
  assert.ok(missing.api.state.gate.reasons.every(r=>!/On-chain/.test(r)), 'دروازه نباید دلیلی از لایه‌ی خالی بیاورد');
});

test('پاسخ‌های با ساختار درست ولی محتوای تهی هم بی‌اثرند', async ()=>{
  const none = await start('riskon', {omit:['onchain.js']});
  const empty = await start('riskon', {network:{oc:{
    diff:{}, hash:{}, fees:{}, pool:{}, chains:{chains:[]},
    stables:{tether:{market_caps:[]}, 'usd-coin':{market_caps:[]}} }}});
  assert.equal(fingerprint(empty.api), fingerprint(none.api));
  assert.equal(empty.api.state.oc.market, null);
});

/* ------------------------- ۲) اثر داده ------------------------- */
test('خروج نقدینگی استیبل: امتیاز رژیم را کم و دروازه را سخت‌گیر می‌کند', async ()=>{
  const clean = await start('riskon', {network:{}});
  const drain = await start('riskon', {network:{oc:ocData({stableDaily:-0.006, fee:2, poolTxs:20000, hashChg:-0.05})}});
  const m = drain.api.state.oc.market;
  assert.ok(m, 'با داده‌ی آنچین باید ارزیابی ساخته شود');
  assert.ok(m.score < 0, `امتیاز کلان باید منفی شود: ${m.score}`);
  assert.equal(m.liq.level, 'drain');
  assert.ok(drain.api.state.regime.pts <= clean.api.state.regime.pts,
    `امتیاز رژیم نباید بالا برود (${drain.api.state.regime.pts} در برابر ${clean.api.state.regime.pts})`);
  assert.ok(m.reasons.some(r=>/استیبل/.test(r)), 'دلیل باید در خروجی باشد: ' + m.reasons.join(' | '));
  assert.equal(m.riskOff, true, 'خروج نقدینگی + افت نرخ هش = پرچم خطر مشترک');
  assert.ok(drain.api.state.gate.reasons.some(r=>/On-chain/.test(r)), 'دروازه باید سخت‌گیری را در دلایل بگوید');
  assert.ok(drain.api.state.gate.macro !== 'open', 'با پرچم خطر، دروازه نباید «باز» بماند');
});

test('رشد نقدینگی و شبکه‌ی گرم: دروازه را بازتر نمی‌کند (اثر مثبت کران‌دار است)', async ()=>{
  const clean = await start('riskoff', {network:{}});
  const hot   = await start('riskoff', {network:{oc:ocData({stableDaily:0.008, fee:80, poolTxs:500000, hashChg:0.05, diffChange:6})}});
  const m = hot.api.state.oc.market;
  assert.ok(m.score >= 0, 'داده‌ی خوب نباید منفی شود: ' + m.score);
  assert.ok(m.score <= 2, 'سقف اثر مثبت دو واحد است: ' + m.score);
  assert.equal(hot.api.state.gate.macro, clean.api.state.gate.macro, 'لایه حق باز کردن دروازه‌ی بسته را ندارد');
  const openOf = api => api.state.coins.filter(c=>c.a.gate && c.a.gate.state==='open').map(c=>c.id).sort().join(',');
  assert.equal(openOf(hot.api), openOf(clean.api), 'هیچ ارزی نباید با آنچین مجوز تازه بگیرد');
  assert.equal(hot.api.state.gate.reasons.some(r=>/On-chain/.test(r)), false, 'در حالت بازترکردن نباید دلیلی ثبت شود');
});

test('فشار آزادسازی عرضه: امتیاز خرید را کم و دروازه را می‌بندد', async ()=>{
  const coins = cloneWith('riskon', 'chainlink', c => ({
    fully_diluted_valuation:c.market_cap*6, circulating_supply:1e8, total_supply:1e9 }));
  const clean = await start('riskon', {network:{}});
  const over  = await start('riskon', {coins, network:{oc:false}});
  const before = clean.api.state.coins.find(c=>c.id==='chainlink').a;
  const after  = over.api.state.coins.find(c=>c.id==='chainlink').a;
  assert.ok(after.oc, 'a.oc باید ساخته شود');
  assert.equal(after.oc.fdvRatio, 6);
  assert.equal(after.oc.flags.overhang, 'severe');
  assert.equal(after.buyScore, Math.max(0, before.buyScore - 6), `کاهش باید دقیقاً جریمه‌ی ماژول باشد: ${before.buyScore}→${after.buyScore}`);
  assert.notEqual(after.gate.state, 'open', 'ارزِ زیر فشار آنلاک نباید مجوز ورود تازه بگیرد');
  assert.ok(after.gate.fails.some(f=>/آزادسازی/.test(f)), 'دلیل باید در fails باشد: ' + after.gate.fails.join(' | '));
  assert.ok(after.ctx.some(x=>/🧊/.test(x.t)), 'زمینه‌ی امتیاز باید در مودال دیده شود');
  const others = api => api.state.coins.filter(c=>c.id!=='chainlink').map(c=>c.id+':'+c.a.buyScore).join(',');
  assert.equal(others(over.api), others(clean.api), 'فقط ارزِ دارای FDV غیرمتعارف نباید تغییر کند');
});

test('روند TVL زنجیره از تاریخچه‌ی محلی: یک اسنپ‌شات کافی نیست، دو تا آری', async ()=>{
  const sol = [chainRow('Solana','solana',1e10), chainRow('Ethereum','ethereum',5e10)];
  const one = await start('riskon', {network:{oc:ocData({chains:sol})}});
  const oc1 = one.api.state.coins.find(c=>c.id==='solana').a.oc;
  assert.ok(!oc1 || oc1.tvl7d == null, 'با یک اسنپ‌شات نباید روند اعلام شود');
  /* تاریخچه از همان کشِ برنامه می‌آید (اسنپ‌شات ساعتیِ خودِ اپ) — نه از شبکه:
     یک نمونه‌ی هشت‌روزه می‌کاریم و بگذارید چرخه، نمونه‌ی امروز را رویش بگذارد. */
  const store2 = makeStorage();
  store2.setItem('cbo:hist:chains', JSON.stringify([{t: Date.now()-8*DAY, v:{Solana:1e10, Ethereum:5e10}}]));
  const drop = [chainRow('Solana','solana',8.4e9), chainRow('Ethereum','ethereum',5e10)];
  const two = await start('riskon', {store:store2, network:{oc:ocData({chains:drop})}});
  const oc2 = two.api.state.coins.find(c=>c.id==='solana').a.oc;
  assert.ok(oc2, 'با تاریخچه‌ی محلی باید داوری ساخته شود');
  assert.equal(oc2.chain, 'Solana');
  assert.ok(oc2.tvl7d < -10, `ریزش ۱۶٪ باید دیده شود: ${oc2.tvl7d}`);
  assert.equal(oc2.flags.exodus, true);
  assert.ok(oc2.score < 0, 'خروج پول از اکوسیستم باید امتیاز را کم کند');
  assert.ok(two.api.state.coins.find(c=>c.id==='solana').a.gate.fails.some(f=>/اکوسیستم/.test(f)),
    'دروازه باید مانع اکوسیستمی را اعلام کند');
  const nb = two.api.state.coins.find(c=>c.id==='chainlink').a.oc;
  assert.ok(!nb || nb.tvl7d == null, 'زنجیره‌ی بدون تاریخچه نباید روند بسازد');
});

test('واگرایی قیمت/شبکه: رالی بی‌مصرف علامت می‌خورد، رالی با شبکه‌ی شلوغ نه', async ()=>{
  /* شرط لایه: رشد ۲۴ ساعته‌ی بیت‌کوین بالای آستانه (۶٪) با کارمزد/صف سرد */
  const rally = cloneWith('riskon','bitcoin', ()=>({price_change_percentage_24h_in_currency:9.5}));
  const cold = await start('riskon', {coins:rally, network:{oc:ocData({fee:1, poolTxs:15000, hashChg:0.01})}});
  const mC = cold.api.state.oc.market;
  assert.ok(mC.parts.some(p=>/هم‌راستایی/.test(p.k)), 'واگرایی باید در اجزا باشد: ' + mC.parts.map(p=>p.k).join(' | '));
  assert.ok(mC.reasons.some(r=>/روی‌زنجیره‌ای سرد|نقدی/.test(r)), 'دلیل باید نوشته شود: ' + mC.reasons.join(' | '));
  const busy = await start('riskon', {coins:rally, network:{oc:ocData({fee:90, poolTxs:600000})}});
  assert.equal(busy.api.state.oc.market.parts.some(p=>/هم‌راستایی/.test(p.k)), false,
    'رالی با شبکه‌ی شلوغ واگرایی نیست');
});

/* ------------------------- ۳) حالت‌ها ------------------------- */
test('«فقط نمایش»: رندر کامل است، اما هیچ امتیازی تکان نمی‌خورد', async ()=>{
  const none = await start('riskon', {network:{}});
  const data = ocData({stableDaily:-0.006, fee:2, hashChg:-0.05});
  const disp = await start('riskon', {network:{oc:data}, ocMode:'display'});
  assert.ok(disp.api.state.oc.market.score < 0, 'داده محاسبه می‌شود تا نمایش داده شود');
  assert.equal(disp.api.state.regime.oc, null, 'در حالت نمایش نباید به رژیم برسد');
  assert.equal(disp.api.state.oc.applied, 0, 'اثر اعمال‌شده باید صفر باشد');
  const coins = disp.api.state.coins.map(c=>[c.id, c.a.buyScore, c.a.gate?c.a.gate.state:'-']).sort();
  const base  = none.api.state.coins.map(c=>[c.id, c.a.buyScore, c.a.gate?c.a.gate.state:'-']).sort();
  assert.deepEqual(coins, base, 'نه امتیازی و نه دروازه‌ای نباید در حالت نمایش عوض شود');
  disp.api.renderOnchain();
  assert.ok((els.get('#ocGrid').innerHTML.match(/class="oc-card"/g)||[]).length === 6, 'کارت‌ها باید پر شوند');
});

test('حالتِ ذخیره‌شده از حافظه بازیابی می‌شود و در حالت خاموش هیچ فراخوانی نمی‌رود', async ()=>{
  const b = await start('riskon', {ocMode:'off', network:{oc:ocData({})}});
  assert.equal(b.api.oc.mode, 'off');
  const before = b.api.state.regime.pts;
  assert.equal(b.network.hits.oc, undefined, 'در حالت خاموش نباید هیچ درخواستی به سرویس آنچین برود');
  assert.equal(await b.api.refreshOnChain(), 0);
  b.api.applyMarketContext();
  assert.equal(b.api.state.regime.pts, before);
  b.api.renderOnchain();
  assert.ok(/خاموش/.test(els.get('#ocGrid').innerHTML), 'پنل باید بگوید لایه خاموش است');
});

/* ------------------------- ۴) رابط و خروجی ------------------------- */
test('پنل آنچین: شش کارت، حکم کلی و جدول ارزها — بدون حتی یک NaN', async ()=>{
  const b = await start('riskon', {network:{oc:ocData({stableDaily:0.004, fee:30, hashChg:0.02,
    chains:[chainRow('Solana','solana',1.1e10)]})}});
  b.api.renderOnchain();
  const grid = els.get('#ocGrid');
  assert.equal((grid.innerHTML.match(/class="oc-card"/g)||[]).length, 6, 'تعداد کارت‌ها');
  assert.doesNotMatch(grid.innerHTML, /NaN|undefined|null/, 'کارت‌ها نباید NaN/undefined نشت کنند');
  assert.ok(/امتیاز آنچین/.test(els.get('#ocVerdict').innerHTML), 'حکم کلی باید نوشته شود');
  assert.ok(/باد/.test(els.get('#ocVerdict').innerHTML), 'حکم باید جهت داشته باشد');
  const why = els.get('#ocWhy').innerHTML;
  assert.ok(why.length > 10 && !/NaN/.test(why), 'دلایل باید نوشته شوند: ' + why.slice(0,80));
});

test('وضعیت خالیِ لایه هم راست گفته می‌شود، نه «صفر»', async ()=>{
  const b = await start('riskon', {network:{oc:false}});
  b.api.renderOnchain();
  assert.ok(/کافی جمع نشده/.test(els.get('#ocVerdict').innerHTML), els.get('#ocVerdict').innerHTML);
  assert.ok(/قابل‌داوری/.test(els.get('#ocCoins').innerHTML), 'جدول باید بگوید داوری ممکن نیست');
  assert.doesNotMatch(els.get('#ocCoins').innerHTML, /<table/, 'بی‌داده نباید جدول خالی رندر شود');
});

test('ردیف‌های مودال + ستون‌های CSV/JSON + نسخه‌ی اسکیما', async ()=>{
  const coins = cloneWith('riskon', 'chainlink', c => ({
    fully_diluted_valuation:c.market_cap*6, circulating_supply:1e8, total_supply:1e9 }));
  const b = await start('riskon', {coins, network:{oc:ocData({stableDaily:-0.005})}});
  b.api.openModal('chainlink');
  const mkv = els.get('#mkv');
  assert.ok(/امتیاز آنچین/.test(mkv.innerHTML) && /FDV/.test(mkv.innerHTML), 'ردیف‌های آنچین در مودال نیست');
  assert.doesNotMatch(mkv.innerHTML, /NaN|undefined/, 'جدول اندیکاتور نباید NaN داشته باشد');
  const p = b.api.buildSignalPayload({side:'long', filter:'all'});
  assert.equal(p.schemaVersion, '1.1');
  assert.equal(p.market.onchainMode, 'auto');
  assert.ok(p.market.onchain, 'بخش onchain در market باید پر شود');
  assert.ok(Number.isFinite(p.market.onchain.score) && p.market.onchain.score < 0);
  assert.ok(p.market.onchain.stableMcapUsd > 0 && Array.isArray(p.market.onchain.reasons));
  assert.ok(p.market.onchain.at && !/NaN/.test(p.market.onchain.at), 'زمان داده باید ISO باشد');
  const sig = p.signals.find(x=>x.id==='chainlink');
  assert.ok(sig && sig.context.onchain, 'سیگنال باید زمینه‌ی آنچین داشته باشد');
  assert.equal(sig.context.onchain.floatPct, 10);
  assert.equal(sig.context.onchain.flags.overhang, 'severe');
  assert.ok(sig.context.onchain.why.length > 0);
  assert.ok(p.signals.every(x=>x.context.onchain===null || x.id==='chainlink'),
    'ارزهای بدون FDV غیرمتعارف نباید زمینه‌ی ساختگی داشته باشند');
  b.api.exportCSV();
  const csv = b.getCsv(), head = csv.split('\r\n')[0], row = csv.split('\r\n').find(l=>l.includes('LINK'));
  assert.ok(/امتیاز آنچین/.test(head) && /باد آنچین/.test(head), 'سرستون CSV: ' + head.slice(-120));
  assert.ok(/-6,10\.0,6\.00,/.test(row), 'ردیف LINK باید امتیاز/عرضه/FDV را نشان دهد: ' + (row||'').slice(-140));
});

test('نوار وضعیت: بودجه و خطا دیده می‌شود', async ()=>{
  const b = await start('riskon', {network:{oc:false}});
  b.api.updateOcStatus();
  const txt = els.get('#ocStatus').textContent;
  assert.ok(/فراخوان این ساعت/.test(txt), txt);
  assert.ok(/خطای دسترسی/.test(txt) && /404/.test(txt), 'خطا باید گزارش شود: ' + txt);
});

test('بودجه: چرخه‌های پشت‌سرهم فراخوان تکراری نمی‌زنند', async ()=>{
  const b = await start('riskon', {network:{oc:ocData({chains:[chainRow('Solana','solana',1e10)]})}});
  const first = b.network.hits.oc || 0;
  assert.ok(first > 0, 'بار اول باید فراخوان زده باشد');
  for(let i=0;i<8;i++) await b.api.refreshOnChain();
  assert.equal(b.network.hits.oc, first, `فراخوان تکراری در همان بازه زده شد (${first} → ${b.network.hits.oc})`);
});

/* ------------------------- اجرا ------------------------- */
let pass=0, fail=0;
for(const [name, fn] of results){
  try{ await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch(e){ console.log(`  ❌ ${name}\n     ${String(e.message).split('\n').slice(0,5).join('\n     ')}`); fail++; }
}
console.log(`\n${pass} آزمون موفق، ${fail} آزمون ناموفق (از ${results.length})`);
process.exit(fail?1:0);
