#!/usr/bin/env node
// Playwright Chromium launcher for the Argon browser bridge.
// Playwright is an optional runtime dependency. No browser cookies are copied.
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {BROWSER_SITES, getBrowserSite} from '../bridge/browser-sites.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELP = `Usage: node scripts/browser-gateway.mjs [--site=gemini|chatgpt] [--headed|--headless] [--check]

--headed      Visible Chromium browser, intended for interactive sign-in and testing
--headless    Persistent headless Chromium (Gemini extension bridge only, default)
--site=...    Select allowlisted website (gemini by default)
--check       Validate configuration without launching a browser
--help        Show this help

Optional: npm install --no-save playwright && npx playwright install chromium
No passwords, CAPTCHA responses or cookies are collected by Argon.
`;

export function parseBrowserArgs(args) {
  const opts = {site:'gemini', mode:'headless', check:false, help:false};
  for (const arg of args) {
    if (arg === '--headless') opts.mode = 'headless';
    else if (arg === '--headed') opts.mode = 'headed';
    else if (arg === '--check') opts.check = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--site=')) opts.site = arg.slice(7);
    else throw new Error('Unknown option: ' + arg);
  }
  if (!getBrowserSite(opts.site)) throw new Error('Unsupported browser site: ' + opts.site);
  if (!opts.check && !opts.help && opts.mode === 'headless' && !getBrowserSite(opts.site).headless) {
    throw new Error('Headless relay is not available for this site; ChatGPT web extraction is not supported. Use openai/<model> through the official API.');
  }
  return opts;
}

export function browserProfilePath(site, env = process.env, platform = process.platform, home = homedir()) {
  const root = env.ARGON_BROWSER_PROFILE_ROOT ||
    (platform === 'win32'
      ? join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Argon', 'browser-profiles')
      : join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'argon', 'browser-profiles'));
  return join(resolve(root), site);
}

export function browserLaunchPlan(opts, {root = ROOT, env = process.env, platform = process.platform, home = homedir()} = {}) {
  const site = getBrowserSite(opts.site);
  if (!site) throw new Error('Unsupported site');
  const profile = browserProfilePath(opts.site, env, platform, home);
  const extension = join(root, 'extension');
  const extensionAvailable = existsSync(join(extension, 'manifest.json')) &&
    existsSync(join(extension, 'config.js'));
  return {
    site:site.id, url:site.url, mode:opts.mode,
    profile, hasProfile:existsSync(join(profile, '.argon-initialized')),
    browserRelay:site.browserRelay,
    extension, extensionAvailable,
    reason:site.reason || null,
  };
}

async function main() {
  const opts = parseBrowserArgs(process.argv.slice(2));
  if (opts.help) { process.stdout.write(HELP); return; }
  const plan = browserLaunchPlan(opts);
  if (opts.check) {
    console.log(JSON.stringify({status:'configuration-only', ...plan}, null, 2));
    return;
  }
  if (plan.browserRelay && !plan.extensionAvailable) {
    throw new Error('Extension manifest or config.js is missing; install Argon first (scripts/install.py).');
  }
  if (opts.mode === 'headless' && !plan.hasProfile) {
    throw new Error('No dedicated Argon browser profile found. Run with --headed first to sign in interactively.');
  }
  let chromium;
  try {
    ({chromium} = await import('playwright'));
  } catch {
    throw new Error('Playwright is missing. From the installed Argon directory: npm install --no-save playwright && npx playwright install chromium');
  }
  mkdirSync(plan.profile,{recursive:true, mode:0o700});
  const args = plan.browserRelay
    ? [`--disable-extensions-except=${plan.extension}`, `--load-extension=${plan.extension}`]
    : [];
  const context = await chromium.launchPersistentContext(plan.profile, {
    channel:'chromium', headless:opts.mode === 'headless', args,
    acceptDownloads:false, serviceWorkers:'allow',
  });
  try {
    // A profile belongs to one Playwright process at a time; never reuse a personal Chrome profile.
    const page = context.pages()[0] || await context.newPage();
    await page.goto(plan.url,{waitUntil:'domcontentloaded', timeout:30000});
    if (!plan.hasProfile) writeFileSync(join(plan.profile,'.argon-initialized'),'Initialized by Argon headed browser. Sign-in not verified.\n',{mode:0o600});
    console.log(`Argon browser running: ${plan.site} (${plan.mode})`);
    console.log(plan.browserRelay
      ? 'Browser extension loaded. Use argon --status to check Gemini readiness.'
      : 'Manual browser only: no ChatGPT website answer scraping or API relay. Use the official OpenAI API connector.');
    if (opts.mode === 'headed') console.log('Sign in normally in the opened browser window. Close it or press Ctrl+C when finished.');
    await new Promise(done => {
      process.once('SIGINT',done);
      process.once('SIGTERM',done);
      context.once('close',done);
    });
  } finally {
    await context.close().catch(()=>{});
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e=>{console.error('Argon browser: ' + e.message);process.exitCode=1;});
}
