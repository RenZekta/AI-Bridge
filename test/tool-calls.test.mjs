import assert from "node:assert/strict";
import test from "node:test";
import {
  extractToolCall,
  makeAssistantMessage,
  normalizeToolArguments,
  toolNamesFromTools,
} from "../tool-calls.mjs";

const bashTools = [
  { type: "function", function: { name: "Bash", parameters: { type: "object" } } },
];

const multiTools = [
  { type: "function", function: { name: "Bash", parameters: { type: "object" } } },
  { type: "function", function: { name: "Read", parameters: { type: "object" } } },
  { name: "Write", parameters: { type: "object" } },
];

test("parses OpenAI and legacy tool request schemas for offered names", () => {
  assert.deepEqual(toolNamesFromTools(bashTools), ["Bash"]);
  assert.deepEqual(toolNamesFromTools(multiTools), ["Bash", "Read", "Write"]);
  assert.deepEqual(toolNamesFromTools(null), []);
  assert.deepEqual(toolNamesFromTools([{ type: "function", function: {} }]), []);
});

test("extracts bare JSON tool calls matching the request tools", () => {
  const raw = "{\"name\":\"Bash\",\"arguments\":{\"command\":\"ls -la\",\"description\":\"List files in current directory\"}}";
  assert.deepEqual(extractToolCall(raw, bashTools), {
    name: "Bash",
    arguments: { command: "ls -la", description: "List files in current directory" },
  });
});

test("extracts fenced and prose-wrapped tool calls", () => {
  const fenced = "Sure.\n\n```json\n{\"name\":\"Bash\",\"arguments\":{\"command\":\"pwd\"}}\n```\n";
  assert.equal(extractToolCall(fenced, bashTools)?.name, "Bash");
  assert.deepEqual(extractToolCall(fenced, bashTools)?.arguments, { command: "pwd" });

  const jsFence = "```javascript\n{\"name\":\"Read\",\"arguments\":{\"path\":\"README.md\"}}\n```";
  assert.equal(extractToolCall(jsFence, multiTools)?.name, "Read");

  const prose = "Let me check that.\n{\"name\":\"Bash\",\"arguments\":{\"command\":\"pwd\"}}\nDone.";
  assert.equal(extractToolCall(prose, bashTools)?.arguments.command, "pwd");
});

test("extracts nested-object arguments and pre-stringified argument fields", () => {
  const nested = "{\"name\":\"Write\",\"arguments\":{\"path\":\"a.txt\",\"contents\":{\"ok\":true,\"items\":[1,2]}}}";
  assert.deepEqual(extractToolCall(nested, multiTools)?.arguments, {
    path: "a.txt",
    contents: { ok: true, items: [1, 2] },
  });

  const stringArgs = "{\"name\":\"Bash\",\"arguments\":\"{\\\"command\\\":\\\"ls\\\"}\"}";
  assert.equal(extractToolCall(stringArgs, bashTools)?.arguments, "{\"command\":\"ls\"}");
  assert.equal(
    normalizeToolArguments(extractToolCall(stringArgs, bashTools).arguments),
    "{\"command\":\"ls\"}",
  );
});

test("prefers a valid offered tool when multiple JSON objects appear", () => {
  const mixed = [
    "Notes: {\"ok\":true}",
    "{\"name\":\"NotATool\",\"arguments\":{}}",
    "{\"name\":\"Read\",\"arguments\":{\"path\":\"local-server.mjs\"}}",
  ].join("\n");
  assert.deepEqual(extractToolCall(mixed, multiTools), {
    name: "Read",
    arguments: { path: "local-server.mjs" },
  });
});

test("ignores JSON that is not an offered tool or is malformed", () => {
  const raw = "{\"name\":\"NotATool\",\"arguments\":{\"command\":\"ls\"}}";
  assert.equal(extractToolCall(raw, bashTools), null);
  assert.equal(extractToolCall(raw, []), null);
  assert.equal(extractToolCall("plain answer", bashTools), null);
  assert.equal(extractToolCall("{\"name\":\"Bash\",\"arguments\":", bashTools), null);
  assert.equal(extractToolCall("{\"name\":1,\"arguments\":{}}", bashTools), null);
  assert.equal(extractToolCall("{\"name\":\"Bash\",\"arguments\":false}", bashTools), null);
  // Array-wrapped payloads still yield the inner object via balanced-brace scan.
  assert.equal(extractToolCall("[{\"name\":\"Bash\",\"arguments\":{}}]", bashTools)?.name, "Bash");
});

test("builds OpenAI tool_calls with stringified arguments", () => {
  const message = makeAssistantMessage(
    "{\"name\":\"Bash\",\"arguments\":{\"command\":\"ls -la\"}}",
    bashTools,
  );
  assert.equal(message.content, null);
  assert.equal(message.tool_calls.length, 1);
  assert.equal(message.tool_calls[0].type, "function");
  assert.equal(message.tool_calls[0].function.name, "Bash");
  assert.equal(typeof message.tool_calls[0].function.arguments, "string");
  assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments), { command: "ls -la" });
  assert.match(message.tool_calls[0].id, /^call_/);

  const plain = makeAssistantMessage("No tools needed.", bashTools);
  assert.equal(plain.content, "No tools needed.");
  assert.equal(plain.tool_calls, undefined);
});

test("normalizes object and pre-stringified arguments", () => {
  assert.equal(normalizeToolArguments({ command: "ls" }), "{\"command\":\"ls\"}");
  assert.equal(normalizeToolArguments("{\"command\":\"ls\"}"), "{\"command\":\"ls\"}");
  assert.equal(normalizeToolArguments(null), "{}");
  assert.equal(normalizeToolArguments(undefined), "{}");
  assert.equal(normalizeToolArguments(""), "{}");
  assert.equal(normalizeToolArguments("not-json"), "{\"value\":\"not-json\"}");
});

test("matches tool names case-insensitively to the canonical schema name", () => {
  assert.equal(extractToolCall("{\"name\":\"bash\",\"arguments\":{}}", bashTools)?.name, "Bash");
  assert.equal(extractToolCall("{\"name\":\"READ\",\"arguments\":{\"path\":\"x\"}}", multiTools)?.name, "Read");
});

test("accepts empty arguments objects from local IDE-style requests", () => {
  assert.deepEqual(extractToolCall("{\"name\":\"Bash\"}", bashTools), { name: "Bash", arguments: {} });
  assert.deepEqual(extractToolCall("{\"name\":\"Bash\",\"arguments\":{}}", bashTools), {
    name: "Bash",
    arguments: {},
  });
});
