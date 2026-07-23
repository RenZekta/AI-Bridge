import fs from "node:fs";
import path from "node:path";

export const PROVIDER_DISPLAY_NAMES = Object.freeze({
  grok: "Grok",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  perplexity: "Perplexity",
  qwen: "Qwen",
  chatgpt: "ChatGPT",
  claude: "Claude",
  zai: "Z.ai",
  kimi: "Kimi",
});

export const DEFAULT_PROMPT_INSTRUCTION_SETTINGS = Object.freeze({
  injectPromptInstructionsEveryMessage: true,
  prePrompt: "Generic Pre-prompt",
  postPrompt: "Generic Post-prompt",
  // Turning on may increase responsiveness of a model to the prompt.
  disguiseModelNameAsAssistant: false,
});

export const DISGUISED_MODEL_NAME = "an assistant";

export function isFirstUserTurn(messages) {
  if (!Array.isArray(messages)) return false;
  const userTurns = messages.filter((message) => message?.role === "user");
  return userTurns.length <= 1;
}

export function shouldInjectPromptInstructions(messages, everyMessage) {
  return everyMessage === true || isFirstUserTurn(messages);
}

export function displayNameForProvider(provider) {
  if (!provider) return null;
  const name = PROVIDER_DISPLAY_NAMES[provider];
  if (!name) throw new Error(`Unsupported provider for prompt instructions: ${provider}`);
  return name;
}

export function renderPromptTemplate(template, provider, options = {}) {
  if (!template) return "";
  if (options.disguiseModelNameAsAssistant) {
    return template.replaceAll("{{modelName}}", DISGUISED_MODEL_NAME);
  }
  const modelName = displayNameForProvider(provider);
  // When the IDE uses bridge-auto, the server does not yet know which tab will answer.
  // Leave {{modelName}} for the content script to fill from the live page hostname.
  if (!modelName) return template;
  return template.replaceAll("{{modelName}}", modelName);
}

export function wrapWithPromptInstructions(prompt, { prePrompt = "", postPrompt = "" } = {}) {
  const parts = [];
  if (prePrompt) parts.push(prePrompt);
  parts.push(prompt);
  if (postPrompt) parts.push(postPrompt);
  return parts.join("\n\n");
}

export function resolvePromptInstructionPath(rootDirectory, kind, name) {
  const stem = normalizeInstructionName(name);
  if (!stem) return null;
  return path.join(rootDirectory, kind, `${stem}.md`);
}

export function loadPromptInstructionFile(rootDirectory, kind, name) {
  const filePath = resolvePromptInstructionPath(rootDirectory, kind, name);
  if (!filePath) return "";
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Prompt instruction file not found: ${filePath}`);
    throw new Error(`Could not read prompt instruction file at ${filePath}: ${error.message}`);
  }
}

export function buildPromptWithInstructions(prompt, messages, provider, options) {
  const {
    everyMessage,
    prePromptName,
    postPromptName,
    rootDirectory,
    disguiseModelNameAsAssistant = false,
  } = options;
  if (!shouldInjectPromptInstructions(messages, everyMessage)) return prompt;

  const renderOptions = { disguiseModelNameAsAssistant };
  const prePrompt = renderPromptTemplate(
    loadPromptInstructionFile(rootDirectory, "pre-prompt", prePromptName),
    provider,
    renderOptions,
  );
  const postPrompt = renderPromptTemplate(
    loadPromptInstructionFile(rootDirectory, "post-prompt", postPromptName),
    provider,
    renderOptions,
  );
  return wrapWithPromptInstructions(prompt, { prePrompt, postPrompt });
}

export function ensurePromptInstructionsLayout(rootDirectory) {
  const preDir = path.join(rootDirectory, "pre-prompt");
  const postDir = path.join(rootDirectory, "post-prompt");
  fs.mkdirSync(preDir, { recursive: true });
  fs.mkdirSync(postDir, { recursive: true });

  const prePath = path.join(preDir, "Generic Pre-prompt.md");
  const postPath = path.join(postDir, "Generic Post-prompt.md");
  if (!fs.existsSync(prePath)) {
    fs.writeFileSync(prePath, `${DEFAULT_PRE_PROMPT_TEMPLATE}\n`, "utf8");
  }
  if (!fs.existsSync(postPath)) {
    fs.writeFileSync(postPath, `${DEFAULT_POST_PROMPT_TEMPLATE}\n`, "utf8");
  }
  return rootDirectory;
}

function normalizeInstructionName(name) {
  if (typeof name !== "string") return "";
  const trimmed = name.trim();
  if (!trimmed) return "";
  return trimmed.replace(/\.md$/i, "");
}

const DEFAULT_PRE_PROMPT_TEMPLATE = [
  "This message was relayed through AI Bridge, connecting an IDE to this chat tab.",
  "You're still {{modelName}}; the IDE tool name is not yours. Respond as yourself.",
].join(" ");

const DEFAULT_POST_PROMPT_TEMPLATE = [
  "Follow the IDE's tool and formatting conventions from the message above when they apply.",
  "Otherwise answer normally as {{modelName}}.",
].join(" ");
