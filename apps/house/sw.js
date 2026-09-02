const C='sameroof-v2',STATIC=new Set(['/','/index.html','/manifest.json','/sw.js']);
self.addEventListener('install',e=>e.waitUntil(caches.open(C).then(c=>c.addAll([...STATIC]))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==C).map(k=>caches.delete(k))))));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==location.origin||!STATIC.has(u.pathname))return;e.respondWith(fetch(e.request).then(r=>{if(r.ok){const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp))}return r}).catch(()=>caches.match(e.request)))});
