# Build a Graph-Structured Note & AI-Chat Web App

## 1. Objective

Build a polished, performant, graph-structured thinking workspace where users can start with a single window on an infinite canvas and progressively branch their thinking into connected windows.

Each window can be used in one of two modes:

1. **Note** — a plain-text note with a title and body.
2. **AI conversation** — a ChatGPT/Claude-style chat with an LLM, using an API key the user supplies and updates in the app's settings.

The signature interaction works in both modes:

1. A user opens a canvas containing one initial note window.
2. They write or paste content into the window, or switch it to AI mode and hold a conversation.
3. They highlight a portion of the text (note body or an AI reply).
4. A contextual action allows them to create a branch from the selected text.
5. A new window appears on the canvas, connected to the originating window by an edge.
6. The selected text becomes the context or source reference for the new branch.
7. The new window is independently editable or chattable, and the user can repeat the process from any window.

The result should feel like an infinite visual workspace for thinking, research, studying, brainstorming, and exploring ideas. It should combine the familiarity of a text editor and a chat interface with the flexibility of a node-based canvas.

**Scope:** implement the complete working application, including real AI chat requests, user-managed API keys, note/AI mode switching and resizable windows. AI *autocomplete* and automatic context stuffing remain future work; the architecture must leave clean seams for them without rewriting the graph, editor, canvas or state systems.

Before changing code, inspect the existing repository, identify its framework, conventions, dependencies, and current functionality. Preserve working features and follow the existing architecture where appropriate.

The current implementation is documented in [`README.md`](./README.md).

## 2. Core Product Requirements

### A. Canvas and graph structure

- Each canvas starts with exactly one root note window.
- Users can create branches from any existing note window.
- Each branch creates a new note window and a directed relationship from the source window to the new window.
- Every window can create additional branches, without a fixed depth limit.
- A canvas may contain a maximum of 50 outgoing branches from any single window. The limit applies independently to every window, not to the total number of windows on the canvas.
- Enforce the 50-child limit in the domain/business logic, not only by disabling a UI button.
- Clearly communicate when the branch limit is reached.
- The initial scope should be a directed tree: each note has at most one parent, except the root. Do not introduce arbitrary cross-links or cycles unless explicitly required later.
- Every window must have a stable unique ID, and every edge must reference valid source and target IDs.
- Deleting a node must have explicit, predictable semantics. Prefer confirming deletion of a node and its entire descendant subtree, with a clear preview of what will be removed.
- Support undo and redo for important editing operations where practical, including node creation, deletion, text changes, and movement.

### B. Infinite canvas and viewport

Implement a genuinely pannable and zoomable canvas, rather than a large fixed-size page.

Users should be able to:

- Pan across the workspace using a suitable mouse/trackpad interaction.
- Zoom in and out around the cursor position.
- Fit the entire graph or selected branch into the viewport.
- Center the viewport on a selected node.
- Move note windows freely without changing their graph relationships.
- Navigate large graphs without noticeable input lag.
- See graph edges update as nodes move.
- Create new nodes near their parent without overlapping existing nodes unnecessarily.
- Use a minimap or another navigation aid if it materially improves usability.

Use a consistent world-coordinate system. Node positions must be stored in world coordinates, independent of screen size, pan offset, and zoom.

Do not reposition every node whenever the camera pans or zooms.

### C. Note windows and text editing

Each note window should have:

- A title or editable heading.
- An editable text body.
- A clear visual distinction between the title, body, and window controls.
- A visible relationship to its parent, where applicable.
- A way to collapse, expand, focus, or delete the window.
- A word or character count and a clear character-limit indicator.

**Hard limit: 20,000 characters per note window.**

- Count characters consistently, using JavaScript string length (UTF-16 code units) as the initial implementation's documented counting convention.
- Enforce the limit while typing, pasting, and inserting text through any other editing operation.
- Do not silently truncate existing content when editing or loading data.
- Show a useful validation message if imported or previously stored content exceeds the limit.
- Do not impose a 20,000-character limit on the entire canvas; each node has its own independent limit.

Use a real, accessible text-editing approach rather than implementing a custom text editor from scratch. Choose an appropriate editor library based on the repository and product requirements. A lightweight textarea is acceptable for the initial version if rich-text formatting is not essential. If using a rich-text editor, ensure that text selection, paste handling, selection offsets, and character counting work reliably.

### D. Highlight text to create a branch

This is the signature interaction and must work reliably.

Expected behavior:

1. The user selects a range of text inside a note body.
2. A small contextual action appears near the selection, offering "Create branch".
3. Clicking the action creates a child note window and an edge connecting it to the source.
4. The new note records the selected text as its source context.
5. The new note is focused and ready for editing.
6. The original note remains unchanged unless the user explicitly edits it.
7. The user can repeat this interaction from any child note.

Store the source reference structurally, not just as a copied string.

A branch should include:
- Source node ID.
- The source message ID when the selection was made in an AI reply.
- Selected text.
- Selection start and end offsets in the source text (the note body or that message).
- A snapshot of the selected text at the time of branching.
- A way to determine whether the original selection has changed since the branch was created.

Treat the original text range as a reference, not as an automatically synchronized copy. If the source note or AI message changes, do not silently rewrite the branch's context. Instead, preserve the snapshot and mark the source reference as potentially outdated when appropriate.

Selection handling must work both in the textarea note editor and in AI reply text rendered as DOM. In the chat case, reject a selection that spans more than one message rather than recording offsets that would refer to the wrong text. If the user clicks elsewhere or the selection becomes invalid, dismiss the contextual action appropriately.

The branch creation flow must respect the 50-child limit and handle repeated clicks without accidentally creating duplicate nodes.

### F. Window modes and resizing

Every window is one document node with one identity and one position in the tree, but it can render in either **note** or **AI conversation** mode.

- New windows start in note mode. An always-visible two-state control in the window header switches modes.
- Switching modes must preserve both the note body and the AI conversation. The note body becomes editable context for the AI request; the chat remains if the user switches back.
- The mode switch is a document operation and must participate in undo/redo.
- Every window is resizable by dragging its bottom-right corner. The open window provides an in-editor handle (with keyboard resizing when focused); a selected painted window shows and accepts the same corner handle directly on the canvas.
- Dimensions are stored in world coordinates as part of the node and survive panning, zooming, refresh, export and import.
- Resizing must be live: edges and hit regions update while the pointer moves, but the document is updated exactly once on release (one undo step). Do not write React state on every pointer move.
- A resize must not break zoom, pan, node dragging, marquee selection, edge attachment, text selection or highlight-to-branch. The canvas corner has a small hit zone so it does not swallow ordinary drags.
- Enforce minimum and maximum window sizes in the domain/business layer, not only in CSS.
- Resize handles live inside the editor overlay (or in the engine's corner hit zone) so they can never start an unrelated canvas gesture. Text selection inside the note body or an AI reply always takes precedence over canvas dragging.
- Collapsing a window uses a compact height but must not overwrite the user's stored height.

### E. Graph visualization

- Draw a clear edge between each parent and child.
- Edges should attach to appropriate points on the windows and update when windows move.
- Use a consistent visual style for edges, nodes, hover states, selection, and focus.
- Make parent-child relationships understandable at a glance.
- Avoid edge and node overlap where reasonably possible.
- Automatically place new branches near their parent, using a simple deterministic layout strategy.
- Do not rearrange the entire graph after every edit or drag.
- Provide a way to navigate from a child to its parent.
- Ensure text remains readable at typical zoom levels. Consider minimum visual sizes, zoom-aware labels, or simplified rendering at extreme zoom levels.

The layout should remain user-editable. Automatic layout is an initial placement aid, not a constraint on node movement.

## 3. Performance and Rendering Architecture

The canvas must be designed to remain responsive as the graph grows. Do not implement it as an ever-growing collection of React components that rerender on every mouse movement.

First inspect existing dependencies. If the repository does not already have a suitable canvas library, evaluate React Flow for graph interactions and a custom Canvas 2D renderer for a more free-form workspace. Select one approach based on actual requirements rather than mixing rendering technologies unnecessarily.

For a custom renderer, prefer a single Canvas 2D rendering surface for the graph background, edges, and node visuals, with HTML overlays only where necessary for editable text and accessible controls. Use a graph library if it provides adequate performance and substantially reduces implementation complexity.

Apply the following principles:

### A. Separate document state from viewport state

Maintain distinct state for:

- Graph document: nodes, edges, text, chat history, window mode/size, metadata, and source references.
- Viewport: pan offsets, zoom, canvas dimensions.
- Interaction: selection, dragging/resizing, active tool, hover, and active editor.
- Persistence: save status and serialized document.
- AI runtime: per-node sessions and request status (in memory, never per-token in the document).

Camera movement must not modify document coordinates.

Avoid React state updates for every pointer movement when a ref or imperative renderer update is more appropriate.

### B. Efficient rendering

- Use `requestAnimationFrame` to schedule canvas updates during continuous interactions.
- Coalesce pointer-move events and avoid unnecessary redraws.
- Avoid rerendering the entire React component tree during panning, zooming, and node dragging.
- Use viewport culling or equivalent techniques if the rendering strategy benefits from them.
- If implementing custom Canvas 2D rendering, maintain a scene graph and efficient node lookup.
- Use a spatial index, such as a uniform spatial grid or R-tree, when node counts and hit-testing requirements justify it.
- Cache expensive static drawing where useful, invalidating caches when relevant content changes.
- Do not add a complicated tile-rendering system prematurely. The initial hard limit is 50 children per node, but total graph size can still grow significantly with branching depth. Design for growth and measure performance.
- Avoid recalculating the entire graph layout when one node moves.
- Keep edge rendering and hit testing efficient.
- Use device-pixel-ratio-aware canvas sizing so the interface remains sharp on high-DPI displays.

If using a library such as React Flow, take advantage of its existing viewport, connection, and interaction mechanisms rather than reimplementing them. Still prevent unnecessary React rerenders and avoid expensive custom node rendering.

### C. Editing performance

- Do not persist the full graph to storage on every keystroke.
- Debounce persistence while ensuring edits are not lost on navigation or page closure.
- Keep updates localized to the changed node where possible.
- Avoid serializing large portions of the graph for every minor interaction.
- Handle rapid typing, paste operations, and multiple simultaneous UI interactions smoothly.

### D. Performance validation

Test with synthetic graphs containing at least:
- 1 root with 50 children.
- Several levels of branching with hundreds of total nodes.
- A larger stress-test graph with approximately 5,000 nodes, where feasible for the selected architecture.

The 5,000-node graph is a performance stress test, not a requirement to render every node as a fully active DOM editor simultaneously.

Measure frame responsiveness, pan/zoom smoothness, editing latency, and memory use where practical. Document any limitations instead of claiming performance that has not been verified.

## 4. Data Model and Persistence

Define a versioned, serializable graph-document format.

A starting point (schema 2 as implemented):

```ts
type NodeId = string;
type WindowKind = 'note' | 'ai';

interface GraphDocument {
  schemaVersion: number;       // 2
  id: string;
  title: string;
  rootNodeId: NodeId;
  nodes: Record<NodeId, NoteNode>;
  edges: Record<string, GraphEdge>;
  createdAt: number;
  updatedAt: number;
}

interface NoteNode {
  id: NodeId;
  parentId: NodeId | null;
  title: string;
  /** Note body. In AI mode it is preserved as editable chat context. */
  content: string;
  position: { x: number; y: number };  // world coordinates
  /** World-space size; survives zoom, pan, reload and export. */
  size: { width: number; height: number };
  /** Note or AI conversation. */
  kind: WindowKind;
  /** Persisted per-window chat, oldest first. */
  chat: ChatMessage[];
  sourceReference: SourceReference | null;
  collapsed: boolean;
  contentVersion: number;
  createdAt: number;
  updatedAt: number;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  interrupted?: boolean;
}

interface GraphEdge {
  id: string;
  sourceNodeId: NodeId;
  targetNodeId: NodeId;
}

interface SourceReference {
  sourceNodeId: NodeId;
  /** Present when the selection came from an AI reply rather than the note body. */
  sourceMessageId?: string;
  selectedTextSnapshot: string;
  startOffset: number;
  endOffset: number;
  sourceContentVersion: number;
}
```

The **API key is not part of the document**. It is user-level configuration stored separately in browser-local storage, so exporting or sharing a canvas can never include a secret.

Treat this as a proposed baseline; adapt it if the chosen graph library or editor requires a better representation.

Ensure that parent-child relationships and edges remain consistent. If relationships can be derived from `parentId`, avoid maintaining redundant data without a clear consistency strategy.

Use a repository/service abstraction for persistence, so storage can be changed without rewriting UI components.

For the initial version:
- Support saving and restoring the graph, including window mode, size and conversations.
- Prefer IndexedDB for browser-local persistence if no backend exists.
- If the repository already has a backend and database, follow its established conventions.
- Include a debounced autosave mechanism and visible save status. Streaming tokens must not be written to the document per token.
- Validate graph structure, window sizes and node character limits during import and load.
- Include a schema version and migrations for the fields added by window modes, resizing and chat.
- Store the API key and selected model separately with the clear user-facing warning that a browser-held key is readable by anyone with access to the profile. Never place it in a document, export, URL or log.

Do not add authentication, collaboration, cloud synchronization, or a backend solely for AI chat unless the existing application requires it. The initial AI transport is a direct browser call to the provider using the user's key.

## 5. AI Conversation Windows (Implemented)

### A. Settings and credentials

- Provide a Settings dialog reachable from the top toolbar, with an API key field, a show/hide control, a model selector and a clear "Remove key" action.
- Persist the key in browser-local storage under a dedicated key, not in the graph document.
- Warn plainly that the key lives in this browser and that anyone with access to the profile could read it. Requests go directly from the browser to the provider.
- Do not log, export, URL-encode or otherwise copy the key.
- If no key is configured, the chat UI must say so and offer a path to Settings. Do not send a request, and do not fake a response.

### B. Independent per-node request lifecycles

Chat is implemented with real provider streaming. It must satisfy:

- Requests are associated with a node ID and a unique request ID.
- Multiple windows can initiate independent requests concurrently; there is no global conversation or request queue.
- Streaming output is routed to the correct node through a session store keyed by node ID.
- A node can cancel its own request without cancelling unrelated requests (`AbortController` per request).
- A late response cannot overwrite newer state for the same node; each event is checked against the node's active request ID.
- Errors and retries are scoped to the relevant node. Retry re-sends the last user turn without duplicating it.
- Session history is isolated per node and persisted in that node's document record.
- A configurable global concurrency cap bounds simultaneous requests; exceeding it produces a clear, non-destructive error rather than an unbounded fan-out.
- Deleting or resetting a window aborts and cleans up its request.
- Streaming tokens update only in-memory session state. The document is written once when the response completes, so autosave is not scheduled per token.
- Refusals, authentication failures, rate limits, model errors and network failures produce specific, actionable messages.

A session abstraction shaped like this is sufficient:

```ts
interface NodeAISession {
  nodeId: NodeId;
  messages: AIMessage[];          // in-flight/streaming buffer, not persistence
  status: 'idle' | 'running' | 'completed' | 'error' | 'cancelled';
  activeRequestId: string | null;
}
```

The persisted conversation lives in `NoteNode.chat` (see the data model). The runtime session is keyed by node in `ai/sessionStore.ts` and driven by `ai/chatRuntime.ts`.

### C. Context and branch lineage

A request is assembled from:

- The current window's note body (`content`), clipped under a character budget. In AI mode this is the user's editable context.
- Its source text snapshot and source reference, including whether the source is stale.
- Its parent and nearest-ancestor lineage, clipped and nearest-first under an explicit character budget.
- The window's own conversation history, kept under a separate recent-turn budget.
- A compact system prompt explaining the workspace, plain-text output and per-window isolation.

Do not concatenate every ancestor's full 20,000-character content. Context assembly is selective and budgeted (`ai/context.ts`, `ai/chatContext.ts`). Never include another window's conversation.

### D. Provider boundary and future surfaces

Keep provider transport behind a small module (`ai/chatService.ts`) so the graph, editor and canvas layers never import a provider SDK. The initial implementation uses Anthropic's Messages API with streaming and the user's own key; the SDK is loaded lazily on first send so a canvas with no AI activity does not pay for it.

AI **autocomplete** and non-chat AI features remain future work. Keep the documented service boundary available for them:

```ts
interface AIService {
  autocomplete(input: AutocompleteInput): AsyncIterable<string>;
  ask(input: AskInput): Promise<AskResult>;
  cancel(nodeId: NodeId, requestId: string): void;
}
```

Do not add fake implementations for those surfaces. The chat implementation and the generic interface may coexist; the chat UI must not depend on the generic registry.

## 6. Interaction and UX Requirements

Aim for a minimal, polished, desktop-first experience.

The interface should prioritize the canvas and note content rather than permanent navigation chrome.

Include:
- A small top toolbar with the document title, settings and essential actions.
- A canvas with a subtle grid or similarly useful spatial cue.
- Distinct note and AI windows with clear focus and selection states.
- A visible note/AI mode switch in every open window header.
- A floating branch-creation action near selected text, in notes and AI replies.
- A resize handle on every window, with keyboard resizing as an alternative.
- An unobtrusive node character counter in note mode and a message count in AI mode.
- Zoom controls and a fit-to-view action.
- A visible indication when a node reaches its branch limit.
- A settings dialog for the API key and model, with clear privacy wording.
- Helpful empty, loading, error, and save-status states.
- Confirmation when an action could delete substantial content.

Support keyboard accessibility:
- Keyboard navigation and accessible labels for controls.
- A keyboard shortcut for creating a branch when a valid selection exists.
- Escape to dismiss transient controls or cancel an interaction.
- Enter to send an AI message, Shift+Enter for a newline, and a Stop control that cancels only that window.
- Appropriate focus management when creating, switching and deleting nodes.
- Arrow keys to resize a focused window handle.

Prevent accidental canvas panning while the user is selecting or editing text. Ensure that text selection takes precedence over canvas drag interactions inside an active editor. Selecting chat text and pressing Delete must not delete the whole window.

Do not sacrifice editing usability for rendering performance.

## 7. Suggested Code Organization

Adapt this to the existing repository rather than imposing a new structure unnecessarily.

```text
src/
  app/
  components/
    canvas/
      GraphCanvas
      CanvasToolbar
      Minimap
    node/
      NoteWindow        window frame: mode switch, actions, footer, resize
      NoteEditor        textarea body and highlight-to-branch
      AIChatPanel       messages, composer, streaming, chat selection
      BranchAction
    panels/
      SettingsPanel
  graph/
    types
    graphStore
    graphOperations
    graphValidation
    layout
    metrics
  canvas/
    engine
    camera
    coordinateTransforms
    renderer
    spatialIndex
    hitTesting
    interactions
  editor/
    selection
    chatSelection
    characterLimit
  persistence/
    documentRepository
    autosave
    migrations
  ai/
    settings          user key/model, local only
    chatService       provider transport (lazy SDK)
    chatRuntime       per-node request lifecycle
    chatContext       selective prompt/history assembly
    sessionStore
    types
    serviceInterface  future autocomplete/Q&A seam
  hooks/
  utils/
```

Use clear module boundaries and keep graph business logic independent of React components.

## 8. Engineering Standards

- Use TypeScript with strict typing.
- Follow existing linting, formatting, testing, and naming conventions.
- Keep dependencies minimal and justified; load a heavy provider SDK lazily.
- Avoid monolithic components and unnecessary abstractions.
- Separate business logic from rendering and UI state.
- Validate all graph mutations through centralized operations.
- Handle invalid selections, stale references, failed saves, failed AI requests, and malformed documents.
- Ensure that the app works after refreshing the page.
- Avoid implementing fake functionality merely to make the interface appear complete.
- Never persist secrets into the graph document or exports.
- Document non-obvious rendering and state-management decisions.

Add unit tests for:
- Root node creation.
- Branch creation from any node.
- The 50-child limit.
- The 20,000-character limit.
- Graph integrity and deletion semantics.
- Text selection offsets and source snapshots, including selections inside AI messages.
- Window mode switching preserving note content and chat.
- Resize clamping, persistence and undo.
- Coordinate transformations and zoom-around-cursor behavior.
- Autosave and document restoration, including AI mode, size and conversations.
- Independent per-node AI session state isolation.
- AI history budgeting, prompt assembly and non-inclusion of other windows.
- Settings storage, key clearing and malformed settings.

Add integration tests for the key workflows:
- Create a note, type content, highlight a phrase, create a child branch, edit the child, create a grandchild, move nodes, reload the document, and verify the graph is restored correctly.
- Switch a window to AI, exchange messages, resize it, reload, and verify mode, size and conversation are restored.

## 9. Implementation Workflow

Follow this order:

1. Inspect the existing project and identify the most suitable canvas and editor approach.
2. Briefly explain the proposed architecture and any important trade-offs.
3. Define the graph schema and centralized graph operations.
4. Implement the root note, note editing, branch creation, and source references.
5. Implement the canvas, camera, graph edges, node movement, and selection interactions.
6. Implement branch-limit and character-limit validation.
7. Add persistence, autosave, and restoration.
8. Add rendering and state-management optimizations.
9. Add window modes, world-space resizing, and mode-preserving undo.
10. Implement AI settings, provider streaming, per-node request runtime, and chat persistence.
11. Keep the future autocomplete/Q&A boundary documented without faking it.
12. Add tests, run the available checks, and fix regressions.
13. Provide setup instructions and document important design decisions.

Do not stop after creating a plan or mockup. Implement the working application in the repository. If a technical decision blocks progress, choose the simplest robust solution consistent with these requirements and document the trade-off.

## 10. Definition of Done

The implementation is complete when:

- A fresh canvas starts with one root note.
- Users can write up to 20,000 characters in each note and each chat message.
- Selecting text and choosing "Create branch" creates a connected child window with a source snapshot and selection offsets, from notes and AI replies.
- Branching works recursively from every node.
- No node can exceed 50 direct children.
- Users can pan, zoom, move nodes, and navigate the graph without corrupting relationships.
- Edges stay connected as nodes move and resize.
- Every window can switch between note and AI conversation mode without losing its note body or chat.
- Every window can be resized in world coordinates, with the change surviving zoom, pan, reload, export and import.
- AI chat uses a real provider request with the user's key, streams into the correct window, is cancellable per window, and never shares conversation state between windows.
- The API key is stored only in browser-local settings and never in the document/export.
- Documents persist across refreshes, including window mode, size, positions, notes and conversations.
- Editing, selection, deletion, and restoration behave predictably.
- Rendering architecture avoids unnecessary React rerenders and is designed for growing graphs.
- Future autocomplete/Q&A surfaces have a clear seam, but no fake AI feature is shown.
- Tests and available project checks pass, with limitations documented honestly.

**Priority order:** correctness of graph and text interactions first, editing usability second, persistence third, rendering performance fourth, and AI extensibility throughout the architecture. Deliver a working, maintainable foundation rather than an overengineered prototype.