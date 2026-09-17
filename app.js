/* =====================================================================
   کریپتوبین — منطق برنامه (نسخه بهبودیافته UX/گرافیک/پیام‌ها)
   ===================================================================== */
const API = 'https://api.coingecko.com/api/v3';
const CACHE_VERSION=3, CACHE_FRESH_MS=15*60*1000, CACHE_MAX_AGE_MS=6*60*60*1000;
/* آستانه‌های لایه‌ی مشتقات — تنها منبع حقیقت، که با موتور شورت هم به اشتراک گذاشته می‌شود. */
const CROWD = (typeof MarketData!=='undefined' && MarketData.THRESHOLDS) ? MarketData.THRESHOLDS
  : { fundingWarm:30, fundingHot:55, fundingNegWarm:-20, fundingNegHot:-40, oiRisingPct:3, rsiLongCrowd:62, rsiShortCrowd:40 };
const CATS = {
  sbuy:{k:'sbuy',label:'خرید قوی',c:'#00e676',icon:'🟢'},
  buy:{k:'buy',label:'خرید',c:'#4ade80',icon:'🟩'},
  pot:{k:'pot',label:'مستعد رشد',c:'#fbbf24',icon:'⚡'},
  hold:{k:'hold',label:'خنثی / نگهداری',c:'#94a3b8',icon:'⏸️'},
  sell:{k:'sell',label:'فروش',c:'#fb7185',icon:'🔻'},
  ssell:{k:'ssell',label:'فروش قوی',c:'#ef4444',icon:'🔴'}
};
const LS_KEYS = {
  watch:'cb_watch', cmp:'cb_cmp', gate:'cb_gate_v1', alerts:'cb_alerts',
  perf:'cb_perf_v1', cache:'cb_cache', risk:'cb_risk', mon:'cb_mon_v1',
  view:'cb_view', sort:'cb_sort', filter:'cb_filter', side:'cb_side_v1'
};
const state = {coins:[], global:null, fng:null, filter:'all', q:'', sort:'buy', view:'cards',
  deriv:null, derivAt:null, derivCount:0, history:[], globalTrend:null,
  watch: (()=>{try{return JSON.parse(localStorage.getItem(LS_KEYS.watch)||'[]')}catch(e){return []}})(),
  watchOnly:false, modalCoin:null, tf:7, chartCache:{},
  cmp: (()=>{ try{ return JSON.parse(localStorage.getItem(LS_KEYS.cmp)||'[]'); }catch(e){ return []; } })()
};
try{
  const v=localStorage.getItem(LS_KEYS.view); if(v==='cards'||v==='table') state.view=v;
  const s=localStorage.getItem(LS_KEYS.sort); if(s) state.sort=s;
  const f=localStorage.getItem(LS_KEYS.filter); if(f) state.filter=f;
}catch(e){}

/* ---------------------------------------------------------------------
   طبقه‌بندی نوع دارایی — استیبل‌کوین‌ها و توکن‌های رَپ‌شده/استیک‌شده
   --------------------------------------------------------------------- */
const STABLE_RE = /^(usdt|usdc|dai|fdusd|tusd|usde|usds|pyusd|usdd|frax|busd|gusd|lusd|usdp|susd|eurc|eurt|usd1|usd0|usdy|usdb|bfusd|rlusd|usdtb|susde|susds|ustc|xaut|paxg|cusd|buidl|ousg|crvusd|gho|dola|mim|usdx|usda|ausd|deusd|usr|ustb|bsc-usd)$/i;
const WRAPPED_RE = /^(w|cb|st|wst|r|ws|we|rs|ez|tb|lb|solv|pump|m|bn|k|ib)?(btc|eth|sol|bnb|tao)$|^(weth|wbtc|steth|wsteth|cbbtc|cbeth|reth|weeth|rseth|ezeth|tbtc|lbtc|solvbtc|frxeth|sfrxeth|meth|bnsol|jitosol|msol|jupsol|bbsol|wbnb|wbeth|sweth|oseth|lseth|ankreth|beth|hbtc|renbtc|kelp|xsolvbtc|wtao|clbtc|pumpbtc|fbtc|unibtc|sbtc|wsol|weth\.e|wbtc\.e)$/i;
function assetKind(c){
  const sym=String(c.symbol||'').toLowerCase(), name=String(c.name||'').toLowerCase();
  if(STABLE_RE.test(sym) || /\b(usd|stable|dollar)\b/.test(name) && Math.abs((c.current_price||0)-1)<0.05) return 'stable';
  if(Math.abs((c.current_price||0)-1)<0.02){
    const sp=(c.sparkline_in_7d?.price||[]).filter(x=>x!=null&&isFinite(x));
    if(sp.length>10){ const mx=Math.max(...sp), mn=Math.min(...sp); if(mn>0 && mx/mn-1<0.01) return 'stable'; }
    else if(Math.abs(c.price_change_percentage_7d_in_currency||0)<0.3 && Math.abs(c.price_change_percentage_24h_in_currency||0)<0.2) return 'stable';
  }
  if(['btc','eth','sol','bnb'].includes(sym)) return 'asset';
  if(WRAPPED_RE.test(sym) || /wrapped|staked|liquid staking|restak/.test(name)) return 'wrapped';
  return 'asset';
}
const KIND_LABEL={stable:'استیبل‌کوین',wrapped:'رَپ‌شده / استیک‌شده',asset:''};
const tradable = c => c.a && c.a.kind==='asset';

/* رژیم بازار */
const REGIMES = {
  riskon : {k:'riskon', label:'ریسک‌پذیر (Risk-On)',  icon:'🟢', c:'#00e676', adj:+4, hint:'بیت‌کوین در ساختار صعودی و اکثریت بازار مثبت — ورود پله‌ای روی آلت‌های پیشرو منطقی است.'},
  neutral: {k:'neutral',label:'خنثی / انتخابی',       icon:'🟡', c:'#fbbf24', adj:0,  hint:'ساختار مختلط — فقط سِتاپ‌های با قدرت نسبی مثبت و نسبت ریسک/بازده بالا را انتخاب کنید.'},
  riskoff: {k:'riskoff',label:'ریسک‌گریز (Risk-Off)', icon:'🔴', c:'#ef4444', adj:-7, hint:'بیت‌کوین در ساختار نزولی — اکثر آلت‌کوین‌ها با بتای بالا سقوط می‌کنند؛ حجم را کم و حد ضرر را سفت کنید.'}
};

/* =====================================================================
   لایه‌ی سوم تحلیل: دروازه‌ی رژیم (Regime Gateway) — بهبود یافته
   ===================================================================== */
const GATE_STATES={
  open   :{k:'open',   label:'باز — ورود تازه مجاز',            short:'باز',      icon:'🟢', c:'#00e676'},
  watch  :{k:'watch',  label:'انتخابی — فقط سِتاپ تأییدشده',    short:'انتخابی',  icon:'🟡', c:'#fbbf24'},
  blocked:{k:'blocked',label:'بسته — ورود تازه توصیه نمی‌شود',  short:'بسته',     icon:'🛑', c:'#ef4444'},
  exempt :{k:'exempt', label:'مستثنا — معامله تکنیکال مستقل ندارد', short:'مستثنا', icon:'⚪', c:'#94a3b8'}
};
const GATE_MODES={
  auto  :{k:'auto',  label:'خودکار'},
  strict:{k:'strict',label:'سخت‌گیرانه'},
  off   :{k:'off',   label:'خاموش'}
};
const GATE_RULES={
  open   :{score:58, rrNow:1.0, rs7:-2.0, states:['now','below','wait']},
  watch  :{score:66, rrNow:1.3, rs7: 0.0, states:['now','below']},
  closed :{score:55, rrNow:1.3, rs7: 5.0, states:['now','below']}
};
const GATE_STRICT={score:6, rrNow:0.5, rs7:1.5};

const gate={
  mode:'auto',
  onlyApproved:false,
  load(){ try{ const d=JSON.parse(localStorage.getItem(LS_KEYS.gate)||'{}');
      if(GATE_MODES[d.mode]) this.mode=d.mode; this.onlyApproved=!!d.onlyApproved; }catch(e){} },
  save(){ try{ localStorage.setItem(LS_KEYS.gate, JSON.stringify({mode:this.mode, onlyApproved:this.onlyApproved})); }catch(e){} }
};
gate.load();

function evalMarketGate(R){
  const reasons=[];
  if(!R) return {state:'watch', macro:'watch', reasons:['رژیم بازار هنوز محاسبه نشده است'], stats:null};
  let macro = R.k==='riskon' ? 'open' : R.k==='riskoff' ? 'closed' : 'watch';
  reasons.push(`رژیم بازار: ${R.label} (امتیاز ${R.pts>0?'+':''}${R.pts})`);

  if(macro==='open' && R.fng!=null && R.fng>=80 && R.breadth<0.55){
    macro='watch'; reasons.push(`طمع شدید (${R.fng}) با گستردگی ${(R.breadth*100).toFixed(0)}٪ — فقط ورود انتخابی`);
  }
  if(macro==='watch' && (R.breadth<0.2 || R.above<0.15) && R.pts<=-2){
    macro='closed'; reasons.push(`گستردگی ${(R.breadth*100).toFixed(0)}٪ و فقط ${(R.above*100).toFixed(0)}٪ بالای SMA20 با امتیاز رژیم منفی — دروازه بسته شد`);
  }
  if(macro==='closed' && R.fng!=null && R.fng<=18){
    macro='watch'; reasons.push(`ترس شدید (${R.fng}) — فقط انباشت پله‌ای روی ارزهای بزرگ با قدرت نسبی مثبت`);
  }
  if(gate.mode==='strict' && macro==='open'){ macro='watch'; reasons.push('حالت سخت‌گیرانه فعال است — آستانه‌های ورود بالاتر رفت'); }
  if(gate.mode==='off') reasons.push('دروازه خاموش است — وضعیت‌ها فقط نمایشی‌اند و هیچ سیگنالی فیلتر نمی‌شود');

  const TO_STATE={open:'open', watch:'watch', closed:'blocked'};
  return {state: gate.mode==='off' ? 'open' : (TO_STATE[macro]||'watch'), macro, reasons};
}

function evalCoinGate(c, mkt){
  const a=c.a;
  const out={state:'blocked', reasons:[], fails:[], need:null, exempt:false, rsExempt:false};
  if(!a || !a.ok){ out.reasons.push('داده‌ی کافی برای تحلیل تکنیکال وجود ندارد'); return out; }
  if(!tradable(c)){
    out.exempt=true; out.state='exempt';
    out.reasons.push(`${KIND_LABEL[a.kind]} — معامله‌ی تکنیکال مستقل ندارد و از دروازه‌ی ورود، رتبه‌بندی و کارنامه مستثناست`);
    return out;
  }
  const rules=GATE_RULES[(mkt&&mkt.macro)||'watch'];
  const st = gate.mode==='strict' ? GATE_STRICT : {score:0, rrNow:0, rs7:0};
  const need={ score:rules.score+st.score, rrNow:rules.rrNow+st.rrNow, rs7:rules.rs7+st.rs7, states:rules.states };
  out.need=need;
  const isBtc = c.id==='bitcoin';
  out.rsExempt = isBtc;
  if(a.buyScore<need.score)  out.fails.push(`امتیاز فرصت خرید ${a.buyScore} کمتر از آستانه‌ی ${need.score}`);
  if(!(a.rrNow>=need.rrNow)) out.fails.push(`ریسک/بازده با قیمت فعلی ${a.rrNow.toFixed(2)} کمتر از ${need.rrNow.toFixed(1)}`);
  if(!isBtc && !(a.rs7>=need.rs7)) out.fails.push(`قدرت نسبی به BTC ${pct(a.rs7,1)} ضعیف‌تر از آستانه‌ی ${need.rs7>0?'+':''}${need.rs7}`);
  if(!need.states.includes(a.buyState)) out.fails.push(`وضعیت ورود: ${a.buyStateTxt} (مجاز: ${need.states.map(s=>({now:'در محدوده',below:'زیر محدوده',wait:'کمی صبر'}[s]||s)).join(' / ')})`);
  if(a.volRatio<0.008)       out.fails.push('حجم معاملات نسبت به ارزش بازار ناکافی است (نقدشوندگی پایین)');
  /* فیلتر ازدحام فقط با داده‌ی معتبر فعال می‌شود: فاندینگ داغ + OI صعودی یعنی
     خریداران اهرمی در اوج؛ ورود تازه در این نقطه ریسک اصلاح اهرمی دارد. */
  if(a.crowd && a.crowd.side==='long' && a.crowd.level==='hot'){
    out.fails.push(`${a.crowd.reason} — ورود تازه در اوج اهرم توصیه نمی‌شود`);
  }

  if(!out.fails.length){
    out.state='open';
    out.reasons.push(`همه‌ی شرط‌های دروازه برقرار است (امتیاز ${a.buyScore}، R/R ${a.rrNow.toFixed(2)}${isBtc?'':`، RS ${pct(a.rs7,1)}`})`);
  } else if(out.fails.length===1 && a.buyScore>=need.score-8 && a.rrNow>=need.rrNow-0.5){
    out.state='watch';
    out.reasons.push('فقط یک شرط باقی مانده — در واچ‌لیست نگه دارید و منتظر تأیید بمانید');
    out.reasons.push(out.fails[0]);
  } else {
    out.state='blocked';
    out.reasons=out.fails.slice();
  }
  return out;
}

function gatePermit(c, need='any'){
  if(gate.mode==='off') return true;
  const g=c.a && c.a.gate;
  if(!g || g.exempt) return true;
  return need==='open' ? g.state==='open' : g.state!=='blocked';
}

function gateStats(){
  const s={open:0,watch:0,blocked:0,exempt:0,total:0};
  state.coins.forEach(c=>{ const g=c.a&&c.a.gate; if(!g) return; s.total++;
    if(g.exempt) s.exempt++; else s[g.state]=(s[g.state]||0)+1; });
  return s;
}

function gateRank(c){
  const g=c.a && c.a.gate;
  if(gate.mode==='off' || !g || g.exempt) return 0;
  return g.state==='open' ? 0 : g.state==='watch' ? 1 : 2;
}

function gateBadge(g){
  if(!g) return '';
  if(g.exempt){
    const S=GATE_STATES.exempt;
    return `<span class="gbadge" style="--gc:${S.c}" title="${esc(S.label)}">${S.icon} ${esc(S.short)}</span>`;
  }
  const S=GATE_STATES[g.state];
  if(!S) return '';
  const title=g.reasons.length? g.reasons.join(' • ') : S.label;
  return `<span class="gbadge" style="--gc:${S.c}" title="${esc(title)}">${S.icon} ${esc(S.short)}</span>`;
}

/* ------------------------- Helpers ------------------------- */
const $ = s=>document.querySelector(s);
const esc = v => String(v==null?'':v).replace(/[&<>\"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const safeImg = u => { const t=String(u||''); return /^https:\/\//i.test(t) ? esc(t) : ''; };
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const fmtN=(n,d)=>n==null?'—':Number(n).toLocaleString('en-US',{maximumFractionDigits:d??2,minimumFractionDigits:0});
function fmtP(p){ if(p==null) return '—'; if(p>=1000) return '$'+fmtN(p,0); if(p>=1) return '$'+fmtN(p,2); if(p>=0.01) return '$'+fmtN(p,4); return '$'+Number(p).toPrecision(3); }
function fmtBig(n){ if(n==null) return '—'; const a=Math.abs(n); if(a>=1e12) return '$'+(n/1e12).toFixed(2)+' T'; if(a>=1e9) return '$'+(n/1e9).toFixed(2)+' B'; if(a>=1e6) return '$'+(n/1e6).toFixed(1)+' M'; return '$'+fmtN(n,0); }
const pct=(v,d=2)=> v==null?'—':(v>0?'+':'')+v.toFixed(d)+'%';
const cls=v=> v>=0?'up':'down';
function toast(m,ms=3500){ const t=$('#toast'); t.textContent=m; t.classList.add('show'); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),ms); }
const faTime=d=>new Date(d).toLocaleTimeString('fa-IR',{hour:'2-digit',minute:'2-digit'});
function debounce(fn,ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }

/* ------------------------- Indicators ------------------------- */
function SMA(a,n){ const o=new Array(a.length).fill(null); let s=0; for(let i=0;i<a.length;i++){ s+=a[i]; if(i>=n) s-=a[i-n]; if(i>=n-1) o[i]=s/n; } return o; }
function EMA(a,n){ const o=new Array(a.length).fill(null); const k=2/(n+1); let p=null; for(let i=0;i<a.length;i++){ if(a[i]==null) continue; p = p==null? a[i] : a[i]*k+p*(1-k); if(i>=n-1) o[i]=p; } return o; }
function RSI(a,n=14){ const o=new Array(a.length).fill(null); let g=0,l=0; for(let i=1;i<a.length;i++){ const d=a[i]-a[i-1]; if(i<=n){ if(d>0) g+=d; else l-=d; if(i===n){ g/=n; l/=n; o[i]=l===0?100:100-100/(1+g/l); } } else { g=(g*(n-1)+Math.max(d,0))/n; l=(l*(n-1)+Math.max(-d,0))/n; o[i]=l===0?100:100-100/(1+g/l); } } return o; }
function MACD(a){ const e12=EMA(a,12), e26=EMA(a,26); const m=a.map((_,i)=> e12[i]!=null&&e26[i]!=null? e12[i]-e26[i] : null); const sig=EMA(m,9); const h=m.map((v,i)=> v!=null&&sig[i]!=null? v-sig[i]:null); return {macd:m,signal:sig,hist:h}; }
function BB(a,n=20,k=2){ const m=SMA(a,n); const up=[],lo=[]; for(let i=0;i<a.length;i++){ if(m[i]==null){up.push(null);lo.push(null);continue;} let s=0; for(let j=i-n+1;j<=i;j++) s+=(a[j]-m[i])**2; const sd=Math.sqrt(s/n); up.push(m[i]+k*sd); lo.push(m[i]-k*sd);} return {mid:m,up,lo}; }
function linreg(a){ const n=a.length; let sx=0,sy=0,sxy=0,sxx=0; for(let i=0;i<n;i++){ sx+=i; sy+=a[i]; sxy+=i*a[i]; sxx+=i*i; } const slope=(n*sxy-sx*sy)/(n*sxx-sx*sx); const mean=sy/n; return {slope, rel:slope/mean}; }
function volatility(a){ const r=[]; for(let i=1;i<a.length;i++) r.push(Math.log(a[i]/a[i-1])); const m=r.reduce((x,y)=>x+y,0)/r.length; const v=Math.sqrt(r.reduce((x,y)=>x+(y-m)**2,0)/r.length); return v; }
const last=a=>{ for(let i=a.length-1;i>=0;i--) if(a[i]!=null) return a[i]; return null; };
const prev=a=>{ let c=0; for(let i=a.length-1;i>=0;i--) if(a[i]!=null){ if(c===1) return a[i]; c++; } return null; };

/* ارزهایی که در این چرخه ارزش هزینه‌ی فراخوان را دارند: واچ‌لیست ← مجاز ←
   انتخابی ← بالاترین امتیاز خرید. اولویت کمتر = مهم‌تر. */
function enrichmentCandidates(){
  const cs = state.coins.filter(c => c.a && c.a.ok && tradable(c));
  return cs.map(c=>{
    const g = c.a.gate;
    let p = 9;
    if(state.watch.includes(c.id)) p = 0;
    else if(g && g.state==='open') p = 1;
    else if(g && g.state==='watch') p = 2;
    else if(c.a.buyScore >= 70) p = 3;
    else if(c.a.buyScore >= 58) p = 4;
    return { id:c.id, p, score:c.a.buyScore };
  }).filter(x => x.p <= 4);
}
/* خروجی: true فقط وقتی داده‌ی تازه‌ای واکشی شده باشد (برای امتیازدهی مجدد). */
async function refreshDerivatives(){
  const MD = (typeof MarketData!=='undefined') ? MarketData : null;
  if(!MD || !shortFresh()) return false;
  const t = Date.now();
  const cached = MD.cacheGet('deriv', 'all', MD.TTL.deriv);
  if(cached){
    state.derivAt = MD.cacheAge('deriv','all');
    state.deriv = cached.bySymbol || null;
    state.derivCount = cached.count || (state.deriv ? Object.keys(state.deriv).length : 0);
    return false;
  }
  if(!MD.canEnrich(t, 'deriv')) return false;
  MD.noteCall(t, 'deriv');
  const url = `${API}/derivatives`;
  const rows = await MD.getJSON(url, 15000);
  if(!rows || rows.__error){ MD.backoffOn(rows && rows.status === 429); return false; }
  const bySymbol = MD.derivativesBySymbol(rows);
  const count = Object.keys(bySymbol).length;
  if(!count) return false;
  MD.cacheSet('deriv', 'all', { bySymbol, count });
  state.deriv = bySymbol;
  state.derivAt = 0;
  state.derivCount = count;
  Object.values(bySymbol).forEach(b => { if(b.symbol) MD.recordOi(b.symbol, b.oiUsd, t); });
  return true;
}
/* در هر چرخه حداکثر یک قدم غنی‌سازی: یک فراخوان کندل و (در صورت اجازه‌ی
   بودجه) یک فراخوان سری حجم. ارز فقط وقتی از صف بیرون می‌رود که «هر دو»
   کش موجود باشد؛ در غیر این صورت چرخه‌ی بعد بقیه‌اش را می‌گیرد. */
async function runEnrichment(){
  const MD = (typeof MarketData!=='undefined') ? MarketData : null;
  if(!MD || !shortFresh()) return 0;
  MD.plan(enrichmentCandidates());
  const id = MD.next();
  if(!id) return 0;
  const coin = state.coins.find(c => c.id === id);
  if(!coin){ MD.dropFromQueue(id); return 0; }
  const ageO = MD.cacheAge('ohlc', id), ageC = MD.cacheAge('chart', id);
  if(ageO != null && ageC != null && ageO <= MD.TTL.ohlc && ageC <= MD.TTL.chart){ MD.dropFromQueue(id); return 0; }
  const t = Date.now();
  if(!MD.canEnrich(t)) return 0;          // بودجه اجازه نمی‌دهد — خطای ارز نیست
  let got = 0, failed = 0;
  const md = coin.md || {};
  if(ageO == null || ageO > MD.TTL.ohlc){
    MD.noteCall(t);
    const ohlc = MD.rowsToCandles(await MD.getJSON(`${API}/coins/${encodeURIComponent(id)}/ohlc?vs_currency=usd&days=30`, 15000));
    if(ohlc){ MD.cacheSet('ohlc', id, ohlc); md.ohlc = ohlc; got++; } else failed++;
  }
  if((ageC == null || ageC > MD.TTL.chart) && MD.canEnrich(Date.now())){
    MD.noteCall(Date.now());
    const s = MD.priceVolumeSeries(await MD.getJSON(`${API}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=7`, 15000));
    if(s){ MD.cacheSet('chart', id, s); md.series = s; got++; } else failed++;
  }
  if(got){
    md.at = Date.now();
    coin.md = md;
    delete coin._mdDerived;
    coin.a = analyze(coin);
    applyMarketContext();
  }
  if(failed && !got) MD.fail(id);
  if(MD.cacheAge('ohlc', id) != null && MD.cacheAge('chart', id) != null) MD.dropFromQueue(id);
  return got;
}
/* داده‌ی کش‌شده را روی ارزها می‌نشاند — بدون هیچ فراخوان تازه. روی آرایه‌ی
   خامِ پاسخ بازار هم کار می‌کند تا تحلیلِ همین چرخه از ابتدا غنی باشد. */
function attachCachedMarketData(list){
  const MD = (typeof MarketData!=='undefined') ? MarketData : null;
  if(!MD) return;
  (Array.isArray(list) ? list : state.coins).forEach(c=>{
    if(!c || c.kind && c.kind !== 'asset') return;
    if(assetKind(c) !== 'asset') return;
    const ageO = MD.cacheAge('ohlc', c.id), ageC = MD.cacheAge('chart', c.id);
    if(ageO == null && ageC == null) return;
    const md = {};
    /* مهلت مضاعف: داده‌ی کمی کهنه بهتر از نبود داده است، چون فقط محافظه‌کارانه‌
       تر می‌کند (ATR بزرگ‌تر/شکست قدیمی) و هرگز سیگنال تازه نمی‌سازد. */
    const ohlc = ageO != null ? MD.cacheGet('ohlc', c.id, MD.TTL.ohlc*4) : null;
    const series = ageC != null ? MD.cacheGet('chart', c.id, MD.TTL.chart*4) : null;
    if(ohlc) md.ohlc = ohlc;
    if(series) md.series = series;
    if(md.ohlc || md.series){
      md.at = Date.now() - Math.min(ageO ?? Infinity, ageC ?? Infinity);
      c.md = md;
    }
  });
}
function mdStatusText(){
  const MD = (typeof MarketData!=='undefined') ? MarketData : null;
  if(!MD) return 'لایه‌ی داده‌ی غنی‌شده در دسترس نیست';
  const b = MD.budgetState();
  const enriched = state.coins.filter(c => c.md && (c.md.ohlc || c.md.series)).length;
  const throttle = b.throttledForMs > 0 ? ` • محدودیت نرخ: ${Math.ceil(b.throttledForMs/1000)} ثانیه` : '';
  const deriv = state.derivCount ? ` • مشتقات: ${state.derivCount} نماد` : '';
  return `بودجه: ${MD.PROFILES[b.profile].label} (${(b.gapMs/1000).toFixed(0)} ثانیه بین فراخوان‌ها) • غنی‌شده: ${enriched} ارز • در صف: ${MD.pendingCount()} • فراخوان امروز: ${b.callsToday}${deriv}${throttle}`;
}

/* =====================================================================
   لایه‌ی داده‌ی غنی‌شده (فاز ۱)
   کندل ۴ساعته و سری ساعتی حجم برای «ارزهای نامزد» جداگانه و با بودجه‌ی
   محدود واکشی می‌شود. اگر برای ارزی داده‌ای نباشد، همه‌ی میدان‌های زیر
   null می‌مانند و موتور قبلی بدون هیچ تغییری کار می‌کند — یعنی این لایه
   فقط می‌تواند سیگنال را بهتر کند، نه اینکه نبودش چیزی را بشکند.
   ===================================================================== */
const MD_EMPTY = () => ({ mdAt:null, atr:null, stDir:null, adx:null, diPlus:null, diMinus:null,
  volZ:null, volRatioH:null, cmf:null, mfi:null, obvSlope:null, vwapVol:null, cvdDir:null,
  brk24:null, brk7d:null, swingLow:null, swingHigh:null, candles4h:0, candles1h:0, mdQuality:'base' });

/* محاسبه‌ی میدان‌های غنی‌شده برای یک ارز — با حافظه‌ی داخلی تا هر چرخه
   دوباره از صفر حساب نشود (کلید: زمان داده‌ی غنی‌شده). */
function deriveMarketData(c){
  const empty = MD_EMPTY();
  const md = c && c.md;
  if(!md || typeof Analytics === 'undefined') return empty;
  const stamp = `${md.at||0}:${md.ohlc?md.ohlc.length:0}:${md.series?md.series.p.length:0}`;
  if(c._mdDerived && c._mdDerived._stamp === stamp) return c._mdDerived;
  const out = MD_EMPTY(), A = Analytics;
  out.mdAt = md.at || null;
  try{
    if(Array.isArray(md.ohlc) && md.ohlc.length >= 30){
      const cs = md.ohlc;
      out.candles4h = cs.length;
      out.atr = A.atrPct(cs, 14);
      const st = A.supertrend(cs, 10, 3); out.stDir = A.lastNum(st.map(x => x.dir));
      const ad = A.adx(cs, 14);
      out.adx = A.lastNum(ad.adx); out.diPlus = A.lastNum(ad.plusDI); out.diMinus = A.lastNum(ad.minusDI);
      out.brk24 = A.rangeBreakout(cs, 6);          // ۶ کندل ۴ساعته = ۲۴ ساعت
      out.brk7d = A.rangeBreakout(cs, 42);         // ۴۲ کندل = ۷ روز
      const piv = A.swingPivots(cs, 3, 3);
      const lastP = c.current_price || cs[cs.length - 1][4];
      const lows = piv.lows.filter(x => x.price < lastP);
      const highs = piv.highs.filter(x => x.price > lastP);
      out.swingLow = lows.length ? lows[lows.length - 1].price : null;
      out.swingHigh = highs.length ? highs[highs.length - 1].price : null;
    }
    if(md.series && Array.isArray(md.series.p) && Array.isArray(md.series.v) && md.series.p.length >= 24){
      const hourly = A.candlesFromSeries(md.series.p, md.series.v, md.series.t);
      out.candles1h = hourly.length;
      out.volZ = A.volumeZ(hourly, 48);
      out.volRatioH = A.volumeRatio(hourly, 48);
      out.mfi = A.lastNum(A.mfi(hourly, 14));
      out.cmf = A.lastNum(A.cmf(hourly, 20));
      out.obvSlope = A.obvSlope(hourly, 24);
      out.vwapVol = A.vwap(hourly);
      const ob = A.obv(hourly);
      out.cvdDir = ob.length > 6 ? (ob[ob.length - 1] > ob[ob.length - 6] ? 1 : ob[ob.length - 1] < ob[ob.length - 6] ? -1 : 0) : null;
    }
  }catch(e){ return empty; }
  out.mdQuality = (out.candles4h ? 'ohlc' : '') + (out.candles1h ? '+vol' : '') || 'base';
  Object.defineProperty(out, '_stamp', { value:stamp, enumerable:false });
  c._mdDerived = out;
  return out;
}

/* ------------------------- Core analysis ------------------------- */
let workerSeq=0;
function computeIndicatorsInWorker(coins){
  if(typeof Worker==='undefined') return Promise.resolve(null);
  return new Promise(resolve=>{
    let worker, timer;
    const done=value=>{clearTimeout(timer);worker?.terminate();resolve(value);};
    try{
      worker=new Worker('indicator-worker.js'); const id=++workerSeq;
      timer=setTimeout(()=>done(null),8000);
      worker.onmessage=e=>{if(e.data?.id===id)done(e.data.result);};
      worker.onerror=()=>done(null);
      worker.postMessage({id,series:coins.map(c=>c.sparkline_in_7d?.price||[])});
    }catch(e){done(null);}
  });
}

function analyze(c,pre=null){
  const p=(c.sparkline_in_7d?.price||[]).filter(x=>Number.isFinite(x)&&x>0);
  const a={ok:p.length>=60&&p.every(x=>Number.isFinite(x)&&x>0), prices:p, kind:assetKind(c)};
  const ch1=c.price_change_percentage_1h_in_currency||0, ch24=c.price_change_percentage_24h_in_currency||0,
        ch7=c.price_change_percentage_7d_in_currency||0, ch30=c.price_change_percentage_30d_in_currency||0;
  a.ch1=ch1;a.ch24=ch24;a.ch7=ch7;a.ch30=ch30;
  a.volRatio = c.market_cap? c.total_volume/c.market_cap : 0;
  a.athDist = c.ath_change_percentage;
  if(!a.ok){ a.score=50; a.cat='hold'; a.rsi=50; a.pred=0; a.predLo=0; a.predHi=0; a.conf=20; a.dvol=0; a.signals=[{t:'داده‌ی کافی برای تحلیل تکنیکال وجود ندارد',s:0}]; a.trend='نامشخص'; a.risk='نامشخص'; a.diverg=null; a.divergStrength=0; a.divergType=null;
    const lp=c.current_price||0; a.entry=lp*0.98; a.entryLo=lp*0.96; a.entryHi=lp; a.entryGap=-2; a.ladder=[]; a.anchors=[]; a.avgEntry=lp*0.98; a.stop=lp*0.93; a.tp1=lp*1.05; a.tp2=lp*1.1; a.rr=1; a.buyScore=35; a.grade='D'; a.gradeC='#fb7185'; a.buyState='no'; a.buyStateTxt='داده ناکافی'; a.support=lp*0.95; a.resist=lp*1.05; a.rrNow=0; a.riskPct=7; a.rs7=0; a.rs24=0; a.ctx=[]; a.buyRaw=-15; return a; }
  const lastP=p[p.length-1];
  const rsiArr=pre?.rsiArr||RSI(p,14); a.rsi=last(rsiArr); a.rsiPrev=prev(rsiArr);
  const {macd,signal,hist}=pre||MACD(p); a.macd=last(macd); a.sig=last(signal); a.hist=last(hist); a.histPrev=prev(hist);
  const sma20=pre?.sma20||SMA(p,20), sma50=pre?.sma50||SMA(p,50); a.sma20=last(sma20); a.sma50=last(sma50);
  const ema20=pre?.ema20||EMA(p,20); a.ema20=last(ema20);
  const bb=pre?.bb||BB(p,20,2); a.bbUp=last(bb.up); a.bbLo=last(bb.lo); a.bbPos=clamp((lastP-a.bbLo)/((a.bbUp-a.bbLo)||1), -1, 2);
  a.bbWidth=(a.bbUp-a.bbLo)/a.sma20*100;
  const lr=linreg(p.slice(-48)); a.slopeH=lr.rel*100;
  const lr7=linreg(p); a.slope7=lr7.rel*100;
  a.dvol=volatility(p)*Math.sqrt(24)*100;
  a.high7=Math.max(...p); a.low7=Math.min(...p); a.rangePos=(lastP-a.low7)/((a.high7-a.low7)||1);
  a.cross=null; for(let i=p.length-24;i<p.length;i++){ if(sma20[i-1]!=null&&sma50[i-1]!=null){ if(sma20[i-1]<=sma50[i-1]&&sma20[i]>sma50[i]) a.cross='golden'; if(sma20[i-1]>=sma50[i-1]&&sma20[i]<sma50[i]) a.cross='death'; } }
  a.macdCross=null; { const m=macd,s=signal; for(let i=p.length-12;i<p.length;i++){ if(m[i-1]!=null&&s[i-1]!=null){ if(m[i-1]<=s[i-1]&&m[i]>s[i]) a.macdCross='bull'; if(m[i-1]>=s[i-1]&&m[i]<s[i]) a.macdCross='bear'; } } }

  /* ---- واگرایی RSI — RD و HD ----
     RD+ (Regular Bullish): قیمت LL و RSI HL → بازگشت صعودی قوی
     RD- (Regular Bearish): قیمت HH و RSI LH → بازگشت نزولی قوی
     HD+ (Hidden Bullish): قیمت HL و RSI LL → ادامه روند صعودی
     HD- (Hidden Bearish): قیمت LH و RSI HH → ادامه روند نزولی
     هر دو در روند بسیار موثرند — RD پایان روند، HD تایید ادامه روند
  */
  a.diverg=null; a.divergStrength=0; a.divergType=null;
  {
    const W=5, look=Math.min(p.length, 96);
    const st=p.length-look;
    const lows=[], highs=[];
    for(let i=st+W; i<p.length-2; i++){
      if(rsiArr[i]==null) continue;
      const rw=Math.min(W, p.length-1-i);
      if(rw<2) break;
      let lo=true, hi=true;
      for(let j=i-W; j<=i+rw; j++){ if(j===i) continue; if(p[j]<p[i]) lo=false; if(p[j]>p[i]) hi=false; }
      lo = lo && p[i-W]>p[i] && p[i+rw]>p[i];
      hi = hi && p[i-W]<p[i] && p[i+rw]<p[i];
      if(lo) lows.push(i);
      if(hi) highs.push(i);
    }
    const pickTwo=arr=>{ if(arr.length<2) return null; const b=arr[arr.length-1], a2=arr[arr.length-2];
      return (b-a2)>=8 ? [a2,b] : (arr.length>=3 && (b-arr[arr.length-3])>=8 ? [arr[arr.length-3],b] : null); };
    const L=pickTwo(lows), H=pickTwo(highs);
    // کف‌ها: RD+ و HD+
    if(L){
      const [i1,i2]=L;
      const priceDown = p[i2] < p[i1]*0.998;
      const priceUp = p[i2] > p[i1]*1.002;
      const rsiUp = rsiArr[i2] > rsiArr[i1]+1.5;
      const rsiDown = rsiArr[i2] < rsiArr[i1]-1.5;
      if(priceDown && rsiUp){
        a.diverg='bull'; a.divergType='RD+';
        a.divergStrength=clamp((rsiArr[i2]-rsiArr[i1])*0.8 + (1-p[i2]/p[i1])*100*1.2, 1, 12);
      } else if(priceUp && rsiDown){
        a.diverg='hBull'; a.divergType='HD+';
        a.divergStrength=clamp((rsiArr[i1]-rsiArr[i2])*0.6 + (p[i2]/p[i1]-1)*100*0.9, 1, 10);
      }
    }
    // سقف‌ها: RD- و HD-
    if(!a.diverg && H){
      const [i1,i2]=H;
      const priceUp = p[i2] > p[i1]*1.002;
      const priceDown = p[i2] < p[i1]*0.998;
      const rsiDown = rsiArr[i2] < rsiArr[i1]-1.5;
      const rsiUp = rsiArr[i2] > rsiArr[i1]+1.5;
      if(priceUp && rsiDown){
        a.diverg='bear'; a.divergType='RD-';
        a.divergStrength=clamp((rsiArr[i1]-rsiArr[i2])*0.8 + (p[i2]/p[i1]-1)*100*1.2, 1, 12);
      } else if(priceDown && rsiUp){
        a.diverg='hBear'; a.divergType='HD-';
        a.divergStrength=clamp((rsiArr[i2]-rsiArr[i1])*0.6 + (1-p[i2]/p[i1])*100*0.9, 1, 10);
      }
    }
  }

  /* لایه‌ی داده‌ی غنی‌شده: ATR واقعی، حجم و ساختار سایه‌دار.
     در نبود داده، همه‌ی میدان‌ها null می‌مانند و هیچ قاعده‌ای فعال نمی‌شود. */
  const mdx = deriveMarketData(c);
  Object.assign(a, mdx);
  a.mdAt = mdx.mdAt;
  a.mdQuality = (mdx.candles4h && mdx.candles1h) ? 'full' : (mdx.candles4h || mdx.candles1h) ? 'partial' : 'base';

  let sc=50; const S=[]; const add=(v,t)=>{ sc+=v; S.push({t,s:v}); };
  if(a.rsi<30) add(12,`RSI در ناحیه اشباع فروش (${a.rsi.toFixed(0)}) — پتانسیل بازگشت صعودی`);
  else if(a.rsi<45) add(6,`RSI پایین‌تر از میانه (${a.rsi.toFixed(0)}) — فضای رشد وجود دارد`);
  else if(a.rsi>75) add(-13,`RSI در اشباع خرید شدید (${a.rsi.toFixed(0)}) — ریسک اصلاح بالا`);
  else if(a.rsi>65) add(-6,`RSI نزدیک اشباع خرید (${a.rsi.toFixed(0)})`);
  else add(2,`RSI متعادل (${a.rsi.toFixed(0)})`);
  if(a.rsi>a.rsiPrev+2) add(2,'شتاب RSI رو به بالا'); else if(a.rsi<a.rsiPrev-2) add(-2,'شتاب RSI رو به پایین');
  if(a.macd>a.sig) add(7,'MACD بالای خط سیگنال — مومنتوم مثبت'); else add(-7,'MACD زیر خط سیگنال — مومنتوم منفی');
  if(a.hist>a.histPrev) add(4,'هیستوگرام MACD در حال افزایش'); else add(-4,'هیستوگرام MACD در حال کاهش');
  if(a.macdCross==='bull') add(5,'کراس صعودی MACD در ۱۲ ساعت اخیر ✨'); if(a.macdCross==='bear') add(-5,'کراس نزولی MACD در ۱۲ ساعت اخیر');
  // واگرایی‌ها — RD قوی‌تر از HD، هر دو در روند موثر
  if(a.diverg==='bull') add(+Math.round(4+a.divergStrength*0.7), `واگرایی صعودی معمولی (RD+) — قیمت کف پایین‌تر ولی RSI کف بالاتر → بازگشت صعودی قوی 🔀`);
  if(a.diverg==='bear') add(-Math.round(4+a.divergStrength*0.7), `واگرایی نزولی معمولی (RD-) — قیمت سقف بالاتر ولی RSI سقف پایین‌تر → بازگشت نزولی قوی ⚠️`);
  if(a.diverg==='hBull') add(+Math.round(3+a.divergStrength*0.55), `واگرایی صعودی مخفی (HD+) — قیمت کف بالاتر و RSI کف پایین‌تر → تایید ادامه روند صعودی 💪`);
  if(a.diverg==='hBear') add(-Math.round(3+a.divergStrength*0.55), `واگرایی نزولی مخفی (HD-) — قیمت سقف پایین‌تر و RSI سقف بالاتر → تایید ادامه روند نزولی 🔻`);
  if(lastP>a.sma20) add(5,'قیمت بالای SMA20'); else add(-5,'قیمت زیر SMA20');
  if(a.sma50!=null){ if(a.sma20>a.sma50) add(5,'SMA20 بالای SMA50 — ساختار صعودی کوتاه‌مدت'); else add(-5,'SMA20 زیر SMA50 — ساختار نزولی کوتاه‌مدت'); }
  if(a.cross==='golden') add(6,'تقاطع طلایی SMA20/50 در ۲۴ ساعت اخیر 🌟'); if(a.cross==='death') add(-6,'تقاطع مرگ SMA20/50 در ۲۴ ساعت اخیر');
  if(a.bbPos<0.1) add(6,'قیمت چسبیده به باند پایینی بولینگر — احتمال برگشت'); else if(a.bbPos>0.95) add(-6,'قیمت خارج از باند بالایی بولینگر — کشیدگی زیاد');
  if(a.bbWidth<4) add(3,'فشردگی باند بولینگر — احتمال حرکت انفجاری (Squeeze)');
  const m7=clamp(ch7/2.5,-8,8), m24=clamp(ch24/2.5,-6,6), m30=clamp(ch30/8,-6,6);
  add(+m7.toFixed(1)*1,`بازده ۷ روزه: ${pct(ch7)}`); add(+m24.toFixed(1)*1,`بازده ۲۴ ساعته: ${pct(ch24)}`); add(+m30.toFixed(1)*1,`بازده ۳۰ روزه: ${pct(ch30)}`);
  const sl=clamp(a.slopeH*40,-8,8); add(+sl.toFixed(1)*1, a.slopeH>0?'شیب رگرسیون ۴۸ ساعته صعودی':'شیب رگرسیون ۴۸ ساعته نزولی');
  if(a.rangePos>0.97&&ch24>0) add(3,'شکست سقف ۷ روزه — نشانه قدرت خریداران');
  if(a.rangePos<0.05) add(3,'قیمت روی کف ۷ روزه — منطقه حمایتی');
  if(a.volRatio>0.2) add(3,`نسبت حجم به ارزش بازار بالا (${(a.volRatio*100).toFixed(0)}٪) — نقدشوندگی و توجه بالا`);
  else if(a.volRatio<0.02) add(-2,'حجم معاملات نسبت به ارزش بازار پایین');
  /* ---------- سهم لایه‌ی غنی‌شده در امتیاز تکنیکال (فقط با داده‌ی معتبر) ---------- */
  if(a.stDir!=null) add(a.stDir===1?4:-4, a.stDir===1?'Supertrend صعودی — روند تأییدشده با ATR':'Supertrend نزولی — روند تأییدشده با ATR');
  if(a.adx!=null && a.adx>=25) add(a.diPlus>=a.diMinus?2:-2, `ADX قوی (${a.adx.toFixed(0)}) — روند جهت‌دار`);
  if(a.mfi!=null){
    if(a.mfi<20) add(4, `MFI در اشباع فروش پولی (${a.mfi.toFixed(0)})`);
    else if(a.mfi>80) add(-4, `MFI در اشباع خرید پولی (${a.mfi.toFixed(0)})`);
  }
  if(a.cmf!=null){
    if(a.cmf>0.15) add(3, 'جریان پول (CMF) مثبت — فشار خرید واقعی');
    else if(a.cmf<-0.15) add(-3, 'جریان پول (CMF) منفی — فشار فروش واقعی');
  }
  if(a.brk24 && a.brk24.state==='up'){
    if(a.volZ==null) add(1,'شکست سقف ۲۴ ساعته (بدون داده‌ی حجم برای تأیید)');
    else add(a.volZ>=1 ? 5 : -3, a.volZ>=1 ? 'شکست سقف ۲۴ ساعته با تأیید حجم' : 'شکست سقف بدون تأیید حجم — ریسک شکست جعلی');
  }
  if(a.brk24 && a.brk24.state==='down'){
    if(a.volZ==null) add(-1,'شکست کف ۲۴ ساعته (بدون داده‌ی حجم)');
    else add(a.volZ>=1 ? -4 : -1, a.volZ>=1 ? 'شکست کف ۲۴ ساعته با حجم بالا' : 'شکست کف بدون تأیید حجم');
  }
  if(a.volZ!=null && a.ch24>6 && a.volZ<-0.5) add(-3,'رشد ۲۴ ساعته با حجمی کمتر از میانگین — ضعف تقاضا');
  if(a.obvSlope!=null && a.ch7>3 && a.obvSlope<0) add(-3,'واگرایی قیمت/حجم: قیمت رشد کرده ولی OBV نزولی است');
  a.score=Math.round(clamp(sc,0,100)); a.signals=S;

  // مستعد رشد: بازگشت (RD+) یا ادامه روند (HD+) یا سایر سیگنال‌های برگشتی
  const volBreakout = !!(a.brk24 && a.brk24.state==='up' && a.volZ!=null && a.volZ>=1);
  const reversal=(a.rsi<42&&a.hist>a.histPrev)||(a.bbPos<0.15&&a.macdCross==='bull')||(a.bbWidth<4&&a.score>=48)||((a.diverg==='bull'||a.diverg==='hBull')&&a.divergStrength>=3)||volBreakout;
  if(a.score>=74) a.cat='sbuy';
  else if(a.score>=62) a.cat='buy';
  else if(reversal||(a.score>=53&&a.slopeH>0)) a.cat='pot';
  else if(a.score>=42) a.cat='hold';
  else if(a.score>=30) a.cat='sell';
  else a.cat='ssell';

  const trendComp = clamp(a.slopeH*168*0.35, -25, 25);
  const momComp   = clamp(ch7*0.2 + ch24*0.15, -10, 10);
  const mrComp    = (50-a.rsi)*0.12;
  const macdComp  = clamp((a.hist/lastP)*100*40, -4, 4);
  const scoreComp = (a.score-50)*0.12;
  let pred = trendComp+momComp+mrComp+macdComp+scoreComp;
  const band=a.dvol*Math.sqrt(7);
  pred=clamp(pred,-band*1.5,band*1.5);
  a.pred=pred; a.predLo=pred-band*0.9; a.predHi=pred+band*0.9;
  const pos=S.filter(x=>x.s>0).length, neg=S.filter(x=>x.s<0).length; const agree=Math.abs(pos-neg)/(pos+neg||1);
  a.conf=Math.round(clamp(35+agree*45-Math.min(a.dvol,10)*1.5+Math.min(a.volRatio*50,8),15,92));
  a.trend = pred>6?'صعودی قوی':pred>2?'صعودی':pred>-2?'خنثی / رِنج':pred>-6?'نزولی':'نزولی قوی';
  a.risk = a.dvol<3?'کم':a.dvol<6?'متوسط':a.dvol<10?'زیاد':'بسیار زیاد';
  a.support = Math.max(a.low7, a.bbLo); a.resist=Math.min(a.high7, a.bbUp);
  if(a.support>lastP) a.support=a.low7; if(a.resist<lastP) a.resist=a.high7;

  buyPlan(a, c, lastP, p);
  return a;
}

/* =====================================================================
   موتور «بهترین قیمت خرید» + منطق R/R — نسخه بازبینی‌شده و سازگار
   =====================================================================
   منطق RR به صورت زیر تضمین می‌شود:
   - stop < avgEntry <= mkt (همیشه زیر قیمت بازار)
   - tp1 > mkt و tp1 > avgEntry و tp2 > tp1
   - risk = avgEntry - stop >0
   - reward = tp1 - avgEntry >0
   - rr = reward/risk  (RR از نقطه ورود پلکانی)
   - riskNow = mkt - stop >0
   - rewardNow = tp1 - mkt >0
   - rrNow = rewardNow/riskNow (RR اگر همین حالا با قیمت بازار بخری)
   - rrNow <= rr  (چون avgEntry <= mkt)
   - هر دو در [0,10] کران‌دار و NaN-safe
   - wideStop اگر حمایت دور باشد، stop روی 15% ریسک محدود می‌شود
   ===================================================================== */
function buyPlan(a, c, lastP, p){
  const mkt = (c.current_price && isFinite(c.current_price) && c.current_price>0) ? c.current_price : lastP;
  const anchors=[];
  const push=(v,w,label)=>{ if(v!=null && isFinite(v) && v>0) anchors.push({v,w,label}); };

  push(a.support, 2.2, 'حمایت ۷ روزه');
  push(a.bbLo,    1.8, 'باند پایین بولینگر');
  push(a.sma20,   1.5, 'SMA20');
  push(a.ema20,   1.0, 'EMA20');
  if(a.sma50!=null && a.sma50<mkt) push(a.sma50, 1.0, 'SMA50');

  /* لنگر ساختاری تازه: نزدیک‌ترین کف پیوت «تأییدشده» با سایه‌ی واقعی (۴ساعته) */
  if(a.swingLow!=null && a.swingLow<mkt) push(a.swingLow, 1.7, 'کف پیوت تأییدشده (۴ساعته)');
  if(a.brk24 && a.brk24.low!=null && a.brk24.low<mkt) push(a.brk24.low, 1.0, 'کف دامنه ۲۴ ساعته');

  let vw=0, ww=0; p.forEach((x,i)=>{ const w=1+i/p.length; vw+=x*w; ww+=w; });
  if(a.vwapVol!=null && a.vwapVol>0){
    a.vwap = a.vwapVol;                       // VWAP حجم‌وزن واقعی، جایگزین تقریب زمانی
    a.vwapKind = 'volume';
    push(a.vwap, 1.6, 'VWAP حجمی ۷ روزه');
  } else {
    a.vwap = ww? vw/ww : mkt;
    a.vwapKind = 'time';
    push(a.vwap, 1.4, 'میانگین وزنی ۷ روزه');
  }

  const rng=a.high7-a.low7;
  a.fib382 = a.high7 - rng*0.382;
  a.fib5   = a.high7 - rng*0.5;
  a.fib618 = a.high7 - rng*0.618;
  push(a.fib382, 0.9, 'فیبو ۳۸.۲٪');
  push(a.fib5,   1.2, 'فیبو ۵۰٪');
  push(a.fib618, 1.1, 'فیبو ۶۱.۸٪');

  const piv=[]; for(let i=3;i<p.length-3;i++){ if(p[i]<=p[i-1]&&p[i]<=p[i-2]&&p[i]<=p[i-3]&&p[i]<=p[i+1]&&p[i]<=p[i+2]&&p[i]<=p[i+3]) piv.push(p[i]); }
  const pivBelow=piv.filter(v=>v<mkt).sort((x,y)=>y-x);
  if(pivBelow.length){ push(pivBelow[0], 1.6, 'نزدیک‌ترین کف پیوت'); a.pivot=pivBelow[0]; }

  let bias = 0;
  if(a.score>=74) bias += 0.45;
  else if(a.score>=62) bias += 0.30;
  else if(a.score<42) bias -= 0.35;
  if(a.rsi>70) bias -= 0.35; else if(a.rsi<32) bias += 0.30;
  if(a.macdCross==='bull') bias += 0.15;
  if(a.diverg==='bull')    bias += 0.20;  // RD+ بازگشت
  if(a.diverg==='bear')    bias -= 0.25; // RD- بازگشت
  if(a.diverg==='hBull')   bias += 0.15; // HD+ ادامه صعود، ورود نزدیک‌تر
  if(a.diverg==='hBear')   bias -= 0.18; // HD- ادامه نزول، صبر بیشتر
  if(a.cross==='golden')   bias += 0.15;
  if(a.rangePos>0.9)       bias -= 0.25;
  if(a.bbWidth<4)          bias += 0.10;

  let base = anchors.length? anchors.reduce((s2,x)=>s2+x.v*x.w,0)/anchors.reduce((s2,x)=>s2+x.w,0) : mkt*0.97;
  const k = clamp(0.5 + bias*0.5, 0.05, 0.95);
  let entry = base + (mkt-base)*clamp(k,0,1);

  const halfBandPct = clamp(a.dvol*0.45, 0.4, 4.5)/100;
  // بهترین قیمت خرید هرگز بالاتر از قیمت بازار نیست؛ اگر لنگرها بالای بازارند، نیم‌باند تخفیف
  entry = Math.min(entry, base>mkt ? mkt*(1-halfBandPct*0.5) : mkt);
  // کف منطقی: بیش از 3 برابر نوسان روزانه پایین‌تر نرو
  entry = Math.max(entry, mkt*(1-clamp(a.dvol,1,12)*3/100));
  entry = clamp(entry, mkt*0.70, mkt); // ایمنی نهایی

  a.entry   = entry;
  a.entryLo = entry*(1-halfBandPct);
  a.entryHi = Math.min(entry*(1+halfBandPct), mkt*1.004);
  if(a.entryHi<a.entry) a.entryHi=a.entry;
  a.entryGap= (entry/mkt-1)*100;
  a.anchors = anchors.sort((x,y)=>y.w-x.w).slice(0,5);

  // پلکان سه‌مرحله‌ای DCA — همیشه نزولی و زیر قیمت بازار
  let L1=Math.min(a.entryHi, mkt), L2=entry, L3=Math.min(a.entryLo, a.support*1.002);
  L2=Math.min(L2,L1); L3=Math.min(L3,L2);
  // ایمنی: هر پله حداقل 0.2% پایین‌تر از قبلی
  if(L1>0 && L2>=L1) L2=L1*0.998;
  if(L2>0 && L3>=L2) L3=L2*0.998;
  a.ladder=[{p:L1,w:40,t:'پله ۱'},{p:L2,w:35,t:'پله ۲'},{p:L3,w:25,t:'پله ۳'}];
  a.avgEntry = a.ladder.reduce((s2,x)=>s2+x.p*x.w,0)/100;
  a.avgEntry = clamp(a.avgEntry, L3, mkt); // میانگین بین کمترین پله و بازار

  // سطوح حد ضرر و اهداف: اگر ATR واقعی موجود باشد، مبنای فاصله‌ها همان است؛
  // وگرنه تقریب قبلی (نوسان لگاریتمی) دست‌نخورده می‌ماند. کف/سقف ۰.۸–۹٪ حفظ
  // می‌شود تا حتی با ATR غیرعادی، هندسه‌ی پلن از محدوده‌ی معقول بیرون نزند.
  const atrLike = clamp(a.atr!=null ? a.atr : a.dvol, 0.8, 9)/100;
  a.atrLike = atrLike*100;
  let stop = Math.min(a.support*0.985, a.avgEntry*(1-atrLike*1.6));
  let tp1  = Math.max(Math.min(a.resist, a.avgEntry*(1+atrLike*3)), a.avgEntry*(1+atrLike*1.8));
  let tp2  = Math.max(tp1*1.02, Math.min(a.high7*1.01, a.avgEntry*(1+atrLike*4.5)), a.avgEntry*(1+atrLike*3.2));
  // تضمین tpها بالای قیمت بازار
  tp1  = Math.max(tp1, mkt*(1+atrLike*1.2), a.avgEntry*1.01);
  tp2  = Math.max(tp2, tp1*1.03, mkt*1.02);
  // تضمین stop زیر میانگین و زیر بازار
  stop = Math.min(stop, a.avgEntry*0.999, mkt*0.999);
  stop = Math.max(stop, a.avgEntry*0.70); // بیش از 30% پایین‌تر نرو

  /* پالایش حد ضرر با ATR واقعی:
     ۱) حد ضررِ دورتر از ۲.۲×ATR ریسک بی‌دلیل است و جمع می‌شود.
     ۲) حد ضررِ نزدیک‌تر از ۰.۹×ATR داخل نویز معمول بازار است و عقب برده
        می‌شود — مادامی که از سقف ریسک ۱۵٪ عبور نکند. */
  if(a.atr!=null && a.atr>0){
    const atrAbs = mkt*a.atr/100;
    const wide = a.avgEntry - atrAbs*2.2, tight = a.avgEntry - atrAbs*0.9;
    if(stop < wide) stop = wide;
    if(tight>0 && stop > tight && (a.avgEntry-tight)/a.avgEntry <= 0.15) stop = tight;
    a.atrStopMult = atrAbs > 0 ? (a.avgEntry-stop)/atrAbs : null;
  } else a.atrStopMult = null;
  if(!(stop < a.avgEntry) || !(stop > 0)) stop = a.avgEntry*0.98;

  a.wideStop=false;
  if((a.avgEntry-stop)/a.avgEntry>0.15){ stop=a.avgEntry*0.85; a.wideStop=true; }

  // بازبینی نهایی پس از wideStop
  if(stop>=a.avgEntry) stop=a.avgEntry*0.95;
  if(tp1<=a.avgEntry) tp1=a.avgEntry*1.05;
  if(tp2<=tp1) tp2=tp1*1.04;

  a.stop=stop; a.tp1=tp1; a.tp2=tp2;

  // محاسبه R/R — کاملاً NaN-safe و با کران
  const risk = a.avgEntry - a.stop;
  const reward = a.tp1 - a.avgEntry;
  const reward2 = a.tp2 - a.avgEntry;
  a.rr = (risk>0 && reward>0 && isFinite(risk) && isFinite(reward)) ? clamp(reward/risk,0,10) : 0;
  a.rr2 = (risk>0 && reward2>0 && isFinite(reward2)) ? clamp(reward2/risk,0,10) : 0;

  const riskNow = mkt - a.stop;
  const rewardNow = a.tp1 - mkt;
  const rewardNow2 = a.tp2 - mkt;
  a.rrNow = (riskNow>0 && rewardNow>0 && isFinite(riskNow) && isFinite(rewardNow)) ? clamp(rewardNow/riskNow,0,10) : 0;
  a.rrNow2 = (riskNow>0 && rewardNow2>0) ? clamp(rewardNow2/riskNow,0,10) : 0;

  // درصد ریسک از قیمت فعلی تا حد ضرر
  a.riskPct = (mkt>0 && isFinite(a.stop)) ? (1-a.stop/mkt)*100 : 7;
  a.riskPct = clamp(a.riskPct, 0.1, 50);

  // وضعیت لحظه‌ای نسبت به محدوده خرید — پیام‌ها با منطق RR هماهنگ
  if(mkt<=a.entryLo)        { a.buyState='below'; a.buyStateTxt='زیر محدوده — تخفیف بیشتر از انتظار (R/R بهتر)'; }
  else if(mkt<=a.entryHi)   { a.buyState='now';   a.buyStateTxt='هم‌اکنون در محدوده خرید — R/R بهینه'; }
  else if(a.entryGap>-6)    { a.buyState='wait';  a.buyStateTxt='کمی صبر تا اصلاح به محدوده — R/R فعلی ضعیف'; }
  else                      { a.buyState='no';    a.buyStateTxt='فاصله زیاد تا ورود — صبر کنید، تعقیب قیمت ممنوع'; }

  // امتیاز فرصت خرید
  let b=0;
  b += clamp(a.score-50,-30,30)*0.42;
  b += clamp(a.pred,-12,12)*0.62;
  b += clamp(a.rr-1,-1,3)*3.2; // RR ایده‌آل از میانگین پلکانی
  b += clamp(-a.entryGap,0,6)*1.1;
  b += clamp(a.conf-50,-25,35)*0.11;
  b += clamp(Math.log10(Math.max(1,(c.market_cap||1))/1e8),-2,2.5)*1.6;
  b -= clamp(a.dvol-4,0,12)*1.15;
  b -= clamp(a.rsi-68,0,32)*0.28;
  if(a.buyState==='now')   b+=5;
  if(a.buyState==='below') b+=2;
  if(a.buyState==='no')    b-=7;
  if(a.volRatio<0.008)     b-=6;
  if(a.diverg==='bull')    b+=clamp(a.divergStrength,0,12)*0.55; // RD+
  if(a.diverg==='bear')    b-=clamp(a.divergStrength,0,12)*0.65; // RD-
  if(a.diverg==='hBull')   b+=clamp(a.divergStrength,0,10)*0.40; // HD+ ادامه صعود
  if(a.diverg==='hBear')   b-=clamp(a.divergStrength,0,10)*0.50; // HD- ادامه نزول
  if(a.cat==='sell')       b-=5;
  if(a.cat==='ssell')      b-=12;
  if(a.wideStop)           b-=3;
  if(a.athDist!=null && a.athDist<-92) b-=4;
  // جریمه RR ضعیف با قیمت فعلی — هماهنگی با دروازه
  if(a.rrNow<1) b-= (1-a.rrNow)*2;
  a.buyRaw=b;
  a.buyScore=Math.round(clamp(50+b,0,100));
  setGrade(a);
}
function setGrade(a){
  a.grade = a.buyScore>=82?'A+' : a.buyScore>=74?'A' : a.buyScore>=66?'B+' : a.buyScore>=58?'B' : a.buyScore>=50?'C' : a.buyScore>=40?'D':'E';
  a.gradeC= a.buyScore>=74?'#00e676' : a.buyScore>=58?'#4ade80' : a.buyScore>=50?'#fbbf24' : a.buyScore>=40?'#fb7185':'#ef4444';
}

function applyMarketContext(){
  const cs=state.coins.filter(tradable).filter(c=>c.a.ok);
  const btc=state.coins.find(c=>c.id==='bitcoin' && c.a.ok);
  const bull=cs.filter(c=>c.a.cat==='sbuy'||c.a.cat==='buy').length, breadth=cs.length? bull/cs.length : 0.5;
  const above=cs.filter(c=>c.current_price>c.a.sma20).length/(cs.length||1);
  /* گستردگی «عینی» مستقل از طبقه‌بندی خودمان: سهم ارزهای مثبت در ۲۴ ساعت.
     گستردگی قبلی (سهم برچسب‌های خرید) از همان امتیازی ساخته می‌شود که دروازه
     فیلترش می‌کند؛ این معیار آن هم‌خطی را می‌شکند. */
  const chs=cs.map(c=>c.a.ch24).filter(v=>Number.isFinite(v)).sort((x,y)=>x-y);
  const objBreadth=cs.length? cs.filter(c=>c.a.ch24>0).length/cs.length : 0.5;
  const medianCh24=chs.length? chs[Math.floor(chs.length/2)] : 0;
  const gt=state.globalTrend||null;
  let pts=0, why=[];
  if(btc){
    const b=btc.a, px=btc.current_price;
    if(px>b.sma50 && b.sma20>b.sma50){ pts+=2; why.push('BTC بالای SMA50 با ساختار صعودی'); }
    else if(px<b.sma50 && b.sma20<b.sma50){ pts-=2; why.push('BTC زیر SMA50 با ساختار نزولی'); }
    if(b.slope7>0.05){ pts+=1; why.push('شیب هفتگی BTC مثبت'); } else if(b.slope7<-0.05){ pts-=1; why.push('شیب هفتگی BTC منفی'); }
    if(b.rsi>72){ pts-=1; why.push('RSI بیت‌کوین در اشباع خرید'); } else if(b.rsi<35){ pts+=1; why.push('RSI بیت‌کوین در اشباع فروش (فرصت انباشت)'); }
    if(b.macd>b.sig){ pts+=1; } else { pts-=1; }
  }
  if(breadth>0.55){ pts+=1; why.push(`گستردگی مثبت (${Math.round(breadth*100)}٪ سیگنال خرید/قوی)`); }
  else if(breadth<0.3){ pts-=1; why.push(`گستردگی ضعیف (${Math.round(breadth*100)}٪ سیگنال مثبت)`); }
  if(above>0.6) pts+=1; else if(above<0.3) pts-=1;
  if(cs.length){
    if(objBreadth>0.6 && medianCh24>0){ pts+=1; why.push(`گستردگی عینی: ${Math.round(objBreadth*100)}٪ ارزها در ۲۴ ساعت مثبت (میانه ${pct(medianCh24,1)})`); }
    else if(objBreadth<0.35 && medianCh24<0){ pts-=1; why.push(`گستردگی عینی ضعیف: فقط ${Math.round(objBreadth*100)}٪ ارزها در ۲۴ ساعت مثبت (میانه ${pct(medianCh24,1)})`); }
  }
  /* روند سلطه/ارزش کل بازار از تاریخچه‌ی محلی — ورودی مستقل و بدون فراخوان تازه */
  if(gt){
    const d=gt.domChangePp, m=gt.mcapChangePct;
    if(d!=null && m!=null){
      if(d>=0.5 && m<=-1){ pts-=1; why.push(`سلطه‌ی بیت‌کوین ${pct(d,2)} واحد در ${Math.round(gt.spanHours)} ساعت با ارزش کل ${pct(m,1)} — خروج پول از آلت‌ها`); }
      else if(d<=-0.5 && m>=1){ pts+=1; why.push(`سلطه‌ی بیت‌کوین رو به کاهش (${pct(d,2)} واحد) با رشد ارزش کل — چرخش به نفع آلت‌ها`); }
    }
  }
  const fng=fngValue();
  const k = pts>=3?'riskon' : pts<=-3?'riskoff' : 'neutral';
  state.regime={...REGIMES[k], btcAvailable:!!btc&&shortCoinFresh(btc), pts, why, breadth, above,
    objBreadth, medianCh24, gt, fng, btc7:btc?btc.a.ch7:0, btc24:btc?btc.a.ch24:0};

  state.gate=evalMarketGate(state.regime);

  const adj=state.regime.adj;
  state.coins.forEach(c=>{
    const a=c.a; if(!a.ok) return;
    a.rs7 = btc? a.ch7 - btc.a.ch7 : 0;
    a.rs24= btc? a.ch24- btc.a.ch24 : 0;
    a.beta= (btc && Math.abs(btc.a.ch7)>0.5)? clamp(a.ch7/btc.a.ch7, -3, 4) : null;
    /* ---------- لایه‌ی مشتقات (فاز ۲): ازدحام پوزیشن و سوخت اسکوییز ---------- */
    const sym=String(c.symbol||'').toUpperCase();
    const dr=state.deriv ? state.deriv[sym] : null;
    a.fundingAnnual = dr && dr.fundingAnnual!=null ? dr.fundingAnnual : null;
    a.fundingPct    = dr && dr.fundingPct!=null ? dr.fundingPct : null;
    a.oiUsd         = dr && dr.oiUsd ? dr.oiUsd : null;
    a.derivVenues   = dr ? dr.venues : 0;
    a.oiChangePct   = (dr && typeof MarketData!=='undefined') ? MarketData.oiChangePct(sym) : null;
    a.crowd         = (dr && typeof MarketData!=='undefined') ? MarketData.classifyCrowding(dr, a.rsi, a.oiChangePct, CROWD) : null;
    if(a.crowd && !a.crowd.side) a.crowd = null;
    a.derivAt = dr ? state.derivAt : null;
    let b=a.buyRaw;
    if(c.id!=='bitcoin'){
      b += adj;
      b += clamp(a.rs7,-12,12)*0.35;
      if(state.regime.k==='riskoff' && a.rs7>3) b+=3;
    }
    /* امتیاز ازدحام: خرید در اوج اهرم جریمه، و شورت‌های ازدحام‌شده (فاندینگ عمیقاً
       منفی) در حالی که قیمت بالای SMA20 است، به‌عنوان سوخت اسکوییز پاداش می‌گیرند. */
    if(a.crowd){
      if(a.crowd.side==='long') b -= a.crowd.level==='hot' ? 7 : 3;
      else if(a.crowd.side==='short' && c.current_price>a.sma20 && a.rs7>=0) b += a.crowd.level==='hot' ? 3 : 1.5;
    }
    /* رشد OI همراه با رشد قیمت = ورود پول تازه؛ رشد قیمت با OI نزولی = بستن پوزیشن */
    if(a.oiChangePct!=null){
      if(a.oiChangePct>=CROWD.oiRisingPct && a.ch24>3) b+=1.5;
      else if(a.oiChangePct<=-CROWD.oiRisingPct && a.ch24>3) b-=1;
    }
    a.buyScore=Math.round(clamp(50+b,0,100)); setGrade(a);
    a.gate=evalCoinGate(c, state.gate);
    a.ctx=[];
    if(c.id!=='bitcoin'){
      a.ctx.push({t:`قدرت نسبی ۷ روزه در برابر بیت‌کوین: ${pct(a.rs7,1)}${a.rs7>3?' — پیشروی آلت 💪':a.rs7<-3?' — ضعیف‌تر از بازار':''}`, s:Math.round(clamp(a.rs7,-12,12)*0.35)});
      a.ctx.push({t:`رژیم بازار: ${state.regime.label}`, s:adj});
    }
    if(a.gate && !a.gate.exempt){
      a.ctx.push({t:`دروازه‌ی رژیم: ${GATE_STATES[a.gate.state].label}`, s:a.gate.state==='open'?0:a.gate.state==='watch'?-2:-5});
    }
    if(a.fundingAnnual!=null){
      const oiTxt = a.oiChangePct!=null ? ` • تغییر OI: ${pct(a.oiChangePct,1)}` : '';
      a.ctx.push({t:`فاندینگ سالانه‌ی فیوچرز (میانه‌ی ${a.derivVenues} بازار): ${pct(a.fundingAnnual,1)}${oiTxt}`,
        s: a.crowd ? (a.crowd.side==='long'? -4 : 2) : 0});
    }
    if(a.crowd) a.ctx.push({t:a.crowd.reason, s:a.crowd.side==='long'?-4:2});
    if(a.mdQuality!=='base' && a.atr!=null){
      a.ctx.push({t:`داده‌ی غنی‌شده: ATR(14) چهارساعته ${a.atr.toFixed(2)}٪${a.volZ!=null?` • حجم نسبی ${a.volZ>=0?'+':''}${a.volZ.toFixed(1)}σ`:''}`, s:0});
    }
  });
  state.gate.stats=gateStats();
}

/* Short research workspace: isolated storage keeps legacy long history intact. */
const shorts={records:[], enabled:false, filter:'all'};
try{
  const saved=JSON.parse(localStorage.getItem('cb_short_v1')||'{}')||{};
  shorts.enabled=saved.enabled===true;
  shorts.records=ShortEngine.restoreRecords(saved.records);
}catch(e){}
function saveShorts(){try{localStorage.setItem('cb_short_v1',JSON.stringify({enabled:shorts.enabled,records:ShortEngine.keepRecords(shorts.records)}));}catch(e){}}
function shortFresh(){const age=Date.now()-state.dataAt;return state.liveData===true&&Number.isFinite(age)&&age>=0&&age<CACHE_FRESH_MS;}
function shortCoinFresh(c){const t=Date.parse(c.last_updated);return Number.isFinite(t)&&Date.now()-t<CACHE_FRESH_MS&&t<=Date.now()+60000;}
function longCandidate(c){
  const a=c.a;
  return shortFresh()&&shortCoinFresh(c)&&a?.ok&&tradable(c)&&
    (a.cat==='sbuy'||a.buyScore>=78)&&gatePermit(c,'open')&&
    a.tp1>c.current_price*1.004&&a.stop<c.current_price*0.996;
}
function shortConflict(c){return perf.rec.some(r=>r.id===c.id&&r.open)||longCandidate(c);}
function shortBenchmarkFresh(){const btc=state.coins.find(c=>c.id==='bitcoin');return !!btc&&btc.a?.ok&&shortCoinFresh(btc)&&state.regime?.btcAvailable===true;}
function shortOptions(c,levels){return {fresh:shortFresh()&&shortCoinFresh(c),mode:gate.mode,conflict:shortConflict(c),benchmarkFresh:shortBenchmarkFresh(),levels};}
function updateShortPlans(){
  state.coins.forEach(c=>{
    c.a.plans={long:{side:'long',entry:c.a.entry,stop:c.a.stop,tp1:c.a.tp1,tp2:c.a.tp2,score:c.a.buyScore,gate:c.a.gate},
      short:ShortEngine.plan(c,state.regime,shortOptions(c))};
  });
}
function shortAlert(c,text){
  // Direction is explicit; alerts use existing sound/notification preferences.
  pushAlert(c,'short',`شورت آزمایشی — ${text}`,'#fb7185',true);
  try{localStorage.setItem(LS_KEYS.alerts,JSON.stringify(mon.alerts.slice(0,60)));}catch(e){}
  renderAlerts();
}
function shortCycle(){
  updateShortPlans();
  if(!shortFresh()){renderShorts();return;}
  const now=Date.now();
  shorts.records.forEach(r=>{
    const c=state.coins.find(c=>c.id===r.id);if(!c||!shortCoinFresh(c))return;
    const px=c.current_price, p=r.status==='waiting'?ShortEngine.plan(c,state.regime,shortOptions(c,r)):c.a.plans.short;
    const event=ShortEngine.advance(r,px,now);
    if(event) shortAlert(c,event==='cancelled'?'ستاپ منتظر منقضی/باطل شد':`${event==='win'?'هدف اول':event==='loss'?'حد ضرر':'سررسید'} • بازده ناخالص ${pct(r.ret)}`);
    if(r.status==='waiting'){
      if(!shorts.enabled||p.state==='blocked'||shortConflict(c)){
        r.status='cancelled';r.closed=now;shortAlert(c,'ستاپ منتظر به دلیل تغییر شرایط باطل شد');
      }else if(px>=r.entryLo&&px<=r.entryHi&&px<r.stop&&px>r.tp1&&(px-r.tp1)/(r.stop-px)>=p.gate.need.rr){
        Object.assign(r,{status:'active',fill:px,opened:now,last:px,peak:px,trough:px});
        shortAlert(c,`ورود مشاهده‌شده ${fmtP(px)} • حد ضرر ${fmtP(r.stop)} • هدف ${fmtP(r.tp1)}`);
      }
    }
  });
  if(shorts.enabled) state.coins.forEach(c=>{
    const p=c.a.plans.short;
    if(!p.valid||p.state==='blocked'||shortConflict(c))return;
    // One live setup per asset, and a 24h cooldown after closing/cancelling.
    if(shorts.records.some(r=>r.id===c.id&&(['active','waiting'].includes(r.status)||now-(r.closed||r.created)<86400000)))return;
    const r={...p,gate:undefined,id:c.id,sym:c.symbol,created:now,status:p.state==='ready'?'active':'waiting'};
    if(r.status==='active')Object.assign(r,{fill:c.current_price,opened:now,last:c.current_price,peak:c.current_price,trough:c.current_price});
    shorts.records.push(r);
    shortAlert(c,r.status==='active'?`ورود مشاهده‌شده ${fmtP(r.fill)} • حد ضرر ${fmtP(r.stop)}`:`انتظار پولبک به ${fmtP(p.entry)} — هنوز معامله فعال نیست`);
  });
  // Never evict live trades to make room for closed history.
  shorts.records=ShortEngine.keepRecords(shorts.records);
  saveShorts();renderShorts();
}
const SHORT_STATUS={blocked:'بدون ورود',waiting:'منتظر پولبک',ready:'آماده ورود',active:'فعال آزمایشی',win:'هدف اول',loss:'حد ضرر',expired:'سررسید',cancelled:'باطل‌شده'};
function shortDetails(c){
  const p=c.a.plans?.short;
  if(!p)return '<p>پس از دریافت داده محاسبه می‌شود.</p>';
  const shown=p.state==='ready'?{...p,entry:c.current_price}:p;
  const pos=ShortEngine.position(shown,riskCfg());
  return `<b>🔻 شورت • ${esc(SHORT_STATUS[p.state])} • امتیاز ${p.score}/100</b>
    <p>${p.gate.reasons.map(esc).join(' • ')}</p>
    ${p.valid?`<p>محدوده ورود: ${fmtP(p.entryLo)} تا ${fmtP(p.entryHi)} • مبنا: ${fmtP(p.entry)} | حد ضرر: ${fmtP(p.stop)} | اهداف: ${fmtP(p.tp1)} / ${fmtP(p.tp2)}</p>
    <p>R/R ورود: ${p.rr.toFixed(2)} | فعلی: ${p.rrNow.toFixed(2)}</p>
    ${p.fundingAnnual!=null?`<p>فاندینگ سالانه‌ی فیوچرز: <b>${pct(p.fundingAnnual,1)}</b>${p.oiChangePct!=null?` • تغییر OI: ${pct(p.oiChangePct,1)}`:''} ${p.crowd&&p.crowd.side==='short'?'<b class="down">— ازدحام سمت شورت (ریسک اسکوییز)</b>':p.fundingAnnual>=40?'<b class="up">— ازدحام سمت لانگ (به نفع شورت)</b>':''}</p>`:''}
    ${pos?`<p>حجم بر مبنای ${p.state==='ready'?'قیمت فعلی':'ورود پیشنهادی'} و تنظیمات سرمایه: ${fmtN(pos.units,4)} واحد • ارزش اسمی: ${fmtP(pos.notional)} • زیان حد ضرر: ${fmtP(pos.loss)} • سود هدف اول: ${fmtP(pos.gain)}</p>`:''}`:''}`;
}
function shortFreshKey(){return [shortFresh(),...state.coins.map(c=>shortCoinFresh(c))].join('|');}
function renderShorts(){
  state.shortFreshDisplayed=shortFreshKey();
  const box=$('#shortPanel');if(!box)return;
  const plans=state.coins.filter(c=>tradable(c)&&c.a.plans?.short).sort((x,y)=>{
    const rank={ready:0,waiting:1,blocked:2};return rank[x.a.plans.short.state]-rank[y.a.plans.short.state]||y.a.plans.short.score-x.a.plans.short.score;
  }).filter(c=>shorts.filter!=='approved'||c.a.plans.short.state!=='blocked').slice(0,25);
  $('#shortEnabled').checked=shorts.enabled;
  $('#shortFresh').textContent=shortFresh()?'داده تازه؛ نتایج تحلیلی، بدون اجرای سفارش':'آفلاین / داده کهنه؛ ورود و ارزیابی کارنامه متوقف است';
  box.innerHTML=plans.length?plans.map(c=>`<article class="short-card"><h3>${esc(c.name)} <small>${esc(c.symbol.toUpperCase())}</small></h3>${shortDetails(c)}<button data-short-open="${esc(c.id)}">نمودار و جزئیات</button></article>`).join(''):'<p>فرصتی مطابق این فیلتر وجود ندارد؛ عدم معامله یک خروجی معتبر است.</p>';
  const done=shorts.records.filter(r=>['win','loss','expired'].includes(r.status));
  const avg=done.length?done.reduce((s,r)=>s+r.ret,0)/done.length:0;
  $('#shortStats').textContent=`کارنامه مستقل شورت • ${done.length} بسته • میانگین ناخالص ${pct(avg)} • ${shorts.records.filter(r=>r.status==='active').length} فعال • ${shorts.records.filter(r=>r.status==='waiting').length} منتظر`;
  $('#shortHistory').innerHTML=[...shorts.records].sort((a,b)=>(b.closed||b.opened||b.created)-(a.closed||a.opened||a.created)).slice(0,30).map(r=>`<tr><td>${esc(r.sym.toUpperCase())} • شورت</td><td>${esc(SHORT_STATUS[r.status])}</td><td>${fmtP(r.fill||r.entry)}</td><td>${fmtP(r.stop)}</td><td>${fmtP(r.tp1)}</td><td>${r.ret==null?'—':pct(r.ret)}</td></tr>`).join('');
}
function exportShortCSV(){
  updateShortPlans();
  const rows=[['side','version','symbol','state','score','entry','stop','tp1','tp2','rr','rrNow','reasons']];
  state.coins.filter(tradable).forEach(c=>{const p=c.a.plans?.short;if(p)rows.push(['short',p.version,c.symbol,p.state,p.score,p.entry,p.stop,p.tp1,p.tp2,p.rr,p.rrNow,p.gate.reasons.join(' | ')]);});
  // Neutralize spreadsheet formula injection in untrusted asset names/symbols.
  const cell=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';
  const blob=new Blob(['\uFEFF'+rows.map(r=>r.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='cryptobin_short_plans.csv';document.body.appendChild(link);link.click();document.body.removeChild(link);setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function initShortUI(){
  $('#shortEnabled').onchange=e=>{shorts.enabled=e.target.checked;saveShorts();shortCycle();};
  $('#shortFilter').onchange=e=>{shorts.filter=e.target.value;renderShorts();};
  $('#shortCSV').onclick=exportShortCSV;
  $('#shortPanel').onclick=e=>{const b=e.target.closest('[data-short-open]');if(b)openModal(b.dataset.shortOpen);};
}

/* =====================================================================
   تب‌های جهت معامله (لانگ / شورت / دوطرفه)
   مهم: تب فقط لایه‌ی نمایش است. چرخه‌ی پایش، کارنامه و ارزیابی معاملات
   مستقل از تب فعال اجرا می‌شوند تا معامله‌های تب پنهان بی‌صدا متوقف نشوند.
   ===================================================================== */
const SIDES=['long','short','both'];
const sideView={ cur:'long' };
try{
  const h=(location.hash||'').replace('#','');
  const saved=localStorage.getItem(LS_KEYS.side);
  if(SIDES.includes(h)) sideView.cur=h; else if(SIDES.includes(saved)) sideView.cur=saved;
}catch(e){}

function setSide(side,persist=true){
  if(!SIDES.includes(side)) side='long';
  sideView.cur=side;
  const main=document.querySelector('main'); if(main) main.setAttribute('data-side',side);
  document.querySelectorAll('.side-tab').forEach(b=>{
    const on=b.dataset.side===side;
    b.classList.toggle('active',on);
    b.setAttribute('aria-selected',on?'true':'false');
    b.tabIndex=on?0:-1;
  });
  if(persist){ try{ localStorage.setItem(LS_KEYS.side,side); }catch(e){} }
  renderSideTabs();
  if(side!=='long') renderDual();
}

/* شمارنده‌ی روی تب‌ها — تعداد فرصت‌های واقعیِ هر جهت */
function sideCounts(){
  const cs=state.coins.filter(c=>c.a&&c.a.ok&&tradable(c));
  const long=cs.filter(c=>gatePermit(c,'open')).length;
  const short=cs.filter(c=>{const p=c.a.plans&&c.a.plans.short;return p&&p.valid&&p.state!=='blocked';}).length;
  const conflict=cs.filter(c=>{const p=c.a.plans&&c.a.plans.short;
    return p&&p.valid&&p.state!=='blocked'&&gatePermit(c,'any');}).length;
  return {long,short,conflict};
}
function renderSideTabs(){
  if(!$('#cntLong')) return;
  const n=sideCounts();
  $('#cntLong').textContent=n.long; $('#cntShort').textContent=n.short; $('#cntDual').textContent=n.conflict;
  $('#tabLong').title=`${n.long} ارز مجاز دروازه برای ورود لانگ`;
  $('#tabShort').title=`${n.short} فرصت شورت آماده یا منتظر پولبک`;
  $('#tabBoth').title=`${n.conflict} دارایی با سیگنال هم‌زمان در هر دو جهت`;
}

/* نمای دوطرفه — تعارض لانگ/شورت از قبل در موتور بود ولی هرگز نمایش داده نمی‌شد */
function renderDual(){
  const box=$('#dualPanel'); if(!box) return;
  const cs=state.coins.filter(c=>c.a&&c.a.ok&&tradable(c)&&c.a.plans);
  const rows=cs.map(c=>{
    const a=c.a, sp=a.plans.short, longOk=gatePermit(c,'open'), longWatch=gatePermit(c,'any');
    const shortOk=sp&&sp.valid&&sp.state!=='blocked';
    return {c,a,sp,longOk,longWatch,shortOk,conflict:shortOk&&longWatch};
  }).filter(r=>r.longOk||r.shortOk)
    .sort((x,y)=>(y.conflict-x.conflict)||(y.a.buyScore-x.a.buyScore))
    .slice(0,24);
  if(!rows.length){
    box.innerHTML='<div class="empty" style="grid-column:1/-1;padding:26px;font-size:.82rem;line-height:1.9">در حال حاضر هیچ سیگنال مجازی در هیچ‌یک از دو جهت وجود ندارد.<br><span style="color:var(--muted)">عدم معامله هم یک خروجی معتبر است.</span></div>';
    return;
  }
  box.innerHTML=rows.map(r=>{
    const {c,a,sp}=r;
    const cardCls=r.conflict?'conflict':r.longOk?'long-side':'short-side';
    const longBox=`<div class="dual-side l"><b>🟢 لانگ — ${r.longOk?'مجاز':r.longWatch?'انتخابی':'بدون مجوز'}</b>
      <div class="lv"><span>ورود</span><b>${fmtP(a.entry)}</b></div>
      <div class="lv"><span>حد ضرر</span><b>${fmtP(a.stop)}</b></div>
      <div class="lv"><span>هدف ۱</span><b>${fmtP(a.tp1)}</b></div>
      <div class="lv"><span>امتیاز / RR</span><b>${a.buyScore} • ${a.rr.toFixed(1)}</b></div></div>`;
    const shortBox=sp&&sp.valid?`<div class="dual-side s"><b>🔻 شورت — ${esc(SHORT_STATUS[sp.state]||'—')}</b>
      <div class="lv"><span>ورود</span><b>${fmtP(sp.entry)}</b></div>
      <div class="lv"><span>حد ضرر</span><b>${fmtP(sp.stop)}</b></div>
      <div class="lv"><span>هدف ۱</span><b>${fmtP(sp.tp1)}</b></div>
      <div class="lv"><span>امتیاز / RR</span><b>${sp.score} • ${sp.rr.toFixed(1)}</b></div></div>`
      :'<div class="dual-side s"><b>🔻 شورت</b><div class="lv"><span>هندسه‌ی معتبری برای شورت وجود ندارد</span></div></div>';
    const note=r.conflict
      ? '<div class="dual-note warn">⚠️ تعارض جهت: هر دو سمت هم‌زمان سیگنال دارند. موتور در این حالت از ثبت خودکار جلوگیری می‌کند — یعنی ساختار بازار برای این دارایی قطعی نیست و بهترین کار صبر است.</div>'
      : r.longOk
        ? '<div class="dual-note">فقط سمت لانگ مجوز دارد؛ سمت شورت در شرایط فعلی رد شده است.</div>'
        : '<div class="dual-note">فقط سمت شورت سیگنال دارد؛ ورود لانگ از دروازه عبور نکرده است.</div>';
    return `<article class="dual-card ${cardCls}" data-action="open" data-id="${esc(c.id)}" role="button" tabindex="0" aria-label="نمایش تحلیل ${esc(c.name)}">
      <h4><img src="${safeImg(c.image)}" alt="" loading="lazy">${esc(c.name)} <small>${esc(c.symbol.toUpperCase())}</small></h4>
      <div class="dual-sides">${longBox}${shortBox}</div>${note}</article>`;
  }).join('');
}

/* =====================================================================
   خروجی ماشین‌خوان سیگنال‌ها — قرارداد JSON نسخه‌دار (schema 1.0)
   پایه‌ی یک API واقعی. کاملاً محلی؛ هیچ درخواست خروجی ارسال نمی‌شود.
   ===================================================================== */
const SIGNAL_SCHEMA_VERSION='1.0';
const DISCLAIMER='تحلیلی/آزمایشی — سیگنال قطعی معامله نیست. کارمزد، لغزش، فاندینگ و لیکوییدیشن محاسبه نشده است.';
const num=(v,d=8)=>Number.isFinite(v)?Number(v.toFixed(d)):null;

function longSignal(c){
  const a=c.a, g=a.gate;
  return {
    side:'long', strategyVersion:'legacy-long-v1',
    id:c.id, symbol:String(c.symbol||'').toUpperCase(), name:c.name,
    price:num(c.current_price),
    entry:{ best:num(a.entry), low:num(a.entryLo), high:num(a.entryHi), avg:num(a.avgEntry),
      gapPct:num(a.entryGap,4), state:a.buyState, stateText:a.buyStateTxt,
      ladder:(a.ladder||[]).map((s,i)=>({step:i+1,price:num(s.p),weight:s.w})) },
    exit:{ stop:num(a.stop), tp1:num(a.tp1), tp2:num(a.tp2) },
    risk:{ rr:num(a.rr,4), rrNow:num(a.rrNow,4), riskPct:num(a.riskPct,4), wideStop:!!a.wideStop },
    score:{ buyScore:a.buyScore, grade:a.grade, technical:a.score, confidence:a.conf, category:a.cat },
    gate:g?{ state:g.state, exempt:!!g.exempt, reasons:g.reasons||[],
      thresholds:g.need?{score:g.need.score,rrNow:num(g.need.rrNow,4),rs7:num(g.need.rs7,4)}:null }:null,
    context:{ rs7:num(a.rs7,4), pred7d:num(a.pred,4), rsi:num(a.rsi,2),
      divergence:a.divergType||null, volatilityPct:num(a.dvol,4), marketCap:num(c.market_cap,2) },
    disclaimer:DISCLAIMER
  };
}
function shortSignal(c){
  const p=c.a.plans&&c.a.plans.short; if(!p) return null;
  return {
    side:'short', strategyVersion:p.version,
    id:c.id, symbol:String(c.symbol||'').toUpperCase(), name:c.name,
    price:num(c.current_price),
    entry:{ best:num(p.entry), low:num(p.entryLo), high:num(p.entryHi), avg:num(p.avgEntry),
      state:p.state, stateText:SHORT_STATUS[p.state]||null, ladder:[] },
    exit:{ stop:num(p.stop), tp1:num(p.tp1), tp2:num(p.tp2) },
    risk:{ rr:num(p.rr,4), rrNow:num(p.rrNow,4), riskPct:num(p.riskPct,4), wideStop:false },
    score:{ shortScore:p.score, technical:c.a.score },
    gate:{ state:p.gate.state, exempt:false, reasons:p.gate.reasons||[],
      thresholds:p.gate.need?{score:p.gate.need.score,rr:num(p.gate.need.rr,4)}:null },
    context:{ rs7:num(c.a.rs7,4), rsi:num(c.a.rsi,2), divergence:c.a.divergType||null,
      volatilityPct:num(c.a.dvol,4), marketCap:num(c.market_cap,2) },
    valid:!!p.valid,
    disclaimer:DISCLAIMER
  };
}
function buildSignalPayload(opts={}){
  const side=opts.side||'both', approvedOnly=opts.filter!=='all';
  const cs=state.coins.filter(c=>c.a&&c.a.ok&&tradable(c));
  const signals=[];
  if(side!=='short') cs.forEach(c=>{
    if(approvedOnly&&!gatePermit(c,'open')) return;
    signals.push(longSignal(c));
  });
  if(side!=='long') cs.forEach(c=>{
    const s=shortSignal(c); if(!s) return;
    if(approvedOnly&&!(s.valid&&c.a.plans.short.state!=='blocked')) return;
    signals.push(s);
  });
  signals.sort((x,y)=>(y.score.buyScore??y.score.shortScore??0)-(x.score.buyScore??x.score.shortScore??0));
  const R=state.regime;
  return {
    schemaVersion:SIGNAL_SCHEMA_VERSION,
    generatedAt:new Date().toISOString(),
    dataAsOf:Number.isFinite(state.dataAt)?new Date(state.dataAt).toISOString():null,
    dataFresh:shortFresh(),
    source:'coingecko',
    filter:{side,approvedOnly},
    market:{ regime:R?R.k:null, regimeLabel:R?R.label:null, regimeScore:R?R.pts:null,
      gate:state.gate?state.gate.state:null, gateMode:gate.mode,
      fng:fngValue(), breadth:R?num(R.breadth,4):null, aboveSma20:R?num(R.above,4):null },
    count:signals.length,
    signals,
    disclaimer:DISCLAIMER
  };
}
function apiOptions(){
  return { side:($('#apiSide')&&$('#apiSide').value)||'both',
           filter:($('#apiFilter')&&$('#apiFilter').value)||'approved' };
}
function renderApiPreview(){
  const pre=$('#apiPreview'); if(!pre) return;
  const payload=buildSignalPayload(apiOptions());
  const preview={...payload, signals:payload.signals.slice(0,2)};
  pre.textContent=JSON.stringify(preview,null,2);
  const s=$('#apiSummary');
  if(s) s.textContent=payload.count
    ? `${payload.count} سیگنال در خروجی • نمایش ۲ مورد اول • داده: ${payload.dataFresh?'تازه':'کهنه/آفلاین'}${payload.dataAsOf?` (${faTime(payload.dataAt||Date.parse(payload.dataAsOf))})`:''}`
    : 'با این فیلتر سیگنالی وجود ندارد — عدم معامله هم یک خروجی معتبر است.';
}
function downloadSignalJSON(){
  const payload=buildSignalPayload(apiOptions());
  const stamp=new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8;'});
  const url=URL.createObjectURL(blob), link=document.createElement('a');
  link.href=url; link.download=`cryptobin_signals_${stamp}.json`;
  document.body.appendChild(link); link.click(); document.body.removeChild(link);
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast(`⬇️ ${payload.count} سیگنال در قالب JSON دانلود شد`);
}
async function copySignalJSON(){
  const payload=buildSignalPayload(apiOptions());
  const text=JSON.stringify(payload,null,2);
  try{
    await navigator.clipboard.writeText(text);
    toast(`📋 ${payload.count} سیگنال در کلیپ‌بورد کپی شد`);
  }catch(e){ toast('⚠️ کپی خودکار ممکن نشد؛ از دکمه‌ی دانلود استفاده کنید'); }
}
function initSideUI(){
  const tabs=$('#sideTabs');
  if(tabs){
    tabs.querySelectorAll('.side-tab').forEach(b=>{
      b.onclick=()=>{ setSide(b.dataset.side); try{history.replaceState(null,'','#'+b.dataset.side);}catch(e){} };
    });
    // پیمایش تب‌ها با کلیدهای جهت‌دار — الگوی استاندارد tablist
    tabs.onkeydown=e=>{
      if(!['ArrowRight','ArrowLeft','Home','End'].includes(e.key)) return;
      e.preventDefault();
      const i=SIDES.indexOf(sideView.cur);
      // RTL: فلش چپ یعنی تب بعدی
      const next=e.key==='Home'?0:e.key==='End'?SIDES.length-1
        :e.key==='ArrowLeft'?(i+1)%SIDES.length:(i-1+SIDES.length)%SIDES.length;
      setSide(SIDES[next]); try{history.replaceState(null,'','#'+SIDES[next]);}catch(_){}
      const el=document.querySelector(`.side-tab[data-side="${SIDES[next]}"]`); if(el) el.focus();
    };
  }
  if($('#apiSide'))     $('#apiSide').onchange=renderApiPreview;
  if($('#apiFilter'))   $('#apiFilter').onchange=renderApiPreview;
  if($('#apiCopy'))     $('#apiCopy').onclick=copySignalJSON;
  if($('#apiDownload')) $('#apiDownload').onclick=downloadSignalJSON;
  setSide(sideView.cur,false);
}

/* ------------------------- Data fetching ------------------------- */
async function getJSON(url){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  try{
    const r=await fetch(url,{signal:controller.signal});
    if(!r.ok){const e=new Error(r.status);e.status=r.status;throw e;}
    return await r.json();
  }finally{clearTimeout(timer);}
}
function marketRows(data){
  if(!Array.isArray(data))return [];
  return data.filter(c=>c&&typeof c.id==='string'&&typeof c.name==='string'&&typeof c.symbol==='string'&&Number.isFinite(c.current_price)&&c.current_price>0)
    .map(c=>({...c,sparkline_in_7d:{price:Array.isArray(c.sparkline_in_7d?.price)?c.sparkline_in_7d.price:[]}}));
}
async function loadAll(manual=false){
  if(state.loading) return;
  state.loading=true;
  const btn=$('#refreshBtn'); btn.classList.add('spin'); btn.disabled=true; btn.setAttribute('aria-busy','true'); $('#statusTxt').textContent='در حال واکشی داده از CoinGecko…';
  try{
    // منابع مستقل را هم‌زمان می‌گیریم؛ اما خرابی سرویس‌های جانبی نباید داده‌ی اصلی قیمت را از کار بیندازد.
    // مهم‌تر: FNG باید پیش از applyMarketContext آماده باشد، وگرنه گاردریل ترس/طمع یک چرخه عقب می‌ماند.
    const [coinsResult, globalResult, fngResult]=await Promise.allSettled([
      getJSON(`${API}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=true&price_change_percentage=1h%2C24h%2C7d%2C30d`),
      getJSON(`${API}/global`),
      getJSON('https://api.alternative.me/fng/?limit=1')
    ]);
    if(coinsResult.status==='rejected') throw coinsResult.reason;
    const coins=marketRows(coinsResult.value);
    if(!Array.isArray(coins) || !coins.length) throw new Error('پاسخ خالی یا نامعتبر CoinGecko');
    if(globalResult.status==='fulfilled' && globalResult.value?.data) state.global=globalResult.value.data;
    if(fngResult.status==='fulfilled' && fngResult.value?.data?.[0]) state.fng=fngResult.value.data[0];
    else state.fng=null;
    const receivedAt=Date.now();
    /* تاریخچه‌ی کلان: روند سلطه‌ی BTC و ارزش کل بازار بدون هیچ فراخوان تازه‌ای
       ساخته می‌شود (فقط از همان پاسخ /global و تاریخچه‌ی محلی). */
    if(typeof MarketData!=='undefined' && state.global){
      try{
        state.history = MarketData.pushHistory(state.history, state.global, receivedAt);
        state.globalTrend = MarketData.globalTrend(state.history, receivedAt);
      }catch(e){ state.globalTrend=null; }
    }
    const indicators=await computeIndicatorsInWorker(coins);
    /* داده‌ی غنی‌شده‌ی کش‌شده پیش از تحلیل می‌نشیند تا همین چرخه از ATR و
       تأیید حجم بهره ببرد — با صفر فراخوان تازه. */
    attachCachedMarketData(coins);
    state.coins=coins.map((c,i)=>({...c,a:analyze(c,indicators?.[i])}));
    state.liveData=true; state.dataAt=receivedAt;
    applyMarketContext();
    try{ localStorage.setItem(LS_KEYS.cache, JSON.stringify({v:CACHE_VERSION,t:Date.now(),coins})); }catch(e){ try{ localStorage.removeItem(LS_KEYS.cache); }catch(_){} }
    $('#dot').classList.remove('err'); $('#statusTxt').textContent=`متصل • ${coins.length} ارز • ${faTime(Date.now())}`;
    $('#updTime').textContent=`آخرین بروزرسانی: ${faTime(Date.now())}`;
    mon.backoff=1;
    if(manual) toast('✅ داده‌ها با موفقیت بروزرسانی شد');
  }catch(e){
    state.liveData=false;
    $('#dot').classList.add('err');
    if(e&&e.status===429){ mon.backoff=Math.min((mon.backoff||1)*2,8); mon.left=mon.iv*mon.backoff; toast('⏳ محدودیت نرخ CoinGecko؛ بررسی بعدی با تأخیر انجام می‌شود',5000); } else { mon.backoff=1; }
    let cache=null; try{ cache=JSON.parse(localStorage.getItem(LS_KEYS.cache)||'null'); }catch(_){ cache=null; }
    const age=cache?.t ? Date.now()-cache.t : Infinity;
    const cachedCoins=marketRows(cache?.coins);
    const cacheValid=cache?.v===CACHE_VERSION && cachedCoins.length && age>=0 && age<=CACHE_MAX_AGE_MS;
    if(cacheValid){
      state.coins=cachedCoins.map(c=>({...c,a:analyze(c)})); applyMarketContext();
      const fresh=age<=CACHE_FRESH_MS;
      $('#statusTxt').textContent=`آفلاین — داده ${fresh?'تازه':'قدیمی'} (${faTime(cache.t)})`;
      toast(`⚠️ اتصال برقرار نشد؛ داده‌ی کش‌شده‌ی ${Math.round(age/60000)} دقیقه قبل نمایش داده می‌شود`);
    } else {
      if(cache) try{ localStorage.removeItem(LS_KEYS.cache); }catch(_){}
      $('#statusTxt').textContent='خطا در اتصال'; toast('❌ عدم دسترسی به مرجع داده؛ کش معتبر و کمتر از ۶ ساعت نیز موجود نیست');
    }
  }
  btn.classList.remove('spin'); btn.disabled=false; btn.removeAttribute('aria-busy');
  state.loading=false;
  renderAll();
  afterCycle();
}

/* ------------------------- Rendering ------------------------- */
function refreshModal(){
  if(!state.modalCoin||!$('#modal').classList.contains('open'))return;
  const current=state.coins.find(c=>c.id===state.modalCoin.id);
  if(!current){closeModal();return;}
  state.modalCoin=current;
  // Do not replace focused calculator fields on a periodic refresh.
  $('#mshort').innerHTML=shortDetails(current);
  if(mainMeta)drawMain(mainMeta.prices,mainMeta.times);
}
function renderAll(){ updateShortPlans(); renderShorts(); renderOverview(); renderPulse(); renderFNG(); renderDual(); renderCmp(); renderBest(); renderChips(); renderList(); renderApiPreview(); renderSideTabs(); refreshModal(); }

function renderOverview(){
  const g=state.global; const cs=state.coins.filter(c=>c.a.ok && tradable(c));
  if(g){
    $('#s-mcap').textContent=fmtBig(g.total_market_cap.usd);
    const ch=g.market_cap_change_percentage_24h_usd; $('#s-mcapch').innerHTML=`<span class="${cls(ch)}">${pct(ch)}</span> در ۲۴ ساعت`;
    $('#s-vol').textContent=fmtBig(g.total_volume.usd);
    $('#s-dom').textContent=g.market_cap_percentage.btc.toFixed(1)+'%';
    $('#s-eth').textContent='اتریوم: '+g.market_cap_percentage.eth.toFixed(1)+'%';
  } else if(cs.length){ $('#s-mcap').textContent=fmtBig(cs.reduce((s,c)=>s+c.market_cap,0)); $('#s-vol').textContent=fmtBig(cs.reduce((s,c)=>s+c.total_volume,0)); $('#s-mcapch').textContent='مجموع ۱۰۰ ارز برتر'; }
  if(cs.length){
    const avg=cs.reduce((s,c)=>s+c.a.rsi,0)/cs.length; $('#s-rsi').textContent=avg.toFixed(1);
    $('#s-rsitxt').innerHTML=avg>65?'<span class="down">بازار در اشباع خرید</span>':avg<38?'<span class="up">بازار در اشباع فروش — فرصت انباشت</span>':'ناحیه متعادل';
    const above=cs.filter(c=>c.current_price>c.a.sma20).length; $('#s-above').textContent=Math.round(above/cs.length*100)+'%';
  }
}

function drawGauge(cv,val,colors){
  const ctx=cv.getContext('2d'); const W=cv.width,H=cv.height; ctx.clearRect(0,0,W,H);
  const cx=W/2, cy=H-10, r=60; const segs=colors.length;
  for(let i=0;i<segs;i++){ const a0=Math.PI+ (Math.PI/segs)*i, a1=a0+Math.PI/segs-0.03; ctx.beginPath(); ctx.arc(cx,cy,r,a0,a1); ctx.lineWidth=14; ctx.strokeStyle=colors[i]; ctx.lineCap='butt'; ctx.stroke(); }
  const ang=Math.PI+Math.PI*clamp(val,0,100)/100;
  ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(cx+Math.cos(ang)*(r-4), cy+Math.sin(ang)*(r-4)); ctx.lineWidth=3; ctx.strokeStyle='#fff'; ctx.lineCap='round'; ctx.stroke();
  ctx.beginPath(); ctx.arc(cx,cy,5,0,Math.PI*2); ctx.fillStyle='#fff'; ctx.fill();
}

function renderPulse(){
  const cs=state.coins.filter(c=>c.a.ok && tradable(c)); if(!cs.length) return;
  let ws=0,wp=0,wsum=0; cs.forEach(c=>{ const w=Math.sqrt(c.market_cap||1); ws+=c.a.score*w; wp+=c.a.pred*w; wsum+=w; });
  const mscore=ws/wsum, mpred=wp/wsum;
  drawGauge($('#mktGauge'),mscore,['#ef4444','#fb7185','#94a3b8','#fbbf24','#4ade80','#00e676']);
  const label=mpred>4?'صعودی قوی 🚀':mpred>1.5?'صعودی 📈':mpred>-1.5?'خنثی / نوسانی ↔️':mpred>-4?'نزولی 📉':'نزولی قوی 🩸';
  $('#mktForecast').textContent=label; $('#mktForecast').className='forecast-big '+(mpred>=0?'up':'down');
  const fng=fngValue();
  let extra=''; if(fng!=null){ if(fng<25&&mscore<45) extra=' | ترس شدید + ضعف تکنیکال: تاریخاً منطقه انباشت هوشمند'; else if(fng>75&&mscore>60) extra=' | طمع شدید: مراقب اصلاح ناگهانی باشید'; }
  $('#mktForecastSub').textContent=`امتیاز وزنی بازار: ${mscore.toFixed(0)}/100 • بازده مورد انتظار هفته: ${pct(mpred,1)}${extra}`;
  const counts={}; Object.keys(CATS).forEach(k=>counts[k]=0); cs.forEach(c=>counts[c.a.cat]++);
  const n=cs.length; $('#breadthBar').innerHTML=Object.keys(CATS).map(k=>`<span style="width:${counts[k]/n*100}%;background:${CATS[k].c}" title="${CATS[k].label}: ${counts[k]}"></span>`).join('');
  $('#breadthLegend').innerHTML=Object.keys(CATS).map(k=>`<span><i style="background:${CATS[k].c}"></i>${CATS[k].label}: ${counts[k]}</span>`).join('');
  const bull=counts.sbuy+counts.buy, bear=counts.sell+counts.ssell, neut=n-bull-bear;
  $('#breadthTxt').textContent=`${Math.round(bull/n*100)}٪ مثبت / ${Math.round(bear/n*100)}٪ منفی / ${Math.round(neut/n*100)}٪ خنثی`;
  renderRegime();
  renderTradeSignals(cs);
}

/* سیگنال‌های اصلی = فقط «مجاز»های دروازه‌ی رژیم؛ اگر دروازه خاموش باشد، قوی‌ترین‌ها */
function renderTradeSignals(cs){
  cs = cs || state.coins.filter(c=>c.a.ok && tradable(c));
  const el=$('#topSignals'); if(!el) return;
  const gateOn = gate.mode!=='off' && state.gate;
  const byScore=(x,y)=>y.a.buyScore-x.a.buyScore || y.a.score-x.a.score;
  const list = gateOn ? cs.filter(c=>c.a.gate && c.a.gate.state==='open').sort(byScore)
                      : cs.slice().sort(byScore);
  const show=list.slice(0,6);
  if(!show.length){
    el.innerHTML = gateOn
      ? `<div class="empty" style="padding:14px;font-size:.8rem;line-height:1.9">🛑 در حال حاضر هیچ ارزی از دروازه‌ی رژیم عبور نکرده — <b>ورود تازه توصیه نمی‌شود</b>.<br><span class="ts-sub">با باز شدن دروازه، سیگنال‌های مجاز همین‌جا نمایش داده می‌شوند.</span></div>`
      : '<div class="empty" style="padding:12px;font-size:.8rem">داده‌ای برای نمایش وجود ندارد</div>';
    return;
  }
  el.innerHTML=show.map(c=>`<div class="mover" data-action="open" data-id="${esc(c.id)}" role="button" tabindex="0" title="بهترین قیمت خرید: ${fmtP(c.a.entry)}"><img src="${safeImg(c.image)}" alt="" loading="lazy"><b>${esc(c.name)} <small style="color:var(--muted)">${esc(c.symbol.toUpperCase())}</small></b>${gateOn? gateBadge(c.a.gate) : `<span class="cat" style="--catc:${CATS[c.a.cat].c};font-size:.68rem;padding:2px 8px">${CATS[c.a.cat].label}</span>`}<span style="font-weight:800;min-width:26px;text-align:left;color:${c.a.gradeC}">${c.a.buyScore}</span></div>`).join('')
    + (list.length>6?`<div class="ts-sub" style="text-align:center;padding-top:3px">و ${list.length-6} ارز مجاز دیگر — فهرست کامل در بخش «بهترین رمزارزها»</div>`:'');
}

/* نوار «فهرست معامله» — پاسخ یک‌جمله به این پرسش که الان کدام ارزها را می‌توان معامله کرد */
function tradeChipHtml(c,isWatch){
  return `<button class="tchip${isWatch?' watch':''}" data-action="open" data-id="${esc(c.id)}" title="${esc(c.name)} • بهترین قیمت خرید: ${fmtP(c.a.entry)} • امتیاز خرید ${c.a.buyScore}"><img src="${safeImg(c.image)}" alt=""><span>${esc(c.symbol.toUpperCase())}</span><small>${c.a.buyScore} (${esc(c.a.grade)})</small></button>`;
}
function renderTradeStrip(){
  const el=$('#tradeStrip'); if(!el) return;
  const cs=state.coins.filter(c=>c.a.ok && tradable(c));
  if(!cs.length){ el.style.display='none'; return; }
  el.style.display='';
  const byScore=(x,y)=>y.a.buyScore-x.a.buyScore || y.a.score-x.a.score;
  const gateOn = gate.mode!=='off' && state.gate;
  if(!gateOn){
    el.style.setProperty('--tc','#7c5cff');
    el.innerHTML=`<div class="ts-h">🚦 دروازه‌ی رژیم خاموش است <span class="ts-sub">— هیچ فیلتر ورودی اعمال نمی‌شود؛ فهرست زیر صرفاً قوی‌ترین سیگنال‌های فعلی است</span></div>
      <div class="trade-chips">${cs.slice().sort(byScore).slice(0,8).map(c=>tradeChipHtml(c)).join('')}</div>`;
    return;
  }
  const S=GATE_STATES[state.gate.state];
  const open=cs.filter(c=>c.a.gate && c.a.gate.state==='open').sort(byScore);
  const watch=cs.filter(c=>c.a.gate && c.a.gate.state==='watch').sort(byScore);
  el.style.setProperty('--tc',S.c);
  let html=`<div class="ts-h">${S.icon} سیگنال‌های مجاز برای معامله <span class="ts-sub">دروازه: ${esc(S.label)} • ${open.length} مجاز${watch.length?` • ${watch.length} انتخابی`:''} • برای جزئیات روی هر ارز بزنید</span></div>`;
  if(open.length){
    html+=`<div class="trade-chips">${open.slice(0,10).map(c=>tradeChipHtml(c)).join('')}${open.length>10?`<span class="tchip" style="cursor:default"><small>+${open.length-10} مورد دیگر در جدول پایین</small></span>`:''}</div>`;
    if(watch.length) html+=`<div class="trade-chips" style="margin-top:7px"><span class="ts-sub" style="align-self:center">در آستانه‌ی مجوز (فقط با تأیید):</span>${watch.slice(0,4).map(c=>tradeChipHtml(c,true)).join('')}</div>`;
  } else if(state.gate.state==='blocked'){
    html+=`<div class="ts-empty">🛑 دروازه‌ی رژیم بسته است — در حال حاضر <b>هیچ ارزی مجاز به ورود تازه نیست</b>. سیگنال‌های خریدِ این دوره صرفاً تحلیلی‌اند؛ منتظر بهبود رژیم بازار بمانید یا فقط پله‌های کوچک بلندمدت در نظر بگیرید.</div>`;
    if(watch.length) html+=`<div class="trade-chips" style="margin-top:7px"><span class="ts-sub" style="align-self:center">نزدیک‌ترین‌ها به مجوز (انتخابی):</span>${watch.slice(0,4).map(c=>tradeChipHtml(c,true)).join('')}</div>`;
  } else {
    html+=`<div class="ts-empty">در حال حاضر هیچ ارزی همه‌ی شرط‌های دروازه را هم‌زمان ندارد${watch.length?' — موارد «انتخابی» زیر با یک تأیید وارد فهرست مجازها می‌شوند':''}.</div>`;
    if(watch.length) html+=`<div class="trade-chips" style="margin-top:7px">${watch.slice(0,6).map(c=>tradeChipHtml(c,true)).join('')}</div>`;
  }
  el.innerHTML=html;
}

/* مقدار عددی معتبر شاخص ترس و طمع (۰ تا ۱۰۰) یا null — یک مرجع واحد برای گیج، رژیم و دروازه.
   مقدار نامعتبر باید null شود، نه NaN؛ وگرنه NaN به گیج و گاردریل‌های دروازه نشت می‌کند. */
function fngValue(){
  const raw=state.fng&&state.fng.value;
  const v=typeof raw==='number'?raw:parseInt(raw,10);
  return Number.isFinite(v)&&v>=0&&v<=100 ? v : null;
}
const FNG_COLORS=['#ef4444','#fb7185','#fbbf24','#4ade80','#00e676'];
function renderFNG(){
  const cv=$('#fngGauge'); if(!cv) return;
  const v=fngValue();
  if(v==null){
    drawGauge(cv,50,FNG_COLORS);
    $('#fngVal').textContent='—'; $('#fngVal').style.color='';
    $('#fngTxt').textContent='داده در دسترس نیست';
    $('#fngHint').textContent='سرویس Alternative.me پاسخ معتبری نداد؛ گاردریل ترس/طمع در دروازه‌ی رژیم این چرخه اعمال نمی‌شود.';
    return;
  }
  drawGauge(cv,v,FNG_COLORS);
  const map={'Extreme Fear':'ترس شدید','Fear':'ترس','Neutral':'خنثی','Greed':'طمع','Extreme Greed':'طمع شدید'};
  const cls=state.fng&&state.fng.value_classification;
  const label=map[cls]||cls||(v<25?'ترس شدید':v<45?'ترس':v<55?'خنثی':v<75?'طمع':'طمع شدید');
  $('#fngVal').textContent=v; $('#fngVal').style.color=v<25?'#ef4444':v<45?'#fb7185':v<55?'#fbbf24':v<75?'#4ade80':'#00e676';
  $('#fngTxt').textContent=label;
  $('#fngHint').textContent=v<25?'💡 ترس شدید معمولاً فرصت‌های خرید پله‌ای ایجاد می‌کند (وارن بافت: وقتی دیگران می‌ترسند، طمع کنید).':v>75?'💡 طمع شدید هشدار احتیاط است؛ ذخیره سود و کاهش اهرم توصیه می‌شود.':'💡 احساسات بازار در محدوده طبیعی؛ تصمیم‌ها را بر پایه تکنیکال و دروازه‌ی رژیم بگیرید.';
}

function renderRegime(){
  const R=state.regime; if(!R) return;
  const box=$('#regimePanel');
  const regEl=box.querySelector('.regime');
  if(regEl){ regEl.style.setProperty('--rc',R.c); const ico=regEl.querySelector('.rico'); if(ico) ico.textContent=R.icon; const lbl=regEl.querySelector('.rlbl'); if(lbl) lbl.textContent=R.label; const sub=regEl.querySelector('.rsub'); if(sub) sub.textContent=`BTC ۲۴h: ${pct(R.btc24,1)} • BTC ۷d: ${pct(R.btc7,1)} • امتیاز رژیم ${R.pts>0?'+':''}${R.pts}`; }
  $('#regimeWhy').innerHTML=R.why.slice(0,4).map(w=>`<span>${esc(w)}</span>`).join('');
  let hint=R.hint;
  if(R.k==='riskon' && R.fng!=null && R.fng>78) hint+=' ⚠️ اما طمع شدید در بازار؛ از تعقیب قیمت بپرهیزید.';
  if(R.k==='riskoff' && R.fng!=null && R.fng<22) hint+=' 💡 ترس شدید + ریسک‌گریزی: منطقه‌ی انباشت پله‌ای بلندمدت روی ارزهای بزرگ.';
  $('#regimeHint').textContent=hint;
  renderGate();
}

function syncGateUI(){
  const b=$('#gateOnlyBtn');
  if(b){ b.classList.toggle('active', gate.onlyApproved); b.setAttribute('aria-pressed', gate.onlyApproved?'true':'false'); }
  const s=$('#gateMode'); if(s) s.value=gate.mode;
}

function renderGate(){
  const box=$('#gateBox'); if(!box) return;
  const m=state.gate;
  if(!m){ box.style.setProperty('--gc','#94a3b8');
    box.innerHTML='<div class="gate-h"><span class="g-ico">🚦</span><div><b>دروازه‌ی رژیم</b><span class="g-sub">در حال محاسبه…</span></div></div>';
    return; }
  const S=GATE_STATES[m.state]||GATE_STATES.watch, s=m.stats||{open:0,watch:0,blocked:0,exempt:0};
  const n=Math.max(1,(s.open||0)+(s.watch||0)+(s.blocked||0));
  box.style.setProperty('--gc',S.c);
  box.innerHTML=`<div class="gate-h"><span class="g-ico" aria-hidden="true">${S.icon}</span>
      <div><b>${esc(S.label)}</b><span class="g-sub">دروازه‌ی رژیم — وضعیت ورود تازه در کل بازار • آستانه‌ها بر پایه توزیع واقعی بازار کالیبره شده‌اند</span></div>
      <span class="g-mode" title="حالت دروازه از بخش تنظیمات پایش قابل تغییر است">${esc(GATE_MODES[gate.mode].label)}</span></div>
    <div class="gate-bar" role="img" aria-label="سهم ارزهای مجاز، انتخابی و مسدود">
      <span style="width:${(s.open||0)/n*100}%;background:${GATE_STATES.open.c}" title="مجاز: ${s.open||0}"></span>
      <span style="width:${(s.watch||0)/n*100}%;background:${GATE_STATES.watch.c}" title="انتخابی: ${s.watch||0}"></span>
      <span style="width:${(s.blocked||0)/n*100}%;background:${GATE_STATES.blocked.c}" title="مسدود: ${s.blocked||0}"></span>
    </div>
    <div class="gate-legend">
      <span><i style="background:${GATE_STATES.open.c}"></i>مجاز: ${s.open||0}</span>
      <span><i style="background:${GATE_STATES.watch.c}"></i>انتخابی: ${s.watch||0}</span>
      <span><i style="background:${GATE_STATES.blocked.c}"></i>مسدود: ${s.blocked||0}</span>
      ${s.exempt?`<span><i style="background:${GATE_STATES.exempt.c}"></i>مستثنا (استیبل/رَپ‌شده): ${s.exempt}</span>`:''}
    </div>
    <div class="gate-why">${m.reasons.map(r=>`<span>${esc(r)}</span>`).join('')}</div>`;
}

function renderChips(){
  const counts={all:state.coins.length}; Object.keys(CATS).forEach(k=>counts[k]=state.coins.filter(c=>c.a.cat===k).length);
  const items=[{k:'all',label:'همه',c:'#7c5cff'},...Object.values(CATS)];
  $('#chips').innerHTML=items.map(i=>`<button class="chip ${state.filter===i.k?'active':''}" style="--chipc:${i.c}" data-k="${i.k}" aria-pressed="${state.filter===i.k}"><i></i>${i.label}<span class="c">${counts[i.k]||0}</span></button>`).join('');
  $('#chips').querySelectorAll('.chip').forEach(b=>b.onclick=()=>{state.filter=b.dataset.k;state.watchOnly=false;$('#watchChip').classList.remove('active');$('#watchChip').setAttribute('aria-pressed','false');try{localStorage.setItem(LS_KEYS.filter, state.filter);}catch(e){}renderChips();renderList();});
  $('#watchCount').textContent=state.watch.length;
}

function filtered(){
  let l=state.coins.filter(c=>state.filter==='all'||c.a.cat===state.filter);
  if(state.watchOnly) l=l.filter(c=>state.watch.includes(c.id));
  if(state.q){ const q=state.q.toLowerCase(); l=l.filter(c=>c.name.toLowerCase().includes(q)||c.symbol.toLowerCase().includes(q)); }
  const f={buy:(a,b)=>b.a.buyScore-a.a.buyScore||b.a.score-a.a.score, score:(a,b)=>b.a.score-a.a.score, rank:(a,b)=>a.market_cap_rank-b.market_cap_rank, ch24:(a,b)=>b.a.ch24-a.a.ch24, ch7:(a,b)=>b.a.ch7-a.a.ch7, pred:(a,b)=>b.a.pred-a.a.pred, rsi:(a,b)=>a.a.rsi-b.a.rsi, vol:(a,b)=>b.a.dvol-a.a.dvol, rs:(a,b)=>(b.a.rs7||0)-(a.a.rs7||0)}[state.sort];
  return l.sort(f);
}

function sparkline(cv,prices,color){
  const ctx=cv.getContext('2d'); const dpr=window.devicePixelRatio||1; const W=cv.clientWidth||280,H=cv.clientHeight||60; cv.width=W*dpr; cv.height=H*dpr; ctx.scale(dpr,dpr);
  if(!prices.length) return; const mn=Math.min(...prices),mx=Math.max(...prices); const r=mx-mn||1;
  ctx.beginPath(); prices.forEach((p,i)=>{ const x=i/(prices.length-1)*W, y=H-4-(p-mn)/r*(H-8); i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
  ctx.strokeStyle=color; ctx.lineWidth=1.8; ctx.lineJoin='round'; ctx.stroke();
  const g=ctx.createLinearGradient(0,0,0,H); g.addColorStop(0,color+'55'); g.addColorStop(1,color+'00');
  ctx.lineTo(W,H); ctx.lineTo(0,H); ctx.closePath(); ctx.fillStyle=g; ctx.fill();
}

function renderList(){
  const l=filtered(); const sec=$('#listSec');
  if(!l.length){ sec.innerHTML='<div class="empty">موردی مطابق فیلتر یافت نشد 🤷‍♂️<br><span style="font-size:.8rem">فیلتر را تغییر دهید یا جستجو را پاک کنید</span></div>'; return; }
  if(state.view==='cards'){
    sec.innerHTML='<div class="grid" id="grid"></div>';
    $('#grid').innerHTML=l.map((c,i)=>{ const a=c.a, C=CATS[a.cat]; return `
      <div class="card" style="--catc:${C.c};animation-delay:${Math.min(i,20)*25}ms" data-action="open" data-id="${esc(c.id)}" role="button" tabindex="0" aria-label="نمایش تحلیل ${esc(c.name)}">
        <div class="c-head"><img src="${safeImg(c.image)}" alt="" loading="lazy"><div class="nm"><b>${esc(c.name)}${a.kind!=='asset'?`<span class="kind">${KIND_LABEL[a.kind]}</span>`:''}</b><span>${esc(c.symbol.toUpperCase())} <span class="rank">#${esc(c.market_cap_rank)}</span> • ${fmtBig(c.market_cap)}</span></div>
          <button class="star ${state.watch.includes(c.id)?'on':''}" data-action="watch" data-id="${esc(c.id)}" aria-label="افزودن به علاقه‌مندی‌ها" aria-pressed="${state.watch.includes(c.id)}">★</button>
          <button class="star-cmp ${state.cmp.includes(c.id)?'on':''}" data-action="compare" data-id="${esc(c.id)}" aria-label="افزودن به مقایسه" aria-pressed="${state.cmp.includes(c.id)}">⚖️</button></div>
        <div class="c-price"><span class="p">${fmtP(c.current_price)}</span><span class="badge ${cls(a.ch24)}">${pct(a.ch24)}</span><span style="font-size:.7rem;color:var(--muted)">۷روز: <span class="${cls(a.ch7)}">${pct(a.ch7,1)}</span></span><span style="font-size:.7rem;color:var(--muted)">RS/BTC: <span class="${cls(a.rs7)} rs">${pct(a.rs7,1)}</span></span></div>
        <canvas class="spark" data-id="${esc(c.id)}" aria-hidden="true"></canvas>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;gap:6px;flex-wrap:wrap"><span class="cat">${C.icon} ${C.label}</span><span style="font-size:.72rem;color:var(--muted)">ریسک: ${esc(a.risk)} • خرید: <b style="color:${a.gradeC}">${a.buyScore} (${esc(a.grade)})</b></span></div>
        <div class="score-row"><span style="font-size:.72rem;color:var(--muted)">امتیاز تکنیکال</span><div class="score-bar" role="img" aria-label="امتیاز تکنیکال ${a.score} از ۱۰۰ — هرچه به سمت سبز (راست) نزدیک‌تر، بهتر"><span></span><i style="left:${a.score}%"></i></div><span class="score-num" style="color:${C.c}">${a.score}</span></div>
        <div class="ind"><div>RSI<b style="color:${a.rsi<30?'var(--up)':a.rsi>70?'var(--down)':'inherit'}">${a.rsi?.toFixed(0)??'—'}</b></div><div>MACD<b class="${a.hist>=0?'up':'down'}">${a.hist>=0?'مثبت ▲':'منفی ▼'}</b></div><div>روند<b class="${a.pred>=0?'up':'down'}">${esc(a.trend)}</b></div></div>
        <div class="pred"><span>پیش‌بینی ۷ روز آینده</span><b class="${cls(a.pred)}">${pct(a.pred,1)}</b><span>اطمینان ${a.conf}٪</span></div>
        <div class="buyline"><span>💰 بهترین قیمت خرید</span><b>${fmtP(a.entry)}</b><span class="stbadge st-${a.buyState}">${esc(a.buyStateTxt)}</span></div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;gap:6px;flex-wrap:wrap">
          <span style="font-size:.7rem;color:var(--muted)">R/R فعلی: <b style="color:${a.rrNow>=1.5?'var(--up)':a.rrNow>=1?'var(--pot)':'var(--down)'}">${a.rrNow.toFixed(1)}:1</b> • فاصله: <b class="${a.entryGap>=0?'up':'down'}">${pct(a.entryGap,1)}</b></span>
          ${gateBadge(a.gate)}
        </div>
      </div>`; }).join('');
    requestAnimationFrame(()=>document.querySelectorAll('.spark').forEach(cv=>{ const c=state.coins.find(x=>x.id===cv.dataset.id); if(c) sparkline(cv,c.a.prices,c.a.ch7>=0?'#22c55e':'#ef4444'); }));
  } else {
    sec.innerHTML=`<div class="tbl-wrap"><table><thead><tr><th>#</th><th>ارز</th><th>قیمت</th><th>۱ساعت</th><th>۲۴ساعت</th><th>۷روز</th><th>۳۰روز</th><th>نمودار ۷ روزه</th><th>RSI</th><th>MACD</th><th>امتیاز</th><th>امتیاز خرید</th><th>💰 بهترین قیمت خرید</th><th>وضعیت</th><th title="دروازه‌ی رژیم: مجاز / انتخابی / مسدود / مستثنا">دروازه</th><th>طبقه</th><th>پیش‌بینی ۷ روزه</th><th>ریسک</th><th>ارزش بازار</th></tr></thead><tbody>
      ${l.map(c=>{const a=c.a,C=CATS[a.cat];return `<tr data-action="open" data-id="${esc(c.id)}" tabindex="0" aria-label="نمایش تحلیل ${esc(c.name)}"><td>${esc(c.market_cap_rank)}</td><td><img src="${safeImg(c.image)}" alt="" loading="lazy"><b>${esc(c.name)}</b> <small style="color:var(--muted)">${esc(c.symbol.toUpperCase())}</small>${a.kind!=='asset'?`<span class="kind">${KIND_LABEL[a.kind]}</span>`:''}</td><td>${fmtP(c.current_price)}</td>
      <td class="${cls(a.ch1)}">${pct(a.ch1,1)}</td><td class="${cls(a.ch24)}">${pct(a.ch24,1)}</td><td class="${cls(a.ch7)}">${pct(a.ch7,1)}</td><td class="${cls(a.ch30)}">${pct(a.ch30,1)}</td>
      <td><canvas class="spark" data-id="${esc(c.id)}" style="width:120px;height:34px;margin:0" aria-hidden="true"></canvas></td><td>${a.rsi?.toFixed(0)??'—'}</td><td class="${a.hist>=0?'up':'down'}">${a.hist>=0?'▲':'▼'}</td>
      <td><b style="color:${C.c}">${a.score}</b></td><td><b style="color:${a.gradeC}">${a.buyScore}</b> <small style="color:var(--muted)">${esc(a.grade)}</small></td><td><b style="color:var(--sbuy)">${fmtP(a.entry)}</b> <small style="color:var(--muted)">${pct(a.entryGap,1)}</small></td><td><span class="stbadge st-${a.buyState}">${esc(a.buyStateTxt)}</span></td><td>${gateBadge(a.gate)}</td><td><span class="cat" style="--catc:${C.c}">${C.label}</span></td><td class="${cls(a.pred)}">${pct(a.pred,1)} <small style="color:var(--muted)">(${a.conf}٪)</small></td><td>${esc(a.risk)}</td><td>${fmtBig(c.market_cap)}</td></tr>`}).join('')}
      </tbody></table></div>`;
    requestAnimationFrame(()=>document.querySelectorAll('.spark').forEach(cv=>{ const c=state.coins.find(x=>x.id===cv.dataset.id); if(c) sparkline(cv,c.a.prices,c.a.ch7>=0?'#22c55e':'#ef4444'); }));
  }
}

function toggleWatch(id){ const i=state.watch.indexOf(id); i>=0?state.watch.splice(i,1):state.watch.push(id); try{localStorage.setItem(LS_KEYS.watch,JSON.stringify(state.watch));}catch(e){} $('#watchCount').textContent=state.watch.length; renderList(); renderAlerts(); toast(i>=0?'از علاقه‌مندی‌ها حذف شد':'⭐ به علاقه‌مندی‌ها اضافه شد',1500); }

/* ------------------------- Modal & detailed charts ------------------------- */
let modalReturnFocus=null;
async function openModal(id){
  const c=state.coins.find(x=>x.id===id); if(!c) return; state.modalCoin=c; state.tf=7;
  modalReturnFocus=document.activeElement;
  document.querySelectorAll('.tf').forEach(b=>{ const on=b.dataset.d==='7'; b.classList.toggle('active',on); b.setAttribute('aria-pressed', on?'true':'false'); });
  $('#modal').classList.add('open'); document.body.style.overflow='hidden';
  renderModalInfo(c); $('#mclose').focus(); await loadAndDrawChart();
}
function closeModal(){
  $('#modal').classList.remove('open'); document.body.style.overflow='';
  if(modalReturnFocus && typeof modalReturnFocus.focus==='function') modalReturnFocus.focus();
  modalReturnFocus=null;
}

function renderModalInfo(c){
  $('#mshort').innerHTML=shortDetails(c);
  const a=c.a,C=CATS[a.cat];
  $('#mhead').innerHTML=`<img src="${safeImg(c.image)}" alt="" loading="lazy"><div><h2>${esc(c.name)} <small style="color:var(--muted);font-size:.9rem">${esc(c.symbol.toUpperCase())} • رتبه #${esc(c.market_cap_rank)}</small></h2><span class="cat" style="--catc:${C.c}">${C.icon} ${C.label} — امتیاز تکنیکال ${a.score}/100 • امتیاز خرید ${a.buyScore} (${esc(a.grade)})</span>${a.kind!=='asset'?`<div style="font-size:.72rem;color:var(--pot);margin-top:4px">⚠️ ${KIND_LABEL[a.kind]} — از رتبه‌بندی «بهترین خرید» و کارنامه سیگنال‌ها مستثناست</div>`:''}</div><div class="mp">${fmtP(c.current_price)}<div style="font-size:.85rem" class="${cls(a.ch24)}">${pct(a.ch24)} (۲۴h) • RS/BTC ${pct(a.rs7,1)}</div></div>`;
  /* ردیف‌های داده‌ی غنی‌شده و مشتقات — فقط وقتی داده‌ی معتبر وجود دارد نمایش داده می‌شوند. */
  const mdRows = a.atr!=null ? [
    ['ATR (14) چهارساعته', a.atr.toFixed(2)+'%'],
    ['Supertrend', a.stDir===1?'صعودی 📈':a.stDir===-1?'نزولی 📉':'—'],
    ['ADX (14)', a.adx!=null?`${a.adx.toFixed(0)}${a.adx>=25?(a.diPlus>=a.diMinus?' صعودی قوی':' نزولی قوی'):' (بی‌روند)'}`:'—'],
    ['حجم نسبی (σ)', a.volZ!=null?`${a.volZ>=0?'+':''}${a.volZ.toFixed(1)}`:'—'],
    ['نسبت حجم', a.volRatioH!=null?a.volRatioH.toFixed(2)+'×':'—'],
    ['MFI (14)', a.mfi!=null?a.mfi.toFixed(0):'—'],
    ['CMF (20)', a.cmf!=null?a.cmf.toFixed(2):'—'],
    ['شیب OBV', a.obvSlope!=null?a.obvSlope.toFixed(2):'—'],
    ['VWAP حجمی', a.vwapVol!=null?fmtP(a.vwapVol):'—'],
    ['شکست ۲۴ ساعته', a.brk24?(a.brk24.state==='up'?'سقف 📈':a.brk24.state==='down'?'کف 📉':'داخل دامنه'):'—'],
  ] : [];
  const dvRows = a.fundingAnnual!=null ? [
    ['فاندینگ سالانه', pct(a.fundingAnnual,1)],
    ['OI تجمیعی فیوچرز', a.oiUsd?fmtBig(a.oiUsd):'—'],
    ['تغییر OI (≥۴۵ دقیقه)', a.oiChangePct!=null?pct(a.oiChangePct,1):'—'],
    ['ازدحام پوزیشن', a.crowd?`${a.crowd.side==='long'?'سمت لانگ':'سمت شورت'} ${a.crowd.level==='hot'?'🔴 داغ':'🟡 گرم'}`:'متعادل'],
  ] : [];
  $('#mkv').innerHTML=[...mdRows,...dvRows,['RSI (14)',a.rsi?.toFixed(1)],['MACD',a.macd?.toPrecision(3)],['Signal',a.sig?.toPrecision(3)],['Histogram',a.hist?.toPrecision(3)],['SMA 20',fmtP(a.sma20)],['SMA 50',fmtP(a.sma50)],['EMA 20',fmtP(a.ema20)],['باند بالا',fmtP(a.bbUp)],['باند پایین',fmtP(a.bbLo)],['موقعیت در باند',(a.bbPos*100).toFixed(0)+'%'],['پهنای باند',a.bbWidth?.toFixed(1)+'%'],['نوسان روزانه',a.dvol?.toFixed(2)+'%'],['شیب ۴۸h',(a.slopeH*24).toFixed(2)+'%/روز'],['کراس MA',a.cross==='golden'?'طلایی 🌟':a.cross==='death'?'مرگ ☠️':'—'],['کراس MACD',a.macdCross==='bull'?'صعودی':a.macdCross==='bear'?'نزولی':'—'],['قدرت نسبی ۷d',pct(a.rs7,1)],['بتا به BTC',a.beta!=null?a.beta.toFixed(2)+'×':'—']].map(([k,v])=>`<div>${esc(k)}<b>${v??'—'}</b></div>`).join('');
  $('#msig').innerHTML=[...a.signals].sort((x,y)=>Math.abs(y.s)-Math.abs(x.s)).map(s=>`<li style="--sc:${s.s>0?'var(--up)':s.s<0?'var(--down)':'var(--hold)'}"><span>${s.s>0?'✅':s.s<0?'⛔':'ℹ️'}</span><span style="flex:1">${esc(s.t)}</span><b style="color:${s.s>0?'var(--up)':s.s<0?'var(--down)':'var(--muted)'}">${s.s>0?'+':''}${s.s}</b></li>`).join('')
    + ((a.ctx&&a.ctx.length)?`<li style="--sc:var(--accent);flex-direction:column;align-items:stretch"><div class="ctxsig"><b style="font-size:.78rem">🌐 زمینه‌ی بازار (روی امتیاز فرصت خرید اثر دارد)</b>${a.ctx.map(x=>`<div><span>${esc(x.t)}</span><b style="color:${x.s>0?'var(--up)':x.s<0?'var(--down)':'var(--muted)'}">${x.s>0?'+':''}${x.s}</b></div>`).join('')}${a.beta!=null?`<div><span>بتای ۷ روزه نسبت به BTC</span><b>${a.beta.toFixed(2)}×</b></div>`:''}</div></li>`:'');
  const tp=c.current_price*(1+a.pred/100), lo=c.current_price*(1+a.predLo/100), hi=c.current_price*(1+a.predHi/100);
  const strat={sbuy:'ورود پله‌ای با حد ضرر زیر حمایت؛ هدف اول مقاومت ۷ روزه. دروازه‌ی رژیم را چک کنید — اگر بسته است فقط پله‌ی کوچک.',buy:'ورود با حجم متوسط و تأیید شکست مقاومت؛ مدیریت ریسک ۲٪. قدرت نسبی به BTC را مثبت نگه دارید.',pot:'در واچ‌لیست نگه دارید؛ تأیید برگشت با کراس MACD یا عبور از SMA20 لازم است. ورود عجولانه ممنوع.',hold:'سیگنال واضحی نیست؛ اگر پوزیشن دارید نگه دارید، ورود جدید توصیه نمی‌شود.',sell:'کاهش پوزیشن یا ذخیره سود؛ منتظر تثبیت روی حمایت بمانید.',ssell:'خروج / اجتناب از ورود؛ ساختار تکنیکال ضعیف است.'}[a.cat];
  $('#mpred').innerHTML=`<div style="font-size:.8rem;color:var(--muted)">🔮 پیش‌بینی روند ۷ روز آینده</div><div class="big ${cls(a.pred)}">${esc(a.trend)} • ${pct(a.pred,1)}</div><div style="font-size:.85rem">قیمت هدف تخمینی: <b>${fmtP(tp)}</b></div>
    <div class="range"><span>سناریوی بدبینانه<br><b class="down">${fmtP(lo)}</b></span><span style="text-align:center">میزان اطمینان<br><b>${a.conf}٪</b></span><span style="text-align:left">سناریوی خوش‌بینانه<br><b class="up">${fmtP(hi)}</b></span></div>
    <div class="conf" role="img" aria-label="اطمینان ${a.conf}٪"><span style="width:${a.conf}%"></span></div>
    <div style="margin-top:12px;font-size:.8rem;border-top:1px dashed rgba(255,255,255,.1);padding-top:8px">🎯 <b>استراتژی پیشنهادی:</b> ${esc(strat)}</div>`;
  renderCalc(c);
  const anchTxt=a.anchors.map(x=>`${esc(x.label)}: ${fmtP(x.v)}`).join(' • ');
  $('#mbuy').innerHTML=`<div style="font-size:.8rem;color:var(--muted)">💰 بهترین قیمت خرید (نقطه ورود بهینه — هرگز بالاتر از قیمت لحظه‌ای نیست)</div>
    <div class="big" style="color:var(--sbuy)">${fmtP(a.entry)}</div>
    <div style="font-size:.85rem">محدوده مطمئن خرید: <b>${fmtP(a.entryLo)}</b> تا <b>${fmtP(a.entryHi)}</b></div>
    <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center"><span class="stbadge st-${a.buyState}">${esc(a.buyStateTxt)}</span><span style="font-size:.78rem;color:var(--muted)">فاصله تا ورود: <b class="${a.entryGap>=0?'up':'down'}">${pct(a.entryGap,2)}</b> ${a.entryGap<0?`(${Math.abs(a.entryGap).toFixed(1)}٪ زیر قیمت فعلی)`:''}</span>${gateBadge(a.gate)}</div>
    <div class="lad">${a.ladder.map(x=>`<div>${x.t} (${x.w}٪)<b>${fmtP(x.p)}</b></div>`).join('')}</div>
    <div style="font-size:.75rem;color:var(--muted);margin-top:6px">میانگین ورود پلکانی: <b style="color:var(--text)">${fmtP(a.avgEntry)}</b> • اختلاف با قیمت فعلی: ${pct((a.avgEntry/c.current_price-1)*100,2)}</div>
    <div class="tri"><div class="sl">حد ضرر<b>${fmtP(a.stop)}</b></div><div class="t1">هدف ۱<b>${fmtP(a.tp1)}</b></div><div class="t2">هدف ۲<b>${fmtP(a.tp2)}</b></div><div class="rr">R/R<b>${a.rr.toFixed(1)}:1</b></div></div>
    <div style="display:flex;justify-content:space-between;font-size:.75rem;color:var(--muted);margin-top:8px;flex-wrap:wrap;gap:6px"><span>R/R با قیمت فعلی بازار: <b style="color:${a.rrNow>=1.5?'var(--up)':a.rrNow>=1?'var(--pot)':'var(--down)'}">${a.rrNow.toFixed(2)}:1</b> ${a.rrNow<1?'⚠️ تعقیب قیمت':a.rrNow>=2?'✅ عالی':''}</span><span>ریسک تا حد ضرر: <b class="down">−${a.riskPct.toFixed(1)}٪</b></span></div>
    ${a.rrNow<1?'<div style="font-size:.73rem;color:var(--pot);margin-top:4px">⚠️ خرید با قیمت فعلی نسبت ریسک/بازده کمتر از ۱ دارد — منتظر رسیدن به محدوده خرید بمانید تا R/R بهبود یابد.</div>':''}
    ${a.wideStop?'<div style="font-size:.73rem;color:var(--pot);margin-top:4px">⚠️ حمایت ساختاری بسیار دور بود؛ حد ضرر روی سقف ریسک ۱۵٪ محدود شد تا ریسک معامله کنترل شود.</div>':''}
    ${a.gate&&!a.gate.exempt?`<div class="gate-note" style="--gc:${GATE_STATES[a.gate.state].c}">
      <b>${GATE_STATES[a.gate.state].icon} دروازه‌ی رژیم: ${esc(GATE_STATES[a.gate.state].label)}</b>
      <ul>${a.gate.reasons.map(r=>`<li>${esc(r)}</li>`).join('')}</ul>
      ${a.gate.need?`<div style="margin-top:5px;font-size:.7rem;color:var(--muted)">آستانه‌های فعلی دروازه: امتیاز خرید ≥ ${a.gate.need.score} • R/R با قیمت فعلی ≥ ${a.gate.need.rrNow.toFixed(1)} ${a.gate.rsExempt?'':`• قدرت نسبی به BTC ≥ ${a.gate.need.rs7>0?'+':''}${a.gate.need.rs7} `}• وضعیت ورود مجاز: ${a.gate.need.states.map(s=>({now:'در محدوده',below:'زیر محدوده',wait:'کمی صبر'}[s]||s)).join(' / ')}</div>`:''}
    </div>`:''}
    ${a.gate&&a.gate.exempt?`<div class="gate-note" style="--gc:${GATE_STATES.exempt.c}"><b>${GATE_STATES.exempt.icon} ${esc(GATE_STATES.exempt.label)}</b><ul><li>${esc(a.gate.reasons[0]||'')}</li></ul></div>`:''}
    <div style="margin-top:10px;font-size:.75rem;color:var(--muted);border-top:1px dashed rgba(255,255,255,.12);padding-top:8px">🧮 لنگرهای محاسبه قیمت ورود (وزن‌دار): ${anchTxt}</div>
    <div style="margin-top:6px;font-size:.78rem">امتیاز فرصت خرید: <b style="color:${a.gradeC}">${a.buyScore}/100 (${esc(a.grade)})</b> • اطمینان ${a.conf}٪ • نوسان ${esc(a.risk)}</div>`;
  const mdBadge = a.mdQuality==='full' ? `<span class="mdq full" title="کندل چهارساعته و حجم ساعتی برای این ارز تحلیل شده است — ATR و تأیید حجم فعال است">⚡ داده‌ی غنی‌شده</span>`
    : a.mdQuality==='partial' ? `<span class="mdq part" title="فقط بخشی از داده‌ی کندل/حجم موجود است">⚡ داده‌ی ناقص</span>`
    : `<span class="mdq base" title="تحلیل فقط بر پایه‌ی قیمت ساعتی هفت‌روزه است؛ حجم و ATR واقعی در دسترس نیست">◽ داده‌ی پایه</span>`;
  $('#msr').innerHTML=`<div class="s">حمایت کلیدی<b>${fmtP(a.support)}</b><small>${pct((a.support/c.current_price-1)*100,1)}</small></div><div class="r">مقاومت کلیدی<b>${fmtP(a.resist)}</b><small>${pct((a.resist/c.current_price-1)*100,1)}</small></div><div style="background:rgba(255,255,255,.05)">ریسک<b>${esc(a.risk)}</b><small>نوسان ${a.dvol?.toFixed(1)}٪</small></div>`
    + `<div style="background:rgba(255,255,255,.05)">کیفیت داده${mdBadge}<small>${a.mdAt?`غنی‌سازی: ${faTime(a.mdAt)}`:'بدون غنی‌سازی'}</small></div>`;
  $('#mmkt').innerHTML=[['ارزش بازار',fmtBig(c.market_cap)],['حجم ۲۴h',fmtBig(c.total_volume)],['حجم/ارزش',(a.volRatio*100).toFixed(1)+'%'],['سقف ۲۴h',fmtP(c.high_24h)],['کف ۲۴h',fmtP(c.low_24h)],['ATH',fmtP(c.ath)],['فاصله از ATH',pct(c.ath_change_percentage,1)],['عرضه در گردش',fmtN(c.circulating_supply,0)],['عرضه کل',c.total_supply?fmtN(c.total_supply,0):'∞'],['تغییر ۳۰ روزه',pct(a.ch30,1)],['قدرت نسبی ۷d',pct(a.rs7,1)],['بتا به BTC',a.beta!=null?a.beta.toFixed(2)+'×':'—']].map(([k,v])=>`<div>${esc(k)}<b>${v}</b></div>`).join('');
}

async function loadAndDrawChart(){
  const c=state.modalCoin; let prices, times;
  if(state.tf===7){ prices=c.a.prices; const now=Date.now(); times=prices.map((_,i)=>now-(prices.length-1-i)*3600e3); }
  else {
    const key=c.id+'_'+state.tf;
    if(!state.chartCache[key]){ try{ const d=await getJSON(`${API}/coins/${encodeURIComponent(c.id)}/market_chart?vs_currency=usd&days=${state.tf}`); const ks=Object.keys(state.chartCache); if(ks.length>30) delete state.chartCache[ks[0]]; state.chartCache[key]=d.prices; }catch(e){ toast('⚠️ بارگذاری تایم‌فریم بلند ممکن نشد (محدودیت API)؛ نمایش ۷ روزه'); state.tf=7; document.querySelectorAll('.tf').forEach(b=>{ const on=b.dataset.d==='7'; b.classList.toggle('active',on); b.setAttribute('aria-pressed', on?'true':'false'); }); return loadAndDrawChart(); } }
    const d=state.chartCache[key]; prices=d.map(x=>x[1]); times=d.map(x=>x[0]);
  }
  drawMain(prices,times); drawRSI(prices); drawMACD(prices);
}

function setupCanvas(cv,h){ const dpr=window.devicePixelRatio||1; const W=cv.clientWidth; cv.width=W*dpr; cv.height=h*dpr; const ctx=cv.getContext('2d'); ctx.scale(dpr,dpr); return {ctx,W,H:h}; }
function drawGrid(ctx,W,H,pad,mn,mx,fmt,lines=4){ ctx.strokeStyle='rgba(255,255,255,.06)'; ctx.fillStyle='#8a94ad'; ctx.font='10px Vazirmatn'; ctx.textAlign='right'; for(let i=0;i<=lines;i++){ const y=pad.t+(H-pad.t-pad.b)*i/lines; ctx.beginPath(); ctx.moveTo(pad.l,y); ctx.lineTo(W-pad.r,y); ctx.stroke(); ctx.fillText(fmt(mx-(mx-mn)*i/lines), W-4, y+3); } }

let mainMeta=null;
function drawMain(prices,times){
  const cv=$('#mainChart'); const {ctx,W,H}=setupCanvas(cv,320); const pad={t:14,b:22,l:6,r:64};
  const a=state.modalCoin.a; const n=prices.length;
  const sma20=SMA(prices,20), sma50=SMA(prices,50), bb=BB(prices,20,2);
  const showPred=$('#ovPred').checked; const fut=showPred?Math.round(n*0.18):0;
  const sp=$('#ovShort').checked&&state.tf===7&&a.plans?.short?.valid?a.plans.short:null;
  const lastP=prices[n-1];
  let all=[...prices]; if($('#ovBB').checked) all=all.concat(bb.up.filter(v=>v!=null),bb.lo.filter(v=>v!=null));
  if(showPred) all.push(lastP*(1+a.predHi/100),lastP*(1+a.predLo/100));
  if(sp) all.push(sp.entry,sp.stop,sp.tp1,sp.tp2);
  let mn=Math.min(...all), mx=Math.max(...all); const pd=(mx-mn)*0.05; mn-=pd; mx+=pd;
  const X=i=>pad.l+(W-pad.l-pad.r)*i/(n-1+fut), Y=v=>pad.t+(H-pad.t-pad.b)*(1-(v-mn)/(mx-mn));
  drawGrid(ctx,W,H,pad,mn,mx,v=>fmtP(v).replace('$',''));
  ctx.textAlign='center'; ctx.fillStyle='#8a94ad'; ctx.font='10px Vazirmatn';
  for(let k=0;k<=4;k++){ const i=Math.round((n-1)*k/4); const d=new Date(times[i]); ctx.fillText(state.tf>7?d.toLocaleDateString('fa-IR',{month:'short',day:'numeric'}):d.toLocaleDateString('fa-IR',{weekday:'short'})+' '+d.getHours()+':00', X(i), H-6); }
  const line=(arr,color,w=1.3,dash=[])=>{ ctx.beginPath(); ctx.setLineDash(dash); let st=false; arr.forEach((v,i)=>{ if(v==null){st=false;return;} st?ctx.lineTo(X(i),Y(v)):ctx.moveTo(X(i),Y(v)); st=true; }); ctx.strokeStyle=color; ctx.lineWidth=w; ctx.stroke(); ctx.setLineDash([]); };
  if($('#ovBB').checked){ ctx.beginPath(); let s=false; bb.up.forEach((v,i)=>{ if(v==null) return; s?ctx.lineTo(X(i),Y(v)):ctx.moveTo(X(i),Y(v)); s=true; }); for(let i=n-1;i>=0;i--) if(bb.lo[i]!=null) ctx.lineTo(X(i),Y(bb.lo[i])); ctx.closePath(); ctx.fillStyle='rgba(124,92,255,.08)'; ctx.fill(); line(bb.up,'rgba(124,92,255,.5)',1,[4,3]); line(bb.lo,'rgba(124,92,255,.5)',1,[4,3]); }
  const up=prices[n-1]>=prices[0]; const col=up?'#22c55e':'#ef4444';
  ctx.beginPath(); prices.forEach((v,i)=>i?ctx.lineTo(X(i),Y(v)):ctx.moveTo(X(i),Y(v))); ctx.lineTo(X(n-1),H-pad.b); ctx.lineTo(X(0),H-pad.b); ctx.closePath(); const g=ctx.createLinearGradient(0,pad.t,0,H); g.addColorStop(0,col+'44'); g.addColorStop(1,col+'00'); ctx.fillStyle=g; ctx.fill();
  line(prices,col,2);
  if($('#ovSma20').checked) line(sma20,'#fbbf24',1.3);
  if($('#ovSma50').checked) line(sma50,'#00d4ff',1.3);
  // حمایت/مقاومت — برای تایم‌فریم ۷ روزه از تحلیل اصلی، برای بلندمدت از سقف/کف همان بازه
  let sup, res, supLabel, resLabel;
  if(state.tf===7){ sup=a.support; res=a.resist; supLabel='حمایت ۷روزه'; resLabel='مقاومت ۷روزه'; }
  else { sup=Math.min(...prices); res=Math.max(...prices); supLabel=`کف ${state.tf} روزه`; resLabel=`سقف ${state.tf} روزه`; }
  ctx.setLineDash([6,4]); ctx.lineWidth=1; ctx.strokeStyle='rgba(34,197,94,.6)'; ctx.beginPath(); ctx.moveTo(pad.l,Y(sup)); ctx.lineTo(W-pad.r,Y(sup)); ctx.stroke(); ctx.strokeStyle='rgba(239,68,68,.6)'; ctx.beginPath(); ctx.moveTo(pad.l,Y(res)); ctx.lineTo(W-pad.r,Y(res)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle='rgba(34,197,94,.9)'; ctx.font='10px Vazirmatn'; ctx.textAlign='left'; ctx.fillText(supLabel,pad.l+4,Y(sup)-3); ctx.fillStyle='rgba(239,68,68,.9)'; ctx.fillText(resLabel,pad.l+4,Y(res)-3);
  if(showPred&&fut>0){ const x0=X(n-1), x1=X(n-1+fut); const tp=lastP*(1+a.pred/100), hi=lastP*(1+a.predHi/100), lo=lastP*(1+a.predLo/100);
    ctx.beginPath(); ctx.moveTo(x0,Y(lastP)); ctx.lineTo(x1,Y(hi)); ctx.lineTo(x1,Y(lo)); ctx.closePath(); const pg=ctx.createLinearGradient(x0,0,x1,0); pg.addColorStop(0,'rgba(0,212,255,.25)'); pg.addColorStop(1,'rgba(0,212,255,.03)'); ctx.fillStyle=pg; ctx.fill();
    ctx.beginPath(); ctx.moveTo(x0,Y(lastP)); ctx.lineTo(x1,Y(tp)); ctx.strokeStyle='#00d4ff'; ctx.lineWidth=2; ctx.setLineDash([5,4]); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle='#00d4ff'; ctx.textAlign='left'; ctx.fillText('پیش‌بینی ۷ روزه ⟶',x0+6,pad.t+10);
    ctx.fillStyle='rgba(255,255,255,.04)'; ctx.fillRect(x0,pad.t,x1-x0,H-pad.t-pad.b); }
  ctx.font='10px Vazirmatn'; ctx.textAlign='left'; let lx=pad.l+4, ly=H-pad.b-8; const leg=[[col,'قیمت'],['#fbbf24','SMA20'],['#00d4ff','SMA50'],['rgba(124,92,255,.8)','بولینگر']]; leg.forEach(([c,t])=>{ ctx.fillStyle=c; ctx.fillRect(lx,ly-6,10,3); ctx.fillStyle='#8a94ad'; ctx.fillText(t,lx+13,ly); lx+=ctx.measureText(t).width+28; });
  if(sp){
    [[sp.entry,'ورود شورت','#fbbf24'],[sp.stop,'حد ضرر شورت','#fb7185'],[sp.tp1,'هدف ۱ شورت','#00d4ff'],[sp.tp2,'هدف ۲ شورت','#a78bfa']].forEach(([v,label,color])=>{
      ctx.strokeStyle=color;ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo(pad.l,Y(v));ctx.lineTo(W-pad.r,Y(v));ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=color;ctx.textAlign='right';ctx.fillText(label,W-pad.r-6,Y(v)-4);
    });
  }
  mainMeta={prices,times,X,Y,n,sma20,sma50,sup,res};
}
function drawRSI(prices){
  const cv=$('#rsiChart'); const {ctx,W,H}=setupCanvas(cv,90); const pad={t:8,b:8,l:6,r:64}; const r=RSI(prices,14); const n=prices.length;
  const X=i=>pad.l+(W-pad.l-pad.r)*i/(n-1), Y=v=>pad.t+(H-pad.t-pad.b)*(1-v/100);
  ctx.fillStyle='rgba(239,68,68,.08)'; ctx.fillRect(pad.l,Y(100),W-pad.l-pad.r,Y(70)-Y(100)); ctx.fillStyle='rgba(34,197,94,.08)'; ctx.fillRect(pad.l,Y(30),W-pad.l-pad.r,Y(0)-Y(30));
  ctx.strokeStyle='rgba(255,255,255,.08)'; ctx.setLineDash([3,3]); [30,50,70].forEach(v=>{ ctx.beginPath(); ctx.moveTo(pad.l,Y(v)); ctx.lineTo(W-pad.r,Y(v)); ctx.stroke(); }); ctx.setLineDash([]);
  ctx.fillStyle='#8a94ad'; ctx.font='10px Vazirmatn'; ctx.textAlign='right'; [30,50,70].forEach(v=>ctx.fillText(v,W-6,Y(v)+3));
  ctx.beginPath(); let s=false; r.forEach((v,i)=>{ if(v==null) return; s?ctx.lineTo(X(i),Y(v)):ctx.moveTo(X(i),Y(v)); s=true; }); ctx.strokeStyle='#c084fc'; ctx.lineWidth=1.6; ctx.stroke();
  ctx.textAlign='left'; ctx.fillStyle='#c084fc'; ctx.fillText('RSI (14): '+(last(r)?.toFixed(1)??'—'),pad.l+4,pad.t+10);
}
function drawMACD(prices){
  const cv=$('#macdChart'); const {ctx,W,H}=setupCanvas(cv,90); const pad={t:8,b:8,l:6,r:64}; const {macd,signal,hist}=MACD(prices); const n=prices.length;
  const vals=[...macd,...signal,...hist].filter(v=>v!=null); if(!vals.length) return; const mx=Math.max(...vals.map(Math.abs))*1.1||1;
  const X=i=>pad.l+(W-pad.l-pad.r)*i/(n-1), Y=v=>pad.t+(H-pad.t-pad.b)*(1-(v+mx)/(2*mx));
  ctx.strokeStyle='rgba(255,255,255,.1)'; ctx.beginPath(); ctx.moveTo(pad.l,Y(0)); ctx.lineTo(W-pad.r,Y(0)); ctx.stroke();
  const bw=Math.max(1,(W-pad.l-pad.r)/n-1); hist.forEach((v,i)=>{ if(v==null) return; ctx.fillStyle=v>=0?(hist[i-1]!=null&&v>=hist[i-1]?'#22c55e':'#22c55e88'):(hist[i-1]!=null&&v<=hist[i-1]?'#ef4444':'#ef444488'); ctx.fillRect(X(i)-bw/2,Math.min(Y(0),Y(v)),bw,Math.abs(Y(v)-Y(0))); });
  const line=(arr,c)=>{ ctx.beginPath(); let s=false; arr.forEach((v,i)=>{ if(v==null) return; s?ctx.lineTo(X(i),Y(v)):ctx.moveTo(X(i),Y(v)); s=true; }); ctx.strokeStyle=c; ctx.lineWidth=1.4; ctx.stroke(); };
  line(macd,'#00d4ff'); line(signal,'#fbbf24');
  ctx.font='10px Vazirmatn'; ctx.textAlign='left'; ctx.fillStyle='#00d4ff'; ctx.fillText('MACD (12,26,9)',pad.l+4,pad.t+10); ctx.fillStyle='#fbbf24'; ctx.fillText('Signal',pad.l+90,pad.t+10);
}

$('#mainChart').addEventListener('mousemove',e=>{ if(!mainMeta) return; const rect=e.target.getBoundingClientRect(); const x=e.clientX-rect.left; const {prices,times,X,n,sma20,sma50}=mainMeta; let best=0,bd=1e9; for(let i=0;i<n;i++){ const d=Math.abs(X(i)-x); if(d<bd){bd=d;best=i;} } if(bd>30){ $('#tip').style.display='none'; return; }
  const t=$('#tip'); t.style.display='block'; const d=new Date(times[best]); t.innerHTML=`<b>${fmtP(prices[best])}</b><br>${d.toLocaleDateString('fa-IR')} ${d.getHours()}:00${sma20[best]?'<br>SMA20: '+fmtP(sma20[best]):''}${sma50[best]?'<br>SMA50: '+fmtP(sma50[best]):''}`; const tx=Math.min(x+12,rect.width-160); t.style.left=tx+'px'; t.style.top=(e.clientY-rect.top-10)+'px'; });
$('#mainChart').addEventListener('mouseleave',()=>$('#tip').style.display='none');

/* =====================================================================
   رتبه‌بندی بهترین رمزارزها برای خرید + اعلام بهترین قیمت خرید
   ===================================================================== */
function bestList(n=25){
  let l=[...state.coins]
    .filter(c=>c.a.ok && tradable(c) && c.market_cap>2e7 && c.total_volume>1e6);
  if(gate.onlyApproved) l=l.filter(c=>gatePermit(c,'open'));
  return l
    .sort((x,y)=> gateRank(x)-gateRank(y) || y.a.buyScore-x.a.buyScore || y.a.score-x.a.score)
    .slice(0,n);
}

function renderBest(){
  renderTradeStrip();
  const l=bestList(25);
  const cardsEl=$('#bestCards'), tblWrap=$('#bestTblWrap');
  if(!l.length){
    if(gate.onlyApproved){
      cardsEl.innerHTML='<div class="empty" style="grid-column:1/-1;padding:28px">🚦 در حال حاضر هیچ ارزی از دروازه‌ی رژیم عبور نکرده است — یعنی شرایط بازار برای ورود تازه مناسب نیست. حالت دروازه را روی «خاموش» بگذارید یا منتظر بهبود رژیم بمانید.</div>';
      tblWrap.innerHTML='';
    } else {
      cardsEl.innerHTML='<div class="empty" style="grid-column:1/-1;padding:28px">داده‌ای برای رتبه‌بندی وجود ندارد — در حال واکشی…</div>';
      tblWrap.innerHTML='';
    }
    return;
  }
  const medals=['🥇','🥈','🥉'];
  cardsEl.innerHTML=l.slice(0,3).map((c,i)=>{
    const a=c.a, C=CATS[a.cat];
    return `<div class="bcard" style="animation-delay:${i*70}ms" data-action="open" data-id="${esc(c.id)}" role="button" tabindex="0" aria-label="نمایش تحلیل ${esc(c.name)}">
      <div class="medal" aria-hidden="true">${medals[i]}</div>
      <div class="bh" style="padding-inline-start:44px">
        <img src="${safeImg(c.image)}" alt="" loading="lazy">
        <div><b>${esc(c.name)}</b><span>${esc(c.symbol.toUpperCase())} • رتبه #${esc(c.market_cap_rank)} • ${fmtBig(c.market_cap)}</span></div>
        <div class="bscore">امتیاز خرید<b>${a.buyScore}</b><span class="gr" style="background:${a.gradeC}22;color:${a.gradeC}">${esc(a.grade)}</span></div>
      </div>
      <div class="entry">
        <div class="lbl">💰 بهترین قیمت خرید (نقطه ورود بهینه — هرگز بالاتر از قیمت فعلی)</div>
        <div class="big">${fmtP(a.entry)}</div>
        <div class="zone">محدوده مطمئن: ${fmtP(a.entryLo)} تا ${fmtP(a.entryHi)} • قیمت فعلی ${fmtP(c.current_price)} (${pct(a.entryGap,2)} فاصله) • ${a.entryGap<0?`${Math.abs(a.entryGap).toFixed(1)}٪ زیر قیمت فعلی — نیاز به اصلاح`:''}</div>
        <div style="margin-top:7px;display:flex;gap:6px;flex-wrap:wrap;align-items:center"><span class="stbadge st-${a.buyState}">${a.buyState==='now'?'🟢':a.buyState==='below'?'🔵':a.buyState==='wait'?'🟡':'⚪'} ${esc(a.buyStateTxt)}</span>${gateBadge(a.gate)}</div>
      </div>
      <div class="lad">${a.ladder.map(s2=>`<div>${s2.t} (${s2.w}٪)<b>${fmtP(s2.p)}</b></div>`).join('')}</div>
      <div class="tri">
        <div class="sl">حد ضرر<b>${fmtP(a.stop)}</b></div>
        <div class="t1">هدف ۱<b>${fmtP(a.tp1)}</b></div>
        <div class="t2">هدف ۲<b>${fmtP(a.tp2)}</b></div>
        <div class="rr">ریسک/بازده<b>${a.rr.toFixed(1)}:1</b></div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:9px;font-size:.73rem;color:var(--muted);flex-wrap:wrap;gap:4px">
        <span class="cat" style="--catc:${C.c};font-size:.7rem">${C.icon} ${C.label}</span>
        <span>پیش‌بینی ۷روزه: <b class="${cls(a.pred)}">${pct(a.pred,1)}</b></span>
        <span title="ATR چهارساعته (نوسان واقعی) و تأیید حجم — وقتی فعال باشد، حد ضرر و اهداف بر پایه‌ی نوسان واقعی‌اند">${a.atr!=null?`ATR: <b>${a.atr.toFixed(1)}٪</b>${a.volZ!=null?` • حجم: <b class="${a.volZ>=1?'up':a.volZ<=-0.5?'down':''}">${a.volZ>=0?'+':''}${a.volZ.toFixed(1)}σ</b>`:''}`:'<span style="opacity:.7">داده‌ی پایه</span>'}</span>
        <span title="قدرت نسبی ۷ روزه در برابر بیت‌کوین — مثبت یعنی مقاوم‌تر از BTC">RS/BTC: <b class="${cls(a.rs7)} rs">${pct(a.rs7,1)}</b></span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:5px;font-size:.71rem;color:var(--muted);flex-wrap:wrap;gap:4px">
        <span title="نسبت ریسک/بازده اگر همین حالا با قیمت بازار وارد شوید">R/R فعلی: <b style="color:${a.rrNow>=1.5?'var(--up)':a.rrNow>=1?'var(--pot)':'var(--down)'}">${a.rrNow.toFixed(1)}:1</b> ${a.rrNow<1?'⚠️ صبر کنید':''}</span>
        <span>ریسک تا حد ضرر: <b class="down">−${a.riskPct.toFixed(1)}٪</b></span>
        <span>نوسان: ${esc(a.risk)}</span>
      </div>
    </div>`;
  }).join('');

  tblWrap.innerHTML=`<div class="tbl-wrap" style="max-height:520px;overflow:auto"><table class="btbl">
    <thead><tr><th>رتبه</th><th>ارز</th><th>امتیاز خرید</th><th>درجه</th><th>قیمت فعلی</th><th>💰 بهترین قیمت خرید</th><th>محدوده خرید</th><th>فاصله</th><th>وضعیت</th><th title="دروازه‌ی رژیم: مجاز / انتخابی / مسدود / مستثنا">دروازه</th><th>حد ضرر</th><th>هدف ۱</th><th title="ریسک/بازده از نقطه ورود پلکانی">R/R</th><th title="ریسک/بازده اگر همین حالا با قیمت بازار بخرید">R/R فعلی</th><th title="قدرت نسبی ۷ روزه در برابر بیت‌کوین">RS/BTC</th><th>پیش‌بینی ۷روزه</th><th>طبقه</th></tr></thead><tbody>
    ${l.map((c,i)=>{const a=c.a,C=CATS[a.cat];const gcls=a.gate&&!a.gate.exempt?(a.gate.state==='open'?'g-open':a.gate.state==='blocked'?'g-blocked':''):'';return `<tr class="${gcls}" data-action="open" data-id="${esc(c.id)}" tabindex="0" aria-label="نمایش تحلیل ${esc(c.name)}">
      <td><b>${i+1}</b></td>
      <td><img src="${safeImg(c.image)}" alt="" loading="lazy"><b>${esc(c.name)}</b> <small style="color:var(--muted)">${esc(c.symbol.toUpperCase())}</small></td>
      <td><b style="color:${a.gradeC}">${a.buyScore}</b></td>
      <td><span class="gr" style="background:${a.gradeC}22;color:${a.gradeC}">${esc(a.grade)}</span></td>
      <td>${fmtP(c.current_price)}</td>
      <td><b style="color:var(--sbuy)">${fmtP(a.entry)}</b></td>
      <td style="color:var(--muted);font-size:.75rem">${fmtP(a.entryLo)} – ${fmtP(a.entryHi)}</td>
      <td class="${a.entryGap>=0?'up':'down'}">${pct(a.entryGap,2)}</td>
      <td><span class="stbadge st-${a.buyState}">${esc(a.buyStateTxt)}</span></td>
      <td>${gateBadge(a.gate)}</td>
      <td class="down">${fmtP(a.stop)}</td>
      <td class="up">${fmtP(a.tp1)}</td>
      <td>${a.rr.toFixed(1)}</td>
      <td style="color:${a.rrNow>=1.5?'var(--up)':a.rrNow>=1?'var(--pot)':'var(--down)'}">${a.rrNow.toFixed(1)}</td>
      <td class="${cls(a.rs7)} rs">${pct(a.rs7,1)}</td>
      <td class="${cls(a.pred)}">${pct(a.pred,1)}</td>
      <td><span class="cat" style="--catc:${C.c};font-size:.68rem">${C.label}</span></td>
    </tr>`}).join('')}
  </tbody></table></div>`;
}

/* =====================================================================
   موتور پایش مداوم — بهبود پیام‌ها و هماهنگی با دروازه
   ===================================================================== */
const mon = {
  on:true, iv:90, sound:false, notif:false, filter:'buy',
  cycles:0, left:90, prev:{},
  alerts: (()=>{try{return JSON.parse(localStorage.getItem(LS_KEYS.alerts)||'[]')}catch(e){return []}})(),
  backoff:1, prevRegime:null, prevGate:null
};
try{
  const m=JSON.parse(localStorage.getItem(LS_KEYS.mon)||'{}');
  if(typeof m.on==='boolean') mon.on=m.on;
  if([30,60,90,180,300].includes(m.iv)) mon.iv=m.iv;
  if(typeof m.sound==='boolean') mon.sound=m.sound;
  if(typeof m.notif==='boolean') mon.notif=m.notif;
  // 'short' is a valid saved filter too; omitting it silently reset the user's choice on reload.
  if(['all','buy','watch','short'].includes(m.filter)) mon.filter=m.filter;
  mon.left=mon.iv;
}catch(e){}
function monSave(){ try{ localStorage.setItem(LS_KEYS.mon, JSON.stringify({on:mon.on, iv:mon.iv, sound:mon.sound, notif:mon.notif, filter:mon.filter})); }catch(e){} }

function beep(){ if(!mon.sound) return; try{ const ac=new (window.AudioContext||window.webkitAudioContext)(); const o=ac.createOscillator(), g=ac.createGain();
  o.type='sine'; o.frequency.value=880; g.gain.setValueAtTime(.001,ac.currentTime); g.gain.exponentialRampToValueAtTime(.18,ac.currentTime+.02); g.gain.exponentialRampToValueAtTime(.001,ac.currentTime+.35);
  o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime+.36);}catch(e){} }

function notify(title,body){ if(!mon.notif) return; try{ if(Notification.permission==='granted') new Notification(title,{body}); }catch(e){} }

function pushAlert(c,kind,text,color,important){
  const a={id:c.id,sym:c.symbol.toUpperCase(),name:c.name,img:c.image,kind,text,color,t:Date.now()};
  mon.alerts.unshift(a);
  if(mon.alerts.length>120) mon.alerts.length=120;
  if(important&&alertVisible(a)){ beep(); notify(`${a.sym} — ${text}`, kind==='short'?`شورت آزمایشی • قیمت ${fmtP(c.current_price)} • بدون اجرای سفارش`:`قیمت ${fmtP(c.current_price)} • بهترین خرید ${fmtP(c.a.entry)} • ${c.a.gate?GATE_STATES[c.a.gate.state].label:''}`); }
}

function detectEvents(){
  if(!shortFresh())return;
  const isFirst = Object.keys(mon.prev).length===0;
  let fresh=0;
  const gOff   = gate.mode==='off';
  const gMacro = state.gate ? state.gate.macro : null;
  state.coins.forEach(c=>{
    if(!shortCoinFresh(c))return;
    const a=c.a, pv=mon.prev[c.id];
    if(pv && a.ok){
      const watched=state.watch.includes(c.id);
      const pass = k => mon.filter==='all' || (mon.filter==='watch'? watched : (k==='buy'||k==='sig'));
      const allowed = gatePermit(c,'any')&&!shorts.records.some(r=>r.id===c.id&&r.status==='active');
      const halfOpen = !gOff && gMacro==='closed';

      if(pv.buyState!=='now' && a.buyState==='now' && pass('buy')){
        if(allowed){
          pushAlert(c,'buy',`${halfOpen?'⚠️ دروازه بسته — فقط پله‌ی کوچک: ':''}وارد محدوده خرید شد — بهترین قیمت ${fmtP(a.entry)} (فاصله ${pct(a.entryGap,1)})`,
                    halfOpen?'#fbbf24':'#00e676', !halfOpen); fresh++;
        } else {
          pushAlert(c,'risk',`🛑 دروازه‌ی رژیم اجازه ورود نداد — ${(a.gate&&a.gate.reasons[0])||'شرط ورود برقرار نیست'}`, '#ef4444', watched); fresh++;
        }
      }
      if(pv.cat!=='sbuy' && a.cat==='sbuy' && pass('buy') && allowed){
        pushAlert(c,'buy',`ارتقا به «خرید قوی» (امتیاز تکنیکال ${a.score} • خرید ${a.buyScore})${halfOpen?' — دروازه بسته است':''}`, halfOpen?'#fbbf24':'#00e676', !halfOpen); fresh++;
      }
      if(pv.buyScore<74 && a.buyScore>=74 && pass('buy') && allowed){
        pushAlert(c,'buy',`امتیاز فرصت خرید به ${a.buyScore} (${esc(a.grade)}) رسید — ${a.buyStateTxt}${halfOpen?' — دروازه بسته':''}`, '#4ade80', !halfOpen); fresh++;
      }
      if(pv.macdCross!=='bull' && a.macdCross==='bull' && pass('sig')){
        pushAlert(c,'sig','کراس صعودی MACD ✨ — مومنتوم برگشتی', '#4ade80', false); fresh++;
      }
      if(pv.cross!=='golden' && a.cross==='golden' && pass('sig')){
        pushAlert(c,'sig','تقاطع طلایی SMA20/50 🌟 — ساختار صعودی تأیید شد', '#00e676', true); fresh++;
      }
      if(pv.rsi>=30 && a.rsi<30 && pass('sig')){
        pushAlert(c,'sig',`RSI وارد اشباع فروش شد (${a.rsi.toFixed(0)}) — پتانسیل بازگشت`, '#00d4ff', false); fresh++;
      }
      if(mon.filter!=='buy' || watched){
        if(pv.cat!=='ssell' && a.cat==='ssell'){ pushAlert(c,'risk','سقوط به «فروش قوی» ⛔ — خروج / اجتناب', '#ef4444', watched); fresh++; }
        if(pv.rsi<=70 && a.rsi>70){ pushAlert(c,'risk',`RSI وارد اشباع خرید شد (${a.rsi.toFixed(0)}) — ریسک اصلاح`, '#fb7185', false); fresh++; }
        const mv=(c.current_price/pv.price-1)*100;
        if(Math.abs(mv)>=3){ pushAlert(c,mv>0?'sig':'risk',`جهش قیمتی ${pct(mv,1)} در یک چرخه — ${mv>0?'قدرت خریداران':'فشار فروش'}`, mv>0?'#22c55e':'#ef4444', watched); fresh++; }
      }
      /* رویدادهای «تایپ‌شده»ی لایه‌ی غنی‌شده — فقط وقتی داده‌ی معتبر موجود باشد.
         این‌ها همان قواعدی هستند که در امتیاز اثر می‌گذارند، ولی اینجا صریح و
         قابل‌ردیابی گزارش می‌شوند تا کاربر بداند «چرا» هشدار آمد. */
      if(a.mdQuality!=='base' || pv.volZ!=null){
        if(a.brk24 && a.brk24.state==='up' && pv.brk24!=='up' && pass('sig')){
          const strong = a.volZ!=null && a.volZ>=1;
          pushAlert(c, strong?'buy':'sig', strong
            ? `شکست سقف ۲۴ ساعته با تأیید حجم (${a.volRatioH!=null?a.volRatioH.toFixed(1)+'× میانگین':'حجم بالای میانگین'}) — سطح ${fmtP(a.brk24.high)}`
            : `شکست سقف ۲۴ ساعته بدون تأیید حجم — ریسک شکست جعلی`, strong?'#00e676':'#fbbf24', strong&&watched);
          fresh++;
        }
        if(a.brk24 && a.brk24.state==='down' && pv.brk24!=='down' && pass('sig')){
          pushAlert(c,'risk',`شکست کف ۲۴ ساعته${a.volZ!=null&&a.volZ>=1?' با حجم بالا':''} — ساختار تکنیکال ضعیف شد`, '#ef4444', watched); fresh++;
        }
        if(pv.volZ!=null && a.volZ!=null && a.volZ>=2.5 && pv.volZ<2.5 && pass('sig')){
          const up=c.a.ch24>=0;
          pushAlert(c, up?'sig':'risk', `جهش حجم (${a.volZ.toFixed(1)}σ بالای میانگین) در جهت ${up?'صعود':'نزول'}${a.cmf!=null?` — ${a.cmf>0.1?'جریان پول ورودی':a.cmf<-0.1?'جریان پول خروجی':'جریان پول بی‌طرف'}`:''}`, up?'#4ade80':'#fb7185', watched); fresh++;
        }
        const crowdKey = a.crowd ? a.crowd.side+':'+a.crowd.level : null;
        if(a.crowd && a.crowd.level==='hot' && pv.crowd!==crowdKey && pass('sig')){
          pushAlert(c,'risk',`⚠️ ${a.crowd.reason} — ورود تازه در اوج اهرم توصیه نمی‌شود`, '#fbbf24', watched); fresh++;
        }
        if(a.fundingAnnual!=null && Math.abs(a.fundingAnnual)>=CROWD.fundingHot && (pv.fundingAnnual==null || Math.abs(pv.fundingAnnual)<CROWD.fundingHot) && pass('sig')){
          pushAlert(c,'risk',`فاندینگ سالانه به ${pct(a.fundingAnnual,1)} رسید — ${a.fundingAnnual>0?'ازدحام سمت خرید':'ازدحام سمت فروش (ریسک اسکوییز)'}`, '#fbbf24', watched); fresh++;
        }
      }
      if(watched){
        if(pv.price<a.tp1 && c.current_price>=a.tp1){ pushAlert(c,'sig',`به هدف اول رسید (${fmtP(a.tp1)}) 🎯 — ذخیره سود را بررسی کنید`, '#00e676', true); fresh++; }
        if(pv.price>a.stop && c.current_price<=a.stop){ pushAlert(c,'risk',`زیر حد ضرر بسته شد (${fmtP(a.stop)}) ⚠️ — مدیریت ریسک`, '#ef4444', true); fresh++; }
      }
    }
    mon.prev[c.id]={cat:a.cat,score:a.score,buyScore:a.buyScore,buyState:a.buyState,rsi:a.rsi,cross:a.cross,macdCross:a.macdCross,price:c.current_price,tp1:a.tp1,stop:a.stop,
      volZ:a.volZ??null, brk24:a.brk24?a.brk24.state:null, crowd:a.crowd?a.crowd.side+':'+a.crowd.level:null, fundingAnnual:a.fundingAnnual??null};
  });
  if(state.regime && mon.prevRegime && mon.prevRegime!==state.regime.k){
    const R=state.regime, btc=state.coins.find(c=>c.id==='bitcoin');
    if(btc){ pushAlert(btc,R.k==='riskoff'?'risk':'sig',`تغییر رژیم بازار به «${R.label}» ${R.icon} — ${R.hint}`, R.c, true); fresh++; }
  }
  if(state.regime) mon.prevRegime=state.regime.k;
  if(state.gate && mon.prevGate && mon.prevGate!==state.gate.state){
    const S=GATE_STATES[state.gate.state], btc=state.coins.find(c=>c.id==='bitcoin');
    const verb = state.gate.state==='open' ? 'باز شد — ورود تازه مجاز است ✅'
               : state.gate.state==='watch' ? 'انتخابی شد — فقط سِتاپ‌های تأییدشده 🟡'
               : state.gate.state==='blocked' ? 'بسته شد — ورود تازه توصیه نمی‌شود 🛑'
               : 'تغییر کرد';
    if(btc){ pushAlert(btc, state.gate.state==='blocked'?'risk':'sig', `🚦 دروازه‌ی رژیم ${verb} ${S.icon} — ${S.label}`, S.c, true); fresh++; }
  }
  if(state.gate) mon.prevGate=state.gate.state;
  if(isFirst){
    const top=bestList(25).filter(c=>shortCoinFresh(c)&&gatePermit(c,'open')&&!shorts.records.some(r=>r.id===c.id&&r.status==='active')).slice(0,3);
    top.forEach(c=>pushAlert(c,'buy',`شروع پایش — بهترین قیمت خرید ${fmtP(c.a.entry)} (امتیاز ${c.a.buyScore} • ${c.a.buyStateTxt})`, '#7c5cff', false));
  }
  try{ localStorage.setItem(LS_KEYS.alerts, JSON.stringify(mon.alerts.slice(0,60))); }catch(e){}
  renderAlerts();
  if(fresh) toast(`🔔 ${fresh} رویداد تازه در پایش مداوم ثبت شد`);
}

function alertVisible(a){
  if(mon.filter==='all') return true;
  if(mon.filter==='watch') return state.watch.includes(a.id);
  if(mon.filter==='short') return a.kind==='short';
  return a.kind==='buy' || a.kind==='sig';
}

function renderAlerts(){
  const box=$('#alerts');
  const list=mon.alerts.filter(alertVisible);
  if(!list.length){ box.innerHTML=`<div class="empty" style="padding:24px;font-size:.8rem">رویدادی مطابق فیلتر «${mon.filter==='all'?'همه':mon.filter==='short'?'شورت':'فقط فرصت‌های خرید'}» ثبت نشده است.<br>فیلتر را تغییر دهید یا منتظر چرخه بعدی باشید.</div>`; $('#alCount').textContent=''; return; }
  $('#alCount').textContent=`(${list.length} رویداد — فیلتر: ${mon.filter==='all'?'همه':mon.filter==='short'?'شورت':'خرید/سیگنال'})`;
  box.innerHTML=list.slice(0,60).map(a=>`<div class="al" style="--alc:${a.color}" data-action="open" data-id="${esc(a.id)}" role="button" tabindex="0" aria-label="${esc(a.sym)} ${esc(a.text)}">
    <img src="${safeImg(a.img)}" alt="" loading="lazy"><div class="t"><b>${esc(a.sym)}</b> — ${esc(a.text)}</div><span class="tm">${faTime(a.t)}</span></div>`).join('');
}

function tick(){
  if(state.shortFreshDisplayed!==shortFreshKey()){updateShortPlans();renderShorts();refreshModal();}
  if(!mon.on) return;
  mon.left--;
  $('#cd').textContent=mon.left>0? mon.left+'s' : '…';
  if(mon.left<=0){ mon.left=mon.iv; loadAll(false); }
}

/* یک قدم غنی‌سازی در هر چرخه + تازه‌سازی مشتقات (هر دو با بودجه‌ی نرخ‌محدود).
   خطا هرگز چرخه‌ی اصلی را نمی‌شکند: لایه‌ی غنی‌شده «تلاش بهترین» است. */
let mdBusy=false;
async function enrichCycle(){
  if(mdBusy) return;                       // یک لایه‌ی داده در هر لحظه کافی است
  mdBusy=true;
  try{
    let derivFresh=false;
    try{ derivFresh=await refreshDerivatives(); }catch(e){}
    if(derivFresh) applyMarketContext();                    // امتیاز ازدحام تازه شود
    let got=0;
    try{ got=await runEnrichment(); }catch(e){}
    updateMdStatus();
    if(got){ renderAll(); toast(`⚡ داده‌ی غنی‌شده‌ی ${got} ارز بروزرسانی شد (ATR واقعی و تأیید حجم فعال شد)`); }
  }catch(e){ /* لایه‌ی داده هرگز نباید چرخه‌ی اصلی را بشکند */ }
  finally{ mdBusy=false; }
}
function updateMdStatus(){
  const el=$('#mdStatus'); if(!el) return;
  el.textContent=mdStatusText();
  el.title=mdStatusText();
}
function afterCycle(){
  mon.cycles++;
  shortCycle();
  try{ perfCycle(); }catch(e){ console.warn('perf',e); }
  $('#cycles').textContent=mon.cycles.toLocaleString('fa-IR');
  $('#lastChk').textContent=faTime(Date.now());
  $('#monHint').textContent=`هر ${mon.iv} ثانیه یک بار کل بازار واکشی، تحلیل و با چرخه قبل مقایسه می‌شود • ${mon.cycles} چرخه انجام شده • دروازه: ${state.gate?GATE_STATES[state.gate.state].label:'—'}`;
  detectEvents();
  enrichCycle();
}

function setMon(on){
  mon.on=on; $('#swMon').classList.toggle('on',on); $('#swMon').setAttribute('aria-checked', on?'true':'false');
  $('#monPill').classList.toggle('off',!on);
  $('#cd').textContent = on? mon.left+'s' : 'خاموش';
  if(on){ mon.left=mon.iv; }
  monSave();
}

/* کنترل‌های پایش */
$('#swMon').onclick=()=>{ setMon(!mon.on); toast(mon.on?'▶️ پایش مداوم فعال شد':'⏸️ پایش مداوم متوقف شد'); };
$('#swMon').onkeydown=e=>{ if(e.key==='Enter'||e.key===' ') { e.preventDefault(); $('#swMon').click(); } };
$('#ivSel').onchange=e=>{ mon.iv=+e.target.value; mon.left=mon.iv; monSave(); $('#monHint').textContent=`هر ${mon.iv} ثانیه یک بار کل بازار واکشی و تحلیل می‌شود`; toast(`⏱️ فاصله بررسی روی ${mon.iv} ثانیه تنظیم شد`); };
/* بودجه‌ی لایه‌ی داده: هر ارز دو فراخوان دارد؛ کاربر با این کنترل تعیین می‌کند
   چند ارز در ساعت غنی شود. حذف/افزودن داده هرگز روی موتور اصلی اثر مخرب ندارد. */
$('#mdProfile').onchange=e=>{
  if(typeof MarketData!=='undefined') MarketData.setProfile(e.target.value);
  updateMdStatus();
  toast(`⚡ بودجه‌ی داده روی «${e.target.selectedOptions[0]?.textContent?.trim()||''}» تنظیم شد`);
};
$('#swSound').onclick=()=>{ mon.sound=!mon.sound; $('#swSound').classList.toggle('on',mon.sound); $('#swSound').setAttribute('aria-checked', mon.sound?'true':'false'); monSave(); if(mon.sound) beep(); toast(mon.sound?'🔊 هشدار صوتی فعال شد':'🔇 هشدار صوتی خاموش شد'); };
$('#swSound').onkeydown=e=>{ if(e.key==='Enter'||e.key===' ') { e.preventDefault(); $('#swSound').click(); } };
$('#swNotif').onclick=async()=>{ if(!mon.notif){ try{ const p2=await Notification.requestPermission(); mon.notif=(p2==='granted'); if(!mon.notif) toast('⚠️ اجازه اعلان داده نشد'); else toast('🔔 اعلان مرورگر فعال شد'); }catch(e){ toast('⚠️ مرورگر از اعلان پشتیبانی نمی‌کند'); } } else { mon.notif=false; toast('🔕 اعلان مرورگر خاموش شد'); } $('#swNotif').classList.toggle('on',mon.notif); $('#swNotif').setAttribute('aria-checked', mon.notif?'true':'false'); monSave(); };
$('#swNotif').onkeydown=e=>{ if(e.key==='Enter'||e.key===' ') { e.preventDefault(); $('#swNotif').click(); } };
$('#alFilter').onchange=e=>{ mon.filter=e.target.value; monSave(); renderAlerts(); toast('🔎 فیلتر هشدارها بروزرسانی شد'); };
$('#clearAl').onclick=()=>{ mon.alerts=[]; localStorage.removeItem(LS_KEYS.alerts); renderAlerts(); toast('🗑️ تاریخچه هشدارها پاک شد'); };

/* =====================================================================
   کارنامه عملکرد سیگنال‌ها (Track Record) — هماهنگ با دروازه
   ===================================================================== */
const PERF_KEY=LS_KEYS.perf;
const HORIZON_MS=7*24*3600*1000;
const perf = { rec: (()=>{ try{ return JSON.parse(localStorage.getItem(PERF_KEY)||'[]').map(r=>({...r,side:'long',version:r.version||'legacy-long-v1'})); }catch(e){ return []; } })() };
function perfSave(){ try{ localStorage.setItem(PERF_KEY, JSON.stringify(perf.rec.slice(-300))); }catch(e){} }

function perfOpen(c){
  if(!shortFresh()||!shortCoinFresh(c))return;
  if(shorts.records.some(r=>r.id===c.id && r.status==='active')) return;
  const a=c.a;
  if(perf.rec.some(r=>r.id===c.id && r.open)) return;
  if(!(a.tp1>c.current_price*1.004 && a.stop<c.current_price*0.996)) return;
  perf.rec.push({ side:'long', version:'legacy-long-v1', id:c.id, sym:c.symbol.toUpperCase(), name:c.name, img:c.image,
    t0:Date.now(), p0:c.current_price, entry:a.entry, tp1:a.tp1, stop:a.stop,
    score:a.score, buyScore:a.buyScore, grade:a.grade, cat:a.cat, pred:a.pred,
    open:true, peak:c.current_price, trough:c.current_price, last:c.current_price });
}

function perfEvaluate(){
  const now=Date.now(); let closed=0;
  perf.rec.forEach(r=>{
    if(!r.open) return;
    const c=state.coins.find(x=>x.id===r.id);
    if(!c || !shortFresh() || !shortCoinFresh(c) || !Number.isFinite(c.current_price) || c.current_price<=0) return;
    const px=c.current_price;
    r.peak=Math.max(r.peak??px, px); r.trough=Math.min(r.trough??px, px); r.last=px;
    if(px>=r.tp1){ r.open=false; r.result='win';  r.why='برخورد به هدف اول 🎯'; }
    else if(px<=r.stop){ r.open=false; r.result='loss'; r.why='برخورد به حد ضرر 🛑'; }
    else if(now-r.t0>=HORIZON_MS){
      const ret=(px/r.p0-1)*100;
      r.open=false; r.result = ret>1?'win':(ret<-1?'loss':'flat'); r.why='سررسید ۷ روزه ⏰';
    }
    if(!r.open){ r.t1=now; r.ret=(px/r.p0-1)*100; r.mfe=(r.peak/r.p0-1)*100; r.mae=(r.trough/r.p0-1)*100; closed++; }
  });
  if(closed) perfSave();
  return closed;
}

function perfStats(){
  const done=perf.rec.filter(r=>!r.open);
  const win=done.filter(r=>r.result==='win').length;
  const loss=done.filter(r=>r.result==='loss').length;
  const flat=done.filter(r=>r.result==='flat').length;
  const rets=done.map(r=>r.ret||0);
  const avg=rets.length? rets.reduce((a,b)=>a+b,0)/rets.length : 0;
  const decided=win+loss;
  const gains=done.filter(r=>(r.ret||0)>0).reduce((a,b)=>a+b.ret,0);
  const losses=Math.abs(done.filter(r=>(r.ret||0)<0).reduce((a,b)=>a+b.ret,0));
  const wins=done.filter(r=>(r.ret||0)>0).map(r=>r.ret), lss=done.filter(r=>(r.ret||0)<0).map(r=>r.ret);
  const avgWin=wins.length? wins.reduce((a,b)=>a+b,0)/wins.length:0, avgLoss=lss.length? Math.abs(lss.reduce((a,b)=>a+b,0)/lss.length):0;
  const pw=done.length? wins.length/done.length:0;
  const expectancy=done.length? pw*avgWin-(1-pw)*avgLoss : null;
  return {done:done.length, open:perf.rec.filter(r=>r.open).length, win, loss, flat,
    acc: decided? win/decided*100 : null, avg, avgWin, avgLoss, expectancy,
    best: rets.length?Math.max(...rets):0, worst: rets.length?Math.min(...rets):0,
    pf: losses>0? gains/losses : (gains>0?Infinity:0)};
}

function renderPerf(){
  const st=perfStats();
  drawGauge($('#accGauge'), st.acc==null?50:st.acc, ['#ef4444','#fb7185','#fbbf24','#4ade80','#00e676']);
  if(st.acc==null){
    $('#accBig').textContent='—';
    $('#accBig').className='forecast-big';
    $('#accSub').textContent = st.open? `${st.open} سیگنال در جریان — نتیجه پس از هدف/حد ضرر یا ۷ روز (فقط مجازهای دروازه ثبت می‌شوند)` : 'هنوز سیگنالی ثبت نشده — با ورود ارزی به «خرید قوی» یا امتیاز ≥۷۸ و عبور از دروازه، رکورد ثبت می‌شود';
  } else {
    $('#accBig').textContent=st.acc.toFixed(0)+'٪ دقت (برد/برد+باخت)';
    $('#accBig').className='forecast-big '+(st.acc>=55?'up':'down');
    $('#accSub').textContent=`${st.win} برد / ${st.loss} باخت${st.flat?` / ${st.flat} خنثی`:''} از ${st.done} سیگنال بسته‌شده • میانگین ${pct(st.avg,1)} • فاکتور سود ${st.pf===Infinity?'∞':st.pf.toFixed(2)}`;
  }
  const pf = st.pf===Infinity? '∞' : st.pf.toFixed(2);
  $('#perfKv').innerHTML=[['بسته‌شده',st.done],['در جریان',st.open],
    ['میانگین بازده', st.done?pct(st.avg,2):'—'],['بهترین', st.done?pct(st.best,1):'—'],
    ['بدترین', st.done?pct(st.worst,1):'—'],['فاکتور سود', st.done?pf:'—'],
    ['میانگین برد', st.done?pct(st.avgWin,1):'—'],['میانگین باخت', st.done?'−'+st.avgLoss.toFixed(1)+'%':'—'],
    ['امید ریاضی/سیگنال', st.expectancy!=null?pct(st.expectancy,2):'—']]
    .map(([k,v])=>`<div>${esc(k)}<b>${esc(v)}</b></div>`).join('');

  const open=perf.rec.filter(r=>r.open).slice(-25).reverse();
  $('#openCount').textContent=open.length?`(${open.length})`:'';
  $('#openList').innerHTML = open.length? open.map(r=>{
    const cur=r.last??r.p0, ret=(cur/r.p0-1)*100;
    const days=Math.max(0,(HORIZON_MS-(Date.now()-r.t0))/86400000);
    return `<div class="res" style="--rc:${ret>=0?'#22c55e':'#ef4444'}" data-action="open" data-id="${esc(r.id)}" role="button" tabindex="0">
      <img src="${safeImg(r.img)}" alt="" loading="lazy">
      <div class="t"><b>${esc(r.sym)}</b> <span class="mini">ورود ${fmtP(r.p0)} • هدف ${fmtP(r.tp1)} • حد ${fmtP(r.stop)} • ${esc(r.grade||'')}</span></div>
      <span class="pnl ${ret>=0?'up':'down'}">${pct(ret,1)}</span>
      <span class="tm">${days>=1? days.toFixed(0)+' روز':'<۱ روز'}</span></div>`;
  }).join('') : '<div class="empty" style="padding:20px;font-size:.8rem">سیگنال بازی وجود ندارد. با ورود ارزی به «خرید قوی» یا امتیاز خرید ≥۷۸ و عبور از دروازه، رکورد ثبت می‌شود.</div>';

  const closed=perf.rec.filter(r=>!r.open).slice(-30).reverse();
  $('#closedList').innerHTML = closed.length? closed.map(r=>{
    const ic=r.result==='win'?'✅':r.result==='loss'?'❌':'➖';
    const col=r.result==='win'?'#22c55e':r.result==='loss'?'#ef4444':'#94a3b8';
    return `<div class="res" style="--rc:${col}" data-action="open" data-id="${esc(r.id)}" role="button" tabindex="0">
      <img src="${safeImg(r.img)}" alt="" loading="lazy">
      <div class="t"><b>${ic} ${esc(r.sym)}</b> <span class="mini">${esc(r.why||'')} • ${pct(r.ret||0,1)}</span></div>
      <span class="pnl" style="color:${col}">${pct(r.ret||0,1)}</span>
      <span class="tm">${faTime(r.t1||r.t0)}</span></div>`;
  }).join('') : '<div class="empty" style="padding:20px;font-size:.8rem">هنوز نتیجه‌ای نهایی نشده است — پس از ۷ روز یا برخورد به هدف/حد ضرر، اینجا نمایش داده می‌شود.</div>';
}

function perfCycle(){
  if(!shortFresh()){renderPerf();return;}
  perfEvaluate();
  state.coins.forEach(c=>{ if(longCandidate(c)) perfOpen(c); });
  perfSave(); renderPerf();
}

/* =====================================================================
   مقایسه چند ارز کنار هم — بهترین مقدار هر سطر برجسته می‌شود
   ===================================================================== */
function cmpSave(){ try{ localStorage.setItem(LS_KEYS.cmp, JSON.stringify(state.cmp)); }catch(e){} }

function toggleCmp(id){
  const i=state.cmp.indexOf(id);
  if(i>=0) state.cmp.splice(i,1);
  else { if(state.cmp.length>=4){ toast('⚠️ حداکثر ۴ ارز قابل مقایسه است — ابتدا یکی را حذف کنید'); return; } state.cmp.push(id); }
  cmpSave(); renderCmp(); renderList();
  toast(i>=0?'از مقایسه حذف شد':'⚖️ به مقایسه اضافه شد',1500);
}

function renderCmp(){
  const sec=$('#cmpSec');
  const list=state.cmp.map(id=>state.coins.find(c=>c.id===id)).filter(Boolean);
  if(!list.length){ sec.style.display='none'; return; }
  sec.style.display='';
  $('#cmpBar').innerHTML=list.map(c=>`<span class="cmp-chip"><img src="${safeImg(c.image)}" alt="" loading="lazy"><b>${esc(c.symbol.toUpperCase())}</b>
    <button data-action="compare" data-id="${esc(c.id)}" aria-label="حذف ${esc(c.symbol)} از مقایسه">✕</button></span>`).join('')
    + `<span class="cmp-add">${list.length}/۴ ارز انتخاب شده</span>`;

  const rows=[
    ['امتیاز فرصت خرید', c=>c.a.buyScore, true,  c=>c.a.buyScore+' ('+c.a.grade+')'],
    ['امتیاز تکنیکال',   c=>c.a.score,    true,  c=>c.a.score],
    ['قیمت فعلی',        c=>c.current_price, null, c=>fmtP(c.current_price)],
    ['بهترین قیمت خرید', c=>c.a.entry,    null,  c=>fmtP(c.a.entry)],
    ['فاصله تا ورود',    c=>c.a.entryGap, true,  c=>pct(c.a.entryGap,2)],
    ['وضعیت خرید',       c=>({now:3,below:2,wait:1,no:0})[c.a.buyState], true, c=>c.a.buyStateTxt],
    ['نسبت ریسک/بازده (پلکانی)',  c=>c.a.rr,       true,  c=>c.a.rr.toFixed(2)+':1'],
    ['R/R با قیمت فعلی',  c=>c.a.rrNow,   true,  c=>c.a.rrNow.toFixed(2)+':1'],
    ['پیش‌بینی ۷ روزه',  c=>c.a.pred,     true,  c=>pct(c.a.pred,1)],
    ['اطمینان',          c=>c.a.conf,     true,  c=>c.a.conf+'٪'],
    ['RSI',              c=>c.a.rsi,      null,  c=>c.a.rsi?.toFixed(0)??'—'],
    ['واگرایی',          c=>c.a.diverg==='bull'?2:(c.a.diverg==='hBull'?1:(c.a.diverg==='hBear'?-1:(c.a.diverg==='bear'?-2:0))), true,
                          c=>c.a.divergType?`${c.a.divergType} ${c.a.diverg==='bull'?'صعودی معمولی':c.a.diverg==='bear'?'نزولی معمولی':c.a.diverg==='hBull'?'صعودی مخفی':c.a.diverg==='hBear'?'نزولی مخفی':''}`:'—'],
    ['نوسان روزانه',     c=>-(c.a.dvol||0), true, c=>(c.a.dvol?.toFixed(2)??'—')+'٪'],
    ['قدرت نسبی به BTC', c=>c.a.rs7||0,  true,  c=>pct(c.a.rs7,1)],
    ['ریسک',             c=>null,         null,  c=>c.a.risk],
    ['تغییر ۲۴ ساعته',   c=>c.a.ch24,     true,  c=>pct(c.a.ch24,1)],
    ['تغییر ۷ روزه',     c=>c.a.ch7,      true,  c=>pct(c.a.ch7,1)],
    ['ارزش بازار',       c=>c.market_cap, true,  c=>fmtBig(c.market_cap)],
    ['دروازه رژیم',      c=>({open:2,watch:1,blocked:0,exempt:0})[c.a.gate?.state]??0, true, c=>c.a.gate?GATE_STATES[c.a.gate.state].label:'—'],
  ];
  let html='<thead><tr><th>معیار</th>'+list.map(c=>
    `<th><img src="${safeImg(c.image)}" alt="" loading="lazy">${esc(c.symbol.toUpperCase())}</th>`).join('')+'</tr></thead><tbody>';
  rows.forEach(([label,val,hi,fmt])=>{
    let bestIdx=-1;
    if(hi!=null && list.length>1){
      const vals=list.map(c=>{const v=val(c); return (v==null||!isFinite(v))?null:v;});
      const valid=vals.filter(v=>v!=null);
      if(valid.length>1){ const target=Math.max(...valid); bestIdx=vals.indexOf(target); }
    }
    html+=`<tr><td style="color:var(--muted)">${esc(label)}</td>`+
      list.map((c,i)=>`<td class="${i===bestIdx?'best':''}">${esc(fmt(c))}</td>`).join('')+'</tr>';
  });
  $('#cmpTbl').innerHTML=html+'</tbody>';
}

/* =====================================================================
   ماشین‌حساب حجم معامله — بر پایه سرمایه و درصد ریسک
   ===================================================================== */
function riskCfg(){
  let d={cap:1000, pct:2};
  try{ d=Object.assign(d, JSON.parse(localStorage.getItem(LS_KEYS.risk)||'{}')); }catch(e){}
  return d;
}
function riskSave(cfg){ try{ localStorage.setItem(LS_KEYS.risk, JSON.stringify(cfg)); }catch(e){} }

function calcPosition(a, cfg){
  const entry=a.avgEntry||a.entry, stop=a.stop;
  const riskAmt=cfg.cap*cfg.pct/100;
  const perUnit=entry-stop;
  if(!(perUnit>0) || !(entry>0)) return null;
  let units=riskAmt/perUnit;
  let cost=units*entry;
  let capped=false;
  if(cost>cfg.cap){ capped=true; cost=cfg.cap; units=cost/entry; }
  const lossAtStop=units*perUnit;
  const gainAtTp1=units*(a.tp1-entry);
  const gainAtTp2=units*(a.tp2-entry);
  return {units, cost, riskAmt, lossAtStop, gainAtTp1, gainAtTp2, capped,
          costPct: cost/cfg.cap*100, rr:a.rr};
}

function renderCalc(c){
  const cfg=riskCfg(), r=calcPosition(c.a, cfg);
  const box=$('#mcalc');
  if(!r){ box.innerHTML='<h4>🧮 ماشین‌حساب حجم معامله</h4><div class="mini">سطوح این ارز برای محاسبه معتبر نیست — حد ضرر یا ورود نامعتبر است.</div>'; return; }
  box.innerHTML=`<h4>🧮 ماشین‌حساب حجم معامله — مدیریت ریسک</h4>
    <div class="fields">
      <div><label for="capIn">سرمایه کل (دلار)</label><input id="capIn" type="number" min="1" step="any" value="${cfg.cap}" aria-label="سرمایه کل"></div>
      <div><label for="pctIn">ریسک هر معامله (٪ از سرمایه)</label><input id="pctIn" type="number" min="0.1" max="100" step="0.1" value="${cfg.pct}" aria-label="درصد ریسک"></div>
    </div>
    <div class="out">
      <div>مقدار خرید<b>${fmtN(r.units, r.units<1?6:4)} ${esc(c.symbol.toUpperCase())}</b></div>
      <div>ارزش پوزیشن<b>$${fmtN(r.cost,2)} <span class="mini">(${r.costPct.toFixed(0)}٪ سرمایه)</span></b></div>
      <div>زیان در حد ضرر<b class="down">−$${fmtN(r.lossAtStop,2)}</b></div>
      <div>سود در هدف ۱<b class="up">+$${fmtN(r.gainAtTp1,2)}</b></div>
      <div>سود در هدف ۲<b class="up">+$${fmtN(r.gainAtTp2,2)}</b></div>
      <div>ریسک/بازده<b>${r.rr.toFixed(2)}:1</b></div>
    </div>
    ${r.capped?'<div class="warn">⚠️ حجم محاسبه‌شده از کل سرمایه بیشتر بود و به سقف سرمایه محدود شد؛ یعنی حد ضرر نسبت به ریسک انتخابی خیلی نزدیک است — درصد ریسک را کم کنید یا حد ضرر را بازتر بگذارید.</div>':''}
    ${cfg.pct>5?'<div class="warn">⚠️ ریسک بیش از ۵٪ در هر معامله بالاست؛ مدیریت سرمایه معمولاً ۱ تا ۲٪ را توصیه می‌کند تا در رشته باخت‌ها سرمایه حفظ شود.</div>':''}
    <div class="mini" style="margin-top:8px">فرمول: مقدار = (سرمایه × درصد ریسک) ÷ (ورود − حد ضرر) • ارزش = مقدار × ورود</div>`;
  const upd=()=>{ const cap=Math.max(1, parseFloat($('#capIn').value)||0), pctVal=clamp(parseFloat($('#pctIn').value)||0,0.1,100);
    riskSave({cap,pct:pctVal}); const current=state.coins.find(x=>x.id===c.id)||c; renderCalc(current); renderShorts(); $('#mshort').innerHTML=shortDetails(current); };
  $('#capIn').onchange=upd; $('#pctIn').onchange=upd;
}

/* ------------------------- خروجی CSV ------------------------- */
function exportCSV(){
  const l=bestList(25);
  if(!l.length){ toast('⚠️ هنوز داده‌ای برای خروجی وجود ندارد'); return; }
  const head=['رتبه','نام','نماد','رتبه بازار','قیمت فعلی (USD)','بهترین قیمت خرید','کف محدوده','سقف محدوده','فاصله تا ورود %','وضعیت ورود','دروازه‌ی رژیم','دلیل دروازه','پله ۱','پله ۲','پله ۳','میانگین ورود','حد ضرر','هدف ۱','هدف ۲','ریسک/بازده','ریسک/بازده با قیمت فعلی','قدرت نسبی ۷روزه به BTC %','امتیاز خرید','درجه','امتیاز تکنیکال','طبقه','RSI','پیش‌بینی ۷ روزه %','اطمینان %','نوسان روزانه %','ارزش بازار'];
  const cell=v=>{ const t=String(v==null?'':v); return /[\",\n;]/.test(t)? '"'+t.replace(/"/g,'""')+'"' : t; };
  const rows=l.map((c,i)=>{ const a=c.a; return [i+1,c.name,c.symbol.toUpperCase(),c.market_cap_rank,
    c.current_price,a.entry,a.entryLo,a.entryHi,a.entryGap.toFixed(2),a.buyStateTxt,
    a.gate&&!a.gate.exempt?GATE_STATES[a.gate.state].short:'مستثنا', a.gate?a.gate.reasons.join(' | '):'',
    a.ladder[0]?.p,a.ladder[1]?.p,a.ladder[2]?.p,a.avgEntry,a.stop,a.tp1,a.tp2,a.rr.toFixed(2),a.rrNow?.toFixed(2),a.rs7?.toFixed(2),
    a.buyScore,a.grade,a.score,CATS[a.cat].label,a.rsi?.toFixed(1),a.pred.toFixed(2),a.conf,
    a.dvol?.toFixed(2),c.market_cap].map(cell).join(','); });
  const stamp=new Date().toISOString().slice(0,16).replace('T','_').replace(':','-');
  const blob=new Blob(['\uFEFF'+[head.map(cell).join(','),...rows].join('\r\n')],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download=`cryptobin_best_buy_${stamp}.csv`; document.body.appendChild(a); a.click();
  document.body.removeChild(a); setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast(`⬇️ خروجی ${l.length} ارز برتر دانلود شد — شامل دروازه، R/R و قدرت نسبی`);
}

/* ------------------------- Events ------------------------- */
$('#refreshBtn').onclick=()=>loadAll(true);
$('#csvBtn').onclick=exportCSV;
$('#gateOnlyBtn').onclick=()=>{
  gate.onlyApproved=!gate.onlyApproved; gate.save(); syncGateUI(); renderBest();
  toast(gate.onlyApproved?'🚦 فقط ارزهای دارای مجوز دروازه (باز) نمایش داده می‌شوند — مسدودها و انتخابی‌ها حذف شدند':'🚦 فیلتر دروازه خاموش شد — همه‌ی ارزها نمایش داده می‌شوند');
};
$('#gateMode').onchange=e=>{
  gate.mode=e.target.value; gate.save(); syncGateUI();
  if(state.coins.length){ applyMarketContext(); renderAll(); }
  toast(`🚦 دروازه‌ی رژیم: ${GATE_MODES[gate.mode].label} — ${gate.mode==='off'?'فقط نمایشی':'فیلتر فعال'}`);
};
$('#cmpClear').onclick=()=>{ state.cmp=[]; cmpSave(); renderCmp(); renderList(); toast('مقایسه پاک شد'); };
$('#perfReset').onclick=()=>{ if(!perf.rec.length){ toast('کارنامه خالی است'); return; } if(!confirm('کارنامه عملکرد پاک شود؟ این عمل برگشت‌ناپذیر است.')) return; perf.rec=[]; perfSave(); renderPerf(); toast('🗑️ کارنامه عملکرد پاک شد'); };
const debouncedSearch=debounce(e=>{state.q=e.target.value.trim();renderList();},300);
$('#q').oninput=debouncedSearch;
$('#sort').onchange=e=>{state.sort=e.target.value; try{localStorage.setItem(LS_KEYS.sort, state.sort);}catch(_){} renderList();};
$('#viewToggle').querySelectorAll('button').forEach(b=>b.onclick=()=>{ state.view=b.dataset.v; try{localStorage.setItem(LS_KEYS.view, state.view);}catch(_){} $('#viewToggle').querySelectorAll('button').forEach(x=>{ const on=x===b; x.classList.toggle('active',on); x.setAttribute('aria-pressed', on?'true':'false'); }); renderList(); });
$('#watchChip').onclick=()=>{ state.watchOnly=!state.watchOnly; $('#watchChip').classList.toggle('active',state.watchOnly); $('#watchChip').setAttribute('aria-pressed', state.watchOnly?'true':'false'); if(state.watchOnly){state.filter='all';renderChips();} renderList(); toast(state.watchOnly?'⭐ فقط علاقه‌مندی‌ها نمایش داده می‌شوند':'⭐ نمایش همه ارزها'); };
$('#mclose').onclick=closeModal; $('#modal').onclick=e=>{ if(e.target.id==='modal') closeModal(); };
// یک listener برای تمام اکشن‌های پویای فهرست‌ها؛ بدون handler درون HTML و سازگار با رندر مجدد.
document.addEventListener('click',e=>{
  const el=e.target?.closest?.('[data-action]'); if(!el) return;
  const {action,id}=el.dataset;
  if(action==='open') openModal(id);
  else if(action==='watch'){ e.stopPropagation(); toggleWatch(id); }
  else if(action==='compare'){ e.stopPropagation(); toggleCmp(id); }
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape' && $('#modal').classList.contains('open')){ closeModal(); return; }
  // کارت‌ها و ردیف‌های پویای کلیک‌پذیر باید با صفحه‌کلید نیز فعال شوند.
  if((e.key==='Enter'||e.key===' ') && e.target?.dataset?.action && e.target.tagName!=='BUTTON'){
    e.preventDefault(); e.target.click();
  }
});
document.querySelectorAll('.tf').forEach(b=>b.onclick=()=>{ state.tf=+b.dataset.d; document.querySelectorAll('.tf').forEach(x=>{ const on=x===b; x.classList.toggle('active',on); x.setAttribute('aria-pressed', on?'true':'false'); }); loadAndDrawChart(); });
['ovSma20','ovSma50','ovBB','ovPred','ovShort'].forEach(id=>{ const el=$('#'+id); if(el) el.onchange=()=>loadAndDrawChart(); });
let rz; window.addEventListener('resize',()=>{ clearTimeout(rz); rz=setTimeout(()=>{ renderList(); if($('#modal').classList.contains('open')) loadAndDrawChart(); },200); });

/* ------------------------- Boot ------------------------- */
function initMonUI(){
  $('#swMon').classList.toggle('on', mon.on); $('#swMon').setAttribute('aria-checked', mon.on?'true':'false');
  $('#monPill').classList.toggle('off', !mon.on);
  $('#ivSel').value=String(mon.iv);
  $('#swSound').classList.toggle('on', mon.sound); $('#swSound').setAttribute('aria-checked', mon.sound?'true':'false');
  $('#swNotif').classList.toggle('on', mon.notif); $('#swNotif').setAttribute('aria-checked', mon.notif?'true':'false');
  $('#alFilter').value=mon.filter;
  $('#cd').textContent= mon.on? mon.left+'s' : 'خاموش';
}
if('serviceWorker' in navigator && location.protocol!=='file:'){
  let controlled=!!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{if(controlled)location.reload();else controlled=true;});
  window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(()=>{}));
}
/* لایه‌ی داده: پروفایل ذخیره‌شده، مصرف روز، و تاریخچه‌ی کلان را بازیابی کن.
   هیچ‌کدام اجباری نیست؛ نبودشان فقط یعنی تحلیل روی داده‌ی پایه می‌ماند. */
if(typeof MarketData!=='undefined'){
  try{
    MarketData.restoreUsage();
    state.history = MarketData.loadHistory();
    state.globalTrend = MarketData.globalTrend(state.history);
    const sel=$('#mdProfile'); if(sel) sel.value=MarketData.profile();
  }catch(e){ console.warn('market-data init', e); }
}
updateMdStatus();
renderAlerts();
renderPerf();
syncGateUI();
initMonUI();
initShortUI();
initSideUI();
setMon(mon.on);
loadAll();
setInterval(tick, 1000);
document.addEventListener('visibilitychange',()=>{ if(!document.hidden && mon.on && mon.left>mon.iv-2) loadAll(false); });
