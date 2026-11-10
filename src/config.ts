/**
 * Central limits and provider configuration.
 *
 * Every hard product/domain limit lives here — branch fan-out, note and chat
 * message length, window resize bounds, undo depth, zoom bounds and the AI
 * request/context/token budgets. Business rules import these values rather than
 * carrying their own literals, so changing a limit is one edit in one file and
 * the UI copy, validation and runtime behaviour stay in agreement.
 *
 * Layout geometry (window default sizes, gaps, fonts, radii) deliberately stays
 * in `graph/metrics.ts`: those are drawing measurements, not product limits.
 * Provider endpoints, protocols, defaults and capability metadata live in
 * `ai/provider.ts`, close to the registry that resolves them.
 */

export const CONFIG = {
  graph: {
    /** Maximum direct children a single window may have (not a canvas total). */
    maxChildrenPerNode: 50,
    /** Maximum UTF-16 code units in a note body or a user chat message. */
    maxNodeContentLength: 20_000,
    /** Undo/redo entries retained before the oldest are discarded. */
    maxHistoryEntries: 200,
  },
  window: {
    /** World-space resize bounds; enforced by `clampNodeSize`, not just CSS. */
    minWidth: 260,
    minHeight: 240,
    maxWidth: 960,
    maxHeight: 900,
  },
  canvas: {
    minZoom: 0.1,
    maxZoom: 3,
    /** Below this zoom, text is replaced by block placeholders. */
    textLodZoom: 0.42,
    /** Below this zoom, shadows and inner detail are skipped. */
    detailLodZoom: 0.25,
    /**
     * Below this zoom, windows are labelled with their title only (drawn at a
     * screen-space floor so it stays readable), instead of full body text.
     */
    titleLodZoom: 0.25,
    /** Below this zoom, only edges and window outlines are painted. */
    structureLodZoom: 0.14,
    /** Below this zoom the HTML editor overlay is closed. */
    minEditZoom: 0.5,
  },
  persistence: {
    /**
     * Above this serialized size the emergency localStorage mirror is skipped,
     * keeping the primary IndexedDB store within browser quota.
     */
    mirrorMaxBytes: 900_000,
  },
  ai: {
    /** Output ceiling for one assistant reply, in tokens. */
    maxOutputTokens: 16_000,
    /** Global cap on simultaneous chat requests across all windows. */
    maxConcurrentRequests: 4,
    /** One in-flight request per window; a new send supersedes the old one. */
    maxConcurrentRequestsPerNode: 1,
    /** Streaming deltas are batched at this cadence before touching the UI. */
    deltaFlushMs: 50,
    /** Character budgets for the lineage/note context sent with a request. */
    context: {
      maxCharacters: 8_000,
      maxAncestors: 4,
      minAncestorCharacters: 160,
    },
    /** Character/turn budgets for the window's own conversation history. */
    history: {
      maxCharacters: 24_000,
      maxMessages: 80,
    },
    /**
     * Ancestor-context summarization (hybrid): a deterministic extractive
     * summarizer is always used; when a provider key is configured and a fresh
     * cache entry exists, an abstractive LLM "lineage summary" (root → current)
     * replaces the raw excerpts. These knobs bound the cache and background jobs.
     */
    summarize: {
      /** Soft target total length of a lineage summary. */
      targetCharacters: 1_200,
      /** Dedicated background summary jobs; separate from the chat concurrency cap. */
      maxConcurrent: 1,
      /** In-memory LRU summaries kept. */
      maxCacheEntries: 64,
    },
  },
} as const;

export type AppConfig = typeof CONFIG;

/* ------------------------------------------------------------------ */
/* Named aliases                                                       */
/*                                                                     */
/* Kept for readable imports at call sites and for compatibility with  */
/* modules that previously defined these constants themselves.         */
/* ------------------------------------------------------------------ */

export const MAX_CHILDREN_PER_NODE = CONFIG.graph.maxChildrenPerNode;
export const MAX_NODE_CONTENT_LENGTH = CONFIG.graph.maxNodeContentLength;
export const MAX_HISTORY_ENTRIES = CONFIG.graph.maxHistoryEntries;
export const MIRROR_MAX_BYTES = CONFIG.persistence.mirrorMaxBytes;

export const MIN_NODE_WIDTH = CONFIG.window.minWidth;
export const MIN_NODE_HEIGHT = CONFIG.window.minHeight;
export const MAX_NODE_WIDTH = CONFIG.window.maxWidth;
export const MAX_NODE_HEIGHT = CONFIG.window.maxHeight;

export const MIN_ZOOM = CONFIG.canvas.minZoom;
export const MAX_ZOOM = CONFIG.canvas.maxZoom;
export const TEXT_LOD_ZOOM = CONFIG.canvas.textLodZoom;
export const DETAIL_LOD_ZOOM = CONFIG.canvas.detailLodZoom;
export const TITLE_LOD_ZOOM = CONFIG.canvas.titleLodZoom;
export const STRUCTURE_LOD_ZOOM = CONFIG.canvas.structureLodZoom;
export const MIN_EDIT_ZOOM = CONFIG.canvas.minEditZoom;

export const CHAT_MAX_TOKENS = CONFIG.ai.maxOutputTokens;
export const MAX_CONCURRENT_REQUESTS = CONFIG.ai.maxConcurrentRequests;
export const DELTA_FLUSH_MS = CONFIG.ai.deltaFlushMs;
export const AI_CONTEXT_BUDGET = CONFIG.ai.context;
export const AI_HISTORY_BUDGET = CONFIG.ai.history;
