# Argon Multi-Site Browser Gateway — Phase 2

> Status: Code submitted for review. Mock tests do **not** verify real website login or headless model answers.

## Objective / สถาปัตยกรรม

Maintain one local entry point, but separate **browser website relays** from **official model APIs**.

```text
OpenAI-compatible clients / MCP / Argon CLI
                  |
          127.0.0.1:8989
          Argon Bearer token
                  |
   +--------------+-------------------+
   |              |                   |
 gemini-web    ollama/*,lmstudio/*   openai/*
   |              |                   |
 Extension     Local LLM runtime    Official OpenAI API
   |
 Playwright Chromium
  --headed (interactive sign-in)
  --headless (same dedicated profile)
```

The ChatGPT website is present in the browser **site registry**, but it is **manual browsing only**. Automated capture of ChatGPT website output is intentionally not implemented. For programmable ChatGPT-compatible inference, use the official `openai/<model-id>` provider with `ARGON_OPENAI_API_KEY`. ChatGPT subscriptions and API billing are separate.

## Supported matrix

| Provider / site | Browser UI | Automated API routing | Headless relay |
|---|---|---|---|
| Gemini website | Yes, existing extension | `gemini-web` | Experimental, via Playwright Chromium + installed extension |
| ChatGPT website | Yes, manual browser launch | No web-answer extraction | No, deliberately disabled |
| OpenAI API | Not a website relay | `openai/<model-id>` | Not needed |
| Ollama | Local server | `ollama/<model-id>` | Not needed |
| LM Studio | Local server | `lmstudio/<model-id>` | Not needed |

No fake `chatgpt-web` model is advertised. `GET /v1/browser/sites` reports browser capability transparently. The browser registry is the starting point for more allowed sites, not a claim that additional automations are complete.

## Headed → Headless setup (macOS/Linux)

Install Argon from the feature branch/source first, preserving the original token, session queue and history. To use an installed checkout:

```sh
cd ~/.gemini/config/skills/argon
npm install --no-save playwright
npx playwright install chromium
argon --start
argon browser --check
argon browser --headed --site=gemini
```

In the **new, dedicated Chromium window**, sign in manually and inspect whether the Gemini extension is connected. Close the browser when finished; start the same profile headlessly:

```sh
argon browser --headless --site=gemini
```

In a separate terminal:

```sh
argon --status
```

The headless launcher is a **long-running foreground process**, not a daemon installed automatically. Press Ctrl+C to stop it. A successful browser launch is not proof of a valid authenticated session or a successful model request.

The extension is loaded using Playwright Chromium's documented `launchPersistentContext` and `channel: 'chromium'`, with extension loading flags. It must use **Playwright Chromium**, not the user's default Chrome/Edge profile. On first run `--headed` creates a dedicated profile under `~/.local/share/argon/browser-profiles/gemini` by default. On Windows it uses the user's LocalAppData location. The optional `ARGON_BROWSER_PROFILE_ROOT` can override the parent directory.

For Windows, run the equivalent commands in a terminal containing the installed Argon CLI. Install Playwright in the Argon install directory with `npm install --no-save playwright`, then run `npx playwright install chromium`. The first login still requires `--headed` on Windows as well.

**Headless limitations:** authentication challenges, account restrictions, CAPTCHA, UI updates, and provider-side anti-automation controls can still block access. Argon never attempts to bypass them. Do not open the same persistent profile in multiple browser processes; do not copy cookies from another Chrome profile.

## OpenAI API (official integration)

Use a separately issued OpenAI API key. It is **not** your ChatGPT Plus/Pro subscription credential. This API may incur usage fees.

On macOS/Linux, set the key **in the server process environment** before starting the Argon Node daemon/service. For an interactive shell without putting the key into shell history:

```sh
cd ~/.gemini/config/skills/argon
read -r -s -p 'OpenAI API key: ' ARGON_OPENAI_API_KEY; echo
export ARGON_OPENAI_API_KEY
# Only start this when another Argon process is not listening on port 8989:
node bridge/server.mjs
```

If Argon is managed by launchd or another service, put the environment variable in a secure service secret/config mechanism and restart that service. Environment changes in a terminal do **not** change an already running daemon. Do not commit the key to Git, append it to the README, or place it in extension/config.js.

From a second terminal:

```sh
TOKEN="$(cat ~/.gemini/config/skills/argon/bridge/token)"
curl -sS http://127.0.0.1:8989/v1/browser/sites \
  -H "Authorization: Bearer $TOKEN"
curl -sS http://127.0.0.1:8989/v1/models \
  -H "Authorization: Bearer $TOKEN"
```

Use the exact model ID returned by `/v1/models`. Example request:

```sh
curl -sS http://127.0.0.1:8989/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/<model-id>","messages":[{"role":"user","content":"สวัสดี"}]}'
```

Replace `<model-id>` with a real API-accessible model ID. Requests are routed to a **fixed** upstream origin, `https://api.openai.com`. The Argon bearer token is never forwarded; the OpenAI API key is used instead. The gateway does not silently fall back between web, local and cloud providers.

The OpenAI API connector currently covers **Chat Completions** and streaming, not all Responses API capabilities.

## Security and compliance

- Local HTTP server stays bound to `127.0.0.1:8989`; original Bearer authentication remains mandatory.
- The browser profile is dedicated to Argon, isolated from the user's everyday browser profile. Cookies and sign-in data remain sensitive local browser-profile data.
- Site URLs are allowlisted; arbitrary websites and URLs from API callers are not accepted by the browser launcher.
- For the ChatGPT website, this feature does not programmatically extract answers. OpenAI Terms of Use disallow automated/programmatic extraction: https://openai.com/policies/terms-of-use/
- No CAPTCHA bypass, covert login, password collection, session copying or rate-limit avoidance is implemented.
- OpenAI API billing is separate from ChatGPT subscriptions: https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform
- Playwright browser extension reference: https://playwright.dev/docs/chrome-extensions

## Team-lead planner and release gates

| Workstream | Owner | Current gate |
|---|---|---|
| G1 — Provider registry and capability metadata | Gateway agent | Implemented, review pending |
| G2 — Headless Chromium launcher with separate profile | Browser agent | Implemented, real-site E2E pending |
| G3 — Official OpenAI cloud adapter | API agent | Implemented, live API credentials not used in CI |
| G4 — Authentication and isolation | Security agent | Unit/mock tests implemented; review pending |
| G5 — Linux/macOS/Windows CI | Test agent | Workflow added; final results pending |
| G6 — Full real-browser E2E on macOS/Windows | Integration agent | Pending authenticated machine |
| G7 — Human/lead review + merge | Lead | Pending |

## Future extensibility

- Separate site adapter interface with per-site DOM contracts, health probes and explicit operator permissions.
- Consent-aware provider enable/disable toggles, per-provider sessions, error isolation and routing UI.
- Monitoring dashboards for live WebSocket/SSE, latency, failures and allowed-provider usage.
- Model features and Responses API mapping where supported by official APIs.
- Headless smoke runs on each release, with local test pages and opt-in provider-specific acceptance.

Do not mark a provider production-ready based solely on DOM selectors or mock tests.
