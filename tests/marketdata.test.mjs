/* =====================================================================
   آزمون لایه‌ی داده‌ی غنی‌شده (market-data.js) — بدون شبکه، با حافظه‌ی جعلی
   اجرا:  node --test tests/marketdata.test.mjs
   ===================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const MD = require('../market-data.js');

/* حافظه‌ی جعلی سازگار با localStorage */
function fakeStore(){
  const m = new Map();
  return { getItem:k => (m.has(k) ? m.get(k) : null), setItem:(k,v) => m.set(k, String(v)),
    removeItem:k => m.delete(k), clear:() => m.clear(), key:i => [...m.keys()][i], get length(){ return m.size; },
    _raw:m };
}
let NOW = 1_700_000_000_000;
function fresh(){
  const store = fakeStore();
  MD.setEnv({ storage:store, now:() => NOW, fetchImpl:null });
  MD.resetBudget();
  MD.clearQueue();
  return store;
}
const der = (symbol, funding, oi, extra = {}) => Object.assign({
  market:'Binance (Futures)', symbol, index_id:symbol.replace(/USDT$/, '') + ' USD', price:100,
  contract_type:'perpetual', funding_rate:funding, open_interest:oi, volume_24h:1e8, basis:0.1, spread:0.02 }, extra);

test('مشتقات: تک‌قرارداد و میانه‌ی چند صرافی', () => {
  const by = MD.derivativesBySymbol([
    der('BTCUSDT', 0.0001, 1e9), der('BTC-USD', 0.0003, 2e9, {market:'OKX'}),
    der('ETHUSDT', -0.0002, 5e8)
  ]);
  assert.equal(by.BTC.venues, 2);
  assert.equal(by.BTC.markets.length, 2);
  assert.ok(Math.abs(by.BTC.fundingMedian - 0.0002) < 1e-12);      // میانه، نه میانگین
  assert.equal(by.BTC.oiUsd, 3e9);                                 // جمع OI همه‌ی بازارها
  assert.equal(Math.round(by.BTC.fundingAnnual), 22);              // 0.0002×3×365×100 ≈ 21.9
  assert.ok(by.ETH.fundingAnnual < 0);
});

test('مشتقات: قرارداد تاریخ‌دار، استیبل‌کوین و ردیف خراب حذف می‌شوند', () => {
  const by = MD.derivativesBySymbol([
    der('BTCUSDT', 0.0001, 1e9, {contract_type:'futures'}),          // تاریخ‌دار ⇒ دور
    der('USDTUSD', 0.0001, 1e9),                                     // استیبل ⇒ دور
    der('SOLUSDT', NaN, 0),                                          // بدون داده‌ی معتبر
    null, 'x', {symbol:'DOGEUSDT', contract_type:'perpetual', funding_rate:'0.0005', open_interest:'1000'}
  ]);
  assert.equal(by.BTC, undefined);                                   // قرارداد تاریخ‌دار
  assert.equal(by.USDT, undefined);                                  // استیبل‌کوین
  assert.equal(by.SOL, undefined);                                   // ردیف بی‌داده
  assert.equal(by.DOGE.fundingPct > 0, true);                        // رشته‌ی عددی پذیرفته می‌شود
});

test('سالانه‌سازی فاندینگ با فرض ۸ ساعت و رد مقدار نامعتبر', () => {
  assert.ok(Math.abs(MD.annualize(0.0001) - 10.95) < 0.01);          // ۰.۰۱٪ هر ۸ ساعت
  assert.equal(MD.annualize(NaN), null);
  assert.equal(MD.annualize(0.0001, 4), null === null ? MD.annualize(0.0001, 4) : null);
  assert.ok(Math.abs(MD.annualize(0.0001, 4) - 21.9) < 0.01);        // دوره‌ی ۴ ساعته
});

test('ازدحام: فاندینگ داغ + OI صعودی ⇒ لانگ داغ؛ بی‌داده ⇒ بی‌اثر', () => {
  const hot = MD.classifyCrowding({ fundingAnnual:60 }, 70, 5);
  assert.equal(hot.side, 'long'); assert.equal(hot.level, 'hot');
  const warm = MD.classifyCrowding({ fundingAnnual:35 }, 50, 4);
  assert.equal(warm.side, 'long'); assert.equal(warm.level, 'warm');
  const neg = MD.classifyCrowding({ fundingAnnual:-45 }, 35, 6);
  assert.equal(neg.side, 'short'); assert.equal(neg.level, 'hot');
  assert.equal(MD.classifyCrowding({ fundingAnnual:null }, 70, 5).side, null);   // بی‌داده ⇒ هیچ
  assert.equal(MD.classifyCrowding(null, 70, 5).side, null);
  /* فاندینگ داغ ولی نه OI صعودی و نه RSI بالا ⇒ هشدار ساخته نمی‌شود */
  assert.equal(MD.classifyCrowding({ fundingAnnual:60 }, 50, -2).side, null);
});

test('بودجه: پروفایل‌ها و فاصله‌ی فراخوان', () => {
  fresh();
  assert.equal(MD.profile(), 'balanced');
  assert.equal(MD.gapMs(), 90000);                                   // ۲۰ ارز/ساعت × ۲ فراخوان
  MD.setProfile('eco'); assert.equal(MD.gapMs(), 300000);            // ۶ ارز/ساعت
  MD.setProfile('full'); assert.equal(MD.gapMs(), 45000);            // ۴۰ ارز/ساعت
  assert.equal(MD.canEnrich(NOW), true);
  MD.noteCall(NOW);
  assert.equal(MD.canEnrich(NOW + 1000), false);                     // تازه خرج کرده‌ایم
  assert.equal(MD.canEnrich(NOW + 45000), true);
  MD.setProfile('nonsense');                                         // پروفایل نامعتبر نادیده گرفته می‌شود
  assert.equal(MD.profile(), 'full');
  fresh();                                                           // حافظه‌ی تازه ⇒ پیش‌فرض
  assert.equal(MD.profile(), 'balanced');
});

test('بودجه: خطای ۴۲۹ پشتیبان‌گیری نمایی و توقف موقت می‌سازد', () => {
  fresh();
  assert.equal(MD.backoffOn(true), 2);
  assert.equal(MD.canEnrich(NOW + 100000), false);                   // پنجره‌ی توقف فعال است
  assert.ok(MD.budgetState().throttledForMs > 0);
  assert.equal(MD.backoffOn(true), 4);
  assert.equal(MD.backoffOn(false), 2);                              // موفقیت ⇒ نصف
  MD.backoffOn(false); assert.equal(MD.backoffOn(false), 1);
});

test('بودجه: شمارش فراخوان روزانه در حافظه می‌ماند', () => {
  const store = fresh();
  MD.noteCall(NOW); MD.noteCall(NOW + 200000);
  assert.equal(MD.budgetState().callsToday, 2);
  const day = new Date(NOW).toISOString().slice(0, 10);
  assert.equal(JSON.parse(store.getItem(MD.NS + 'usage')).day, day);
  NOW += 24 * 3600000;                                               // روز بعد
  MD.noteCall(NOW);
  assert.equal(MD.budgetState().callsToday, 1);
  MD.restoreUsage();
  assert.equal(MD.budgetState().callsToday, 1);
});

test('صف: شکست پشت‌سرهم، cool‌دان رشدی و رهاکردن پس از سه خطا', () => {
  fresh();
  MD.plan([{ id:'bad', p:1 }, { id:'good', p:5 }]);
  assert.equal(MD.next(), 'bad');
  MD.fail('bad');                                    // خطای اول ⇒ ۵ دقیقه cool‌دان
  assert.equal(MD.next(), 'good');                   // نوبت به گزینه‌ی بعدی می‌رسد
  NOW += 6 * 60 * 1000;
  assert.equal(MD.next(), 'bad');                    // پس از پنجره، دوباره تلاش می‌شود
  MD.fail('bad'); MD.fail('bad');                    // سه خطا
  NOW += 6 * 60 * 1000;
  assert.equal(MD.next(), 'good');                   // cool‌دان ۶ ساعته فعال است
  MD.plan(new Set([...MD.pendingIds()].map(id => ({ id }))));   // برنامه‌ریزی نباید شمارنده را صفر کند
  assert.equal(MD.next(), 'good');
  NOW += 25 * 3600 * 1000;
  MD.plan([{ id:'bad', p:1 }]);                      // پس از یک روز، شانس دوباره
  assert.equal(MD.next(), 'bad');
});

test('صف: اولویت، ماندگاری و حذف پس از موفقیت', () => {
  fresh();
  MD.plan([{ id:'b', p:9 }, { id:'a', p:1 }, { id:'c', p:2 }]);
  assert.equal(MD.next(), 'a');
  assert.equal(MD.next(), 'a');                                      // تا حذف نشود همان است
  assert.equal(MD.pendingCount(), 3);
  MD.dropFromQueue('a');
  assert.equal(MD.next(), 'c');
  MD.plan([{ id:'d', p:0 }]);
  assert.deepEqual(MD.pendingIds(), ['d']);
  MD.clearQueue(); assert.equal(MD.next(), null);
  MD.plan(null); assert.equal(MD.pendingCount(), 0);
});

test('کش: TTL، سن و پاک‌سازی قدیمی‌ها', () => {
  fresh();
  MD.cacheSet('ohlc', 'bitcoin', [[1, 2, 3, 4, 5]]);
  assert.equal(MD.cacheGet('ohlc', 'bitcoin', 1000).length, 1);
  assert.equal(MD.cacheAge('ohlc', 'bitcoin'), 0);
  NOW += 2000;
  assert.equal(MD.cacheGet('ohlc', 'bitcoin', 1000), null);          // منقضی
  assert.equal(MD.cacheGet('ohlc', 'bitcoin', 5000).length, 1);      // هنوز داخل مهلت جدید
  assert.equal(MD.cacheAge('ohlc', 'bitcoin'), 2000);
  for(let i = 0; i < 6; i++){ NOW += 10; MD.cacheSet('oi', 'coin' + i, [i]); }
  assert.ok(MD.cacheSummary().cache >= 1);
});

test('OI: نمونه‌ی تازه جایگزین می‌شود و تغییر فقط با بازه‌ی کافی محاسبه می‌شود', () => {
  fresh();
  assert.equal(MD.recordOi('BTC', 1000, NOW), true);
  assert.equal(MD.oiChangePct('BTC', 1), null);                      // یک نمونه کافی نیست
  MD.recordOi('BTC', 1050, NOW + 60 * 1000);                         // کمتر از ۴ دقیقه ⇒ همان نمونه به‌روز می‌شود
  MD.recordOi('BTC', 1200, NOW + 30 * 60 * 1000);
  NOW += 30 * 60 * 1000;                                             // ساعت جعلی باید جلو برود
  const ch = MD.oiChangePct('BTC', 1);
  assert.ok(Math.abs(ch - (1200 / 1050 - 1) * 100) < 0.01, `تغییر OI باید ۱۴.۲۸٪ باشد، بود ${ch}`);
  assert.equal(MD.oiChangePct('BTC', 0.05), null);                   // بازه‌ی خیلی کوتاه ⇒ null
  assert.equal(MD.recordOi('BTC', -5, NOW), false);                  // مقدار بی‌معنا ثبت نمی‌شود
  assert.equal(MD.oiChangePct('NOPE', 1), null);
});

test('کندل: ردیف خراب حذف و سری کوتاه رد می‌شود', () => {
  const rows = [];
  for(let i = 0; i < 40; i++) rows.push([i * 1e7, 100 + i, 101 + i, 99 + i, 100 + i, 5]);
  rows.push(['nan', 1, 1, 1, 1], [400, -5, 100, 90, 95], [401, 5, 1, 9, 5]);   // دامنه‌ی معکوس
  const cs = MD.rowsToCandles(rows);
  assert.equal(cs.length, 40);
  assert.equal(cs[0].length, 5);
  assert.equal(MD.rowsToCandles(rows.slice(0, 20)), null);           // ۲۰ کندل ⇒ بی‌معنا
  assert.equal(MD.rowsToCandles(null), null);
  assert.equal(MD.rowsToCandles({}), null);
});

test('سری حجم: تطبیق قیمت و حجم و رد سری کوتاه', () => {
  const prices = [], vols = [];
  for(let i = 0; i < 50; i++){ prices.push([i * 3600000, 100 + i]); vols.push([i * 3600000, 10 + i]); }
  const s = MD.priceVolumeSeries({ prices, total_volumes:vols });
  assert.equal(s.p.length, 50);
  assert.equal(s.v[49], 59);
  assert.equal(MD.priceVolumeSeries({ prices:prices.slice(0, 10), total_volumes:vols.slice(0, 10) }), null);
  assert.equal(MD.priceVolumeSeries({ prices, total_volumes:null }), null);
});

test('تاریخچه‌ی کلان: اسنپ‌شات فشرده و روند سلطه', () => {
  fresh();
  const snap = (dom, mcap, vol) => ({ market_cap_percentage:{ btc:dom }, total_market_cap:{ usd:mcap }, total_volume:{ usd:vol }, market_cap_change_percentage_24h_usd:1 });
  let h = MD.pushHistory([], snap(54, 2.0e12, 1e11), NOW);
  assert.equal(h.length, 1);
  h = MD.pushHistory(h, snap(54.2, 2.1e12, 1.2e11), NOW + 60 * 1000);   // فشرده‌سازی <۵ دقیقه
  assert.equal(h.length, 1);
  h = MD.pushHistory(h, snap(54.4, 2.2e12, 1.3e11), NOW + 10 * 60 * 1000);
  assert.equal(h.length, 2);
  assert.equal(MD.globalTrend(h, 24, NOW + 10 * 60 * 1000), null);      // بازه‌ی کوتاه ⇒ null
  h = MD.pushHistory(h, snap(55.1, 2.4e12, 1.5e11), NOW + 26 * 3600000);
  const tr = MD.globalTrend(h, 24, NOW + 26 * 3600000);
  assert.ok(tr.domChangePp > 0.5);
  /* مبنای مقایسه، نمونه‌ی ۱۰ دقیقه‌ای (۲.۲T) است چون هدف ۲۴ ساعت قبل، بعد از آن می‌افتد */
  assert.ok(Math.abs(tr.mcapChangePct - (2.4 / 2.2 - 1) * 100) < 0.01, `رشد ارزش کل: ${tr.mcapChangePct}`);
  assert.ok(tr.spanHours >= 24);
  assert.equal(MD.loadHistory().length, 3);                             // ماندگار شده است
  assert.equal(MD.pushHistory(h, null, NOW).length, 3);                 // ورودی خالی نادیده
  assert.equal(MD.globalTrend([], 24, NOW), null);
  assert.equal(MD.snapshot(null, NOW), null);
  assert.equal(MD.snapshot({ market_cap_percentage:{} }, NOW).btcDom, null);
});

test('شبکه: خطا به شیء خطا تبدیل می‌شود و هرگز استثنا پرت نمی‌کند', async () => {
  fresh();
  assert.deepEqual(await MD.getJSON('https://x'), { __error:true, status:0 });   // بدون fetch
  MD.setEnv({ fetchImpl:async () => ({ ok:false, status:429 }) });
  assert.deepEqual(await MD.getJSON('https://x'), { __error:true, status:429 });
  MD.setEnv({ fetchImpl:async () => { throw new Error('boom'); } });
  assert.equal((await MD.getJSON('https://x')).__error, true);
  MD.setEnv({ fetchImpl:async () => ({ ok:true, json:async () => ({ a:1 }) }) });
  assert.deepEqual(await MD.getJSON('https://x'), { a:1 });
});

test('میانه: زوج/فرد/خالی/آلوده', () => {
  assert.equal(MD.median([3, 1, 2]), 2);
  assert.equal(MD.median([4, 1, 3, 2]), 2.5);
  assert.equal(MD.median([]), null);
  assert.equal(MD.median([NaN, 'x', 5]), 5);
});
