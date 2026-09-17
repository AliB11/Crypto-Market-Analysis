/* =====================================================================
   tests/backtest.mjs — آزمون تاریخی (walk-forward) روی داده‌ی ساختگیِ کنترل‌شده

   اجرا:  node tests/backtest.mjs            (گزارش + خروج ۰)
          node tests/backtest.mjs --strict   (اگر قاعده‌ی تازه بهتر از پایه نبود، خروج ۱)

   چرا این‌طور؟
   * محیط این مخزن به شبکه دسترسی ندارد و داده‌ی تاریخی واقعی را نمی‌توان
     داخل مخزن نگه داشت. پس دو راه می‌ماند: (الف) بک‌تست بدلی که قواعد را
     دوباره پیاده می‌کند، (ب) همان برنامه‌ی واقعی روی داده‌ی ساختگیِ
     کنترل‌شده. این فایل راه (ب) است: دقیقاً app.js و ماژول‌های واقعی اجرا
     می‌شوند (با tests/harness.mjs) و فقط ورودی بازار ساختگی است.
   * داده‌ی ساختگی «اثر» دارد: شکست‌های همراه‌با‌حجم واقعاً ادامه می‌دهند و
     فاندینگ داغ مثبت واقعاً به اصلاح می‌رسد. پس اگر قاعده‌ی ما این اثر را
     نگیرد، آزمون شکست می‌خورد — نه اینکه با داده‌ی تصادفی بی‌معنا شود.
   * هیچ نگاه به آینده‌ای وجود ندارد: هر پنجره فقط داده‌ی تا «همان لحظه» را
     می‌بیند و نتیجه از کندل‌های بعدی سنجیده می‌شود.
   ===================================================================== */
import {boot, settled} from './harness.mjs';

const HOUR = 3600000;
const STEP_HOURS = Number(process.env.BT_STEP || 24);       // فاصله‌ی پنجره‌ها
const HORIZON = Number(process.env.BT_HORIZON || 72);       // افق سنجش پس از پر شدن سفارش
const FILL_WINDOW = Number(process.env.BT_FILL || 48);      // مهلت رسیدن قیمت به محدوده‌ی خرید
const DAYS = Number(process.env.BT_DAYS || 60);
const TOTAL_H = DAYS * 24;
const WARMUP = 192;                                          // ۸ روز گرم‌کردن

const ALTS = [
  ['ethereum','eth','Ethereum',2,1.0], ['solana','sol','Solana',4,1.25],
  ['cardano','ada','Cardano',9,0.85], ['chainlink','link','Chainlink',14,1.1],
  ['dogecoin','doge','Dogecoin',8,1.4]
];

/* ------------------------- مولد داده -------------------------
   دو چیز را باید هم‌زمان بسازیم: (۱) رژیم‌های کلان که دروازه‌ی ما را باز و
   بسته کنند، (۲) رفتار «پولبک در روند» که استراتژی ما روی آن بنا شده است.
   پس هر آلت با یک روند + انحراف بازگشت‌به‌میانگین ساخته می‌شود: در رژیم
   صعودی، افت قیمت (انحراف منفی) بعداً جبران می‌شود و در ریزش، نه. اگر
   قاعده‌ای این اثر را از دست بدهد، انتظار ریاضی‌اش منفی می‌شود. */
function rng(seed){
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const PHASES = ['bull', 'bull', 'bull', 'recover', 'chop', 'crash'];   // چرخه‌ی ۶ فاز × ۲۴۰ ساعت
function regimeOf(h){
  const idx = Math.floor(h / 240) % PHASES.length;
  return PHASES[idx];
}
function driftOf(regime){
  return { bull:0.00045, chop:0.0, crash:-0.0009, recover:0.0006 }[regime];
}
function volOf(regime){
  return { bull:0.0045, chop:0.004, crash:0.008, recover:0.006 }[regime];
}
function makeSeries(seed){
  const rnd = rng(seed);
  const closes = [], volumes = [], regimes = [];
  let btc = 100;
  for(let h = 0; h < TOTAL_H + WARMUP; h++){
    const regime = regimeOf(h);
    regimes.push(regime);
    btc *= Math.max(0.5, 1 + driftOf(regime) + (rnd() - 0.5) * 2 * volOf(regime));
    closes.push(btc);
    volumes.push(1000 * (1 + rnd() * 0.4));
  }
  /* آلت‌ها: روند = BTC با بتا، انحراف = AR(1) که در روند صعودی جبران می‌شود */
  const alts = ALTS.map(([id], k) => {
    const beta = ALTS[k][4], dev = [], price = [];
    let d = 0;
    for(let h = 0; h < closes.length; h++){
      const regime = regimes[h];
      const pull = { bull:-0.00035, chop:-0.00005, crash:-0.0016, recover:-0.0003 }[regime];
      d = d * 0.9 + pull + (rnd() - 0.5) * 0.012;
      d = Math.max(-0.25, Math.min(0.2, d));
      dev.push(d);
      const trend = closes[h] * (1 + (beta - 1) * 0.6);
      price.push(trend * (1 + d));
    }
    return {id, beta, price, dev};
  });
  return {closes, volumes, regimes, alts, rnd};
}
const SERIES = makeSeries(20260918);

/* ------------------------- برش‌های بدون نگاه به آینده ------------------------- */
function sparkAt(endIndex){                                  // ۱۶۸ ساعت اخیر (BTC)
  const start = endIndex - 167;
  return SERIES.closes.slice(start, endIndex + 1);
}
function altSparkAt(altIndex, endIndex){
  const start = endIndex - 167;
  return SERIES.alts[altIndex].price.slice(start, endIndex + 1).map(p => Number(p.toFixed(6)));
}
function seriesOf(id){
  const idx = SERIES.alts.findIndex(x => x.id === id);
  return idx < 0 ? SERIES.closes : SERIES.alts[idx].price;
}
function candles4h(id, endIndex, hours = 720){               // ۳۰ روز، فقط گذشته
  const src = seriesOf(id);
  const start = Math.max(0, endIndex - hours + 1);
  const out = [];
  for(let i = start; i <= endIndex; i += 4){
    const seg = src.slice(i, Math.min(i + 4, endIndex + 1));
    if(seg.length < 2) break;
    out.push([1690000000000 + i * HOUR, seg[0], Math.max(...seg), Math.min(...seg), seg[seg.length - 1]]);
  }
  return out;
}
function chartAt(id, endIndex, hours = 168){
  const src = seriesOf(id);
  const start = Math.max(0, endIndex - hours + 1);
  const prices = [], total_volumes = [];
  for(let i = start; i <= endIndex; i++){
    /* حجم در پولبک‌های روند صعودی بالاتر است — همان اثری که تأیید حجم باید بگیرد */
    const dip = src[i] < src[Math.max(0, i - 24)];
    const vol = SERIES.volumes[i] * (dip ? 1.35 : 1);
    prices.push([1690000000000 + i * HOUR, Number(src[i].toFixed(6))]);
    total_volumes.push([1690000000000 + i * HOUR, Number(vol.toFixed(2))]);
  }
  return {prices, total_volumes};
}
/* فاندینگ ساختگی: در سقف‌های روند، فاندینگ به‌شدت مثبت می‌شود و بعد اصلاح
   می‌آید؛ در کف‌های ریزش، فاندینگ منفی می‌شود. */
function derivAt(endIndex){
  const ch24 = (SERIES.closes[endIndex] / SERIES.closes[endIndex - 24] - 1) * 100;
  const funding = Number((0.0001 + Math.max(-0.0009, Math.min(0.0012, ch24 * 0.00003))).toFixed(6));
  const rows = [];
  ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT', 'LINKUSDT', 'DOGEUSDT'].forEach(sym => {
    rows.push({market:'Binance (Futures)', symbol:sym, index_id:sym.replace(/USDT$/, ''), contract_type:'perpetual',
      funding_rate:funding, open_interest:5e8, volume_24h:2e8, basis:funding * 3000, spread:0.02});
    rows.push({market:'Bybit', symbol:sym.replace('USDT', '-USDT'), index_id:sym.replace(/USDT$/, ''), contract_type:'perpetual',
      funding_rate:funding * 0.9, open_interest:3e8, volume_24h:1e8, basis:funding * 2800, spread:0.03});
  });
  return rows;
}

const change = (a, b) => Number(((a / b - 1) * 100).toFixed(4));
/* ساخت ارزها در لحظه‌ی endIndex — دقیقاً با همان شکل پاسخ CoinGecko، بدون
   هیچ داده‌ای از آینده */
function coinsAt(endIndex){
  const btcSpark = sparkAt(endIndex);
  const mk = (id, sym, name, rank, spark, mcap) => ({
    id, symbol:sym, name, market_cap_rank:rank, image:'',
    current_price:spark[spark.length - 1], market_cap:mcap, total_volume:mcap * 0.05,
    high_24h:Math.max(...spark.slice(-24)), low_24h:Math.min(...spark.slice(-24)),
    ath:Math.max(...spark) * 1.2, ath_change_percentage:-33,
    circulating_supply:1e8, total_supply:1e9, last_updated:new Date(0).toISOString(),
    price_change_percentage_1h_in_currency:0, price_change_percentage_24h_in_currency:0,
    price_change_percentage_7d_in_currency:0, price_change_percentage_30d_in_currency:0,
    sparkline_in_7d:{price:spark}
  });
  const fill = (c, spark) => {
    c.price_change_percentage_1h_in_currency = change(spark[spark.length - 1], spark[spark.length - 2]);
    c.price_change_percentage_24h_in_currency = change(spark[spark.length - 1], spark[spark.length - 25]);
    c.price_change_percentage_7d_in_currency = change(spark[spark.length - 1], spark[0]);
    c.price_change_percentage_30d_in_currency = c.price_change_percentage_7d_in_currency * 1.4;
    return c;
  };
  const coins = [fill(mk('bitcoin','btc','Bitcoin',1,btcSpark,1.2e12), btcSpark)];
  ALTS.forEach(([id, sym, name, rank], i) => {
    const spark = altSparkAt(i, endIndex);
    coins.push(fill(mk(id, sym, name, rank, spark, 4e10 / (i + 1)), spark));
  });
  return coins;
}

/* ------------------------- سنجش پیامد ------------------------- */
/* استراتژی برنامه «سفارش محدود در محدوده‌ی خرید» است، نه خرید به قیمت بازار.
   پس اول می‌سنجیم آیا قیمت تا N ساعت به محدوده رسیده (پر شدن سفارش)، و بعد
   پیامد را از همان قیمت ورود تا حد ضرر/هدف برنامه حساب می‌کنیم. فقط کلوزها
   در دسترس‌اند: اگر در یک کندل هم حد ضرر و هم هدف لمس شده باشد، «ضرر» فرض
   می‌شود تا نتیجه خوش‌بینانه نباشد. */
function fillIndex(src, entry, endIndex, windowHours){
  const last = Math.min(endIndex + windowHours, src.length - 1);
  for(let i = endIndex + 1; i <= last; i++) if(src[i] <= entry) return i;
  return -1;
}
function outcome(src, entry, stop, tp, fromIndex, horizon){
  const R = entry - stop;
  if(!(R > 0) || !(tp > entry)) return null;
  let mfe = 0, mae = 0;
  const last = Math.min(fromIndex + horizon, src.length - 1);
  for(let i = fromIndex + 1; i <= last; i++){
    const px = src[i];
    mfe = Math.max(mfe, (px - entry) / R);
    mae = Math.min(mae, (px - entry) / R);
    if(px <= stop) return {r:-1, kind:'stop', mfe, mae, hours:i - fromIndex};
    if(px >= tp) return {r:(tp - entry) / R, kind:'tp', mfe, mae, hours:i - fromIndex};
  }
  return {r:(src[last] - entry) / R, kind:'timeout', mfe, mae, hours:last - fromIndex};
}

/* ------------------------- اجرای یک بازو ------------------------- */
/* هر مشاهده با دو برچسب ثبت می‌شود: وضعیت دروازه و کیفیت داده.
   این‌طور در یک اجرا می‌توان «تشخیص دروازه» و «ارزش لایه‌ی داده» را سنجید،
   بدون نیاز به اجرای جداگانه و بدون مقایسه‌ی سیب و پرتقال. */
async function runArm({enriched}){
  const obs = [];
  for(let end = WARMUP + 168; end + FILL_WINDOW + HORIZON < TOTAL_H + WARMUP; end += STEP_HOURS){
    const network = {md:enriched, deriv:enriched ? derivAt(end) : null};
    const {api} = boot({
      coins:coinsAt(end),
      network,
      hooks:{ ohlc:id => candles4h(id, end), chart:id => chartAt(id, end) }
    });
    await settled(api);
    if(enriched){
      await api.refreshDerivatives();
      for(let i = 0; i < api.state.coins.length + 1; i++){
        api.MarketData.resetBudget();
        const got = await api.runEnrichment();
        if(!got) break;
      }
    }
    for(const c of api.state.coins){
      const a = c.a;
      if(!a || !a.ok) continue;
      const src = seriesOf(c.id);
      const fillIdx = fillIndex(src, a.entry, end, FILL_WINDOW);
      const gateState = a.gate ? a.gate.state : 'none';
      if(fillIdx < 0){
        obs.push({kind:'nofill', r:null, id:c.id, window:end, gate:gateState, md:a.mdQuality || 'base'});
        continue;
      }
      const o = outcome(src, a.entry, a.stop, a.tp1, fillIdx, HORIZON);
      if(o) obs.push({...o, id:c.id, window:end, gate:gateState, md:a.mdQuality || 'base', rr:a.rr});
    }
  }
  return obs;
}

function stats(all){
  const obs = all.filter(o => Number.isFinite(o.r));
  if(!obs.length) return {n:0, fills:0, nofill:all.length};
  const rs = obs.map(o => o.r).sort((x, y) => x - y);
  const mean = rs.reduce((s, v) => s + v, 0) / rs.length;
  const wins = obs.filter(o => o.kind === 'tp').length;
  const mid = rs.length % 2 ? rs[(rs.length - 1) / 2] : (rs[rs.length / 2 - 1] + rs[rs.length / 2]) / 2;
  const mfe = obs.reduce((s, o) => s + o.mfe, 0) / obs.length;
  const mae = obs.reduce((s, o) => s + o.mae, 0) / obs.length;
  const gross = rs.filter(v => v > 0).reduce((s, v) => s + v, 0);
  const loss = -rs.filter(v => v < 0).reduce((s, v) => s + v, 0);
  return {n:obs.length, fills:obs.length, nofill:all.length - obs.length,
    win:obs.filter(o => o.r > 0).length / obs.length, tpRate:wins / obs.length,
    mean, mid, pf: loss > 0 ? gross / loss : Infinity, mfe, mae,
    stopRate:obs.filter(o => o.kind === 'stop').length / obs.length};
}
const f = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '∞');

/* ------------------------- اجرا ------------------------- */
const t0 = Date.now();
const baseArm = await runArm({enriched:false});
const richArm = await runArm({enriched:true});
const line = (label, all, opts={}) => {
  const s = stats(all);
  if(!s.n) return console.log(label.padEnd(44), '0 — موردی برای سنجش نبود');
  console.log(label.padEnd(44), String(s.fills).padStart(5), String(s.nofill).padStart(5),
    (s.win * 100).toFixed(1).padStart(6), (s.tpRate * 100).toFixed(1).padStart(6), (s.stopRate * 100).toFixed(1).padStart(6),
    f(s.mean).padStart(8), f(s.pf).padStart(6), f(s.mfe).padStart(6), f(s.mae).padStart(6));
};
const header = () => console.log('بازو'.padEnd(44), 'پر'.padStart(5), 'نارس'.padStart(5), 'برد٪'.padStart(6), 'TP٪'.padStart(6), 'SL٪'.padStart(6), 'انتظارR'.padStart(8), 'PF'.padStart(6), 'MFE'.padStart(6), 'MAE'.padStart(6));

console.log(`\n=== بک‌تست — ${DAYS} روز داده‌ی ساختگی، پنجره‌های ${STEP_HOURS} ساعته، مهلت پر شدن ${FILL_WINDOW} ساعت، افق ${HORIZON} ساعت ===\n`);
console.log('— تفکیک بر اساس «وضعیت دروازه» (کل نمونه، هر دو بازو) —');
header();
const both = [...baseArm, ...richArm];
['open','watch','blocked','exempt'].forEach(st => line(`دروازه: ${st}`, both.filter(o => o.gate === st)));
line('همه‌ی سفارش‌های پر شده', both);

console.log('\n— تفکیک بر اساس «کیفیت داده» —');
header();
line('داده‌ی پایه (بدون ATR/حجم)', both.filter(o => o.md === 'base'));
line('داده‌ی غنی‌شده (ناقص: فقط کندل)', both.filter(o => o.md === 'partial'));
line('داده‌ی غنی‌شده (کامل: کندل+حجم)', both.filter(o => o.md === 'full'));

console.log('\n— مقایسه‌ی بازوها (کل سفارش‌های پر شده) —');
header();
line('بازو الف: بدون لایه‌ی داده', baseArm);
line('بازو ب: با لایه‌ی داده‌ی غنی‌شده', richArm);

const st = (arr, key, val) => stats(arr.filter(o => o[key] === val));
/* سؤال عملیاتی این است: ورودهای «مجاز» بهتر از «مسدود»ها هستند یا نه؟
   پس open و watch در یک سمت و blocked در سمت دیگر می‌آید. */
const permitted = stats(both.filter(o => ['open','watch'].includes(o.gate)));
const blocked = st(both,'gate','blocked');
const rich = st(both,'md','full'), plain = st(both,'md','base');
const gateGain = (permitted.n >= 8 && blocked.n >= 8) ? permitted.mean - blocked.mean : null;
const dataGain = (rich.n >= 8 && plain.n >= 8) ? rich.mean - plain.mean : null;
console.log('\n--- داوری (فقط با نمونه‌ی کافی ≥ ۸ مشاهده در هر سمت) ---');
console.log(`تشخیص دروازه (مجاز[open/watch] − مسدود): ${gateGain == null ? 'نمونه کافی نیست' : f(gateGain) + 'R'}`);
console.log(`ارزش لایه‌ی داده (کامل − پایه، در همان بازار): ${dataGain == null ? 'نمونه کافی نیست' : f(dataGain) + 'R'}`);
const verdicts = [];
if(gateGain != null) verdicts.push(gateGain >= 0
  ? '✅ دروازه‌ی رژیم ورودهای بهتری انتخاب می‌کند (انتظار بازِ دروازه بهتر از بقیه است)'
  : '❌ دروازه‌ی رژیم ورودهای بهتری انتخاب نکرد — آستانه‌ها نیازمند بازنگری‌اند');
if(dataGain != null) verdicts.push(dataGain >= 0
  ? '✅ لایه‌ی داده‌ی غنی‌شده (ATR واقعی + تأیید حجم) انتظار را بهتر می‌کند'
  : '❌ لایه‌ی داده‌ی غنی‌شده بهتر از پایه نبود — قواعد باید بازبینی شوند');
if(!verdicts.length) verdicts.push('ℹ️ نمونه‌ی کافی برای داوری جمع نشد — بازه‌ی داده یا افق را بیشتر کنید');
verdicts.forEach(v => console.log(v));
console.log(`\nزمان اجرا: ${((Date.now() - t0) / 1000).toFixed(1)} ثانیه • داده‌ی ساختگیِ کنترل‌شده (اثرهای واقعی: ادامه‌ی روند پس از پولبک، حجم بالاتر در افت، فاندینگ داغ در سقف)`);
console.log('این آزمون جای اعتبارسنجی روی داده‌ی واقعی را نمی‌گیرد؛ هدفش «آیا قاعده جهت درست را می‌گیرد؟» است.\n');

if(process.argv.includes('--strict') && verdicts.some(v => v.startsWith('❌'))) process.exit(1);
