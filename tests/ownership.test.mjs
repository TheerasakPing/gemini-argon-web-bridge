import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../extension/background.js',import.meta.url),'utf8');
async function fixture({beforeSet}={}) {
  const saved={clientId:'client',active:{id:'job',tabId:7,documentId:'document-a',claimToken:'claim'}};
  const posted=[];
  let listener, updated, removed;
  const context=vm.createContext({
    ARGON_TOKEN:'test',importScripts(){},crypto:{randomUUID:()=> 'id'},
    setTimeout,clearTimeout,AbortSignal,URLSearchParams,TextDecoder,
    fetch:async(url,options)=>{posted.push({url,body:options?.body&&JSON.parse(options.body)});return {ok:true,json:async()=>({})};},
    chrome:{
      storage:{local:{
        async setAccessLevel(){},
        async get(keys){
          const names=typeof keys==='string'?[keys]:keys;
          return Object.fromEntries(names.map(k=>[k,structuredClone(saved[k])]));
        },
        async set(value){await beforeSet?.(value);Object.assign(saved,structuredClone(value));},
        async remove(keys){for(const k of keys)delete saved[k];},
      }},
      alarms:{async create(){},onAlarm:{addListener(){}}},
      runtime:{onMessage:{addListener(fn){listener=fn;}},onStartup:{addListener(){}},onInstalled:{addListener(){}}},
      tabs:{onUpdated:{addListener(fn){updated=fn;}},onRemoved:{addListener(fn){removed=fn;}}},
    },
  });
  vm.runInContext(source.slice(0,source.lastIndexOf('setInterval(')),context);
  await vm.runInContext('initialized',context);
  return {saved,context,updated,removed,posted,
    message(message,sender={tab:{id:7}}){return new Promise(resolve=>listener(message,sender,resolve));}};
}
test('wrong document cannot deliver a result or stream into an owned job',async()=>{
  const f=await fixture();
  assert.equal((await f.message({type:'argon:result',id:'job',documentId:'document-b',result:{text:'wrong'}})).accepted,false);
  assert.equal((await f.message({type:'argon:progress',id:'job',documentId:'document-b',partial:'wrong'})).ok,false);
  assert.equal(f.saved.outbox,undefined);
  assert.equal(f.saved.job,undefined);
});
test('navigation queued during delayed result storage wins before flush posts any success',async()=>{
  let release, entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const held=new Promise(resolve=>{release=resolve;});
  const f=await fixture({async beforeSet(value){
    if(value.outbox?.job?.text){entered();await held;}
  }});
  vm.runInContext('poll = async () => {}',f.context);
  const result=f.message({type:'argon:result',id:'job',documentId:'document-a',result:{text:'late success'}});
  await started;
  f.updated(7,{status:'loading'},{});
  const flushed=vm.runInContext('flush()',f.context);
  release();
  await result;await flushed;
  const response=f.posted.find(p=>p.url.endsWith('/jobs/job/response'));
  assert.match(response.body.error,/navigated or reloaded/);
  assert.equal(response.body.text,undefined);
  assert.equal(f.saved.active,undefined);
});
test('navigation of an unrelated tab leaves active job intact',async()=>{
  const f=await fixture();
  f.updated(8,{status:'loading'},{});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.saved.active.invalid,undefined);
  assert.equal(f.saved.outbox,undefined);
});
test('reload marks owner invalid and queues explicit error; delayed old-document answer is rejected',async()=>{
  const f=await fixture();
  f.updated(7,{status:'loading'},{});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.saved.active.invalid,true);
  assert.match(f.saved.outbox.job.error,/navigated or reloaded/);
  assert.equal((await f.message({type:'argon:result',id:'job',documentId:'document-a',result:{text:'stale'}})).accepted,false);
  assert.equal(f.saved.outbox.job.text,undefined);
});
test('closing assigned tab queues error instead of waiting for job timeout',async()=>{
  const f=await fixture();
  f.removed(7);
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(f.saved.outbox.job.error,/tab closed/);
  assert.equal(f.saved.outbox.job.claimToken,'claim');
});
