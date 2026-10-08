import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';

// Read only the requested variables. Spawning the PowerShell runtime adds over
// a second to Electron startup on Windows, even for a single environment key.
export function createPersistentKeyReader({env=process.env,platform=process.platform,exec=promisify(execFile)}={}) {
  const system=resolve(env.SystemRoot || 'C:/Windows','System32');
  async function powershell(name) {
    const command=`[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $v = [Environment]::GetEnvironmentVariable('${name}', 'User'); if ([string]::IsNullOrWhiteSpace($v)) { $v = [Environment]::GetEnvironmentVariable('${name}', 'Machine') }; if (-not [string]::IsNullOrWhiteSpace($v)) { [Console]::Write($v) }`;
    try {
      const {stdout}=await exec(resolve(system,'WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,timeout:10000,maxBuffer:16384});
      return stdout.trim() || undefined;
    }catch{return undefined;}
  }
  async function read(name) {
    if(!/^[A-Z_][A-Z0-9_]*$/.test(name))throw new Error('Invalid key variable name');
    if(env[name]?.trim())return env[name];
    if(platform!=='win32')return undefined;
    for(const hive of ['HKCU\\Environment','HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
      let output;
      try {
        const {stdout}=await exec(resolve(system,'reg.exe'),['query',hive,'/v',name],{windowsHide:true,timeout:3000,maxBuffer:16384,encoding:'buffer'});
        output=Buffer.isBuffer(stdout)?stdout.toString(stdout[0]===0xff&&stdout[1]===0xfe?'utf16le':'utf8'):stdout;
      }catch(error){
        if(error.code!==1)return powershell(name);
        continue;
      }
      // reg.exe uses the system code page on some Windows configurations.
      // Preserve non-ASCII values via the Unicode fallback instead of decoding
      // a credential with replacement characters.
      if(output.includes('\ufffd'))return powershell(name);
      const value=output.match(new RegExp(`^\\s*${name}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.*)$`,'m'))?.[1]?.trim();
      if(value)return value;
    }
    return undefined;
  }
  async function readMany(names) {
    const remaining=[...new Set(names)],values={};let position=0;
    await Promise.all(Array.from({length:Math.min(4,remaining.length)},async()=>{
      while(position<remaining.length){const name=remaining[position++];values[name]=await read(name);}
    }));
    return values;
  }
  return {read,readMany};
}
const reader=createPersistentKeyReader();
export const persistentKey=name=>reader.read(name);
export const persistentKeys=names=>reader.readMany(names);
