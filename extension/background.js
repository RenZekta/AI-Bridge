const PROVIDERS = {
  grok: { label: "Grok", home: "https://grok.com/", matches: ["https://grok.com/*"] },
  gemini: { label: "Gemini", home: "https://gemini.google.com/app", matches: ["https://gemini.google.com/*"] },
  deepseek: { label: "DeepSeek", home: "https://chat.deepseek.com/", matches: ["https://chat.deepseek.com/*"] },
  perplexity: { label: "Perplexity", home: "https://www.perplexity.ai/", matches: ["https://www.perplexity.ai/*"] },
  qwen: { label: "Qwen", home: "https://chat.qwen.ai/", matches: ["https://chat.qwen.ai/*", "https://chat.qwenlm.ai/*"] },
  chatgpt: { label: "ChatGPT", home: "https://chatgpt.com/", matches: ["https://chatgpt.com/*"] },
  claude: { label: "Claude", home: "https://claude.ai/", matches: ["https://claude.ai/*"] },
  zai: { label: "Z.ai", home: "https://chat.z.ai/", matches: ["https://chat.z.ai/*"] },
  kimi: { label: "Kimi", home: "https://www.kimi.com/", matches: ["https://www.kimi.com/*"] },
};

const DEFAULT_SETTINGS = {
  serverUrl: "http://127.0.0.1:4317",
  token: "",
  defaultProvider: "auto",
  paused: false,
};

const HEARTBEAT_INTERVAL_MS = 20_000;
let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let socketState = "disconnected";
let lastError = "";
let closingForPause = false;

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(DEFAULT_SETTINGS);
  await chrome.storage.local.set(existing);
  connect();
});

chrome.runtime.onStartup.addListener(connect);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.paused) {
    if (changes.paused.newValue) pauseBridge();
    else connect(true);
    return;
  }
  if (changes.serverUrl || changes.token) connect(true);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "bridge:get-state") {
    getState().then(sendResponse);
    return true;
  }
  if (message?.type === "bridge:open-provider") {
    openProvider(message.provider).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "bridge:reconnect") {
    connect(true);
    sendResponse({ ok: true });
    return;
  }
  if (message?.type === "bridge:toggle-pause") {
    chrome.storage.local.get(DEFAULT_SETTINGS).then(async (settings) => {
      await chrome.storage.local.set({ paused: !settings.paused });
      sendResponse({ ok: true, paused: !settings.paused });
    });
    return true;
  }
  if (message?.type === "bridge:site-message") {
    const provider = providerForUrl(sender.tab?.url);
    sendToServer({ ...message.message, provider });
  }
});

connect();

async function connect(force = false) {
  clearTimeout(reconnectTimer);
  closingForPause = false;
  if (socket && !force && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  if (socket) {
    stopHeartbeat();
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  if (settings.paused) {
    socketState = "paused";
    lastError = "";
    updateBadge();
    return;
  }
  if (!settings.token.trim()) {
    socketState = "needs-token";
    lastError = "Paste the bridge token from the local server.";
    updateBadge();
    return;
  }
  const endpoint = toWebSocketUrl(settings.serverUrl, settings.token);
  socketState = "connecting";
  lastError = "";
  updateBadge();
  try {
    socket = new WebSocket(endpoint);
  } catch (error) {
    scheduleReconnect(error.message);
    return;
  }
  socket.onopen = () => {
    socketState = "connected";
    lastError = "";
    sendToServer({ type: "bridge:hello", version: chrome.runtime.getManifest().version, providers: Object.keys(PROVIDERS) });
    startHeartbeat();
    updateBadge();
  };
  socket.onmessage = (event) => {
    try {
      handleServerMessage(JSON.parse(event.data));
    } catch {
      lastError = "The local bridge sent invalid data.";
    }
  };
  socket.onerror = () => {
    lastError = "Could not reach the local bridge.";
  };
  socket.onclose = () => {
    stopHeartbeat();
    socket = null;
    if (closingForPause) return;
    socketState = "disconnected";
    updateBadge();
    scheduleReconnect(lastError || "Local bridge disconnected.");
  };
}

function scheduleReconnect(error) {
  lastError = error;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(async () => {
    const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
    if (!settings.paused) connect(true);
  }, 3000);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (socket?.readyState !== WebSocket.OPEN) return stopHeartbeat();
    sendToServer({ type: "bridge:ping", at: Date.now() });
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function pauseBridge() {
  closingForPause = true;
  clearTimeout(reconnectTimer);
  stopHeartbeat();
  socketState = "paused";
  lastError = "";
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  updateBadge();
}

async function handleServerMessage(message) {
  if (message?.type !== "bridge:run" || typeof message.id !== "string") return;
  const tab = await findTargetTab(message.provider);
  if (!tab?.id) {
    sendToServer({
      type: "bridge:error",
      id: message.id,
      message: message.provider
        ? `Open a logged-in ${PROVIDERS[message.provider]?.label ?? message.provider} tab, then retry.`
        : "Open a logged-in supported AI chat tab, then retry.",
    });
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "bridge:run", id: message.id, prompt: message.prompt });
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    sendToServer({ type: "bridge:error", id: message.id, message: "The AI Bridge content script is not ready in the selected tab. Reload that tab and retry." });
  }
}

async function findTargetTab(requestedProvider) {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const provider = requestedProvider || (settings.defaultProvider === "auto" ? null : settings.defaultProvider);
  const patterns = provider ? PROVIDERS[provider]?.matches : Object.values(PROVIDERS).flatMap((item) => item.matches);
  if (!patterns?.length) return null;
  const tabs = await chrome.tabs.query({ url: patterns });
  return tabs.sort((left, right) => Number(Boolean(right.active)) - Number(Boolean(left.active)) || Number(Boolean(right.highlighted)) - Number(Boolean(left.highlighted)))[0] ?? null;
}

function sendToServer(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function toWebSocketUrl(serverUrl, token) {
  const url = new URL(serverUrl.trim());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/bridge";
  url.search = "";
  url.searchParams.set("token", token.trim());
  return url.toString();
}

async function openProvider(provider) {
  const item = PROVIDERS[provider];
  if (!item) throw new Error("Unknown provider.");
  const existing = await chrome.tabs.query({ url: item.matches });
  if (existing[0]?.id) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: item.home, active: true });
}

function providerForUrl(url) {
  if (!url) return null;
  return Object.entries(PROVIDERS).find(([, item]) => item.matches.some((pattern) => url.startsWith(pattern.replace("*", ""))))?.[0] ?? null;
}

async function getState() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { settings, socketState, lastError, providers: PROVIDERS };
}

function updateBadge() {
  const text = socketState === "connected" ? "ON" : socketState === "paused" ? "II" : socketState === "needs-token" ? "!" : "×";
  const color = socketState === "connected" ? "#16794a" : socketState === "paused" || socketState === "needs-token" ? "#b7791f" : "#a73737";
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}
