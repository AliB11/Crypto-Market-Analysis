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
assert.match(sw,/cryptobin-shell-v4/);

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
console.log('✅ ۱۲ بررسی کیفیت، امنیت، کش، ماژول‌ها و Web Worker موفق بود');
