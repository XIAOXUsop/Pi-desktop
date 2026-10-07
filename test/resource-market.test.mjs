import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ResourceMarket} from '../desktop/resource-market.mjs';
import {ResourceManager} from '../desktop/resources.mjs';
const json = value => new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
test('market searches only the public registry and only returns Pi-marked packages',async () => {
  let request;const market = new ResourceMarket(async url => {request=new URL(url);return json({objects:[{package:{name:'@author/pi-review',version:'1.2.3',keywords:['pi-package'],publisher:{username:'author'}}},{package:{name:'ordinary',keywords:[]}},{package:{name:'../../escape',keywords:['pi-package']}}],total:3});});
  assert.deepEqual((await market.search({query:'review & redirect=https://evil.example'})).items.map(p=>p.name),['@author/pi-review']);
  assert.equal(request.origin,'https://registry.npmjs.org');assert.equal(request.searchParams.get('text'),'keywords:pi-package review & redirect=https://evil.example');
});
test('market detail pins the exact version, reports declared types and rejects unsafe URLs',async () => {
  const market=new ResourceMarket(async url=> {assert.equal(url,'https://registry.npmjs.org/%40author%2Fpi-review/1.2.3');return json({name:'@author/pi-review',version:'1.2.3',homepage:'javascript:alert(1)',pi:{skills:['skills'],extensions:[],prompts:['!hidden.md']},peerDependencies:{'@earendil-works/pi-coding-agent':'^1.0.0'}});});
  const detail=await market.detail({name:'@author/pi-review',version:'1.2.3'});assert.equal(detail.source,'npm:@author/pi-review@1.2.3');assert.deepEqual(detail.types,['skills']);assert.equal(detail.homepage,'');assert.equal(detail.peers.length,1);
  await assert.rejects(market.detail({name:'https://evil.example',version:'1.2.3'}),/无效/);
  await assert.rejects(market.detail({name:'valid',version:'latest'}),/无效/);
});
test('market rejects mismatched versions, HTTP failures and oversized streaming bodies',async () => {
  await assert.rejects(new ResourceMarket(async()=>json({name:'other',version:'1.0.0'})).detail({name:'valid',version:'1.0.0'}),/不一致/);
  await assert.rejects(new ResourceMarket(async()=>new Response('',{status:503})).search(),/503/);
  await assert.rejects(new ResourceMarket(async()=>new Response('x'.repeat(4*1024*1024+1))).search(),/过大/);
});
async function fixture() {const root=await mkdtemp(join(tmpdir(),'pi-custom-'));const workspace=join(root,'project');await mkdir(workspace);return {root,workspace,manager:await new ResourceManager(join(root,'profile')).load()};}
test('custom skill is a real Pi resource, preserves its full body and starts disabled',async () => {
  const {workspace,manager}=await fixture();const body='Read files first.\n'+ '完整内容 '.repeat(9000);
  const list=await manager.create({type:'skills',name:'my-review',description:'Review: "测试"',body,scope:'project'},workspace);
  assert.equal(list.items.length,1);const skill=list.items[0];assert.equal(skill.name,'my-review');assert.equal(skill.description,'Review: "测试"');assert.equal(skill.enabled,false);assert.equal(skill.scope,'project');assert((await readFile(skill.path,'utf8')).includes(body));
  assert.deepEqual((await manager.runtime(workspace)).skills,[]);await manager.toggle({id:skill.id,enabled:true},workspace);assert.deepEqual((await manager.runtime(workspace)).skills,[skill.path]);
  await manager.remove({sourceId:skill.sourceId},workspace);await manager.add({source:list.sources[0].root,scope:'project'},workspace);assert.equal((await manager.list(workspace)).items[0].enabled,false,'re-import resets old activation');
  assert.equal((await manager.list(undefined)).items.length,0);
});
test('custom prompt persists as a global independent resource and does not overwrite another resource',async () => {
  const {root,workspace,manager}=await fixture();await manager.create({type:'prompts',name:'summary',description:'Summarize files',body:'Summarize $ARGUMENTS',scope:'global'},workspace);
  const original=(await manager.list(workspace)).items[0];await manager.create({type:'prompts',name:'summary-custom',description:'Custom copy',body:'Custom $ARGUMENTS',scope:'project'},workspace);
  assert((await readFile(original.path,'utf8')).includes('Summarize $ARGUMENTS'));
  assert.equal((await (await new ResourceManager(join(root,'profile')).load()).list(undefined)).items.length,1);
  await assert.rejects(manager.create({type:'prompts',name:'summary',description:'duplicate',body:'x'},workspace),/同名/);
});
test('custom resources validate paths, text limits and scope before writing',async () => {
  const {manager,workspace}=await fixture();const input={type:'skills',name:'valid',description:'valid',body:'valid',scope:'project'};
  for(const bad of [{name:'../../escape'},{type:'extensions'},{description:'two\nlines'},{body:'x'.repeat(256*1024+1)},{scope:'unknown'}]) await assert.rejects(manager.create({...input,...bad},workspace));
  await assert.rejects(manager.create(input,undefined),/范围/);assert.equal((await manager.list(workspace)).items.length,0);
});
