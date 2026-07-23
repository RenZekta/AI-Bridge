import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PROVIDER_DISPLAY_NAMES,
  buildPromptWithInstructions,
  displayNameForProvider,
  isFirstUserTurn,
  renderPromptTemplate,
  shouldInjectPromptInstructions,
  wrapWithPromptInstructions,
} from "../prompt-instructions.mjs";

const SITE_PROVIDERS = ["grok", "gemini", "deepseek", "perplexity", "qwen", "chatgpt", "claude", "zai", "kimi"];

test("every provider has a display name", () => {
  assert.deepStrictEqual([...SITE_PROVIDERS].sort(), [...Object.keys(PROVIDER_DISPLAY_NAMES)].sort());
});

test("first user turn is detected from the messages array", () => {
  assert.equal(isFirstUserTurn([{ role: "user", content: "hi" }]), true);
  assert.equal(isFirstUserTurn([
    { role: "system", content: "rules" },
    { role: "user", content: "hi" },
  ]), true);
  assert.equal(isFirstUserTurn([
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "again" },
  ]), false);
  assert.equal(shouldInjectPromptInstructions([{ role: "user", content: "hi" }], false), true);
  assert.equal(shouldInjectPromptInstructions([
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "again" },
  ], false), false);
  assert.equal(shouldInjectPromptInstructions([
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "again" },
  ], true), true);
});

test("renders provider display names into prompt templates", () => {
  assert.equal(renderPromptTemplate("You are {{modelName}}.", "claude"), "You are Claude.");
  assert.equal(renderPromptTemplate("You are {{modelName}}.", null), "You are {{modelName}}.");
  assert.equal(
    renderPromptTemplate("You are {{modelName}}.", "claude", { disguiseModelNameAsAssistant: true }),
    "You are an assistant.",
  );
  assert.equal(
    renderPromptTemplate("You are {{modelName}}.", null, { disguiseModelNameAsAssistant: true }),
    "You are an assistant.",
  );
  assert.equal(displayNameForProvider("zai"), "Z.ai");
  assert.equal(displayNameForProvider(null), null);
  assert.throws(() => displayNameForProvider("nope"), /Unsupported provider/);
});

test("disguise setting forces an assistant even for auto-routed providers", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-bridge-disguise-"));
  context.after(async () => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "pre-prompt"), { recursive: true });
  await fs.mkdir(path.join(root, "post-prompt"), { recursive: true });
  await fs.writeFile(path.join(root, "pre-prompt", "Generic Pre-prompt.md"), "Hello {{modelName}}.", "utf8");
  await fs.writeFile(path.join(root, "post-prompt", "Generic Post-prompt.md"), "Bye {{modelName}}.", "utf8");

  const disguised = buildPromptWithInstructions("USER:\nhi", [{ role: "user", content: "hi" }], null, {
    everyMessage: true,
    prePromptName: "Generic Pre-prompt",
    postPromptName: "Generic Post-prompt",
    rootDirectory: root,
    disguiseModelNameAsAssistant: true,
  });
  assert.equal(disguised, "Hello an assistant.\n\nUSER:\nhi\n\nBye an assistant.");
});

test("wraps pre and post prompt instructions around the transcript", () => {
  assert.equal(
    wrapWithPromptInstructions("USER:\nhi", { prePrompt: "PRE", postPrompt: "POST" }),
    "PRE\n\nUSER:\nhi\n\nPOST",
  );
  assert.equal(wrapWithPromptInstructions("USER:\nhi", { prePrompt: "PRE" }), "PRE\n\nUSER:\nhi");
});

test("loads and injects markdown instruction files", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-bridge-prompts-"));
  context.after(async () => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "pre-prompt"), { recursive: true });
  await fs.mkdir(path.join(root, "post-prompt"), { recursive: true });
  await fs.writeFile(path.join(root, "pre-prompt", "ZCode Pre-prompt.md"), "Hello {{modelName}} from ZCode.", "utf8");
  await fs.writeFile(path.join(root, "post-prompt", "ZCode Post-prompt.md"), "Done as {{modelName}}.", "utf8");

  const first = buildPromptWithInstructions("USER:\nfix this", [{ role: "user", content: "fix this" }], "gemini", {
    everyMessage: false,
    prePromptName: "ZCode Pre-prompt",
    postPromptName: "ZCode Post-prompt.md",
    rootDirectory: root,
  });
  assert.equal(first, "Hello Gemini from ZCode.\n\nUSER:\nfix this\n\nDone as Gemini.");

  const later = buildPromptWithInstructions("USER:\nagain", [
    { role: "user", content: "fix this" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "again" },
  ], "gemini", {
    everyMessage: false,
    prePromptName: "ZCode Pre-prompt",
    postPromptName: "ZCode Post-prompt",
    rootDirectory: root,
  });
  assert.equal(later, "USER:\nagain");

  const always = buildPromptWithInstructions("USER:\nagain", [
    { role: "user", content: "fix this" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "again" },
  ], "chatgpt", {
    everyMessage: true,
    prePromptName: "ZCode Pre-prompt",
    postPromptName: "ZCode Post-prompt",
    rootDirectory: root,
  });
  assert.match(always, /^Hello ChatGPT from ZCode\./);
  assert.match(always, /Done as ChatGPT\.$/);
});
