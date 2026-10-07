const {app,dialog}=require('electron');
const {existsSync,mkdirSync,appendFileSync}=require('node:fs');
const {join}=require('node:path');
app.setName('Pi-desktop');
app.setAppUserModelId('com.pidesktop.app');
if(app.isPackaged){
  const runtime=join(process.resourcesPath,'runtime');
  if(existsSync(join(runtime,'node.exe')))process.env.PATH=runtime+';'+(process.env.PATH||'');
}
import('./main.mjs').catch(async error=>{
  const folder=app.getPath('userData');mkdirSync(folder,{recursive:true});
  appendFileSync(join(folder,'startup-error.log'),new Date().toISOString()+' '+(error.stack||error.message)+'\n');
  console.error(error);
  if(!process.argv.includes('--package-check')){await app.whenReady();dialog.showErrorBox('Pi-desktop 启动失败','请查看启动日志：'+join(folder,'startup-error.log'));}
  app.exit(1);
});
