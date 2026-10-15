import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

test('numeric tab IDs never fall back to matching another tab title',()=>{
  const source=readFileSync(new URL('../extension/background.js',import.meta.url),'utf8');
  const matching=source.slice(source.indexOf('const matchTab ='),source.indexOf('async function openNewChat'));
  const matchTab=vm.runInNewContext(matching+'\nmatchTab');
  const other={id:456,title:'Gemini chat 123'}, exact={id:123,title:'Work'};
  assert.equal(matchTab([other],'123'),undefined);
  assert.equal(matchTab([other,exact],'123'),exact);
  assert.equal(matchTab([other],'CHAT'),other);
});
