/* =====================================================================
   analytics.js — توابع خالص تحلیل کندل/حجم (بدون وابستگی به DOM)

   چرا جدا؟ این توابع باید در Node هم قابل آزمون باشند (tests/analytics.test.mjs)
   و هم در مرورگر داخل app.js مصرف شوند. هیچ‌کدام شبکه یا state نمی‌خوانند.

   قرارداد داده:
   کندل = [time, open, high, low, close, volume?] — حجم اختیاری است.
   همه‌ی توابع در برابر داده‌ی ناقص/متناقض امن‌اند: خروجی null یا آرایه‌ی
   کوتاه می‌دهند و هرگز NaN تولید نمی‌کنند (NaN در امتیازدهی فاجعه است).

   نکته‌ی مهم: توابع «آخرین مقدار» (atrPct، volumeZ، ...) عدد می‌دهند و
   مصرف‌کننده باید null را به‌معنای «داده کافی نیست» بفهمد، نه صفر.
   ===================================================================== */
(function(root, factory){
  const API = factory();
  root.Analytics = API;
  if(typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  /* همیشه آرایه برمی‌گرداند (نه boolean): مصرف‌کننده‌ها روی خروجی .length
     می‌گیرند و false.length یعنی undefined — و مقایسه‌ی undefined با عدد
     همان NaN است، یعنی گارد رد می‌شود و کد روی ورودی خراب می‌ترکد. */
  function candlesOk(candles){
    if(!Array.isArray(candles)) return [];
    return candles.filter(c =>
      Array.isArray(c) && c.length >= 5 && isNum(c[1]) && isNum(c[2]) && isNum(c[3]) && isNum(c[4]) && c[1] > 0 && c[4] > 0
    );
  }
  function lastNum(arr){
    if(!Array.isArray(arr)) return null;
    for(let i = arr.length - 1; i >= 0; i--){ if(isNum(arr[i])) return arr[i]; }
    return null;
  }
  function prevNum(arr){
    if(!Array.isArray(arr)) return null;
    let seen = 0;
    for(let i = arr.length - 1; i >= 0; i--){
      if(isNum(arr[i])){ seen++; if(seen === 2) return arr[i]; }
    }
    return null;
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* ------------------------- میانگین‌ها ------------------------- */
  function sma(values, period){
    if(!Array.isArray(values) || period < 1) return [];
    const out = [];
    let sum = 0;
    for(let i = 0; i < values.length; i++){
      const v = isNum(values[i]) ? values[i] : null;
      if(v === null){ out.push(null); continue; }
      sum += v;
      if(i >= period) sum -= values[i - period];
      out.push(i >= period - 1 ? sum / period : null);
    }
    return out;
  }
  function ema(values, period){
    if(!Array.isArray(values) || period < 1) return [];
    const k = 2 / (period + 1), out = [];
    let prev = null;
    for(let i = 0; i < values.length; i++){
      const v = isNum(values[i]) ? values[i] : null;
      if(v === null){ out.push(prev); continue; }
      prev = prev === null ? v : v * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  }

  /* ------------------------- دامنه‌ی واقعی و ATR ------------------------- */
  function trueRange(candles){
    const cs = candlesOk(candles);
    const out = [];
    for(let i = 0; i < cs.length; i++){
      const [, , h, l] = cs[i];
      if(i === 0){ out.push(h - l); continue; }
      const pc = cs[i - 1][4];
      out.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    return out;
  }
  /* ATR وایلدر (میانگین متحرک نمایی با k=1/period) — همان تعریف استاندارد */
  function atr(candles, period = 14){
    const tr = trueRange(candles);
    if(tr.length < period + 1) return [];
    const out = new Array(tr.length).fill(null);
    let prev = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
    out[period - 1] = prev;
    for(let i = period; i < tr.length; i++){
      prev = (prev * (period - 1) + tr[i]) / period;
      out[i] = prev;
    }
    return out;
  }
  /* ATR به درصد آخرین کلوز — عددی که در سطوح حد ضرر مصرف می‌شود */
  function atrPct(candles, period = 14){
    const cs = candlesOk(candles);
    if(cs.length < period + 1) return null;
    const a = lastNum(atr(cs, period));
    const close = cs[cs.length - 1][4];
    return (isNum(a) && close > 0) ? (a / close) * 100 : null;
  }

  /* ------------------------- Supertrend ------------------------- */
  /* خروجی: آرایه‌ی {dir: 1|-1, line} — dir=1 یعنی روند صعودی. */
  function supertrend(candles, period = 10, mult = 3){
    const cs = candlesOk(candles);
    if(cs.length < period + 1) return [];
    const a = atr(cs, period), out = [];
    let dir = 1, upper = null, lower = null, line = null;
    for(let i = 0; i < cs.length; i++){
      const [, , h, l, c] = cs[i];
      const at = a[i];
      if(!isNum(at)){ out.push({ dir:null, line:null }); continue; }
      const hl2 = (h + l) / 2;
      let up = hl2 + mult * at, lo = hl2 - mult * at;
      const pc = i > 0 ? cs[i - 1][4] : c;
      if(upper !== null && isNum(upper)) up = (up < upper || pc > upper) ? up : upper;
      if(lower !== null && isNum(lower)) lo = (lo > lower || pc < lower) ? lo : lower;
      if(line === null) dir = c >= hl2 ? 1 : -1;
      else if(dir === 1) dir = c < lo ? -1 : 1;
      else dir = c > up ? 1 : -1;
      upper = up; lower = lo;
      line = dir === 1 ? lo : up;
      out.push({ dir, line });
    }
    return out;
  }

  /* ------------------------- ADX / DI ------------------------- */
  function adx(candles, period = 14){
    const cs = candlesOk(candles);
    const empty = { adx: [], plusDI: [], minusDI: [] };
    if(cs.length < period * 2 + 2) return empty;
    const tr = trueRange(cs);
    const plusDM = [], minusDM = [];
    for(let i = 1; i < cs.length; i++){
      const up = cs[i][2] - cs[i - 1][2], dn = cs[i - 1][3] - cs[i][3];
      plusDM.push(up > dn && up > 0 ? up : 0);
      minusDM.push(dn > up && dn > 0 ? dn : 0);
    }
    /* هموارسازی وایلدر روی tr/±DM (آرایه‌ها یک واحد از cs عقب‌اند) */
    const smooth = (arr) => {
      const out = new Array(arr.length).fill(null);
      let sum = 0;
      for(let i = 0; i < arr.length; i++){
        if(i < period){ sum += arr[i]; if(i === period - 1) out[i] = sum; }
        else out[i] = out[i - 1] - out[i - 1] / period + arr[i];
      }
      return out;
    };
    const trS = smooth(tr.slice(1)), pS = smooth(plusDM), mS = smooth(minusDM);
    const pdi = [], mdi = [], dx = [];
    for(let i = 0; i < trS.length; i++){
      if(!isNum(trS[i]) || trS[i] <= 0){ pdi.push(null); mdi.push(null); dx.push(null); continue; }
      const p = 100 * pS[i] / trS[i], m = 100 * mS[i] / trS[i];
      pdi.push(p); mdi.push(m);
      const s = p + m;
      dx.push(s > 0 ? 100 * Math.abs(p - m) / s : 0);
    }
    const adxOut = new Array(dx.length).fill(null);
    let seed = 0, count = 0;
    for(let i = 0; i < dx.length; i++){
      if(!isNum(dx[i])) continue;
      count++;
      if(count <= period){ seed += dx[i]; if(count === period) adxOut[i] = seed / period; }
      else adxOut[i] = (adxOut[i - 1] * (period - 1) + dx[i]) / period;
    }
    return { adx: adxOut, plusDI: pdi, minusDI: mdi };
  }

  /* ------------------------- جریان پول: MFI و CMF ------------------------- */
  /* MFI = RSI وزنی حجم روی قیمت معمول. کمبود حجم ⇒ null. */
  function mfi(candles, period = 14){
    const cs = candlesOk(candles).filter(c => isNum(c[5]) && c[5] >= 0);
    if(cs.length < period + 1) return [];
    const out = new Array(cs.length).fill(null);
    const pv = cs.map(c => ((c[2] + c[3] + c[4]) / 3) * c[5]);
    for(let i = period; i < cs.length; i++){
      let pos = 0, neg = 0;
      for(let j = i - period + 1; j <= i; j++){
        const tp = (cs[j][2] + cs[j][3] + cs[j][4]) / 3, ptp = (cs[j - 1][2] + cs[j - 1][3] + cs[j - 1][4]) / 3;
        if(tp > ptp) pos += pv[j]; else if(tp < ptp) neg += pv[j];
      }
      out[i] = neg === 0 ? (pos === 0 ? 50 : 100) : 100 - 100 / (1 + pos / neg);
    }
    return out;
  }
  /* CMF (Chaikin Money Flow): فشار خرید/فروش وزنی حجم در بازه. */
  function cmf(candles, period = 20){
    const cs = candlesOk(candles).filter(c => isNum(c[5]) && c[5] >= 0);
    if(cs.length < period) return [];
    const mfv = cs.map(c => {
      const range = c[2] - c[3];
      const m = range > 0 ? ((c[4] - c[3]) - (c[2] - c[4])) / range : 0;
      return m * c[5];
    });
    const out = new Array(cs.length).fill(null);
    for(let i = period - 1; i < cs.length; i++){
      let num = 0, den = 0;
      for(let j = i - period + 1; j <= i; j++){ num += mfv[j]; den += cs[j][5]; }
      out[i] = den > 0 ? num / den : null;
    }
    return out;
  }
  /* OBV و شیب نرمال‌شده‌ی آن در بازه‌ی آخر (نسبت به حجم میانگین) */
  function obv(candles){
    const cs = candlesOk(candles).filter(c => isNum(c[5]));
    if(cs.length < 2) return [];
    const out = [0];
    for(let i = 1; i < cs.length; i++){
      const dir = cs[i][4] > cs[i - 1][4] ? 1 : cs[i][4] < cs[i - 1][4] ? -1 : 0;
      out.push(out[i - 1] + dir * cs[i][5]);
    }
    return out;
  }
  function obvSlope(candles, period = 24){
    const cs = candlesOk(candles).filter(c => isNum(c[5]));
    const o = obv(cs);
    if(o.length < period + 1) return null;
    const n = period;
    const xs = [], ys = [];
    for(let i = o.length - n; i < o.length; i++){ xs.push(i); ys.push(o[i]); }
    const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
    let num = 0, den = 0;
    for(let i = 0; i < n; i++){ num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
    if(den === 0) return null;
    const slope = num / den;
    const vols = cs.slice(-period).map(c => c[5]).filter(isNum);
    const avgVol = vols.length ? vols.reduce((s, v) => s + v, 0) / vols.length : 0;
    return avgVol > 0 ? slope / avgVol : null;   // «شیب بر حسب حجم میانگین» — مقیاس‌پذیر
  }

  /* ------------------------- حجم ------------------------- */
  /* z-score حجم آخرین کندل نسبت به پنجره. کف انحراف معیار از تقسیم بر صفر
     و انفجار عددی جلوگیری می‌کند؛ خروجی برای پنجره‌ی کاملاً تخت صفر است. */
  function volumeZ(candles, period = 48){
    const cs = candlesOk(candles).filter(c => isNum(c[5]));
    if(cs.length < Math.min(period, 12) + 1 || cs.length < 12) return null;
    const win = cs.slice(-Math.min(period, cs.length)).map(c => c[5]);
    const mean = win.reduce((s, v) => s + v, 0) / win.length;
    if(!(mean > 0)) return null;
    const sd = Math.sqrt(win.reduce((s, v) => s + (v - mean) ** 2, 0) / win.length);
    const floor = 0.02 * Math.max(1, Math.abs(mean));
    const z = (win[win.length - 1] - mean) / Math.max(sd, floor);
    return clamp(z, -8, 8);
  }
  function volumeRatio(candles, period = 48){
    const cs = candlesOk(candles).filter(c => isNum(c[5]));
    if(cs.length < 12) return null;
    const win = cs.slice(-Math.min(period, cs.length)).map(c => c[5]);
    const mean = win.reduce((s, v) => s + v, 0) / win.length;
    return mean > 0 ? win[win.length - 1] / mean : null;
  }

  /* ------------------------- ساختار سایه‌دار ------------------------- */
  /* پیوت‌های تأییدشده: سقف/کفی که «right» کندل بعدی آن را نشکسته باشد.
     برخلاف حمایت/مقاومت قبلی (که فقط از کلوز ساخته می‌شد) این‌ها سایه‌ی
     واقعی دارند و بنابراین حد ضرر منطقی‌تری می‌دهند. */
  function swingPivots(candles, left = 3, right = 3){
    const cs = candlesOk(candles);
    const highs = [], lows = [];
    for(let i = left; i < cs.length - right; i++){
      const h = cs[i][2], l = cs[i][3];
      let isHigh = true, isLow = true;
      for(let j = i - left; j <= i + right; j++){
        if(j === i) continue;
        if(cs[j][2] >= h) isHigh = false;
        if(cs[j][3] <= l) isLow = false;
      }
      if(isHigh) highs.push({ i, price:h, time:cs[i][0] });
      if(isLow) lows.push({ i, price:l, time:cs[i][0] });
    }
    return { highs, lows };
  }
  /* شکست دامنه‌ی lookback کندل آخر: سقف/کف دامنه + وضعیت شکست.
     مقدار state فقط وقتی 'up'/'down' می‌شود که کلوز آخرین کندل بیرون دامنه
     باشد؛ در غیر این صورت null (داخل دامنه). */
  function rangeBreakout(candles, lookback = 6){
    const cs = candlesOk(candles);
    if(cs.length < lookback + 1) return null;
    const win = cs.slice(-(lookback + 1), -1);
    const high = Math.max(...win.map(c => c[2]));
    const low = Math.min(...win.map(c => c[3]));
    const last = cs[cs.length - 1];
    const state = last[4] > high ? 'up' : last[4] < low ? 'down' : null;
    return { state, high, low, close:last[4] };
  }

  /* ------------------------- VWAP ------------------------- */
  function vwap(candles){
    const cs = candlesOk(candles).filter(c => isNum(c[5]) && c[5] > 0);
    if(cs.length < 12) return null;
    let pv = 0, v = 0;
    cs.forEach(c => { const tp = (c[2] + c[3] + c[4]) / 3; pv += tp * c[5]; v += c[5]; });
    return v > 0 ? pv / v : null;
  }

  /* ------------------------- تبدیل سری قیمت به کندل ------------------------- */
  /* CoinGecko در market_chart فقط کلوز ساعتی و حجم می‌دهد. از دو کلوز متوالی
     یک کندل تقریبی می‌سازیم: open=قیمت قبلی، high/low=max/min(open,close).
     این کندل‌ها برای ATR کاربرد ندارند (دامنه را کم‌برآورد می‌کنند) اما برای
     MFI/CMF/OBV/VWAP حجم‌محور کافی‌اند — و در کد هم همین‌طور مصرف می‌شوند. */
  function candlesFromSeries(prices, volumes, times){
    if(!Array.isArray(prices) || prices.length < 2) return [];
    const vol = Array.isArray(volumes) ? volumes : [];
    const out = [];
    for(let i = 1; i < prices.length; i++){
      const o = prices[i - 1], c = prices[i];
      if(!isNum(o) || !isNum(c) || o <= 0 || c <= 0) continue;
      const v = isNum(vol[i]) && vol[i] >= 0 ? vol[i] : null;
      const t = isNum(times?.[i]) ? times[i] : i;
      out.push([t, o, Math.max(o, c), Math.min(o, c), c, v]);
    }
    return out;
  }

  return { sma, ema, trueRange, atr, atrPct, supertrend, adx, mfi, cmf, obv, obvSlope,
    volumeZ, volumeRatio, swingPivots, rangeBreakout, vwap, candlesFromSeries,
    lastNum, prevNum };
});
