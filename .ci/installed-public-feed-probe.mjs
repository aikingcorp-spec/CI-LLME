import{createRequire}from'node:module';
import{readFile,mkdtemp,rm}from'node:fs/promises';
import path from'node:path';import{tmpdir}from'node:os';
const require=createRequire(new URL('./probe-tools/package.json',import.meta.url));const{_electron:electron}=require('@playwright/test');
const executable=process.env.PROBE_INSTALLED_APP;if(!executable)throw Error('Missing installed app');
const config=await readFile(path.join(path.dirname(executable),'resources','app-update.yml'),'utf8');
if(!/^provider: generic\r?$/m.test(config)||!/^url: https:\/\/dl\.vnbot\.run\/desktop\/\r?$/m.test(config))throw Error('Public feed configuration differs');
const profile=await mkdtemp(path.join(tmpdir(),'vnbot-public-feed-'));let app;
try{
 app=await electron.launch({executablePath:executable,env:{...process.env,RAKAZO_DISABLE_AUTO_UPDATE:'1',RAKAZO_DISABLE_BUNDLED_RENDERER:'1',RAKAZO_PERFORMANCE_USER_DATA:profile,RAKAZO_WEB_URL:'data:text/html,<html><title>Public update feed acceptance</title><body>In-app update driver</body></html>'},timeout:45000});
 const page=await app.firstWindow();await page.waitForFunction(()=>window.rakazoDesktop?.update);
 const info=await app.evaluate(({app})=>({packaged:app.isPackaged,version:app.getVersion()}));
 if(!info.packaged||info.version!=='0.3.8')throw Error('Wrong installed app');
 const state=await page.evaluate(()=>window.rakazoDesktop.update.check());
 if(state.phase!=='idle'||state.currentVersion!=='0.3.8'||state.availableVersion!==null||state.checkedAt===null||state.message!==null)throw Error('Public feed check failed: '+JSON.stringify({phase:state.phase,message:state.message}));
 console.log(JSON.stringify({artifact:'public-installed-Windows-0.3.8',real_public_https_feed:true,manual_in_app_check:true,background_disabled:true,up_to_date:true,installer_executed:false}));
}finally{
 if(app){await app.evaluate(({app})=>{const require=process.getBuiltinModule('node:module').createRequire(app.getAppPath()+'/package.json');require('electron-updater').autoUpdater.autoInstallOnAppQuit=false;});await app.close();}
 await rm(profile,{recursive:true,force:true});
}
