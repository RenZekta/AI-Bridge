# AI Bridge

AI Bridge turns a tab you are already logged into on an AI chat website into a **local, OpenAI-compatible** endpoint for a local IDE or agent. It deliberately keeps the two halves on your computer:

```text
IDE / agent ──HTTP──> 127.0.0.1:4317/v1 ──WebSocket──> Chrome extension ──DOM──> logged-in AI chat tab
```

## Supported AI chats

- [Grok](https://grok.com/)
- [Gemini](https://gemini.google.com/app)
- [DeepSeek](https://chat.deepseek.com/)
- [Perplexity](https://www.perplexity.ai/)
- [Qwen](https://chat.qwen.ai/)
- [ChatGPT](https://chatgpt.com/)
- [Claude](https://claude.ai/)
- [Z.ai](https://chat.z.ai/)
- [Kimi](https://www.kimi.com/)
- [Arena](https://arena.ai/) — **experimental**: verified in chat mode with a single model selected. The bridge does not choose models, so chat mode is where you control which model answers. Agent mode is marked coming soon and has no model picker yet. Side-by-side mode returns two answers per turn and is not supported.

This project borrows the practical idea of a web-chat-to-OpenAI gateway from [geminiweb-as-api](https://github.com/hieonn/geminiweb-as-api) and the extension-first direction of [Quarkonix](https://github.com/nikita-nikita12308/Quarkonix), without copying browser profiles or exposing a remote server.

## Install

1. Install Node.js 20 or newer.
2. From this directory, start the local companion with Run.bat or manually in cmd:

   ```powershell
   npm start
   ```

   On first start it creates `.ai-bridge-token` next to `local-server.mjs`, then prints that bridge token. Leave this terminal running. Future starts reuse the same token, so the extension does not need to be configured again.

3. In Chrome, open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select the `extension` folder in this project.
4. Open the AI Bridge extension, paste the printed token, and click **Save & connect**.
5. Click a provider in the popup, sign in normally, and leave that tab open. Choose it as the default provider, or use a provider-specific model name.

The server binds only to `127.0.0.1`. It never reads, copies, or uploads Chrome profile files. A single chat tab answers one prompt at a time, but requests run **in parallel across tabs**: each request is leased to a free tab, and up to `BRIDGE_MAX_CONCURRENT` requests (default `3`) may be in flight per connected browser. When every matching tab is busy the request is requeued rather than failed, so opening another logged-in tab of the same provider increases throughput without changing your client. While connected, the extension exchanges a heartbeat every 20 seconds, so its Manifest V3 service worker remains active indefinitely on Chrome 116 or newer. The **Pause** button intentionally stops that connection; **Continue** restores it.

After changing extension files during development, click the extension's **Reload** button on `chrome://extensions`. Restart `npm start` after changing the local server.

## Use from an IDE

Set the IDE's OpenAI-compatible base URL to:

```text
http://127.0.0.1:4317/v1
```

Use `bridge-auto` to route to the configured default provider, or select one explicitly:

```text
bridge-grok       bridge-gemini     bridge-deepseek
bridge-perplexity bridge-qwen       bridge-chatgpt
bridge-claude     bridge-zai        bridge-kimi
bridge-arena
```

The local endpoint implements `GET /v1/models`, `POST /v1/chat/completions`, including Server-Sent Events when `stream: true`, and `GET /health`.

Automatic “name this conversation” requests are detected and completed locally; they do not use the active AI-chat tab. Set `BRIDGE_INTERCEPT_TITLES=0` before starting the server to disable this behavior.

```powershell
curl http://127.0.0.1:4317/v1/chat/completions `
  -H 'Content-Type: application/json' `
  -d '{"model":"bridge-gemini","messages":[{"role":"user","content":"Explain this error briefly."}]}'
```

Most OpenAI clients require a non-empty API key even when a local server does not. Supply any placeholder value unless you opt into local API-key protection:

```powershell
$env:BRIDGE_API_KEY = 'choose-a-local-secret'
npm start
```

With `BRIDGE_API_KEY` set, send `Authorization: Bearer choose-a-local-secret`.

### Use from an agent

An agent driving a chat tab as a sub-agent sends the same request with one extra header:

```text
X-AI-Bridge-Mode: web
```

Web-subagent mode wraps the prompt in `webPrePrompt` / `webPostPrompt` instructions instead of the IDE ones, and sends the message as plain text rather than a `USER:`-labelled transcript, so the website reads a natural request. Both web instruction files start empty.

Send one message per request. The conversation lives in the browser tab, so resending history makes the site see those turns twice.

The workflow is chosen per request rather than per provider because the same tab can serve an IDE now and an agent later. A value other than `ide` or `web` is rejected, so a typo cannot silently take the wrong profile.

### Bridge-token storage

The bridge token is automatically stored in the ignored `.ai-bridge-token` file. Delete that file to rotate the token, then paste the newly printed value into the extension. To use a managed token without writing a file, set `BRIDGE_TOKEN`; to choose another token-file location, pass `--token-file <path>` or set `BRIDGE_TOKEN_FILE`.

### Settings

`ai-bridge.settings.json` sits beside the local server and is **local to your machine**: it is git-ignored so your personal configuration is never committed. Copy the example to start:

```powershell
Copy-Item ai-bridge.settings.example.json ai-bridge.settings.json
```

If the file is missing, the server creates it with defaults on next start.

```json
{
  "interceptTitleRequests": true,
  "injectPromptInstructionsEveryMessage": true,
  "prePrompt": "Generic IDE Pre-prompt",
  "postPrompt": "Generic IDE Post-prompt",
  "webPrePrompt": "Web Subagent Pre-prompt",
  "webPostPrompt": "Web Subagent Post-prompt",
  "// disguiseModelNameAsAssistant": "Turning on may increase responsiveness of a model to the prompt",
  "disguiseModelNameAsAssistant": false,
  "providers": {
    "qwen": { "prePrompt": "" }
  }
}
```

Set `interceptTitleRequests` to `false` to pass IDE conversation-naming calls through to the selected AI website. The environment variable `BRIDGE_INTERCEPT_TITLES=0` overrides this setting for one run. Use `BRIDGE_SETTINGS_FILE` or `--settings-file <path>` to load a settings file from elsewhere.

Set `disguiseModelNameAsAssistant` to `true` to always replace `{{modelName}}` with `an assistant` instead of the provider display name. Turning this on may increase responsiveness of a model to the prompt. Keys that start with `//` are comments and are ignored.

**Per-provider overrides.** The optional `providers` object is keyed by provider id (`grok`, `gemini`, `deepseek`, `perplexity`, `qwen`, `chatgpt`, `claude`, `zai`, `kimi`, `arena`). Each entry may override `prePrompt`, `postPrompt`, `webPrePrompt`, `webPostPrompt`, `injectPromptInstructionsEveryMessage` and `disguiseModelNameAsAssistant` for that provider only; anything omitted falls back to the global value. An empty prompt name disables that side for the provider instead of inheriting the global name, which is how you turn the relay preamble off for one site only. `interceptTitleRequests` stays global because it is decided before the provider is known. Unknown provider ids and wrong value types are rejected at startup.

Concurrency is controlled by the environment variable `BRIDGE_MAX_CONCURRENT` (default `3`): how many requests one connected browser may have in flight at once. Set it to `1` for strictly serial behaviour.

### Prompt instructions

Markdown files under `prompt-instructions/` are wrapped around the bridged chat transcript before it is typed into the AI tab:

```text
prompt-instructions/
  pre-prompt/
    Generic IDE Pre-prompt.md
    Web Subagent Pre-prompt.md
    ZCode Pre-prompt.md
  post-prompt/
    Generic IDE Post-prompt.md
    Web Subagent Post-prompt.md
    ZCode Post-prompt.md
```

- `prePrompt` / `postPrompt` name the files used for IDE requests; `webPrePrompt` / `webPostPrompt` name the ones used when the request carries `X-AI-Bridge-Mode: web`. The web files ship empty, so an agent gets its prompt dressed only the way it asked.
- Set a name to `""` to disable that side entirely.
- Pre-prompt text is placed at the very start of the outgoing prompt; post-prompt text at the very end.
- With `injectPromptInstructionsEveryMessage: true` (default), both are injected on every chat completion. Set it to `false` to inject only on the first user turn of a conversation (`messages` has at most one `role: "user"` entry).
- Use `{{modelName}}` in either file for the provider display name (for example `Claude`, `Gemini`, `ChatGPT`). Prefer a provider-specific model (`bridge-claude`, …) so the server can substitute immediately; with `bridge-auto`, the placeholder is filled by the content script from the live tab hostname.
- Edit the markdown files anytime; the next request reloads them. Settings changes still require restarting `npm start`.
- Use `BRIDGE_PROMPT_INSTRUCTIONS_DIR` or `--prompt-instructions-dir <path>` to point at another instructions root.

## Notes and limits

- This uses the visible web UI, not a provider's private or undocumented network API. UI changes can require selector updates in `extension/content.js`.
- You are responsible for the terms, plan limits, and acceptable-use rules of every provider you choose to connect.
- File uploads, images, provider-specific citations, and native tool execution are outside the first version. When the IDE sends a `tools` array, the bridge best-effort detects JSON tool-call text from the chat tab (bare, fenced, or prose-wrapped) and returns OpenAI `tool_calls` for both streaming and non-streaming requests.
- Claude responses are intentionally emitted once its final response block is stable, rather than streaming its intermediate thinking/status blocks into the IDE.
- Keep the requested provider page fully loaded. If a request says the content script is not ready, reload that tab.
- The extension has permissions only for the ten named chat websites and localhost; it does not have broad `<all_urls>` access.

## Development

```powershell
npm test
```

The tests cover the local health endpoint, model list, title-request interception, bridge relay, streaming, heartbeats, token persistence, prompt-instruction injection, per-provider settings, text-to-`tool_calls` conversion, and that every provider stays registered across the server, extension, and manifest.

`AGENTS.md` records the conventions for working in this repository, including how to verify a provider's selectors against the live site before writing an adapter.
