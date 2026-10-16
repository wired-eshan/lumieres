/**
 * The canvas engine.
 *
 * Owns everything that changes at pointer speed — camera, hover, drag offsets,
 * marquee, the render loop — outside of React. React subscribes to a small,
 * immutable `EngineSnapshot` that only changes on discrete events (selection,
 * editing target, floating actions), so panning a 5,000-node canvas does not
 * rerender a single component.
 *
 * Layers, bottom to top:
 *   <canvas>            background, edges, all window chrome and preview text
 *   .overlay-layer      camera-transformed DOM; holds the one open editor
 *   .screen-layer       untransformed DOM; holds floating controls
 */

import {
  getChildCount,
  getNode,
  getNodeRect,
  getSubtreeCharCount,
  previewDeletion,
  type DeletionPreview,
} from '../graph/graphOperations';
import {
  MAX_CHILDREN_PER_NODE,
  type GraphDocument,
  type NodeId,
  type NoteNode,
  type Point,
  type Rect,
  type SourceReference,
} from '../graph/types';
import { boundsOf, resolveChildPosition } from '../graph/layout';
import { nodeSize } from '../graph/metrics';
import type { ChangeHint } from '../graph/graphStore';
import type { GraphController } from '../graph/graphController';
import { truncate } from '../utils/misc';
import {
  centerOnRect,
  ensureRectVisible,
  fitToRect,
  panCamera,
  zoomAround,
  zoomToAround,
  type Camera,
  type Viewport,
} from './camera';
import { screenToWorld } from './coordinateTransforms';
import { hitTestNode, nodesInRect } from './hitTesting';
import { nodeRectAt, GraphRenderer } from './renderer';
import { SpatialGrid } from './spatialIndex';
import { textLayoutCache } from './textLayout';
import { MIN_EDIT_ZOOM } from '../graph/metrics';

const PULSE_DURATION = 1100;
const TOAST_DURATION = 4200;
/** Screen-pixel gap between a floating control and the edge it hangs from. */
const FLOATING_GAP = 10;
/** Keeps a clamped floating control this far inside the viewport. */
const FLOATING_INSET = 8;
/** How far outside the viewport a floating control's owner may sit before it is hidden. */
const FLOATING_MARGIN = 72;
/** Idle delay before an in-progress edit is written into the document. */
export const DRAFT_COMMIT_DELAY = 450;

export interface BranchActionState {
  nodeId: NodeId;
  text: string;
  start: number;
  end: number;
  /** World-space anchor the floating button hangs from. */
  anchor: Point;
}

export type PendingAction =
  | { kind: 'delete'; previews: DeletionPreview[]; nodeCount: number; characterCount: number }
  | { kind: 'reset'; nodeCount: number; characterCount: number };

export interface ToastState {
  id: number;
  message: string;
  tone: 'info' | 'success' | 'error';
}

export interface EngineSnapshot {
  editingNodeId: NodeId | null;
  selectedIds: readonly NodeId[];
  hoveredId: NodeId | null;
  branchAction: BranchActionState | null;
  pendingAction: PendingAction | null;
  toast: ToastState | null;
  zoomPercent: number;
  cursor: string;
  nodeCount: number;
}

export type PointerMode = 'idle' | 'pan' | 'drag-node' | 'marquee';

interface PanGesture {
  kind: 'pan';
  startScreen: Point;
  startCamera: Camera;
}

interface DragGesture {
  kind: 'drag-node';
  nodeId: NodeId;
  startWorld: Point;
  origins: Map<NodeId, Point>;
  moved: boolean;
}

interface MarqueeGesture {
  kind: 'marquee';
  startWorld: Point;
  additive: boolean;
  baseSelection: NodeId[];
}

type Gesture = PanGesture | DragGesture | MarqueeGesture | null;

export interface MountTargets {
  canvas: HTMLCanvasElement;
  overlayLayer: HTMLElement;
  screenLayer: HTMLElement;
}

export class CanvasEngine {
  private readonly controller: GraphController;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private overlayLayer: HTMLElement | null = null;

  private readonly renderer = new GraphRenderer();
  private index = new SpatialGrid();

  doc: GraphDocument;
  camera: Camera = { x: -320, y: -180, zoom: 1 };
  viewport: Viewport = { width: 1200, height: 800 };
  private dpr = 1;

  private gesture: Gesture = null;
  private draftPositions = new Map<NodeId, Point>();
  private selected = new Set<NodeId>();
  private hoveredId: NodeId | null = null;
  private editingId: NodeId | null = null;
  private branchAction: BranchActionState | null = null;
  /** Reads the live selection from the open editor; registered by NoteWindow. */
  private selectionResolver: (() => BranchActionState | null) | null = null;
  /** The range the last branch consumed, so one selection cannot branch twice. */
  private consumedSelection: { nodeId: NodeId; start: number; end: number } | null = null;
  private pendingAction: PendingAction | null = null;
  private toast: ToastState | null = null;
  private marquee: Rect | null = null;
  private pulse: { ids: Set<NodeId>; startedAt: number } | null = null;

  /** Uncommitted editor text; committed to the document on idle/blur/exit. */
  private draft: { nodeId: NodeId; content: string } | null = null;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;

  private rafId: number | null = null;
  private continuous = false;
  private needsDraw = true;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private zoomEmitAt = 0;
  private lastEmittedZoomPercent = 100;

  private listeners = new Set<() => void>();
  private snapshot: EngineSnapshot;

  private editingEl: HTMLElement | null = null;
  private toolbarEl: HTMLElement | null = null;
  private branchEl: HTMLElement | null = null;
  /** Measured size of the branch action, reported by the component itself. */
  private branchSize: { width: number; height: number } | null = null;

  constructor(controller: GraphController) {
    this.controller = controller;
    this.doc = controller.getDocument();
    this.snapshot = this.buildSnapshot();
    this.rebuildIndex();
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                         */
  /* ---------------------------------------------------------------- */

  mount(targets: MountTargets): void {
    this.canvas = targets.canvas;
    this.ctx = targets.canvas.getContext('2d', { alpha: false });
    this.overlayLayer = targets.overlayLayer;
    this.scheduleDraw();
  }

  destroy(): void {
    if (this.rafId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
    if (this.draftTimer) clearTimeout(this.draftTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.listeners.clear();
    this.canvas = null;
    this.ctx = null;
  }

  resize(width: number, height: number, dpr: number): void {
    this.viewport = { width, height };
    this.dpr = dpr;
    if (this.canvas) {
      const pixelWidth = Math.max(1, Math.round(width * dpr));
      const pixelHeight = Math.max(1, Math.round(height * dpr));
      if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
      if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
    }
    this.scheduleDraw();
  }

  /* ---------------------------------------------------------------- */
  /* Subscriptions                                                     */
  /* ---------------------------------------------------------------- */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): EngineSnapshot => this.snapshot;

  private buildSnapshot(): EngineSnapshot {
    return {
      editingNodeId: this.editingId,
      selectedIds: [...this.selected],
      hoveredId: this.hoveredId,
      branchAction: this.branchAction,
      pendingAction: this.pendingAction,
      toast: this.toast,
      zoomPercent: Math.round(this.camera.zoom * 100),
      cursor: this.cursorForState(),
      nodeCount: Object.keys(this.doc.nodes).length,
    };
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  /** Emits at most ~10×/s while zooming so the readout stays live without churn. */
  private emitZoomThrottled(now: number): void {
    const percent = Math.round(this.camera.zoom * 100);
    if (percent === this.lastEmittedZoomPercent) return;
    if (now - this.zoomEmitAt < 90) return;
    this.zoomEmitAt = now;
    this.lastEmittedZoomPercent = percent;
    this.emit();
  }

  /* ---------------------------------------------------------------- */
  /* Document sync                                                     */
  /* ---------------------------------------------------------------- */

  setDocument(doc: GraphDocument, change: ChangeHint): void {
    this.doc = doc;

    if (change.full) {
      this.rebuildIndex();
    } else {
      for (const id of change.removed) {
        this.index.remove(id);
        this.draftPositions.delete(id);
        textLayoutCache.invalidate(`node:${id}`);
      }
      for (const id of [...change.added, ...change.ids]) {
        const node = doc.nodes[id];
        if (!node) continue;
        const position = this.draftPositions.get(id) ?? node.position;
        this.index.update(id, nodeRectAt(position, node.collapsed));
      }
    }

    // Drop UI state that points at windows which no longer exist.
    if (this.editingId && !doc.nodes[this.editingId]) this.stopEditing({ commit: false });
    if (this.hoveredId && !doc.nodes[this.hoveredId]) this.hoveredId = null;
    if (this.branchAction && !doc.nodes[this.branchAction.nodeId]) this.branchAction = null;
    let selectionChanged = false;
    for (const id of [...this.selected]) {
      if (!doc.nodes[id]) {
        this.selected.delete(id);
        selectionChanged = true;
      }
    }

    if (change.full || selectionChanged || change.added.length > 0 || change.removed.length > 0) {
      this.emit();
    }
    this.scheduleDraw();
  }

  private rebuildIndex(): void {
    this.index.rebuild(
      Object.values(this.doc.nodes).map(
        (node) => [node.id, nodeRectAt(node.position, node.collapsed)] as const,
      ),
    );
  }

  getIndex(): SpatialGrid {
    return this.index;
  }

  /* ---------------------------------------------------------------- */
  /* Render loop                                                       */
  /* ---------------------------------------------------------------- */

  scheduleDraw(): void {
    this.needsDraw = true;
    if (this.rafId !== null) return;
    if (typeof requestAnimationFrame !== 'function') {
      this.drawNow();
      return;
    }
    this.rafId = requestAnimationFrame(this.frame);
  }

  private frame = (): void => {
    this.rafId = null;
    if (this.needsDraw) this.drawNow();
    const now = performance.now();
    const pulsing = this.pulse !== null && now - this.pulse.startedAt < PULSE_DURATION;
    if (pulsing) {
      this.scheduleDraw();
    } else if (this.pulse) {
      this.pulse = null;
      this.scheduleDraw();
    }
    if (this.continuous) this.scheduleDraw();
  };

  private drawNow(): void {
    const ctx = this.ctx;
    if (!ctx || !this.canvas) return;
    this.needsDraw = false;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.syncOverlays();

    this.renderer.draw(ctx, {
      doc: this.doc,
      camera: this.camera,
      viewport: this.viewport,
      draftPositions: this.draftPositions,
      selectedIds: this.selected,
      hoveredId: this.hoveredId,
      editingNodeId: this.editingId,
      dragSourceId: this.gesture?.kind === 'drag-node' ? this.gesture.nodeId : null,
      marquee: this.marquee,
      index: this.index,
      forceVisible: this.draftPositions.size > 0 ? new Set(this.draftPositions.keys()) : undefined,
      pulse: this.pulse,
      now: performance.now(),
    });
  }

  /** Positions the DOM overlays from the camera; called every frame. */
  private syncOverlays(): void {
    const { camera } = this;
    if (this.overlayLayer) {
      this.overlayLayer.style.transform = `translate(${-camera.x * camera.zoom}px, ${-camera.y * camera.zoom}px) scale(${camera.zoom})`;
    }

    if (this.editingEl && this.editingId) {
      const node = this.doc.nodes[this.editingId];
      if (node) {
        const position = this.draftPositions.get(node.id) ?? node.position;
        this.editingEl.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
      }
    }

    this.positionFloating(this.toolbarEl, this.toolbarAnchor(), 'above', { gap: FLOATING_GAP });
    this.positionFloating(this.branchEl, this.branchAction?.anchor ?? null, 'above', {
      gap: FLOATING_GAP,
      frame: this.branchAction ? this.nodeWorldRect(this.branchAction.nodeId) : null,
      size: this.branchSize,
    });
  }

  private toolbarAnchor(): Point | null {
    const id = this.editingId ?? [...this.selected][0];
    if (!id || this.selected.size > 1) return null;
    const node = this.doc.nodes[id];
    if (!node) return null;
    const position = this.draftPositions.get(id) ?? node.position;
    const size = nodeSize(node.collapsed);
    return { x: position.x + size.width / 2, y: position.y };
  }

  /** World rect of a window, including any position an in-flight drag is showing. */
  private nodeWorldRect(id: NodeId): Rect | null {
    const node = this.doc.nodes[id];
    if (!node) return null;
    const position = this.draftPositions.get(id) ?? node.position;
    const size = nodeSize(node.collapsed);
    return { x: position.x, y: position.y, width: size.width, height: size.height };
  }

  /**
   * Places a screen-layer control at a world anchor, above it.
   *
   * `gap` is measured in *screen* pixels, not world units: these controls are a
   * fixed size on screen, so their distance from the window they belong to has
   * to hold at every zoom level.
   *
   * `frame` is the owning window's world rect. It changes two things: visibility
   * follows the window rather than the anchor point (a control hanging off the
   * top edge must stay reachable while the window's header is scrolled out of
   * view), and the control is clamped over the window horizontally and into the
   * viewport vertically.
   */
  private positionFloating(
    el: HTMLElement | null,
    worldAnchor: Point | null,
    placement: 'above',
    options: { gap?: number; frame?: Rect | null; size?: { width: number; height: number } | null } = {},
  ): void {
    if (!el) return;
    if (!worldAnchor) {
      el.style.display = 'none';
      return;
    }

    const { camera, viewport } = this;
    const frame = options.frame ?? null;
    const size = options.size ?? null;
    const margin = FLOATING_MARGIN;

    let screenX = (worldAnchor.x - camera.x) * camera.zoom;
    let screenY = (worldAnchor.y - camera.y) * camera.zoom;

    const windowVisible = frame
      ? this.rectOnScreen(frame, margin)
      : screenX > -margin &&
        screenX < viewport.width + margin &&
        screenY > -margin &&
        screenY < viewport.height + margin;
    if (!windowVisible) {
      el.style.display = 'none';
      return;
    }

    el.style.display = '';
    if (options.gap) screenY -= options.gap;

    if (size && size.width > 0 && size.height > 0) {
      const halfWidth = size.width / 2;
      if (frame) {
        const frameLeft = (frame.x - camera.x) * camera.zoom;
        const frameRight = frameLeft + frame.width * camera.zoom;
        // Stay over the window when it is wide enough for the control; a window
        // zoomed out past the control's width falls back to its centre.
        const minCentre = frameLeft + halfWidth;
        const maxCentre = frameRight - halfWidth;
        screenX =
          minCentre > maxCentre
            ? (frameLeft + frameRight) / 2
            : Math.min(Math.max(screenX, minCentre), maxCentre);
      }
      const minX = FLOATING_INSET + halfWidth;
      const maxX = viewport.width - FLOATING_INSET - halfWidth;
      screenX = minX > maxX ? viewport.width / 2 : Math.min(Math.max(screenX, minX), maxX);
      // 'above' places the control's bottom edge on the anchor.
      const minY = FLOATING_INSET + size.height;
      const maxY = viewport.height - FLOATING_INSET;
      if (minY <= maxY) screenY = Math.min(Math.max(screenY, minY), maxY);
    }

    const offset = placement === 'above' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)';
    el.style.transform = `translate3d(${Math.round(screenX)}px, ${Math.round(screenY)}px, 0) ${offset}`;
  }

  /** Whether a world rect projects anywhere near the viewport. */
  private rectOnScreen(rect: Rect, margin: number): boolean {
    const left = (rect.x - this.camera.x) * this.camera.zoom;
    const top = (rect.y - this.camera.y) * this.camera.zoom;
    const right = left + rect.width * this.camera.zoom;
    const bottom = top + rect.height * this.camera.zoom;
    return (
      right > -margin &&
      left < this.viewport.width + margin &&
      bottom > -margin &&
      top < this.viewport.height + margin
    );
  }

  registerEditingElement(el: HTMLElement | null): void {
    this.editingEl = el;
    this.scheduleDraw();
  }

  registerToolbarElement(el: HTMLElement | null): void {
    this.toolbarEl = el;
    this.scheduleDraw();
  }

  registerBranchElement(el: HTMLElement | null): void {
    this.branchEl = el;
    this.scheduleDraw();
  }

  /**
   * The floating action reports its own size (measured by React after a commit,
   * where a layout read is free) so the engine can clamp it without forcing a
   * synchronous layout in the middle of a frame.
   */
  setBranchSize(size: { width: number; height: number }): void {
    if (size.width <= 0 || size.height <= 0) return;
    const current = this.branchSize;
    if (current && current.width === size.width && current.height === size.height) return;
    this.branchSize = { width: size.width, height: size.height };
    this.scheduleDraw();
  }

  /* ---------------------------------------------------------------- */
  /* Camera                                                            */
  /* ---------------------------------------------------------------- */

  screenToWorld(point: Point): Point {
    return screenToWorld(this.camera, point);
  }

  worldToScreen(point: Point): Point {
    return {
      x: (point.x - this.camera.x) * this.camera.zoom,
      y: (point.y - this.camera.y) * this.camera.zoom,
    };
  }

  viewportCenterScreen(): Point {
    return { x: this.viewport.width / 2, y: this.viewport.height / 2 };
  }

  zoomBy(factor: number, screenPoint: Point = this.viewportCenterScreen()): void {
    this.camera = zoomAround(this.camera, screenPoint, factor);
    this.afterCameraChange();
  }

  setZoom(zoom: number, screenPoint: Point = this.viewportCenterScreen()): void {
    this.camera = zoomToAround(this.camera, screenPoint, zoom);
    this.afterCameraChange();
  }

  resetZoom(): void {
    this.setZoom(1);
  }

  panByScreen(dx: number, dy: number): void {
    this.camera = panCamera(this.camera, dx, dy);
    this.afterCameraChange();
  }

  fitToView(ids?: Iterable<NodeId>): void {
    const nodes = ids
      ? [...ids].map((id) => this.doc.nodes[id]).filter((node): node is NoteNode => Boolean(node))
      : Object.values(this.doc.nodes);
    const bounds = boundsOf(nodes);
    if (!bounds) return;
    this.camera = fitToRect(bounds, this.viewport, 90);
    this.afterCameraChange();
  }

  /** Moves the camera so a world point sits at the centre of the viewport. */
  centerOn(worldX: number, worldY: number): void {
    const { zoom } = this.camera;
    this.camera = {
      zoom,
      x: worldX - this.viewport.width / (2 * zoom),
      y: worldY - this.viewport.height / (2 * zoom),
    };
    this.afterCameraChange();
  }

  /** Zooms to a comfortable editing level centred on a node. */
  focusNode(id: NodeId, zoom = 1): void {
    const node = this.doc.nodes[id];
    if (!node) return;
    const rect = getNodeRect(node);
    this.camera = centerOnRect(rect, this.viewport, { zoom, padding: 120 });
    this.afterCameraChange();
  }

  revealNode(id: NodeId): void {
    const node = this.doc.nodes[id];
    if (!node) return;
    this.camera = ensureRectVisible(this.camera, this.viewport, getNodeRect(node), 90);
    this.afterCameraChange();
  }

  private afterCameraChange(): void {
    this.emitZoomThrottled(performance.now());
    // Editing at very small zoom is unusable; close the editor rather than
    // leaving a sub-pixel textarea on screen.
    if (this.editingId && this.camera.zoom < MIN_EDIT_ZOOM) {
      this.stopEditing({ commit: true });
    }
    if (this.branchAction) this.emit();
    this.scheduleDraw();
  }

  /* ---------------------------------------------------------------- */
  /* Hit testing / hover                                               */
  /* ---------------------------------------------------------------- */

  hitTest(screenPoint: Point): NodeId | null {
    const world = this.screenToWorld(screenPoint);
    const hit = hitTestNode(this.doc, this.index, world, this.draftPositions);
    return hit?.nodeId ?? null;
  }

  private updateHover(screenPoint: Point): void {
    if (this.gesture) return;
    const next = this.hitTest(screenPoint);
    if (next === this.hoveredId) return;
    this.hoveredId = next;
    this.emit();
    this.scheduleDraw();
  }

  /* ---------------------------------------------------------------- */
  /* Gestures                                                          */
  /* ---------------------------------------------------------------- */

  pointerDown(
    screen: Point,
    options: { button: number; panModifier: boolean; additive: boolean; editingLocked: boolean },
  ): void {
    const world = this.screenToWorld(screen);

    // Middle mouse or space-drag always pans, even over a window.
    if (options.button === 1 || options.panModifier) {
      this.gesture = { kind: 'pan', startScreen: screen, startCamera: this.camera };
      this.continuous = true;
      this.emit();
      return;
    }
    if (options.button !== 0) return;

    if (options.editingLocked) {
      // Clicking inside the open editor must never start a canvas gesture.
      return;
    }

    const hitId = this.hitTest(screen);
    if (!hitId) {
      if (!options.additive) this.setSelection([]);
      this.gesture = {
        kind: 'marquee',
        startWorld: world,
        additive: options.additive,
        baseSelection: [...this.selected],
      };
      this.continuous = true;
      this.emit();
      return;
    }

    const node = this.doc.nodes[hitId];
    if (!node) return;

    if (options.additive) {
      this.toggleSelection(hitId);
    } else if (!this.selected.has(hitId)) {
      this.setSelection([hitId]);
    }

    if (this.editingId && this.editingId !== hitId) this.stopEditing({ commit: true });

    const origins = new Map<NodeId, Point>();
    for (const id of this.selected) {
      const selected = this.doc.nodes[id];
      if (selected) origins.set(id, { ...selected.position });
    }
    if (origins.size === 0) origins.set(hitId, { ...node.position });

    this.gesture = { kind: 'drag-node', nodeId: hitId, startWorld: world, origins, moved: false };
    this.continuous = true;
    this.emit();
  }

  pointerMove(screen: Point): void {
    const gesture = this.gesture;
    if (!gesture) {
      this.updateHover(screen);
      return;
    }

    if (gesture.kind === 'pan') {
      const dx = screen.x - gesture.startScreen.x;
      const dy = screen.y - gesture.startScreen.y;
      const camera = gesture.startCamera;
      this.camera = {
        zoom: camera.zoom,
        x: camera.x - dx / camera.zoom,
        y: camera.y - dy / camera.zoom,
      };
      this.emitZoomThrottled(performance.now());
      this.scheduleDraw();
      return;
    }

    if (gesture.kind === 'drag-node') {
      const world = this.screenToWorld(screen);
      const dx = world.x - gesture.startWorld.x;
      const dy = world.y - gesture.startWorld.y;
      if (!gesture.moved && Math.abs(dx) + Math.abs(dy) < 1.5) return;
      gesture.moved = true;
      for (const [id, origin] of gesture.origins) {
        this.draftPositions.set(id, { x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) });
      }
      this.scheduleDraw();
      return;
    }

    if (gesture.kind === 'marquee') {
      const world = this.screenToWorld(screen);
      const rect: Rect = {
        x: Math.min(gesture.startWorld.x, world.x),
        y: Math.min(gesture.startWorld.y, world.y),
        width: Math.abs(world.x - gesture.startWorld.x),
        height: Math.abs(world.y - gesture.startWorld.y),
      };
      this.marquee = rect;
      const hits = nodesInRect(this.doc, this.index, rect, this.draftPositions);
      const next = gesture.additive ? new Set([...gesture.baseSelection, ...hits]) : new Set(hits);
      if (!sameSet(next, this.selected)) {
        this.selected = next;
        this.emit();
      }
      this.scheduleDraw();
    }
  }

  pointerUp(): void {
    const gesture = this.gesture;
    this.gesture = null;
    this.continuous = false;
    this.marquee = null;

    if (gesture?.kind === 'drag-node' && gesture.moved && this.draftPositions.size > 0) {
      const positions: Record<NodeId, Point> = {};
      for (const [id, position] of this.draftPositions) positions[id] = position;
      this.draftPositions.clear();
      this.controller.moveNodes(positions);
      this.rebuildIndex();
    } else {
      this.draftPositions.clear();
    }

    this.emit();
    this.scheduleDraw();
  }

  cancelGesture(): void {
    if (!this.gesture) return;
    this.gesture = null;
    this.continuous = false;
    this.marquee = null;
    this.draftPositions.clear();
    this.emit();
    this.scheduleDraw();
  }

  isGestureActive(): boolean {
    return this.gesture !== null;
  }

  /** Kept for the UI's read-only queries. */
  getNode(id: NodeId): NoteNode | undefined {
    return getNode(this.doc, id);
  }

  getSubtreeCharCount(id: NodeId): number {
    return getSubtreeCharCount(this.doc, id);
  }

  private cursorForState(): string {
    if (this.gesture?.kind === 'pan') return 'grabbing';
    if (this.gesture?.kind === 'drag-node') return 'grabbing';
    if (this.gesture?.kind === 'marquee') return 'crosshair';
    if (this.hoveredId) return 'grab';
    return 'default';
  }

  /** Recomputes and emits the cursor without a full state change. */
  refreshCursor(): void {
    const cursor = this.cursorForState();
    if (cursor !== this.snapshot.cursor) this.emit();
  }

  /* ---------------------------------------------------------------- */
  /* Wheel                                                             */
  /* ---------------------------------------------------------------- */

  wheel(deltaX: number, deltaY: number, screen: Point, zoomIntent: boolean): void {
    if (zoomIntent) {
      // Trackpad pinch and ctrl/cmd+wheel both land here.
      const factor = Math.exp(-deltaY * 0.0035);
      this.camera = zoomAround(this.camera, screen, factor);
      this.afterCameraChange();
      return;
    }
    const scale = 1;
    this.camera = panCamera(this.camera, -deltaX * scale, -deltaY * scale);
    this.afterCameraChange();
  }

  /* ---------------------------------------------------------------- */
  /* Selection                                                         */
  /* ---------------------------------------------------------------- */

  setSelection(ids: Iterable<NodeId>): void {
    const next = new Set(ids);
    if (sameSet(next, this.selected)) return;
    this.selected = next;
    if (this.editingId && !this.selected.has(this.editingId) && this.selected.size > 0) {
      this.stopEditing({ commit: true });
    }
    this.emit();
    this.scheduleDraw();
  }

  toggleSelection(id: NodeId): void {
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.emit();
    this.scheduleDraw();
  }

  clearSelection(): void {
    this.setSelection([]);
  }

  selectAll(): void {
    this.setSelection(Object.keys(this.doc.nodes));
  }

  getSelectedIds(): NodeId[] {
    return [...this.selected];
  }

  /* ---------------------------------------------------------------- */
  /* Editing                                                           */
  /* ---------------------------------------------------------------- */

  startEditing(id: NodeId): void {
    if (!this.doc.nodes[id]) return;
    if (this.camera.zoom < MIN_EDIT_ZOOM) this.setZoom(Math.max(MIN_EDIT_ZOOM, 0.85));
    if (this.editingId === id) return;
    if (this.editingId) this.stopEditing({ commit: true });
    this.flushDraft();
    this.editingId = id;
    this.selected = new Set([id]);
    this.branchAction = null;
    this.consumedSelection = null;
    this.emit();
    this.scheduleDraw();
  }

  stopEditing(options: { commit?: boolean } = {}): void {
    if (options.commit !== false) this.flushDraft({ immediate: true });
    if (!this.editingId) return;
    this.editingId = null;
    this.branchAction = null;
    // A new editor session starts from a clean slate.
    this.consumedSelection = null;
    this.emit();
    this.scheduleDraw();
  }

  getEditingId(): NodeId | null {
    return this.editingId;
  }

  /** Text currently held in the open editor but not yet in the document. */
  getDraft(nodeId: NodeId): string | null {
    return this.draft && this.draft.nodeId === nodeId ? this.draft.content : null;
  }

  setDraft(nodeId: NodeId, content: string): void {
    this.draft = { nodeId, content };
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => this.flushDraft(), DRAFT_COMMIT_DELAY);
  }

  /** Writes the open editor's text into the document. Safe to call often. */
  flushDraft(options: { immediate?: boolean } = {}): void {
    if (this.draftTimer) {
      clearTimeout(this.draftTimer);
      this.draftTimer = null;
    }
    const draft = this.draft;
    this.draft = null;
    if (!draft) return;
    const node = this.doc.nodes[draft.nodeId];
    if (!node || node.content === draft.content) return;
    this.controller.updateContent(draft.nodeId, draft.content);
    void options;
  }

  /* ---------------------------------------------------------------- */
  /* Branching                                                         */
  /* ---------------------------------------------------------------- */

  canBranch(nodeId: NodeId): { allowed: boolean; message?: string } {
    const node = this.doc.nodes[nodeId];
    if (!node) return { allowed: false, message: 'That note no longer exists.' };
    const count = getChildCount(this.doc, nodeId);
    if (count >= MAX_CHILDREN_PER_NODE) {
      return {
        allowed: false,
        message: `Branch limit reached — this note already has ${MAX_CHILDREN_PER_NODE} branches. Delete one to create another.`,
      };
    }
    return { allowed: true };
  }

  /**
   * The open editor reads its own selection; registered by the note window it
   * belongs to, and cleared when that window closes.
   */
  registerSelectionResolver(resolver: (() => BranchActionState | null) | null): void {
    this.selectionResolver = resolver;
  }

  /** Clears the floating action only if it belongs to `nodeId` (avoids a
   *  closing window dismissing a newer window's action). */
  clearBranchActionFor(nodeId: NodeId): void {
    if (this.branchAction?.nodeId !== nodeId) return;
    this.branchAction = null;
    this.emit();
    this.scheduleDraw();
  }

  setBranchAction(state: BranchActionState | null): void {
    // Selecting anything else retires the claim the last branch had on its range,
    // so the same text can be branched again once the user selects it afresh.
    if (state && this.consumedSelection && !this.isConsumed(state)) this.consumedSelection = null;
    const same =
      (state === null && this.branchAction === null) ||
      (state !== null &&
        this.branchAction !== null &&
        state.nodeId === this.branchAction.nodeId &&
        state.start === this.branchAction.start &&
        state.end === this.branchAction.end &&
        state.text === this.branchAction.text);
    if (same) {
      if (state) this.branchAction = state;
      return;
    }
    this.branchAction = state;
    this.emit();
    this.scheduleDraw();
  }

  /** Creates a child window from the current text selection. */
  createBranchFromSelection(): NodeId | null {
    const action = this.branchActionForClick();
    if (!action) return null;
    this.flushDraft({ immediate: true });
    const source = this.doc.nodes[action.nodeId];
    if (!source) return null;
    // Guards against a double click creating two branches from the same selection.
    this.branchAction = null;

    const reference: SourceReference = {
      sourceNodeId: source.id,
      selectedTextSnapshot: action.text,
      startOffset: action.start,
      endOffset: action.end,
      sourceContentVersion: source.contentVersion,
    };

    const created = this.createBranch(action.nodeId, {
      sourceReference: reference,
      title: deriveTitleFromSelection(action.text),
    });
    // Recorded after the branch, because creating it moves the editor to the new
    // window — a session change that retires any earlier claim. A failed attempt
    // records nothing, so the same selection can simply be tried again.
    this.consumedSelection = created
      ? { nodeId: action.nodeId, start: action.start, end: action.end }
      : null;
    return created;
  }

  /**
   * The selection a click on "Create branch" should act on.
   *
   * `branchAction` is *derived* state — it exists to show the floating button,
   * and it is dropped whenever the editor reports that nothing is selected. Some
   * of those reports are not the user's doing: a caret placed by the browser, by
   * a delayed focus frame, or by a value the editor itself rewrote can collapse a
   * selection the user still sees highlighted. Asking the open editor for the
   * selection again at click time means the button acts on what is actually
   * selected, which is what the user is looking at.
   */
  private branchActionForClick(): BranchActionState | null {
    const cached = this.branchAction;
    if (cached && !this.isConsumed(cached)) return cached;
    const live = this.selectionResolver?.() ?? null;
    if (live && !this.isConsumed(live)) return live;
    return null;
  }

  private isConsumed(action: BranchActionState): boolean {
    const consumed = this.consumedSelection;
    return Boolean(
      consumed &&
        consumed.nodeId === action.nodeId &&
        consumed.start === action.start &&
        consumed.end === action.end,
    );
  }

  /** Creates an empty child window from a window's own "branch" control. */
  createBranchFromNode(nodeId: NodeId): NodeId | null {
    this.flushDraft({ immediate: true });
    return this.createBranch(nodeId, { sourceReference: null, title: '' });
  }

  private createBranch(
    parentId: NodeId,
    options: { sourceReference: SourceReference | null; title: string },
  ): NodeId | null {
    const permission = this.canBranch(parentId);
    if (!permission.allowed) {
      this.notify(permission.message ?? 'Cannot create another branch here.', 'error');
      return null;
    }

    const parent = this.doc.nodes[parentId];
    if (!parent) return null;
    const position = resolveChildPosition(
      parent,
      getChildCount(this.doc, parentId),
      (rect) => this.index.isOccupied(rect),
    );

    const result = this.controller.addBranch(parentId, {
      position,
      title: options.title,
      content: '',
      sourceReference: options.sourceReference,
    });

    if (!result.ok) {
      this.notify(result.message, 'error');
      return null;
    }

    const node = result.value.node;
    this.pulse = { ids: new Set([node.id]), startedAt: performance.now() };
    this.selected = new Set([node.id]);
    this.revealNode(node.id);
    this.emit();
    this.startEditing(node.id);
    this.scheduleDraw();
    return node.id;
  }

  /* ---------------------------------------------------------------- */
  /* Deletion                                                          */
  /* ---------------------------------------------------------------- */

  requestDelete(ids: NodeId[]): void {
    if (ids.length === 0) return;
    this.flushDraft({ immediate: true });

    // Only the topmost node of any selected subtree needs deleting.
    const set = new Set(ids);
    const roots = ids.filter((id) => {
      let parent = this.doc.nodes[id]?.parentId ?? null;
      while (parent) {
        if (set.has(parent)) return false;
        parent = this.doc.nodes[parent]?.parentId ?? null;
      }
      return true;
    });

    const previews: DeletionPreview[] = [];
    for (const id of roots) {
      if (id === this.doc.rootNodeId) {
        this.notify('The root note cannot be deleted. Use “Reset canvas” to start over.', 'error');
        return;
      }
      const preview = previewDeletion(this.doc, id);
      if (preview) previews.push(preview);
    }
    if (previews.length === 0) return;

    const nodeIds = new Set<NodeId>();
    let characterCount = 0;
    for (const preview of previews) {
      for (const id of preview.nodeIds) nodeIds.add(id);
      characterCount += preview.characterCount;
    }

    if (nodeIds.size === 1 && characterCount < 120) {
      // Nothing substantial would be lost — delete without an interruption.
      this.performDelete(previews);
      return;
    }

    this.pendingAction = { kind: 'delete', previews, nodeCount: nodeIds.size, characterCount };
    this.emit();
  }

  requestReset(): void {
    this.pendingAction = {
      kind: 'reset',
      nodeCount: Object.keys(this.doc.nodes).length,
      characterCount: Object.values(this.doc.nodes).reduce((sum, node) => sum + node.content.length, 0),
    };
    this.emit();
  }

  cancelPendingAction(): void {
    this.pendingAction = null;
    this.emit();
  }

  confirmPendingAction(): void {
    const action = this.pendingAction;
    this.pendingAction = null;
    if (!action) return;

    if (action.kind === 'reset') {
      this.stopEditing({ commit: false });
      this.controller.resetCanvas();
      const rootId = this.controller.getDocument().rootNodeId;
      this.selected = new Set([rootId]);
      this.camera = centerOnRect(getNodeRect(this.controller.getDocument().nodes[rootId]!), this.viewport, {
        zoom: 1,
      });
      this.rebuildIndex();
      this.notify('Canvas reset', 'info');
      this.emit();
      this.scheduleDraw();
      return;
    }

    this.performDelete(action.previews);
  }

  private performDelete(previews: DeletionPreview[]): void {
    if (this.editingId && previews.some((p) => p.nodeIds.includes(this.editingId as NodeId))) {
      this.stopEditing({ commit: false });
    }
    let focusTarget: NodeId | null = null;
    for (const preview of previews) {
      const result = this.controller.deleteSubtree(preview.nodeId);
      if (result.ok) focusTarget = result.value.parentId;
    }
    this.selected = focusTarget ? new Set([focusTarget]) : new Set();
    for (const preview of previews) {
      for (const id of preview.nodeIds) {
        this.draftPositions.delete(id);
        this.index.remove(id);
      }
    }
    this.emit();
    this.scheduleDraw();
  }

  /* ---------------------------------------------------------------- */
  /* Collapse / expand                                                */
  /* ---------------------------------------------------------------- */

  toggleCollapsed(id: NodeId): void {
    const node = this.doc.nodes[id];
    if (!node) return;
    if (this.editingId === id && !node.collapsed) this.stopEditing({ commit: true });
    this.controller.setCollapsed(id, !node.collapsed);
  }

  /* ---------------------------------------------------------------- */
  /* History                                                           */
  /* ---------------------------------------------------------------- */

  /** Undo, then bring the affected window back into view. */
  undo(): void {
    this.flushDraft({ immediate: true });
    const result = this.controller.undo();
    if (!result) {
      this.notify('Nothing left to undo', 'info');
      return;
    }
    this.afterHistoryChange(result.focusNodeId, result.label ? `Undid: ${result.label}` : 'Undo');
  }

  redo(): void {
    this.flushDraft({ immediate: true });
    const result = this.controller.redo();
    if (!result) {
      this.notify('Nothing left to redo', 'info');
      return;
    }
    this.afterHistoryChange(result.focusNodeId, result.label ? `Redid: ${result.label}` : 'Redo');
  }

  private afterHistoryChange(focusNodeId: NodeId | null, message: string): void {
    this.rebuildIndex();
    if (this.editingId && !this.doc.nodes[this.editingId]) this.stopEditing({ commit: false });
    if (focusNodeId && this.doc.nodes[focusNodeId]) {
      this.selected = new Set([focusNodeId]);
      this.revealNode(focusNodeId);
    }
    const history = this.controller.getState().history;
    this.emit();
    this.scheduleDraw();
    void history;
    void message;
  }

  /** Persists immediately (⌘S). */
  async flushSave(): Promise<void> {
    await this.controller.flushPendingWrites();
    this.notify('Saved', 'success');
  }

  /* ---------------------------------------------------------------- */
  /* Pan modifier (space bar)                                          */
  /* ---------------------------------------------------------------- */

  private panModifierSetter: ((held: boolean) => void) | null = null;

  setPanModifierHook(setter: ((held: boolean) => void) | null): void {
    this.panModifierSetter = setter;
  }

  setPanModifier(held: boolean): void {
    this.panModifierSetter?.(held);
  }

  /* ---------------------------------------------------------------- */
  /* Notifications                                                     */
  /* ---------------------------------------------------------------- */

  notify(message: string, tone: ToastState['tone'] = 'info'): void {
    this.toast = { id: Date.now() + Math.random(), message, tone };
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast = null;
      this.emit();
    }, TOAST_DURATION);
    this.emit();
  }

  dismissToast(): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toast = null;
    this.emit();
  }
}

function sameSet(a: Set<NodeId>, b: Set<NodeId>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

export function deriveTitleFromSelection(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim().length > 0) ?? '';
  return truncate(firstLine.trim(), 60);
}
