import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createBridge} from '../bridge/server.mjs';

const binary=process.env.ARGON_HARNESS_BIN || resolve('harness/target/debug/argon-harness');
const skip=!existsSync(binary) && 'Build Rust harness before running recovery integration';
const delay=ms=>new Promise(r=>setTimeout(r,ms));

test('recover reconciles completed job and resumes durable final without another model submission',{skip},async t=>{
  const dir=mkdtempSync(join(tmpdir(),'argon-recover-'));
  const root=join(dir,'install'),workspace=join(dir,'project'),state=join(dir,'sessions');
  mkdirSync(join(root,'bridge'),{recursive:true});mkdirSync(workspace);mkdirSync(state);
  writeFileSync(join(root,'bridge/token'),'test-token\n');
  writeFileSync(join(workspace,'README.md'),'recovery fixture\n');
  const server=createBridge({token:'test-token',dataDir:join(root,'bridge')});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(()=>{server.closeAllConnections();server.close();rmSync(dir,{recursive:true,force:true});});
  const api=async(path,body)=>{
    const r=await fetch(base+path,{method:body===undefined?'GET':'POST',
      headers:{Authorization:'Bearer test-token','Content-Type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body)});
    return {code:r.status,data:await r.json()};
  };
  const poll=()=>api('/api/pending_task?'+new URLSearchParams({client:'recovery',
    ready:'1',tabs:JSON.stringify([{id:123,ready:true,generating:false}])}));
  await poll();
  const launch=args=>{
    const child=spawn(binary,[...args,'--state-dir',state],{cwd:workspace,
      env:{...process.env,ARGON_ROOT:root,ARGON_BRIDGE_URL:base},stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
    const ended=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve({code,out,err}));});
    t.after(()=>child.kill('SIGKILL'));return {child,ended};
  };
  const active=launch(['agent','Explain fixture','--json']);
  let task;
  for(let i=0;i<200;i++){task=(await poll()).data.task;if(task)break;await delay(20);}
  assert.ok(task);
  // Ensure job id is durable before crash; submit can return just before the state write.
  let id,saved;
  for(let i=0;i<100;i++){
    id=readdirSync(state)[0];
    if(id){saved=JSON.parse(readFileSync(join(state,id,'state.json')));if(saved.pending?.kind==='model_job')break;}
    await delay(10);
  }
  assert.equal(saved.pending.kind,'model_job');
  active.child.kill('SIGKILL');await active.ended;
  const nonce=task.prompt.match(/"nonce":"([^"]+)"/)[1];
  const answer='<<<ARGON_ACTION>>>'+JSON.stringify({version:1,nonce,id:'final_recovered',
    action:{type:'final',text:'Recovered original response.'}})+'<<<END_ARGON_ACTION>>>';
  assert.equal((await api(`/jobs/${task.id}/response`,{claimToken:task.claimToken,text:answer})).code,200);
  const inspect=await launch(['recover',id,'--json']).ended;
  assert.equal(inspect.code,0,inspect.err);
  assert.equal(JSON.parse(inspect.out).resolution,'completed_response_available');
  assert.equal(JSON.parse(readFileSync(join(state,id,'state.json'))).pending.kind,'model_job');
  const reconciled=await launch(['recover',id,'--reconcile','--json']).ended;
  assert.equal(reconciled.code,0,reconciled.err);
  assert.equal(JSON.parse(readFileSync(join(state,id,'state.json'))).pending.kind,'model_answer');
  const result=await launch(['resume',id,'--json']).ended;
  assert.equal(result.code,0,result.err);
  assert.match(result.out,/Recovered original response/);
  saved=JSON.parse(readFileSync(join(state,id,'state.json')));
  assert.equal(saved.status,'final');assert.equal(saved.turns,1);assert.equal(saved.pending,null);
  assert.equal((await api('/health')).data.queue,0);
  assert.equal((await api('/history?limit=20')).data.items.length,1);
});
