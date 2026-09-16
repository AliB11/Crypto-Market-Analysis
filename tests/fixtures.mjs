// Deterministic synthetic market data; never used by the application.
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
  return {id, symbol, name, last_updated:new Date().toISOString(), market_cap_rank:o.rank, current_price:o.price, market_cap:o.mc, total_volume:o.vol,
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


export {market};
