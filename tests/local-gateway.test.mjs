import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createBridge} from '../bridge/server.mjs';
import {validateLocalProviders, resolveLocalModel} from '../bridge/local-gateway.mjs';

async function listening(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {server.closeAllConnections(); server.close();});
  return 'http://127.0.0.1:' + server.address().port;
}
async function fixture(t) {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, {'Content-Type': 'application/json'});
      return res.end(JSON.stringify({data:[{id:'qwen/test:small', object:'model'}]}));
    }
    if (req.url !== '/v1/chat/completions') {res.writeHead(404); return res.end();}
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    seen.push({request, authorization:req.headers.authorization});
    if (request.stream) {
      res.writeHead(200, {'Content-Type':'text/event-stream'});
      res.write('data: ' + JSON.stringify({model:'qwen/test:small', choices:[{index:0,delta:{content:'Hello'},finish_reason:null}]}) + '\n\n');
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({model:'qwen/test:small', choices:[{message:{role:'assistant',content:'Local OK'}}]}));
    }
  });
  const localUrl = await listening(t, upstream);
  const bridge = createBridge({token:'test-secret', localProviders:[{name:'ollama',url:localUrl, token:'runtime-secret'}]});
  const base = await listening(t, bridge);
  async function call(path, body, token='test-secret') {
    const response = await fetch(base+path, {
      method:body === undefined ? 'GET' : 'POST',
      headers:{Authorization:'Bearer '+token, 'Content-Type':'application/json'},
      body:body === undefined ? undefined : JSON.stringify(body),
    });
    return {status:response.status, body:await response.json()};
  }
  return {base, call, seen};
}

test('local model discovery is prefixed and independent of Gemini readiness', async t => {
  const {call}=await fixture(t);
  const health=await call('/health');
  assert.equal(health.body.ready, false);
  const models=await call('/v1/models');
  assert.equal(models.status,200);
  assert.deepEqual(models.body.data.map(m=>m.id), ['gemini-web','ollama/qwen/test:small']);
  assert.equal((await call('/v1/models',undefined,'bad')).status,401);
});

test('local completions preserve messages and never relay gateway bearer token', async t => {
  const {call,seen}=await fixture(t);
  const messages=[{role:'system',content:'Be brief'},{role:'user',content:'Hello'}];
  const completion=await call('/v1/chat/completions', {
    model:'ollama/qwen/test:small', messages, temperature:0.2, argon_tab:'ignored',
  });
  assert.equal(completion.status,200);
  assert.equal(completion.body.model,'ollama/qwen/test:small');
  assert.equal(completion.body.choices[0].message.content,'Local OK');
  assert.deepEqual(seen[0].request.messages,messages);
  assert.equal(seen[0].request.model,'qwen/test:small');
  assert.equal(seen[0].request.argon_tab,undefined);
  assert.equal(seen[0].authorization,'Bearer runtime-secret');
  assert.equal((await call('/v1/chat/completions',{model:'unknown',messages})).status,404);
  assert.equal((await call('/v1/chat/completions',{model:'ollama/x',messages:[]})).status,400);
  assert.equal((await call('/v1/chat/completions',{model:'ollama/qwen/test:small',messages},'bad')).status,401);
});

test('local SSE streams through the gateway without a Gemini browser session', async t => {
  const {base,seen}=await fixture(t);
  const response=await fetch(base+'/v1/chat/completions',{
    method:'POST', headers:{Authorization:'Bearer test-secret','Content-Type':'application/json'},
    body:JSON.stringify({model:'ollama/qwen/test:small',messages:[{role:'user',content:'Hi'}],stream:true}),
  });
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/text\/event-stream/);
  const content=await response.text();
  assert.match(content,/Hello/);
  assert.match(content,/data: \[DONE\]/);
  assert.equal(seen[0].request.model,'qwen/test:small');
});

test('Gemini lease does not block local requests, but still protects Gemini requests', async t => {
  const {call}=await fixture(t);
  await call('/api/pending_task?client=test&ready=1&tabs=%5B%7B%22id%22%3A1%2C%22ready%22%3Atrue%7D%5D');
  const lease=await call('/agent/lease',{action:'acquire',session:'agent',tab:1});
  assert.equal(lease.status,200);
  const messages=[{role:'user',content:'hi'}];
  assert.equal((await call('/v1/chat/completions',{model:'gemini-web',messages})).status,409);
  assert.equal((await call('/v1/chat/completions',{model:'ollama/qwen/test:small',messages})).status,200);
});

test('provider URLs are restricted to literal loopback origins', () => {
  for (const url of [
    'https://127.0.0.1:11434', 'http://localhost:11434',
    'http://169.254.169.254:80', 'http://127.0.0.1:11434/redirect',
    'http://user:password@127.0.0.1:11434',
    'http://127.0.0.1:11434/?next=http://example.com',
  ]) assert.throws(() => validateLocalProviders([{name:'ollama',url}]));
  assert.throws(() => validateLocalProviders([{name:'x',url:'http://127.0.0.1:1'},{name:'x',url:'http://127.0.0.1:2'}]));
  assert.equal(resolveLocalModel('ollama/model',[]),null);
});

test('unavailable local runtime does not suppress the Gemini model', async t => {
  const server=createBridge({token:'t',localProviders:[{name:'ollama',url:'http://127.0.0.1:1'}]});
  const base=await listening(t,server);
  const r=await fetch(base+'/v1/models',{headers:{Authorization:'Bearer t'}});
  assert.deepEqual((await r.json()).data.map(x=>x.id),['gemini-web']);
});
