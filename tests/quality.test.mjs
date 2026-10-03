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
/* نسخه‌ی پوسته باید در هر انتشار عوض شود، وگرنه فایل‌های تازه به کاربر
   نمی‌رسند (کش قدیمی همه‌چیز را نگه می‌دارد). */
assert.match(sw,/cryptobin-shell-v\d+/,'نسخه‌ی پوسته در sw.js پیدا نیست');
/* نسخه‌ی مستندشده در README باید همان نسخه‌ی sw.js باشد؛ وگرنه بعد از هر
   انتشار، سند و کد از هم جدا می‌افتند (همین اتفاق یک‌بار افتاده بود: v7 در
   README مقابل v10 در sw.js). */
const swVer=(sw.match(/cryptobin-shell-v\d+/)||[])[0];
assert.ok(readFileSync(new URL('../README.md',import.meta.url),'utf8').includes(swVer),
  `نسخه‌ی پوسته در README با sw.js یکی نیست (${swVer})`);
/* ماژول‌های تازه باید هم در HTML و هم در پوسته‌ی Service Worker باشند، وگرنه
   نسخه‌ی آفلاین یا تحلیل با خطای «Analytics is not defined» می‌خوابد. */
/* هر اسکریپتی که در HTML هست باید در فهرست پوسته‌ی Service Worker هم باشد —
   وگرنه نسخه‌ی آفلاین با «X is not defined» می‌خوابد. ترتیب بارگذاری هم
  قرارداد است: ماژول‌های خالص پیش از app.js. */
for(const f of ['analytics.js','market-data.js','short-engine.js','onchain.js']){
  assert.match(html,new RegExp(`script src="${f}" defer`),`${f} با defer بارگذاری نمی‌شود`);
  assert.ok(sw.includes(`./${f}`),`${f} در فهرست پوسته‌ی SW نیست`);
  assert.ok(html.indexOf(f)<html.indexOf('app.js'),`${f} باید پیش از app.js بارگذاری شود`);
}
/* کنترل بودجه‌ی لایه‌ی داده و خط وضعیت آن باید در HTML باشند */
assert.match(html,/id="mdProfile"/);
assert.match(html,/id="mdStatus"/);
/* کنترل و وضعیت لایه‌ی On-chain هم باید در HTML باشد */
assert.match(html,/id="ocMode"/);
assert.match(html,/id="ocStatus"/);
assert.match(html,/id="ocGrid"/);
/* هر دامنه‌ای که کد واقعاً با آن fetch می‌کند باید در connect-src باشد (وگرنه
   CSP بی‌صدا درخواست را می‌کُشد) و هیچ دامنه‌ی بی‌مصرفی هم نباید در CSP بماند.
   دامنه‌های مصرفی از خودِ منبع استخراج می‌شوند، نه از یک فهرست دستی. */
{
  const csp=(html.match(/connect-src([^;"]+)/)||[])[1]||'';
  const allowed=[...new Set([...csp.matchAll(/https:\/\/([a-z0-9.-]+)/gi)].map(m=>m[1]))].sort();
  const ocSrc=readFileSync(new URL('../onchain.js',import.meta.url),'utf8');
  const ep=ocSrc.slice(ocSrc.indexOf('const ENDPOINTS'), ocSrc.indexOf('const STABLE_SEED'));
  const used=new Set();
  const apiHost=app.match(/const API\s*=\s*'https:\/\/([a-z0-9.-]+)/); if(apiHost) used.add(apiHost[1]);
  [...app.matchAll(/getJSON\('https:\/\/([a-z0-9.-]+)/g)].forEach(m=>used.add(m[1]));
  [...ep.matchAll(/https:\/\/([a-z0-9.-]+)/g)].forEach(m=>used.add(m[1]));
  assert.deepEqual(allowed,[...used].sort(),'connect-src با دامنه‌های واقعیِ فراخوان هم‌خوان نیست');
  assert.ok(!/connect-src[^;"]*\*/.test(html),'wildcard در connect-src مجاز نیست');
}
/* ماژول‌های تازه باید UMD و بدون وابستگی به DOM باشند */
{
  const analytics=readFileSync(new URL('../analytics.js',import.meta.url),'utf8');
  const md=readFileSync(new URL('../market-data.js',import.meta.url),'utf8');
  const oc=readFileSync(new URL('../onchain.js',import.meta.url),'utf8');
  assert.doesNotMatch(oc,/document\./,'onchain.js نباید به DOM وابسته باشد (آزمون Node)');
  assert.match(oc,/module\.exports/,'onchain.js باید در Node هم قابل بارگذاری باشد');
  assert.match(oc,/setEnv/,'onchain.js باید محیط تزریق‌پذیر داشته باشد تا آزمون‌پذیر بماند');
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
