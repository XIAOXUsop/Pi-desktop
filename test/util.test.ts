import test from 'node:test';
import assert from 'node:assert/strict';
import {bounded} from '../src/util.js';

const limit=64*1024,marker='\n[output truncated]';

test('bounded never splits UTF-8 code points at any interior byte of the 64 KiB boundary',()=>{
  for(const character of ['é','你','🙂']) {
    for(let split=1;split<Buffer.byteLength(character);split++) {
      const prefix='x'.repeat(limit-Buffer.byteLength(marker)-split);
      const source=prefix+character+'tail'.repeat(10),result=bounded(source,limit);
      assert(Buffer.byteLength(result)<=limit);assert(!result.includes('\uFFFD'),`${character}: cut after byte ${split}`);
      assert(result===prefix+marker,`valid prefix for ${character}: cut after byte ${split}`);
    }
    const prefix='x'.repeat(limit-Buffer.byteLength(marker)-Buffer.byteLength(character));
    assert(bounded(prefix+character+'tail'.repeat(10),limit)===prefix+character+marker,`complete ${character} is retained at the boundary`);
  }
});

test('bounded keeps complete Unicode and BOM, and honours even budgets smaller than the marker',()=>{
  const exact='\uFEFF'+'🙂'.repeat(10)+'你';
  assert.equal(bounded(exact,Buffer.byteLength(exact)),exact);
  const prefix='\uFEFF'+'x'.repeat(limit-Buffer.byteLength(marker)-4);
  assert(bounded(prefix+'你tail'.repeat(10),limit)===prefix+marker,'a truncated BOM-prefixed string keeps its BOM');
  for(const budget of [0,1,2,3,4,Buffer.byteLength(marker)-1]) {
    const result=bounded('你🙂'.repeat(20),budget);
    assert(Buffer.byteLength(result)<=budget,`small byte budget ${budget}`);
    assert(!result.includes('\uFFFD'));
  }
});
