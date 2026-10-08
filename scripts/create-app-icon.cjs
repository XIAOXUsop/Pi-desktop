const {readFileSync,writeFileSync,mkdirSync}=require('node:fs');
const {resolve}=require('node:path');
const root=resolve(__dirname,'..');

if(!process.versions.electron){
  const {spawnSync}=require('node:child_process');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const result=spawnSync(require('electron'),[__filename],{cwd:root,env,windowsHide:true,stdio:'inherit',timeout:45000});
  if(result.error)throw result.error;
  process.exitCode=result.status??1;
}else{
  const {app,BrowserWindow,nativeImage}=require('electron');
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor','1');
  app.setPath('userData',resolve(root,'.agent/icon-renderer-profile'));
  app.whenReady().then(async()=>{
    const svg=readFileSync(resolve(root,'desktop/ui/app-mark.svg'));
    const window=new BrowserWindow({width:512,height:512,useContentSize:true,show:false,transparent:true,
      backgroundColor:'#00000000',webPreferences:{sandbox:true,contextIsolation:true}});
    const html=`<!doctype html><html><body style="margin:0;background:transparent"><img width="512" height="512" src="data:image/svg+xml;base64,${svg.toString('base64')}" /></body></html>`;
    await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
    const raster=await window.webContents.executeJavaScript(`document.images[0].decode().then(()=>{
      const canvas=document.createElement('canvas');canvas.width=512;canvas.height=512;
      canvas.getContext('2d').drawImage(document.images[0],0,0,512,512);return canvas.toDataURL('image/png');
    })`);
    const master=nativeImage.createFromDataURL(raster);
    if(master.isEmpty())throw new Error('SVG icon rendering returned an empty image');
    const sizes=[16,20,24,32,40,48,64,128,256];
    const frames=sizes.map(size=>master.resize({width:size,height:size,quality:'best'}).toPNG());
    const header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);
    let offset=header.length;
    frames.forEach((png,index)=>{const entry=6+16*index,size=sizes[index];header[entry]=size===256?0:size;header[entry+1]=size===256?0:size;
      header.writeUInt16LE(1,entry+4);header.writeUInt16LE(32,entry+6);header.writeUInt32LE(png.length,entry+8);header.writeUInt32LE(offset,entry+12);offset+=png.length;});
    mkdirSync(resolve(root,'build'),{recursive:true});
    writeFileSync(resolve(root,'build/app.png'),master.toPNG());
    writeFileSync(resolve(root,'build/app.ico'),Buffer.concat([header,...frames]));
    console.log(JSON.stringify({icon:'build/app.ico',source:'desktop/ui/app-mark.svg',preview:'build/app.png',sizes}));
    window.destroy();app.exit(0);
  }).catch(error=>{console.error(error);app.exit(1);});
}
