import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
const require=createRequire(new URL('../apps/desktop/package.json',import.meta.url));
const {_electron:electron}=require('@playwright/test');
const executable=process.env.PROBE_INSTALLED_APP;
if(!executable)throw Error('Missing installed application');
const configPath=path.join(path.dirname(executable),'resources','app-update.yml');
const original=await readFile(configPath,'utf8');
if(!/^provider: generic\r?$/m.test(original)||!/^url: https:\/\/dl\.vnbot\.run\/desktop\/\r?$/m.test(original))throw Error('Packaged public feed missing');
const data=Buffer.from('Harmless non-executable update fixture. Never install.');
const digest=createHash('sha512').update(data).digest('base64');
const requests=[];
const server=createServer((request,response)=>{
 const name=new URL(request.url,'http://localhost').pathname;requests.push(name);
 if(name==='/latest.yml')response.end(`version: 0.3.9\nfiles:\n  - url: fixture.exe\n    sha512: ${digest}\n    size: ${data.length}\npath: fixture.exe\nsha512: ${digest}\n`);
 else if(name==='/fixture.exe')response.end(data);
 else response.writeHead(404).end();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const profile=await mkdtemp(path.join(tmpdir(),'vnbot-update-proof-'));
let app;
try{
 await writeFile(configPath,original.replace(/^url: .*\r?$/m,`url: http://127.0.0.1:${server.address().port}/`));
 app=await electron.launch({executablePath:executable,args:[],env:{...process.env,RAKAZO_DISABLE_AUTO_UPDATE:'1',RAKAZO_DISABLE_BUNDLED_RENDERER:'1',RAKAZO_PERFORMANCE_USER_DATA:profile,RAKAZO_WEB_URL:'data:text/html,<html><title>Update acceptance fixture</title><body>Updater acceptance driver</body></html>'},timeout:45000});
 const page=await app.firstWindow();
 await page.waitForFunction(()=>window.rakazoDesktop?.update);
 const packaged=await app.evaluate(({app})=>({packaged:app.isPackaged,version:app.getVersion()}));
 if(!packaged.packaged||packaged.version!=='0.3.8')throw Error('Unexpected installed application');
 await new Promise(resolve=>setTimeout(resolve,9000));
 if(requests.length!==0)throw Error('Disabled background check contacted feed');
 await page.evaluate(()=>window.rakazoDesktop.update.check());
 let state;
 for(let i=0;i<200;i++){
  state=await page.evaluate(()=>window.rakazoDesktop.update.state());
  if(state.phase==='error'||state.phase==='unsupported')throw Error('Manual check failed: '+state.phase);
  if(state.phase==='ready')break;
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 if(state?.phase!=='ready'||state.availableVersion!=='0.3.9'||state.percent!==100)throw Error('Verified download not ready');
 const allowed=new Set(['/latest.yml','/fixture.exe','/fixture.exe.blockmap']);
 if(requests.filter(p=>p==='/latest.yml').length!==1||requests.filter(p=>p==='/fixture.exe').length!==1||requests.some(p=>!allowed.has(p)))throw Error('Unexpected update requests: '+JSON.stringify(requests));
 console.log(JSON.stringify({artifact:'installed-Windows-0.3.8',packaged:true,background_disabled:true,manual_ipc_check:true,real_sdk_http_download:true,checksum_verified:true,phase:state.phase,installer_executed:false,requests}));
}finally{
 if(app){
  // The fixture must never execute. Leave production signature settings intact.
  await app.evaluate(({app})=>{const require=process.getBuiltinModule('node:module').createRequire(app.getAppPath()+'/package.json');require('electron-updater').autoUpdater.autoInstallOnAppQuit=false;});
  await app.close();
 }
 await writeFile(configPath,original);
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 await rm(profile,{recursive:true,force:true});
}
