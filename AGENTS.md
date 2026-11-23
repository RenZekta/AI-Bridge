# Instructions for agents working on AI Bridge

AI Bridge exposes a logged-in AI chat tab as a local OpenAI-compatible endpoint:
an IDE calls `127.0.0.1:4317/v1`, the server relays over WebSocket to a Manifest
V3 extension, and the extension drives the real website through its DOM. There is
no provider API involved, which means every provider integration is a scraping
problem that can break silently when a website ships.

Solo-developer project, no PR review process. Code and comments should read as if
a single careful engineer wrote them, not as a transcript of a chat session.

## Comments

A comment should tell a future reader something the code itself does not already
say: a non-obvious invariant, a constraint imposed by an external system (a
website's DOM, Chrome's MV3 service-worker lifetime, an IDE's OpenAI client), or
the reason behind a choice that is not the obvious one. If the code is
self-explanatory, do not add a comment to narrate it.

Do not reference the conversation, PR, or task that produced a change. No
"Task 3", "as requested", "as discussed", "the user reported". Write the comment
as if it has always been there.

When explaining a fix, describe the invariant or failure mode itself, not the fact
that a bug existed. "X must happen before Y because Z" stays useful; "fixed a bug
where X happened before Y" stops being useful the next time the code changes.

```
// GOOD (states a constraint the code cannot express)
// Must match assistant turns only. latestResponseText() takes the last match in
// DOM order, and right after submission the newest element is the user's own
// message, so a selector broad enough to catch both makes the bridge return the
// prompt instead of the reply.

// BAD (references a selector that no longer exists in this file)
// Assistant turns only. "[class*='message-content']" also matches the user's own
// .user-message-content, which right after submission is the prompt just sent.
```

```
// GOOD (code is self-explanatory, no comment needed)
const quietFor = Date.now() - lastChangeAt;

// BAD (restates the code)
// How long the response text has been unchanged
const quietFor = Date.now() - lastChangeAt;
```

When editing existing code, replace the old comment rather than leaving it beside a
new one saying something similar. A function gets one coherent explanation, not a
changelog of every pass over it.

## Text and writing

- Do not write personal information anywhere.
- Do not document changes as if explaining them to the developer who made them.
- Comment rules apply to UI strings, menus, and docs too.
- Avoid self-explanatory descriptions.
- Be brief.

## Code style

No linter or formatter is configured, so match the surrounding file: two-space
indent, double quotes, semicolons, camelCase, ES modules. Prefer extending an
existing helper over adding a parallel one that does nearly the same thing.

Plain ASCII in code, comments, and prose. Strings the product genuinely needs are
exempt: localized selectors such as `aria-label*='停止'` and single-character badge
glyphs stay exactly as the site or the badge requires.

## The provider registry is the most bug-prone seam

Adding or renaming a provider means updating five places, and they fail silently
when they drift:

1. `PROVIDERS` in `local-server.mjs` (drives model routing and `/v1/models`)
2. `PROVIDER_DISPLAY_NAMES` in `prompt-instructions.mjs`
3. `PROVIDER_DISPLAY_NAMES` in `extension/content.js` (fills `{{modelName}}` from
   the live hostname when the IDE used `bridge-auto`)
4. `PROVIDERS` in `extension/background.js` (label, home URL, tab match patterns)
5. `SITE_CONFIG` in `extension/content.js` plus `detectProvider()` in the same file,
   and `host_permissions` + `content_scripts.matches` in `extension/manifest.json`

`test/provider-registry.test.mjs` asserts all of these stay in agreement, including
that manifest host permissions and content-script matches are identical. Run it
after touching any provider list rather than eyeballing the diff.

## Website analysis before writing an adapter

Selectors written from memory or from a screenshot are the main source of broken
adapters here. Verify them against the live DOM first. Open the site, run the
snippet in DevTools, and read the output before editing `SITE_CONFIG`.

Check every selector the adapter will use, including the ones already in the file:

```js
(() => {
  const vis = (el) => { const c = getComputedStyle(el); return c.display !== "none" && c.visibility !== "hidden" && el.getClientRects().length > 0; };
  const probe = (sel) => { const all = [...document.querySelectorAll(sel)]; const v = all.filter(vis);
    return { sel, matches: all.length, visible: v.length, first: v[0] ? v[0].className : null }; };
  console.log(JSON.stringify(["textarea", "[contenteditable='true']"].map(probe), null, 2));
})();
```

Then get the real class chains rather than guessing at them. The chain shows which
container belongs to the assistant and which to the user, and whether a code block is
a plain `<pre>` or an editor widget that keeps its own line numbers:

```js
(() => {
  const c = (el) => el.tagName.toLowerCase() + (typeof el.className === "string" && el.className ? "." + el.className.trim().replace(/\s+/g, ".") : "");
  const chain = (el) => { const out = []; let n = el; for (let i = 0; i < 6 && n; i++) { out.push(c(n)); n = n.parentElement; } return out; };
  console.log(JSON.stringify([...document.querySelectorAll("[class*='message']")].map((el) => ({ chain: chain(el), text: (el.innerText || "").slice(0, 40) })), null, 2));
})();
```

Answer these before trusting an adapter:

- **Does the output selector match assistant turns only?** If it also matches the
  user's own message, `latestResponseText()` returns the prompt you just sent. This
  fails silently: the request succeeds, `finish_reason` is `stop`, and the caller
  gets its own prompt back. It is the single most dangerous mistake in this codebase.
- **Is the site's UI localized?** `aria-label` values are translated, so
  `aria-label*='Stop'` does not match `Стоп`. Confirm against the actual locale, or
  match on a class the site does not translate.
- **Does the site render code with an editor widget?** Monaco and CodeMirror place
  each line in an absolutely positioned row and keep the language label and line
  numbers in separate chrome, so `textContent` of the block merges everything onto
  one line and includes the gutter. `renderCodeBlock` handles Monaco; check whether
  the widget is the same one before assuming it applies. Monaco also virtualizes, so
  lines outside the viewport may not exist in the DOM at all.
- **Is the composer present while logged out?** Some sites render it anyway, which
  means a missing composer is not a reliable sign of being logged out.
- **Does the send control exist before the composer has text?** Many sites only
  reveal it after input, so a send-button probe on an empty page proves nothing.

Prefer a selector scoped to a stable container class over a substring match like
`[class*='message-content']`; substring matches routinely catch more of the page
than intended.

## Adapter conventions

- Per-provider behaviour belongs in that provider's `SITE_CONFIG` entry, using the
  existing optional fields (`extractor`, `streamFinalOnly`), not in a
  `if (PROVIDER === "...")` branch inside shared code.
- A selector that matches nothing is worse than no selector: it looks configured and
  behaves as a fallback. If a provider-specific selector cannot be verified, say so
  in a comment and mark the provider experimental in the README.
- `bridge:complete` carries the authoritative text for a turn. Chunks are an
  optimisation; do not treat them as the source of truth.
- Uncertain submissions must not be retried blindly. A request that fails after the
  prompt was already typed into the page will duplicate the turn if retried.

## Settings

`ai-bridge.settings.json` is local per-machine configuration and git-ignored, so new
options go in `ai-bridge.settings.example.json`, the file that documents the shape.
`providers` holds per-provider overrides, and an empty `prePrompt` or `postPrompt`
means "off for this provider", not "inherit".

The bridge token, browser profiles and scratch directories are git-ignored too. When
a change introduces a new kind of local state, add it to `.gitignore` in the same
commit, rather than leaving the next person to work out what should have been
ignored.

## Testing

```
npm test
```

The suite spawns the real server and connects a fake extension over WebSocket, so it
covers routing, streaming, tool-call lifting, settings, and the provider registry.
It does not cover the extension's DOM code: there is no harness for `content.js`, so
adapter changes are only proven by a real browser run against the live site. Say
which kind of verification a change actually had instead of implying more than was
done.
