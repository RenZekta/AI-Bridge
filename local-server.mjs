import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";
import {
  DEFAULT_PROMPT_INSTRUCTION_SETTINGS,
  PROVIDER_DISPLAY_NAMES,
  buildPromptWithInstructions,
  ensurePromptInstructionsLayout,
} from "./prompt-instructions.mjs";
import { makeAssistantMessage } from "./tool-calls.mjs";

const MAX_BODY_BYTES = 1_000_000;
const MAX_QUEUE_LENGTH = 10;
const REQUEST_TIMEOUT_MS = 240_000;
const PROVIDERS = ["auto", "grok", "gemini", "deepseek", "perplexity", "qwen", "chatgpt", "claude", "zai", "kimi"];
if (PROVIDERS.slice(1).some((provider) => !PROVIDER_DISPLAY_NAMES[provider])) {
  throw new Error("PROVIDER_DISPLAY_NAMES is missing a provider from PROVIDERS.");
}
const DEFAULT_BRIDGE_SETTINGS = Object.freeze({
  interceptTitleRequests: true,
  ...DEFAULT_PROMPT_INSTRUCTION_SETTINGS,
});

const args = parseArgs(process.argv.slice(2));
const port = readPort(args.port ?? process.env.BRIDGE_PORT ?? "4317");
const tokenConfig = resolveBridgeToken(args);
const settingsConfig = loadBridgeSettings(args);
const promptInstructionsDir = resolvePromptInstructionsDirectory(args, settingsConfig.path);
const bridgeToken = tokenConfig.token;
const apiKey = args.apiKey ?? process.env.BRIDGE_API_KEY ?? "";
const interceptTitleRequests = process.env.BRIDGE_INTERCEPT_TITLES === undefined
  ? settingsConfig.settings.interceptTitleRequests
  : process.env.BRIDGE_INTERCEPT_TITLES !== "0";
const injectPromptInstructionsEveryMessage = settingsConfig.settings.injectPromptInstructionsEveryMessage;
const prePromptName = settingsConfig.settings.prePrompt;
const postPromptName = settingsConfig.settings.postPrompt;
const disguiseModelNameAsAssistant = settingsConfig.settings.disguiseModelNameAsAssistant;

const clients = new Set();
const jobs = new Map();
const queue = [];
let activeJob = null;

const server = http.createServer(async (request, response) => {
  try {
    if (!isLoopback(request.socket.remoteAddress)) {
      return sendOpenAiError(response, 403, "AI Bridge only accepts loopback connections.", "forbidden");
    }

    setCorsHeaders(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, {
        ok: true,
        connected_extensions: clients.size,
        active_request: activeJob?.id ?? null,
        queued_requests: queue.length,
      });
    }

    if (request.method === "GET" && url.pathname === "/v1/models") {
      if (!isAuthorized(request)) return sendOpenAiError(response, 401, "Invalid API key.", "invalid_api_key");
      return sendJson(response, 200, {
        object: "list",
        data: PROVIDERS.map((provider) => ({
          id: `bridge-${provider}`,
          object: "model",
          created: 0,
          owned_by: "ai-bridge",
        })),
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      if (!isAuthorized(request)) return sendOpenAiError(response, 401, "Invalid API key.", "invalid_api_key");
      const payload = await readJsonBody(request);
      return handleChatCompletion(request, response, payload);
    }

    return sendOpenAiError(response, 404, "Route not found.", "not_found");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    if (!response.headersSent) sendOpenAiError(response, 400, message, "invalid_request_error");
    else response.end();
  }
});

server.on("upgrade", (request, socket, head) => {
  try {
    if (!isLoopback(request.socket.remoteAddress)) return rejectUpgrade(socket, 403, "Loopback only");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/bridge") return rejectUpgrade(socket, 404, "Not found");
    if (url.searchParams.get("token") !== bridgeToken) return rejectUpgrade(socket, 401, "Invalid bridge token");
    if (request.headers.upgrade?.toLowerCase() !== "websocket") return rejectUpgrade(socket, 400, "WebSocket required");

    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") return rejectUpgrade(socket, 400, "Missing WebSocket key");
    const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));

    const client = createWebSocketClient(socket);
    clients.add(client);
    client.send({ type: "bridge:connected", providers: PROVIDERS.slice(1) });
    if (head.length) client.consume(head);
    log(`Chrome extension connected (${clients.size} active).`);
    client.onClose = () => {
      clients.delete(client);
      log(`Chrome extension disconnected (${clients.size} active).`);
      failJobsForClient(client, "The Chrome extension disconnected while the request was running.");
    };
    client.onMessage = (message) => handleExtensionMessage(client, message);
  } catch {
    socket.destroy();
  }
});

server.listen(port, "127.0.0.1", () => {
  log(`AI Bridge listening at http://127.0.0.1:${port}`);
  log(`Extension WebSocket: ws://127.0.0.1:${port}/bridge`);
  log(`Bridge token: ${bridgeToken}`);
  if (tokenConfig.path) log(`Bridge token file: ${tokenConfig.path}`);
  log(`Settings file: ${settingsConfig.path}`);
  log(`Prompt instructions: ${promptInstructionsDir}`);
  if (!apiKey) log("API key authentication is disabled (loopback-only mode).");
  else log("API key authentication is enabled.");
});

function handleChatCompletion(request, response, payload) {
  if (!payload || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    return sendOpenAiError(response, 400, "'messages' must be a non-empty array.", "invalid_request_error", "messages");
  }
  if (payload.stream !== undefined && typeof payload.stream !== "boolean") {
    return sendOpenAiError(response, 400, "'stream' must be a boolean.", "invalid_request_error", "stream");
  }
  if (interceptTitleRequests && isConversationTitleRequest(payload.messages)) {
    return sendConversationTitle(response, payload);
  }
  if (clients.size === 0) {
    return sendOpenAiError(response, 503, "No Chrome extension is connected. Start the local server, then configure and enable the extension.", "bridge_unavailable");
  }
  if (queue.length >= MAX_QUEUE_LENGTH) {
    return sendOpenAiError(response, 429, "AI Bridge queue is full. Try again shortly.", "rate_limit_error");
  }

  const provider = providerForModel(payload.model);
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const prompt = buildPromptWithInstructions(
    formatPrompt(payload.messages, tools),
    payload.messages,
    provider,
    {
      everyMessage: injectPromptInstructionsEveryMessage,
      prePromptName,
      postPromptName,
      rootDirectory: promptInstructionsDir,
      disguiseModelNameAsAssistant,
    },
  );
  const job = {
    id: `bridge-${crypto.randomUUID()}`,
    model: typeof payload.model === "string" && payload.model ? payload.model : "bridge-auto",
    provider,
    prompt,
    tools,
    hasTools: tools.length > 0,
    stream: payload.stream === true,
    streamedContent: false,
    response,
    text: "",
    timer: null,
    client: null,
    done: false,
  };
  jobs.set(job.id, job);
  queue.push(job);
  if (job.stream) startStreamingResponse(job);
  dispatchNext();
}

function isConversationTitleRequest(messages) {
  const lastUserMessage = [...messages].reverse().find((message) => message?.role === "user");
  if (!lastUserMessage) return false;
  const text = contentToText(lastUserMessage.content).toLowerCase().replace(/\s+/g, " ");
  const asksForTitle = /\b(?:title|name|summari[sz]e|label)\b/.test(text);
  const namesConversation = /\b(?:conversation|chat|discussion|thread|messages)\b/.test(text);
  const requestVerb = /\b(?:generate|create|write|provide|return|suggest|give|make|name|summari[sz]e)\b/.test(text);
  const titleOnly = /\b(?:title only|only the title|just the title|no explanation)\b/.test(text);
  return asksForTitle && requestVerb && (namesConversation || titleOnly);
}

function sendConversationTitle(response, payload) {
  const model = typeof payload.model === "string" && payload.model ? payload.model : "bridge-auto";
  const title = makeConversationTitle(payload.messages);
  const id = `title-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  if (payload.stream) {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders?.();
    const titleJob = { id, model };
    writeSse(response, makeStreamChunk(titleJob, { role: "assistant", content: "" }, null));
    writeSse(response, makeStreamChunk(titleJob, { content: title }, null));
    writeSse(response, makeStreamChunk(titleJob, {}, "stop"));
    writeSse(response, "[DONE]");
    response.end();
    return;
  }
  sendJson(response, 200, {
    id: `chatcmpl-${id}`,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: title }, finish_reason: "stop" }],
  });
}

function makeConversationTitle(messages) {
  const lastTitleRequest = [...messages].reverse().find((message) => message?.role === "user");
  const sourceMessage = [...messages].reverse().find((message) => message?.role === "user" && message !== lastTitleRequest && !isConversationTitleRequest([message]));
  const source = contentToText(sourceMessage?.content ?? "");
  const words = source
    .replace(/```[\s\S]*?```/g, " ")
    .match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)
    ?.filter((word) => !TITLE_STOP_WORDS.has(word.toLowerCase()))
    .slice(0, 7) ?? [];
  if (words.length === 0) return "New conversation";
  const title = words.join(" ");
  return `${title[0].toUpperCase()}${title.slice(1)}`.slice(0, 72);
}

const TITLE_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "for", "from", "how", "i", "in", "is", "it", "my", "of", "on", "or", "please", "the", "this", "that", "to", "we", "with", "you", "your",
]);

function dispatchNext() {
  if (activeJob || queue.length === 0) return;
  const job = queue.shift();
  const client = selectClient(job.provider);
  if (!client) {
    finishJobWithError(job, "No suitable Chrome extension is connected.");
    dispatchNext();
    return;
  }

  activeJob = job;
  job.client = client;
  job.timer = setTimeout(() => finishJobWithError(job, "The web chat did not finish before the 4 minute bridge timeout."), REQUEST_TIMEOUT_MS);
  client.send({
    type: "bridge:run",
    id: job.id,
    provider: job.provider,
    prompt: job.prompt,
  });
}

function handleExtensionMessage(client, message) {
  if (!message || typeof message !== "object" || typeof message.type !== "string") return;
  if (message.type === "bridge:hello") {
    client.providers = Array.isArray(message.providers) ? message.providers.filter((name) => PROVIDERS.includes(name)) : [];
    client.extensionVersion = typeof message.version === "string" ? message.version : "unknown";
    return;
  }
  if (message.type === "bridge:status") return;
  if (message.type === "bridge:ping") {
    client.send({ type: "bridge:pong", at: Date.now() });
    return;
  }
  if (typeof message.id !== "string") return;
  const job = jobs.get(message.id);
  if (!job || job.client !== client || job.done) return;

  if (message.type === "bridge:chunk") {
    const text = typeof message.text === "string" ? message.text : "";
    if (!text) return;
    job.text += text;
    // When tools are present, buffer until complete so we can lift JSON into tool_calls
    // instead of streaming it as ordinary assistant content the IDE will ignore.
    if (job.stream && !job.hasTools) writeChunk(job, text);
    return;
  }
  if (message.type === "bridge:complete") {
    if (typeof message.text === "string" && message.text) {
      if (!job.text || message.text.length >= job.text.length) job.text = message.text;
    }
    finishJob(job);
    return;
  }
  if (message.type === "bridge:error") {
    finishJobWithError(job, typeof message.message === "string" ? message.message : "The web chat page reported an unknown error.");
  }
}

function finishJob(job) {
  if (job.done) return;
  job.done = true;
  clearTimeout(job.timer);
  jobs.delete(job.id);
  if (activeJob === job) activeJob = null;

  if (job.stream) {
    finishStreamingJob(job);
  } else {
    const message = makeAssistantMessage(job.text, job.tools);
    sendJson(job.response, 200, {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: job.model,
      choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
    });
  }
  dispatchNext();
}

function finishStreamingJob(job) {
  if (job.hasTools) {
    const message = makeAssistantMessage(job.text, job.tools);
    if (message.tool_calls) {
      const call = message.tool_calls[0];
      writeSse(job.response, makeStreamChunk(job, {
        tool_calls: [{
          index: 0,
          id: call.id,
          type: "function",
          function: { name: call.function.name, arguments: call.function.arguments },
        }],
      }, null));
      writeSse(job.response, makeStreamChunk(job, {}, "tool_calls"));
      writeSse(job.response, "[DONE]");
      job.response.end();
      return;
    }
  }

  if (!job.streamedContent && job.text) writeChunk(job, job.text);
  writeSse(job.response, makeStreamChunk(job, {}, "stop"));
  writeSse(job.response, "[DONE]");
  job.response.end();
}

function finishJobWithError(job, message) {
  if (job.done) return;
  job.done = true;
  clearTimeout(job.timer);
  jobs.delete(job.id);
  const queuedIndex = queue.indexOf(job);
  if (queuedIndex !== -1) queue.splice(queuedIndex, 1);
  if (activeJob === job) activeJob = null;

  if (job.stream) {
    writeSse(job.response, { error: { message, type: "bridge_error", code: "bridge_error" } });
    writeSse(job.response, "[DONE]");
    job.response.end();
  } else {
    sendOpenAiError(job.response, 502, message, "bridge_error");
  }
  dispatchNext();
}

function failJobsForClient(client, message) {
  for (const job of [...jobs.values()]) {
    if (job.client === client) finishJobWithError(job, message);
  }
}

function startStreamingResponse(job) {
  job.response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  job.response.flushHeaders?.();
  // Avoid committing to content:"" when tools may produce tool_calls instead.
  writeSse(job.response, makeStreamChunk(job, job.hasTools ? { role: "assistant" } : { role: "assistant", content: "" }, null));
}

function writeChunk(job, text) {
  job.streamedContent = true;
  writeSse(job.response, makeStreamChunk(job, { content: text }, null));
}

function makeStreamChunk(job, delta, finishReason) {
  return {
    id: `chatcmpl-${job.id}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: job.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function formatPrompt(messages, tools) {
  const transcript = messages.map((message) => {
    const role = typeof message.role === "string" ? message.role.toUpperCase() : "USER";
    return `${role}:\n${contentToText(message.content)}`;
  }).join("\n\n");
  if (!Array.isArray(tools) || tools.length === 0) return transcript;
  return `${transcript}\n\nAVAILABLE TOOLS (OpenAI schema):\n${JSON.stringify(tools)}\n\nIf a tool is required, reply only with a JSON object shaped like {"name":"tool_name","arguments":{...}}. Otherwise answer normally.`;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part?.type === "text" && typeof part.text === "string") return part.text;
    if (part?.type === "input_text" && typeof part.text === "string") return part.text;
    return `[Unsupported content part: ${part?.type ?? "unknown"}]`;
  }).join("\n");
}

function providerForModel(model) {
  const value = typeof model === "string" ? model.toLowerCase().trim() : "";
  if (!value || value === "auto" || value === "bridge-auto") return null;
  const found = PROVIDERS.slice(1).find((provider) => (
    value === provider
    || value === `bridge-${provider}`
    || value.includes(`bridge-${provider}`)
    || value === `bridge_${provider}`
    || value.startsWith(`${provider}-`)
    || value.startsWith(`${provider}_`)
  ));
  return found ?? null;
}

function selectClient(provider) {
  const available = [...clients].filter((client) => !client.closed);
  if (!provider) return available.at(-1) ?? null;
  return available.find((client) => client.providers.length === 0 || client.providers.includes(provider)) ?? null;
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function createWebSocketClient(socket) {
  const client = {
    socket,
    providers: [],
    buffer: Buffer.alloc(0),
    closed: false,
    onClose: null,
    onMessage: null,
    send(value) {
      if (client.closed || socket.destroyed) return;
      sendWebSocketFrame(socket, JSON.stringify(value));
    },
    consume(chunk) {
      client.buffer = Buffer.concat([client.buffer, chunk]);
      while (client.buffer.length >= 2) {
        const first = client.buffer[0];
        const second = client.buffer[1];
        const opcode = first & 0x0f;
        const masked = (second & 0x80) === 0x80;
        let payloadLength = second & 0x7f;
        let offset = 2;
        if (payloadLength === 126) {
          if (client.buffer.length < 4) return;
          payloadLength = client.buffer.readUInt16BE(2);
          offset = 4;
        } else if (payloadLength === 127) {
          if (client.buffer.length < 10) return;
          const length = client.buffer.readBigUInt64BE(2);
          if (length > BigInt(MAX_BODY_BYTES)) return closeWebSocket(client, 1009, "Message too large");
          payloadLength = Number(length);
          offset = 10;
        }
        const frameLength = offset + (masked ? 4 : 0) + payloadLength;
        if (client.buffer.length < frameLength) return;
        let payload = client.buffer.subarray(offset + (masked ? 4 : 0), frameLength);
        if (masked) {
          const mask = client.buffer.subarray(offset, offset + 4);
          payload = Buffer.from(payload);
          for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
        }
        client.buffer = client.buffer.subarray(frameLength);
        if (opcode === 0x8) return socket.end();
        if (opcode === 0x9) {
          sendWebSocketFrame(socket, payload, 0xA);
          continue;
        }
        if (opcode !== 0x1) continue;
        try {
          client.onMessage?.(JSON.parse(payload.toString("utf8")));
        } catch {
          closeWebSocket(client, 1007, "Invalid JSON");
          return;
        }
      }
    },
  };
  socket.on("data", client.consume);
  socket.on("error", () => socket.destroy());
  socket.on("close", () => {
    if (client.closed) return;
    client.closed = true;
    client.onClose?.();
  });
  return client;
}

function sendWebSocketFrame(socket, payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  socket.write(Buffer.concat([header, body]));
}

function closeWebSocket(client, code, reason) {
  if (client.closed) return;
  const body = Buffer.alloc(2 + Buffer.byteLength(reason));
  body.writeUInt16BE(code, 0);
  body.write(reason, 2);
  sendWebSocketFrame(client.socket, body, 0x8);
  client.socket.end();
}

function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function isAuthorized(request) {
  if (!apiKey) return true;
  return request.headers.authorization === `Bearer ${apiKey}`;
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function sendOpenAiError(response, status, message, code, param = null) {
  sendJson(response, status, { error: { message, type: code, param, code } });
}

function writeSse(response, payload) {
  response.write(`data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`);
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const [key, inline] = value.slice(2).split("=", 2);
    result[key] = inline ?? values[index + 1];
    if (inline === undefined) index += 1;
  }
  return result;
}

function readPort(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("BRIDGE_PORT must be a valid TCP port.");
  return parsed;
}

function resolveBridgeToken(options) {
  const supplied = options.token ?? process.env.BRIDGE_TOKEN;
  if (supplied) return { token: supplied, path: null };

  const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
  const tokenPath = path.resolve(options.tokenFile ?? options["token-file"] ?? process.env.BRIDGE_TOKEN_FILE ?? path.join(serverDirectory, ".ai-bridge-token"));
  const existing = readTokenFile(tokenPath);
  if (existing) return { token: existing, path: tokenPath };

  const generated = crypto.randomBytes(24).toString("base64url");
  try {
    fs.writeFileSync(tokenPath, `${generated}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { token: generated, path: tokenPath };
  } catch (error) {
    if (error?.code !== "EEXIST") throw new Error(`Could not create bridge token file at ${tokenPath}: ${error.message}`);
    const tokenCreatedElsewhere = readTokenFile(tokenPath);
    if (tokenCreatedElsewhere) return { token: tokenCreatedElsewhere, path: tokenPath };
    throw new Error(`Bridge token file at ${tokenPath} is empty.`);
  }
}

function loadBridgeSettings(options) {
  const serverDirectory = path.dirname(fileURLToPath(import.meta.url));
  const settingsPath = path.resolve(options.settingsFile ?? options["settings-file"] ?? process.env.BRIDGE_SETTINGS_FILE ?? path.join(serverDirectory, "ai-bridge.settings.json"));
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("the root value must be a JSON object");
    return {
      path: settingsPath,
      settings: {
        interceptTitleRequests: typeof parsed.interceptTitleRequests === "boolean"
          ? parsed.interceptTitleRequests
          : DEFAULT_BRIDGE_SETTINGS.interceptTitleRequests,
        injectPromptInstructionsEveryMessage: typeof parsed.injectPromptInstructionsEveryMessage === "boolean"
          ? parsed.injectPromptInstructionsEveryMessage
          : DEFAULT_BRIDGE_SETTINGS.injectPromptInstructionsEveryMessage,
        prePrompt: readOptionalSettingsString(parsed.prePrompt, DEFAULT_BRIDGE_SETTINGS.prePrompt, "prePrompt"),
        postPrompt: readOptionalSettingsString(parsed.postPrompt, DEFAULT_BRIDGE_SETTINGS.postPrompt, "postPrompt"),
        disguiseModelNameAsAssistant: typeof parsed.disguiseModelNameAsAssistant === "boolean"
          ? parsed.disguiseModelNameAsAssistant
          : DEFAULT_BRIDGE_SETTINGS.disguiseModelNameAsAssistant,
      },
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error(`Could not load settings file at ${settingsPath}: ${error.message}`);
    const contents = `${JSON.stringify({
      interceptTitleRequests: DEFAULT_BRIDGE_SETTINGS.interceptTitleRequests,
      injectPromptInstructionsEveryMessage: DEFAULT_BRIDGE_SETTINGS.injectPromptInstructionsEveryMessage,
      prePrompt: DEFAULT_BRIDGE_SETTINGS.prePrompt,
      postPrompt: DEFAULT_BRIDGE_SETTINGS.postPrompt,
      "// disguiseModelNameAsAssistant": "Turning on may increase responsiveness of a model to the prompt",
      disguiseModelNameAsAssistant: DEFAULT_BRIDGE_SETTINGS.disguiseModelNameAsAssistant,
    }, null, 2)}\n`;
    try {
      fs.writeFileSync(settingsPath, contents, { encoding: "utf8", flag: "wx" });
    } catch (writeError) {
      if (writeError?.code !== "EEXIST") throw new Error(`Could not create settings file at ${settingsPath}: ${writeError.message}`);
    }
    return loadBridgeSettings({ "settings-file": settingsPath });
  }
}

function resolvePromptInstructionsDirectory(options, settingsPath) {
  const configured = options.promptInstructionsDir
    ?? options["prompt-instructions-dir"]
    ?? process.env.BRIDGE_PROMPT_INSTRUCTIONS_DIR
    ?? path.join(path.dirname(settingsPath), "prompt-instructions");
  return ensurePromptInstructionsLayout(path.resolve(configured));
}

function readOptionalSettingsString(value, fallback, key) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new Error(`'${key}' must be a string`);
  return value.trim();
}

function readTokenFile(tokenPath) {
  try {
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    return token || null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Could not read bridge token file at ${tokenPath}: ${error.message}`);
  }
}

function log(message) {
  console.log(`[ai-bridge] ${message}`);
}
