import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createBridge} from '../bridge/server.mjs';
import {createHash} from 'node:crypto';

const binary=process.env.ARGON_HARNESS_BIN || resolve('harness/target/debug/argon-harness');
const skip=!existsSync(binary) && 'Build the Rust harness first (cargo test --manifest-path harness/Cargo.toml)';
const delay=ms=>new Promise(r=>setTimeout(r,ms));

async function setup(t) {
  const dir=mkdtempSync(join(tmpdir(),'argon-agent-'));
  const install=join(dir,'install'),workspace=join(dir,'project'),state=join(dir,'sessions');
  mkdirSync(join(install,'bridge'),{recursive:true});mkdirSync(workspace);mkdirSync(state);
  writeFileSync(join(install,'bridge/token'),'test-token\n',{mode:0o600});
  writeFileSync(join(workspace,'README.md'),'A tiny project\nEntry: app.py\n');
  writeFileSync(join(workspace,'app.py'),'print("hello")\n');
  const server=createBridge({token:'test-token'});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const api=async(path,body,lease)=>{
    const r=await fetch(base+path,{method:body===undefined?'GET':'POST',
      headers:{Authorization:'Bearer test-token','Content-Type':'application/json',...(lease?{'X-Argon-Lease':lease}:{})},
      body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  };
  const poll=()=>api('/api/pending_task?'+new URLSearchParams({client:'simulator',ready:'1',
    tabs:JSON.stringify([{id:123,ready:true,generating:false}])}));
  await poll();
  t.after(()=>{server.closeAllConnections();server.close();rmSync(dir,{recursive:true,force:true});});
  const launch=(args,pty=false)=>{
    const command=pty?'python3':binary;
    // Test-only terminal driver: approves at most two synthetic actions in this fixture.
    const driver=`import os,pty,select,subprocess,sys,time
master,slave=pty.openpty()
child=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
os.close(slave)
deadline=time.monotonic()+30
tail=b''; approvals=0
while child.poll() is None and time.monotonic()<deadline:
 if select.select([master],[],[],0.1)[0]:
  try: data=os.read(master,8192)
  except OSError: break
  sys.stdout.buffer.write(data);sys.stdout.buffer.flush()
  tail+=data
  marker='พิมพ์ yes เพื่ออนุมัติ:'.encode()
  if marker in tail and approvals<2:
   os.write(master,b'yes\\n');approvals+=1;tail=b''
if child.poll() is None: child.kill()
while select.select([master],[],[],0.1)[0]:
 try: data=os.read(master,8192)
 except OSError: break
 if not data: break
 sys.stdout.buffer.write(data)
sys.exit(child.wait())
`;
    const child=spawn(command,[...(pty?['-c',driver,binary]:[]),...args,'--state-dir',state],{cwd:workspace,
      env:{...process.env,ARGON_ROOT:install,ARGON_BRIDGE_URL:base},stdio:['pipe','pipe','pipe']});
    let out='',err='';const received=[];
    child.stdout.on('data',chunk=>{out+=chunk;received.push({at:Date.now(),text:chunk.toString()});});
    child.stderr.on('data',chunk=>err+=chunk);
    const ended=new Promise((res,rej)=>{child.on('error',rej);child.on('close',code=>res({code,out,err,received}));});
    t.after(()=>child.kill('SIGKILL'));
    return {child,ended,received};
  };
  return {dir,install,workspace,state,api,poll,launch};
}

test('Rust agent: real bridge multi-turn read, streaming, final, session fork', {skip},async t=>{
  const f=await setup(t);
  const run=f.launch(['agent','Understand this project','--json']);
  let finalPostedAt=0;
  const streamedJobs=[];
  for(let i=0;i<2;i++){
    let task;
    for(let tries=0;tries<200;tries++){
      task=(await f.poll()).body.task;
      if(task)break;
      await delay(20);
    }
    assert.ok(task,'agent submitted a model job');
    assert.equal(task.options.newChat,true);assert.equal(task.options.tab,'123');
    const nonce=task.prompt.match(/"nonce":"([^"]+)"/)?.[1];
    assert.ok(nonce);
    if(i===1)assert.match(task.prompt,/A tiny project/);
    const action=i===0?{type:'read_file',path:'README.md',start_line:1,end_line:50}:{type:'final',text:'Project overview: README.md:1; app.py is entrypoint.'};
    const response='กำลังตรวจโปรเจค\nเสร็จแล้ว\n<<<ARGON_ACTION>>>\n'+JSON.stringify({version:1,nonce,id:`call_${i}`,action})+'\n<<<END_ARGON_ACTION>>>';
    streamedJobs.push(task.id);
    for(const [count,partial] of [[1,'กำลัง'],[2,'กำลังตรวจ']]){
      await f.api(`/jobs/${task.id}/progress`,{claimToken:task.claimToken,phase:'generating',partial});
      let partialEvents=[];
      for(let tries=0;tries<200;tries++){
        partialEvents=run.received.map(chunk=>chunk.text).join('').trim().split('\n')
          .flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
        if(partialEvents.filter(e=>e.event==='assistant_delta'&&e.data.job_id===task.id&&
          e.data.job_status==='running'&&e.data.job_phase==='generating').length>=count)break;
        await delay(20);
      }
      assert.ok(partialEvents.filter(e=>e.event==='assistant_delta'&&e.data.job_id===task.id&&
        e.data.job_status==='running'&&e.data.job_phase==='generating').length>=count,
        'partial arrives while the same job is still generating');
      await delay(120);
    }
    await f.api(`/jobs/${task.id}/progress`,{claimToken:task.claimToken,phase:'generating',partial:'กำลังตรวจโปรเจค\n<<<ARGO'});
    await delay(250);
    finalPostedAt=Date.now();
    await f.api(`/jobs/${task.id}/response`,{claimToken:task.claimToken,text:response});
  }
  const result=await run.ended;
  assert.equal(result.code,0,result.err);
  const events=result.out.trim().split('\n').map(l=>JSON.parse(l));
  assert.ok(events.some(e=>e.event==='tool_result'&&e.data.status==='success'));
  assert.ok(events.some(e=>e.event==='final'));
  assert.ok(result.received.some(r=>r.at<finalPostedAt&&r.text.includes('assistant_delta')));
  assert.ok(!events.filter(e=>e.event==='assistant_delta').some(e=>e.data.text.includes('<<<')));
  for(const job of streamedJobs){
    const partials=events.filter(e=>e.event==='assistant_delta'&&e.data.job_id===job&&
      e.data.job_status==='running'&&e.data.job_phase==='generating');
    assert.ok(partials.length>=2);
    assert.ok(partials.at(-1).at_ms-partials[0].at_ms>=100);
    assert.ok(events.some(e=>e.event==='assistant_delta'&&e.data.job_id===job&&e.data.job_status==='done'),
      'text first received from completed response is labelled done');
  }
  const id=readdirSync(f.state)[0];
  const saved=JSON.parse(readFileSync(join(f.state,id,'state.json')));
  assert.equal(saved.status,'final');assert.equal(saved.pending,null);
  assert.equal((await f.api('/health')).body.agentLeased,false);
  const fork=await f.launch(['fork',id,'--task','Explain tests']).ended;
  assert.equal(fork.code,0,fork.err);
  const forked=JSON.parse(readFileSync(join(f.state,fork.out.trim(),'state.json')));
  assert.equal(forked.parent,id);assert.equal(forked.editable,false);
});

test('Rust agent: malformed JSON receives concrete repair feedback before any tool execution', {skip},async t=>{
  const f=await setup(t);
  const run=f.launch(['agent','Explain this project','--json']);
  for(let turn=0;turn<2;turn++){
    let task;
    for(let tries=0;tries<200;tries++){
      task=(await f.poll()).body.task;
      if(task)break;
      await delay(20);
    }
    assert.ok(task);
    const nonce=task.prompt.match(/"nonce":"([^"]+)"/)[1];
    if(turn===1){
      assert.match(task.prompt,/Invalid action schema:/);
      assert.match(task.prompt,/line 1 column/);
    }
    const response=turn===0
      ? `<<<ARGON_ACTION>>>{"version":1,"nonce":"${nonce}","id":"broken","action":{"type":"final","text":"bad "quote""}}<<<END_ARGON_ACTION>>>`
      : '<<<ARGON_ACTION>>>'+JSON.stringify({version:1,nonce,id:'repaired',action:{type:'final',text:'Repaired safely.'}})+'<<<END_ARGON_ACTION>>>';
    await f.api(`/jobs/${task.id}/response`,{claimToken:task.claimToken,text:response});
  }
  const result=await run.ended;
  assert.equal(result.code,0,result.err);
  const events=result.out.trim().split('\n').map(l=>JSON.parse(l));
  assert.equal(events.filter(e=>e.event==='protocol_error').length,1);
  assert.equal(events.filter(e=>e.event==='tool_started').length,0);
  assert.equal(events.find(e=>e.event==='final').data.text,'Repaired safely.');
});

test('Rust agent: read-only command is denied without executing it', {skip},async t=>{
  const f=await setup(t);
  const run=f.launch(['agent','Inspect project','--max-turns','1','--json']);
  let task;
  for(let i=0;i<200;i++){task=(await f.poll()).body.task;if(task)break;await delay(20);}
  assert.ok(task);
  const nonce=task.prompt.match(/"nonce":"([^"]+)"/)[1];
  await f.api(`/jobs/${task.id}/response`,{claimToken:task.claimToken,
    text:'<<<ARGON_ACTION>>>'+JSON.stringify({version:1,nonce,id:'unsafe',action:{type:'run_command',argv:['touch','BAD'],timeout_s:1}})+'<<<END_ARGON_ACTION>>>'});
  const result=await run.ended;
  assert.ok(!existsSync(join(f.workspace,'BAD')));
  assert.match(result.out,/Read-only mode/);
  const id=readdirSync(f.state)[0];
  const saved=JSON.parse(readFileSync(join(f.state,id,'state.json')));
  assert.equal(saved.status,'budget');
});

test('Rust agent: pending model intent is not replayed on resume', {skip},async t=>{
  const f=await setup(t);
  const run=f.launch(['agent','Inspect project','--json']);
  let task;
  for(let i=0;i<200;i++){task=(await f.poll()).body.task;if(task)break;await delay(20);}
  assert.ok(task);
  run.child.kill('SIGKILL');await run.ended;
  const id=readdirSync(f.state)[0];
  const resumed=await f.launch(['resume',id,'--json']).ended;
  assert.notEqual(resumed.code,0);assert.match(resumed.err,/uncertain unfinished intent/);
  assert.equal((await f.api('/health')).body.queue,1);
});

test('Rust agent: approved read/edit/test/final loop preserves actual test result', {skip:skip || process.platform==='win32'},async t=>{
  const f=await setup(t);
  const run=f.launch(['agent','Change hello to welcome and test it','--allow-edit','--allow-commands',
    ...(process.platform==='darwin'?[]:['--no-sandbox'])],true);
  const hash=createHash('sha256').update('print("hello")\n').digest('hex');
  const actions=[
    {type:'read_file',path:'app.py',start_line:1,end_line:30},
    {type:'edit_file',path:'app.py',sha256:hash,old_text:'hello',new_text:'welcome'},
    {type:'run_command',argv:process.platform==='darwin'
      ?['/bin/sh','-c','/usr/bin/grep -q welcome app.py && printf "TEST_OK\\n"']
      :['python3','-I','-c','from pathlib import Path; assert "welcome" in Path("app.py").read_text(); print("TEST_OK")'],timeout_s:3},
    {type:'final',text:'Changed app.py; approved test exited 0 and printed TEST_OK.'},
  ];
  for(let index=0;index<actions.length;index++){
    let task;
    for(let tries=0;tries<300;tries++){task=(await f.poll()).body.task;if(task)break;await delay(20);}
    assert.ok(task,`model turn ${index}`);
    if(index===3)assert.match(task.prompt,/"success":true/);
    const nonce=task.prompt.match(/"nonce":"([^"]+)"/)[1];
    await f.api(`/jobs/${task.id}/response`,{claimToken:task.claimToken,
      text:'<<<ARGON_ACTION>>>'+JSON.stringify({version:1,nonce,id:`step_${index}`,action:actions[index]})+'<<<END_ARGON_ACTION>>>'});
  }
  const result=await run.ended;
  assert.equal(result.code,0,result.err+result.out);
  assert.equal(readFileSync(join(f.workspace,'app.py'),'utf8'),'print("welcome")\n');
  const state=JSON.parse(readFileSync(join(f.state,readdirSync(f.state)[0],'state.json')));
  assert.equal(state.calls.step_2.result.data.exit_code,0);
  assert.equal(state.calls.step_2.result.data.stdout.trim(),'TEST_OK');
  assert.equal(state.command_sandbox,process.platform==='darwin');
  assert.equal(state.status,'final');
});
