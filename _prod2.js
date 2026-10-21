const fs=require('fs');const env=Object.fromEntries(fs.readFileSync('.env','utf8').split(/\r?\n/).filter(l=>/^[A-Z_0-9]+=/.test(l)).map(l=>[l.split('=')[0],l.slice(l.indexOf('=')+1)]));
const B='https://glad-u-came-funnel.vercel.app';let ck='';
const call=async(p,o={})=>{const r=await fetch(B+p,{method:o.method||'GET',headers:{'Content-Type':'application/json',...(ck?{Cookie:ck}:{})},body:o.body?JSON.stringify(o.body):undefined});const t=await r.text();let j=null;try{j=JSON.parse(t)}catch{};return{s:r.status,j,t,r}};
(async()=>{let r=await call('/api/login',{method:'POST',body:{password:env.ADMIN_PASSWORD}});ck=r.r.headers.get('set-cookie').split(';')[0];
for(const [n,s,b,t] of [['Test Human','Events and launches','5 lakh','In 3 months']]){const x=await call('/api/leads',{method:'POST',body:{name:n,phone:'+91 90000 00002',scope:[s],city:'Mumbai',budget:b,timeline:t,notes:'REGRESSION TEST'}});console.log(n,x.s,x.t.slice(0,160));}
const l=await call('/api/leads?sim=0');console.log((l.j.leads||[]).map(x=>`${x.id}:${x.name}:${x.stage}`).join(' | '));})();
