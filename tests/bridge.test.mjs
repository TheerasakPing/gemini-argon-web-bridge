import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../bridge/server.mjs';
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function fixture(t, timeoutMs=180000, token='test-token', dataDir=null) {
  const server=createBridge({token,timeoutMs,dataDir});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const call=async(path,body,headers={})=>{
    const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  };
  return {call,base};
}
function cliHome(t) {
  const root=mkdtempSync(join(tmpdir(),'argon-cli-'));
  mkdirSync(join(root,'bridge'));
  writeFileSync(join(root,'bridge/token'),'test-token\n',{mode:0o600});
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return root;
}
test('queue is serialized, claims deduplicate, result is authenticated and idempotent',async t=>{
  const {call}=await fixture(t);
  const a=(await call('/ask',{prompt:'หนึ่ง'})).body;
  await call('/ask',{prompt:'two'});
  assert.equal((await call('/api/pending_task?client=a&ready=0')).body.task,null);
  const claims=await Promise.all([call('/api/pending_task?client=a&ready=1'),call('/api/pending_task?client=b&ready=1')]);
  assert.equal(claims.filter(r=>r.body.task).length,1);
  const task=claims.find(r=>r.body.task).body.task;
  assert.equal(task.id,a.id);
  assert.equal((await call(`/api/pending_task?client=${task.client}&ready=1`)).body.task.id,a.id);
  assert.equal((await call(`/jobs/${a.id}/response`,{text:'forged'})).status,409);
  assert.equal((await call(`/jobs/${a.id}/response`,{claimToken:task.claimToken,text:'คำตอบ'})).status,200);
  await call(`/jobs/${a.id}/response`,{claimToken:task.claimToken,text:'duplicate'});
  assert.equal((await call(`/jobs/${a.id}`)).body.text,'คำตอบ');
  assert.equal((await call(`/jobs/${a.id}`)).body.claimToken,undefined);
  assert.notEqual((await call('/api/pending_task?client=a&ready=1')).body.task.id,a.id);
});
test('rejects unauthorized, cross-origin and invalid prompts',async t=>{
  const {call}=await fixture(t);
  assert.equal((await call('/ask',{prompt:'x'},{Authorization:''})).status,401);
  assert.equal((await call('/health',undefined,{Origin:'https://evil.example'})).status,403);
  assert.equal((await call('/ask',{prompt:''})).status,400);
  assert.equal((await call('/ask',null)).status,400);
  assert.equal((await call('/health')).body.ready,false);
});
test('real Python CLI roundtrip with simulated extension, UTF-8 prompt and response',async t=>{
  const root=cliHome(t);
  const {base,call}=await fixture(t);
  await call('/api/pending_task?client=simulator&ready=1');
  const script=fileURLToPath(new URL('../scripts/gemini_argon_bridge.py',import.meta.url));
  const python=spawn('python3',['-c',
    'import importlib.util,sys,pathlib; s=importlib.util.spec_from_file_location("bridge",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.BASE=sys.argv[2]; m.ROOT=pathlib.Path(sys.argv[3]); sys.argv=["argon","ทดสอบ", "--timeout", "5"]; sys.exit(m.main())',script,base,root]);
  let output='',errors='';
  python.stdout.on('data',data=>output+=data); python.stderr.on('data',data=>errors+=data);
  const ended=new Promise((resolve,reject)=>{python.on('error',reject);python.on('close',resolve);});
  t.after(()=>python.kill());
  let task;
  for(let i=0;i<100;i++) {
    task=(await call('/api/pending_task?client=simulator&ready=1')).body.task;
    if(task) break;
    await new Promise(r=>setTimeout(r,20));
  }
  assert.equal(task?.prompt,'ทดสอบ');
  await call(`/jobs/${task.id}/response`,{claimToken:task.claimToken,text:'คำตอบจำลอง'});
  assert.equal(await ended,0,errors); assert.equal(output.trim(),'คำตอบจำลอง');
});
test('timeout ends uncertain work without requeue',async t=>{
  const {call}=await fixture(t,30);
  const job=(await call('/ask',{prompt:'slow'})).body;
  await call('/api/pending_task?client=a&ready=1');
  await new Promise(r=>setTimeout(r,60));
  assert.equal((await call(`/jobs/${job.id}`)).body.status,'error');
  assert.equal((await call('/api/pending_task?client=b&ready=1')).body.task,null);
});
test('SSE receives queue notification and polling sees same pending job',async t=>{
  const {base,call}=await fixture(t);
  const abort=new AbortController();
  const response=await fetch(base+'/events',{headers:{Authorization:'Bearer test-token'},signal:abort.signal});
  const reader=response.body.getReader();
  await reader.read();
  await call('/ask',{prompt:'event'});
  const chunk=await reader.read();
  assert.match(new TextDecoder().decode(chunk.value),/event: pending/);
  assert.equal((await call('/api/pending_task?client=a&ready=1')).body.task.prompt,'event');
  abort.abort();
});

const claim=async(call,client='c')=>(await call(`/api/pending_task?client=${client}&ready=1`)).body.task;
for (const mode of ['default','buffered','json']) {
  test(`Python CLI ${mode}: partial output timing and exact final text`,{timeout:10000},async t=>{
    const root=cliHome(t);
    const {base,call}=await fixture(t);
    await call('/api/pending_task?client=stream-test&ready=1');
    const script=fileURLToPath(new URL('../scripts/gemini_argon_bridge.py',import.meta.url));
    const flags=mode==='buffered'?['--no-stream']:mode==='json'?['--stream','--json']:[];
    const python=spawn('python3',['-c',
      'import importlib.util,sys,pathlib; s=importlib.util.spec_from_file_location("bridge",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.BASE=sys.argv[2]; m.ROOT=pathlib.Path(sys.argv[3]); sys.argv=["argon","ทดสอบ","--timeout","5",*sys.argv[4:]]; sys.exit(m.main())',script,base,root,...flags]);
    t.after(()=>python.kill());
    let output='',errors='',firstChunk;
    const firstOutput=new Promise(resolve=>{firstChunk=resolve;});
    python.stdout.on('data',data=>{output+=data;firstChunk();});
    python.stderr.on('data',data=>errors+=data);
    const ended=new Promise((resolve,reject)=>{python.on('error',reject);python.on('close',resolve);});
    let task;
    for(let i=0;i<100;i++) {
      task=await claim(call,'stream-test'); if(task) break;
      await new Promise(r=>setTimeout(r,20));
    }
    assert.ok(task,'CLI submitted a job');
    await call(`/jobs/${task.id}/progress`,{claimToken:task.claimToken,phase:'generating',partial:'สวัสดี '});
    if(mode==='default') {
      let timer;
      try {
        await Promise.race([firstOutput,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Partial text was buffered until completion')),1500);})]);
      } finally {clearTimeout(timer);}
      assert.equal(output,'สวัสดี ');
      assert.equal((await call(`/jobs/${task.id}`)).body.status,'running');
    } else {
      await new Promise(r=>setTimeout(r,400)); assert.equal(output,'');
    }
    await call(`/jobs/${task.id}/progress`,{claimToken:task.claimToken,phase:'generating',partial:'สวัสดี โลก'});
    await call(`/jobs/${task.id}/response`,{claimToken:task.claimToken,text:'สวัสดี โลก!'});
    assert.equal(await ended,0,errors);
    if(mode==='json') assert.equal(JSON.parse(output).text,'สวัสดี โลก!');
    else assert.equal(output,'สวัสดี โลก!\n');
  });
}
test('progress updates phase and partial text, requires the claim token',async t=>{
  const {call}=await fixture(t);
  const job=(await call('/ask',{prompt:'q'})).body;
  const task=await claim(call);
  assert.equal((await call(`/jobs/${job.id}/progress`,{claimToken:'nope',phase:'typing'})).status,409);
  assert.equal((await call(`/jobs/${job.id}/progress`,{claimToken:task.claimToken,phase:'generating',partial:'สวัส'})).status,200);
  const seen=(await call(`/jobs/${job.id}`)).body;
  assert.equal(seen.phase,'generating'); assert.equal(seen.partial,'สวัส');
  assert.equal(seen.claimToken,undefined);
});
test('options are validated and carried to the claimed task',async t=>{
  const {call}=await fixture(t);
  assert.equal((await call('/ask',{prompt:'x',options:[]})).status,400);
  await call('/ask',{prompt:'x',options:{newChat:true,tab:' work ',force:'yes',bogus:1}});
  const task=await claim(call);
  assert.deepEqual(task.options,{newChat:true,force:false,tab:'work'});
});
test('queued jobs can be cancelled; running jobs cannot',async t=>{
  const {call}=await fixture(t);
  const a=(await call('/ask',{prompt:'a'})).body, b=(await call('/ask',{prompt:'b'})).body;
  assert.equal((await call(`/jobs/${b.id}/cancel`,{})).body.cancelled,true);
  assert.equal((await call(`/jobs/${b.id}`)).body.status,'error');
  await claim(call);
  assert.equal((await call(`/jobs/${a.id}/cancel`,{})).status,409);
});
test('doctor jobs are claimed even when Gemini is not ready; drafts need force',async t=>{
  const {call}=await fixture(t);
  await call('/ask',{prompt:'needs ready'});
  assert.equal((await call('/api/pending_task?client=c&ready=0&draft=1')).body.task,null);
  await call('/ask',{prompt:'x',options:{force:true}});
  const first=(await call('/api/pending_task?client=c&ready=0&draft=1')).body.task;
  assert.equal(first,null,'FIFO: non-force head blocks');
  const d=await fixture(t);
  await d.call('/doctor',{});
  const doctor=(await d.call('/api/pending_task?client=c&ready=0')).body.task;
  assert.equal(doctor.kind,'doctor');
  const f=await fixture(t);
  await f.call('/ask',{prompt:'draft ok',options:{force:true}});
  assert.equal((await f.call('/api/pending_task?client=c&ready=0&draft=1')).body.task.prompt,'draft ok');
});
test('health exposes tabs reported by the extension',async t=>{
  const {call}=await fixture(t);
  const tabs=encodeURIComponent(JSON.stringify([{id:7,title:'Work chat',ready:true,generating:false}]));
  await call(`/api/pending_task?client=c&ready=1&tabs=${tabs}`);
  assert.deepEqual((await call('/health')).body.clients[0].tabs,[{id:7,title:'Work chat',ready:true,generating:false}]);
});
test('history persists finished jobs and supports search',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'argon-'));
  const {call}=await fixture(t,180000,'test-token',dir);
  await call('/ask',{prompt:'หาเมืองหลวง'});
  const task=await claim(call);
  await call(`/jobs/${task.id}/response`,{claimToken:task.claimToken,text:'กรุงเทพ',model:'m'});
  const all=(await call('/history')).body.items;
  assert.equal(all.length,1); assert.equal(all[0].text,'กรุงเทพ'); assert.equal(all[0].status,'done');
  assert.equal((await call('/history?q=zzz')).body.items.length,0);
  assert.equal((await call('/history?q=เมือง')).body.items.length,1);
});
test('queued work survives a restart; running work is reported as lost',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'argon-'));
  const one=createBridge({token:'test-token',dataDir:dir});
  await new Promise(r=>one.listen(0,'127.0.0.1',r));
  const base1=`http://127.0.0.1:${one.address().port}`;
  const post=(base,path,body)=>fetch(base+path,{method:'POST',headers:{Authorization:'Bearer test-token','Content-Type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
  const get=(base,path)=>fetch(base+path,{headers:{Authorization:'Bearer test-token'}}).then(r=>r.json());
  const running=await post(base1,'/ask',{prompt:'running'}), queued=await post(base1,'/ask',{prompt:'queued'});
  await get(base1,'/api/pending_task?client=c&ready=1');
  one.closeAllConnections(); await new Promise(r=>one.close(r));
  const two=createBridge({token:'test-token',dataDir:dir});
  await new Promise(r=>two.listen(0,'127.0.0.1',r));
  t.after(()=>{two.closeAllConnections();two.close();});
  const base2=`http://127.0.0.1:${two.address().port}`;
  assert.equal((await get(base2,`/jobs/${running.id}`)).status,'error');
  assert.match((await get(base2,`/jobs/${running.id}`)).error,/restarted/);
  assert.equal((await get(base2,`/jobs/${queued.id}`)).status,'queued');
});
test('OpenAI-compatible endpoint returns the Gemini answer',async t=>{
  const {call,base}=await fixture(t);
  assert.equal((await call('/v1/chat/completions',{messages:[{role:'user',content:'hi'}]})).status,503);
  await call('/api/pending_task?client=c&ready=1');
  const pending=call('/v1/chat/completions',{model:'gemini-web',messages:[{role:'system',content:'be brief'},{role:'user',content:[{type:'text',text:'hi'}]}]});
  let task; for(let i=0;i<50&&!task;i++){task=await claim(call);if(!task)await new Promise(r=>setTimeout(r,20));}
  assert.equal(task.prompt,'system: be brief\n\nuser: hi');
  await call(`/jobs/${task.id}/response`,{claimToken:task.claimToken,text:'hello!'});
  const out=await pending;
  assert.equal(out.status,200); assert.equal(out.body.choices[0].message.content,'hello!'); assert.equal(out.body.object,'chat.completion');
  const models=await call('/v1/models'); assert.equal(models.body.data[0].id,'gemini-web');
  assert.equal((await call('/v1/chat/completions',{messages:[]})).status,400);
});
test('OpenAI streaming emits partial deltas then [DONE]',async t=>{
  const {call,base}=await fixture(t);
  await call('/api/pending_task?client=c&ready=1');
  const res=fetch(base+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer test-token','Content-Type':'application/json'},body:JSON.stringify({stream:true,messages:[{role:'user',content:'hi'}]})});
  let task; for(let i=0;i<50&&!task;i++){task=await claim(call);if(!task)await new Promise(r=>setTimeout(r,20));}
  await call(`/jobs/${task.id}/progress`,{claimToken:task.claimToken,phase:'generating',partial:'He'});
  await new Promise(r=>setTimeout(r,250));
  await call(`/jobs/${task.id}/response`,{claimToken:task.claimToken,text:'Hello'});
  const text=await (await res).text();
  const deltas=[...text.matchAll(/data: (\{.*\})\n/g)].map(m=>JSON.parse(m[1]).choices?.[0]?.delta?.content).filter(Boolean);
  assert.equal(deltas.join(''),'Hello'); assert.ok(deltas.length>=2,'expected incremental chunks');
  assert.match(text,/data: \[DONE\]/);
});
