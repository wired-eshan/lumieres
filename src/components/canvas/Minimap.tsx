/**
 * Navigation aid for large graphs.
 *
 * Draws the whole graph at a glance plus the current viewport rectangle, and
 * supports click/drag to move the camera. It redraws on a slow interval rather
 * than per frame: it is a coarse overview, so 6–7 fps is indistinguishable from
 * real-time and costs nothing next to the main render loop.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useEngine } from '../../app/EngineContext';
import { useGraphStore } from '../../graph/graphStore';
import { boundsOf } from '../../graph/layout';
import { nodeSize } from '../../graph/metrics';
import { visibleWorldRect } from '../../canvas/coordinateTransforms';
import { palette } from '../../canvas/theme';

const WIDTH = 192;
const HEIGHT = 136;
const PADDING = 10;

export function Minimap(): ReactNode {
  const engine = useEngine();
  const doc = useGraphStore((state) => state.doc);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [collapsed, setCollapsed] = useState(false);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(WIDTH * dpr);
    const pixelHeight = Math.round(HEIGHT * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    const nodes = Object.values(doc.nodes);
    if (nodes.length === 0) return;

    const bounds = boundsOf(nodes);
    if (!bounds) return;

    const view = visibleWorldRect(engine.camera, engine.viewport);
    const minX = Math.min(bounds.x, view.x);
    const minY = Math.min(bounds.y, view.y);
    const maxX = Math.max(bounds.x + bounds.width, view.x + view.width);
    const maxY = Math.max(bounds.y + bounds.height, view.y + view.height);
    const worldWidth = Math.max(1, maxX - minX);
    const worldHeight = Math.max(1, maxY - minY);

    const scale = Math.min((WIDTH - PADDING * 2) / worldWidth, (HEIGHT - PADDING * 2) / worldHeight);
    const offsetX = PADDING + (WIDTH - PADDING * 2 - worldWidth * scale) / 2;
    const offsetY = PADDING + (HEIGHT - PADDING * 2 - worldHeight * scale) / 2;

    const project = (x: number, y: number) => ({
      x: offsetX + (x - minX) * scale,
      y: offsetY + (y - minY) * scale,
    });

    // Edges first, so windows sit on top of them.
    ctx.strokeStyle = palette.edge;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const node of nodes) {
      if (!node.parentId) continue;
      const parent = doc.nodes[node.parentId];
      if (!parent) continue;
      const parentSize = nodeSize(parent.collapsed);
      const a = project(parent.position.x + parentSize.width / 2, parent.position.y + parentSize.height / 2);
      const b = project(node.position.x, node.position.y + 8);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();

    const selected = new Set(engine.getSelectedIds());
    for (const node of nodes) {
      const size = nodeSize(node.collapsed);
      const topLeft = project(node.position.x, node.position.y);
      const isRoot = node.id === doc.rootNodeId;
      ctx.fillStyle = selected.has(node.id)
        ? palette.accent
        : isRoot
          ? 'rgba(95,211,189,0.85)'
          : 'rgba(152,160,181,0.55)';
      ctx.fillRect(
        topLeft.x,
        topLeft.y,
        Math.max(2, size.width * scale),
        Math.max(2, size.height * scale),
      );
    }

    const viewTopLeft = project(view.x, view.y);
    ctx.strokeStyle = palette.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.round(viewTopLeft.x) + 0.5,
      Math.round(viewTopLeft.y) + 0.5,
      Math.max(4, view.width * scale),
      Math.max(4, view.height * scale),
    );

    return { minX, minY, scale, offsetX, offsetY };
  }, [doc, engine]);

  useEffect(() => {
    if (collapsed) return;
    draw();
    const timer = setInterval(draw, 140);
    return () => clearInterval(timer);
  }, [draw, collapsed]);

  const recenter = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const nodes = Object.values(doc.nodes);
      const bounds = boundsOf(nodes);
      if (!bounds) return;
      const view = visibleWorldRect(engine.camera, engine.viewport);
      const minX = Math.min(bounds.x, view.x);
      const minY = Math.min(bounds.y, view.y);
      const maxX = Math.max(bounds.x + bounds.width, view.x + view.width);
      const maxY = Math.max(bounds.y + bounds.height, view.y + view.height);
      const worldWidth = Math.max(1, maxX - minX);
      const worldHeight = Math.max(1, maxY - minY);
      const scale = Math.min((WIDTH - PADDING * 2) / worldWidth, (HEIGHT - PADDING * 2) / worldHeight);
      const offsetX = PADDING + (WIDTH - PADDING * 2 - worldWidth * scale) / 2;
      const offsetY = PADDING + (HEIGHT - PADDING * 2 - worldHeight * scale) / 2;

      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      const worldX = minX + (localX - offsetX) / scale;
      const worldY = minY + (localY - offsetY) / scale;
      engine.centerOn(worldX, worldY);
    },
    [doc.nodes, engine],
  );

  return (
    <div className="minimap" data-overlay="true">
      <div className="minimap__header">
        <span>Overview</span>
        <button
          type="button"
          className="minimap__toggle"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
        >
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </div>
      {collapsed ? null : (
        <canvas
          ref={canvasRef}
          className="minimap__canvas"
          style={{ width: WIDTH, height: HEIGHT }}
          onPointerDown={recenter}
          aria-label="Graph overview. Click to move the view."
          role="img"
        />
      )}
    </div>
  );
}
