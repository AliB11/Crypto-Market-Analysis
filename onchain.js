/* =====================================================================
   onchain.js — لایه‌ی On-chain: داده‌ی زنجیره‌ای که پشت قیمت اتفاق می‌افتد

   چرا یک لایه‌ی جدا؟
   تحلیل تکنیکال «قیمت» را می‌بیند؛ مشتقات «اهرم» را. چیزی که در هر دو غایب
   است، سوخت و سلامت واقعی شبکه است: آیا دلار تازه به بازار وارد می‌شود،
   آیا تقاضای واقعی برای فضای بلاک وجود دارد، آیا ماینرها زیر فشار خاموش
   می‌کنند، آیا TVL یک اکوسیستم رشد می‌کند یا پول از آن خارج می‌شود، و آیا
   عرضه‌ی قفل‌شده‌ی یک توکن هنوز پشت سر کاربر انفجار می‌کند.

   اصول طراحی (همان قرارداد لایه‌ی داده، بدون استثنا):
   ۱) بدون کلید API و فقط از دامنه‌هایی که CORS آن‌ها «*» است (تأییدشده):
        • mempool.space  → سلامت شبکه‌ی بیت‌کوین (نرخ هش/دیفیکالتی/مِم‌پول/کارمزد)
        • api.llama.fi    → TVL زنجیره‌ها (DefiLlama، منبع متن‌باز)
        • api.coingecko.com → تاریخچه‌ی عرضه‌ی استیبل‌کوین‌ها (همان دامنه‌ی مجاز)
   ۲) هیچ داده‌ای حیاتی نیست: نبود هر منبع = آن مؤلفه null و خنثی، نه صفر.
      صفر یعنی «بی‌طرف»، null یعنی «نمی‌دانیم» — اشتباه‌کردنی نباشد.
   ۳) لایه‌ی On-chain در سطح کلان فقط «سخت‌گیرتر» می‌کند، هرگز آسان‌گیرتر:
      اثرش کم کردن امتیاز و بستن دروازه است، نه باز کردن آن. (تنها استثنا،
      پاداش کوچک مومنتوم TVL در سطح تک‌ارز است که دروازه را رد نمی‌کند.)
   ۴) بودجه‌ی فراخوان: داده‌ی زنجیره‌ای ساعتی/روزانه تغییر می‌کند، نه هر ۹۰
      ثانیه. پس هر kind حداقل فاصله‌ی خودش را دارد و سقف ساعتی هم دارد.
   ۵) ماژول خالصِ محیط است: storage/fetch/now تزریق‌پذیرند تا در Node و بدون
      شبکه آزمون‌پذیر باشد (tests/onchain.test.mjs). هیچ‌جا DOM یا setTimeout
      سراسری استفاده نمی‌شود.
   ===================================================================== */
(function(root, factory){
  const API = factory();
  root.OnChain = API;
  if(typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  const VERSION = 'onchain-v1';
  const NS = 'cbo:';

  const ENDPOINTS = {
    btcDiff : 'https://mempool.space/api/v1/difficulty-adjustment',
    btcHash : 'https://mempool.space/api/v1/mining/hashrate/3d',
    btcFees : 'https://mempool.space/api/v1/fees/recommended',
    btcPool : 'https://mempool.space/api/mempool',
    chains  : 'https://api.llama.fi/v2/chains',
    /* تاریخچه‌ی عرضه‌ی استیبل‌کوین‌ها از همان CoinGecko که CSP اجازه داده است
       (days=120 و interval=daily ⇒ ۱۲۰ نقطه‌ی روزانه، پاسخ کوچک). */
    stables : id => `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=120&interval=daily`
  };
  const STABLE_SEED = ['tether', 'usd-coin'];   // ~۸۵٪ نقدینگی دلاری بازار

  /* حداقل فاصله‌ی دو فراخوان هر گروه + سقف کل فراخوان‌ها در ساعت */
  const GAP = { btcMin: 15 * 60e3, btcSlow: 60 * 60e3, chains: 60 * 60e3, stables: 12 * 3600e3 };
  const HOURLY_CAP = 24;
  const TTL = { btcMin: 15 * 60e3, btcSlow: 60 * 60e3, chains: 60 * 60e3, stables: 12 * 3600e3, snap: 60 * 60e3 };

  const LIMITS = { chainsHist: 210, liqHist: 220, stablePts: 130 };

  /* آستانه‌ها: یک‌جا و صریح تا در آزمون‌ها قابل بازنویسی باشند.
     اعداد «درصد» هستند مگر آن‌که واحد در نام کلید آمده باشد. */
  const TH = {
    /* نقدینگی استیبل‌کوین (سوخت بازار) */
    liqGrow7d    : 0.8,   liqGrow7dStrong : 1.6,
    liqDrain7d   : -0.6,  liqDrain7dDeep  : -1.5,
    liqGrow30d   : 3.0,   liqDrain30d     : -2.5,
    /* سلامت شبکه‌ی بیت‌کوین */
    hashDrop3d   : -2.5,  hashRise3d       : 1.5,
    diffCutStress: -3.0,  diffRiseWarm     : 3.0,
    feeShareCapDays: 30,  // بازه‌ی تخمینی برای «فشار»؛ فقط برچسب
    backlogBusy  : 120000, backlogQuiet   : 30000,
    feeHot       : 40,    feeCold         : 3,      // sat/vB برای کندلِ ۳۰ دقیقه‌ای
    priceFeeDivergence: 6, // ٪ رشد ۲۴ ساعته‌ی قیمت که با افت کارمزد/مِم‌پول نمی‌خواند
    /* TVL زنجیره‌ها */
    tvlGrow1d    : 1.2,   tvlGrow7d       : 2.0,
    tvlDrain1d   : -1.5,  tvlDrain7d      : -6.0,  tvlExodus7d : -12.0,
    minTvlUsd    : 4e7,    // زیر این حجم، درصد تغییر بی‌معنا است
    /* توکنومیکس (فشار آزادسازی عرضه) */
    floatThin    : 0.35,  floatThinDeep   : 0.25,
    fdvStress    : 2.5,   fdvStressDeep   : 4.0,
    fdvMild      : 1.5,
    /* سقف اثر روی امتیازها */
    capMarket    : 3,
    capCoin      : 6
  };

  /* نگاشت ارز → زنجیره‌ی DefiLlama.Lookup اول از خود پاسخ (gecko_id /
     gasTokenGeckoId) ساخته می‌شود؛ این جدول فقط جاهایی را پر می‌کند که
     Llama آن کلید را ندارد (مثلاً Polygon با نماد POL یا BNB با نماد BNB). */
  const CHAIN_ALIAS = {
    'ethereum': 'Ethereum', 'solana': 'Solana', 'binancecoin': 'BSC', 'bnb': 'BSC',
    'avalanche-2': 'Avalanche', 'fantom': 'Fantom', 'cardano': 'Cardano', 'tron': 'Tron',
    'arbitrum': 'Arbitrum', 'optimism': 'OP Mainnet', 'matic-network': 'Polygon',
    'polygon-ecosystem-token': 'Polygon', 'near': 'NEAR', 'sui': 'Sui', 'aptos': 'Aptos',
    'sei-network': 'Sei', 'hedera-hashgraph': 'Hedera', 'the-open-network': 'TON', 'ton': 'TON',
    'celo': 'Celo', 'kava': 'Kava', 'algorand': 'Algorand', 'tezos': 'Tezos',
    'filecoin': 'Filecoin', 'cosmos': 'CosmosHub', 'vechain': 'VeChain', 'hz': 'Hedera',
    'moonbeam': 'Moonbeam', 'moonriver': 'Moonriver', 'klay-token': 'Klaytn',
    'flare-networks': 'Flare', 'eos': 'Wax', 'arbitrum-usdc': 'Arbitrum', 'base': 'Base',
    'sonic-3': 'Sonic', 'linea': 'Linea', 'scroll': 'Scroll', 'mantle': 'Mantle',
    'blast': 'Blast', 'fraxtal': 'Fraxtal', 'gnosis': 'Gnosis', 'xdai': 'Gnosis',
    'rootstock': 'Rootstock', 'celo2': 'Celo', 'hydra': 'Hyperliquid L1', 'hyperliquid': 'Hyperliquid L1',
    'plasma': 'Plasma', 'monad': 'Monad', 'plume': 'Plume Mainnet', 'ink': 'Ink', 'unichain': 'Unichain'
  };

  /* ------------------------- محیط تزریق‌پذیر ------------------------- */
  const env = {
    storage: (typeof localStorage !== 'undefined' ? localStorage : null),
    fetchImpl: (typeof fetch !== 'undefined' ? fetch : null),
    now: () => Date.now()
  };
  function setEnv(patch){ Object.assign(env, patch || {}); }
  function nowMs(){ try { return env.now(); } catch(e){ return Date.now(); } }

  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const round = (v, d = 2) => isNum(v) ? Number(v.toFixed(d)) : null;

  /* ------------------------- کش / ذخیره‌سازی ------------------------- */
  function read(key){
    try { const raw = env.storage && env.storage.getItem(NS + key); return raw ? JSON.parse(raw) : null; }
    catch(e){ return null; }
  }
  function write(key, value){
    try { env.storage && env.storage.setItem(NS + key, JSON.stringify(value)); return true; }
    catch(e){ return false; }
  }
  function cacheSet(kind, data, t){ write('c:' + kind, { t: t ?? nowMs(), d: data }); return data; }
  /* خواندن کش با سقف عمر؛ پاسخ کهنه‌تر از TTL ⇒ null (نه داده‌ی تاریخ‌گذشته) */
  function cacheGet(kind, maxAge, t){
    const rec = read('c:' + kind);
    if(!rec || !isNum(rec.t) || !rec.d) return null;
    const age = (t ?? nowMs()) - rec.t;
    if(age < 0 || age > maxAge) return null;
    return rec.d;
  }
  function cacheAge(kind, t){
    const rec = read('c:' + kind);
    return rec && isNum(rec.t) ? Math.max(0, (t ?? nowMs()) - rec.t) : null;
  }

  /* ------------------------- بودجه‌ی فراخوان ------------------------- */
  const budget = { last: {}, hour: 0, calls: 0, backoff: 1, blocked: 0 };
  function hourOf(t){ return Math.floor(t / 3600e3); }
  /* آیا «همین الان» سهمیه‌ی ساعتی باقی مانده؟ (بدون بررسی فاصله) */
  function hasBudget(t){
    const now = t ?? nowMs();
    if(budget.blocked > now) return false;
    if(hourOf(now) !== budget.hour) return true;
    return budget.calls < HOURLY_CAP;
  }
  function canCall(kind, t){
    const now = t ?? nowMs();
    if(now < budget.blocked) return false;
    const h = hourOf(now);
    if(h !== budget.hour){ budget.hour = h; budget.calls = 0; }
    if(budget.calls >= HOURLY_CAP) return false;
    const last = budget.last[kind] ?? 0;
    const gap = (GAP[kind] ?? 15 * 60e3) * budget.backoff;
    return (now - last) >= gap;
  }
  function noteCall(kind, t){
    const now = t ?? nowMs();
    budget.last[kind] = now;
    const h = hourOf(now);
    if(h !== budget.hour){ budget.hour = h; budget.calls = 0; }
    budget.calls++;
    write('usage', { hour: h, calls: budget.calls });
    return budget.calls;
  }
  function backoffOn(isRateLimited){
    if(isRateLimited){ budget.backoff = Math.min((budget.backoff || 1) * 2, 8); budget.blocked = nowMs() + 10 * 60e3; }
    else budget.backoff = Math.max(1, (budget.backoff || 1) / 2);
    return budget.backoff;
  }
  function restoreUsage(){
    const u = read('usage');
    if(u && u.hour === hourOf(nowMs())){ budget.hour = u.hour; budget.calls = u.calls || 0; }
    return budget.calls;
  }
  function budgetState(t){
    const now = t ?? nowMs();
    if(hourOf(now) !== budget.hour) return { callsThisHour: 0, cap: HOURLY_CAP, backoff: budget.backoff, blockedForMs: Math.max(0, budget.blocked - now), nextIn: {} };
    const nextIn = {};
    for(const k of Object.keys(GAP)) nextIn[k] = Math.max(0, Math.round(GAP[k] * budget.backoff - (now - (budget.last[k] ?? 0))));
    return { callsThisHour: budget.calls, cap: HOURLY_CAP, backoff: budget.backoff, blockedForMs: Math.max(0, budget.blocked - now), nextIn };
  }
  function resetBudget(){ budget.last = {}; budget.hour = hourOf(nowMs()); budget.calls = 0; budget.backoff = 1; budget.blocked = 0; }

  /* ------------------------- شبکه ------------------------- */
  /* مثل market-data: خطا هرگز throw نمی‌شود؛ {__error:true} برمی‌گردد. */
  async function getJSON(url, timeoutMs = 12000){
    if(!env.fetchImpl) return { __error: true, status: 0, reason: 'no-fetch' };
    let timer = null;
    try{
      const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      if(ctrl) timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const r = await env.fetchImpl(url, ctrl ? { signal: ctrl.signal } : undefined);
      if(!r || !r.ok) return { __error: true, status: (r && r.status) || 0 };
      const j = await r.json();
      if(j == null || typeof j !== 'object') return { __error: true, status: 0, reason: 'bad-json' };
      return j;
    }catch(e){
      return { __error: true, status: 0, reason: String((e && e.name) || 'network') };
    }finally{ if(timer) clearTimeout(timer); }
  }
  const bad = r => !r || r.__error === true;

  /* =====================================================================
     ۱) سلامت شبکه‌ی بیت‌کوین — «آیا روی زنجیره تقاضای واقعی هست؟»
     ===================================================================== */
  /* ورودی خام پاسخ‌ها → یک شیء کوچک و اعتبارسنجی‌شده. هر میدان غایب null. */
  function readBtcNetwork(raw){
    const out = { at: null, diffChangePct: null, diffProgress: null, retargetInHrs: null, prevRetargetPct: null,
      hashNow: null, hash3dAvg: null, hashChgPct: null, difficulty: null,
      feeFast: null, feeHalf: null, feeHour: null, feeEco: null,
      poolTxs: null, poolVsizeMb: null, poolFeeBtc: null };
    if(!raw) return out;
    const d = raw.diff;
    if(d && !bad(d)){
      if(isNum(d.difficultyChange)) out.diffChangePct = round(d.difficultyChange, 3);
      if(isNum(d.progressPercent)) out.diffProgress = clamp(d.progressPercent, 0, 100);
      if(isNum(d.remainingTime)) out.retargetInHrs = round(d.remainingTime / 3600e3, 2);
      if(isNum(d.previousRetarget)) out.prevRetargetPct = round(d.previousRetarget, 3);
    }
    const h = raw.hash;
    if(h && !bad(h)){
      if(isNum(h.currentHashrate) && h.currentHashrate > 0) out.hashNow = h.currentHashrate;
      if(isNum(h.currentDifficulty) && h.currentDifficulty > 0) out.difficulty = h.currentDifficulty;
      const list = Array.isArray(h.hashrates) ? h.hashrates.filter(x => x && isNum(x.avgHashrate) && x.avgHashrate > 0) : [];
      if(list.length >= 2){
        /* مقایسه‌ی «آخرین» با میانگین بقیه — اگر فقط دو نقطه باشد، همان دو. */
        const last = list[list.length - 1].avgHashrate;
        const base = list.slice(0, -1);
        const avg = base.reduce((s, x) => s + x.avgHashrate, 0) / base.length;
        if(avg > 0){ out.hash3dAvg = avg; out.hashChgPct = round((last / avg - 1) * 100, 3); }
      } else if(list.length === 1){ out.hash3dAvg = list[0].avgHashrate; }
    }
    const f = raw.fees;
    if(f && !bad(f)){
      if(isNum(f.fastestFee)) out.feeFast = f.fastestFee;
      if(isNum(f.halfHourFee)) out.feeHalf = f.halfHourFee;
      if(isNum(f.hourFee)) out.feeHour = f.hourFee;
      if(isNum(f.economyFee)) out.feeEco = f.economyFee;
    }
    const m = raw.pool;
    if(m && !bad(m)){
      if(isNum(m.count) && m.count >= 0) out.poolTxs = Math.round(m.count);
      if(isNum(m.vsize) && m.vsize > 0) out.poolVsizeMb = round(m.vsize / 1e6, 2);
      if(isNum(m.total_fee) && m.total_fee > 0) out.poolFeeBtc = round(m.total_fee / 1e8, 4);   // sat → BTC
    }
    return out;
  }
  /* هر شاهد فقط با داده‌ی معتبر شمارش می‌شود؛ نبود داده = بی‌اثر (نه خنثی‌ساز). */
  function analyzeBtcNetwork(d, th = TH){
    const T = Object.assign({}, TH, th || {});
    const out = { score: 0, level: 'unknown', why: [], flags: {}, n: 0 };
    if(!d) return out;
    const add = (v, t) => { out.score += v; out.why.push(t); if(v) out.n++; };
    if(isNum(d.hashChgPct)){
      if(d.hashChgPct <= T.hashDrop3d){
        out.flags.hashDrop = true;
        add(-1, `نرخ هش شبکه ${pctTxt(d.hashChgPct, 1)} در سه روز — ماینرها در حال خاموش‌کردن ریگ‌های کم‌سود هستند (فشار عرضه‌ی ماینر)`);
      } else if(d.hashChgPct >= T.hashRise3d){
        out.flags.hashRise = true;
        add(1, `نرخ هش شبکه ${pctTxt(d.hashChgPct, 1)} در سه روز — سرمایه‌گذاری روی زیرساخت در حال بازگشت است`);
      }
    }
    if(isNum(d.diffChangePct)){
      if(d.diffChangePct <= T.diffCutStress){
        out.flags.diffCut = true;
        add(-1, `تنظیم دشواری پیش‌رو ${pctTxt(d.diffChangePct, 1)} — حاشیه سود ماینر فشرده شده؛ تاریخاً با تعدیل عرضه همراه بوده`);
      } else if(d.diffChangePct >= T.diffRiseWarm){
        out.flags.diffRise = true;
        add(1, `تنظیم دشواری پیش‌رو ${pctTxt(d.diffChangePct, 1)} — شبکه با اطمینان رشد می‌کند`);
      }
    }
    if(isNum(d.poolTxs)){
      if(d.poolTxs >= T.backlogBusy){
        out.flags.congested = true;
        add(1, `صف مِم‌پول با ${fmtInt(d.poolTxs)} تراکنش — تقاضای واقعی برای فضای بلاک بالاست (کارمزد، سوخت شبکه)`);
      } else if(d.poolTxs <= T.backlogQuiet){
        out.flags.quiet = true;
        add(0, `صف مِم‌پول خلوت است (${fmtInt(d.poolTxs)} تراکنش) — تقاضای تسویه‌ی روی‌زنجیره‌ای کم`);
      }
    }
    if(isNum(d.feeFast) && isNum(d.feeHour)){
      if(d.feeFast >= T.feeHot) out.flags.feeHot = true;
      if(d.feeHour <= T.feeCold && d.feeFast <= T.feeCold) out.flags.feeCold = true;
    }
    if(out.n > 0 || out.flags.quiet) out.level = out.score > 0 ? 'strengthening' : out.score < 0 ? 'stressed' : 'balanced';
    else out.level = 'unknown';
    out.score = clamp(out.score, -T.capMarket, T.capMarket);
    return out;
  }
  /* واگرایی «قیمت بالا، زنجیره بی‌میل» — تنها قاعده‌ای که به قیمت نیاز دارد. */
  function networkPriceDivergence(net, ch24, th = TH){
    const T = Object.assign({}, TH, th || {});
    if(!net || !isNum(ch24)) return null;
    const feeSoft = (isNum(net.feeFast) && net.feeFast <= T.feeCold) || (isNum(net.poolTxs) && net.poolTxs <= T.backlogQuiet);
    if(ch24 >= T.priceFeeDivergence && feeSoft){
      return { kind: 'weak-rally', score: -1,
        text: `بیت‌کوین ${pctTxt(ch24, 1)} در ۲۴ ساعت، ولی تقاضای روی‌زنجیره‌ای سرد است (کارمزد ${net.feeFast ?? '—'} sat/vB • صف مِم‌پول ${fmtInt(net.poolTxs ?? 0)}) — رشد قیمت بیشتر نقدی است تا شبکه‌ای` };
    }
    if(ch24 <= -T.priceFeeDivergence && (isNum(net.poolTxs) && net.poolTxs >= T.backlogBusy || isNum(net.feeFast) && net.feeFast >= T.feeHot)){
      return { kind: 'real-selling', score: -1,
        text: `ریزش ${pctTxt(ch24, 1)} با شبکه‌ی شلوغ — فروش واقعی و تسویه‌ی پشت‌سرهم، نه فقط لیکوئیدیشن فیوچرز` };
    }
    return null;
  }

  /* =====================================================================
     ۲) نقدینگی دلاری (استیبل‌کوین) — «سوخت تازه وارد بازار می‌شود یا خارج؟»
     ===================================================================== */
  /* market_chart با interval=daily → market_caps = عرضه‌ی در گردش × قیمت.
     ردیف‌های نامعتبر و تکراری حذف؛ خروجی صعودی بر پایه‌ی زمان. */
  function parseStableSeries(resp){
    const rows = resp && Array.isArray(resp.market_caps) ? resp.market_caps : [];
    const byDay = new Map();
    for(const r of rows){
      if(!Array.isArray(r) || r.length < 2) continue;
      const t = Number(r[0]), v = Number(r[1]);
      if(!Number.isFinite(t) || !Number.isFinite(v) || v <= 0) continue;
      const day = Math.floor(t / 864e5) * 864e5;
      byDay.set(day, v);        // آخرین نمونه‌ی همان روز
    }
    return [...byDay.entries()].sort((a, b) => a[0] - b[0])
      .map(([t, mcap]) => ({ t, mcap }));
  }
  /* جمع چند سری (USDT + USDC) بر حسب روز؛ روزی در سری نهایی که در همه باشد. */
  function mergeStableSeries(lists){
    const valid = (Array.isArray(lists) ? lists : []).filter(a => Array.isArray(a) && a.length);
    if(!valid.length) return [];
    const map = new Map();
    valid.forEach(list => list.forEach(p => {
      const day = Math.floor(p.t / 864e5) * 864e5;
      const e = map.get(day) || { sum: 0, n: 0 };
      e.sum += p.mcap; e.n++;
      map.set(day, e);
    }));
    return [...map.entries()]
      .filter(([, e]) => e.n === valid.length)          // روز کامل، نه نصف‌ونیمه
      .sort((a, b) => a[0] - b[0])
      .map(([t, e]) => ({ t, mcap: e.sum }));
  }
  /* درصد تغییر نسبت به نزدیک‌ترین نمونه به «days» روز قبل. اگر تاریخچه
     کافی نباشد null — «رشد ۱٪ نقدینگی» نباید از دو نقطه‌ی ۳ ساعته ساخته شود. */
  function changeOver(series, days, t){
    const now = t ?? nowMs();
    if(!Array.isArray(series) || series.length < 2) return null;
    const last = series[series.length - 1];
    const target = now - days * 864e5;
    let best = null;
    for(const p of series){
      if(p.t <= target && (!best || p.t > best.t)) best = p;
    }
    if(!best){
      const oldest = series[0];
      if(now - oldest.t < days * 864e5 * 0.5) return null;   // نیمی از پنجره هم پر نشده
      best = oldest;
    }
    if(!(best.mcap > 0) || !(last.mcap > 0)) return null;
    const spanDays = (last.t - best.t) / 864e5;
    if(spanDays < Math.max(0.35, days * 0.35)) return null;
    return { pct: (last.mcap / best.mcap - 1) * 100, spanDays, now: last.mcap };
  }
  function analyzeLiquidity(series, t, th = TH){
    const T = Object.assign({}, TH, th || {});
    const out = { score: 0, level: 'unknown', why: [], chg7d: null, chg30d: null, mcap: null, points: 0, flags: {} };
    if(!Array.isArray(series)) return out;
    out.points = series.length;
    if(series.length) out.mcap = series[series.length - 1].mcap;
    const d7 = changeOver(series, 7, t), d30 = changeOver(series, 30, t);
    out.chg7d = round(d7 && d7.pct, 3);
    out.chg30d = round(d30 && d30.pct, 3);
    if(d7 == null && d30 == null){
      out.why.push(series.length < 8
        ? `تاریخچه‌ی عرضه‌ی استیبل‌کوین کوتاه است (${series.length} روز) — سنجش روند ممکن نیست`
        : 'بازه‌ی زمانی برای مقایسه کافی نیست');
      return out;
    }
    let s = 0;
    const c7 = d7 ? d7.pct : null;
    if(c7 != null){
      if(c7 >= T.liqGrow7dStrong){ s += 3; out.flags.expanding = 'strong'; out.why.push(`عرضه‌ی استیبل‌کوین ${pctTxt(c7, 2)} در ۷ روز — دلار تازه به حاشیه‌ی بازار می‌آید (سوخت ورود)`); }
      else if(c7 >= T.liqGrow7d){ s += 2; out.flags.expanding = true; out.why.push(`عرضه‌ی استیبل‌کوین ${pctTxt(c7, 2)} در ۷ روز — نقدینگی در حال رشد`); }
      else if(c7 <= T.liqDrain7dDeep){ s -= 3; out.flags.drain = 'deep'; out.why.push(`عرضه‌ی استیبل‌کوین ${pctTxt(c7, 2)} در ۷ روز — نقدینگی از بازار خارج می‌شود؛ رالی‌های بی‌سوخت شکننده‌اند`); }
      else if(c7 <= T.liqDrain7d){ s -= 2; out.flags.drain = true; out.why.push(`عرضه‌ی استیبل‌کوین ${pctTxt(c7, 2)} در ۷ روز — خروج آرام دلار از حاشیه‌ی بازار`); }
    }
    if(d30 != null){
      if(d30.pct >= T.liqGrow30d){ s += 1; out.why.push(`روند ۳۰ روزه مثبت (${pctTxt(d30.pct, 1)}) — ورود نقدینگی ساختاری است نه اتفاقی`); }
      else if(d30.pct <= T.liqDrain30d){ s -= 1; out.why.push(`روند ۳۰ روزه منفی (${pctTxt(d30.pct, 1)}) — بازار در حالت حذف اهرم است`); }
    }
    out.score = clamp(s, -T.capMarket, T.capMarket);
    out.level = out.score >= 2 ? 'expansion' : out.score <= -2 ? 'drain' : (out.score !== 0 ? 'mixed' : 'flat');
    return out;
  }
  /* سهم استیبل‌کوین از کل ارزش بازار = دماسنج ریسک‌گریزی (local، بدون فراخوان) */
  function pushLiqSnap(history, snap, t){
    const now = t ?? nowMs();
    const list = (Array.isArray(history) ? history : []).filter(x => x && isNum(x.t));
    if(!snap || !isNum(snap.stableUsd) || snap.stableUsd <= 0 || !isNum(snap.mcapUsd) || snap.mcapUsd <= 0) return list;
    const share = snap.stableUsd / snap.mcapUsd * 100;
    const rec = { t: now, stable: snap.stableUsd, mcap: snap.mcapUsd, share: round(share, 4) };
    const last = list[list.length - 1];
    /* نمونه‌ها حداکثر ساعتی؛ در همان ساعت، آخرین مقدار جایگزین می‌شود */
    if(last && now - last.t < TTL.snap) list[list.length - 1] = rec;
    else list.push(rec);
    while(list.length > LIMITS.liqHist) list.shift();
    write('hist:liq', list);
    return list;
  }
  function loadLiqHistory(){
    const h = read('hist:liq');
    return Array.isArray(h) ? h.filter(x => x && isNum(x.t) && isNum(x.share)) : [];
  }
  /* تغییر «سهم دلاری» در پنجره: مثبت = پول به استیبل می‌گریزد (ریسک‌گریز)،
     منفی = استیبل‌ها به دارایی پرریسک تبدیل شده‌اند (سوختِ ورودِ واقعی). */
  function shareTrend(hist, days, t){
    const now = t ?? nowMs();
    const list = (Array.isArray(hist) ? hist : []).filter(x => x && isNum(x.t) && isNum(x.share));
    if(list.length < 2) return null;
    const last = list[list.length - 1];
    const target = now - days * 864e5;
    let best = null;
    for(const p of list){ if(p.t <= target && (!best || p.t > best.t)) best = p; }
    if(!best){
      if(now - list[0].t < days * 864e5 * 0.5) return null;
      best = list[0];
    }
    return { pp: round(last.share - best.share, 3), spanDays: round((last.t - best.t) / 864e5, 2), share: last.share };
  }

  /* =====================================================================
     ۳) TVL زنجیره‌ها — «پول در اکوسیستم این ارز کم می‌شود یا زیاد؟»
     ===================================================================== */
  /* پاسخ /v2/chains بزرگ است؛ فقط آنچه لازم داریم نگه داشته می‌شود و
     ردیف‌های بی‌ارزش (TVL ناچیز) دور ریخته می‌شوند تا localStorage نترکد. */
  function readChains(rows){
    const out = {};
    if(!Array.isArray(rows)) return out;
    rows.forEach(r => {
      if(!r || !isNum(r.tvl) || r.tvl < TH.minTvlUsd) return;
      const name = String(r.name || '').trim();
      if(!name) return;
      out[name] = { tvl: r.tvl, gecko: typeof r.gecko_id === 'string' ? r.gecko_id : null,
        gas: typeof r.gasTokenGeckoId === 'string' ? r.gasTokenGeckoId : null,
        symbol: typeof r.tokenSymbol === 'string' ? r.tokenSymbol : null };
    });
    return out;
  }
  /* نگاشت coin id → نام زنجیره، از خود داده (gecko/gas) + جدول جایگزین. */
  function chainLookup(chains){
    const map = {};
    Object.keys(chains || {}).forEach(name => {
      const e = chains[name];
      if(e.gecko && !map[e.gecko]) map[e.gecko] = name;
      if(e.gas && !map[e.gas]) map[e.gas] = name;
    });
    Object.keys(CHAIN_ALIAS).forEach(id => { if(chains && chains[CHAIN_ALIAS[id]] && !map[id]) map[id] = CHAIN_ALIAS[id]; });
    return map;
  }
  /* تاریخچه‌ی محلی: هر اسنپ‌شات فقط «سطح» است؛ تغییرات از مقایسه‌ی نمونه‌ها
     ساخته می‌شود (همان الگوی روند سلطه در market-data). */
  function pushChainHistory(hist, chains, t){
    const now = t ?? nowMs();
    const list = (Array.isArray(hist) ? hist : []).filter(x => x && isNum(x.t) && x.v);
    if(!chains || !Object.keys(chains).length) return list;
    const v = {};
    Object.keys(chains).forEach(name => { v[name] = Math.round(chains[name].tvl); });
    const last = list[list.length - 1];
    if(last && now - last.t < TTL.chains * 0.8) list[list.length - 1] = { t: now, v };
    else list.push({ t: now, v });
    while(list.length > LIMITS.chainsHist) list.shift();
    write('hist:chains', list);
    return list;
  }
  function loadChainHistory(){
    const h = read('hist:chains');
    return Array.isArray(h) ? h.filter(x => x && isNum(x.t) && x.v) : [];
  }
  function tvlAt(hist, name, hours, t){
    const now = t ?? nowMs();
    const list = (Array.isArray(hist) ? hist : []).filter(x => x && isNum(x.t) && isNum(x.v[name]) && x.v[name] > 0);
    if(!list.length) return null;
    const last = list[list.length - 1];
    const target = now - hours * 3600e3;
    let best = null;
    for(const p of list){ if(p.t <= target && (!best || p.t > best.t)) best = p; }
    if(!best){
      const oldest = list[0];
      if(now - oldest.t < Math.max(6 * 3600e3, hours * 3600e3 * 0.5)) return null;
      best = oldest;
    }
    if(best === last) return null;
    return { pct: (last.v[name] / best.v[name] - 1) * 100, spanHours: (last.t - best.t) / 3600e3, tvl: last.v[name] };
  }
  /* امتیاز آنچینِ یک ارز بر پایه‌ی مومنتوم TVL زنجیره‌اش.
     بدون تاریخچه‌ی کافی ⇒ score=0 و ready=false (هیچ اثری ندارد). */
  function analyzeChain(name, hist, t, th = TH){
    const T = Object.assign({}, TH, th || {});
    const out = { chain: name || null, ready: false, score: 0, tvl: null, chg1d: null, chg7d: null, flags: {}, why: [] };
    if(!name || !Array.isArray(hist) || hist.length < 2) return out;
    const d1 = tvlAt(hist, name, 24, t), w1 = tvlAt(hist, name, 168, t);
    if(!d1 && !w1) return out;
    out.ready = true;
    out.tvl = (d1 || w1).tvl;
    out.chg1d = round(d1 && d1.pct, 3);
    out.chg7d = round(w1 && w1.pct, 3);
    let s = 0;
    if(w1 && w1.pct <= T.tvlExodus7d){ s -= 5; out.flags = { exodus: true }; out.why.push(`TVL زنجیره‌ی ${name} در ۷ روز ${pctTxt(w1.pct, 1)} — پول از اکوسیستم خارج می‌شود؛ خرید در این نقطه شرط تأیید لازم دارد`); }
    else if(w1 && w1.pct <= T.tvlDrain7d){ s -= 3; out.why.push(`TVL زنجیره‌ی ${name} در ۷ روز ${pctTxt(w1.pct, 1)} — اکوسیستم در حال کوچک‌شدن`); }
    else if(d1 && d1.pct <= T.tvlDrain1d){ s -= 1; out.why.push(`TVL ${name} در ۲۴ ساعت ${pctTxt(d1.pct, 1)}`); }
    else if(w1 && w1.pct >= T.tvlGrow7d && d1 && d1.pct >= 0){ s += 3; out.why.push(`TVL زنجیره‌ی ${name} در ۷ روز ${pctTxt(w1.pct, 1)} و در ۲۴ ساعت ${pctTxt(d1.pct, 1)} — پول واقعی به اکوسیستم سرازیر می‌شود`); }
    else if(d1 && d1.pct >= T.tvlGrow1d){ s += 2; out.why.push(`TVL ${name} در ۲۴ ساعت ${pctTxt(d1.pct, 1)} — ورود تازه‌ی سرمایه‌ی قفل‌شده`); }
    out.score = clamp(s, -T.capCoin, T.capCoin);
    return out;
  }

  /* =====================================================================
     ۴) توکنومیکس روی‌زنجیره‌ای — فشار آزادسازی عرضه (بدون هیچ فراخوان)
     ===================================================================== */
  /* ضریب FDV/ارزش بازار ≈ چند برابرِ عرضه‌ی فعلی هنوز قفل است. نسبت بالا یعنی
     «سقف فروشِ آینده» — همان چیزی که موتور تکنیکال هیچ‌وقت نمی‌بیند. */
  function analyzeFloat(c, th = TH){
    const T = Object.assign({}, TH, th || {});
    const out = { ready: false, floatPct: null, fdvRatio: null, score: 0, why: [], flags: {} };
    if(!c || typeof c !== 'object') return out;
    const circ = Number(c.circulating_supply), tot = Number(c.total_supply || c.max_supply);
    const mcap = Number(c.market_cap), fdv = Number(c.fully_diluted_valuation);
    if(isNum(circ) && isNum(tot) && tot > 0 && circ >= 0){
      out.floatPct = clamp(circ / tot, 0, 1) * 100;   // فقط اطلاعات: بدون FDV داوری نمی‌کنیم
    }
    if(isNum(mcap) && mcap > 0 && isNum(fdv) && fdv > 0){
      out.fdvRatio = fdv / mcap;
      if(!isNum(circ) || !isNum(tot) || tot <= 0) out.floatPct = clamp(mcap / fdv, 0, 1) * 100;   // تخمین سهم شناور از خود FDV
      out.ready = true;                       // «قابل داوری» یعنی FDV روی میز باشد
    }
    /* مبنای داوری، فاصله‌ی FDV تا ارزش بازارِ امروز است — نه total_supply که
       معنایش بین ارزها یکی نیست (گاهی max_supply است، گاهی عرضه‌ی قفل‌شده).
       بدون FDV هیچ امتیازی ساخته نمی‌شود: نه پاداش، نه جریمه. */
    if(!isNum(out.fdvRatio)) return out;
    const r = out.fdvRatio, fp = out.floatPct;
    const thin = isNum(fp) && fp <= T.floatThin * 100, deep = isNum(fp) && fp <= T.floatThinDeep * 100;
    const floatTxt = isNum(fp) ? ' (فقط ' + fp.toFixed(0) + '٪ از عرضه در گردش)' : '';
    if(r >= T.fdvStressDeep || (r >= T.fdvStress && deep)){
      out.score = -T.capCoin; out.flags.overhang = 'severe';
      out.why.push('فشار آزادسازی عرضه: FDV ' + r.toFixed(1) + '\u00d7 ارزش بازار' + floatTxt + ' — هر صعود، سهمی از آنلاک‌های پیش‌رو را می‌خورد');
    } else if(r >= T.fdvStress){
      out.score = -4; out.flags.overhang = 'high';
      out.why.push('FDV ' + r.toFixed(1) + '\u00d7 ارزش بازار — بخش بزرگی از عرضه هنوز قفل است و به عرضه‌ی فعلی اضافه می‌شود');
    } else if(r >= T.fdvMild){
      out.score = -2; out.flags.overhang = 'mild';
      out.why.push('FDV ' + r.toFixed(1) + '\u00d7 ارزش بازار — عرضه‌ی در راه، سقفِ صعود را پایین می‌آورد');
    } else if(r <= 1.15 && (!isNum(fp) || fp >= 92)){
      out.score = 1; out.flags.fullyCirculated = true;
      out.why.push('تقریباً کل عرضه در گردش است (FDV \u2248 ارزش بازار) — ریسک آنلاک ساختاری وجود ندارد');
    }
    if(thin && out.score >= 0) out.why.push('عرضه‌ی شناور کم (' + (isNum(fp)?fp.toFixed(0):'—') + '٪) — نوسان با آزادسازیِ عرضه اغراق‌آمیز می‌شود');
    return out;
  }

  /* =====================================================================
     ۵) ترکیب — یک عدد برای «زمینه‌ی آنچین» و یک عدد برای «این ارز»
     ===================================================================== */
  /* ترکیب لایه‌ی کلان: فقط «سخت‌گیرنده» مجاز است؛ یعنی اگر جمع مثبت شد،
     سقف کوچک‌تر از منفی است تا دروازه را بی‌دلیل باز نکند. */
  /* ترکیب لایه‌ی کلان. فراخوان: combineMarket(net, liq, div, extraParts?, th?)
     - extraParts: آرایه‌ی اجزای اضافی که مصرف‌کننده می‌سازد (مثل «سهم دلاری»)
     - سازگاری: اگر جای extraParts یک شیء آستانه داده شود، مثل نسخه‌ی قبل
     رفتار می‌کند (th) — تا فراخوان‌های قدیمی بی‌صدا خراب نشوند. */
  function combineMarket(btcNet, liq, div, extraParts, th){
    const parts = [];
    const T = Object.assign({}, TH, Array.isArray(extraParts) ? (th || {}) : (extraParts || {}));
    const extras = Array.isArray(extraParts) ? extraParts : [];
    let s = 0;
    if(btcNet && btcNet.level !== "unknown"){ s += btcNet.score; parts.push({ k:"شبکه‌ی بیت‌کوین", s:btcNet.score, why:btcNet.why, level:btcNet.level }); }
    if(liq && liq.level !== "unknown"){ s += liq.score; parts.push({ k:"نقدینگی استیبل‌کوین", s:liq.score, why:liq.why, level:liq.level }); }
    if(div){ s += div.score; parts.push({ k:"هم‌راستایی قیمت/زنجیره", s:div.score, why:[div.text], level:div.kind }); }
    extras.forEach(p => {
      if(p && isNum(p.s)){ s += p.s; parts.push({ k:p.k, s:p.s, why:p.why ? (Array.isArray(p.why) ? p.why : [p.why]) : [], level:p.level || null }); }
    });
    s = clamp(s, -T.capMarket - 1, Math.round(T.capMarket * 0.66));
    const level = s <= -2 ? "headwind" : s >= 2 ? "tailwind" : s !== 0 ? "mixed" : "flat";
    const riskOff = !!(liq && liq.flags && liq.flags.drain) && !!(btcNet && (btcNet.flags.hashDrop || btcNet.flags.diffCut));
    return { score: s, level, parts, riskOff,
      reasons: parts.flatMap(p => (p.why || []).map(w => "[" + p.k + "] " + w)),
      liq: liq || null, net: btcNet || null, div: div || null };
  }

  /* ------------------------- ابزار رندر ------------------------- */
  function pctTxt(v, d = 1){ return v == null ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(d) + '٪'; }
  function fmtInt(v){ return Number(v || 0).toLocaleString('en-US'); }
  function fmtUsdBig(n){
    if(!isNum(n)) return '—';
    const a = Math.abs(n);
    if(a >= 1e12) return (n / 1e12).toFixed(2) + ' T$';
    if(a >= 1e9) return (n / 1e9).toFixed(1) + ' B$';
    if(a >= 1e6) return (n / 1e6).toFixed(0) + ' M$';
    return Math.round(n).toLocaleString('en-US') + ' $';
  }

  return {
    VERSION, NS, TH, GAP, TTL, LIMITS, ENDPOINTS, STABLE_SEED, CHAIN_ALIAS, HOURLY_CAP,
    setEnv, nowMs, getJSON, hasBudget,
    canCall, noteCall, backoffOn, budgetState, restoreUsage, resetBudget,
    cacheGet, cacheSet, cacheAge,
    readBtcNetwork, analyzeBtcNetwork, networkPriceDivergence,
    parseStableSeries, mergeStableSeries, changeOver, analyzeLiquidity,
    pushLiqSnap, loadLiqHistory, shareTrend,
    readChains, chainLookup, pushChainHistory, loadChainHistory, tvlAt, analyzeChain,
    analyzeFloat, combineMarket,
    pctTxt, fmtInt, fmtUsdBig, clamp, isNum, round
  };
});
