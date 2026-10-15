import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url));
function rpc(t) {
  const child = spawn('node', [script], {stdio: ['pipe', 'pipe', 'inherit']});
  t.after(() => child.kill());
  let buffer = ''; const waiting = new Map();
  child.stdout.on('data', d => {
    buffer += d; let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  return (method, params) => new Promise(resolve => {
    const mine = ++id; waiting.set(mine, resolve);
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: mine, method, params}) + '\n');
  });
}
test('MCP server handshakes, lists tools and rejects unknown tools', async t => {
  const call = rpc(t);
  const init = await call('initialize', {protocolVersion: '2025-06-18'});
  assert.equal(init.result.serverInfo.name, 'argon');
  const tools = (await call('tools/list')).result.tools.map(x => x.name);
  assert.deepEqual(tools, ['ask_gemini', 'argon_status', 'argon_history']);
  assert.equal((await call('tools/call', {name: 'nope'})).error.code, -32602);
  const missing = await call('tools/call', {name: 'ask_gemini', arguments: {}});
  assert.equal(missing.result.isError, true);
});
