import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../style.css',import.meta.url),'utf8');
const sw=readFileSync(new URL('../sw.js',import.meta.url),'utf8');

assert.match(html,/Content-Security-Policy/);
assert.match(html,/script src="app\.js" defer/);
assert.match(html,/stylesheet" href="style\.css/);
assert.doesNotMatch(html,/\sonclick=/i);
assert.doesNotMatch(app,/onclick="/i);
assert.match(app,/CACHE_MAX_AGE_MS=6\*60\*60\*1000/);
assert.match(app,/cache\?\.v===CACHE_VERSION/);
assert.match(app,/new Worker\('indicator-worker\.js'\)/);
assert.match(css,/prefers-reduced-motion/);
assert.match(sw,/cryptobin-shell-v8/);
/* ماژول‌های تازه باید هم در HTML و هم در پوسته‌ی Service Worker باشند، وگرنه
   نسخه‌ی آفلاین یا تحلیل با خطای «Analytics is not defined» می‌خوابد. */
assert.match(html,/script src="analytics\.js" defer><\/script>/);
assert.match(html,/script src="market-data\.js" defer><\/script>/);
assert.ok(html.indexOf('analytics.js')<html.indexOf('app.js'),'analytics.js باید پیش از app.js بارگذاری شود');
assert.ok(html.indexOf('market-data.js')<html.indexOf('app.js'),'market-data.js باید پیش از app.js بارگذاری شود');
['analytics.js','market-data.js'].forEach(f=>assert.ok(sw.includes(`./${f}`),`${f} در فهرست پوسته‌ی SW نیست`));
/* کنترل بودجه‌ی لایه‌ی داده و خط وضعیت آن باید در HTML باشند */
assert.match(html,/id="mdProfile"/);
assert.match(html,/id="mdStatus"/);
/* دامنه‌ی تازه‌ای به CSP اضافه نشده باشد: همه‌ی فراخوان‌های تازه از همان
   api.coingecko.com هستند، پس نباید origin تازه‌ای در connect-src باشد. */
{
  const csp=(html.match(/connect-src([^;"]+)/)||[])[1]||'';
  const origins=[...csp.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map(m=>m[1]);
  assert.deepEqual([...new Set(origins)].sort(),['api.alternative.me','api.coingecko.com'],
    'دامنه‌ی غیرمنتظره در connect-src اضافه شده است');
}
/* ماژول‌های تازه باید UMD و بدون وابستگی به DOM باشند */
{
  const analytics=readFileSync(new URL('../analytics.js',import.meta.url),'utf8');
  const md=readFileSync(new URL('../market-data.js',import.meta.url),'utf8');
  [analytics,md].forEach((src,name)=>{
    assert.doesNotMatch(src,/document\./,`${name} نباید به DOM وابسته باشد`);
    assert.match(src,/module\.exports/,'ماژول‌ها باید در Node هم قابل بارگذاری باشند');
  });
  assert.match(md,/setEnv/,'لایه‌ی داده باید محیط تزریق‌پذیر داشته باشد تا آزمون‌پذیر بماند');
}

/* تب‌ها: ماتریس نمایش باید در CSS درست باشد — این بخش با DOM ساختگی Node پوشش داده نمی‌شود */
{
  const secs=[...html.matchAll(/<section id="([^"]+)"[^>]*data-tab="([^"]+)"/g)].map(m=>({id:m[1],tab:m[2]}));
  assert.ok(secs.length>=4,'بخش‌های تب‌دار در HTML یافت نشد');
  const block=css.match(/((?:main\[data-side[^{]+,\s*)*main\[data-side[^{]+)\{display:none\}/);
  assert.ok(block,'قاعده‌ی پنهان‌سازی تب‌ها در CSS یافت نشد');
  const hides=[...block[1].matchAll(/main\[data-side="(\w+)"\]\s*\[data-tab="(\w+)"\]/g)].map(m=>({side:m[1],tab:m[2]}));
  for(const side of ['long','short','both']){
    const vis=secs.filter(s=>!hides.some(h=>h.side===side&&h.tab===s.tab));
    assert.ok(vis.length>0,`تب ${side} هیچ بخشی نمایش نمی‌دهد`);
    vis.forEach(s=>assert.equal(s.tab,side,`تب ${side} بخش ${s.id} متعلق به ${s.tab} را نشان می‌دهد`));
  }
  // بخش‌های مشترک (زمینه‌ی بازار، خروجی API، فهرست ارزها) نباید به تب گره بخورند
  assert.doesNotMatch(html,/<section id="apiSec"[^>]*data-tab=/,'خروجی API باید در همه‌ی تب‌ها در دسترس باشد');
  assert.doesNotMatch(html,/<section id="listSec"[^>]*data-tab=/,'فهرست ارزها باید در همه‌ی تب‌ها بماند');
  assert.match(html,/role="tablist"/,'تب‌ها باید نقش tablist داشته باشند');
  assert.equal((html.match(/role="tab"/g)||[]).length,3,'باید دقیقاً سه تب وجود داشته باشد');
  assert.match(html,/aria-selected="true"/,'تب فعال باید aria-selected داشته باشد');
  /* هر aria-controls باید به بخشی اشاره کند که واقعاً role="tabpanel" دارد */
  const panels=new Set([...html.matchAll(/<section id="([^"]+)"[^>]*role="tabpanel"/g)].map(m=>m[1]));
  const controlled=[...html.matchAll(/aria-controls="([^"]+)"/g)].flatMap(m=>m[1].split(/\s+/));
  assert.ok(controlled.length>0,'تب‌ها باید aria-controls داشته باشند');
  controlled.forEach(id=>assert.ok(panels.has(id),`aria-controls به #${id} اشاره می‌کند ولی آن بخش role="tabpanel" ندارد`));
  /* هر tabpanel باید با aria-labelledby به تب خودش وصل باشد */
  [...html.matchAll(/<section id="([^"]+)"[^>]*role="tabpanel"[^>]*aria-labelledby="([^"]+)"[^>]*data-tab="([^"]+)"/g)]
    .forEach(([,id,lab])=>assert.match(html,new RegExp(`id="${lab}"[^>]*role="tab"|role="tab"[^>]*id="${lab}"`),
      `بخش #${id} به تب ناموجود ${lab} ارجاع می‌دهد`));
  assert.equal(panels.size,4,'هر چهار بخش وابسته به تب باید tabpanel باشند');
}
/* کامنت نادرست بالای بخش شورت نباید برگردد */
assert.doesNotMatch(html,/Track record \/ backtest/,'کامنت نادرست بالای بخش شورت هنوز هست');
/* شاخص ترس و طمع باید واقعاً رندر شود */
assert.match(app,/renderFNG\(\)/,'renderFNG هرگز صدا زده نمی‌شود — پنل روی placeholder می‌ماند');
assert.doesNotMatch(app,/parseInt\(state\.fng\.value\)/,'خواندن مستقیم fng باید از fngValue() عبور کند');
/* فیلتر هشدار «فقط شورت» باید معتبر شمرده شود */
assert.match(app,/\['all','buy','watch','short'\]\.includes\(m\.filter\)/,'فیلتر short در اعتبارسنجی بارگذاری جا افتاده');

const workerCode=readFileSync(new URL('../indicator-worker.js',import.meta.url),'utf8');
let posted;
const sandbox={self:{postMessage:v=>{posted=v}},Number,Math};
vm.createContext(sandbox); vm.runInContext(workerCode,sandbox);
const series=Array.from({length:168},(_,i)=>100+i*.2+Math.sin(i/4));
sandbox.self.onmessage({data:{id:7,series:[series]}});
assert.equal(posted.id,7);
assert.equal(posted.result[0].rsiArr.length,168);
assert.ok(Number.isFinite(posted.result[0].sma20.at(-1)));
assert.ok(Number.isFinite(posted.result[0].hist.at(-1)));
console.log("✅ بررسی‌های کیفیت، امنیت، کش، ماژول‌ها، تب‌ها و Web Worker موفق بود");
