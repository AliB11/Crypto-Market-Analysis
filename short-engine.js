/* Independent, price-only research strategy. No orders, leverage or execution claims. */
(function(root){
  'use strict';
  const VERSION='short-pullback-v1';
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
    let entry,stop,tp1,tp2;
    if(options.levels){
      ({entry,stop,tp1,tp2}=options.levels);
    }else{
    const series=a.prices||[], pivots=[];
    // Only confirmed pivots; the last three samples cannot be pivots.
    for(let i=3;i<series.length-3;i++){
      if(series.slice(i-3,i+4).every(v=>v<=series[i])) pivots.push(series[i]);
    }
    const anchors=[a.resist,a.sma20,a.ema20,...pivots.slice(-6)].filter(v=>finite(v)&&v>=px);
    if(!anchors.length){reasons.push('مقاومت معتبر بالای قیمت یافت نشد');return p;}
    entry=Math.min(...anchors);
    const ceiling=Math.min(...[a.resist,...pivots].filter(v=>finite(v)&&v>=entry));
    stop=Math.max(entry*(1+vol),ceiling*(1+vol*0.25));
    const supports=[a.support,a.low7].filter(v=>finite(v)&&v<entry).sort((x,y)=>y-x);
    tp1=supports[0]; tp2=supports.find(v=>v<tp1);
    }
    Object.assign(p,{entry,avgEntry:entry,entryLo:entry*(1-0.002),entryHi:entry*(1+0.002),stop,tp1,tp2});
    if(![entry,stop,tp1,tp2].every(finite)||!(stop>entry&&entry>tp1&&tp1>tp2)){
      reasons.push('دو حمایت متمایز و اهداف معتبر موجود نیست'); return p;
    }
    p.valid=true; p.rr=(entry-tp1)/(stop-entry);
    p.rrNow=px>tp1&&px<stop?(px-tp1)/(stop-px):0;
    p.riskPct=(stop-entry)/entry*100;
    const bearish=px<a.sma50&&a.sma20<a.sma50&&a.slopeH<0;
    const momentum=a.macd<a.sig&&a.hist<a.histPrev&&a.rsi<a.rsiPrev;
    let score=35;
    if(bearish) score+=20;
    if(momentum) score+=18;
    if(a.diverg==='bear'||a.diverg==='hBear') score+=8;
    if(a.macdCross==='bear') score+=5;
    score+=clamp(-(a.rs7||0),-10,10);
    if(regime?.k==='riskoff') score+=8;
    if(regime?.k==='riskon') score-=15;
    if(a.rsi<30) score-=25;
    if(a.diverg==='bull'||a.diverg==='hBull') score-=25;
    p.score=Math.round(clamp(score,0,100));
    // Hard safety checks are never bypassed by disabling the regime filter.
    if(options.benchmarkFresh===false) reasons.push('داده تازه بیت‌کوین برای رژیم و قدرت نسبی موجود نیست');
    if(!options.fresh) reasons.push('داده زنده و تازه نیست؛ ورود جدید غیرفعال');
    if(!bearish) reasons.push('ساختار نزولی تأیید نشده');
    if(!momentum) reasons.push('کاهش مومنتوم و RSI برای تأیید برگشت پولبک لازم است');
    if(!Number.isFinite(a.volRatio)||a.volRatio<0.008) reasons.push('نقدشوندگی ناکافی');
    if(a.rsi<30||a.diverg==='bull'||a.diverg==='hBull') reasons.push('خطر بازگشت صعودی / اشباع فروش');
    if(px<=tp1||((px-tp1)/px)<vol*0.5) reasons.push('قیمت بیش از حد به حمایت نزدیک است');
    if((a.ch24||0)<-Math.max(8,a.dvol*2)) reasons.push('تعقیب سقوط شدید مجاز نیست');
    if(p.riskPct>15||((stop-px)/px)*100>15) reasons.push('حد ضرر ساختاری بیش از حد دور است');
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
    if(px>p.entryHi||px>=stop){reasons.push('قیمت از محدوده ورود ثبت‌شده عبور کرده است');return p;}
    const inZone=px>=p.entryLo&&px<=p.entryHi;
    if(inZone&&p.rrNow<minRR){ reasons.push('ریسک/بازده قیمت فعلی ناکافی');return p; }
    p.state=inZone?'ready':'waiting'; p.gate.state=inZone?'open':'watch';
    reasons.push(inZone?'پولبک در محدوده و مومنتوم نزولی تأیید شده':'انتظار پولبک به محدوده؛ هنوز ورود انجام نشده');
    return p;
  }
  function position(p,cfg){
    if(!p.valid||![cfg.cap,cfg.pct,p.entry,p.stop,p.tp1].every(finite)||cfg.pct>100||p.stop<=p.entry||p.tp1>=p.entry)return null;
    const risk=cfg.cap*cfg.pct/100, units=Math.min(risk/(p.stop-p.entry),cfg.cap/p.entry);
    const result={units,notional:units*p.entry,loss:units*(p.stop-p.entry),gain:units*(p.entry-p.tp1)};
    return Object.values(result).every(Number.isFinite)?result:null;
  }
  function advance(r,px,now){
    if(!finite(px)||!['waiting','active'].includes(r.status))return null;
    if(r.status==='waiting'){
      if(now-r.created>=24*3600000||px>=r.stop||px<=r.tp1){r.status='cancelled';r.closed=now;return 'cancelled';}
      return null; // Activation requires a fresh, independently confirmed plan in the app.
    }
    r.last=px; r.peak=Math.max(r.peak,px);r.trough=Math.min(r.trough,px);
    const result=px>=r.stop?'loss':px<=r.tp1?'win':now-r.opened>=7*86400000?'expired':null;
    if(result){
      r.status=result;r.closed=now;r.exit=px;r.ret=(r.fill-px)/r.fill*100;
      r.mfe=(r.fill-r.trough)/r.fill*100;r.mae=(r.fill-r.peak)/r.fill*100;
    }
    return result;
  }
  function restoreRecords(items){
    if(!Array.isArray(items))return [];
    return keepRecords(items.filter(r=>{
      if(!r||r.side!=='short'||r.version!==VERSION||typeof r.id!=='string'||typeof r.sym!=='string')return false;
      if(!['waiting','active','win','loss','expired','cancelled'].includes(r.status))return false;
      if(![r.created,r.entry,r.entryLo,r.entryHi,r.stop,r.tp1,r.tp2].every(finite))return false;
      if(!(r.stop>r.entryHi&&r.entryHi>=r.entry&&r.entry>=r.entryLo&&r.entryLo>r.tp1&&r.tp1>r.tp2))return false;
      if(r.status!=='waiting'&&r.status!=='cancelled'&&![r.fill,r.opened,r.peak,r.trough,r.last].every(finite))return false;
      if(['win','loss','expired'].includes(r.status)&&(!finite(r.closed)||!finite(r.exit)||![r.ret,r.mfe,r.mae].every(Number.isFinite)))return false;
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
