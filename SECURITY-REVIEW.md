# Security Review — Motion Graphic template sandbox

**Scope:** `src/template-host.ts` (the MG/template evaluation sandbox) and its reachable blast radius.
**Date:** 2026-09-04
**Status:** Findings only. No code changes were made as part of this review.

---

## Why this surface matters

Motion Graphic templates are `({item}) => JSX` arrow functions that are:

- authored by AI agents (`create_motion_graphic_from_code`, `submit_motion_graphic`, `edit_asset`),
- shipped inside third-party plugin packs, or
- supplied by users.

They are compiled with Babel and evaluated **in the renderer process**, in the top-level
application document (`src/editor/TimelineGraphicLayers.tsx:71`, `src/media/MgThumb.tsx:26`).

`src/template-host.ts:14-18` already documents that this is *"hardening, NOT a hard VM
boundary"* and prescribes an `<iframe sandbox="allow-scripts">` or QuickJS realm for
production. **That mitigation is not implemented anywhere in the repository.**

The findings below are grouped into what the file's own comment acknowledges and what it
does not. The second group is the material part: several bypasses are considerably more
direct than the "dynamically-computed prototype-chain constructor traversal" the comment
names as the residual risk.

---

## Summary

| # | Severity | File | Lines | Finding | Confidence |
|---|----------|------|-------|---------|------------|
| 1 | CRITICAL | `src/template-host.ts` | 123 → 155 | Unicode-escaped identifiers evade the scan; Babel restores canonical names, making `eval` reachable | 10/10 |
| 2 | CRITICAL | `src/template-host.ts` | 52–76 | No host-element or prop allowlist — `<script>`, `dangerouslySetInnerHTML`, raw `<img>`/`<iframe>` are all renderable | 9/10 |
| 3 | CRITICAL | `server/plugins/request-shape-gate.ts` | 13–23 | Renderer code is same-origin, so it passes the CSRF shape gate; reachable surface includes credential redirection and local command execution | 9/10 |
| 4 | HIGH | `src/template-host.ts` | 119–124 | `stripComments` mangles string literals, deleting real code from the scanned text | 9/10 |
| 5 | HIGH | `src/template-host.ts` | 85–116 | `SHADOW` omits `Image`/`caches`; `ownerDocument` reaches the real `document` | 9/10 |
| 6 | HIGH | `src/template-host.ts` | 14–18, 143–161 | Prescribed containment never implemented, and "validation" itself executes the template | 10/10 |

---

## The structural flaw

The sandbox has two layers:

1. `validateTemplate()` — a regex blocklist (`FORBIDDEN`) over comment-stripped source.
2. `evaluateTemplate()` — `new Function(...names, '"use strict";' + transpiled + ...)`, where
   `names` is a `WHITELIST` of injected Remotion globals plus a `SHADOW` list of dangerous
   global names bound to `undefined` (lexical shadowing).

**Layer 1 scans a different string than the one layer 2 executes.** `validateTemplate()`
inspects the original source; `evaluateTemplate()` runs the Babel *output*. Any construct
where those two differ is a bypass.

Layer 1 is also a denylist of regexes over a language built for dynamic dispatch, and
layer 2 is a denylist of ~40 global *names* in a realm the application does not own — new
globals arrive with every Chromium release. Neither list can be made complete.

---

## Findings not acknowledged by the existing comment

### 1. Unicode-escaped identifiers reach `eval` (CRITICAL)

`src/template-host.ts:123` (scan) → `:155` (transform) → `:146`–`:147` (execute)

JavaScript identifiers may contain `\uXXXX` escapes. The scanner sees the escaped spelling
and matches none of the identifier-anchored regexes; Babel parses it as the real identifier
and prints the **canonical name** into the executed output.

This falsifies the claim at `:83`–`:84` that `eval` and `arguments` "CANNOT be parameter
names — they are blocked by the static check instead." The static check is the *only*
defense for `eval`, and it is bypassable. A direct `eval` inside the `new Function` body
resolves to the real global `eval`, which makes every shadowed name reachable in one step —
no prototype-chain traversal required.

**Fix:** never validate a string other than the one you execute. Walk the Babel AST and
enforce an allowlist of node types and identifier references, or at minimum validate the
transpiled output.

### 2. No element or prop allowlist in the render path (CRITICAL)

`src/template-host.ts:52`–`:70` (`createElementSafe`), `:72`–`:76` (`HostReact`), `:34`–`:42` (`isLoadableSrc`)

`createElementSafe` inspects props only to relocate `mixBlendMode` into `style`, then
forwards `type`, `props` and children verbatim to the real `React.createElement` (`:69`).
The `HostReact` Proxy intercepts only `createElement` and forwards everything else via
`Reflect.get`. There is no tag allowlist and no prop filter.

Consequences, none of which require a blocked token:

- **Same-origin script execution without escaping the JS sandbox** — a host `script`
  element with a remote `src`, or `dangerouslySetInnerHTML` carrying an inline event
  handler. The resulting code runs as ordinary page script against the real global, so
  `SHADOW`, `FORBIDDEN` and strict mode are all irrelevant to it.
- **Zero-JS exfiltration** — raw `img`, `iframe`, `link`, `video`, `source`, SVG
  `image href`, or `style={{ backgroundImage: 'url(…)' }}` all issue outbound requests to
  an arbitrary origin with attacker-chosen data in the URL.

`isLoadableSrc` is not a security control: it is a Remotion `delayRender` availability
guard, it permits `https:` to any host, and it wraps only the whitelisted `Img` component.
A plain JSX `<img>` never reaches it.

**Fix:** enforce an allowlist inside `createElementSafe` — permit only known-safe host
tags; hard-reject `script`/`link`/`iframe`/`object`/`embed`/`base`/`meta`; reject
`dangerouslySetInnerHTML` and any `on*` prop unconditionally; route every URL-bearing prop
(`src`, `href`, `xlinkHref`, `poster`, `srcSet`, and the URL-bearing `style` properties)
through a real origin allowlist.

### 3. Blast radius: same-origin renderer code passes the CSRF gate (CRITICAL)

`server/plugins/request-shape-gate.ts:13`–`:23`

`requestShapeAllowed` admits any state-changing request that is loopback + same-origin.
Code executing in the renderer is same-origin by construction, so the entire local API is
authenticated to it, and nothing in that path distinguishes the app's own UI from code
injected by a template.

Concretely reachable:

- **Provider credential redirection.** `keyStatus()` correctly upholds its invariant —
  secrets surface only as `configured`/`source` booleans
  (`server/keystore.ts:436`–`:451`), so `GET /api/keys` leaks nothing. However
  `POST /api/keys` accepts any whitelisted name (`server/plugins/settings.ts:163`–`:191`),
  including `LLM_BASE_URL`. `llmTarget()`/`llmHeaders()`
  (`server/plugins/llm-proxy.ts:23`–`:39`) then attach the stored `LLM_API_KEY` as an
  `authorization` / `x-api-key` header on requests to that URL. The change persists to
  `.env.local`, so it survives restart.
- **Local command execution.** `PUT /api/skills` writes an attacker-controlled body to
  `~/.openchatcut/skills/<slug>/SKILL.md` (`server/plugins/skill-files.ts:160`–`:174`,
  `server/skills-files.ts:92`–`:98`). `POST /api/skills/<slug>/exec` then runs a
  whitelisted binary in that directory (`server/plugins/skill-exec.ts:105`–`:135`). `bash`
  is whitelisted (`:20`–`:23`), and `interpreterGuardError` (`:41`–`:56`) rejects only
  *inline* `-c` and requires the script to resolve inside the skill directory — which a
  file written by the previous request satisfies.
- **Editor bearer token.** `desktop/preload.ts:202` exposes `getEditorCredentials()`
  returning `{ mcpToken }` — precisely the credential that lets a non-browser client pass
  the shape gate for `/api/external-mcp/mcp` (`request-shape-gate.ts:17`), converting
  in-renderer access into durable off-host editor control.
- **Project and media data.** Full read/modify/delete via `/api/project-store` and the
  `PROJECT_STORE_CHANNEL` IPC, local-path import via `AGENT_PATH_IMPORT_CHANNEL` (bounded
  by `AGENT_IMPORT_ROOTS`), plus `/e2b/run` and the agent turn endpoints.

**Fix:** this is the argument for containment (finding 6) rather than for patching
individual endpoints. Two items stand out regardless: reject interpreter invocations
against files whose contents arrived over an HTTP write (or drop `bash`/`sh` from
`ALLOWED_BINARIES`), and gate `getEditorCredentials()` and provider base-URL changes behind
explicit user confirmation rather than mere same-origin.

### 4. `stripComments` deletes real code from the scan (HIGH)

`src/template-host.ts:119`–`:124`

`stripComments` is two regex replaces with no lexer state, so `//` and `/* */` **inside
string, template and regex literals** are treated as comment delimiters. Because
`//[^\n]*` deletes to end of line, code following a `//` that occurs inside a string on
that line is erased from the scanned text while remaining in what Babel compiles.

A URL literal is among the most likely constants in a real motion-graphic template, so an
AI-generated template can trigger this **accidentally**, not only deliberately.

**Fix:** remove `stripComments` and validate the Babel AST, where comments are already
separated. Never regex-strip comments from code you intend to scan.

### 5. `SHADOW` omits network sinks and reflection primitives (HIGH)

`src/template-host.ts:85`–`:93` (`SHADOW`), `:95`–`:116` (`FORBIDDEN`)

Network-capable and neither shadowed nor matched by any `FORBIDDEN` pattern:

- **`Image`** — `new Image()` is both an outbound GET to an arbitrary origin and a handle
  to a real DOM node. The constructor rule at `:107` covers only
  `XMLHttpRequest|WebSocket|EventSource|Worker`.
- **`caches`** — `CacheStorage.add(url)` performs a genuine network fetch, and `localhost`
  is a secure context.

An element obtained this way exposes **`ownerDocument`**, which `/\bdocument\s*[.[]/`
(`:104`) structurally cannot match — there is no word boundary inside the identifier. From
there `defaultView` yields the real `window`, and every shadowed global becomes reachable
as a property of an object, where identifier-anchored regexes do not apply. This is a plain
static property chain, not the dynamic traversal the header comment describes.

Also unshadowed and useful as escape or obfuscation aids: `Reflect`, `Proxy`, `Object`,
`Symbol`, `Promise`, `WeakRef`, `FinalizationRegistry`, `structuredClone`, `crypto`,
`performance`, `Intl`, `URL`, `Blob`, `FileReader`, `EventTarget`, `AbortController`,
`atob`/`btoa`, `WebAssembly`. `/\.\s*constructor\b/` (`:102`) matches only the literal
dotted spelling. `Promise` also defeats the evident intent of shadowing the timer functions,
by providing asynchronous continuation outside the render call.

Correctly handled, for the record: `queueMicrotask` **is** shadowed (`:90`), and `Audio`
**is** effectively shadowed because `WHITELIST` (`:79`) binds that parameter name to
Remotion's component — though it still accepts an arbitrary `src` per finding 2.

**Fix:** a denylist of global names is structurally unsound in a realm the app does not
own. Invert it — run templates where the global object is one you constructed.

### 6. Containment not implemented, and validation executes the code (HIGH)

`src/template-host.ts:14`–`:18`, `:143`–`:161`

**No containment exists.** A repository-wide search for `sandbox=`, `allow-scripts`,
QuickJS, worker isolation and CSP finds the mitigation only in the comment itself. The only
CSP headers are on unrelated surfaces (`server/mobile-upload-service.ts:328`,
`server/media-dir.ts:292`). `index.html` carries no CSP meta tag; `config/` sets none;
`desktop/main.ts` sets `contextIsolation: true` / `nodeIntegration: false` (`:242`–`:243`,
`:395`–`:396`) but no `onHeadersReceived` CSP and no per-frame isolation. With no CSP,
both `eval` (finding 1) and remote `<script>` (finding 2) are unblocked.

**`prepareTemplate` runs the code it is meant to be vetting.** `evaluateTemplate` invokes
`factory(...values)` immediately (`:147`), so all top-level statements execute at *compile*
time — before any render, before placement on a timeline, before a user sees anything.
Every call site is therefore an execution sink:

- `src/agent/tools/mg-code-tools.ts:31` — `create_motion_graphic_from_code`
- `src/agent/tools/core-tools.ts:127` — `submit_motion_graphic`
- `src/agent/tools/edit-asset-tools.ts:50` — `edit_asset` code update
- `src/plugins/install.ts:63` — installing a **third-party plugin pack** executes every
  `mg-template` it contains as an install probe

Once stored, template code is recompiled on every project load
(`src/editor/TimelineReadinessGate.tsx:18`), so a single successful write is persistent.

**Fix:** implement the header's own prescription — execute templates in a cross-origin
`<iframe sandbox="allow-scripts">` (opaque origin, no `allow-same-origin`) under a strict
CSP, or in a QuickJS WASM realm, marshalling only serialized props and frame numbers across
the boundary. Until then, treat `prepareTemplate` as "run untrusted code," not "validate
untrusted code."

---

## Already acknowledged by the existing comment

`src/template-host.ts:14`–`:18` correctly states that this is hardening rather than a VM
boundary, that a dynamically-computed prototype-chain `constructor` traversal can reach the
real global, and that an iframe or QuickJS realm is required for production. Findings 1–5
are additional and, in several cases, more direct than the acknowledged risk.

---

## Regression fixtures

The following inputs are useful as tests for any fix. They are benign probes of the
*static* layer only — each is inert, and none is a working escape. A hardened
`validateTemplate` should reject all of them; the two controls must keep being rejected.

| Input shape | Current layer-1 result | Finding |
|---|---|---|
| String literal containing `https://…` followed by further code on the same line | PASS | 4 |
| Identifier written with a `\uXXXX` escape | PASS | 1 |
| `React.createElement("script", { src })` | PASS | 2 |
| `React.createElement("img", { src })` | PASS | 2 |
| `dangerouslySetInnerHTML` prop | PASS | 2 |
| `new Image()` | PASS | 5 |
| `.ownerDocument` property access | PASS | 5 |
| `Reflect.get(obj, "constr" + "uctor")` | PASS | 5 |
| *control:* `fetch("/x")` | REJECT | — |
| *control:* `window.location = 1` | REJECT | — |

---

## Recommended order of work

1. **Containment first** (finding 6) — an opaque-origin iframe or QuickJS realm makes
   findings 1, 3, 4 and 5 non-exploitable rather than merely harder.
2. **Element and prop allowlist** (finding 2) — cheap, and it is the only finding that
   containment alone does not fully address, since a sandboxed frame can still beacon
   outward unless CSP `connect-src`/`img-src` are constrained too.
3. **Validate the Babel AST instead of the source string** (findings 1 and 4) — removes an
   entire bypass class and the accidental-trigger bug.
4. **Endpoint hardening** (finding 3) — interpreter/skill-exec restrictions and explicit
   confirmation for provider base-URL changes and `getEditorCredentials()`.
