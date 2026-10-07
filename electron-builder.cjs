module.exports={
  appId:'com.pidesktop.app',productName:'Pi-desktop',executableName:'Pi-desktop',
  directories:{output:'release',buildResources:'build'},
  electronDist:'node_modules/electron/dist',asar:false,npmRebuild:false,
  files:['desktop/**','!desktop/*-smoke.mjs','!desktop/smoke.mjs','!desktop/navigation-benchmark.mjs','desktop/packaging-smoke.mjs','dist/src/**','!dist/**/*.map','configs/deepseek.json','packages/pi-workflows/**','build/app.ico','package.json'],
  extraResources:[{from:'build/runtime',to:'runtime'}],
  // The builder excludes root node_modules even in extraResources. npm must
  // retain its complete dependency tree to work without a system installation.
  async afterPack(context){
    const {cp}=require('node:fs/promises'),{join}=require('node:path');
    await cp(join(context.packager.projectDir,'build/runtime/node_modules/npm'),join(context.appOutDir,'resources/runtime/node_modules/npm'),{recursive:true});
  },
  win:{target:[{target:'nsis',arch:['x64']},{target:'zip',arch:['x64']}],icon:'build/app.ico',artifactName:'Pi-desktop-${version}-Windows-${arch}.${ext}'},
  nsis:{artifactName:'Pi-desktop-Setup-${version}-${arch}.${ext}',oneClick:false,perMachine:false,allowElevation:false,allowToChangeInstallationDirectory:true,createDesktopShortcut:'always',createStartMenuShortcut:true,shortcutName:'Pi-desktop',deleteAppDataOnUninstall:false,runAfterFinish:true,installerLanguages:['zh_CN','en_US']},
  extraMetadata:{main:'desktop/bootstrap.cjs',author:'Pi-desktop'},publish:null,
};
