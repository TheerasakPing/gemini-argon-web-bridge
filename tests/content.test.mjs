import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../extension/content.js',import.meta.url),'utf8');
function fixture({draft='',generating=false,hiddenStop=null,hiddenStopParent=null,paragraphs=false,changingStatus=false,onTick,initialPath='/app/owned',newQueries}={}) {
  let listener, clicks=0, ticks=0, now=1000, delivered; const messages=[]; const inserted=[];
  const result=new Promise(resolve=>{delivered=resolve;});
  const node={getClientRects:()=>[{}]};
  const hidden={...node,style:hiddenStop,parentElement:hiddenStopParent ? {...node,style:hiddenStopParent}:null};
  const input={...node,innerText:draft,focus(){},dispatchEvent(){}};
  const old={...node,innerText:'OLD ANSWER'};
  const body={...node,closest:()=>null,contains(other){return other===nested;},
    get innerText(){return changingStatus
      ? ticks<3 ? '' : ticks<4 ? 'NEW answer ' : 'NEW answer FINAL'
      : ticks<4 ? 'partial' : 'NEW ANSWER';}};
  const nested={...node,closest:()=>null,contains:()=>false,get innerText(){return body.innerText;}};
  const second={...node,closest:()=>null,contains:()=>false,
    get innerText(){return ticks<4 ? '' : 'SECOND PANEL\ncode and table';}};
  const thought={...node,closest:()=>node,contains:()=>false,innerText:'private status'};
  const fresh={...node,
    get innerText(){return `Drafting ${ticks}...\nGemini บอกว่า\n${body.innerText}`;},
    querySelectorAll(selector){return selector==='model-response' ? [] : changingStatus ? [body,nested,second,thought] : [body,nested];}};
  const button={...node,disabled:false,getAttribute:()=>null,click(){clicks++;input.innerText='';}};
  const events = {};
  const location = {origin:'https://gemini.google.com',pathname:initialPath,search:''};
  const context=vm.createContext({
    Date:class extends Date {static now(){return now;}},
    setTimeout(fn,ms){now+=ms;ticks++;onTick?.({ticks,location,input,events});queueMicrotask(fn);},
    location,
    addEventListener(name,fn){events[name]=fn;},
    InputEvent:class {},
    getComputedStyle(el){return {display:'block',visibility:'visible',opacity:'1',...el.style};},
    window:{getSelection:()=>({removeAllRanges(){},addRange(){}})},
    document:{
      querySelectorAll(selector){
        if(selector.startsWith('rich-textarea')) return [input];
        if(selector.startsWith('button.stop')) return generating || (clicks && ticks<3) ? [node] : (hiddenStop || hiddenStopParent) ? [hidden]:[];
        if(selector.startsWith('button.send')) return [button];
        if(selector==='model-response') return clicks ? [old,fresh]:[old];
        if(selector==='user-query') return clicks
          ? newQueries ? newQueries(ticks) : [{innerText:inserted[0]}] : [];
        return [];
      },
      createRange:()=>({selectNodeContents(){}}),
      execCommand(_cmd,_ui,text){inserted.push(text);input.innerText=paragraphs?text.replace(/\n/g,'\n\n'):text;return true;}
    },
    chrome:{runtime:{onMessage:{addListener(fn){listener=fn;}},async sendMessage(message){messages.push(message);if(message.type==='argon:result') delivered(message);return {accepted:true};}}}
  });
  vm.runInContext(source,context);
  return {messages,inserted,input,send(message){let response;listener(message,{},r=>{response=r;});return response;},result,get clicks(){return clicks;},context};
}
test('Stop inside a transparent container does not mark Gemini busy',()=>{
  const f=fixture({hiddenStopParent:{opacity:'0'}});
  assert.equal(f.send({type:'argon:ping'}).ready,true);
});
test('content sends once despite duplicate delivery and extracts only the new completed response',async()=>{
  const f=fixture(); const task={id:'one',prompt:'hello',deadline:170000};
  f.send({type:'argon:run',task}); f.send({type:'argon:run',task});
  assert.equal((await f.result).result.text,'NEW ANSWER');
  assert.equal(f.clicks,1);
  vm.runInContext(source,f.context);
  f.send({type:'argon:run',task}); assert.equal(f.clicks,1);
});
test('content refuses to overwrite a user draft',async()=>{
  const f=fixture({draft:'my unsent draft'});
  assert.equal(f.send({type:'argon:ping'}).ready,false);
  f.send({type:'argon:run',task:{id:'draft',prompt:'hello',deadline:170000}});
  assert.match((await f.result).result.error,/unsent draft/); assert.equal(f.clicks,0);
});
test('content refuses submission while another response is generating',async()=>{
  const f=fixture({generating:true});
  f.send({type:'argon:run',task:{id:'busy',prompt:'hello',deadline:170000}});
  assert.match((await f.result).result.error,/generating another/); assert.equal(f.clicks,0);
});
for (const style of [{visibility:'hidden'},{visibility:'collapse'},{opacity:'0'},{display:'none'}]) {
  test(`hidden Stop button does not block readiness or completion: ${JSON.stringify(style)}`,async()=>{
    const f=fixture({hiddenStop:style});
    assert.equal(f.send({type:'argon:ping'}).ready,true);
    f.send({type:'argon:run',task:{id:'hidden',prompt:'hello',deadline:170000}});
    assert.equal((await f.result).result.text,'NEW ANSWER');
    assert.equal(f.clicks,1);
  });
}

test('progress reports typing -> sending -> generating -> finishing with partial text',async()=>{
  const f=fixture();
  f.send({type:'argon:run',task:{id:'p1',prompt:'hello',deadline:170000}});
  await f.result;
  const phases=f.messages.filter(m=>m.type==='argon:progress').map(m=>m.phase);
  for (const phase of ['typing','sending','generating','finishing']) assert.ok(phases.includes(phase),`missing ${phase}: ${phases}`);
  assert.ok(phases.indexOf('typing')<phases.indexOf('sending'));
  assert.ok(phases.indexOf('sending')<phases.indexOf('generating'));
  assert.ok(phases.indexOf('generating')<phases.indexOf('finishing'));
  assert.ok(f.messages.some(m=>m.type==='argon:progress'&&m.partial==='NEW ANSWER'));
});
test('changing thought headings never enter the stream; all answer panels are preserved once',async()=>{
  const f=fixture({changingStatus:true});
  f.send({type:'argon:run',task:{id:'status',prompt:'hello',deadline:170000}});
  const result=await f.result;
  const progress=f.messages.filter(m=>m.type==='argon:progress');
  assert.ok(progress.some(m=>m.phase==='generating' && m.partial==='NEW answer'));
  assert.ok(progress.every(m=>!/(Drafting|Gemini บอกว่า|private status)/.test(m.partial||'')));
  assert.equal(result.result.text,'NEW answer FINAL\n\nSECOND PANEL\ncode and table');
  assert.ok(f.messages.findIndex(m=>m.type==='argon:progress' && m.partial?.startsWith('NEW ')) <
    f.messages.findIndex(m=>m.type==='argon:result'));
});
test('force stashes an unsent draft, sends the prompt, then restores the draft',async()=>{
  const f=fixture({draft:'my unsent draft'});
  assert.deepEqual({ready:f.send({type:'argon:ping'}).ready,draft:f.send({type:'argon:ping'}).draft},{ready:false,draft:true});
  f.send({type:'argon:run',task:{id:'force',prompt:'hello',deadline:170000,options:{force:true}}});
  const delivered=await f.result;
  assert.equal(delivered.result.text,'NEW ANSWER');
  assert.equal(f.clicks,1);
  assert.deepEqual(f.inserted,['hello','my unsent draft']);
});
test('doctor reports which selectors resolve',()=>{
  const report=fixture().send({type:'argon:doctor'});
  assert.equal(report.editor,true); assert.equal(report.send,true); assert.equal(report.stop,false);
});

test('multi-line prompts survive the composer turning newlines into paragraphs',async()=>{
  const f=fixture({paragraphs:true});
  f.send({type:'argon:run',task:{id:'ml',prompt:'อธิบายโค้ด\n\ndef add(a,b):\n    return a+b',deadline:170000}});
  const delivered=await f.result;
  assert.equal(delivered.result.text,'NEW ANSWER'); assert.equal(f.clicks,1);
});
test('conversation navigation mid-generation discards unrelated answer and stops partials',async()=>{
  const f=fixture({onTick({ticks,location}){if(ticks===4)location.pathname='/app/unrelated';}});
  f.send({type:'argon:run',task:{id:'navigation',prompt:'hello',deadline:170000}});
  const {result}=await f.result;
  assert.match(result.error,/conversation changed/);
  assert.equal(result.text,undefined);
  assert.ok(!f.messages.some(m=>m.type==='argon:progress' && m.partial==='NEW ANSWER'));
});
test('pagehide mid-generation discards result even if URL remains the same',async()=>{
  const f=fixture({onTick({ticks,events}){if(ticks===4)events.pagehide();}});
  f.send({type:'argon:run',task:{id:'reload',prompt:'hello',deadline:170000}});
  assert.match((await f.result).result.error,/document reloaded/);
});
test('dispatch bound to another document never inserts or sends prompt',async()=>{
  const f=fixture();
  f.send({type:'argon:run',task:{id:'stale',documentId:'previous-document',prompt:'hello',deadline:170000}});
  assert.match((await f.result).result.error,/document reloaded/);
  assert.equal(f.clicks,0);assert.equal(f.inserted.length,0);
});
test('fresh chat accepts one assigned conversation URL only with its own prompt echo',async()=>{
  const f=fixture({initialPath:'/app',newQueries:()=>[{innerText:'hello'}],
    onTick({ticks,location}){if(ticks===2)location.pathname='/app/created';}});
  f.send({type:'argon:run',task:{id:'created',prompt:'hello',deadline:170000}});
  assert.equal((await f.result).result.text,'NEW ANSWER');
});
test('fresh chat does not accept a URL transition containing someone else’s prompt',async()=>{
  const f=fixture({initialPath:'/app',newQueries:()=>[{innerText:'unrelated question'}],
    onTick({ticks,location}){if(ticks===2)location.pathname='/app/wrong';}});
  f.send({type:'argon:run',task:{id:'wrong',prompt:'hello',deadline:170000}});
  assert.match((await f.result).result.error,/different user prompt/);
});
test('fresh chat verifies rendered paragraph boundaries instead of concatenated textContent',async()=>{
  const prompt='Understand this project.\nRead README.md first.\nList the source files.';
  const query={querySelector:()=>({
    textContent:'Understand this project.Read README.md first.List the source files.',
    innerText:'Understand this project.\n\nRead README.md first.\n\nList the source files.'
  })};
  const f=fixture({initialPath:'/app',newQueries:()=>[query],
    onTick({ticks,location}){if(ticks===2)location.pathname='/app/created';}});
  f.send({type:'argon:run',task:{id:'paragraph-echo',prompt,deadline:170000}});
  assert.equal((await f.result).result.text,'NEW ANSWER');
});
test('rendered prompt mismatch is rejected even when textContent matches',async()=>{
  const query={querySelector:()=>({textContent:'hello',innerText:'another prompt'})};
  const f=fixture({newQueries:()=>[query]});
  f.send({type:'argon:run',task:{id:'rendered-mismatch',prompt:'hello',deadline:170000}});
  assert.match((await f.result).result.error,/different user prompt/);
});
test('prompt echo without innerText uses exact textContent fallback',async()=>{
  const f=fixture({newQueries:()=>[{textContent:'hello'}]});
  f.send({type:'argon:run',task:{id:'text-fallback',prompt:'hello',deadline:170000}});
  assert.equal((await f.result).result.text,'NEW ANSWER');
});
test('empty rendered echo cannot hide a mismatched textContent prompt',async()=>{
  const f=fixture({newQueries:()=>[{innerText:'  ',textContent:'another prompt'}]});
  f.send({type:'argon:run',task:{id:'empty-rendered',prompt:'hello',deadline:170000}});
  assert.match((await f.result).result.error,/different user prompt/);
  assert.ok(!f.messages.some(m=>m.type==='argon:progress' && m.partial));
});
test('missing or empty prompt echo never emits an answer on the same URL',async()=>{
  for(const queries of [[],[{innerText:'',textContent:''}]]) {
    const f=fixture({newQueries:()=>queries});
    f.send({type:'argon:run',task:{id:'missing-echo',prompt:'hello',deadline:9000}});
    assert.match((await f.result).result.error,/timed out/);
    assert.ok(!f.messages.some(m=>m.type==='argon:progress' && m.partial));
  }
});
for (const changed of [false,true]) {
  test(`long paragraph/code echo ${changed ? 'rejects one changed word' : 'matches rendered whitespace'}`,async()=>{
    const prompt=Array.from({length:40},(_,i)=>`Section ${i}\nRead file_${i}.py.\n    return a + b`).join('\n\n');
    const rendered=(changed ? prompt.replace('file_20.py','other_20.py') : prompt).replace(/\n/g,'\n\n');
    const f=fixture({newQueries:()=>[{querySelector:()=>({
      textContent:rendered.replace(/\n/g,''),innerText:rendered
    })}]});
    f.send({type:'argon:run',task:{id:`long-${changed}`,prompt,deadline:170000}});
    const {result}=await f.result;
    if(changed) assert.match(result.error,/different user prompt/);
    else assert.equal(result.text,'NEW ANSWER');
  });
}
