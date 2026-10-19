/**
 * The canvas surface and its two DOM overlay layers.
 *
 * Layer contract (bottom → top):
 *   <canvas>          static scene: grid, edges, every window's chrome + preview
 *   .overlay-layer    transformed with the camera; contains the single open editor
 *   .screen-layer     untransformed; floating controls positioned per frame
 *
 * React renders at most a handful of elements here regardless of graph size.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { attachInteractions } from '../../canvas/interactions';
import { useEngine, useEngineSnapshot } from '../../app/EngineContext';
import { useElementSize } from '../../hooks/useElementSize';
import { useKeyboardShortcuts, type ShortcutHandlers } from '../../hooks/useKeyboardShortcuts';
import { NoteWindow } from '../node/NoteWindow';
import { NodeToolbar } from '../node/NodeToolbar';
import { BranchAction } from '../node/BranchAction';
import { Minimap } from './Minimap';
import { ZoomControls } from './ZoomControls';

export interface GraphCanvasProps extends ShortcutHandlers {
  children?: ReactNode;
}

export function GraphCanvas({ children, ...handlers }: GraphCanvasProps): ReactNode {
  const engine = useEngine();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);

  const editingNodeId = useEngineSnapshot((snapshot) => snapshot.editingNodeId);

  useElementSize(containerRef, (size) => engine.resize(size.width, size.height, size.dpr));
  useKeyboardShortcuts(engine, handlers);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    const screen = screenRef.current;
    if (!container || !canvas || !overlay || !screen) return;

    engine.mount({ canvas, overlayLayer: overlay, screenLayer: screen });
    const interactions = attachInteractions(container, engine);
    engine.setPanModifierHook(interactions.setPanModifier);

    // Focus the canvas when the pointer lands on empty space so keyboard
    // shortcuts apply to the graph rather than to a stale form control.
    const onPointerDownCapture = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-overlay="true"]')) return;
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    };
    container.addEventListener('pointerdown', onPointerDownCapture);

    return () => {
      container.removeEventListener('pointerdown', onPointerDownCapture);
      engine.setPanModifierHook(null);
      interactions.detach();
    };
  }, [engine]);

  return (
    <div
      className="canvas-root"
      ref={containerRef}
      data-pan-held="false"
    >
      <canvas className="canvas-surface" ref={canvasRef} aria-label="Graph canvas" role="img" />

      <div className="overlay-layer" ref={overlayRef}>
        {editingNodeId ? <NoteWindow key={editingNodeId} nodeId={editingNodeId} /> : null}
      </div>

      <div className="screen-layer" ref={screenRef}>
        <NodeToolbar />
        <BranchAction />
      </div>

      <Minimap />
      <ZoomControls />
      {children}
    </div>
  );
}
