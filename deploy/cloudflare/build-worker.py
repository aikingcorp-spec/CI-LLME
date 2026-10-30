"""Gói một thư mục tĩnh thành một Worker module duy nhất (mỗi file là một data module).

Dùng: python3 build-worker.py <site_dir> <worker_name> <www_host|->
Ghi .out/deploy2-<worker_name>.js trong thư mục hiện tại: một hàm async chạy qua
Cloudflare API connector, dùng khi endpoint upload assets không có sẵn qua connector.
<www_host> được 301 về vnbot.run; '-' nghĩa là không chuyển hướng.
"""
import os,sys,json,base64
root,name,redir=sys.argv[1],sys.argv[2],sys.argv[3]
CT={'html':'text/html; charset=utf-8','css':'text/css; charset=utf-8','js':'application/javascript; charset=utf-8','svg':'image/svg+xml','png':'image/png','webp':'image/webp','jpg':'image/jpeg','ico':'image/x-icon','woff2':'font/woff2','txt':'text/plain; charset=utf-8','xml':'application/xml; charset=utf-8','webmanifest':'application/manifest+json'}
files=[]
for d,_,fs in os.walk(root):
  for f in sorted(fs):
    p=os.path.join(d,f); rel='/'+os.path.relpath(p,root); ext=os.path.splitext(f)[1][1:]
    files.append({'path':rel,'mod':'f%d.bin'%len(files),'ct':CT.get(ext,'application/octet-stream'),'b64':base64.b64encode(open(p,'rb').read()).decode()})
imports=''.join(f"import m{i} from './{x['mod']}';" for i,x in enumerate(files))
table='const T={'+','.join(f"{json.dumps(x['path'])}:[m{i},{json.dumps(x['ct'])}]" for i,x in enumerate(files))+'};'
red=f"if(u.hostname==={json.dumps(redir)}){{u.hostname='vnbot.run';return Response.redirect(u.toString(),301)}}" if redir!='-' else ''
worker=imports+table+"""export default{async fetch(r){const u=new URL(r.url);"""+red+"""let p=decodeURIComponent(u.pathname);
let e=T[p]||T[p.replace(/\\/$/,'')+'/index.html']||T[p+'.html'];
if(!e&&!p.endsWith('/')&&T[p+'/index.html'])return Response.redirect(u.origin+p+'/'+u.search,301);
const h=x=>({'content-type':x[1],'cache-control':x[1].startsWith('text/html')?'public, max-age=0, must-revalidate':'public, max-age=3600','x-content-type-options':'nosniff'});
if(e)return new Response(r.method==='HEAD'?null:e[0],{headers:h(e)});const nf=T['/404.html'];return new Response(nf[0],{status:404,headers:h(nf)})}};"""
meta=[{k:x[k] for k in('mod','b64')} for x in files]
js="async () => {\nconst M="+json.dumps(meta)+";const NAME="+json.dumps(name)+";const W="+json.dumps(worker)+""";
const b=s=>{const t=atob(s);const u=new Uint8Array(t.length);for(let i=0;i<t.length;i++)u[i]=t.charCodeAt(i);return u};
const fd=new FormData();fd.append('metadata',new Blob([JSON.stringify({main_module:'worker.js',compatibility_date:'2026-10-01'})],{type:'application/json'}));
fd.append('worker.js',new Blob([W],{type:'application/javascript+module'}),'worker.js');
for(const m of M)fd.append(m.mod,new Blob([b(m.b64)],{type:'application/octet-stream'}),m.mod);
const up=await cloudflare.request({method:'PUT',path:`/accounts/${accountId}/workers/scripts/${NAME}`,body:fd});
return {modules:M.length,id:up.result.id,etag:up.result.etag,size:up.result.startup_time_ms};}
"""
os.makedirs('.out',exist_ok=True)
open(f'.out/deploy2-{name}.js','w').write(js)
