/**
 * Visual constants for the canvas renderer.
 *
 * These mirror the CSS custom properties in `styles/index.css`; keeping them in
 * one object means the HTML overlay (editor, toolbars) and the canvas paint the
 * same design tokens. Zoom-tier thresholds are load-bearing limits, so their
 * values are owned by `src/config.ts`.
 */

import { DETAIL_LOD_ZOOM, STRUCTURE_LOD_ZOOM, TEXT_LOD_ZOOM } from '../config';

export const palette = {
  background: '#0a0c11',
  gridFine: 'rgba(255,255,255,0.030)',
  gridBold: 'rgba(255,255,255,0.055)',
  nodeFill: '#161a24',
  nodeHeader: '#1c2130',
  nodeBorder: '#2a3143',
  nodeBorderHover: '#3d4761',
  nodeBorderSelected: '#7c8cf8',
  nodeBorderOverLimit: '#f2686b',
  text: '#e7eaf3',
  textMuted: '#98a0b5',
  textFaint: '#5f6779',
  accent: '#7c8cf8',
  /** AI conversation windows, so mode is legible at a glance on the canvas. */
  aiAccent: '#b79cff',
  accentSoft: 'rgba(124,140,248,0.14)',
  rootAccent: '#5fd3bd',
  edge: '#333c52',
  edgeActive: '#7c8cf8',
  /**
   * Branch-sourcing colors. A window created from a highlighted range carries a
   * `sourceReference`; its edge and the referenced phrase are painted in these
   * ambers to tie the highlighted text to the edge of the branch that came from
   * it. Contrast (WCAG): the muted `branch` is 6.7:1 on the canvas background
   * (#0a0c11), the active variant 12.3:1 — both comfortably above the 3:1
   * graphic threshold. `branchHighlightFill` is a translucent amber laid over
   * the node fill; the light body text keeps ~9.6:1 on it, above the 4.5:1 text
   * threshold, so highlighting never degrades readability.
   */
  branch: '#c98a2f',
  branchActive: '#ffc34d',
  branchHighlightFill: 'rgba(255,195,77,0.20)',
  /** Live text selection, matching `--branch-selection` (opaque amber). */
  branchSelectionFill: 'rgba(201,138,47,0.62)',
  danger: '#f2686b',
  warning: '#f0b35e',
  success: '#5ad19b',
  selectionFill: 'rgba(124,140,248,0.08)',
  selectionStroke: 'rgba(124,140,248,0.55)',
  shadow: 'rgba(0,0,0,0.45)',
  chipFill: 'rgba(124,140,248,0.10)',
  /** Source chip fill once consigned to the branch (amber) family. */
  branchChipFill: 'rgba(201,138,47,0.14)',
} as const;

export const fonts = {
  title: `600 14px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`,
  body: `400 13px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`,
  label: `500 11px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`,
  mono: `400 11px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace`,
} as const;

export const zoomTier = {
  /** Below this, text is replaced by placeholder blocks. */
  text: TEXT_LOD_ZOOM,
  /** Below this, node shadows and inner detail are skipped. */
  detail: DETAIL_LOD_ZOOM,
  /** Below this, only edges and outlines are painted. */
  structure: STRUCTURE_LOD_ZOOM,
} as const;
