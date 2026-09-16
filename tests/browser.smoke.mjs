/* Optional real-browser smoke test. Start the static server first.
   npm install --no-save playwright; npx playwright install chromium
   BASE_URL=http://localhost:8000 node tests/browser.smoke.mjs
   PLAYWRIGHT_MODULE and CHROMIUM_PATH can point to an existing installation.
   API responses are deterministic fixtures, NOT a live trading validation. */
import assert from 'node:assert/strict';
import {market} from './fixtures.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader']});
const base=process.env.BASE_URL||'http://localhost:8000';
async function wait(page,predicate){
 for(let i=0;i<600;i++){if(await page.evaluate(predicate).catch(()=>false))return;await new Promise(r=>setTimeout(r,50));}
 throw new Error('Browser condition timed out: '+predicate);
}
let passed=0;
try{
 for(const width of [1280,390]){
  const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block',acceptDownloads:true});
  const page=await context.newPage(),errors=[];let offline=false;
  page.on('pageerror',e=>errors.push(e.message));
  await context.route('https://**/*',async route=>{
   const url=route.request().url();
   if(offline&&url.includes('api.'))return route.abort();
   if(url.includes('/coins/markets'))return route.fulfill({json:market('riskoff')});
   if(url.includes('/global'))return route.fulfill({json:{data:{total_market_cap:{usd:2e12},total_volume:{usd:1e10},market_cap_change_percentage_24h_usd:-2,market_cap_percentage:{btc:55,eth:16}}}});
   if(url.includes('alternative.me'))return route.fulfill({json:{data:[{value:'40'}]}});
   if(url.includes('/market_chart'))return route.fulfill({json:{prices:market('riskoff')[1].sparkline_in_7d.price.map((p,i)=>[Date.now()-(168-i)*3600000,p])}});
   if(url.includes('fonts.googleapis'))return route.fulfill({contentType:'text/css',body:''});
   return route.abort();
  });
  await page.goto(base);
  await wait(page,()=>state.coins.length>0&&!state.loading);
  // Default tab is long: short workspace must be hidden, long must be visible.
  assert.equal(await page.locator('#tabLong').getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('#shortSec').isVisible(),false,'short section must be hidden on the long tab');
  assert.equal(await page.locator('#bestSec').isVisible(),true,'long section must be visible on the long tab');
  // Fear & Greed must actually render, not stay on its placeholder.
  assert.notEqual((await page.locator('#fngVal').innerText()).trim(),'—','Fear & Greed gauge stayed on placeholder');
  assert.notMatch(await page.locator('#fngVal').innerText(),/NaN/);
  // Switch to the short tab before touching short controls.
  await page.locator('#tabShort').click();
  assert.equal(await page.locator('#shortSec').isVisible(),true);
  assert.equal(await page.locator('#bestSec').isVisible(),false);
  assert.equal(await page.locator('#shortEnabled').isChecked(),false);
  assert.ok(await page.locator('.short-card').count()>0);
  // Dual tab renders without error, then return to short for the rest of the flow.
  await page.locator('#tabBoth').click();
  assert.equal(await page.locator('#dualSec').isVisible(),true);
  await page.locator('#tabShort').click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,`horizontal page overflow at ${width}`);
  // The real Worker, analyze(), market context, rendering and existing long UI ran above.
  // Isolate a known valid short setup to exercise controls/notifications/persistence.
  await page.evaluate(()=>{
   setMon(false);perf.rec=[];shorts.records=[];
   const c=state.coins.find(c=>c.id==='solana');c.current_price=99;
   Object.assign(c.a,{ok:true,kind:'asset',prices:[],sma20:100,sma50:110,ema20:101,support:95,resist:101,low7:90,dvol:1,slopeH:-0.2,macd:-2,sig:-1,hist:-1,histPrev:-0.5,rsi:45,rsiPrev:46,rs7:-2,volRatio:0.1,ch24:-2,buyScore:0,buyState:'wait',cat:'sell'});
   state.regime={k:'riskoff',fng:40,btcAvailable:true};state.coins=[c,state.coins.find(x=>x.id==='bitcoin')];updateShortPlans();renderShorts();
  });
  await page.locator('#shortEnabled').check();
  assert.match(await page.locator('#shortHistory').innerText(),/منتظر پولبک/);
  await page.locator('#shortFilter').selectOption('approved');
  await page.locator('[data-short-open="solana"]').click();
  await wait(page,()=>mainMeta!==null);
  assert.match(await page.locator('#mshort').innerText(),/محدوده ورود/);
  await page.locator('#ovShort').check();
  await page.locator('#capIn').fill('2000');await page.locator('#capIn').dispatchEvent('change');
  assert.match(await page.locator('#mshort').innerText(),/حجم بر مبنای/);
  await page.locator('#mclose').click();
  const download=page.waitForEvent('download');await page.locator('#shortCSV').click();
  assert.equal((await download).suggestedFilename(),'cryptobin_short_plans.csv');
  await page.evaluate(()=>{state.coins[0].current_price=100;shortCycle();});
  assert.match(await page.locator('#shortHistory').innerText(),/فعال آزمایشی/);
  await page.locator('#alFilter').selectOption('short');assert.match(await page.locator('#alerts').innerText(),/شورت/);
  const fixed=await page.evaluate(()=>({stop:shorts.records[0].stop,tp1:shorts.records[0].tp1}));
  await page.reload();await wait(page,()=>!state.loading&&state.coins.length>0);
  // The selected tab must survive a reload, otherwise the short controls are unreachable.
  assert.equal(await page.locator('#tabShort').getAttribute('aria-selected'),'true','selected tab was not restored');
  assert.equal(await page.locator('#shortEnabled').isChecked(),true);
  assert.equal(await page.evaluate(()=>shorts.records.length),1);
  assert.deepEqual(await page.evaluate(()=>({stop:shorts.records[0].stop,tp1:shorts.records[0].tp1})),fixed);
  const recordBefore=await page.evaluate(()=>JSON.stringify(shorts.records));
  offline=true;await page.locator('#refreshBtn').click();
  await wait(page,()=>!state.loading&&state.liveData===false);
  assert.match(await page.locator('#shortFresh').innerText(),/متوقف/);
  assert.equal(await page.evaluate(()=>JSON.stringify(shorts.records)),recordBefore);
  assert.deepEqual(errors,[],`browser errors at width ${width}`);
  await context.close();console.log(`PASS browser: ${width}px, Worker, modal, chart, risk, CSV, alerts, restore, offline`);passed++;
 }
 // Actual service worker caching: warm shell online, then reload fully offline.
 const context=await browser.newContext();const page=await context.newPage();const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.evaluate(()=>navigator.serviceWorker.ready);
 await wait(page,()=>!!navigator.serviceWorker.controller);
 assert.ok((await page.evaluate(()=>caches.keys())).includes('cryptobin-shell-v5'));
 await context.setOffline(true);await page.reload();
 await wait(page,()=>!state.loading);
 // Fresh context starts on the long tab; the short workspace is reachable via its tab.
 assert.equal(await page.locator('#sideTabs').isVisible(),true);
 await page.locator('#tabShort').click();
 assert.equal(await page.locator('#shortEnabled').isVisible(),true);
 assert.equal(await page.evaluate(()=>typeof ShortEngine.plan),'function');
 assert.deepEqual(errors,[]);
 await context.close();console.log('PASS browser: service-worker shell reload while fully offline');passed++;
 console.log(`${passed} browser scenarios passed`);
}finally{await browser.close();}
