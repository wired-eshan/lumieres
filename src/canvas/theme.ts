/**
 * Visual constants for the canvas renderer.
 *
 * These mirror the CSS custom properties in `styles/index.css`; keeping them in
 * one object means the HTML overlay (editor, toolbars) and the canvas paint the
 * same design tokens.
 */

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
  danger: '#f2686b',
  warning: '#f0b35e',
  success: '#5ad19b',
  selectionFill: 'rgba(124,140,248,0.08)',
  selectionStroke: 'rgba(124,140,248,0.55)',
  shadow: 'rgba(0,0,0,0.45)',
  chipFill: 'rgba(124,140,248,0.10)',
} as const;

export const fonts = {
  title: `600 14px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`,
  body: `400 13px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`,
  label: `500 11px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`,
  mono: `400 11px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace`,
} as const;

export const zoomTier = {
  /** Below this, text is replaced by placeholder blocks. */
  text: 0.42,
  /** Below this, node shadows and inner detail are skipped. */
  detail: 0.25,
  /** Below this, only edges and outlines are painted. */
  structure: 0.14,
} as const;
