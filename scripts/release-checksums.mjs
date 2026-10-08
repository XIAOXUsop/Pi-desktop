import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),version=JSON.parse(await readFile(resolve(root,'package.json'))).version;
const files=[`Pi-desktop-Setup-${version}-x64.exe`,`Pi-desktop-${version}-Windows-x64.zip`],lines=[];
for(const file of files){const hash=createHash('sha256');for await(const chunk of createReadStream(resolve(root,'release',file)))hash.update(chunk);lines.push(hash.digest('hex')+'  '+file);}
await writeFile(resolve(root,'release',`Pi-desktop-${version}-SHA256SUMS.txt`),lines.join('\n')+'\n');console.log(lines.join('\n'));
