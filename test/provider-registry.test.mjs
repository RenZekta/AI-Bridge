import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { PROVIDER_DISPLAY_NAMES } from "../prompt-instructions.mjs";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

// Returns the object keys declared at the top level of the named object literal.
function objectKeys(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `${declaration} not found`);
  const block = source.slice(start, source.indexOf("\n};", start));
  return [...block.matchAll(/^  ([a-z][a-z0-9]*):/gm)].map((match) => match[1]);
}

const serverProviders = read("local-server.mjs")
  .match(/const PROVIDERS = \[([^\]]+)\]/)[1]
  .split(",")
  .map((value) => value.trim().replace(/["']/g, ""))
  .filter((value) => value && value !== "auto");

const backgroundProviders = objectKeys(read("extension/background.js"), "const PROVIDERS = {");
const contentProviders = objectKeys(read("extension/content.js"), "const PROVIDER_DISPLAY_NAMES = {");
const siteConfigs = objectKeys(read("extension/content.js"), "const SITE_CONFIG = {");
const displayNames = Object.keys(PROVIDER_DISPLAY_NAMES);

const manifest = JSON.parse(read("extension/manifest.json"));
const manifestHosts = manifest.host_permissions.filter((pattern) => pattern.startsWith("https://"));
const manifestMatches = manifest.content_scripts[0].matches;

test("every provider is registered in all five places", () => {
  assert.ok(serverProviders.length > 0, "no providers found in local-server.mjs");
  assert.deepStrictEqual([...backgroundProviders].sort(), [...serverProviders].sort(), "extension/background.js PROVIDERS drifted");
  assert.deepStrictEqual([...contentProviders].sort(), [...serverProviders].sort(), "extension/content.js PROVIDER_DISPLAY_NAMES drifted");
  assert.deepStrictEqual([...siteConfigs].sort(), [...serverProviders].sort(), "extension/content.js SITE_CONFIG drifted");
  assert.deepStrictEqual([...displayNames].sort(), [...serverProviders].sort(), "prompt-instructions.mjs PROVIDER_DISPLAY_NAMES drifted");
});

test("manifest host permissions and content script matches stay in sync", () => {
  assert.deepStrictEqual([...manifestHosts].sort(), [...manifestMatches].sort());
});

test("every provider has a home URL and at least one match pattern", () => {
  const background = read("extension/background.js");
  for (const provider of serverProviders) {
    const entry = background.match(new RegExp(`^  ${provider}: \\{([^}]*)\\}`, "m"));
    assert.ok(entry, `${provider} missing from extension/background.js PROVIDERS`);
    assert.match(entry[1], /home: "https:\/\/[^"]+"/, `${provider} has no home URL`);
    assert.match(entry[1], /matches: \["https:\/\/[^"]+"/, `${provider} has no match pattern`);
  }
});
