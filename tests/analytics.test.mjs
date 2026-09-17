/* =====================================================================
   آزمون توابع خالص analytics.js
   اجرا:  node --test tests/analytics.test.mjs
   همه‌ی انتظارها «پاسخ معلوم»اند: یا از فرمول دستی می‌آیند یا از هندسه‌ی
   کندل‌های ساختگی. هیچ آزمونی به شبکه یا DOM نیاز ندارد.
   ===================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const A = require('../analytics.js');

/* کندل ساز کمکی: [time, open, high, low, close, volume] */
const C = (h, l, c, v = 1000, o = null) => [0, o ?? c, h, l, c, v];
const flat = (n = 40, price = 100, v = 1000) => Array.from({length:n}, (_, i) => [i, price, price + 1, price - 1, price, v]);
/* روند با دامنه‌ی ۲ و بدنه‌ی ۱: هر کندل نسبت به قبلی ۱ واحد بالا می‌رود */
const step = (n = 40, start = 100, d = 1) => Array.from({length:n}, (_, i) => {
  const o = start + i * d, c = o + d;
  return [i, o, Math.max(o, c) + 1, Math.min(o, c) - 1, c, 1000 + i];
});

test('ATR: کندل تخت ATR=دامنه و درصدش درست است', () => {
  assert.equal(A.lastNum(A.atr(flat(40), 14)), 2);          // H-L = 2
  assert.equal(A.atrPct(flat(40), 14), 2);                  // 2/100
  assert.equal(A.atrPct(flat(5), 14), null);                // داده کم ⇒ null نه NaN
});

test('ATR: گپ صعودی دامنه‌ی واقعی را بزرگ می‌کند (true range)', () => {
  const cs = [...flat(20), C(130, 120, 125)];               // کلوز قبلی ۱۰۰، این کندل تا ۱۳۰
  const tr = A.trueRange(cs);
  assert.equal(tr[tr.length - 1], 30);                      // max(10, |130-100|, |120-100|)
  assert.ok(A.atrPct(cs, 14) > 2);
});

test('Supertrend: روند صعودی +1 و روند نزولی −1 می‌دهد', () => {
  assert.equal(A.lastNum(A.supertrend(step(60), 10, 3).map(x => x.dir)), 1);
  assert.equal(A.lastNum(A.supertrend(step(60, 200, -1), 10, 3).map(x => x.dir)), -1);
});

test('ADX: روند یک‌جهته ADX بالا و DI منطبق می‌دهد', () => {
  const adxUp = A.adx(step(60), 14);
  const last = A.lastNum(adxUp.adx);
  assert.ok(last > 50, `ADX روند یک‌جهته باید بالا باشد، بود: ${last}`);
  assert.ok(A.lastNum(adxUp.plusDI) > A.lastNum(adxUp.minusDI));
  const adxChop = A.adx(flat(60), 14);
  assert.ok(A.lastNum(adxChop.adx) < 30, 'ADX بازار تخت باید پایین باشد');
});

test('MFI: جریان پولی یک‌طرفه به ۱۰۰/۰ همگرا می‌شود', () => {
  assert.equal(A.lastNum(A.mfi(step(40, 100, 1), 14)), 100);
  const down = A.lastNum(A.mfi(step(40, 100, -1), 14));
  assert.ok(down < 1, `MFI نزولی باید نزدیک صفر باشد، بود: ${down}`);
});

test('CMF: بسته‌شدن روی سقف +۱ و روی کف −۱ است', () => {
  const up = Array.from({length:30}, (_, i) => C(110 + i, 90 + i, 110 + i));
  const dn = Array.from({length:30}, (_, i) => C(110 + i, 90 + i, 90 + i));
  assert.equal(A.lastNum(A.cmf(up, 20)), 1);
  assert.equal(A.lastNum(A.cmf(dn, 20)), -1);
});

test('OBV: حرکت تجمعی حجم در جهت کلوز است', () => {
  const cs = [[0, 10, 10, 9, 10, 100], [0, 12, 12, 10, 12, 100], [0, 11, 11, 10, 11, 100], [0, 13, 13, 11, 13, 100]];
  assert.deepEqual(A.obv(cs), [0, 100, 0, 100]);
  assert.ok(A.obvSlope(step(40), 24) > 0, 'شیب OBV در روند صعودی باید مثبت باشد');
});

test('حجم: z-score و نسبت حجم روی مقدار معلوم', () => {
  const base = Array.from({length:48}, (_, i) => C(100, 99, 100, 1000));
  const win = [...base, C(100, 99, 100, 3000)];             // آخرین حجم ۳ برابر
  /* z = (3000 − میانگین) / انحراف معیار = 6.856 و نسبت حجم = 2.88 — دستی محاسبه شده */
  assert.ok(Math.abs(A.volumeZ(win, 48) - 6.8557) < 0.01, String(A.volumeZ(win, 48)));
  assert.ok(Math.abs(A.volumeRatio(win, 48) - 2.88) < 0.01);
  assert.equal(A.volumeZ(flat(48), 48), 0);                  // پنجره‌ی تخت ⇒ صفر، نه null
  assert.equal(A.volumeZ([C(1,1,1,1)], 48), null);           // داده کم ⇒ null
});

test('پیوت‌های تأییدشده: سقف و کف زیگزاگ با سایه‌ی واقعی پیدا می‌شوند', () => {
  /* زیگزاگ دستی: صعود به ۱۰۵، کندل قله با سایه تا ۱۱۰، ریزش، کندل کف با
     سایه تا ۹۰، و صعود دوباره. هیچ سایه‌ای با هم مساوی نیست تا آزمون قطعی باشد. */
  const cs = [];
  const push = (h, l, c) => cs.push([cs.length, c, h, l, c, 10]);
  for(let i = 0; i < 6; i++) push(100 + i, 99 + i, 100 + i);
  push(110, 107, 108);
  for(let i = 0; i < 6; i++) push(106 - i, 105 - i, 106 - i);
  push(96, 90, 92);
  for(let i = 0; i < 6; i++) push(100 + i, 99 + i, 100 + i);
  const p = A.swingPivots(cs, 3, 3);
  assert.ok(p.highs.length >= 1 && p.lows.length >= 1);
  const peak = p.highs[p.highs.length - 1], trough = p.lows[p.lows.length - 1];
  assert.equal(peak.price, 110);
  assert.equal(trough.price, 90);
  assert.ok(trough.i > peak.i, 'کف باید بعد از سقف باشد');
});

test('شکست دامنه: سقف/کف دامنه و وضعیت درست', () => {
  const inside = [...Array.from({length:10}, (_, i) => C(105, 95, 100, 10)), C(106, 96, 100, 10)];
  assert.equal(A.rangeBreakout(inside, 6).state, null);
  const up = [...Array.from({length:10}, (_, i) => C(105, 95, 100, 10)), C(120, 110, 119, 10)];
  const brkUp = A.rangeBreakout(up, 6);
  assert.equal(brkUp.state, 'up');
  assert.equal(brkUp.high, 105);
  const dn = [...Array.from({length:10}, (_, i) => C(105, 95, 100, 10)), C(90, 80, 81, 10)];
  assert.equal(A.rangeBreakout(dn, 6).state, 'down');
});

test('VWAP: میانگین وزنی حجمی روی مقدار معلوم', () => {
  /* ۱۱ کندل با قیمت معمول ۱۱ و حجم ۱، به‌علاوه یک کندل ۱۹ با حجم ۹
     ⇒ (11*11 + 19*9) / 20 = 14.6 */
  const cs = [...Array.from({length:11}, () => C(12, 10, 11, 1)), C(20, 18, 19, 9)];
  assert.ok(Math.abs(A.vwap(cs) - 14.6) < 1e-9);
  assert.equal(A.vwap([C(10, 9, 9.5, 0)]), null);            // حجم صفر ⇒ null
});

test('سری قیمت→کندل: جفت‌های متوالی و حذف ردیف خراب', () => {
  const out = A.candlesFromSeries([100, 110, 105], [10, 20, 30]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], [1, 100, 110, 100, 110, 20]);
  assert.deepEqual(out[1], [2, 110, 110, 105, 105, 30]);
  assert.deepEqual(A.candlesFromSeries([100, NaN, 105], [1, 2, 3]), []);
  assert.deepEqual(A.candlesFromSeries(null, null), []);
});

test('ورودی بی‌معنا هیچ‌وقت NaN نمی‌سازد', () => {
  const junk = [null, [], ['x'], [1, NaN, 2, 1, 1], [2, -1, 5, 4, 4]];
  for(const fn of [() => A.atrPct(junk, 14), () => A.volumeZ(junk, 48), () => A.lastNum(A.cmf(junk, 20)),
    () => A.vwap(junk), () => A.lastNum(A.mfi(junk, 14)), () => A.obvSlope(junk, 24)]){
    const v = fn();
    assert.ok(v === null || Number.isFinite(v), `خروجی نامعتبر: ${v}`);
  }
  assert.equal(A.atrPct(null, 14), null);
  assert.equal(A.volumeRatio(undefined, 48), null);
  assert.deepEqual(A.sma([], 5), []);
});

test('میانگین‌ها: SMA و EMA روی مقدار معلوم', () => {
  assert.deepEqual(A.sma([1, 2, 3, 4], 2), [null, 1.5, 2.5, 3.5]);
  const e = A.ema([1, 2, 3], 2);                             // k=2/3 ⇒ 1, 1.667, 2.556
  assert.ok(Math.abs(e[2] - 2.5556) < 0.001);
});

test('lastNum/prevNum: پرش از null و مقدار نامعتبر', () => {
  assert.equal(A.lastNum([1, null, NaN, 5]), 5);
  assert.equal(A.prevNum([1, 2, null, 5]), 2);
  assert.equal(A.lastNum([null, NaN]), null);
  assert.equal(A.prevNum([7]), null);
});
