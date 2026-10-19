# Lumières

A graph-structured thinking workspace. Start with one window on an infinite
canvas, select a phrase, and branch it into a connected child window. Repeat
from any window to grow a tree of connected thinking.

Every window can switch between a **note** and an **AI conversation** backed by
the user's own OpenAI-compatible API key. Conversations, notes, window sizes and
the graph itself are stored locally and restored on refresh.

Built to the specification in [`agents.md`](./agents.md).

```bash
npm install
npm run dev        # http://localhost:5173
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Typecheck, then production build into `dist/` |
| `npm run preview` | Serve the production build |
| `npm run typecheck` | `tsc --noEmit`, strict, no `any` |
| `npm test` | Vitest (275 tests) |

Requires Node 20+. The app is fully client-side; there is no backend to run.

### AI setup

Open the gear icon in the toolbar (or Settings from an empty chat window), paste
an API key, and set the provider's OpenAI-compatible base URL (the default is
`https://api.openai.com/v1`). Press **Load models** to read the provider's
`GET /models` response into the model picker; when that response (or a known
model family) advertises reasoning-effort support, choose a level for the
selected model. Save to apply.

The key is stored only in this browser's `localStorage`; it is never written
into the canvas document, exported, or logged. Requests go directly from the
browser to the provider whose base URL you configure. Use a key you are
comfortable holding on this device.

---

## What it does

- **Infinite canvas** — pan, zoom around the cursor, fit-to-view, fit-selection,
  marquee select, multi-select drag, and a minimap. World coordinates only:
  the camera never touches the document.
- **Two window modes** — every window is a note or an AI conversation, switched
  from its header. The note body is preserved as chat context; the conversation
  is preserved if you switch back. Mode changes are undoable.
- **Resizable windows** — drag the bottom-right corner. A selected painted
  window shows the corner handle on the canvas; the open editor has its own
  handle, and arrow keys resize it when focused. Sizes live in world coordinates
  and survive zoom, pan, refresh, export and import. The document is written once
  on release, so a drag is one undo step and no React render happens per pointer
  move.
- **Note windows** — title, body, collapse/expand, focus, delete, character
  budget, branch budget, and a visible link back to the parent.
- **Branch from a selection** — highlight text, choose *Create branch* (or
  ⌘/Ctrl + ↵). Works in note bodies and AI replies; a chat selection records the
  message id so staleness can be checked later. The child opens ready to type.
- **AI chat** — streaming replies, a composer with Enter-to-send, Stop for one
  window only, per-window retries, independent conversations, an explicit
  no-key state, and specific error messages for auth, rate limits, refusals and
  network failures. Request tokens never touch the document or autosave.
- **Limits, enforced in the domain** — 50 direct children per window and 20,000
  characters per note *and per chat message*, all validated in `graphOperations`
  rather than only in the UI.
- **Undo/redo** across creation, deletion, text, movement, mode switches and
  resizes, with typing bursts coalesced into one step. Chat turns are conversation
  history rather than text edits and deliberately stay outside the undo stack.
- **Local persistence** — debounced autosave to IndexedDB, restored on refresh,
  plus JSON import/export including modes, sizes and conversations.

### Keyboard

| | |
| --- | --- |
| Wheel / trackpad | Pan · **⌘ + wheel** zooms around the pointer |
| Space + drag, middle-drag | Pan |
| Drag empty space | Marquee select · **Shift + click** adds |
| Double-click, Enter, F2 | Edit the selected window |
| Select text, then **⌘↵** / **⌘B** | Create a branch from that text |
| Enter / Shift + Enter | Send an AI message / add a newline |
| Drag the corner handle | Resize · arrow keys resize when focused |
| Escape | Dismiss the floating action → leave the editor → clear selection |
| ⌘Z / ⇧⌘Z | Undo / redo (document-wide; works inside the note editor) |
| Delete | Delete selection, with a preview when it removes a subtree |
| Arrow keys | Move to parent, child, or sibling window |
| ⌘1 / ⌘2 / ⌘0 | Fit graph / fit selection / reset zoom |
| ⌘S · ⌘E · ⌘O · ? | Save now · export · import · help |

---

## Architecture

```
src/
  graph/       document model, pure operations, validation, layout, history, store, metrics
  canvas/      engine, camera, renderer, spatial index, hit testing, interactions
  editor/      character-limit rules, textarea selection geometry, chat DOM selection
  persistence/ repository, IndexedDB, migrations, autosave, import/export
  ai/          settings, model discovery, provider transport, request runtime, context
  components/  React: canvas host, window frame, note editor, AI chat, panels
  app/         shell, boot sequence, engine context, UI commands
```

The dependency direction is deliberate: `components` → `canvas`/`graph` →
`persistence`; `ai` provides services to components and imports graph types, but
the graph and canvas layers never import the provider transport. Graph logic
imports nothing from React, and the renderer imports nothing from the DOM beyond
a 2D context.

### One canvas, not five thousand React nodes

The canvas is a **single Canvas 2D surface**. Grid, edges, window chrome and
preview text are all painted there; the only DOM is the one open editor and a
handful of floating controls. Node count therefore does not affect the React
tree: the component tree stays the same size whether the graph has 1 note or
5,000.

### State is split by update rate

| State | Lives in | Changes at |
| --- | --- | --- |
| Document (nodes, edges, text, chat, sizes, modes) | `graphStore` (Zustand) | user actions |
| History (undo/redo patches) | `graphStore` | user actions |
| Camera, hover, drag/resize offsets, marquee | `CanvasEngine` (mutable) | pointer speed |
| Selection, editing target, floating actions | `CanvasEngine` snapshot | discrete events |
| AI streaming text and request status | `AISessionStore`, keyed by node | token cadence |
| API key, base URL, model and effort | `ai/settings` (localStorage) | settings changes |
| Persistence status | `graphStore` | debounce boundaries |

React subscribes to the engine through `useSyncExternalStore` on a small,
immutable snapshot that only changes on discrete events. Panning, zooming and
dragging write to engine fields and to `canvas.style.transform` — **no React
render happens per frame**. During a drag, node positions live in
`engine.draftPositions`; exactly one document update is committed on release.
Resizing uses the same pattern with `engine.draftSizes`: the frame and edges are
redrawn at the provisional size, and one `resizeNode` operation is committed on
pointer-up.

### Rendering

- **Culling** — a uniform-grid spatial index (`SpatialGrid`, 480-unit cells)
  answers "what is on screen" and "what is under this point".
- **Per-window geometry** — node rects come from each window's stored world size
  (or its in-flight resize draft), so culling, edges, hit testing, minimap,
  fit-to-view and placement all follow a resized frame without a global layout
  pass.
- **Level of detail** — full text above 0.42 zoom, placeholder blocks below it,
  topology-only outlines below 0.14. Text is never drawn at a size where it would
  be an unreadable smudge. AI windows preview their conversation tail instead of
  the note body, with long turns truncated before layout.
- **Cached text layout** — wrapping is measured once per note and invalidated by
  content, width or font. Panning and zooming never measure text.
- **Dirty-flag rendering** — `requestAnimationFrame` runs only while something is
  dirty or a gesture/pulse animation is active; an idle canvas costs nothing.
- **Device-pixel-ratio aware** — the backing store is sized to `devicePixelRatio`
  so the canvas stays sharp on high-DPI displays.

### The editor is a real `<textarea>`

Not contenteditable and not a custom editor. Native caret behaviour, IME
composition, spell check, paste, screen-reader support and text selection come
for free. It is positioned by the engine inside a camera-transformed layer, so
its geometry and typography are specified in **world units** from the same
metrics module the renderer uses — the editor lands exactly on the window it
replaces. Selection *pixels* are recovered by mirroring the textarea's content
into a hidden, identically-styled div and measuring marker spans there (the
standard technique); the textarea's own offsets are the source of truth for the
stored reference.

Text selection beats canvas dragging by construction: pointer events originating
inside `[data-overlay="true"]` never start a canvas gesture.

Two invariants keep that native behaviour intact, because both were easy to break:

- **The field owns the caret.** An accepted edit is committed exactly as the
  browser produced it, caret included, so typing or deleting mid-note leaves the
  caret where the user put it. The document layer only repositions the caret when
  it rewrites the value itself — a paste trimmed to the remaining character
  budget, or an insertion refused at the ceiling — where it restores the offset
  the edit would have left behind. `applyTextEdit` reports that offset and
  nothing else moves the selection.
- **The branch action hangs off the window, not the selected line.** Its world
  anchor is the window's top edge at the selection's end column, and the engine
  adds its gap in *screen* pixels — so the control sits one fixed distance above
  the note at every zoom, rather than drifting down with the selection and
  ending up over the note's own header or out past its bottom frame. It is
  clamped over the window horizontally (falling back to the window's centre when
  a zoomed-out window is narrower than the control) and into the viewport
  vertically, so it stays reachable while the window's header is scrolled away.
  The control reports its measured size to the engine after each commit, which
  keeps the layout read out of the frame loop.
- **The branch action acts on the live selection.** The floating action is
  derived state (it exists to show the button); when it is clicked, the engine
  re-reads the selection from the open editor and branches from that. A cached
  copy can be dropped by a caret the browser placed on its own — a delayed focus
  frame, a value the editor rewrote — which used to make "Create branch" look
  inert on a perfectly good selection.

### AI windows: document for history, runtime for tokens

Chat is deliberately split across two stores:

- **Persisted turn history lives in `NoteNode.chat`.** It travels with the
  document through autosave, reload, export, import and undo of deletion, and it
  is deleted with its window.
- **In-flight state lives in `AISessionStore`.** Streaming text, status and the
  active request id are keyed by node id. Deltas are batched at a 50 ms cadence
  and never touch the document, so typing-speed work does not reach autosave or
  the canvas renderer.
- **One write per completed response.** The finished assistant turn is appended
  in a single operation. A stopped response keeps the partial text and is marked
  interrupted. Chat turns are not pushed onto the undo stack.
- **One request lifecycle per window.** `chatRuntime` creates a request id and
  an `AbortController` per send. Late events from a superseded request are
  dropped, cancelling one window leaves the others running, and a configurable
  cap (4) bounds total concurrency with an explicit error rather than a queue.
- **Context is budgeted.** `buildNodeContext` clips the note body and nearest
  ancestors; `selectConversationHistory` keeps the newest turns under a separate
  character budget. Other windows' chats are never sent.
- **Transport is behind a seam.** `chatService` is the only provider-aware
  module and loads the OpenAI SDK lazily on first send. `ai/models.ts` reads the
  configured provider's `/models` endpoint for the picker and its advertised
  reasoning-effort levels. The API key lives in `ai/settings` (localStorage) and
  never appears in the document or an export.

Selecting text in an AI reply uses DOM range offsets measured against that
message's content. The resulting `SourceReference` carries the message id, so
the source chip's staleness check reads the same text it was created from. A
selection spanning two messages is rejected rather than recorded ambiguously.

### Undo/redo as inverse patches

History stores patches, not document snapshots: creating a branch records one
node and one edge, deleting a subtree records that subtree, typing records the
two ends of the edit. Consecutive text edits on the same node within 700 ms
coalesce into one step, so ⌘Z reverses a typing burst rather than a keystroke.
History is capped at 200 entries. Undo/redo is intercepted inside the editor too
— the *document* owns history — with the open draft flushed first so the edit
being undone is always the most recent document state.

### Persistence

`DocumentRepository` is an interface with three implementations — IndexedDB
(primary), `localStorage` (fallback when IndexedDB is unavailable), and
in-memory (last resort so a locked-down browser still gets a working canvas).
Nothing in the UI touches storage directly.

Autosave is debounced (650 ms), serialised so writes cannot interleave, and
flushed on `visibilitychange: hidden` and `pagehide` — the only unload-adjacent
events where async work reliably completes. Every save also writes a small
emergency mirror to `localStorage`, which is what rescues work if the browser
drops an IndexedDB write during an unload race. Save status is visible in the
toolbar; a failed write shows as an error rather than silently pretending to
save.

The document is versioned (`schemaVersion`, currently 2) with an ordered migration
chain: schema 1 documents gain default note mode, the default note size and an
empty chat. Loading is defensive: unknown fields are dropped, missing fields
default, edges are rebuilt from `parentId`, unreachable nodes are re-parented to
the root, and invalid window sizes are clamped. **Over-limit notes are never
truncated** — they keep every character, are reported in a banner, and simply
cannot grow until trimmed. Chat turns are sanitised individually; malformed
entries are dropped without losing the rest of the conversation.

The API key is stored separately under `lumieres:ai-settings`. It is excluded
from document serialisation by construction — the document schema has no field
for it.

---

## Design decisions and trade-offs

**Custom Canvas 2D renderer instead of React Flow.** React Flow renders a DOM
node per window, which is the wrong shape for a workspace that must stay fluid
at thousands of nodes, and its own viewport handling would have to be bypassed
for the world-coordinate and drag-preview behaviour required here. The cost is
that hit-testing, culling and text layout are ours to write — bounded work, all
of it in `canvas/`.

**Edges are derived from `parentId`.** `parentId` is canonical; `edges` mirrors
it with a deterministic id (`e:source->target`) and is regenerated by every
operation that can change structure. Imports rebuild edges wholesale, so the two
cannot drift. The redundancy is kept because edge lookup during rendering should
not scan the node map.

**Text is counted in UTF-16 code units** (`String.prototype.length`), the same
convention as textarea offsets and the stored source references, so a limit, a
selection and a snapshot can never disagree. An emoji therefore counts as two.

**Branches keep snapshots, not references.** A source reference is never
re-synchronised. If the source text changes underneath, the branch keeps its
snapshot and is flagged *source changed*; nothing is silently rewritten.

**Deletion is subtree-shaped and previewed.** Deleting a window removes its
descendants after a dialog stating how many notes and how many characters will
go. Small, low-cost deletions skip the dialog. The root cannot be deleted —
resetting the canvas is a separate, equally-previewed action, and one undo
restores everything.

**Multi-node moves are one patch** (`updateMany`) so a drag of ten windows is a
single undo step and a single document update.

**Resizing is world-space and flex-based.** A window stores `{ width, height }`
in world units. The frame is a flex column (header, body, footer) and the note
editor / chat fill the middle region, so a resize reflows content without
recomputing layout in React. During a drag the engine keeps a provisional size
and writes the element's width/height directly; the document changes once on
pointer-up. Edges, culling, hit testing and the spatial index use the draft size
while the gesture is live. This is also why collapsing never overwrites the
stored height.

**One node, two modes.** Note and AI views share a node's id, position, size,
parent and source reference. Toggling stores only `kind` (plus a one-time size
bump when a default-sized note becomes a chat); the note body and chat are both
retained. That keeps branching, deletion and persistence mode-agnostic.

**Chat history and request state are separate.** The document owns durable
turns; the session store owns tokens in flight. Writing each delta into the
document would schedule autosave and canvas work at token rate and make undo
semantics strange. The trade-off is that a hard refresh mid-response loses the
partial text; the user's message is already saved, and a stopped response is
kept and marked interrupted.

**The API key is browser-local user configuration, not canvas data.** It is
stored under a separate localStorage key, never serialised into the document,
and sent only to the provider from the browser. This is the honest trade-off for
a backend-free app: the key is readable by anyone with access to the browser
profile, which the settings dialog states. Requests use the provider's
browser-access header; the SDK is loaded lazily on first send so the initial
canvas bundle stays lean.

**Provider transport is isolated.** `ai/chatService.ts` is the only module that
imports the OpenAI SDK. Any OpenAI-compatible base URL works; a provider with a
different protocol or the planned autocomplete/Q&A surfaces can be added behind
the same boundary without touching graph, canvas or editor code. Refusals, auth
failures, rate limits and connection errors are mapped to specific user-facing
messages.

**The document is an immutable `Record<NodeId, NoteNode>`.** Every operation
copies the node map. That is O(n) per edit — measured at ~0.7 ms with 5,000
nodes, comfortably inside a keystroke budget — and it buys trivial structural
sharing, patch-based history and simple reasoning. Where it *would* hurt
(building 5,000 nodes in a row, as an importer or the stress generator does),
documents are constructed in bulk instead. This is the main scaling limit of the
current model; a persistent map would remove it if it ever matters.

---

## Testing and measured performance

275 tests across domain, canvas, editor, persistence, AI, settings and
integration layers:

```
graphOperations   root creation, branching at any depth, 50-child limit (per node),
                  character limit, deletion semantics, source-reference staleness,
                  integrity after hundreds of branches
window modes      note ⇄ AI preservation, default-size bump, resize clamping,
                  chat append/limit rules, message-scoped source references
history           patch inversion, typing coalescing, redo invalidation, subtree restore
layout            deterministic placement, no sibling overlap across 50 children,
                  placement past resized parents
graphValidation   plan/stats, malformed documents, repair rules, size and chat repair
camera            world↔screen round trips, zoom-around-cursor anchoring, clamping,
                  fit, ensure-visible
spatialIndex      insert/update/remove/query, multi-cell spans, 5,000-node timing
renderer          every LOD tier and node state (via a recording 2D context),
                  AI previews, culling, edge geometry, layout cache
engine            gestures, drag commit-once, marquee, wheel zoom anchoring,
                  camera/overlay sync, floating-action placement and clamping,
                  draft flush
note editor       limit trimming (typing, paste, over-limit), selection geometry,
                  HTML-escaping in the measurement mirror
chat selection    UTF-16 offsets within a reply, cross-message rejection
persistence       IndexedDB round trips, emergency mirror recovery, migrations,
                  debounced autosave, status transitions, write serialisation,
                  failure surfacing, restoration, AI mode/size/chat round trip
ai settings       local persistence, key clearing, malformed storage, legacy migration,
                  full model list in the select, effort levels for reasoning models
ai models         /models parsing, effort metadata, family inference, deduplication
ai transport      provider error-to-message mapping
ai runtime        per-node isolation, concurrent streaming, superseded-response
                  rejection, scoped cancel, partial-response retention, retry,
                  concurrency cap, no-key and note-mode guards
ai context        history budgeting, ancestor clipping, other-window exclusion
integration       the full note workflow (type → highlight → branch → edit →
                  grandchild → move → reload → verify), plus AI branching and
                  reload of mode/size/conversation; UI mode toggle, corner resize
                  and settings persistence
```

Measured on this machine (Node 25, Vitest, 5,000-node synthetic graph). These
bound *work per frame*, not frame rate — jsdom has no rasteriser, so the numbers
below are the per-frame costs the renderer pays, printed by
`src/graph/performance.test.ts`:

| Measurement | Result |
| --- | --- |
| Culling query (per frame) | **0.2 ms** |
| Hit test (per probe) | **< 0.1 ms** |
| Marquee query | **0.1 ms** |
| Cached text-layout lookup, 400 notes | **< 0.1 ms** |
| Single-node content update at 5,000 nodes | **0.7 ms** |
| Build a 5,000-node graph (bulk path) | 0.3–0.7 s |
| Validate a 5,000-node graph | 77 ms |

Culling at 0.2 ms leaves the whole 16.7 ms frame budget for painting, and the
React tree does not grow with the graph, so the rendering architecture has ample
headroom at 5,000 nodes.

**What has not been verified:** frame rate, paint cost and memory in a real
browser. There is no browser automation in this environment, so smoothness of
pan/zoom/drag at scale was reasoned about from the per-frame work above rather
than measured on a device. To check it by hand:

```bash
npm run dev
# in the browser console (dev builds only):
__lumieresStress(5000)
```

---

## AI implementation and future seam

AI chat is implemented. What is deliberately still future-facing:

- **Provider** — the implemented transport speaks OpenAI's Chat Completions
  protocol, so any OpenAI-compatible service works through the base-URL setting.
  A provider that requires a different request shape would be added behind
  `ai/chatService.ts`; graph, canvas, editor and persistence stay
  provider-agnostic.
- **Autocomplete and non-chat Q&A** — not implemented and not faked.
  `ai/serviceInterface.ts` keeps the documented `AIService` boundary for them,
  and `ai/context.ts` keeps the selective, budgeted context assembly they need.
- **Per-window isolation** — `ai/chatRuntime.ts` and `ai/sessionStore.ts` already
  implement independent request lifecycles, scoped cancellation, late-response
  rejection and a bounded concurrency cap. The UI never sees a global chat state.
- **Context lineage** — each request gets this window's note body, source
  snapshot (with staleness), clipped nearest ancestors and its own recent turns.
  No other window's conversation is ever included.

`dangerouslyAllowBrowser` is required for a backend-free app; direct browser
requests also depend on the provider allowing CORS. The key is treated accordingly: browser-local,
user-managed and explicitly warned about. If the app later gains a backend, the
same `chatService` boundary can move the request server-side without changing
the document, UI or runtime.

---

## Limitations

- **Single document per browser.** The repository lists documents and remembers
  the last opened one, but there is no document picker UI yet.
- **The tree only grows.** `reparentNode` exists and is validated (cycle-safe,
  limit-aware), but no drag-to-reparent interaction is wired up. No cross-links
  or cycles by design.
- **Pixel-level editor alignment** (the textarea landing exactly on the painted
  window) is reasoned from shared metrics constants and covered by unit tests,
  but was not verified against a real rasteriser here. The floating action's
  placement has been checked in a real browser (both ends of a long note, a
  child window, 60% zoom, and a window scrolled past the top of the viewport);
  when a window's header is scrolled out of view the action is pinned to the
  viewport's top edge, where it does overlap the first visible lines.
- **Rich text is not supported.** Notes and chat replies are plain text by
  design; the character limit and selection offsets are exact because of it.
  Markdown in model output is therefore shown literally, and the system prompt
  asks for plain text.
- **Chat turns are not undoable.** Notes, branches, moves, mode switches and
  resizes are. A conversation is history rather than an edit; deleting it means
  deleting the window. There is no separate "clear conversation" action yet.
- **Conversations grow without a turn cap.** Requests send only the recent turns
  under a character budget, but the full history stays in the document (and in
  exports) until the window is deleted.
- **Live provider calls are not exercised by the test suite.** Runtime isolation,
  streaming plumbing, cancellation, context assembly and settings are unit
  tested with injected transports; a real request requires the user's key and a
  network. Error mapping and `/models` parsing are explicit, but the live
  browser→provider round trip was not run in this environment.
- **A refresh during a stream loses the partial reply.** The user's turn is
  already persisted; a stopped reply (Stop button) is kept and marked
  interrupted.
- **Very large documents skip the localStorage emergency mirror** (it is capped
  at 900 KB). IndexedDB remains the primary store; the mirror only exists to
  rescue an unload race when the payload fits.
- **No collaboration, sync, auth or backend**, per the brief.
- **The 5,000-node figures are per-operation costs, not frame rates** — see the
  note under the performance table. AI windows add a small preview cost
  (conversation tail truncated before text layout) but do not add React nodes
  until one is opened.
