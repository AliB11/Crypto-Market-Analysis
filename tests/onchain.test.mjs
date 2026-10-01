/* =====================================================================
   آزمون لایه‌ی On-chain (onchain.js) — بدون شبکه، با حافظه و زمان جعلی
   اجرا:  node --test tests/onchain.test.mjs

   هر قاعده‌ی آنچین باید سه حالت را زنده نشان دهد: داده‌ی خوب (اثر)،
   داده‌ی بد (اثر مخالف) و نبود داده (بی‌اثر — نه صفرِ اشتباه‌پذیر).
   ===================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const OC = require('../onchain.js');

const DAY = 864e5, HOUR = 3600e3;
let NOW = 1_760_000_000_000;
function fakeStore(){
  const m = new Map();
  return { getItem:k => (m.has(k) ? m.get(k) : null), setItem:(k,v) => m.set(k, String(v)),
    removeItem:k => m.delete(k), clear:() => m.clear(), key:i => [...m.keys()][i], get length(){ return m.size; } };
}
function fresh(){
  const store = fakeStore();
  OC.setEnv({ storage:store, now:() => NOW, fetchImpl:null });
  OC.resetBudget();
  return store;
}

/* ------------------------- ۱) شبکه‌ی بیت‌کوین ------------------------- */
test('شبکه: ورودی خراب/ناقص به null تبدیل می‌شود و NaN تولید نمی‌کند', () => {
  const d = OC.readBtcNetwork({ diff:{difficultyChange:'x', progressPercent:NaN}, hash:{currentHashrate:-5, hashrates:[{avgHashrate:null},123]},
    fees:{fastestFee:'abc'}, pool:{count:'nope', vsize:0, total_fee:-3} });
  assert.equal(d.diffChangePct, null);
  assert.equal(d.diffProgress, null);
  assert.equal(d.hashNow, null);
  assert.equal(d.feeFast, null);
  assert.equal(d.poolTxs, null);
  assert.equal(d.poolVsizeMb, null);
  assert.equal(OC.analyzeBtcNetwork(d).level, 'unknown');
  assert.equal(OC.analyzeBtcNetwork(null).score, 0);
});

test('شبکه: افت نرخ هش + کاهش دشواری = فشار ماینر (امتیاز منفی)', () => {
  const d = OC.readBtcNetwork({
    diff:{ difficultyChange:-5.2, progressPercent:96, remainingTime:3 * HOUR, previousRetarget:2.1 },
    hash:{ currentHashrate:0.97e21, currentDifficulty:1.3e14, hashrates:[{avgHashrate:1.0e21},{avgHashrate:1.02e21},{avgHashrate:0.97e21}] },
    fees:{ fastestFee:2, halfHourFee:1, hourFee:1, economyFee:1 },
    pool:{ count:12000, vsize:5e6, total_fee:1.2e8 }
  });
  assert.ok(d.hashChgPct < -2, 'باید افت سه‌روزه‌ی نرخ هش را ببیند');
  const a = OC.analyzeBtcNetwork(d);
  assert.ok(a.score < 0, 'فشار ماینر باید امتیاز را کم کند');
  assert.equal(a.flags.hashDrop, true);
  assert.equal(a.flags.diffCut, true);
  assert.equal(a.level, 'stressed');
  assert.ok(a.why.join(' ').includes('نرخ هش'));
});

test('شبکه: رشد نرخ هش + تنظیم مثبت دشواری = تقویت (امتیاز مثبت، کران‌دار)', () => {
  const a = OC.analyzeBtcNetwork({ hashChgPct:4, diffChangePct:7, poolTxs:400000, feeFast:55, feeHour:20 });
  assert.ok(a.score > 0);
  assert.ok(a.flags.congested);
  assert.ok(a.flags.feeHot);
  assert.ok(a.score <= OC.TH.capMarket, 'امتیاز از سقف نباید رد شود');
});

test('شبکه: نبود داده هیچ امتیازی نمی‌سازد (0 نه 0.5)', () => {
  const a = OC.analyzeBtcNetwork({});
  assert.equal(a.score, 0);
  assert.equal(a.level, 'unknown');
  assert.equal(a.n, 0);
});

test('واگرایی قیمت/زنجیره: رالی با کارمزد سرد → هشدار؛ رالی با شبکه گرم → نه', () => {
  const cold = { feeFast:1, poolTxs:20000 };
  const hot  = { feeFast:60, poolTxs:400000 };
  const d1 = OC.networkPriceDivergence(cold, 8);
  assert.equal(d1.kind, 'weak-rally');
  assert.equal(d1.score, -1);
  assert.equal(OC.networkPriceDivergence(hot, 8), null);
  assert.equal(OC.networkPriceDivergence(cold, 2), null, 'رشد کوچک مشمول نیست');
  const d2 = OC.networkPriceDivergence(hot, -9);
  assert.equal(d2.kind, 'real-selling');
  assert.equal(OC.networkPriceDivergence(null, 9), null);
  assert.equal(OC.networkPriceDivergence(hot, null), null);
});

/* ------------------------- ۲) نقدینگی استیبل‌کوین ------------------------- */
const daySeries = (startMcap, daily, n=40) =>
  Array.from({length:n}, (_, i) => ({ t: NOW - (n - 1 - i) * DAY, mcap: startMcap * (1 + daily * i) }));

test('سری استیبل: market_chart روزانه تحلیل، و فقط روز کامل نگه داشته می‌شود', () => {
  const resp = { market_caps: [[NOW, 100], [NOW, 120], [NOW - DAY, 90], [NOW - 2 * DAY, -5], [NaN, 10], 'junk'] };
  const s = OC.parseStableSeries(resp);
  assert.equal(s.length, 2, 'دو روز معتبر؛ نمونه‌ی منفی/خراب/تکراری حذف');
  assert.equal(s[1].mcap, 120, 'در روز تکراری آخرین نمونه می‌ماند');
  assert.deepEqual(OC.parseStableSeries(null), []);
  assert.deepEqual(OC.parseStableSeries({}), []);
});

test('ادغام USDT+USDC: روزی که در یکی نیست حذف می‌شود', () => {
  const a = [{ t: NOW - 2 * DAY, mcap: 100 }, { t: NOW - DAY, mcap: 110 }, { t: NOW, mcap: 120 }];
  const b = [{ t: NOW - DAY, mcap: 50 }, { t: NOW, mcap: 60 }];
  const m = OC.mergeStableSeries([a, b]);
  assert.equal(m.length, 2);
  assert.equal(m[1].mcap, 180);
  assert.deepEqual(OC.mergeStableSeries([]), []);
  assert.equal(OC.mergeStableSeries([[], []]).length, 0);
});

test('نقدینگی: رشد ۷ روزه امتیاز مثبت و ریزش امتیاز منفی می‌دهد', () => {
  const grow = OC.analyzeLiquidity(daySeries(1e11, 0.004, 40), NOW);      // ≈ +1.6٪/۷روز
  assert.ok(grow.chg7d >= OC.TH.liqGrow7d, 'رشد محاسبه شد: ' + grow.chg7d);
  assert.ok(grow.score > 0);
  assert.equal(grow.level, 'expansion');
  const drain = OC.analyzeLiquidity(daySeries(1e11, -0.004, 40), NOW);
  assert.ok(drain.score < 0);
  assert.equal(drain.level, 'drain');
  assert.ok(drain.flags.drain);
  assert.ok(grow.mcap > 0 && OC.isNum(grow.chg30d));
});

test('نقدینگی: تاریخچه‌ی کوتاه ⇒ بی‌اثر، نه امتیاز تصادفی', () => {
  const few = OC.analyzeLiquidity(daySeries(1e11, 0.01, 3), NOW);
  assert.equal(few.score, 0);
  assert.equal(few.level, 'unknown');
  assert.ok(few.why.length >= 1);
  assert.equal(OC.analyzeLiquidity([], NOW).score, 0);
  assert.equal(OC.analyzeLiquidity(null, NOW).level, 'unknown');
});

test('اسنپ‌شات سهم دلاری: نمونه‌ی همان ساعت جایگزین می‌شود و تاریخچه کران دارد', () => {
  fresh();
  let h = [];
  for(let i = 0; i < 400; i++){
    h = OC.pushLiqSnap(h, { stableUsd: 2e11 + i, mcapUsd: 3e12 }, NOW + i * 3700e3);
  }
  assert.ok(h.length <= OC.LIMITS.liqHist, 'سقف تاریخچه رعایت شود');
  const reloaded = OC.loadLiqHistory();
  assert.equal(reloaded.length, h.length, 'از حافظه هم قابل بازخوانی است');
  const share = reloaded[reloaded.length - 1].share;
  assert.ok(share > 0 && share < 100);
  /* ورودی خراب نباید تاریخچه را خراب کند */
  const before = h.length;
  const after = OC.pushLiqSnap(h, { stableUsd: NaN, mcapUsd: 0 }, NOW + 10 * HOUR);
  assert.equal(after.length, before);
});

test('روند سهم دلاری: بدون تاریخچه null و با پنجره‌ی کامل عدد می‌دهد', () => {
  const hist = [
    { t: NOW - 8 * DAY, stable: 2.0e11, mcap: 3.0e12, share: 6.6667 },
    { t: NOW - 4 * DAY, stable: 2.1e11, mcap: 3.5e12, share: 6.0 },
    { t: NOW,            stable: 2.2e11, mcap: 4.0e12, share: 5.5 }
  ];
  const tr = OC.shareTrend(hist, 7, NOW);
  assert.ok(tr, 'پنجره‌ی ۷ روزه با ۸ روز تاریخچه پر است');
  assert.ok(tr.pp < 0, 'سهم در حال کاهش = سوخت ورود به دارایی پرریسک');
  assert.equal(OC.shareTrend([], 7, NOW), null);
  assert.equal(OC.shareTrend(hist.slice(-1), 7, NOW), null);
  assert.equal(OC.shareTrend([{ t: NOW - HOUR, share: 5 }], 7, NOW), null);
});

/* ------------------------- ۳) TVL زنجیره‌ها ------------------------- */
const chainRows = (eth = 5e10, sol = 1e10) => ([
  { name:'Ethereum', gecko_id:'ethereum', gasTokenGeckoId:'ethereum', tokenSymbol:'ETH', tvl:eth },
  { name:'Solana',   gecko_id:'solana',   gasTokenGeckoId:'solana',   tokenSymbol:'SOL', tvl:sol },
  { name:'Polygon',  gecko_id:'polygon-ecosystem-token', gasTokenGeckoId:'polygon-ecosystem-token', tvl:9e8 },
  { name:'Dust',     gecko_id:'dust',     gasTokenGeckoId:null,        tvl:10 },
  { name:'',         gecko_id:null,        gasTokenGeckoId:null,        tvl:1e9 },
  'junk'
]);
test('TVL: ردیف‌های بی‌ارزش/خراب حذف و lookup از خود داده ساخته می‌شود', () => {
  const ch = OC.readChains(chainRows());
  assert.deepEqual(Object.keys(ch).sort(), ['Ethereum','Polygon','Solana']);
  assert.ok(ch.Ethereum.tvl === 5e10);
  const look = OC.chainLookup(ch);
  assert.equal(look.ethereum, 'Ethereum');
  assert.equal(look.solana, 'Solana');
  assert.equal(look['matic-network'], 'Polygon', 'جدول جایگزین باید نام‌های ناهمخوان را وصل کند');
  assert.equal(look.dust, undefined);
  assert.deepEqual(OC.readChains(null), {});
  assert.deepEqual(OC.chainLookup(null), {});
});

test('TVL: مومنتوم مثبت/منفی امتیاز می‌دهد و بدون تاریخچه بی‌اثر است', () => {
  const mk = (mul1, mul7) => ([
    { t: NOW - 8 * DAY, v: { Solana: 1e10 * mul7 } },
    { t: NOW - DAY,      v: { Solana: 1e10 * mul1 } },
    { t: NOW,            v: { Solana: 1e10 } }
  ]);
  const grow = OC.analyzeChain('Solana', mk(0.99, 0.97), NOW);   // ۷ روز +۳٪، ۲۴ ساعت +۱٪
  assert.equal(grow.ready, true);
  assert.ok(grow.score > 0, 'ورود پول به اکوسیستم باید پاداش بگیرد');
  const exodus = OC.analyzeChain('Solana', mk(1.02, 1.16), NOW); // ۷ روز −۱۴٪
  assert.ok(exodus.score < 0);
  assert.equal(exodus.flags.exodus, true);
  assert.ok(exodus.chg7d <= OC.TH.tvlExodus7d);
  assert.equal(OC.analyzeChain('Solana', [], NOW).ready, false);
  assert.equal(OC.analyzeChain('Unknown', mk(1, 1), NOW).score, 0);
  assert.equal(OC.analyzeChain('Solana', [{ t: NOW, v:{ Solana:1 } }], NOW).ready, false, 'یک نمونه = سطح است نه روند');
});

test('TVL: تاریخچه‌ی محلی کران دارد و نمونه‌ی تازه جایگزین همان اسنپ‌شات می‌شود', () => {
  fresh();
  const chains = { Solana:{ tvl: 1e10 } };
  let h = [];
  for(let i = 0; i < 40; i++) h = OC.pushChainHistory(h, chains, NOW + i * (OC.TTL.chains + 1000));
  assert.ok(h.length <= OC.LIMITS.chainsHist);
  assert.equal(OC.loadChainHistory().length, h.length);
  const h2 = OC.pushChainHistory(h, chains, NOW + 5000);   // همان پنجره ⇒ جایگزینی، نه انباشت
  assert.equal(h2.length, h.length);
  assert.equal(OC.pushChainHistory(h, null, NOW).length, h.length, 'بدون داده نباید چیزی بنویسد');
});

/* ------------------------- ۴) توکنومیکس / فشار آزادسازی ------------------------- */
test('فشار آزادسازی: عرضه‌ی شناور کم + FDV چندبرابر = جریمه', () => {
  const heavy = OC.analyzeFloat({ circulating_supply: 1e8, total_supply: 10e8, market_cap: 1e9, fully_diluted_valuation: 9e9 });
  assert.equal(Math.round(heavy.floatPct), 10);
  assert.ok(heavy.score < 0);
  assert.equal(heavy.flags.overhang, 'severe');
  const mid = OC.analyzeFloat({ circulating_supply: 3e8, total_supply: 10e8, market_cap: 1e9, fully_diluted_valuation: 3.2e9 });
  assert.ok(mid.score < 0 && mid.score > heavy.score);
  const fair = OC.analyzeFloat({ circulating_supply: 9.6e8, total_supply: 10e8, market_cap: 1e9, fully_diluted_valuation: 1.04e9 });
  assert.ok(fair.score > 0, 'عرضه‌ی کامل‌شده باید پاداش بگیرد');
  const none = OC.analyzeFloat({ circulating_supply:null, total_supply:null, market_cap:1e9 });
  assert.equal(none.ready, false);
  assert.equal(none.score, 0);
  assert.equal(OC.analyzeFloat(null).score, 0);
});

test('فشار آزادسازی: بدون FDV هیچ داوری‌ای نمی‌شود (نه پاداش، نه جریمه)', () => {
  /* داده‌ی /coins/markets همیشه total_supply را معنادار نمی‌دهد (گاهی همان
     max_supply است)؛ تکیه بر آن، صدها ارز را بی‌دلیل تنبیه می‌کرد. */
  const noFdv = OC.analyzeFloat({ circulating_supply: 1e8, total_supply: 1e9, market_cap: 1e9 });
  assert.equal(noFdv.score, 0);
  assert.equal(noFdv.flags.overhang, undefined);
  assert.ok(noFdv.why.every(t => !/NaN/.test(t)));
  assert.equal(OC.analyzeFloat({ circulating_supply: 1e8, total_supply: 1e9 }).fdvRatio, null);
  assert.equal(OC.analyzeFloat({ market_cap: 1e9, fully_diluted_valuation: 1.2e9 }).score, 0, 'نسبت کوچک مشمول جریمه نیست');
});

test('فشار آزادسازی: فقط FDV موجود ⇒ تخمین سهم شناور از نسبت، بدون NaN', () => {
  const o = OC.analyzeFloat({ market_cap: 1e9, fully_diluted_valuation: 4e9 });
  assert.ok(Math.abs(o.floatPct - 25) < 1e-6);
  assert.ok(o.score < 0);
  assert.ok(o.why.every(t => typeof t === 'string' && !/NaN|undefined/.test(t)));
});

/* ------------------------- ۵) ترکیب و کران‌ها ------------------------- */
test('ترکیب کلان: لایه‌ی آنچین فقط می‌تواند سخت‌گیر کند، نه آسان‌گیر', () => {
  const bad = OC.combineMarket({ score:-2, level:'stressed', why:['الف'], flags:{ hashDrop:true } },
    { score:-2, level:'drain', why:['ب'], flags:{ drain:true } }, { score:-1, text:'ج' });
  assert.ok(bad.score < 0);
  assert.equal(bad.level, 'headwind');
  assert.equal(bad.riskOff, true, 'خروج نقدینگی + فشار ماینر = پرچم خطر مشترک');
  assert.equal(bad.reasons.length, 3);
  const good = OC.combineMarket({ score:2, level:'strengthening', why:['الف'], flags:{} },
    { score:3, level:'expansion', why:['ب'], flags:{} }, null);
  assert.ok(good.score > 0);
  assert.ok(good.score <= Math.round(OC.TH.capMarket * 0.66), 'سقف مثبت عمداً کوتاه‌تر از منفی است');
  assert.equal(good.riskOff, false);
  const empty = OC.combineMarket(null, null, null);
  assert.deepEqual({ s: empty.score, l: empty.level, r: empty.reasons.length }, { s:0, l:'flat', r:0 });
});

/* ------------------------- ۶) بودجه و کش ------------------------- */
test('بودجه: هر گروه حداقل فاصله‌ی خودش را دارد و سقف ساعتی رعایت می‌شود', () => {
  fresh();
  assert.equal(OC.canCall('btcMin', NOW), true, 'اولین فراخوان آزاد است');
  OC.noteCall('btcMin', NOW);
  assert.equal(OC.canCall('btcMin', NOW + OC.GAP.btcMin - 1000), false);
  assert.equal(OC.canCall('btcMin', NOW + OC.GAP.btcMin), true);
  assert.equal(OC.canCall('stables', NOW + 1000), true, 'گروه دیگر سهم مستقل دارد');
  /* سقف ساعتی با یک kind ساختگی سنجیده می‌شود: فاصله‌ی واقعی‌ها آن‌قدر بزرگ
     است که خودِ فاصله، فراخوان‌ها را محدود می‌کند. */
  OC.GAP.probe = 1000;
  OC.resetBudget();
  const H0 = Math.floor(NOW / 3600e3) * 3600e3;
  let calls = 0;
  for(let i = 0; i < OC.HOURLY_CAP; i++){
    const t = H0 + i * 1000;
    if(OC.canCall("probe", t)){ OC.noteCall("probe", t); calls++; }
  }
  assert.equal(calls, OC.HOURLY_CAP, "تا سقف ساعتی اجازه داده شود");
  assert.equal(OC.canCall("probe", H0 + 100 * 1000), false, "با وجود گذشتن فاصله، سقف ساعتی جلوی فراخوان را می‌گیرد");
  assert.equal(OC.canCall("probe", H0 + 3600e3 + 1000), true, "ساعت بعد بودجه تازه می‌شود");
  assert.ok(OC.budgetState(H0 + 100 * 1000).callsThisHour <= OC.HOURLY_CAP);
  delete OC.GAP.probe;
});

test('بودجه: ۴۲۹ پشتیبان‌گیری نمایی و بلوک کوتاه ایجاد می‌کند', () => {
  fresh();
  assert.equal(OC.backoffOn(true), 2);
  assert.equal(OC.canCall('btcMin', NOW + 1000), false, 'در دوره‌ی تنبیه فراخوانی نمی‌شود');
  assert.equal(OC.backoffOn(true), 4);
  assert.equal(OC.backoffOn(false), 2, 'موفقیت‌های پشت‌سرهم تنبیه را فرسایش می‌دهند');
  assert.ok(OC.budgetState().backoff >= 1);
});

test('کش: TTL رعایت می‌شود و داده‌ی کهنه null برمی‌گردد', () => {
  fresh();
  OC.cacheSet('chains', { a:1 }, NOW);
  assert.deepEqual(OC.cacheGet('chains', OC.TTL.chains, NOW + 60e3), { a:1 });
  assert.equal(OC.cacheGet('chains', OC.TTL.chains, NOW + OC.TTL.chains + 1), null);
  assert.ok(OC.cacheAge('chains', NOW + 5e3) === 5e3);
  assert.equal(OC.cacheGet('nope', 1000, NOW), null);
  assert.equal(OC.cacheAge('nope', NOW), null);
});

test('شبکه: نبود fetchImpl خطا می‌دهد نه استثنا', async () => {
  fresh();
  const r = await OC.getJSON('https://example.invalid/x');
  assert.equal(r.__error, true);
  assert.equal(r.reason, 'no-fetch');
});

test('شبکه: پاسخ HTTP نامعتبر و JSON خراب به خطای ساختاریافته تبدیل می‌شوند', async () => {
  OC.setEnv({ storage: fakeStore(), now:() => NOW,
    fetchImpl: async url => String(url).includes('404')
      ? { ok:false, status:404, json: async() => ({}) }
      : { ok:true, status:200, json: async() => 'text-not-json' } });
  assert.equal((await OC.getJSON('https://x/404')).status, 404);
  assert.equal((await OC.getJSON('https://x/bad')).__error, true);
});

/* ------------------------- ۷) قفل‌کردن «منابع واقعی» ------------------------- */
test('پاسخ واقعی mempool/llama (برون‌داد ذخیره‌شده) باید تحلیل شود', () => {
  /* این سه نمونه از پاسخ‌های زنده‌ی همان endpointها گرفته و کوچک شده‌اند تا
     تغییر ساختار API (مثلاً نام میدان‌ها) در آزمون دیده شود. */
  const diff = { progressPercent:89.88, difficultyChange:0.1239, estimatedRetargetDate:NOW + 122315952,
    remainingBlocks:204, remainingTime:122315952, previousRetarget:4.163, nextRetargetHeight:969696 };
  const hash = { hashrates:[{ timestamp:1790640000, avgHashrate:1.0882e21 }, { timestamp:1790726400, avgHashrate:1.0510e21 }, { timestamp:1790812800, avgHashrate:9.2855e20 }],
    currentHashrate:9.8643e20, currentDifficulty:1.3275e14 };
  const net = OC.readBtcNetwork({ diff, hash, fees:{ fastestFee:5, halfHourFee:4, hourFee:1, economyFee:1 },
    pool:{ count:86958, vsize:44202055, total_fee:14247055 } });
  assert.ok(net.diffChangePct > 0 && net.diffProgress > 80);
  assert.ok(net.hashChgPct < 0, 'میانگین سه‌روزه باید افت را ببیند');
  assert.ok(net.poolTxs > 80000 && net.poolVsizeMb > 40);
  assert.ok(net.poolFeeBtc > 0 && net.poolFeeBtc < 1, 'sat باید به BTC تبدیل شود');
  const chains = OC.readChains([{ gecko_id:'ethereum', gasTokenGeckoId:'ethereum', tvl:5.37e10, name:'Ethereum', chainId:1 }]);
  assert.equal(chains.Ethereum.gecko, 'ethereum');
});
