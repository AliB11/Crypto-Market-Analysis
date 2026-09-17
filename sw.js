// Shell assets are immutable within a release: deploy with a new cache version.
const CACHE='cryptobin-shell-v7';
const SHELL=['./','./index.html','./style.css','./analytics.js','./market-data.js','./short-engine.js','./app.js','./indicator-worker.js'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('cryptobin-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).origin!==location.origin)return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    const cached=await cache.match(event.request);
    if(cached)return cached;
    try{return await fetch(event.request);}
    catch(e){
      // Never return HTML as JavaScript/CSS. Only navigation can use the shell fallback.
      if(event.request.mode==='navigate')return (await cache.match('./index.html'))||Response.error();
      return Response.error();
    }
  })());
});
