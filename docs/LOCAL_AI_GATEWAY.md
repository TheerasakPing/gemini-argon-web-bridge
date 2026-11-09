# Argon Local AI Gateway — Phase 1

The existing Argon bridge can now route OpenAI-compatible chat requests to **local Ollama and LM Studio runtimes** while retaining the existing Gemini web-tab transport. This is an additive API capability; it does not install an inference engine or download a model.

## Architecture

```text
AI clients (OpenAI-compatible chat clients)
            |
    127.0.0.1:8989  Bearer <Argon token>
            |
       GET /v1/models
       POST /v1/chat/completions
            |
       [model prefix]
         |           |                 |
     gemini-web    ollama/*       lmstudio/*
         |           |                 |
    Browser queue   127.0.0.1:11434  127.0.0.1:1234
    (Gemini tab)    Ollama         LM Studio
```

The Gemini agent lease and the extension queue are **not used** for local completions, so local jobs remain available while a Gemini agent owns the browser tab. Gemini jobs keep their existing queue, lease, timeout and browser-readiness semantics.

## Start local inference

**Ollama**: install and start Ollama, then pull a model.

```sh
ollama pull llama3.2
ollama list
```

**LM Studio**: download/load a model, and start the API server from the Developer tab or use `lms server start`. LM Studio normally listens on port 1234. The actual model IDs are returned by `/v1/models`.

Start Argon using the existing installer or `argon --start`. No Argon extension or Gemini login is required for local-only requests, although the extension is still needed to use `gemini-web`.

## Discover available models

```sh
TOKEN="$(cat "$HOME/.gemini/config/skills/argon/bridge/token")"
curl -sS http://127.0.0.1:8989/v1/models \
  -H "Authorization: Bearer $TOKEN"
```

Example IDs (the real IDs depend on installed/loaded models):

- `gemini-web` (always listed; requires a ready browser tab for use)
- `ollama/llama3.2`
- `lmstudio/<model-id-as-reported-by-lm-studio>`

If a local runtime is stopped or model discovery fails, its entries are omitted. The Gemini model remains listed.

## Chat with local models

```sh
curl -sS http://127.0.0.1:8989/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"ollama/llama3.2","messages":[{"role":"user","content":"สวัสดี"}]}'
```

Add `"stream":true` and use `curl -N` for server-sent events (SSE).

Use the following OpenAI-compatible client configuration:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8989/v1",
    api_key="<contents of bridge/token>",
)
response = client.chat.completions.create(
    model="ollama/llama3.2",
    messages=[{"role": "user", "content": "Hello"}],
)
print(response.choices[0].message.content)
```

Unlike Gemini web requests (which flatten messages into a page prompt), local requests preserve the full `messages` array and other supported upstream parameters, including tool-call and multimodal fields when supported by the selected runtime. The gateway currently supports the **chat completions** API only; it does not yet expose `/v1/embeddings`, `/v1/responses` or model-management endpoints. SSE data is passed through from the runtime; streaming chunk `model` fields may use the native model ID rather than the prefixed model ID.

## Environment configuration

| Variable | Default | Purpose |
|---|---|---|
| `ARGON_LOCAL_AI` | `1` (enabled) | Set to `0` to disable local providers |
| `ARGON_OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama origin |
| `ARGON_LMSTUDIO_URL` | `http://127.0.0.1:1234` | LM Studio origin |
| `ARGON_OLLAMA_TOKEN` | Empty | Optional runtime-specific bearer token |
| `ARGON_LMSTUDIO_TOKEN` | Empty | Optional runtime-specific bearer token |

Set environment variables **before starting the Argon process**. To use nondefault ports, provide a URL such as `http://127.0.0.1:12345`. Only literal loopback HTTP origins are accepted (127.0.0.1 or [::1], no path/query/userinfo); arbitrary upstream hostnames, LAN addresses and redirect targets are rejected. To run against a LAN inference node, use a separately secured local tunnel bound to 127.0.0.1.

The incoming Argon Bearer token is **never** forwarded to the runtime. Configure runtime authentication with its own token. API exposure stays on `127.0.0.1:8989`, and the existing Host/Origin/Argon-token checks remain in force. No automatic cloud fallback is performed, so a request to a local model does not silently leave the machine via Gemini.

## Acceptance checklist / workstreams

- [x] **Gateway worker** — preserve `gemini-web`, add prefixed model routing to local backends.
- [x] **Adapter worker** — implement OpenAI-compatible model discovery, chat passthrough, and SSE.
- [x] **Security worker** — restrict upstreams to local HTTP origins; do not forward incoming credentials; reject unknown model IDs.
- [x] **Test worker** — add mock-runtime tests for discovery, auth, nonstream, SSE, agent lease isolation and invalid URLs.
- [ ] **CI/review gate** — run GitHub Actions on Linux and macOS; fix failures before merge.
- [ ] **E2E smoke gate** — run on an actual macOS/Windows host with Ollama or LM Studio and a real downloaded model.
- [ ] **Lead review** — evaluate failures, confirm backward compatibility, approve merge.

## Next phases (not part of Phase 1)

- Phase 2: richer health and metrics (latency, TTFT, tokens/sec, resource usage), model capability metadata, streaming chunk model normalization.
- Phase 3: configurable named provider profiles, LAN access through explicit authenticated tunnels, cloud API connectors with separately stored secrets.
- Phase 4: optional fallback policies, budgets, per-client quotas, embeddings, Responses API, and a local admin dashboard.
- Phase 5: multi-platform packaging, persistent service configuration, real-provider E2E and performance/load tests.

Tests use a **mock** OpenAI-compatible runtime. Passing automated tests does **not** prove that an actual model is installed or running.

## Troubleshooting

- `401 Unauthorized`: supply the original Argon bearer token.
- `404 model_not_found`: select a prefixed model name returned by `GET /v1/models`.
- `502 local_upstream_unavailable`: start Ollama/LM Studio and verify its endpoint is reachable locally.
- `502 local_upstream_error`: the selected runtime rejected the completion request; check model name and runtime logs.
- Gemini readiness does not control local-model readiness.
