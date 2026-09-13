/* =====================================================================
   آزمون لایه‌ی «دروازه‌ی رژیم» (Regime Gateway)
   اجرا:  node tests/gate.test.mjs

   این آزمون index.html واقعی را می‌خواند، بلوک <script> برنامه را بدون
   هیچ تغییری در یک زمینه‌ی Node با DOM ساختگی اجرا می‌کند و سپس با داده‌ی
   ساختگیِ بازار (سناریوی ریسک‌پذیر و ریسک‌گریز) کل زنجیره‌ی
   analyze → applyMarketContext → دروازه → رتبه‌بندی/هشدار/کارنامه/CSV
   را می‌سنجد. یعنی همان کدی اجرا می‌شود که در مرورگر اجرا می‌شود.
   ===================================================================== */
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

/* ------------------------- DOM ساختگی ------------------------- */
function ctx2d(){
  const noop=()=>{};
  return {clearRect:noop,beginPath:noop,arc:noop,stroke:noop,moveTo:noop,lineTo:noop,closePath:noop,
    fill:noop,fillRect:noop,fillText:noop,setLineDash:noop,save:noop,restore:noop,clip:noop,rect:noop,
    measureText:()=>({width:10}),createLinearGradient:()=>({addColorStop:noop}),scale:noop,translate:noop,
    quadraticCurveTo:noop,bezierCurveTo:noop,drawImage:noop,getImageData:()=>({data:new Uint8ClampedArray(4)}),
    putImageData:noop,font:'',textAlign:'',fillStyle:'',strokeStyle:'',lineWidth:1,lineCap:'',lineJoin:'',globalAlpha:1};
}
function makeEl(tag='div'){
  const el={
    tagName:String(tag).toUpperCase(), children:[], dataset:{}, _cls:new Set(),
    style:{setProperty(){},removeProperty(){}}, textContent:'', innerHTML:'', value:'', checked:true,
    href:'', download:'', clientWidth:320, clientHeight:90, width:320, height:100,
    classList:{ add:(...c)=>c.forEach(x=>el._cls.add(x)), remove:(...c)=>c.forEach(x=>el._cls.delete(x)),
      contains:c=>el._cls.has(c),
      toggle:(c,f)=>{ const on=f===undefined?!el._cls.has(c):!!f; on?el._cls.add(c):el._cls.delete(c); return on; } },
    querySelector:sel=>els.get(sel)||els.set(sel,makeEl()).get(sel),
    querySelectorAll:()=>[], getContext:()=>ctx2d(),
    getBoundingClientRect:()=>({left:0,top:0,right:320,bottom:90,width:320,height:90}),
    addEventListener(){}, removeEventListener(){}, setAttribute(){}, getAttribute:()=>null, removeAttribute(){},
    appendChild(c){ el.children.push(c); return c; }, removeChild(){}, focus(){}, click(){},
    toDataURL:()=>'data:,'
  };
  return el;
}
const els=new Map();

function makeStorage(){
  const m=new Map();
  return {getItem:k=>(m.has(k)?m.get(k):null), setItem:(k,v)=>m.set(k,String(v)), removeItem:k=>m.delete(k), clear:()=>m.clear()};
}

/* داده‌ی ساختگی بازار — سری قیمتی ساعتگی ۷ روزه */
function series(start, drift, n=168, vol=0.0035, seed=7){
  const out=[]; let p=start, s=seed;
  const rnd=()=>{ s=(s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; };
  for(let i=0;i<n;i++){ p=p*(1+drift+(rnd()-0.5)*vol); out.push(Number(p.toFixed(8))); }
  return out;
}
/* سقوط شتاب‌دار با ساعت‌های سبز پراکنده: RSI پایین ولی هیستوگرام MACD همچنان
   نزولی — یعنی بازار واقعاً در حال ریختن است، نه یک اصلاح ساده */
function dumpSeries(start, seed=3, n=168, accel=0.0003, up=0.004){
  const out=[]; let p=start, s=seed;
  const rnd=()=>{ s=(s*1103515245+12345)&0x7fffffff; return s/0x7fffffff; };
  for(let i=0;i<n-48;i++){ p*=(1-0.0006+(rnd()-0.5)*0.005); out.push(Number(p.toFixed(8))); }
  for(let i=0;i<48;i++){ const d=0.004+accel*i; p*= (i%6===5)?(1+up):(1-d); out.push(Number(p.toFixed(8))); }
  return out;
}
/* روند صعودی که در ۲۴ ساعت آخر اصلاح کرده — یعنی هم‌نزدیک محدوده‌ی خرید است */
function pullbackSeries(start, drift, pull, n=168, vol=0.0035, seed=7){
  const head=series(start, drift, n-24, vol, seed);
  const tail=series(head.at(-1), pull, 24, vol, seed+5);
  return [...head, ...tail];
}
function coin(id,symbol,name,o){
  return {id, symbol, name, market_cap_rank:o.rank, current_price:o.price, market_cap:o.mc, total_volume:o.vol,
    ath:o.price*3, ath_change_percentage:-66, high_24h:o.price*1.02, low_24h:o.price*0.98,
    circulating_supply:1e8, total_supply:1e9,
    price_change_percentage_1h_in_currency:o.ch1, price_change_percentage_24h_in_currency:o.ch24,
    price_change_percentage_7d_in_currency:o.ch7, price_change_percentage_30d_in_currency:o.ch30,
    sparkline_in_7d:{price:o.spark}};
}
/* حجم معاملات ~۵٪ ارزش بازار تا شرط نقدشوندگی دروازه برقرار باشد */
function alt(id,sym,name,rank,price,spark,ch7,i){
  const mc=price*1e8*(10-i);
  return coin(id,sym,name,{rank,price:spark.at(-1),mc,vol:mc*0.05,
    ch1:ch7/40, ch24:ch7/4, ch7, ch30:ch7*1.6, spark});
}
function market(kind){
  const up = kind==='riskon';
  const btc = up ? series(60000, 0.0009) : dumpSeries(60000, 3);
  const coins=[coin('bitcoin','btc','Bitcoin',{rank:1,price:btc.at(-1),mc:1.2e12,vol:1.2e12*0.03,
    ch1:up?0.4:-1.2, ch24:up?2.4:-4.5, ch7:up?9:-16, ch30:up?15:-27, spark:btc})];
  // آلت‌ها: یک پیشروی اصلاح‌کرده، یک صعودی شارپ، و بقیه ضعیف
  const defs = up
    ? [['solana','sol','Solana',4,140, pullbackSeries(128,0.0016,-0.0026), 12, 3],
       ['chainlink','link','Chainlink',14,17, series(15.6,0.0013), 13, 7],
       ['avalanche-2','avax','Avalanche',22,31, series(31,0.0002), 1, 11],
       ['cardano','ada','Cardano',9,0.48, series(0.48,0.0001), 0, 13],
       ['dogecoin','doge','Dogecoin',8,0.16, series(0.17,-0.0009), -10, 17],
       ['near','near','NEAR',34,5.2, series(5.6,-0.0013), -16, 19],
       ['arbitrum','arb','Arbitrum',46,0.92, series(1.0,-0.0017), -22, 23]]
    : [['solana','sol','Solana',4,140, dumpSeries(140,5), -18, 5],
       ['chainlink','link','Chainlink',14,17, dumpSeries(17,9), -20, 9],
       ['avalanche-2','avax','Avalanche',22,31, dumpSeries(31,13), -23, 13],
       ['cardano','ada','Cardano',9,0.48, dumpSeries(0.48,17), -17, 17],
       ['dogecoin','doge','Dogecoin',8,0.16, dumpSeries(0.16,21), -25, 21],
       ['near','near','NEAR',34,5.2, dumpSeries(5.2,25), -28, 25],
       ['arbitrum','arb','Arbitrum',46,0.92, dumpSeries(0.92,29), -31, 29]];
  defs.forEach(([id,sym,name,rank,price,spark,ch7],i)=>coins.push(alt(id,sym,name,rank,price,spark,ch7,i)));
  // یک استیبل‌کوین و یک توکن رَپ‌شده — باید از دروازه مستثنا شوند
  coins.push(coin('tether','usdt','Tether',{rank:5,price:1,mc:1.1e11,vol:5e10,ch1:0,ch24:0.01,ch7:0.02,ch30:0.01,spark:series(1,0,168,0.0001)}));
  coins.push(coin('wrapped-steth','steth','Lido Staked Ether',{rank:12,price:btc.at(-1)*0.05,mc:9e9,vol:2e7,
    ch1:up?0.4:-1.1, ch24:up?2.3:-4.4, ch7:up?8.8:-15.8, ch30:up?14:-26, spark: up? series(btc.at(-1)*0.05, 0.0008) : dumpSeries(btc.at(-1)*0.05, 31)}));
  return coins;
}

/* ------------------------- اجرای اسکریپت واقعی برنامه ------------------------- */
const EXPORTS='state,gate,mon,perf,REGIMES,GATE_STATES,GATE_RULES,GATE_STRICT,bestList,applyMarketContext,'
  +'evalMarketGate,evalCoinGate,gatePermit,gateRank,gateStats,gateBadge,detectEvents,perfCycle,perfOpen,'
  +'exportCSV,renderGate,renderRegime,renderBest,renderList,renderModalInfo,renderCmp,renderAlerts,renderPerf,'
  +'syncGateUI,loadAll,setMon';

function boot(kind, gateCfg={}){
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const a=html.indexOf('<script>'), b=html.lastIndexOf('</script>');
  assert.ok(a>0 && b>a, 'بلوک <script> در index.html پیدا نشد');
  const code=html.slice(a+8,b)
    +`\n;globalThis.__api={${EXPORTS}, trd:typeof tradable!=='undefined'?tradable:null};`;

  const store=makeStorage();
  if(gateCfg.mode) store.setItem('cb_gate_v1', JSON.stringify(gateCfg));
  els.clear();

  let csvText=null;
  class Blob{ constructor(parts){ csvText=parts.join(''); } }
  const document={
    querySelector:sel=>{ if(!els.has(sel)) els.set(sel,makeEl()); return els.get(sel); },
    querySelectorAll:()=>[], addEventListener(){}, removeEventListener(){},
    createElement:t=>makeEl(t), body:makeEl('body'), documentElement:makeEl('html')
  };
  const sandbox={
    document, console, Blob, URL:{createObjectURL:()=>'blob:stub', revokeObjectURL(){}},
    localStorage:store, setTimeout, clearTimeout, setInterval:()=>0, clearInterval:()=>{},
    requestAnimationFrame:cb=>{ try{ cb(0); }catch(e){} return 0; },
    Notification:{permission:'default', requestPermission:async()=>'denied'},
    addEventListener(){}, removeEventListener(){},
    navigator:{userAgent:'node'}, performance:{now:()=>Date.now()},
    fetch:async url=>{
      const u=String(url);
      if(u.includes('/coins/markets')) return {ok:true, status:200, json:async()=>market(kind)};
      if(u.includes('/global')) return {ok:true, status:200, json:async()=>({data:{
        total_market_cap:{usd:2.5e12}, total_volume:{usd:9e10}, market_cap_change_percentage_24h_usd:1.2,
        market_cap_percentage:{btc:54.1, eth:16.2}}})};
      if(u.includes('alternative.me')) return {ok:true, status:200, json:async()=>({data:[{value:kind==='riskon'?'62':'41', value_classification:'Greed'}]})};
      return {ok:true, status:200, json:async()=>({prices:[]})};
    }
  };
  sandbox.window=sandbox; sandbox.globalThis=sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, {filename:'index.html'});
  return {api:sandbox.__api, getCsv:()=>csvText, store};
}

async function settled(api, tries=200){
  for(let i=0;i<tries;i++){
    if(api.state.coins.length && api.state.regime && api.state.gate) return;
    await new Promise(r=>setTimeout(r,5));
  }
  throw new Error('برنامه با داده‌ی ساختگی راه نیفتاد (state.coins/state.gate خالی ماند)');
}

/* ------------------------- آزمون‌ها ------------------------- */
const results=[];
function test(name, fn){ results.push([name, fn]); }

test('دروازه در بازار ریسک‌پذیر: کلان «باز» و دست‌کم یک ارز مجاز', async ()=>{
  const {api}=boot('riskon'); await settled(api);
  assert.equal(api.state.regime.k, 'riskon', `رژیم محاسبه‌شده: ${api.state.regime.k} (pts=${api.state.regime.pts})`);
  assert.equal(api.state.gate.macro, 'open');
  assert.equal(api.state.gate.state, 'open');
  const open=api.state.coins.filter(c=>c.a.gate && c.a.gate.state==='open');
  assert.ok(open.length>0, 'در بازار ریسک‌پذیر هیچ ارزی مجوز ورود نگرفت');
  open.forEach(c=>assert.ok(c.a.gate.fails.length===0, `${c.id} با وجود نقص مجوز گرفته`));
  const s=api.state.gate.stats;
  assert.equal(s.open+s.watch+s.blocked+s.exempt, s.total, 'جمع آمار دروازه با تعداد کل نمی‌خواند');
  assert.equal(s.exempt, 2, 'استیبل‌کوین و توکن رَپ‌شده باید مستثنا شوند');
});

test('دروازه در بازار ریسک‌گریز: کلان «بسته» و ورودهای بی‌تأیید مسدود', async ()=>{
  const {api}=boot('riskoff'); await settled(api);
  assert.equal(api.state.regime.k, 'riskoff', `رژیم محاسبه‌شده: ${api.state.regime.k} (pts=${api.state.regime.pts})`);
  assert.equal(api.state.gate.macro, 'closed');
  assert.equal(api.state.gate.state, 'blocked');
  const blocked=api.state.coins.filter(c=>c.a.gate && c.a.gate.state==='blocked');
  assert.ok(blocked.length>0, 'در بازار ریزشی هیچ ارزی مسدود نشد');
  blocked.forEach(c=>assert.ok(c.a.gate.reasons.length>0, `${c.id} بدون دلیل مسدود شده`));
  // هر ارز «مجاز» در رژیم بسته باید آستانه‌های سخت همان رژیم را داشته باشد
  api.state.coins.filter(c=>c.a.gate && c.a.gate.state==='open').forEach(c=>{
    const r=api.GATE_RULES.closed;
    assert.ok(c.a.buyScore>=r.score, `${c.id} با امتیاز ${c.a.buyScore} در رژیم بسته مجوز گرفته`);
    assert.ok(c.a.rrNow>=r.rrNow, `${c.id} با R/R ${c.a.rrNow} در رژیم بسته مجوز گرفته`);
    assert.ok(c.id==='bitcoin' || c.a.rs7>=r.rs7, `${c.id} با RS ${c.a.rs7} در رژیم بسته مجوز گرفته`);
  });
});

test('gatePermit: مسدود = بدون مجوز، باز = مجوز، مستثنا = بی‌اثر', async ()=>{
  const {api}=boot('riskoff'); await settled(api);
  const byId=id=>api.state.coins.find(c=>c.id===id);
  const blocked=api.state.coins.find(c=>c.a.gate && c.a.gate.state==='blocked');
  assert.equal(api.gatePermit(blocked,'any'), false);
  assert.equal(api.gatePermit(blocked,'open'), false);
  const usdt=byId('tether');
  assert.equal(usdt.a.gate.exempt, true, 'استیبل‌کوین باید مستثنا باشد');
  assert.equal(api.gatePermit(usdt,'open'), true);
});

test('حالت خاموش: دروازه فقط نمایشی است و هیچ‌چیز فیلتر نمی‌شود', async ()=>{
  const {api}=boot('riskoff',{mode:'off'}); await settled(api);
  assert.equal(api.gate.mode, 'off', 'حالت ذخیره‌شده در localStorage خوانده نشد');
  assert.equal(api.state.gate.state, 'open', 'در حالت خاموش وضعیت مؤثر باید «باز» باشد');
  assert.equal(api.state.gate.macro, 'closed', 'وضعیت کلان واقعی باید همچنان گزارش شود');
  const blocked=api.state.coins.filter(c=>c.a.gate && c.a.gate.state==='blocked');
  assert.ok(blocked.length>0, 'وضعیت ارزی باید حتی در حالت خاموش محاسبه و نمایش داده شود');
  blocked.forEach(c=>assert.equal(api.gatePermit(c,'open'), true, 'در حالت خاموش هیچ ارزی نباید فیلتر شود'));
});

test('حالت سخت‌گیرانه: آستانه‌ها بالاتر و مجوزها کمتر', async ()=>{
  const auto=boot('riskon'); await settled(auto.api);
  const strict=boot('riskon',{mode:'strict'}); await settled(strict.api);
  const bAuto=auto.api.state.coins.find(c=>c.id==='solana').a;
  const bStr=strict.api.state.coins.find(c=>c.id==='solana').a;
  assert.ok(bStr.gate.need.score >= bAuto.gate.need.score + 6,
    `آستانه‌ی امتیاز در حالت سخت‌گیرانه بالاتر نرفت (${bAuto.gate.need.score} → ${bStr.gate.need.score})`);
  const nAuto=auto.api.state.coins.filter(c=>c.a.gate.state==='open').length;
  const nStr=strict.api.state.coins.filter(c=>c.a.gate.state==='open').length;
  assert.ok(nStr<=nAuto, `حالت سخت‌گیرانه مجوز بیشتری داد (${nAuto} → ${nStr})`);
  assert.equal(strict.api.state.gate.macro, 'watch', 'در حالت سخت‌گیرانه بازار «باز» باید به «انتخابی» تبدیل شود');
});

test('رتبه‌بندی بهترین‌ها: مسدودها ته جدول و فیلتر «فقط مجازها» کار می‌کند', async ()=>{
  const {api}=boot('riskon'); await settled(api);
  const all=api.bestList(25);
  // نکته: آرایه‌های برگشتی از زمینه‌ی vm هم‌نوع آرایه‌ی Node نیستند، پس کپی محلی می‌گیریم
  const ranks=[...all.map(c=>api.gateRank(c))];
  assert.deepEqual(ranks, [...ranks].sort((x,y)=>x-y), 'مسدودها پیش از مجازها در جدول آمده‌اند');
  assert.equal(ranks[0], 0, 'اولین ردیف جدول باید یک ارز مجاز باشد');
  assert.deepEqual([...all.map(c=>c.a.gate.state)].slice(0,1), ['open']);
  api.gate.onlyApproved=true;
  const only=api.bestList(25);
  assert.ok(only.length>0 && only.length<=all.length);
  only.forEach(c=>assert.equal(c.a.gate.state,'open', `${c.id} بدون مجوز در فهرست «فقط مجازها» است`));
  api.gate.onlyApproved=false;
});

test('هشدارها: سیگنال خرید مسدود به هشدار «دروازه بسته» تبدیل می‌شود', async ()=>{
  const {api}=boot('riskoff'); await settled(api);
  const c=api.state.coins.find(x=>x.a.gate && x.a.gate.state==='blocked' && x.id!=='bitcoin');
  api.mon.alerts.length=0;
  api.mon.filter='all';
  api.mon.prev={};
  api.state.coins.forEach(x=>{ api.mon.prev[x.id]={cat:'hold',score:50,buyScore:50,buyState:'wait',
    rsi:50,cross:null,macdCross:null,price:x.current_price,tp1:x.current_price*1.2,stop:x.current_price*0.8}; });
  c.a.buyState='now';                       // ورود به محدوده خرید در بازار بسته
  api.detectEvents();
  const buy=api.mon.alerts.filter(a=>a.kind==='buy' && a.id===c.id);
  const risk=api.mon.alerts.filter(a=>a.kind==='risk' && a.id===c.id && /دروازه/.test(a.text));
  assert.equal(buy.length, 0, 'برای ارز مسدود هشدار تشویق به خرید ثبت شد');
  assert.equal(risk.length, 1, `هشدار مسدودسازی دروازه ثبت نشد — رویدادها: ${api.mon.alerts.map(a=>a.text).join(' | ')}`);
});

test('هشدار تغییر وضعیت دروازه ثبت می‌شود', async ()=>{
  const {api}=boot('riskon'); await settled(api);
  api.mon.alerts.length=0;
  api.mon.prevGate='blocked';
  api.detectEvents();
  const flip=api.mon.alerts.filter(a=>/دروازه‌ی رژیم/.test(a.text) && /باز شد/.test(a.text));
  assert.equal(flip.length, 1, 'رویداد «باز شدن دروازه» ثبت نشد');
});

test('کارنامه‌ی عملکرد: فقط سیگنال دارای مجوز ثبت می‌شود', async ()=>{
  const {api}=boot('riskoff'); await settled(api);
  api.perf.rec.length=0;
  const blocked=api.state.coins.find(c=>c.a.gate.state==='blocked' && c.a.ok && api.trd(c));
  blocked.a.cat='sbuy'; blocked.a.buyScore=85; blocked.a.tp1=blocked.current_price*1.05; blocked.a.stop=blocked.current_price*0.95;
  api.perfCycle();
  assert.equal(api.perf.rec.some(r=>r.id===blocked.id), false, 'سیگنال مسدود در کارنامه ثبت شد');
  api.gate.mode='off';
  api.perfCycle();
  assert.equal(api.perf.rec.some(r=>r.id===blocked.id), true, 'در حالت خاموش باید سیگنال ثبت شود');
});

test('خروجی CSV: ستون دروازه با تعداد ستون‌های سرستون می‌خواند', async ()=>{
  const {api, getCsv}=boot('riskon'); await settled(api);
  api.exportCSV();
  const csv=getCsv();
  assert.ok(csv && csv.length>0, 'exportCSV چیزی تولید نکرد');
  const lines=csv.replace(/^\uFEFF/,'').split('\r\n');
  const head=lines[0].split(',');
  assert.ok(head.includes('دروازه‌ی رژیم'), 'ستون دروازه در سرستون CSV نیست');
  assert.ok(head.includes('دلیل دروازه'), 'ستون دلیل دروازه در CSV نیست');
  const split=s=>{ const out=[]; let cur='',q=false;
    for(const ch of s){ if(ch==='"'){q=!q;continue;} if(ch===','&&!q){out.push(cur);cur='';continue;} cur+=ch; }
    out.push(cur); return out; };
  const rows=lines.slice(1).filter(Boolean).map(split);
  assert.ok(rows.length>0);
  rows.forEach(r=>assert.equal(r.length, head.length, `تعداد ستون ردیف (${r.length}) با سرستون (${head.length}) نمی‌خواند`));
  const gi=head.indexOf('دروازه‌ی رژیم');
  rows.forEach(r=>assert.ok(['باز','انتخابی','بسته','مستثنا'].includes(r[gi]), `مقدار نامعتبر دروازه در CSV: ${r[gi]}`));
});

test('رندر: پنل دروازه، کارت‌ها، جدول‌ها و مودال بدون خطا و با محتوای درست', async ()=>{
  const {api}=boot('riskon'); await settled(api);
  api.renderRegime(); api.renderBest(); api.renderList(); api.renderCmp(); api.renderAlerts(); api.renderPerf();
  const box=document_el('gateBox');
  assert.match(box.innerHTML, /دروازه‌ی رژیم/, 'پنل دروازه رندر نشد');
  assert.match(box.innerHTML, /مجاز:/, 'آمار دروازه در پنل نیست');
  const tbl=document_el('bestTblWrap');
  assert.match(tbl.innerHTML, /<th[^>]*>دروازه<\/th>/, 'ستون دروازه در جدول بهترین‌ها نیست');
  assert.match(document_el('grid').innerHTML, /gbadge/, 'نشان دروازه روی کارت ارزها نیست');
  api.state.view='table'; api.renderList();
  assert.match(document_el('listSec').innerHTML, /<th[^>]*>دروازه<\/th>/, 'ستون دروازه در جدول ارزها نیست');
  const sol=api.state.coins.find(c=>c.id==='solana');
  api.renderModalInfo(sol);
  assert.match(document_el('mbuy').innerHTML, /دروازه‌ی رژیم/, 'جعبه‌ی دروازه در مودال نیست');
  assert.match(document_el('mbuy').innerHTML, /آستانه‌های فعلی دروازه/, 'آستانه‌های دروازه در مودال نیست');
  api.syncGateUI();
  assert.equal(document_el('gateMode').value, 'auto', 'حالت دروازه در کنترل تنظیمات همگام نشد');
});

function document_el(sel){ return els.get('#'+sel) || null; }

/* ------------------------- اجرا ------------------------- */
let pass=0, fail=0;
for(const [name, fn] of results){
  try{ await fn(); console.log(`  ✅ ${name}`); pass++; }
  catch(e){ console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}
console.log(`\n${pass} آزمون موفق، ${fail} آزمون ناموفق (از ${results.length})`);
process.exit(fail?1:0);
