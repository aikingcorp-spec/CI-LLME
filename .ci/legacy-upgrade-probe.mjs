import{createRequire}from'node:module';import{readFile,writeFile,mkdtemp,rm}from'node:fs/promises';import path from'node:path';import{tmpdir}from'node:os';
const require=createRequire(new URL('./probe-tools/package.json',import.meta.url));const{_electron:electron}=require('@playwright/test');
const executable=process.env.PROBE_INSTALLED_APP;if(!executable)throw Error('Missing legacy installed app');
const profile=await mkdtemp(path.join(tmpdir(),'vnbot-legacy-upgrade-'));const marker=path.join(profile,'upgrade-fixture.marker');await writeFile(marker,'keep-this-fixture');
// Reproduce a supported operator bootstrap on the isolated CI install. These
// settings do not exist by default in 0.3.7; publishing a feed cannot add them.
await writeFile(path.join(path.dirname(executable),'resources','app-update.yml'),'provider: generic\nurl: https://dl.vnbot.run/desktop/\nupdaterCacheDirName: legacy-upgrade-acceptance\n');
const env={...process.env,RAKAZO_DISABLE_AUTO_UPDATE:'0',RAKAZO_DISABLE_BUNDLED_RENDERER:'1',RAKAZO_PERFORMANCE_USER_DATA:profile,RAKAZO_WEB_URL:'data:text/html,<html><title>Legacy upgrade acceptance</title><body>Isolated in-app upgrade driver</body></html>'};let app;
try{
 app=await electron.launch({executablePath:executable,env,timeout:45000});const page=await app.firstWindow();await page.waitForFunction(()=>window.rakazoDesktop?.update);
 if(await app.evaluate(({app})=>app.getVersion())!=='0.3.7')throw Error('Expected legacy app');
 await page.evaluate(()=>window.rakazoDesktop.update.check());let state;
 for(let i=0;i<900;i++){state=await page.evaluate(()=>window.rakazoDesktop.update.state());if(['error','unsupported'].includes(state.phase))throw Error('Legacy check failed: '+state.phase);if(state.phase==='ready')break;await new Promise(r=>setTimeout(r,200));}
 if(state.phase!=='ready'||state.availableVersion!=='0.3.8')throw Error('Legacy download not verified');
 const closed=app.waitForEvent('close',{timeout:90000});
 await page.evaluate(()=>window.rakazoDesktop.update.install()).catch(()=>{});await closed;app=undefined;
 console.log(JSON.stringify({legacy_version:'0.3.7',bootstrap_opt_in_and_feed_config:true,manual_public_download:true,actual_install_requested:true,app_closed_for_update:true}));
 // The workflow waits for the real installer to replace the executable before
 // opening it again. Keep the fixture profile available for the second step.
 await writeFile('legacy-profile.txt',profile);
}catch(error){
 if(app){await app.evaluate(({app})=>{const require=process.getBuiltinModule('node:module').createRequire(app.getAppPath()+'/package.json');require('electron-updater').autoUpdater.autoInstallOnAppQuit=false;}).catch(()=>{});await app.close().catch(()=>{});}
 await rm(profile,{recursive:true,force:true});throw error;
}
