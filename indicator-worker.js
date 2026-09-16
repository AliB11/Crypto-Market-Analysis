/* محاسبات CPU-bound اندیکاتورها خارج از thread رابط کاربری. */
function sma(a,n){const o=new Array(a.length).fill(null);let s=0;for(let i=0;i<a.length;i++){s+=a[i];if(i>=n)s-=a[i-n];if(i>=n-1)o[i]=s/n}return o}
function ema(a,n){const o=new Array(a.length).fill(null),k=2/(n+1);let p=null;for(let i=0;i<a.length;i++){if(a[i]==null)continue;p=p==null?a[i]:a[i]*k+p*(1-k);if(i>=n-1)o[i]=p}return o}
function rsi(a,n=14){const o=new Array(a.length).fill(null);let g=0,l=0;for(let i=1;i<a.length;i++){const d=a[i]-a[i-1];if(i<=n){d>0?g+=d:l-=d;if(i===n){g/=n;l/=n;o[i]=l===0?100:100-100/(1+g/l)}}else{g=(g*(n-1)+Math.max(d,0))/n;l=(l*(n-1)+Math.max(-d,0))/n;o[i]=l===0?100:100-100/(1+g/l)}}return o}
function macd(a){const e12=ema(a,12),e26=ema(a,26),m=a.map((_,i)=>e12[i]!=null&&e26[i]!=null?e12[i]-e26[i]:null),signal=ema(m,9);return{macd:m,signal,hist:m.map((v,i)=>v!=null&&signal[i]!=null?v-signal[i]:null)}}
function bb(a,n=20,k=2){const mid=sma(a,n),up=[],lo=[];for(let i=0;i<a.length;i++){if(mid[i]==null){up.push(null);lo.push(null);continue}let s=0;for(let j=i-n+1;j<=i;j++)s+=(a[j]-mid[i])**2;const sd=Math.sqrt(s/n);up.push(mid[i]+k*sd);lo.push(mid[i]-k*sd)}return{up,lo}}
self.onmessage=({data})=>{
  const result=data.series.map(p=>{const clean=p.filter(Number.isFinite);if(clean.length<60)return null;const rsiArr=rsi(clean),m=macd(clean),sma20=sma(clean,20),sma50=sma(clean,50),ema20=ema(clean,20),bands=bb(clean);return{rsiArr,...m,sma20,sma50,ema20,bb:bands}});
  self.postMessage({id:data.id,result});
};
