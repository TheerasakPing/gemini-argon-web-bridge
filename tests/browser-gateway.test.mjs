import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join, resolve} from 'node:path';
import {createBridge} from '../bridge/server.mjs';
import {openAIProviderFromEnv} from '../bridge/cloud-gateway.mjs';
import {BROWSER_SITES, getBrowserSite} from '../bridge/browser-sites.mjs';
import {parseBrowserArgs, browserLaunchPlan, browserProfilePath} from '../scripts/browser-gateway.mjs';

const launcher=fileURLToPath(new URL('../scripts/browser-gateway.mjs',import.meta.url));
const start=async(t,server)=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  return 'http://127.0.0.1:'+server.address().port;
};

test('site capability registry distinguishes allowed browser relay from manual ChatGPT site',()=>{
  assert.equal(getBrowserSite('gemini').browserRelay,true);
  assert.equal(getBrowserSite('gemini').headless,true);
  assert.equal(getBrowserSite('chatgpt').browserRelay,false);
  assert.equal(getBrowserSite('chatgpt').headless,false);
  assert.equal(getBrowserSite('__proto__'),null);
  assert.equal(getBrowserSite('https://untrusted.example'),null);
  assert.ok(Object.isFrozen(BROWSER_SITES));
});

test('headless launcher options fail closed on unsupported sites or ChatGPT automated relay',()=>{
  assert.deepEqual(parseBrowserArgs(['--site=gemini','--headless']),{site:'gemini',mode:'headless',check:false,help:false});
  assert.equal(parseBrowserArgs(['--headed','--site=chatgpt']).mode,'headed');
  assert.throws(()=>parseBrowserArgs(['--site=chatgpt','--headless']),/not available/);
  assert.throws(()=>parseBrowserArgs(['--site=evil.example']),/Unsupported/);
  assert.throws(()=>parseBrowserArgs(['--no-sandbox']),/Unknown option/);
});

test('browser creates a separate Argon-owned profile and never points to personal Chrome profile',()=>{
  const opts=parseBrowserArgs(['--headed','--site=gemini','--check']);
  const p=browserProfilePath('gemini',{ARGON_BROWSER_PROFILE_ROOT:'/tmp/argon-isolated'},'linux','/home/person');
  assert.equal(p,join(resolve('/tmp/argon-isolated'),'gemini'));
  assert.notEqual(p,join(resolve('/tmp/argon-isolated'),'chatgpt'));
  const spec=browserLaunchPlan(opts,{root:'/tmp/argon-project',env:{ARGON_BROWSER_PROFILE_ROOT:'/tmp/argon-isolated'},platform:'linux',home:'/home/person'});
  assert.equal(spec.profile,p);
  assert.equal(spec.browserRelay,true);
  assert.equal(spec.extensionAvailable,false);
});

test('CLI configuration check does not need Playwright, network, browser or a login',()=>{
  const proc=spawnSync(process.execPath,[launcher,'--site=chatgpt','--check'],{encoding:'utf8'});
  assert.equal(proc.status,0,proc.stderr);
  const result=JSON.parse(proc.stdout);
  assert.equal(result.status,'configuration-only');
  assert.equal(result.site,'chatgpt');
  assert.equal(result.browserRelay,false);
  assert.equal(result.hasProfile,typeof result.hasProfile==='boolean'?result.hasProfile:false);
  const denied=spawnSync(process.execPath,[launcher,'--site=chatgpt','--headless'],{encoding:'utf8'});
  assert.notEqual(denied.status,0);
  assert.match(denied.stderr,/not available/);
});

test('official OpenAI provider uses a fixed API origin and separate API secret',()=>{
  assert.deepEqual(openAIProviderFromEnv({}),[]);
  assert.deepEqual(openAIProviderFromEnv({ARGON_OPENAI_API_KEY:'sk-test-only'}),[
    {name:'openai',baseUrl:'https://api.openai.com',token:'sk-test-only'}
  ]);
  assert.throws(()=>openAIProviderFromEnv({ARGON_OPENAI_API_KEY:'line1\nline2'}),/single-line/);
});

test('cloud route can stream and authenticate upstream while never forwarding Argon token',async t=>{
  const upstreamCalls=[];
  const upstream=http.createServer(async(req,res)=>{
    upstreamCalls.push({url:req.url,authorization:req.headers.authorization});
    if(req.url==='/v1/models'){
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({data:[{id:'api-model'}]}));
      return;
    }
    let raw='';for await (const c of req) raw+=c;
    const body=JSON.parse(raw);upstreamCalls.at(-1).body=body;
    if(body.stream){
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.end('data: '+JSON.stringify({choices:[{delta:{content:'API result'}}]})+'\n\ndata: [DONE]\n\n');
      return;
    }
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({model:body.model,choices:[{message:{role:'assistant',content:'API result'}}]}));
  });
  const upstreamBase=await start(t,upstream);
  const cloudProviders=[{name:'openai',baseUrl:upstreamBase,token:'upstream-key'}];
  const bridge=createBridge({token:'argon-secret',localProviders:[],cloudProvidersOverride:cloudProviders});
  const base=await start(t,bridge);
  const headers={Authorization:'Bearer argon-secret','Content-Type':'application/json'};
  const sites=await fetch(base+'/v1/browser/sites',{headers});
  assert.equal(sites.status,200);
  const sitePayload=await sites.json();
  assert.equal(sitePayload.data.find(x=>x.id==='chatgpt').browserRelay,false);
  assert.equal(sitePayload.openAIConfigured,true);
  assert.equal((await fetch(base+'/v1/browser/sites')).status,401);
  const models=await (await fetch(base+'/v1/models',{headers})).json();
  assert.deepEqual(models.data.map(x=>x.id),['gemini-web','openai/api-model']);
  const payload={model:'openai/api-model',messages:[{role:'user',content:'hi'}],stream:false,argon_tab:'private-browser-only'};
  let response=await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify(payload)});
  assert.equal(response.status,200);
  assert.equal((await response.json()).model,'openai/api-model');
  const sent=upstreamCalls.find(c=>c.url==='/v1/chat/completions');
  assert.equal(sent.authorization,'Bearer upstream-key');
  assert.equal(sent.body.model,'api-model');
  assert.equal(sent.body.argon_tab,undefined);
  response=await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({...payload,stream:true})});
  assert.equal(response.status,200);
  assert.match(await response.text(),/data: \[DONE\]/);
  response=await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model:'chatgpt-web',messages:payload.messages})});
  assert.equal(response.status,404,'unapproved browser model must not masquerade as supported');
});
