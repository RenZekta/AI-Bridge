/**
 * Best-effort conversion of plain-text model output into OpenAI tool_calls.
 * Providers only give a chat textbox — no schema-constrained decoding — so extraction
 * must tolerate fences, prose wrappers, and minor formatting drift.
 */

import crypto from "node:crypto";

export function toolNamesFromTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((tool) => {
      if (typeof tool?.function?.name === "string") return tool.function.name;
      if (typeof tool?.name === "string") return tool.name;
      return null;
    })
    .filter(Boolean);
}

export function extractToolCall(rawText, availableTools) {
  const toolNames = toolNamesFromTools(availableTools);
  if (!toolNames.length || typeof rawText !== "string" || !rawText.trim()) return null;

  const candidates = collectJsonCandidates(rawText);
  for (const candidate of candidates) {
    const parsed = parseToolCallObject(candidate, toolNames);
    if (parsed) return parsed;
  }
  return null;
}

export function makeAssistantMessage(text, tools) {
  const toolCall = extractToolCall(text, tools);
  if (!toolCall) return { role: "assistant", content: text };

  return {
    role: "assistant",
    content: null,
    tool_calls: [{
      id: `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: normalizeToolArguments(toolCall.arguments),
      },
    }],
  };
}

export function normalizeToolArguments(args) {
  if (args === undefined || args === null) return "{}";
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed) return "{}";
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      return JSON.stringify({ value: args });
    }
  }
  if (typeof args === "object") return JSON.stringify(args);
  return JSON.stringify({});
}

function parseToolCallObject(candidate, toolNames) {
  let value;
  try {
    value = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.name !== "string") return null;

  const canonicalName = matchToolName(value.name, toolNames);
  if (!canonicalName) return null;

  if (value.arguments !== undefined && value.arguments !== null) {
    if (typeof value.arguments !== "object" && typeof value.arguments !== "string") return null;
  }

  return { name: canonicalName, arguments: value.arguments ?? {} };
}

function matchToolName(name, toolNames) {
  if (toolNames.includes(name)) return name;
  const lowered = name.toLowerCase();
  return toolNames.find((toolName) => toolName.toLowerCase() === lowered) ?? null;
}

function collectJsonCandidates(rawText) {
  const trimmed = rawText.trim();
  const candidates = [];

  // Prefer fenced blocks (common when chat UIs render JSON as code).
  for (const match of trimmed.matchAll(/```(?:json|javascript|js)?\s*([\s\S]*?)```/gi)) {
    const body = match[1]?.trim();
    if (body) candidates.push(body);
  }

  candidates.push(trimmed);
  for (const objectText of extractBalancedJsonObjects(trimmed)) {
    candidates.push(objectText);
  }

  return [...new Set(candidates)];
}

function extractBalancedJsonObjects(text) {
  const results = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let cursor = index; cursor < text.length; cursor += 1) {
      const char = text[cursor];
      if (inString) {
        if (escape) escape = false;
        else if (char === "\\") escape = true;
        else if (char === "\"") inString = false;
        continue;
      }
      if (char === "\"") {
        inString = true;
        continue;
      }
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          results.push(text.slice(index, cursor + 1));
          break;
        }
      }
    }
  }
  return results;
}
