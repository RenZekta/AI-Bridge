# AI BRIDGE ENHANCED — MASTER ENGINEERING PLAN
Version: 1.1 | 2026-11-20 | Status: binding project requirements; implementation evidence is separate.

## Mission and success standard
Fork, preserve, secure and extend RenZekta/AI-Bridge into a lightweight Windows 11 gateway that lets OpenCode submit coding instructions through a user's logged-in, real browser-based AI chat and receive structured results. The browser AI provides reasoning; OpenCode performs authorized local file operations, terminal commands, tests and Git changes. Support other compatible clients through modular adapters after OpenCode works end to end. No Docker, paid API key, or local LLM required for the baseline. A browser subscription is not an official API and does not guarantee continuous availability.

The required full cycle is: OpenCode reads instructions/project context -> gateway forwards a request to a real AI chat tab -> browser extension inserts the whole prompt into the actual composer and submits using the normal UI -> response is extracted -> gateway verifies and translates explicit tool requests -> OpenCode's permission system executes tools -> tool results return to the same AI session -> repeat through fixes, regression tests, and verified Git actions. A simple successful prompt/response is NOT acceptance.

## Source and legal provenance
- Upstream: https://github.com/RenZekta/AI-Bridge ; inspected baseline was declared v0.4.0. Pin exact commit before any code modification, record checksums, review current actual version.
- Preserve original functioning modules, nine providers, extension, Node.js local API, WebSocket, streaming, tests and prompt support. Prefer surgical changes rather than rewriting.
- Original source is AGPL-3.0. Retain notices and satisfy modification/distribution/network source requirements. Any future proprietary licensing plan requires separate legal review.
- Preserve all existing engineering instructions; this plan supplements rather than weakens them.

## Baseline architecture
1. Core gateway: authenticated loopback OpenAI-compatible HTTP API, authenticated WebSocket link, session/request router, bounded queues, streaming, error handling, tool-call parser, state journal and diagnostics.
2. Browser connector: Manifest V3 extension for Chrome and Edge; strict site-scoped permissions; approved domain recognition; UI entry/submit, completion detection, response extraction and page-state observation. Do not use provider private backend APIs for the standard path.
3. Individual provider adapters: ChatGPT, Claude, Gemini, DeepSeek, Grok, Perplexity, Qwen, Z.ai and Kimi, each independently versioned, tested and degradable.
4. Windows controller: lightweight installer, configuration, OpenCode integration wizard, provider status, activity, recovery and sanitized diagnostic reports. No duplicate automation logic in the GUI.
5. Client compatibility adapters: OpenCode first; investigate Claude Code, Codex, and other clients without claiming they are supported until tested.

## Browser interaction — approved design
- Use existing real website tabs authenticated by normal browser login.
- Insert the COMPLETE prompt into the real webpage composer, verify untruncated content and multiline formatting, activate normal Send, verify submission, observe completion, and extract visible response.
- Do NOT implement mandatory character-by-character typing, keystroke simulation, or detection evasion. Full-text insertion is the selected method.
- Avoid taking over unrelated tabs or user-owned sessions; prefer dedicated tab/profile ownership, tab leases and explicit manual/automatic mode arbitration.
- If a user writes to the active browser conversation, detect the conflict, suspend automated submissions, and reconcile conversation state.
- Handle editors, redirects, login expiry, render delays, incomplete replies, rate-limit messages, page revisions and provider-specific layout changes.
- Never advertise provider health merely because a tab is open.

## OpenCode protocol and tool correctness
- Pin and validate actual OpenCode version/provider configuration.
- Implement the required OpenAI-compatible model list, chat completions, streaming, roles, tool declarations, tool_call IDs, tool results, cancellation and error semantics, including multi-tool calls as supported.
- Original best-effort JSON extraction is not sufficient for unattended coding. Require explicitly delimited tool outputs, offered tool-name allowlist, strict JSON-schema argument validation, robust result pairing, uniqueness, ordering and streamed-chunk handling.
- Prevent treating quoted source, logs, ordinary prose, or prompt-injection text as tools. Reject ambiguous/malformed/incomplete tool requests.
- Gateway NEVER executes model-proposed OS commands or writes source code. OpenCode enforces its own permissions, including approval gates for high-risk operations; preserve that boundary even if upstream text claims authority.
- Reject unsupported protocol features explicitly rather than fabricating compatibility.
- Test a genuine read -> edit -> failing test -> fix -> passing regression -> authorized feature-branch commit and PR workflow.

## Security controls — release blocking
Known reviewed risks include an optional/empty local HTTP key, permissive CORS and printing the bridge token in startup logs. Verify current code, fix by tests, and do not assume older findings remain unchanged.
- Mandatory secure API authentication, strong token generation, least-privilege token storage and rotation, no logged or URL-leaked secrets.
- Loopback-only default, strict CORS and Host/Origin checks (including WebSockets), DNS-rebinding protections, CSRF mitigations, bounded body sizes and rate limits.
- Minimum extension host permissions; authenticate and validate all extension messages, all tabs/origins, and every command.
- Treat AI outputs, project documents, browsing content and client payloads as untrusted. Protect against prompt injection and cross-session contamination.
- Restrict gateway filesystem access to its own configuration/state; never extract browser passwords/cookies.
- Dependency pinning, SBOM when practical, audit/review of introduced dependencies, checksums/signatures, integrity-protected updates, negative security tests and independent review.
- Redact secrets, source material, and full conversations from logs by default; configurable retention and explicit sensitive export consent.
- Excluded by user decision: the proposed separate "provider terms and account protection" product requirement. This does not relax technical authorization, account security or service limitations.

## Durable execution and context
- Implement an explicit persisted request state machine: created -> validated -> queued -> assigned -> entering -> ready_to_submit -> submission_uncertain OR submitted -> generating -> response_received -> validated -> completed; plus recoverable_failed, blocked and cancelled.
- Persist request IDs, hashes/fingerprints, provider/tab ownership, conversation ID, last confirmed message, call IDs, tool-result associations and checkpoint timestamps in transactional storage.
- Never automatically retry an uncertain submission or execute a tool twice. Reconcile with actual browser conversation; fail closed if uncertain. Distinguish unsent, submitted, answered, and unknown.
- Use stable correlation IDs for end-to-end traces, bounded retries/backoff, circuit breakers, deadlock/stall detection, queue priorities, cancellation, manual pause/resume and emergency shutdown.
- Recover safely after browser/extension/service crashes, network loss, Windows sleep/wake/restart and authentication expiry. Persist queued work without unsafe replay.
- Maintain conversation continuity and project isolation. Deduplicate only genuinely unchanged context; do not silently drop active standing requirements, critical tool outputs or permission constraints.
- Detect context resets or cross-chat navigation and require verified resynchronization. Do not claim recovered context without evidence.
- Encrypted backup of configuration and recoverable session state; test restoration and migration, with explicit data-retention/deletion controls.

## Provider adapters and fallback
- Separate independently testable, versioned adapters with selectors, login detection, composer/submission checks, generation-complete detection, rate-limit/error recognition and compatibility fixtures.
- Capability discovery must reflect actually verified models, tool behavior, attachments and context limits. Unsupported capabilities must be marked accurately.
- Detect breaking website UI changes, disable unreliable adapters and emit actionable diagnostics; do not blindly guess.
- Fallback only to user-approved, authenticated providers, with explicit project confidentiality controls, capability checks and context replay/verification. Do not silently send source code to another provider.
- Never fake success when a provider cannot return dependable structured tool operations.

## Performance and Windows UX
- Windows 11 target, Node >=20 baseline unless carefully revised, Chrome/Edge extension, optional background startup; no Docker, Ollama, mandatory paid API or heavyweight runtime.
- Event-driven design, bounded queues, bounded memory/log retention, backpressure, cleanup, minimal wakeups, independent measurements for browser RAM and gateway RAM, CPU, disk, responsiveness and idle power.
- Add watchdogs for leaks/runaway processes/disk exhaustion; minimize chat replay and duplicated prompt tokens without corrupting context.
- Installer/uninstaller, reversible OpenCode config edits with backup, browser extension setup guidance, health test, secure credentials, provider/model settings, live activity timeline, diagnostics and one-click sanitized export.
- Windows sleep/wake, shutdown, upgrade, rollback, configuration migrations and offline troubleshooting must have tested behavior.
- Sign distributable artifacts where feasible; ensure verifiable provenance and reproducible builds where practical.

## Automation and development standards
- Before each session: inspect repository, current HEAD, status, open branches/PRs, AGENTS.md, both master docs, README, ROADMAP, FEATURE_STATUS, HANDOFF and recent test evidence. Deduplicate work; don't overwrite other agents.
- Follow a task hierarchy: security defects -> OpenCode true tool cycle -> state/recovery -> provider reliability -> multi-agent compatibility -> Windows UX -> packaging/polish.
- Work on feature branches; small modular changes; root-cause analysis; tests and regression additions; independent reviewer/QA; evidence-based commits and pushes; draft PRs until checks pass; no unsafe merges or bypassing branch protection.
- Never claim tests passed or Windows browser tasks were verified unless truly executed. Clearly distinguish unit, mocked integration and real browser/system acceptance.
- Keep AGENTS.md, README, ARCHITECTURE.md, SECURITY.md, PROVIDER_COMPATIBILITY.md, OPENCODE_INTEGRATION.md, RECOVERY.md, TESTING.md, PERFORMANCE.md, ROADMAP.md, FEATURE_STATUS.md, HANDOFF.md and USER_MANUAL.md accurate.
- Preserve original engineering requirements; no duplication; report real blockers; continue through available roadmap work within current agent execution session.

## Verification matrix and release gates
1. Baseline: original app behavior captured, upstream commit and licenses pinned, existing tests run.
2. Security: unauthenticated HTTP/WebSocket and hostile webpage-origin requests fail; secrets never surface in logs; hostile tool payloads do not execute.
3. OpenCode: real OpenCode read/edit/failing test/fix/passing test/authorized Git path succeeds via live AI chat; structured tool outputs verified.
4. Conversation: session identity, model selection, manual browser interaction, multi-project isolation and long-turn context preserved.
5. Recovery: kill/restart at EVERY request state; no duplicate submission or tool execution in ambiguous cases; safe fail closed.
6. Providers: per-provider real Chrome and Edge page tests; no unverified compatibility labels; layout change and rate-limit handling.
7. Stress: repeated long-running tasks, cancellation, races, concurrent clients, queue fairness, memory/CPU bounds, disk and network failures.
8. Windows: clean install/start, browser connection, OpenCode setup, real task, update, rollback and uninstall exercised on actual Windows 11.
9. Release: static scan, dependencies, signed/verifiable artifacts as appropriate, independent security review, documentation, measurable acceptance metrics and truthful limitations.

Define numeric budgets/targets before performance acceptance. No claim of production readiness from source review, a successful chat reply or mocked tests alone.

## Prioritized milestones
P0 fork/commit pin/baseline/docs;
P1 security hardening;
P2 real OpenCode tool-call acceptance;
P3 durable state, context continuity, crash recovery;
P4 independently verified nine-provider adapters;
P5 long-running autonomous coding / resource and failure stress;
P6 Windows control panel, installer, repair and upgrade;
P7 independent security review, full release acceptance and docs.

## Non-negotiable completion criteria
The gateway is finished only when the actual released Windows build can securely route a real OpenCode coding cycle through an actual authenticated browser chat; validate/return safe tools; keep provider and project contexts isolated; survive verified interruptions without duplicate actions; pass measured multi-provider/security/performance regression gates; and produce traceable, honestly reported release evidence.