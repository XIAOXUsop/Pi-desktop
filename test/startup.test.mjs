import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createPersistentKeyReader} from '../desktop/environment-keys.mjs';

const missing=()=>Object.assign(new Error('Fixture variable not found'),{code:1});
const registry=(name,value,type='SZ')=>({stdout:Buffer.from(`HKEY_CURRENT_USER\\Environment\r\n    ${name}    REG_${type}    ${value}\r\n`)});
test('process keys take priority and non-Windows startup never launches a key reader',async()=>{
  const reader=createPersistentKeyReader({platform:'linux',env:{FIXTURE_KEY:'process-fixture'},exec:()=>{throw new Error('Unexpected subprocess');}});
  assert.equal(await reader.read('FIXTURE_KEY'),'process-fixture');
  assert.equal(await reader.read('MISSING_FIXTURE_KEY'),undefined);
  await assert.rejects(()=>reader.read("KEY'; exit"),/Invalid key variable/);
});
test('Windows reads only the requested user key without invoking PowerShell',async()=>{
  const calls=[];
  const reader=createPersistentKeyReader({platform:'win32',env:{SystemRoot:'C:/Windows'},exec:async(binary,args,options)=>{calls.push({binary,args,options});return registry('FIXTURE_KEY','user-fixture');}});
  assert.equal(await reader.read('FIXTURE_KEY'),'user-fixture');
  assert.equal(calls.length,1);assert(calls[0].binary.endsWith('reg.exe'));
  assert.deepEqual(calls[0].args,['query','HKCU\\Environment','/v','FIXTURE_KEY']);assert.equal(calls[0].options.windowsHide,true);
});
test('a missing or blank user key falls back to the machine environment',async()=>{
  for(const absent of [true,false]){
    const calls=[];
    const reader=createPersistentKeyReader({platform:'win32',env:{},exec:async(binary,args)=>{
      calls.push(args);if(calls.length===1){if(absent)throw missing();return registry('FIXTURE_KEY','   ');}
      return registry('FIXTURE_KEY','machine-fixture','EXPAND_SZ');
    }});
    assert.equal(await reader.read('FIXTURE_KEY'),'machine-fixture');assert.equal(calls.length,2);
    assert.equal(calls[1][1],'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment');
  }
});
test('missing Windows keys do not pay for a PowerShell process',async()=>{
  let calls=0;
  const reader=createPersistentKeyReader({platform:'win32',env:{},exec:async binary=>{assert(binary.endsWith('reg.exe'));calls++;throw missing();}});
  assert.equal(await reader.read('FIXTURE_KEY'),undefined);assert.equal(calls,2);
});
test('unavailable registry tooling retains the original Unicode environment fallback',async()=>{
  const calls=[];
  const reader=createPersistentKeyReader({platform:'win32',env:{},exec:async(binary,args)=>{
    calls.push({binary,args});if(binary.endsWith('reg.exe'))throw Object.assign(new Error('Fixture unavailable'),{code:'ENOENT'});
    const command=Buffer.from(args.at(-1),'base64').toString('utf16le');assert(command.includes("GetEnvironmentVariable('FIXTURE_KEY', 'User')"));assert(command.includes("'Machine'"));return {stdout:' Unicode-fixture-中文 '};
  }});
  assert.equal(await reader.read('FIXTURE_KEY'),'Unicode-fixture-中文');assert.equal(calls.length,2);
});
test('registry bytes outside UTF-8 cannot corrupt an environment credential',async()=>{
  const reader=createPersistentKeyReader({platform:'win32',env:{},exec:async binary=>binary.endsWith('reg.exe')?{stdout:Buffer.from([0x46,0x49,0x58,0x54,0x55,0x52,0x45,0x5f,0x4b,0x45,0x59,0x20,0x52,0x45,0x47,0x5f,0x53,0x5a,0x20,0xe9])}:{stdout:'é-fixture'}});
  assert.equal(await reader.read('FIXTURE_KEY'),'é-fixture');
});
test('UTF-16 registry output preserves the exact environment value',async()=>{
  const reader=createPersistentKeyReader({platform:'win32',env:{},exec:async()=>({stdout:Buffer.from('\ufeffFIXTURE_KEY    REG_SZ    fixture-中文\r\n','utf16le')})});
  assert.equal(await reader.read('FIXTURE_KEY'),'fixture-中文');
});
test('providers sharing a key are deduplicated and key lookups have bounded concurrency',async()=>{
  let active=0,peak=0;const lookedUp=[];
  const reader=createPersistentKeyReader({platform:'win32',env:{},exec:async(binary,args)=>{
    const name=args.at(-1);lookedUp.push(name);active++;peak=Math.max(peak,active);await delay(10);active--;return registry(name,'fixture-'+name);
  }});
  const names=Array.from({length:9},(_,index)=>'FIXTURE_'+index+'_KEY');
  const result=await reader.readMany([...names,...names]);
  assert.equal(lookedUp.length,9);assert(peak>1&&peak<=4);for(const name of names)assert.equal(result[name],'fixture-'+name);
});
