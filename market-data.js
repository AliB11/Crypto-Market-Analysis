/* =====================================================================
   market-data.js — لایه‌ی داده‌ی غنی‌شده: مشتقات، کندل، حجم، تاریخچه‌ی کلان

   اصول طراحی (همه از بازبینی محصول بیرون آمده‌اند):
   ۱) اپ استاتیک است و بک‌اند ندارد؛ پس هر داده‌ی تازه باید از همان دامنه‌ی
      مجاز CSP و بدون کلید API بیاید.
   ۲) بودجه‌ی فراخوان محدود است. هر فراخوان از یک «کیف پول ساعتی» کم می‌شود
      و در صورت خطای 429 پشتیبان‌گیری نمایی فعال می‌شود.
   ۳) هیچ داده‌ای «حیاتی» نیست: اگر نبود، مصرف‌کننده باید مثل قبل کار کند.
      بنابراین همه‌ی توابع در بدترین حالت null/{ok:false} برمی‌گردانند.
   ۴) ماژول خالصِ محیط است: storage/fetch/now تزریق‌پذیرند تا در Node و
      بدون شبکه آزمون‌پذیر باشد (tests/marketdata.test.mjs).
   ===================================================================== */
(function(root, factory){
  const API = factory(root);
  root.MarketData = API;
  if(typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root){
  const VERSION = 1;
  const NS = 'cbmd:';

  /* ------------------------- پروفایل بودجه -------------------------
     هر «ارز غنی‌شده» دو فراخوان است (کندل + سری حجم). پس فاصله‌ی زمانی بین
     فراخوان‌ها = ۳۶۰۰ ثانیه تقسیم بر (تعداد ارز در ساعت × ۲).
     اقتصادی = ۶ ارز/ساعت (۴.۵ دقیقه بین فراخوان‌ها)
     متعادل  = ۲۰ ارز/ساعت (۹۰ ثانیه)  ← پیش‌فرض
     کامل    = ۴۰ ارز/ساعت (۴۵ ثانیه) */
  const PROFILES = {
    eco:      { k:'eco',      label:'اقتصادی', coinsPerHour:6  },
    balanced: { k:'balanced', label:'متعادل', coinsPerHour:20 },
    full:     { k:'full',     label:'کامل',   coinsPerHour:40 }
  };
  const DEFAULT_PROFILE = 'balanced';

  const TTL = {
    deriv:  5 * 60 * 1000,    // مشتقات: ۵ دقیقه (سمت سرور هر ۳۰ ثانیه تازه می‌شود)
    ohlc:   45 * 60 * 1000,   // کندل ۴ساعته: ۴۵ دقیقه
    chart:  45 * 60 * 1000,   // سری ساعتی + حجم: ۴۵ دقیقه
    derivGap: 150 * 1000,     // کمترین فاصله‌ی دو فراخوان مشتقات در دو چرخه‌ی پیوسته
    globalSnapGap: 5 * 60 * 1000
  };
  const LIMITS = { ohlc:80, chart:80, deriv:4, oi:40, oiSamples:24, hist:96, histSpanHours:72 };

  /* آستانه‌های ازدحام — محافظه‌کارانه و متمرکز بر «فاندینگ داغ + OI صعودی».
     سالانه‌سازی با فرض ۳ تسویه در روز (هر ۸ ساعت)؛ یعنی ۰.۰۱٪ هر ۸ ساعت ≈ ۱۰.۹٪ سالانه. */
  const THRESHOLDS = {
    fundingWarm   : 30,   // درصد سالانه
    fundingHot    : 55,
    fundingNegWarm: -20,
    fundingNegHot: -40
  };

  /* ------------------------- محیط قابل تزریق ------------------------- */
  const env = {
    storage: (typeof localStorage !== 'undefined' ? localStorage : null),
    fetchImpl: (typeof fetch !== 'undefined' ? fetch : null),
    now: () => Date.now()
  };
  function setEnv(patch){ Object.assign(env, patch || {}); }
  function nowMs(){ try { return env.now(); } catch(e){ return Date.now(); } }

  /* ------------------------- کش ------------------------- */
  function read(key){
    try { const raw = env.storage && env.storage.getItem(NS + key); return raw ? JSON.parse(raw) : null; }
    catch(e){ return null; }
  }
  function write(key, value){
    try { env.storage && env.storage.setItem(NS + key, JSON.stringify(value)); return true; }
    catch(e){ return false; }
  }
  function drop(key){ try { env.storage && env.storage.removeItem(NS + key); } catch(e){} }

  function cacheSet(kind, id, data){
    write('cache:' + kind + ':' + id, { t: nowMs(), d: data });
    cachePrune(kind, LIMITS[kind] || 40);
  }
  function cacheGet(kind, id, maxAge){
    const rec = read('cache:' + kind + ':' + id);
    if(!rec || !Number.isFinite(rec.t)) return null;
    const age = nowMs() - rec.t;
    if(age < 0 || age > (Number.isFinite(maxAge) ? maxAge : (TTL[kind] ?? Infinity))) return null;
    return rec.d;
  }
  function cacheAge(kind, id){
    const rec = read('cache:' + kind + ':' + id);
    return rec && Number.isFinite(rec.t) ? Math.max(0, nowMs() - rec.t) : null;
  }
  /* سقف تعداد کلیدها: قدیمی‌ترین‌ها حذف می‌شوند. کلید «oi:» تاریخچه‌ی OI است. */
  function cachePrune(kind, max){
    try {
      if(!env.storage) return 0;
      const prefix = NS + 'cache:' + kind + ':', hits = [];
      for(let i = 0; i < env.storage.length; i++){
        const k = env.storage.key(i);
        if(k && k.indexOf(prefix) === 0){
          const rec = read(k.slice(NS.length));
          hits.push({ k, t: rec && Number.isFinite(rec.t) ? rec.t : 0 });
        }
      }
      if(hits.length <= max) return 0;
      hits.sort((a, b) => a.t - b.t);
      const kill = hits.slice(0, hits.length - max);
      kill.forEach(h => env.storage.removeItem(h.k));
      return kill.length;
    } catch(e){ return 0; }
  }
  function cacheSummary(){
    const out = {};
    try {
      if(!env.storage) return out;
      for(let i = 0; i < env.storage.length; i++){
        const k = env.storage.key(i);
        if(k && k.indexOf(NS) === 0){
          const kind = k.slice(NS.length).split(':')[0];
          out[kind] = (out[kind] || 0) + 1;
        }
      }
    } catch(e){}
    return out;
  }
  function cacheClear(){
    try {
      if(!env.storage) return;
      const keys = [];
      for(let i = 0; i < env.storage.length; i++){
        const k = env.storage.key(i);
        if(k && k.indexOf(NS) === 0) keys.push(k);
      }
      keys.forEach(k => env.storage.removeItem(k));
    } catch(e){}
  }

  /* ------------------------- بودجه‌ی فراخوان ------------------------- */
  const budget = { last:0, lastDeriv:0, callsToday:0, day:'', backoff:1, throttledUntil:0 };

  function profileKey(){
    const saved = read('profile');
    return PROFILES[saved] ? saved : DEFAULT_PROFILE;
  }
  function setProfile(k){ if(PROFILES[k]) write('profile', k); }
  function profile(){ return PROFILES[profileKey()]; }
  function gapMs(){ return Math.round(3600000 / (profile().coinsPerHour * 2)); }

  /* kind='deriv' پنجره‌ی مستقل خودش را دارد: مشتقات یک فراخوان در هر ۲.۵ دقیقه
     است و نباید سهم غنی‌سازی ارزها را مصرف کند. */
  function canEnrich(t, kind){
    const now = t ?? nowMs();
    if(now < budget.throttledUntil) return false;
    const gap = kind === 'deriv' ? TTL.derivGap : gapMs();
    const last = kind === 'deriv' ? budget.lastDeriv : budget.last;
    return (now - last) >= gap * budget.backoff;
  }
  function noteCall(t, kind){
    const now = t ?? nowMs();
    if(kind === 'deriv') budget.lastDeriv = now; else budget.last = now;
    const day = new Date(now).toISOString().slice(0, 10);
    if(day !== budget.day){ budget.day = day; budget.callsToday = 0; }
    budget.callsToday++;
    write('usage', { day, calls: budget.callsToday });
  }
  /* پشتیبان‌گیری نمایی: ۴۲۹ یعنی «آرام بگیر»، نه «تلاش دوباره». */
  function backoffOn(is429){
    if(is429){ budget.backoff = Math.min((budget.backoff || 1) * 2, 8); budget.throttledUntil = nowMs() + 120000; }
    else budget.backoff = Math.max(1, (budget.backoff || 1) / 2);
    return budget.backoff;
  }
  function budgetState(){
    const t = nowMs();
    return { profile: profileKey(), gapMs: gapMs(), last: budget.last, lastDeriv: budget.lastDeriv, callsToday: budget.callsToday,
      backoff: budget.backoff, throttledForMs: Math.max(0, budget.throttledUntil - t) };
  }
  function restoreUsage(){
    const u = read('usage');
    if(u && u.day === new Date(nowMs()).toISOString().slice(0, 10)) budget.callsToday = u.calls || 0;
    return budget.callsToday;
  }
  function resetBudget(){ budget.last = 0; budget.lastDeriv = 0; budget.backoff = 1; budget.throttledUntil = 0; budget.callsToday = 0; budget.day = ''; }

  /* ------------------------- صف غنی‌سازی ------------------------- */
  /* صف نگه‌داشته می‌شود تا اگر کاربر صفحه را بست، دور بعد از همان‌جا ادامه
     دهد. اولویت کمتر = مهم‌تر (۰ واچ‌لیست … ۴ امتیاز متوسط). */
  /* شکست‌های پشت‌سرهم: اگر endpoint برای ارزی خراب باشد، تلاش بی‌پایان فقط
     بودجه‌ی فراخوان را می‌سوزاند. پس شمارنده‌ی خطا نگه می‌داریم: cool‌دان
     رشد می‌کند (۵ دقیقه → ۳۰ دقیقه → ۶ ساعت) و بعد از سه خطا، ارز تا ۲۴
     ساعت دوباره برنامه‌ریزی نمی‌شود. */
  const FAIL_COOLDOWN = [5 * 60 * 1000, 30 * 60 * 1000, 6 * 3600 * 1000];
  const FAIL_GIVE_UP = 24 * 3600 * 1000;
  function plan(list){
    if(!Array.isArray(list)) return [];
    const prev = {};
    loadQueue().forEach(x => { prev[x.id] = x; });
    const now = nowMs();
    const items = [];
    list.forEach(x => {
      if(!x || !x.id) return;
      const id = String(x.id), old = prev[id];
      const f = old && Number.isFinite(old.f) ? old.f : 0;
      const lastFail = old && Number.isFinite(old.lastFail) ? old.lastFail : 0;
      /* سه خطا ⇒ رها کن، ولی پس از یک روز دوباره شانس بده (ممکن است موقتی بوده) */
      if(f >= 3 && now - lastFail < FAIL_GIVE_UP) return;
      items.push({ id, p:Number.isFinite(x.p) ? x.p : 9, t:(old && old.t) || now, f:f >= 3 ? 0 : f, lastFail });
    });
    write('queue', items);
    return items;
  }
  function loadQueue(){
    const q = read('queue');
    return Array.isArray(q) ? q.filter(x => x && x.id) : [];
  }
  function fail(id){
    const key = String(id);
    const q = loadQueue().map(x => x.id === key
      ? Object.assign({}, x, { f:(Number.isFinite(x.f) ? x.f : 0) + 1, lastFail:nowMs() })
      : x);
    write('queue', q);
    return q.find(x => x.id === key) || null;
  }
  function next(){
    const q = loadQueue();
    if(!q.length) return null;
    const now = nowMs();
    const ready = q.filter(x => {
      const f = Number.isFinite(x.f) ? x.f : 0;
      if(!f || !Number.isFinite(x.lastFail)) return true;
      return (now - x.lastFail) >= FAIL_COOLDOWN[Math.min(f, FAIL_COOLDOWN.length) - 1];
    });
    if(!ready.length) return null;
    const sorted = ready.slice().sort((a, b) => (a.p - b.p) || (a.t - b.t));
    return sorted[0].id;
  }
  function dropFromQueue(id){
    const q = loadQueue().filter(x => x.id !== id);
    write('queue', q);
    return q.length;
  }
  function pendingCount(){ return loadQueue().length; }
  function pendingIds(){ return loadQueue().map(x => x.id); }
  function clearQueue(){ write('queue', []); }

  /* ------------------------- شبکه ------------------------- */
  /* هر خطا به شیء {__error:true, status} تبدیل می‌شود تا مصرف‌کننده هیچ‌گاه
     به try/catch نیاز نداشته باشد و پیام خطای شبکه به منطق تحلیل نفوذ نکند. */
  async function getJSON(url, timeoutMs = 15000){
    if(!env.fetchImpl) return { __error:true, status:0 };
    let timer = null;
    try{
      const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      if(ctrl) timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const r = await env.fetchImpl(url, ctrl ? { signal: ctrl.signal } : undefined);
      if(!r || !r.ok) return { __error:true, status:(r && r.status) || 0 };
      return await r.json();
    }catch(e){
      return { __error:true, status:0 };
    }finally{ if(timer) clearTimeout(timer); }
  }

  /* ------------------------- نرمال‌سازی مشتقات ------------------------- */
  /* CoinGecko برای هر قرارداد فیوچرز یک ردیف می‌دهد: funding_rate (هر دوره)،
     open_interest (دلار)، volume_24h، basis و spread. آلفای ما «میانه‌ی
     فاندینگ در بازارها» است تا یک صرافی با فاندینگ افراطی، کل نتیجه را
     نچرخاند. فیوچرزهای تاریخ‌دار (futures) کنار گذاشته می‌شوند. */
  function median(arr){
    const v = arr.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if(!v.length) return null;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }
  /* سالانه‌سازی با فرض ۸ ساعت (۳ تسویه در روز). اگر بازار با دوره‌ی دیگری
     باشد، خطای آن در حد ضریب ۲-۳ است و آستانه‌ها محافظه‌کارانه انتخاب شده‌اند. */
  function annualize(rate, hoursPerInterval = 8){
    if(!Number.isFinite(rate)) return null;
    return rate * (24 / hoursPerInterval) * 365 * 100;
  }
  const QUOTE_RE = /(USDT|USDC|BUSD|USD|PERP|SWAP|PERPETUAL)+$/;
  const STABLE_RE = /^(USDT|USDC|BUSD|DAI|TUSD|FDUSD|USDE|PYUSD|USDD|FRAX|GUSD|LUSD|USDP|EURC|EURT|XAU|PAXG)$/;
  /* کلید خروجی، «نماد پایه» است (BTC نه BTCUSDT) تا با symbol ارزهای
     CoinGecko که در app.js داریم قابل تطبیق باشد. چند صرافی روی یک کلید
     جمع می‌شوند و شمرده می‌شوند. */
  function derivativesBySymbol(rows){
    const out = {};
    if(!Array.isArray(rows)) return out;
    rows.forEach(r => {
      if(!r || typeof r !== 'object') return;
      if(String(r.contract_type || 'perpetual').toLowerCase() !== 'perpetual') return;
      const sym = String(r.symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if(!sym) return;
      const base = sym.replace(QUOTE_RE, '') || sym;
      if(!base || STABLE_RE.test(base)) return;        // جفت ارز/استیبل‌کوین ⇒ مبنای تحلیل نیست
      const e = out[base] || (out[base] = { base, symbol:base, markets:[], _f:[], _fa:[], _oi:[], _vol:[], _b:[], _s:[] });
      if(e.markets.indexOf(sym) < 0) e.markets.push(sym);
      const fr = Number(r.funding_rate);
      if(Number.isFinite(fr)){ e._f.push(fr); e._fa.push(annualize(fr)); }
      const oi = Number(r.open_interest);
      if(Number.isFinite(oi) && oi > 0) e._oi.push(oi);
      const v = Number(r.volume_24h);
      if(Number.isFinite(v) && v > 0) e._vol.push(v);
      const b = Number(r.basis);
      if(Number.isFinite(b)) e._b.push(b);
      const s = Number(r.spread);
      if(Number.isFinite(s)) e._s.push(s);
    });
    Object.keys(out).forEach(base => {
      const e = out[base];
      if(!e._fa.length && !e._oi.length){ delete out[base]; return; }   // ردیف بی‌داده ⇒ دور ریخته می‌شود
      e.venues = e._f.length;
      e.fundingMedian = median(e._f);
      e.fundingAnnual = median(e._fa);
      e.fundingPct = e.fundingMedian != null ? e.fundingMedian * 100 : null;
      e.oiUsd = e._oi.length ? e._oi.reduce((s, v) => s + v, 0) : null;
      e.vol24Usd = e._vol.length ? e._vol.reduce((s, v) => s + v, 0) : null;
      e.basisPct = median(e._b);
      e.spreadPct = median(e._s);
      delete e._f; delete e._fa; delete e._oi; delete e._vol; delete e._b; delete e._s;
    });
    return out;
  }

  /* ------------------------- تاریخچه‌ی OI -------------------------
     تغییر OI بدون تاریخچه معنا ندارد؛ یک اسنپ‌شات در روز اول فقط «سطح» است.
     به‌ازای هر نماد حداکثر ۲۴ نمونه نگه می‌داریم و اگر فاصله‌ی نمونه‌ها
     کمتر از ۴ دقیقه باشد، نمونه‌ی قبلی به‌روزرسانی می‌شود (نویز حذف). */
  const OI_MIN_GAP = 240 * 1000;
  function recordOi(symbol, oiUsd, t){
    const sym = String(symbol || '').toUpperCase();
    if(!sym || !Number.isFinite(oiUsd) || oiUsd <= 0) return false;
    const now = t ?? nowMs();
    const hist = read('oi:' + sym);
    const arr = Array.isArray(hist) ? hist.filter(x => Array.isArray(x) && Number.isFinite(x[0]) && Number.isFinite(x[1])) : [];
    const lastPt = arr[arr.length - 1];
    if(lastPt && now - lastPt[0] < OI_MIN_GAP) lastPt[1] = oiUsd;
    else arr.push([now, oiUsd]);
    while(arr.length > LIMITS.oiSamples) arr.shift();
    write('oi:' + sym, arr);
    pruneOi();
    return true;
  }
  function pruneOi(){
    try{
      if(!env.storage) return;
      const hits = [];
      for(let i = 0; i < env.storage.length; i++){
        const k = env.storage.key(i);
        if(k && k.indexOf(NS + 'oi:') === 0){
          const rec = read(k.slice(NS.length));
          const last = Array.isArray(rec) && rec.length ? rec[rec.length - 1] : null;
          hits.push({ k, t: last && Number.isFinite(last[0]) ? last[0] : 0 });
        }
      }
      if(hits.length <= LIMITS.oi) return;
      hits.sort((a, b) => b.t - a.t);
      hits.slice(LIMITS.oi).forEach(h => env.storage.removeItem(h.k));
    }catch(e){}
  }
  /* درصد تغییر OI نسبت به قدیمی‌ترین نمونه‌ی داخل بازه. اگر بازه‌ی کافی
     نباشد null برمی‌گردد — «۳٪ رشد OI» نباید از مقایسه‌ی دو ثانیه ساخته شود. */
  function oiChangePct(symbol, hours = 1){
    const sym = String(symbol || '').toUpperCase();
    const arr = read('oi:' + sym);
    if(!Array.isArray(arr) || arr.length < 2) return null;
    const now = nowMs(), cutoff = now - hours * 3600000;
    const inside = arr.filter(x => x[0] >= cutoff);
    if(inside.length < 2) return null;
    const oldest = inside[0][1], newest = arr[arr.length - 1][1];
    if(!Number.isFinite(oldest) || oldest <= 0) return null;
    return (newest / oldest - 1) * 100;
  }

  /* ------------------------- ازدحام (طبقه‌بندی خالص) ------------------------- */
  /* ترکیب سه شاهد: فاندینگ، تغییر OI، و وضعیت مومنتوم. فقط ترکیب
     «فاندینگ داغ + OI صعودی» اخطار قوی می‌دهد تا هشدار بی‌مورد ساخته نشود. */
  function classifyCrowding(m, rsi, oiChangePct, th = THRESHOLDS){
    const out = { side:null, level:null, fundingAnnual:null, oiChangePct:null, reason:null };
    if(!m || m.fundingAnnual == null) return out;
    out.fundingAnnual = m.fundingAnnual;
    out.oiChangePct = Number.isFinite(oiChangePct) ? oiChangePct : null;
    const rising = out.oiChangePct != null && out.oiChangePct >= 3;
    const f = m.fundingAnnual;
    if(f >= th.fundingWarm && (rising || rsi >= 62)){
      out.side = 'long';
      out.level = f >= th.fundingHot ? 'hot' : 'warm';
      out.reason = `ازدحام سمت خرید: فاندینگ سالانه ${f.toFixed(0)}٪` +
        (out.oiChangePct != null ? ` و رشد OI ${out.oiChangePct.toFixed(1)}٪` : '') +
        (rsi >= 62 ? ` (RSI ${rsi.toFixed(0)})` : '');
    } else if(f <= th.fundingNegWarm && (out.oiChangePct != null && out.oiChangePct >= 3 || rsi <= 40)){
      out.side = 'short';
      out.level = f <= th.fundingNegHot ? 'hot' : 'warm';
      out.reason = `ازدحام سمت فروش: فاندینگ سالانه ${f.toFixed(0)}٪` +
        (out.oiChangePct != null ? ` و رشد OI ${out.oiChangePct.toFixed(1)}٪` : '') +
        (rsi <= 40 ? ` (RSI ${rsi.toFixed(0)})` : '');
    }
    return out;
  }

  /* ------------------------- تاریخچه‌ی کلان ------------------------- */
  function snapshot(global, t){
    if(!global) return null;
    const dom = Number(global.market_cap_percentage?.btc);
    const mcap = Number(global.total_market_cap?.usd);
    const vol = Number(global.total_volume?.usd);
    const ch24 = Number(global.market_cap_change_percentage_24h_usd);
    return { t, btcDom: Number.isFinite(dom) ? dom : null, mcap: Number.isFinite(mcap) ? mcap : null,
      vol: Number.isFinite(vol) ? vol : null, ch24: Number.isFinite(ch24) ? ch24 : null };
  }
  function pushHistory(history, global, t){
    const now = t ?? nowMs();
    const snap = snapshot(global, now);
    const list = Array.isArray(history) ? history.filter(x => x && Number.isFinite(x.t)) : [];
    if(!snap || snap.btcDom == null) return list;
    const last = list[list.length - 1];
    if(last && now - last.t < TTL.globalSnapGap) list[list.length - 1] = snap;
    else list.push(snap);
    while(list.length > LIMITS.hist) list.shift();
    const cutoff = now - LIMITS.histSpanHours * 3600000;
    const trimmed = list.filter(x => x.t >= cutoff);
    write('hist', trimmed);
    return trimmed;
  }
  /* روند سلطه: مقایسه‌ی حالا با نزدیک‌ترین نمونه به «hours» ساعت قبل.
     بدون تاریخچه‌ی کافی null برمی‌گردد تا رژیم بر پایه‌ی یک نقطه ساخته نشود. */
  function globalTrend(history, hours = 24, t){
    const now = t ?? nowMs();
    const list = (Array.isArray(history) ? history : []).filter(x => x && Number.isFinite(x.t));
    if(list.length < 2) return null;
    const cur = list[list.length - 1];
    const target = now - hours * 3600000;
    let best = null;
    for(const s of list){
      if(s.t <= target){ if(!best || s.t > best.t) best = s; }
    }
    if(!best){
      const oldest = list[0];
      if(cur.t - oldest.t < 6 * 3600000) return null;      // کمتر از ۶ ساعت ⇒ بی‌معنا
      best = oldest;
    }
    const spanH = (cur.t - best.t) / 3600000;
    if(spanH < 1) return null;
    return { spanHours: spanH,
      domChangePp: (Number.isFinite(cur.btcDom) && Number.isFinite(best.btcDom)) ? cur.btcDom - best.btcDom : null,
      mcapChangePct: (Number.isFinite(cur.mcap) && Number.isFinite(best.mcap) && best.mcap > 0) ? (cur.mcap / best.mcap - 1) * 100 : null,
      volChangePct: (Number.isFinite(cur.vol) && Number.isFinite(best.vol) && best.vol > 0) ? (cur.vol / best.vol - 1) * 100 : null };
  }
  function loadHistory(){ const h = read('hist'); return Array.isArray(h) ? h.filter(x => x && Number.isFinite(x.t)) : []; }

  /* ------------------------- اعتبارسنجی پاسخ‌ها ------------------------- */
  /* کندل CoinGecko: [ms, open, high, low, close]. ردیف ناقص/منفی/معکوس
     دور ریخته می‌شود؛ اگر کمتر از ۳۰ کندل بماند، null — چون ATR روی ۵ کندل
     «داده» نیست، «توهم» است. */
  function rowsToCandles(rows){
    if(!Array.isArray(rows)) return null;
    const out = [];
    rows.forEach(r => {
      if(!Array.isArray(r) || r.length < 5) return;
      const t = Number(r[0]), o = Number(r[1]), h = Number(r[2]), l = Number(r[3]), c = Number(r[4]);
      if(![t, o, h, l, c].every(Number.isFinite)) return;
      if(o <= 0 || c <= 0 || h <= 0 || l <= 0) return;
      if(h < l) return;
      out.push([t, o, h, l, c]);
    });
    return out.length >= 30 ? out : null;
  }
  /* market_chart: [ms, price] و [ms, volume]. تطبیق دو آرایه با طول یکسان
     فرض نمی‌شود؛ ردیف‌های ناسالم حذف می‌شوند. */
  function priceVolumeSeries(d){
    if(!d || !Array.isArray(d.prices) || !Array.isArray(d.total_volumes)) return null;
    const prices = [], volumes = [], times = [];
    const n = Math.min(d.prices.length, d.total_volumes.length);
    for(let i = 0; i < n; i++){
      const p = Array.isArray(d.prices[i]) ? Number(d.prices[i][1]) : NaN;
      const v = Array.isArray(d.total_volumes[i]) ? Number(d.total_volumes[i][1]) : NaN;
      if(!Number.isFinite(p) || p <= 0) continue;
      prices.push(p); volumes.push(Number.isFinite(v) && v >= 0 ? v : 0);
      times.push(Array.isArray(d.prices[i]) ? Number(d.prices[i][0]) : i);
    }
    return prices.length >= 48 ? { p:prices, v:volumes, t:times } : null;
  }

  return {
    VERSION, PROFILES, DEFAULT_PROFILE, TTL, LIMITS, THRESHOLDS, NS,
    setEnv, nowMs,
    cacheGet, cacheSet, cacheAge, cachePrune, cacheSummary, cacheClear,
    profile: profileKey, setProfile, profileLabel: () => profile().label, gapMs,
    canEnrich, noteCall, backoffOn, budgetState, restoreUsage, resetBudget,
    plan, next, fail, dropFromQueue, pendingCount, pendingIds, clearQueue,
    getJSON, derivativesBySymbol, median, annualize, classifyCrowding,
    recordOi, oiChangePct, snapshot, pushHistory, globalTrend, loadHistory,
    rowsToCandles, priceVolumeSeries
  };
});
