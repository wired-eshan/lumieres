/**
 * Canvas 2D scene renderer.
 *
 * Everything static — background, grid, edges, window chrome, wrapped note text
 * — is painted here in a single surface. The only DOM overlay is the active
 * editor and the floating controls, so the React tree never grows with the
 * graph.
 *
 * Cost control:
 *  - viewport culling via the spatial index (only visible windows are touched)
 *  - level of detail by zoom tier (structure → blocks → full text)
 *  - wrapped text cached per node (`TextLayoutCache`), so panning is measure-free
 *  - shadows and rounded corners skipped at low zoom
 */

import type { GraphDocument, NodeId, Point, Rect } from '../graph/types';
import { compareRenderOrder, getNode, evaluateSourceReference } from '../graph/graphOperations';
import {
  BODY_LINE_HEIGHT,
  GRID_SIZE,
  NODE_CONTENT_PADDING,
  NODE_FOOTER_HEIGHT,
  NODE_HEADER_HEIGHT,
  NODE_RADIUS,
  SOURCE_CHIP_HEIGHT,
  bodyTopOffset,
  nodeSize,
} from '../graph/metrics';
import { clamp } from '../utils/misc';
import { visibleWorldRect } from './coordinateTransforms';
import type { Camera, Viewport } from './camera';
import type { SpatialGrid } from './spatialIndex';
import { ellipsize, textLayoutCache } from './textLayout';
import { fonts, palette, zoomTier } from './theme';

export interface RenderFrame {
  doc: GraphDocument;
  camera: Camera;
  viewport: Viewport;
  /** Nodes with an in-flight drag offset; drawn at their provisional position. */
  draftPositions: ReadonlyMap<NodeId, Point>;
  selectedIds: ReadonlySet<NodeId>;
  hoveredId: NodeId | null;
  editingNodeId: NodeId | null;
  /** Node currently under the pointer while dragging, for source highlighting. */
  dragSourceId?: NodeId | null;
  /** In-flight selection rectangle, in **world** coordinates (like node rects). */
  marquee: Rect | null;
  index: SpatialGrid;
  /** Extra ids that must be painted even if culling misses them. */
  forceVisible?: ReadonlySet<NodeId>;
  /** Recent branch targets, painted with a brief highlight pulse. */
  pulse?: { ids: ReadonlySet<NodeId>; startedAt: number } | null;
  now: number;
}

const CULL_PADDING = 240;
const PULSE_DURATION = 1100;

export function nodeRectAt(position: Point, collapsed: boolean): Rect {
  const size = nodeSize(collapsed);
  return { x: position.x, y: position.y, width: size.width, height: size.height };
}

export interface RenderStats {
  /** Windows that survived culling (i.e. were candidates for painting). */
  visible: number;
  drawnNodes: number;
  drawnEdges: number;
  textCacheSize: number;
}

export class GraphRenderer {
  private lastVisible = 0;
  private lastDrawnNodes = 0;
  private lastDrawnEdges = 0;

  /** Diagnostics surfaced in the dev overlay; not used for control flow. */
  get stats(): RenderStats {
    return {
      visible: this.lastVisible,
      drawnNodes: this.lastDrawnNodes,
      drawnEdges: this.lastDrawnEdges,
      textCacheSize: textLayoutCache.size,
    };
  }

  draw(ctx: CanvasRenderingContext2D, frame: RenderFrame): void {
    const { camera, viewport } = frame;
    this.lastVisible = 0;
    this.lastDrawnNodes = 0;
    this.lastDrawnEdges = 0;

    ctx.save();
    ctx.clearRect(0, 0, viewport.width, viewport.height);
    ctx.fillStyle = palette.background;
    ctx.fillRect(0, 0, viewport.width, viewport.height);

    this.drawGrid(ctx, frame);

    const visibleWorld = visibleWorldRect(camera, viewport);
    const cullRect: Rect = {
      x: visibleWorld.x - CULL_PADDING,
      y: visibleWorld.y - CULL_PADDING,
      width: visibleWorld.width + CULL_PADDING * 2,
      height: visibleWorld.height + CULL_PADDING * 2,
    };

    const visibleIds = new Set<NodeId>(frame.index.queryRect(cullRect));
    if (frame.forceVisible) for (const id of frame.forceVisible) visibleIds.add(id);
    this.lastVisible = visibleIds.size;

    if (camera.zoom < zoomTier.structure) {
      // Extreme zoom-out: paint the topology only. Individual windows would be
      // sub-pixel; the structure is what matters at this scale.
      this.drawStructuralOverview(ctx, frame, visibleWorld);
    } else {
      this.drawEdges(ctx, frame, visibleIds);
      this.drawNodes(ctx, frame, visibleIds);
    }

    // The marquee is painted last and in every tier: it is the only feedback for
    // an in-flight selection gesture, so it must not be dropped by level of detail.
    if (frame.marquee) this.drawMarquee(ctx, camera, frame.marquee);
    ctx.restore();
  }

  /* ---------------------------------------------------------------- */
  /* Background                                                        */
  /* ---------------------------------------------------------------- */

  private drawGrid(ctx: CanvasRenderingContext2D, frame: RenderFrame): void {
    const { camera, viewport } = frame;
    let step = GRID_SIZE;
    while (step * camera.zoom < 16) step *= 2;
    const major = step * 5;
    const visible = visibleWorldRect(camera, viewport);

    const startX = Math.floor(visible.x / step) * step;
    const endX = visible.x + visible.width;
    const startY = Math.floor(visible.y / step) * step;
    const endY = visible.y + visible.height;

    ctx.lineWidth = 1;
    ctx.strokeStyle = palette.gridFine;
    ctx.beginPath();
    for (let x = startX; x <= endX; x += step) {
      const screenX = Math.round((x - camera.x) * camera.zoom) + 0.5;
      ctx.moveTo(screenX, 0);
      ctx.lineTo(screenX, viewport.height);
    }
    for (let y = startY; y <= endY; y += step) {
      const screenY = Math.round((y - camera.y) * camera.zoom) + 0.5;
      ctx.moveTo(0, screenY);
      ctx.lineTo(viewport.width, screenY);
    }
    ctx.stroke();

    ctx.strokeStyle = palette.gridBold;
    ctx.beginPath();
    const majorStartX = Math.floor(visible.x / major) * major;
    const majorStartY = Math.floor(visible.y / major) * major;
    for (let x = majorStartX; x <= endX; x += major) {
      if (x % major !== 0 && Math.abs(x % major) > 1e-6) continue;
      const screenX = Math.round((x - camera.x) * camera.zoom) + 0.5;
      ctx.moveTo(screenX, 0);
      ctx.lineTo(screenX, viewport.height);
    }
    for (let y = majorStartY; y <= endY; y += major) {
      const screenY = Math.round((y - camera.y) * camera.zoom) + 0.5;
      ctx.moveTo(0, screenY);
      ctx.lineTo(viewport.width, screenY);
    }
    ctx.stroke();
  }

  private drawStructuralOverview(
    ctx: CanvasRenderingContext2D,
    frame: RenderFrame,
    visible: Rect,
  ): void {
    const { camera } = frame;
    ctx.fillStyle = palette.edge;
    for (const node of Object.values(frame.doc.nodes)) {
      const rect = this.rectFor(frame, node.id);
      if (!rect) continue;
      if (
        rect.x + rect.width < visible.x ||
        rect.x > visible.x + visible.width ||
        rect.y + rect.height < visible.y ||
        rect.y > visible.y + visible.height
      ) {
        continue;
      }
      this.lastDrawnNodes += 1;
      ctx.fillRect(
        (rect.x - camera.x) * camera.zoom,
        (rect.y - camera.y) * camera.zoom,
        Math.max(1, rect.width * camera.zoom),
        Math.max(1, rect.height * camera.zoom),
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Edges                                                             */
  /* ---------------------------------------------------------------- */

  private drawEdges(ctx: CanvasRenderingContext2D, frame: RenderFrame, visibleIds: Set<NodeId>): void {
    const { camera } = frame;
    const highlightSet = new Set<NodeId>(frame.selectedIds);
    if (frame.hoveredId) highlightSet.add(frame.hoveredId);
    if (frame.editingNodeId) highlightSet.add(frame.editingNodeId);
    if (frame.dragSourceId) highlightSet.add(frame.dragSourceId);

    ctx.lineCap = 'round';

    for (const childId of visibleIds) {
      const child = getNode(frame.doc, childId);
      if (!child || child.parentId === null) continue;
      const parent = getNode(frame.doc, child.parentId);
      if (!parent) continue;

      const parentRect = this.rectFor(frame, parent.id);
      const childRect = this.rectFor(frame, child.id);
      if (!parentRect || !childRect) continue;

      const isActive = highlightSet.has(parent.id) || highlightSet.has(child.id);
      this.lastDrawnEdges += 1;

      ctx.strokeStyle = isActive ? palette.edgeActive : palette.edge;
      ctx.lineWidth = isActive ? 2 : 1.5;
      ctx.globalAlpha = isActive ? 1 : 0.85;

      const geometry = edgeGeometry(parentRect, childRect);
      const a = this.toScreen(camera, geometry.from);
      const b = this.toScreen(camera, geometry.to);
      const c1 = this.toScreen(camera, geometry.c1);
      const c2 = this.toScreen(camera, geometry.c2);

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, b.x, b.y);
      ctx.stroke();

      if (camera.zoom > zoomTier.detail) {
        ctx.fillStyle = isActive ? palette.edgeActive : palette.edge;
        drawArrowHead(ctx, b, geometry.direction);
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ---------------------------------------------------------------- */
  /* Nodes                                                             */
  /* ---------------------------------------------------------------- */

  private drawNodes(ctx: CanvasRenderingContext2D, frame: RenderFrame, visibleIds: Set<NodeId>): void {
    const { camera, doc, viewport } = frame;
    const showText = camera.zoom >= zoomTier.text;
    const showDetail = camera.zoom >= zoomTier.detail;

    // Deterministic paint order: parents under children, then by creation. The
    // depth cache is shared for the whole pass so the sort stays cheap even
    // when a large part of the graph is on screen.
    const depthCache = new Map<NodeId, number>();
    const ordered = [...visibleIds]
      .map((id) => doc.nodes[id])
      .filter((node): node is NonNullable<typeof node> => Boolean(node))
      .sort((a, b) => compareRenderOrder(doc, a, b, depthCache));

    for (const node of ordered) {
      const rect = this.rectFor(frame, node.id);
      if (!rect) continue;

      const screenRect = this.screenRect(camera, rect);
      if (
        screenRect.x + screenRect.width < -40 ||
        screenRect.x > viewport.width + 40 ||
        screenRect.y + screenRect.height < -40 ||
        screenRect.y > viewport.height + 40
      ) {
        continue;
      }
      this.lastDrawnNodes += 1;

      const isSelected = frame.selectedIds.has(node.id);
      const isHovered = frame.hoveredId === node.id;
      const isEditing = frame.editingNodeId === node.id;
      const isRoot = node.id === doc.rootNodeId;
      const overLimit = node.content.length > 20_000;
      const pulsing =
        frame.pulse && frame.pulse.ids.has(node.id) && frame.now - frame.pulse.startedAt < PULSE_DURATION;

      ctx.save();
      ctx.translate(screenRect.x, screenRect.y);
      ctx.scale(camera.zoom, camera.zoom);

      if (showDetail && (isSelected || isHovered || isEditing || pulsing)) {
        ctx.shadowColor = isSelected || isEditing ? 'rgba(124,140,248,0.35)' : palette.shadow;
        ctx.shadowBlur = isSelected || isEditing ? 26 : 18;
        ctx.shadowOffsetY = 6;
      }

      ctx.fillStyle = palette.nodeFill;
      pathRoundedRect(ctx, 0, 0, rect.width, rect.height, NODE_RADIUS * (showDetail ? 1 : 0.5));
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;

      if (!node.collapsed) {
        // Header band
        ctx.save();
        pathRoundedRect(ctx, 0, 0, rect.width, NODE_HEADER_HEIGHT + NODE_RADIUS, NODE_RADIUS);
        ctx.clip();
        ctx.fillStyle = palette.nodeHeader;
        ctx.fillRect(0, 0, rect.width, NODE_HEADER_HEIGHT);
        ctx.restore();

        // Accent stripe
        ctx.fillStyle = isRoot ? palette.rootAccent : palette.accent;
        ctx.globalAlpha = isSelected || isHovered || isEditing ? 1 : 0.7;
        pathRoundedRect(ctx, NODE_CONTENT_PADDING, 14, 3, NODE_HEADER_HEIGHT - 28, 1.5);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Border (drawn last so it sits crisply on the fill)
      ctx.lineWidth = isSelected || isEditing ? 1.75 : 1;
      ctx.strokeStyle = overLimit
        ? palette.nodeBorderOverLimit
        : isSelected || isEditing
          ? palette.nodeBorderSelected
          : isHovered
            ? palette.nodeBorderHover
            : palette.nodeBorder;
      pathRoundedRect(ctx, 0.5, 0.5, rect.width - 1, rect.height - 1, NODE_RADIUS);
      ctx.stroke();

      if (showText) this.drawNodeContent(ctx, frame, node.id, rect, isRoot);
      else this.drawNodePlaceholder(ctx, rect);

      if (pulsing && frame.pulse) {
        const t = clamp((frame.now - frame.pulse.startedAt) / PULSE_DURATION, 0, 1);
        ctx.globalAlpha = (1 - t) * 0.9;
        ctx.strokeStyle = palette.accent;
        ctx.lineWidth = 2 + (1 - t) * 3;
        pathRoundedRect(ctx, -4 - t * 6, -4 - t * 6, rect.width + 8 + t * 12, rect.height + 8 + t * 12, NODE_RADIUS + 4);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      ctx.restore();
    }
  }

  private drawNodePlaceholder(ctx: CanvasRenderingContext2D, rect: Rect): void {
    ctx.fillStyle = palette.gridBold;
    const lineWidth = rect.width - NODE_CONTENT_PADDING * 2;
    let y = NODE_HEADER_HEIGHT + 18;
    while (y < rect.height - NODE_FOOTER_HEIGHT - 6) {
      ctx.fillRect(NODE_CONTENT_PADDING, y, lineWidth * (y % 3 === 0 ? 1 : 0.72), 5);
      y += 14;
    }
  }

  private drawNodeContent(
    ctx: CanvasRenderingContext2D,
    frame: RenderFrame,
    nodeId: NodeId,
    rect: Rect,
    isRoot: boolean,
  ): void {
    const { doc } = frame;
    const node = doc.nodes[nodeId];
    if (!node) return;

    const contentWidth = rect.width - NODE_CONTENT_PADDING * 2;
    let cursorY: number;

    // Title
    const titleText = node.title.trim();
    const titleFont = fonts.title;
    ctx.font = titleFont;
    ctx.fillStyle = titleText.length > 0 ? palette.text : palette.textFaint;
    ctx.textBaseline = 'middle';
    const titleLabel = ellipsize(titleText.length > 0 ? titleText : 'Untitled note', titleFont, contentWidth - 6);
    ctx.fillText(titleLabel, NODE_CONTENT_PADDING + (isRoot || !node.collapsed ? 10 : 0), NODE_HEADER_HEIGHT / 2);
    cursorY = NODE_HEADER_HEIGHT;

    if (node.collapsed) {
      const childCount = countChildren(doc, node.id);
      ctx.font = fonts.label;
      ctx.fillStyle = palette.textFaint;
      ctx.textAlign = 'right';
      ctx.fillText(
        childCount > 0 ? `${childCount} branch${childCount === 1 ? '' : 'es'}` : 'collapsed',
        rect.width - NODE_CONTENT_PADDING,
        NODE_HEADER_HEIGHT / 2,
      );
      ctx.textAlign = 'left';
      return;
    }

    // Source-context chip: what this branch was created from. Its position and
    // the body offset below both come from `bodyTopOffset`, which the HTML
    // editor uses too.
    const evaluation = evaluateSourceReference(doc, node);
    if (evaluation.reference) {
      const chipY = NODE_HEADER_HEIGHT + NODE_CONTENT_PADDING * 0.5;
      const chipHeight = SOURCE_CHIP_HEIGHT;
      ctx.fillStyle = palette.chipFill;
      pathRoundedRect(ctx, NODE_CONTENT_PADDING, chipY, contentWidth, chipHeight, 6);
      ctx.fill();

      ctx.fillStyle = evaluation.status === 'stale' ? palette.warning : palette.accent;
      pathRoundedRect(ctx, NODE_CONTENT_PADDING + 5, chipY + 6, 3, chipHeight - 12, 1.5);
      ctx.fill();

      ctx.font = fonts.label;
      ctx.textBaseline = 'middle';
      const staleTag = evaluation.status === 'stale' ? 'source changed' : null;
      const staleWidth = staleTag ? measureLabel(ctx, staleTag) + 10 : 0;
      if (staleTag) {
        ctx.fillStyle = palette.warning;
        ctx.textAlign = 'right';
        ctx.fillText(staleTag, rect.width - NODE_CONTENT_PADDING - 6, chipY + chipHeight / 2);
        ctx.textAlign = 'left';
      }
      ctx.fillStyle = palette.textMuted;
      const snippet = ellipsize(
        `“${evaluation.reference.selectedTextSnapshot}”`,
        fonts.label,
        contentWidth - 20 - staleWidth,
      );
      ctx.fillText(snippet, NODE_CONTENT_PADDING + 13, chipY + chipHeight / 2);
    }
    cursorY = bodyTopOffset(Boolean(evaluation.reference));

    // Body text
    const bodyBox = {
      x: NODE_CONTENT_PADDING,
      y: cursorY,
      width: contentWidth,
      height: rect.height - NODE_FOOTER_HEIGHT - cursorY - 6,
    };
    const maxLines = Math.max(1, Math.floor(bodyBox.height / BODY_LINE_HEIGHT));
    const layout = textLayoutCache.get(
      `node:${nodeId}`,
      node.content,
      fonts.body,
      bodyBox.width,
      maxLines,
    );

    ctx.font = fonts.body;
    ctx.textBaseline = 'top';
    if (node.content.length === 0) {
      ctx.fillStyle = palette.textFaint;
      ctx.fillText('Empty note — start typing', bodyBox.x, bodyBox.y + 2);
    } else {
      ctx.fillStyle = palette.text;
      let y = bodyBox.y;
      for (let i = 0; i < layout.lines.length; i += 1) {
        const line = layout.lines[i];
        if (line === undefined) continue;
        const isLast = i === layout.lines.length - 1;
        ctx.fillText(isLast && layout.clipped ? `${line} …` : line, bodyBox.x, y);
        y += BODY_LINE_HEIGHT;
      }
    }

    // Footer: character budget + branch budget.
    const footerY = rect.height - NODE_FOOTER_HEIGHT;
    ctx.strokeStyle = palette.nodeBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(NODE_CONTENT_PADDING, footerY);
    ctx.lineTo(rect.width - NODE_CONTENT_PADDING, footerY);
    ctx.stroke();

    ctx.font = fonts.mono;
    ctx.textBaseline = 'middle';
    const charCount = node.content.length;
    const overLimit = charCount > 20_000;
    ctx.fillStyle = overLimit ? palette.danger : palette.textFaint;
    ctx.fillText(`${charCount.toLocaleString('en-US')} / 20,000`, NODE_CONTENT_PADDING, footerY + NODE_FOOTER_HEIGHT / 2);

    const children = countChildren(doc, nodeId);
    if (children > 0) {
      ctx.textAlign = 'right';
      ctx.fillStyle = children >= 50 ? palette.warning : palette.textFaint;
      ctx.fillText(
        children >= 50 ? `branch limit · ${children}/50` : `${children}/50 branches`,
        rect.width - NODE_CONTENT_PADDING,
        footerY + NODE_FOOTER_HEIGHT / 2,
      );
      ctx.textAlign = 'left';
    }
  }

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * The marquee rect arrives in world coordinates (it is shared with the
   * hit-testing that decides what gets selected), so it must be projected
   * through the camera like every other piece of the scene. Drawing it raw
   * offsets the box by the camera position and pins it to the canvas edge.
   */
  private drawMarquee(ctx: CanvasRenderingContext2D, camera: Camera, marquee: Rect): void {
    const screen = this.screenRect(camera, marquee);
    ctx.fillStyle = palette.selectionFill;
    ctx.fillRect(screen.x, screen.y, screen.width, screen.height);
    ctx.strokeStyle = palette.selectionStroke;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(
      Math.round(screen.x) + 0.5,
      Math.round(screen.y) + 0.5,
      Math.round(screen.width),
      Math.round(screen.height),
    );
    ctx.setLineDash([]);
  }

  private rectFor(frame: RenderFrame, id: NodeId): Rect | null {
    const node = frame.doc.nodes[id];
    if (!node) return null;
    const draft = frame.draftPositions.get(id);
    return nodeRectAt(draft ?? node.position, node.collapsed);
  }

  private toScreen(camera: Camera, point: Point): Point {
    return { x: (point.x - camera.x) * camera.zoom, y: (point.y - camera.y) * camera.zoom };
  }

  private screenRect(camera: Camera, rect: Rect): Rect {
    return {
      x: (rect.x - camera.x) * camera.zoom,
      y: (rect.y - camera.y) * camera.zoom,
      width: rect.width * camera.zoom,
      height: rect.height * camera.zoom,
    };
  }
}

export interface EdgeGeometry {
  from: Point;
  to: Point;
  c1: Point;
  c2: Point;
  direction: Point;
}

/**
 * Chooses anchor sides from the relative placement of the two windows, so an
 * edge always leaves the side that faces its target and never cuts across a
 * window's own body.
 */
export function edgeGeometry(parent: Rect, child: Rect): EdgeGeometry {
  const parentCenter = { x: parent.x + parent.width / 2, y: parent.y + parent.height / 2 };
  const childCenter = { x: child.x + child.width / 2, y: child.y + child.height / 2 };
  const slack = 8;

  if (child.x >= parent.x + parent.width - slack) {
    const from = { x: parent.x + parent.width, y: parentCenter.y };
    const to = { x: child.x, y: childCenter.y };
    const bend = Math.max(40, (to.x - from.x) * 0.5);
    return { from, to, c1: { x: from.x + bend, y: from.y }, c2: { x: to.x - bend, y: to.y }, direction: { x: 1, y: 0 } };
  }
  if (child.x + child.width <= parent.x + slack) {
    const from = { x: parent.x, y: parentCenter.y };
    const to = { x: child.x + child.width, y: childCenter.y };
    const bend = Math.max(40, (from.x - to.x) * 0.5);
    return { from, to, c1: { x: from.x - bend, y: from.y }, c2: { x: to.x + bend, y: to.y }, direction: { x: -1, y: 0 } };
  }
  if (child.y >= parent.y + parent.height - slack) {
    const from = { x: parentCenter.x, y: parent.y + parent.height };
    const to = { x: childCenter.x, y: child.y };
    const bend = Math.max(30, (to.y - from.y) * 0.5);
    return { from, to, c1: { x: from.x, y: from.y + bend }, c2: { x: to.x, y: to.y - bend }, direction: { x: 0, y: 1 } };
  }
  const from = { x: parentCenter.x, y: parent.y };
  const to = { x: childCenter.x, y: child.y + child.height };
  const bend = Math.max(30, (from.y - to.y) * 0.5);
  return { from, to, c1: { x: from.x, y: from.y - bend }, c2: { x: to.x, y: to.y + bend }, direction: { x: 0, y: -1 } };
}

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  tip: Point,
  direction: Point,
  size = 7,
): void {
  const nx = -direction.y;
  const ny = direction.x;
  ctx.beginPath();
  ctx.moveTo(tip.x + direction.x * size, tip.y + direction.y * size);
  ctx.lineTo(tip.x + nx * size * 0.55, tip.y + ny * size * 0.55);
  ctx.lineTo(tip.x - nx * size * 0.55, tip.y - ny * size * 0.55);
  ctx.closePath();
  ctx.fill();
}

function pathRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function measureLabel(ctx: CanvasRenderingContext2D, text: string): number {
  const previous = ctx.font;
  ctx.font = fonts.label;
  const width = ctx.measureText(text).width;
  ctx.font = previous;
  return width;
}

function countChildren(doc: GraphDocument, id: NodeId): number {
  let count = 0;
  for (const node of Object.values(doc.nodes)) if (node.parentId === id) count += 1;
  return count;
}
