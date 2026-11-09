// Dependency-free, loopback-only OpenAI-compatible local model adapters.
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const DEFINITIONS = [
  {name: 'ollama', url: 'http://127.0.0.1:11434', urlEnv: 'ARGON_OLLAMA_URL', tokenEnv: 'ARGON_OLLAMA_TOKEN'},
  {name: 'lmstudio', url: 'http://127.0.0.1:1234', urlEnv: 'ARGON_LMSTUDIO_URL', tokenEnv: 'ARGON_LMSTUDIO_TOKEN'},
];

export function validateLocalProviders(providers) {
  if (!Array.isArray(providers)) throw new Error('localProviders must be an array');
  const names = new Set();
  return providers.map(p => {
    if (!p || !/^[a-z][a-z0-9_-]{0,31}$/.test(p.name || '') || names.has(p.name)) {
      throw new Error('Invalid or duplicate local provider name');
    }
    names.add(p.name);
    let url;
    try { url = new URL(p.url); } catch { throw new Error('Invalid URL for local provider ' + p.name); }
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Local provider URLs must be plain HTTP loopback origins (127.0.0.1 or [::1])');
    }
    if (p.token !== undefined && typeof p.token !== 'string') throw new Error('Provider token must be a string');
    return {name: p.name, baseUrl: url.origin, token: p.token || ''};
  });
}

export function localProvidersFromEnv(env = process.env) {
  if (env.ARGON_LOCAL_AI === '0') return [];
  return validateLocalProviders(DEFINITIONS.map(d => ({
    name: d.name, url: env[d.urlEnv] || d.url, token: env[d.tokenEnv] || '',
  })));
}

export function resolveLocalModel(id, providers) {
  if (typeof id !== 'string' || id.length > 300) return null;
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) return null;
  const provider = providers.find(p => p.name === id.slice(0, slash));
  const nativeModel = id.slice(slash + 1);
  return provider && !/[\u0000-\u001f\u007f]/.test(nativeModel) ? {provider, nativeModel} : null;
}

function providerHeaders(provider) {
  return provider.token ? {'Authorization': 'Bearer ' + provider.token} : {};
}

export async function discoverLocalModels(providers, timeoutMs = 1200) {
  const lists = await Promise.all(providers.map(async provider => {
    try {
      const response = await fetch(provider.baseUrl + '/v1/models', {
        headers: providerHeaders(provider),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return [];
      const body = await response.json();
      if (!Array.isArray(body.data)) return [];
      return body.data.slice(0, 250).filter(m => typeof m?.id === 'string' && m.id && m.id.length <= 250)
        .map(m => ({id: provider.name + '/' + m.id, object: 'model', owned_by: provider.name}));
    } catch { return []; } // A stopped local runtime must not break the existing Gemini bridge.
  }));
  return lists.flat();
}

export async function proxyLocalChat({req, res, payload, route, timeoutMs = 300000}) {
  const {provider, nativeModel} = route;
  const isStream = payload.stream === true;
  const {argon_new_chat, argon_tab, argon_force, ...input} = payload;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const onClose = () => controller.abort();
  res.once('close', onClose);
  const jsonError = (status, message, type = 'local_upstream_error') => {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify({error: {message, type}}));
  };
  try {
    const upstream = await fetch(provider.baseUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', ...providerHeaders(provider)},
      body: JSON.stringify({...input, model: nativeModel}),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return jsonError(502, provider.name + ' returned HTTP ' + upstream.status);
    }
    const ct = upstream.headers.get('content-type') || '';
    if (isStream && !ct.includes('text/event-stream')) {
      await upstream.body?.cancel();
      return jsonError(502, provider.name + ' did not return an SSE stream');
    }
    if (!isStream && !ct.includes('application/json')) {
      await upstream.body?.cancel();
      return jsonError(502, provider.name + ' did not return JSON');
    }
    if (!isStream) {
      // Cap non-streaming responses to avoid memory exhaustion from a misbehaving provider.
      const bytes = [];
      let total = 0;
      for await (const chunk of upstream.body) {
        total += chunk.byteLength;
        if (total > 8 * 1024 * 1024) {
          controller.abort();
          return jsonError(502, 'Local provider response too large');
        }
        bytes.push(chunk);
      }
      let result;
      try { result = JSON.parse(Buffer.concat(bytes).toString('utf8')); }
      catch { return jsonError(502, 'Local provider returned invalid JSON'); }
      if (result && typeof result === 'object' && !Array.isArray(result)) result.model = payload.model;
      res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
      return res.end(JSON.stringify(result));
    }
    res.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive'});
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (error) {
    if (res.headersSent) {
      if (!res.destroyed && !res.writableEnded) {
        res.write('data: ' + JSON.stringify({error: {message: 'Local upstream stream interrupted', type: 'local_upstream_error'}}) + '\n\n');
        res.end();
      }
    } else {
      jsonError(error?.name === 'TimeoutError' || controller.signal.aborted && !res.destroyed ? 504 : 502,
        'Local provider unavailable or timed out: ' + provider.name, 'local_upstream_unavailable');
    }
  } finally {
    clearTimeout(timer);
    res.off('close', onClose);
  }
}
