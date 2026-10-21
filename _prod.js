const fs=require('fs');const env=Object.fromEntries(fs.readFileSync('.env','utf8').split(/\r?\n/).filter(l=>/^[A-Z_0-9]+=/.test(l)).map(l=>[l.split('=')[0],l.slice(l.indexOf('=')+1)]));
const B='https://glad-u-came-funnel.vercel.app';let ck='';
const call=async(p,o={})=>{const r=await fetch(B+p,{method:o.method||'GET',headers:{'Content-Type':'application/json',...(ck?{Cookie:ck}:{})},body:o.body?JSON.stringify(o.body):undefined});const t=await r.text();let j=null;try{j=JSON.parse(t)}catch{};return{s:r.status,j,t,r}};
(async()=>{
let r=await call('/api/login',{method:'POST',body:{password:env.ADMIN_PASSWORD}});console.log('admin login',r.s);ck=r.r.headers.get('set-cookie').split(';')[0];
r=await call('/api/status');console.log('llm',JSON.stringify(r.j.llm&&{enabled:r.j.llm.enabled,providers:(r.j.llm.providers||[]).map(p=>p.name+(p.cooling?'(cooling)':''))}),'db',r.j.db&&JSON.stringify(r.j.db).slice(0,120));
const mk=async(name,scope,budget,timeline)=>{const x=await call('/api/leads',{method:'POST',body:{name,phone:'+91 90000 00000',scope:[scope],city:'Mumbai',budget,timeline,notes:'REGRESSION TEST'}});return x};
const a=await mk('Test Active','Influencer marketing','8 lakh','Within a month');console.log('create',a.s,JSON.stringify(a.j).slice(0,120));
const b=await mk('Test Nurture','Public relations','','');const c=await mk('Test Human','Events and launches','5 lakh','In 3 months');
const ids=[a.j.id,b.j.id,c.j.id];
let l=await call('/api/leads?sim=0');console.log('lead list',l.s,(l.j.leads||[]).map(x=>`${x.id}:${x.name}:${x.stage}`).join(' | '));
await call('/api/leads/'+ids[1],{method:'PATCH',body:{stage:'nurture',reason:'regression'}});
await call('/api/leads/'+ids[2],{method:'PATCH',body:{stage:'human',reason:'regression'}});
await call('/api/leads/'+ids[0],{method:'PATCH',body:{stage:'active',reason:'regression'}});
l=await call('/api/leads?sim=0');console.log('after moves',(l.j.leads||[]).filter(x=>ids.includes(x.id)).map(x=>`${x.name}:${x.stage}`).join(' | '));
fs.writeFileSync('_ids.json',JSON.stringify(ids));
})();
