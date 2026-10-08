import {cp,mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),runtime=resolve(root,'build/runtime'),nodeRoot=dirname(process.execPath);
if(process.platform!=='win32')throw new Error('This packaging entry currently builds Windows only');
await mkdir(runtime,{recursive:true});
for(const name of ['node.exe','npm.cmd','npx.cmd'])await cp(resolve(nodeRoot,name),resolve(runtime,name));
await cp(resolve(nodeRoot,'node_modules/npm'),resolve(runtime,'node_modules/npm'),{recursive:true});
// Licenses are taken from the exact bundled Node release and npm distribution.
let licenseText;
for(let attempt=0;attempt<3;attempt++){
  try{const license=await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`,{signal:AbortSignal.timeout(15000)});if(!license.ok)throw new Error('Cannot obtain bundled Node license: '+license.status);licenseText=await license.text();break;}
  catch(error){if(attempt===2)throw error;await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));}
}
await writeFile(resolve(runtime,'NODE-LICENSE.txt'),licenseText);
await writeFile(resolve(runtime,'runtime-manifest.json'),JSON.stringify({node:process.version,nodeSha256:createHash('sha256').update(await readFile(process.execPath)).digest('hex'),npm:JSON.parse(await readFile(resolve(runtime,'node_modules/npm/package.json'),'utf8')).version},null,2));
await stat(resolve(root,'build/app.ico'));
console.log('Prepared bundled Node and npm; personal profiles and keys are excluded.');
