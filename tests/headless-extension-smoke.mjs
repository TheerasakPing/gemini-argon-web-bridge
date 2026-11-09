// Real Playwright Chromium (new headless) smoke. No account, network login or scraping.
import assert from 'node:assert/strict';
import {cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const tmp=mkdtempSync(join(tmpdir(),'argon-headless-smoke-'));
const ext=join(tmp,'extension'), profile=join(tmp,'profile');
let context;
try {
  cpSync(join(ROOT,'extension'),ext,{recursive:true});
  writeFileSync(join(ext,'config.js'),'const ARGON_TOKEN = "ci-placeholder-token";\n',{mode:0o600});
  mkdirSync(profile,{recursive:true,mode:0o700});
  context=await chromium.launchPersistentContext(profile,{
    channel:'chromium',
    headless:true,
    args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`],
    serviceWorkers:'allow',
  });
  const worker=context.serviceWorkers().find(w=>w.url().startsWith('chrome-extension://')) ||
    await context.waitForEvent('serviceworker',{timeout:15000});
  assert.ok(worker.url().startsWith('chrome-extension://'),'Manifest V3 extension worker must start');
  const manifest=await worker.evaluate(()=>chrome.runtime.getManifest());
  assert.match(manifest.name,/Argon/);
  const page=context.pages()[0]||await context.newPage();
  await page.route('https://gemini.google.com/**',route=>route.fulfill({
    status:200,
    contentType:'text/html',
    body:'<!doctype html><html><head><title>Offline Gemini Fixture</title></head><body><h1>Offline fixture</h1></body></html>',
  }));
  await page.goto('https://gemini.google.com/app',{waitUntil:'domcontentloaded'});
  let state=null;
  for(let i=0;i<30;i++){
    try {
      state=await worker.evaluate(async()=>{
        const [tab]=await chrome.tabs.query({url:'https://gemini.google.com/*'});
        if(!tab) return null;
        return chrome.tabs.sendMessage(tab.id,{type:'argon:ping'});
      });
      if(state?.documentId) break;
    } catch { /* Content script may not yet be injected. */ }
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.equal(typeof state?.documentId,'string');
  assert.equal(state?.ready,false,'No real composer exists in the local fixture');
  console.log('PASS: Chromium headless launched Manifest V3 extension and content script pinged mock Gemini page');
} finally {
  await context?.close().catch(()=>{});
  rmSync(tmp,{recursive:true,force:true});
}
