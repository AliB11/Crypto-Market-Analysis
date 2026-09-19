/* Independent, price-only research strategy. No orders, leverage or execution claims.
   v2 corrections (360° review):
   * A short's entry level is a MINIMUM acceptable price. If price runs above the
     recorded band but is still under the stop and R/R from the live price holds,
     that is a BETTER fill, not a broken setup — it must not be discarded.
   * Re-validation of a waiting record (options.levels present) must not re-apply
     creation-only conditions (pullback momentum decay, creation score) — a rally
     INTO the sell zone by definition rises RSI/histogram. It re-checks safety,
     geometry, freshness, regime and R/R from live price only. */
(function(root){
  'use strict';
  const VERSION='short-pullback-v2';
  const LEGACY_VERSIONS=['short-pullback-v1'];   // stored history remains readable
  const finite=x=>Number.isFinite(x)&&x>0;
  const clamp=(x,l,h)=>Math.max(l,Math.min(h,x));
  function plan(c, regime, options={}){
    const a=c.a||{}, px=c.current_price;
    const p={side:'short',version:VERSION,score:0,state:'blocked',gate:{state:'blocked',reasons:[]},valid:false};
    const reasons=p.gate.reasons;
    if(!a.ok||a.kind!=='asset'||![px,a.sma20,a.sma50,a.support,a.resist,a.dvol].every(finite)||
      ![a.macd,a.sig,a.hist,a.histPrev,a.rsi,a.rsiPrev,a.slopeH,a.rs7,a.ch24].every(Number.isFinite)){
      reasons.push('داده کافی و معتبر برای دارایی مستقل وجود ندارد'); return p;
    }
    const vol=clamp(a.dvol,0.8,9)/100;
    let entry,stop,tp1,tp2,lane='pullback';
    if(options.levels){
      ({entry,stop,tp1,tp2}=options.levels);
    }else{
    const series=a.prices||[], pivots=[];
    // Only confirmed pivots; the last three samples cannot be pivots.
    for(let i=3;i<series.length-3;i++){
      if(series.slice(i-3,i+4).every(v=>v<=series[i])) pivots.push(series[i]);
    }
    /* 🔻 مسیر ادامه‌دهنده ریزش (continuation): اگر پرچم momoDown توسط موتور اصلی
       تأیید شده باشد، نبودِ مقاومت بالای قیمت «دلیل رد» نیست — ورود در قیمت بازار
       با بافر نوسانی بالای سقف ساختاری مجاز است (بدون پولبک، ریسک بازگشت بالاتر). */
    const cont = a.momoDown===true && px<a.sma50 && a.sma20<a.sma50 && a.slopeH<0;
    const anchors=[a.resist,a.sma20,a.ema20,...pivots.slice(-6)].filter(v=>finite(v)&&v>=px);
    if(!anchors.length){
      if(!cont){reasons.push('مقاومت معتبر بالای قیمت یافت نشد');return p;}
      lane='continuation'; entry=px; stop=px*(1+clamp(vol*1.8,0.012,0.09));
    }else{
      entry=Math.min(...anchors);
      const ceiling=Math.min(...[a.resist,...pivots].filter(v=>finite(v)&&v>=entry));
      stop=Math.max(entry*(1+vol),ceiling*(1+vol*0.25));
    }
    const supports=[a.support,a.low7,a.bbLo].filter(v=>finite(v)&&v<entry).sort((x,y)=>y-x);
    tp1=supports[0]; tp2=supports.find(v=>v<tp1);
    }
    Object.assign(p,{entry,avgEntry:entry,entryLo:entry*(1-0.002),entryHi:entry*(1+0.002),stop,tp1,tp2,lane});
    if(![entry,stop,tp1,tp2].every(finite)||!(stop>entry&&entry>tp1&&tp1>tp2)){
      reasons.push('دو حمایت متمایز و اهداف معتبر موجود نیست'); return p;
    }
    p.valid=true; p.rr=(entry-tp1)/(stop-entry);
    p.rrNow=px>tp1&&px<stop?(px-tp1)/(stop-px):0;
    p.riskPct=(stop-entry)/entry*100;
    const bearish=px<a.sma50&&a.sma20<a.sma50&&a.slopeH<0;
    const momentum=a.macd<a.sig&&a.hist<a.histPrev&&a.rsi<a.rsiPrev;
    /* conditions that only make sense when the plan is CREATED. A waiting
       record re-validates with options.levels: price rallying INTO the sell zone
       lifts RSI/histogram by construction — re-applying the creation-time decay
       requirement would cancel the setup exactly at its fill moment. */
    const revalidate=!!options.levels;
    let score=35;
    if(bearish) score+=20;
    if(momentum) score+=18;
    else if(revalidate && !(a.macd>a.sig&&a.hist>a.histPrev&&a.rsi>62)) score+=18;
    if(a.diverg==='bear'||a.diverg==='hBear') score+=8;
    if(a.macdCross==='bear') score+=5;
    score+=clamp(-(a.rs7||0),-10,10);
    if(regime?.k==='riskoff') score+=8;
    if(regime?.k==='riskon') score-=15;
    if(a.rsi<30) score-=25;
    if(a.diverg==='bull'||a.diverg==='hBull') score-=25;
    /* شاهد مستقل از قیمت: فاندینگ فیوچرز. فاندینگ داغ مثبت یعنی ازدحام سمت
       لانگ (به نفع شورت)، فاندینگ عمیقاً منفی یعنی ازدحام سمت شورت و ریسک
       اسکوییز صعودی. بدون داده‌ی معتبر هیچ‌کدام اعمال نمی‌شود. */
    const funding=Number.isFinite(a.fundingAnnual)?a.fundingAnnual:null;
    if(funding!=null){
      if(funding>=40) score+=6;
      else if(funding<=-20) score-=8;
      if(funding<=-40) score-=10;
      if(funding<=-20 && a.oiChangePct!=null && a.oiChangePct>=3) score-=6;
    }
    // creation-validated score is a floor for fill re-validation, never for display
    const floorScore=Number.isFinite(options.levels?.score)?options.levels.score:null;
    p.score=Math.round(clamp(revalidate&&floorScore!=null?Math.max(score,floorScore):score,0,100));
    // Hard safety checks are never bypassed by disabling the regime filter.
    if(options.benchmarkFresh===false) reasons.push('داده تازه بیت‌کوین برای رژیم و قدرت نسبی موجود نیست');
    if(!options.fresh) reasons.push('داده زنده و تازه نیست؛ ورود جدید غیرفعال');
    if(!bearish) reasons.push('ساختار نزولی تأیید نشده');
    if(!momentum&&!revalidate) reasons.push('کاهش مومنتوم و RSI برای تأیید برگشت پولبک لازم است');
    /* در اعتبارسنجیِ ورودِ منتظر، رشدهای لحظه‌ای مجاز است (قیمت دارد به ناحیه
       فروش می‌رسد) اما «بازگشت قدرتمند» نه: MACD بالای سیگنال + هیستوی رو به
       رشد + RSI بالا یعنی پولبک به شکست تبدیل شده و ستاپ مرده است. */
    if(revalidate&&a.macd>a.sig&&a.hist>a.histPrev&&a.rsi>62) reasons.push('پولبک به شکست قدرتمند تبدیل شده؛ ستاپ شورت باطل است');
    if(!Number.isFinite(a.volRatio)||a.volRatio<0.008) reasons.push('نقدشوندگی ناکافی');
    if(a.rsi<30||a.diverg==='bull'||a.diverg==='hBull') reasons.push('خطر بازگشت صعودی / اشباع فروش');
    if(px<=tp1||((px-tp1)/px)<vol*0.5) reasons.push('قیمت بیش از حد به حمایت نزدیک است');
    if((a.ch24||0)<-Math.max(8,a.dvol*2)) reasons.push('تعقیب سقوط شدید مجاز نیست');
    if(p.riskPct>15||((stop-px)/px)*100>15) reasons.push('حد ضرر ساختاری بیش از حد دور است');
    /* فاندینگ عمیقاً منفی مانع ورود شورت است (سوخت اسکوییز). فاندینگ داغ
       مثبت مانع نیست و فقط امتیاز را بالا می‌برد — چون ازدحام سمت مقابل است. */
    if(funding!=null&&funding<=-40) reasons.push(`فاندینگ سالانه ${funding.toFixed(0)}٪ — شورت‌ها ازدحام دارند و ریسک اسکوییز صعودی بالاست`);
    const strict=options.mode==='strict', threshold=strict?78:68, minRR=strict?2:1.5;
    p.gate.need={score:threshold,rr:minRR};
    if(p.score<threshold) reasons.push(`امتیاز کمتر از ${threshold}`);
    if(p.rr<minRR) reasons.push(`ریسک/بازده ورود کمتر از ${minRR}`);
    if(options.mode!=='off'){
      if(!regime||!['neutral','riskoff'].includes(regime.k)) reasons.push('رژیم صعودی یا نامشخص؛ شورت محدود است');
      if(regime?.fng!=null&&regime.fng<=18) reasons.push('ترس شدید؛ خطر شورت دیرهنگام');
      if(c.id!=='bitcoin'&&!(a.rs7<=0)) reasons.push('دارایی نسبت به BTC ضعیف نیست');
    }
    if(options.conflict) reasons.push('تعارض با ورود تأییدشده لانگ');
    if(reasons.length) return p;
    /* ورود شورت یعنی «فروش در entry یا بالاتر» تا پیش از حد ضرر. پس:
       قیمت بالای باند ثبت‌شده = قیمت اجرای بهتر (نه رد ستاپ)؛ تنها شرط،
       حفظ R/R از قیمت زنده است. کفِ فاصله از حد ضرر هم لازم است، چون درست
       زیر stop عدد R/R مصنوعی بزرگ می‌شود و یک لغزش کوچک فوراً فعالش می‌کند. */
    const stopBuffer=stop*(1-vol*0.5);
    if(px>=stop){reasons.push('قیمت به حد ضرر رسیده یا از آن عبور کرده است');return p;}
    if(px>=stopBuffer){reasons.push('قیمت به حد ضرر خیلی نزدیک است؛ ورود در این نقطه با یک لغزش کوچک فوراً با حد ضرر بسته می‌شود');return p;}
    const fillable=px>=p.entryLo;
    if(fillable&&p.rrNow<minRR){ reasons.push('ریسک/بازده قیمت فعلی ناکافی');return p; }
    p.state=fillable?'ready':'waiting'; p.gate.state=fillable?'open':'watch';
    p.betterFill=px>p.entryHi;
    p.fundingAnnual=a.fundingAnnual??null; p.oiChangePct=a.oiChangePct??null; p.crowd=a.crowd||null;
    reasons.push(fillable?(p.betterFill?'ورود در قیمت فعلی — بهتر از حداقل ثبت‌شده تأیید شد':'پولبک در محدوده و شرایط نزولی تأیید شده'):'انتظار پولبک به محدوده؛ هنوز ورود انجام نشده');
    return p;
  }
  function position(p,cfg){
    if(!p.valid||![cfg.cap,cfg.pct,p.entry,p.stop,p.tp1].every(finite)||cfg.pct>100||p.stop<=p.entry||p.tp1>=p.entry)return null;
    const risk=cfg.cap*cfg.pct/100, units=Math.min(risk/(p.stop-p.entry),cfg.cap/p.entry);
    const result={units,notional:units*p.entry,loss:units*(p.stop-p.entry),gain:units*(p.entry-p.tp1)};
    return Object.values(result).every(Number.isFinite)?result:null;
  }
  function advance(r,px,now,opts={}){
    if(!finite(px)||!['waiting','active'].includes(r.status))return null;
    if(r.status==='waiting'){
      if(now-r.created>=24*3600000||px>=r.stop||px<=r.tp1){r.status='cancelled';r.closed=now;return 'cancelled';}
      return null; // Activation requires a fresh, independently confirmed plan in the app.
    }
    r.last=px; r.peak=Math.max(r.peak,px);r.trough=Math.min(r.trough,px);
    /* خروج پلکانی (opt-in): برخورد اول به TP1 نیمی از پوزیشن را می‌بندد و حد ضرر
       نیمه‌ی باقی‌مانده روی ورود (سر‌به‌سر) می‌نشیند؛ ادامه تا TP2، حدِ سر‌به‌سر،
       یا سررسید ۷ روزه. رکورد بدون پرچم ladder دقیقاً مثل v2 عمل می‌کند. */
    const ladder=r.ladder===true||opts.ladder===true;
    if(ladder&&!r.half&&px<=r.tp1){
      r.half='tp1'; r.halfPx=r.tp1; r.halfT=now;
      r.realized1=(r.fill-r.tp1)/r.fill*50;   // سهم ۵۰٪ بند‌شده در بازده کل
      r.stop=r.entry;                          // باقی‌مانده بی‌ریسک تا TP2
      return 'half';
    }
    let result=null;
    if(px>=r.stop) result=r.half?'be':'loss';
    else if(r.half&&px<=r.tp2) result='win';
    else if(!r.half&&px<=r.tp1) result='win';
    else if(now-r.opened>=7*86400000) result='expired';
    if(result){
      r.status=result;r.closed=now;r.exit=px;
      const rest=(r.fill-px)/r.fill*100;
      r.ret= r.half ? r.realized1 + rest*0.5 : rest;
      if(r.half) r.blended=true;
      r.mfe=(r.fill-r.trough)/r.fill*100;r.mae=(r.fill-r.peak)/r.fill*100;
      /* هزینه‌ها — کارمزد رفت‌وبرگشت و فاندینگ دوره‌ی نگه‌داری. فاندینگ مثبت
         به نفع شورت است (لانگ‌ها پرداخت می‌کنند)، منفی برعکس؛ فقط با عدد
         معتبر اعمال می‌شود. */
      if(Number.isFinite(r.feePct)&&r.feePct>=0){
        const days=Math.max(0,(r.closed-(r.opened??r.created)))/864e5;
        const fee=r.feePct*2;
        const fr=Number.isFinite(r.fundingAnnual)?r.fundingAnnual:0;
        const fundingPnl=fr*Math.min(7,days)/365;   // درصد، علامت‌دار از دید شورت
        r.costPct=fee; r.fundingPnlPct=fundingPnl;
        r.retNet=r.ret-fee+fundingPnl;
        for(const v of [r.costPct,r.retNet])if(!Number.isFinite(v)){delete r.costPct;delete r.retNet;delete r.fundingPnlPct;break;}
      }
    }
    return result;
  }
  function restoreRecords(items){
    if(!Array.isArray(items))return [];
    return keepRecords(items.filter(r=>{
      if(!r||r.side!=='short'||!(r.version===VERSION||LEGACY_VERSIONS.includes(r.version))||typeof r.id!=='string'||typeof r.sym!=='string')return false;
      if(!['waiting','active','win','loss','expired','cancelled','be','half'].includes(r.status))return false;
      if(![r.created,r.entry,r.entryLo,r.entryHi,r.stop,r.tp1,r.tp2].every(finite))return false;
      /* رکوردِ نیمه‌بسته حد ضررش روی ورود نشسته است؛ هندسه‌ی اصلی همان‌جا
       «شل» می‌شود — همان را با سخت‌گیری معادل بررسی می‌کنیم. */
      const stopOk = r.half==='tp1' ? (finite(r.stop)&&r.stop>=r.entry&&r.stop<=r.entryHi) : r.stop>r.entryHi;
      if(!(stopOk&&r.entryHi>=r.entry&&r.entry>=r.entryLo&&r.entryLo>r.tp1&&r.tp1>r.tp2))return false;
      if(r.half==='tp1'&&!finite(r.halfPx))return false;
      if(r.status!=='waiting'&&r.status!=='cancelled'&&![r.fill,r.opened,r.peak,r.trough,r.last].every(finite))return false;
      if(['win','loss','expired','be'].includes(r.status)&&(!finite(r.closed)||!finite(r.exit)||![r.ret,r.mfe,r.mae].every(Number.isFinite)))return false;
      if(r.status==='cancelled'&&!finite(r.closed))return false;
      return true;
    }));
  }
  function keepRecords(records){
    const live=records.filter(r=>['waiting','active'].includes(r.status));
    const slots=Math.max(0,300-live.length);
    const closed=records.filter(r=>!['waiting','active'].includes(r.status)).sort((a,b)=>(a.closed||a.created)-(b.closed||b.created));
    // slice(-0) returns the whole array; never use it for zero capacity.
    return [...(slots?closed.slice(-slots):[]),...live];
  }
  root.ShortEngine={VERSION,plan,position,advance,restoreRecords,keepRecords};
})(globalThis);
