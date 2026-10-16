# Lumières

A graph-structured note-taking canvas. Start with one note window on an infinite
workspace, select a phrase, and branch it into a connected child window. Repeat
from any window to grow a tree of connected thinking.

Built to the specification in [`agents.md`](./agents.md). AI features are
**not implemented** — no API keys, no LLM calls, no fake responses — but the
architecture has explicit seams for them (see [AI readiness](#ai-readiness)).

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
| `npm test` | Vitest (187 tests) |

Requires Node 20+. The app is fully client-side; there is no backend to run.

---

## What it does

- **Infinite canvas** — pan, zoom around the cursor, fit-to-view, fit-selection,
  marquee select, multi-select drag, and a minimap. World coordinates only:
  the camera never touches the document.
- **Note windows** — title, body, collapse/expand, focus, delete, character
  budget, branch budget, and a visible link back to the parent.
- **Branch from a selection** — highlight text, choose *Create branch* (or
  ⌘/Ctrl + ↵). The child window records the source node, the selected text, the
  UTF-16 offsets, and a snapshot, then opens ready to type.
- **Limits, enforced in the domain** — 50 direct children per note and 20,000
  characters per note, both validated in `graphOperations`, not just in the UI.
- **Undo/redo** across creation, deletion, text and movement, with typing bursts
  coalesced into one step.
- **Local persistence** — debounced autosave to IndexedDB, restored on refresh,
  plus JSON import/export.

### Keyboard

| | |
| --- | --- |
| Wheel / trackpad | Pan · **⌘ + wheel** zooms around the pointer |
| Space + drag, middle-drag | Pan |
| Drag empty space | Marquee select · **Shift + click** adds |
| Double-click, Enter, F2 | Edit the selected note |
| Select text, then **⌘↵** / **⌘B** | Create a branch from that text |
| Escape | Dismiss the floating action → leave the editor → clear selection |
| ⌘Z / ⇧⌘Z | Undo / redo (document-wide, works inside the editor) |
| Delete | Delete selection, with a preview when it removes a subtree |
| Arrow keys | Move to parent, child, or sibling window |
| ⌘1 / ⌘2 / ⌘0 | Fit graph / fit selection / reset zoom |
| ⌘S · ⌘E · ⌘O · ? | Save now · export · import · help |

---

## Architecture

```
src/
  graph/       document model, pure operations, validation, layout, history, store
  canvas/      engine, camera, renderer, spatial index, hit testing, interactions
  editor/      character-limit rules, textarea selection geometry
  persistence/ repository, IndexedDB, migrations, autosave, import/export
  ai/          session types, isolation state, context assembly, service boundary
  components/  React: canvas host, note editor, floating controls, panels
  app/         shell, boot sequence, engine context
```

The dependency rule is one-directional: `components` → `canvas`/`graph` →
`persistence`. Graph logic imports nothing from React, and the renderer imports
nothing from the DOM beyond a 2D context.

### One canvas, not five thousand React nodes

The canvas is a **single Canvas 2D surface**. Grid, edges, window chrome and
preview text are all painted there; the only DOM is the one open editor and a
handful of floating controls. Node count therefore does not affect the React
tree: the component tree stays the same size whether the graph has 1 note or
5,000.

### State is split by update rate

| State | Lives in | Changes at |
| --- | --- | --- |
| Document (nodes, edges, text) | `graphStore` (Zustand) | user actions |
| History (undo/redo patches) | `graphStore` | user actions |
| Camera, hover, drag offsets, marquee | `CanvasEngine` (mutable) | pointer speed |
| Selection, editing target, floating actions | `CanvasEngine` snapshot | discrete events |
| Persistence status | `graphStore` | debounce boundaries |

React subscribes to the engine through `useSyncExternalStore` on a small,
immutable snapshot that only changes on discrete events. Panning, zooming and
dragging write to engine fields and to `canvas.style.transform` — **no React
render happens per frame**. During a drag, node positions live in
`engine.draftPositions`; exactly one document update is committed on release.

### Rendering

- **Culling** — a uniform-grid spatial index (`SpatialGrid`, 480-unit cells)
  answers "what is on screen" and "what is under this point".
- **Level of detail** — full text above 0.42 zoom, placeholder blocks below it,
  topology-only outlines below 0.14. Text is never drawn at a size where it would
  be an unreadable smudge.
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

The document is versioned (`schemaVersion`) with an ordered migration chain, and
loading is defensive: unknown fields are dropped, missing fields default, edges
are rebuilt from `parentId`, and unreachable nodes are re-parented to the root.
**Over-limit notes are never truncated** — they keep every character, are
reported in a banner, and simply cannot grow until trimmed.

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

**The document is an immutable `Record<NodeId, NoteNode>`.** Every operation
copies the node map. That is O(n) per edit — measured at ~0.7 ms with 5,000
nodes, comfortably inside a keystroke budget — and it buys trivial structural
sharing, patch-based history and simple reasoning. Where it *would* hurt
(building 5,000 nodes in a row, as an importer or the stress generator does),
documents are constructed in bulk instead. This is the main scaling limit of the
current model; a persistent map would remove it if it ever matters.

---

## Testing and measured performance

187 tests across domain, canvas, editor, persistence, AI state and integration
layers:

```
graphOperations   root creation, branching at any depth, 50-child limit (per node),
                  character limit, deletion semantics, source-reference staleness,
                  integrity after hundreds of branches
history           patch inversion, typing coalescing, redo invalidation, subtree restore
layout            deterministic placement, no sibling overlap across 50 children
graphValidation   plan/stats, malformed documents, repair rules
camera            world↔screen round trips, zoom-around-cursor anchoring, clamping,
                  fit, ensure-visible
spatialIndex      insert/update/remove/query, multi-cell spans, 5,000-node timing
renderer          every LOD tier and node state (via a recording 2D context),
                  culling, edge geometry, layout cache
engine            gestures, drag commit-once, marquee, wheel zoom anchoring,
                  camera/overlay sync, floating-action placement and clamping,
                  draft flush
editor            limit trimming (typing, paste, over-limit), selection geometry,
                  HTML-escaping in the measurement mirror
persistence       IndexedDB round trips, emergency mirror recovery, migrations,
                  debounced autosave, status transitions, write serialisation,
                  failure surfacing, restoration
ai                per-node session isolation, late-response rejection, scoped cancel,
                  context budgeting
integration       the full workflow: type → highlight → branch → edit → grandchild
                  → move → reload → verify, plus limits, deletion preview and undo
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
| Build a 5,000-node graph (bulk path) | 0.3–0.6 s |
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

## AI readiness

No AI is implemented. What exists is the shape it will need, so nothing has to
be rewritten:

- `ai/types.ts` — `NodeAISession` keyed by node id, `AIMessage`, request ids,
  context budgets. Sessions are per node by construction; there is no global
  conversation object anywhere.
- `ai/sessionStore.ts` — a working, tested state container: concurrent requests
  on different nodes, per-node cancellation, and rejection of a late response
  whose request id has been superseded. No transport, no network.
- `ai/context.ts` — selective context assembly: nearest ancestors first, under a
  character budget, with a floor that stops it padding a request with slivers
  from a dozen ancestors. Ancestors are excerpts, never concatenated in full.
- `ai/serviceInterface.ts` — the `AIService` boundary
  (`autocomplete` / `ask` / `cancel`) plus a registry that returns `null` today.
  Because it is null, every AI affordance is absent rather than faked.

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
- **Rich text is not supported.** Notes are plain text by design; the character
  limit and selection offsets are exact because of it.
- **No collaboration, sync, auth or backend**, per the brief.
- **The 5,000-node figures are per-operation costs, not frame rates** — see the
  note under the performance table.
