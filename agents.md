# Build a Graph-Structured Note-Taking Web App

## 1. Objective

Build a polished, performant, graph-structured note-taking web application where users can start with a single note window on an infinite canvas and progressively branch their thinking into connected windows.

The core interaction is:

1. A user opens a canvas containing one initial note window.
2. They write or paste content into the window.
3. They highlight a portion of the text.
4. A contextual action allows them to create a branch from the selected text.
5. A new note window appears on the canvas, connected to the originating window by an edge.
6. The selected text becomes the context or source reference for the new branch.
7. The new window is independently editable, and the user can repeat the process from any window to create further branches.

The result should feel like an infinite visual workspace for thinking, research, studying, brainstorming, and exploring ideas. It should combine the familiarity of a text editor with the flexibility of a node-based canvas.

**Important:** Implement the complete foundational application now, but do not implement AI autocomplete, LLM calls, or AI Q&A yet. Design the architecture so these capabilities can be added later without rewriting the graph, editor, or state-management systems.

Before coding, inspect the existing repository, identify its framework, conventions, dependencies, and current functionality. Preserve working features and follow the existing architecture where appropriate. If starting from an empty repository, establish a sensible production-ready structure.

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
- Selected text.
- Selection start and end offsets in the source text.
- A snapshot of the selected text at the time of branching.
- A way to determine whether the original selection has changed since the branch was created.

Treat the original text range as a reference, not as an automatically synchronized copy. If the source note changes, do not silently rewrite the branch's context. Instead, preserve the snapshot and mark the source reference as potentially outdated when appropriate.

Selection handling must work with the chosen editor. If the user clicks elsewhere or the selection becomes invalid, dismiss the contextual action appropriately.

The branch creation flow must respect the 50-child limit and handle repeated clicks without accidentally creating duplicate nodes.

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

- Graph document: nodes, edges, text, metadata, and source references.
- Viewport: pan offsets, zoom, canvas dimensions.
- Interaction: selection, dragging, active tool, hover, and active editor.
- Persistence: save status and serialized document.
- Future AI runtime: per-node sessions and request status.

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

A suggested starting point:

```ts
type NodeId = string;

interface GraphDocument {
  schemaVersion: number;
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
  content: string;
  position: {
    x: number;
    y: number;
  };
  sourceReference: SourceReference | null;
  createdAt: number;
  updatedAt: number;
}

interface GraphEdge {
  id: string;
  sourceNodeId: NodeId;
  targetNodeId: NodeId;
}

interface SourceReference {
  sourceNodeId: NodeId;
  selectedTextSnapshot: string;
  startOffset: number;
  endOffset: number;
  sourceContentVersion: number;
}
```

Treat this as a proposed baseline; adapt it if the chosen graph library or editor requires a better representation.

Ensure that parent-child relationships and edges remain consistent. If relationships can be derived from `parentId`, avoid maintaining redundant data without a clear consistency strategy.

Use a repository/service abstraction for persistence, so storage can be changed without rewriting UI components.

For the initial version:
- Support saving and restoring the graph.
- Prefer IndexedDB for browser-local persistence if no backend exists.
- If the repository already has a backend and database, follow its established conventions.
- Include a debounced autosave mechanism and visible save status.
- Validate graph structure and node character limits during import and load.
- Include a schema version and a migration strategy for future changes.

Do not add authentication, collaboration, cloud synchronization, or a backend solely for this feature unless the existing application requires it.

## 5. Future AI Architecture — Prepare, Do Not Implement

AI autocomplete and AI Q&A will eventually be available inside every note window. They are explicitly out of scope for the current implementation.

Do not make actual LLM API calls, add API keys, create mock AI responses that masquerade as real functionality, or implement a backend AI service at this stage.

However, the architecture must support multiple windows running AI sessions concurrently in the future.

Plan for these requirements:

### A. Independent per-node sessions

Every node must be able to own an independent AI session in the future.

Use node IDs as stable session keys. Avoid a single global conversation state that causes all windows to share the same messages, streaming response, loading status, or cancellation state.

A future session abstraction could resemble:

```ts
interface NodeAISession {
  nodeId: NodeId;
  messages: AIMessage[];
  status: "idle" | "running" | "completed" | "error";
  activeRequestId: string | null;
}

interface AIMessage {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
}
```

These interfaces are architectural guidance, not a requirement to build AI functionality now.

### B. Parallel request capability

Design the future AI service around independent request lifecycles:

- Requests are associated with a node ID and a unique request ID.
- Multiple nodes can initiate independent requests concurrently.
- Streaming output is routed to the correct node.
- A node can cancel its own request without cancelling unrelated requests.
- Late responses cannot overwrite newer state for the same node.
- Errors and retries are scoped to the relevant node.
- Session history is isolated per node.
- Shared concurrency limits and rate limiting can be introduced at the service layer later.

Do not serialize all future AI work through one global request queue.

Do not assume that concurrency means unlimited requests. The future service should support configurable concurrency limits, backpressure, cancellation, and resource cleanup.

### C. Context and branch lineage

Preserve enough graph metadata for future AI context construction.

An eventual AI request should be able to access:
- The current node's content.
- Its source text snapshot and source reference.
- Its parent and ancestor lineage, subject to configurable context limits.
- Relevant user-provided context.
- The node's own conversation history.

Do not automatically concatenate every ancestor's full 20,000-character content into every request. Future context assembly must be selective and respect model token limits.

Define a clean service boundary for future methods such as:

```ts
interface AIService {
  autocomplete(input: AutocompleteInput): AsyncIterable<string>;
  ask(input: AskInput): Promise<AskResult>;
  cancel(nodeId: NodeId, requestId: string): void;
}
```

Do not implement this interface if doing so requires unnecessary AI-specific dependencies. A documented interface or type definition is sufficient.

## 6. Interaction and UX Requirements

Aim for a minimal, polished, desktop-first experience.

The interface should prioritize the canvas and note content rather than permanent navigation chrome.

Include:
- A small top toolbar with the document title and essential actions.
- A canvas with a subtle grid or similarly useful spatial cue.
- Distinct note windows with clear focus and selection states.
- A floating branch-creation action near selected text.
- An unobtrusive node character counter.
- Zoom controls and a fit-to-view action.
- A visible indication when a node reaches its branch limit.
- Helpful empty, loading, error, and save-status states.
- Confirmation when an action could delete substantial content.

Support keyboard accessibility:
- Keyboard navigation and accessible labels for controls.
- A keyboard shortcut for creating a branch when a valid selection exists.
- Escape to dismiss transient controls or cancel an interaction.
- Appropriate focus management when creating and deleting nodes.

Prevent accidental canvas panning while the user is selecting or editing text. Ensure that text selection takes precedence over canvas drag interactions inside an active editor.

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
      NoteWindow
      NoteEditor
      BranchAction
    panels/
  graph/
    types
    graphStore
    graphOperations
    graphValidation
    layout
  canvas/
    camera
    coordinateTransforms
    renderer
    spatialIndex
    hitTesting
    interactions
  editor/
    selection
    characterLimit
  persistence/
    documentRepository
    autosave
    migrations
  ai/
    types
    serviceInterface
  hooks/
  utils/
```

Use clear module boundaries and keep graph business logic independent of React components.

## 8. Engineering Standards

- Use TypeScript with strict typing.
- Follow existing linting, formatting, testing, and naming conventions.
- Keep dependencies minimal and justified.
- Avoid monolithic components and unnecessary abstractions.
- Separate business logic from rendering and UI state.
- Validate all graph mutations through centralized operations.
- Handle invalid selections, stale references, failed saves, and malformed documents.
- Ensure that the app works after refreshing the page.
- Avoid implementing fake functionality merely to make the interface appear complete.
- Document non-obvious rendering and state-management decisions.

Add unit tests for:
- Root node creation.
- Branch creation from any node.
- The 50-child limit.
- The 20,000-character limit.
- Graph integrity and deletion semantics.
- Text selection offsets and source snapshots.
- Coordinate transformations and zoom-around-cursor behavior.
- Autosave and document restoration.
- Independent per-node AI session state isolation, using types and state abstractions only where appropriate.

Add integration tests for the key workflow: create a note, type content, highlight a phrase, create a child branch, edit the child, create a grandchild, move nodes, reload the document, and verify the graph is restored correctly.

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
9. Define the future AI session types and service boundary without implementing AI.
10. Add tests, run the available checks, and fix regressions.
11. Provide setup instructions and document important design decisions.

Do not stop after creating a plan or mockup. Implement the working application in the repository. If a technical decision blocks progress, choose the simplest robust solution consistent with these requirements and document the trade-off.

## 10. Definition of Done

The implementation is complete when:

- A fresh canvas starts with one root note.
- Users can write up to 20,000 characters in each note.
- Selecting text and choosing "Create branch" creates a connected child note with a source snapshot and selection offsets.
- Branching works recursively from every node.
- No node can exceed 50 direct children.
- Users can pan, zoom, move nodes, and navigate the graph without corrupting relationships.
- Edges stay connected as nodes move.
- Documents persist across refreshes.
- Editing, selection, deletion, and restoration behave predictably.
- Rendering architecture avoids unnecessary React rerenders and is designed for growing graphs.
- Future AI sessions have a clear path to independent per-node state and parallel request execution, but no AI calls are implemented.
- Tests and available project checks pass, with limitations documented honestly.

**Priority order:** correctness of graph and text interactions first, editing usability second, persistence third, rendering performance fourth, and future AI extensibility throughout the architecture. Deliver a working, maintainable foundation rather than an overengineered prototype.