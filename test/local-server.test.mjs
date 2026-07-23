import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  probe.close();
  await once(probe, "close");
  return port;
}

test("serves the local OpenAI discovery and unavailable-bridge contracts", async (context) => {
  const port = await freePort();
  const child = spawn(process.execPath, ["local-server.mjs", `--port=${port}`, "--token=test-token"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  context.after(() => child.kill());
  await once(child.stdout, "data");

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const models = await fetch(`http://127.0.0.1:${port}/v1/models`);
  assert.equal(models.status, 200);
  assert.ok((await models.json()).data.some((model) => model.id === "bridge-chatgpt"));

  const completion = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "bridge-gemini", messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(completion.status, 503);
  assert.equal((await completion.json()).error.code, "bridge_unavailable");

  const title = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "bridge-gemini",
      messages: [
        { role: "user", content: "Fix the extension reconnect loop after a service worker restart." },
        { role: "user", content: "Generate a concise title for this conversation. Return only the title." },
      ],
    }),
  });
  assert.equal(title.status, 200);
  assert.match((await title.json()).choices[0].message.content, /Fix extension reconnect loop/i);

  const streamedTitle = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "bridge-gemini",
      stream: true,
      messages: [
        { role: "user", content: "Document the bridge token persistence behavior." },
        { role: "user", content: "Write a short title for this chat. Title only." },
      ],
    }),
  });
  assert.equal(streamedTitle.status, 200);
  assert.match(await streamedTitle.text(), /Document bridge token persistence behavior/);

  const extension = new WebSocket(`ws://127.0.0.1:${port}/bridge?token=test-token`);
  context.after(() => extension.close());
  await new Promise((resolve, reject) => {
    extension.addEventListener("open", resolve, { once: true });
    extension.addEventListener("error", () => reject(new Error("Test extension WebSocket could not connect.")), { once: true });
  });
  extension.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type !== "bridge:run") return;
    extension.send(JSON.stringify({ type: "bridge:chunk", id: message.id, text: "Hello from the browser" }));
    extension.send(JSON.stringify({ type: "bridge:complete", id: message.id }));
  });
  extension.send(JSON.stringify({ type: "bridge:hello", version: "test", providers: ["gemini"] }));
  const pong = new Promise((resolve) => {
    extension.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "bridge:pong") resolve(message);
    }, { once: false });
  });
  extension.send(JSON.stringify({ type: "bridge:ping" }));
  assert.equal((await pong).type, "bridge:pong");

  const bridged = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "bridge-gemini", messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(bridged.status, 200);
  assert.equal((await bridged.json()).choices[0].message.content, "Hello from the browser");

  const streamed = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "bridge-gemini", stream: true, messages: [{ role: "user", content: "stream" }] }),
  });
  assert.equal(streamed.status, 200);
  const eventStream = await streamed.text();
  assert.match(eventStream, /"content":"Hello from the browser"/);
  assert.match(eventStream, /data: \[DONE\]/);
});

test("persists a generated bridge token unless one is supplied", async (context) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "ai-bridge-token-"));
  const tokenFile = path.join(folder, "token");
  context.after(async () => fs.rm(folder, { recursive: true, force: true }));

  const first = await startServerWithTokenFile(tokenFile);
  const firstToken = await first.token;
  first.child.kill();
  await once(first.child, "exit");
  assert.equal((await fs.readFile(tokenFile, "utf8")).trim(), firstToken);

  const second = await startServerWithTokenFile(tokenFile);
  const secondToken = await second.token;
  second.child.kill();
  await once(second.child, "exit");
  assert.equal(secondToken, firstToken);
});

async function startServerWithTokenFile(tokenFile) {
  const port = await freePort();
  const child = spawn(process.execPath, ["local-server.mjs", `--port=${port}`, "--token-file", tokenFile], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  const token = new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/Bridge token: (.+)/);
      if (match) resolve(match[1].trim());
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Server stopped before publishing its token (exit ${code}).`)));
  });
  return { child, token };
}
