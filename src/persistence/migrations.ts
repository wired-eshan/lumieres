/**
 * Schema versioning and defensive deserialisation.
 *
 * Rule of thumb applied throughout: **never discard user content to make a
 * document valid.** Unknown fields are dropped, missing fields are defaulted,
 * but note text is only ever preserved verbatim — over-limit notes are reported
 * by `validateGraph` rather than trimmed.
 */

import { createEdgeId, createNodeId } from '../utils/id';
import { normalizeDocument, type ValidationIssue } from '../graph/graphValidation';
import { SCHEMA_VERSION, type GraphDocument, type GraphEdge, type NoteNode, type SourceReference } from '../graph/types';

export interface MigrationResult {
  doc: GraphDocument | null;
  issues: ValidationIssue[];
  /** Human-readable notes about what had to be repaired. */
  notes: string[];
  fromVersion: number;
}

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asPoint(value: unknown): { x: number; y: number } {
  if (!isRecord(value)) return { x: 0, y: 0 };
  return { x: asNumber(value.x, 0), y: asNumber(value.y, 0) };
}

function asSourceReference(value: unknown, sourceNodeId: string): SourceReference | null {
  if (!isRecord(value)) return null;
  const snapshot = asString(value.selectedTextSnapshot, '');
  const start = Math.max(0, Math.round(asNumber(value.startOffset, 0)));
  const end = Math.max(start, Math.round(asNumber(value.endOffset, start + snapshot.length)));
  return {
    sourceNodeId: asString(value.sourceNodeId, sourceNodeId),
    selectedTextSnapshot: snapshot,
    startOffset: start,
    endOffset: end,
    sourceContentVersion: Math.max(0, Math.round(asNumber(value.sourceContentVersion, 0))),
  };
}

/** Version migrations, applied in order until the document reaches `SCHEMA_VERSION`. */
const MIGRATIONS: Record<number, (raw: RawRecord, notes: string[]) => RawRecord> = {
  // 0 -> 1: pre-versioning documents had no `collapsed` flag or content version.
  0: (raw, notes) => {
    notes.push('Upgraded a pre-versioned document to schema 1.');
    return { ...raw, schemaVersion: 1 };
  },
};

export function migrateDocument(input: unknown): MigrationResult {
  const notes: string[] = [];
  if (!isRecord(input)) {
    return {
      doc: null,
      issues: [{ severity: 'error', code: 'MISSING_ROOT', message: 'The file is not a graph document.' }],
      notes,
      fromVersion: -1,
    };
  }

  let raw = input;
  const fromVersion = Math.round(asNumber(raw.schemaVersion, 0));
  let currentVersion = fromVersion;

  if (fromVersion > SCHEMA_VERSION) {
    return {
      doc: null,
      issues: [
        {
          severity: 'error',
          code: 'MISSING_ROOT',
          message: `This document was written by a newer version of Lumières (schema ${fromVersion}). Update the app to open it.`,
        },
      ],
      notes,
      fromVersion,
    };
  }

  while (currentVersion < SCHEMA_VERSION) {
    const migration = MIGRATIONS[currentVersion];
    if (migration) raw = migration(raw, notes);
    else raw = { ...raw, schemaVersion: currentVersion + 1 };
    currentVersion += 1;
  }

  const rawNodes = isRecord(raw.nodes) ? raw.nodes : {};
  const nodes: Record<string, NoteNode> = {};
  const idRemap = new Map<string, string>();

  for (const [key, value] of Object.entries(rawNodes)) {
    if (!isRecord(value)) continue;
    const originalId = asString(value.id, key);
    const id = originalId.length > 0 ? originalId : createNodeId();
    if (id !== originalId) idRemap.set(originalId, id);
    const parentIdRaw = value.parentId;
    const parentId = typeof parentIdRaw === 'string' && parentIdRaw.length > 0 ? parentIdRaw : null;
    nodes[id] = {
      id,
      parentId,
      title: asString(value.title, ''),
      // Content is preserved exactly, including anything over the limit.
      content: asString(value.content, ''),
      position: asPoint(value.position),
      sourceReference: asSourceReference(value.sourceReference, parentId ?? ''),
      collapsed: asBoolean(value.collapsed, false),
      contentVersion: Math.max(1, Math.round(asNumber(value.contentVersion, 1))),
      createdAt: asNumber(value.createdAt, Date.now()),
      updatedAt: asNumber(value.updatedAt, Date.now()),
    };
  }

  // Re-point parents and source references through any id remapping.
  for (const node of Object.values(nodes)) {
    if (node.parentId && idRemap.has(node.parentId)) node.parentId = idRemap.get(node.parentId) ?? node.parentId;
    if (node.sourceReference && idRemap.has(node.sourceReference.sourceNodeId)) {
      node.sourceReference.sourceNodeId = idRemap.get(node.sourceReference.sourceNodeId) ?? node.sourceReference.sourceNodeId;
    }
  }

  const rootCandidate = asString(raw.rootNodeId, '');
  const rootNodeId = nodes[rootCandidate]
    ? rootCandidate
    : (Object.values(nodes).find((node) => node.parentId === null)?.id ??
      Object.keys(nodes)[0] ??
      '');

  const edges: Record<string, GraphEdge> = {};
  for (const node of Object.values(nodes)) {
    if (node.parentId === null) continue;
    const id = createEdgeId(node.parentId, node.id);
    edges[id] = { id, sourceNodeId: node.parentId, targetNodeId: node.id };
  }

  const draft: GraphDocument = {
    schemaVersion: SCHEMA_VERSION,
    id: asString(raw.id, `doc_${Date.now().toString(36)}`),
    title: asString(raw.title, 'Untitled canvas'),
    rootNodeId,
    nodes,
    edges,
    createdAt: asNumber(raw.createdAt, Date.now()),
    updatedAt: asNumber(raw.updatedAt, Date.now()),
  };

  const { doc, issues } = normalizeDocument(draft);
  const repaired = issues.filter((issue) => issue.severity === 'error');
  if (repaired.length > 0) {
    notes.push(`Repaired ${repaired.length} structural problem${repaired.length === 1 ? '' : 's'} on load.`);
  }

  return { doc, issues, notes, fromVersion };
}

/** Serialises a document for storage or download (stable key order, pretty printed). */
export function serializeDocument(doc: GraphDocument): string {
  return JSON.stringify(doc, null, 2);
}

export function deserializeDocument(json: string): MigrationResult {
  try {
    return migrateDocument(JSON.parse(json));
  } catch (error) {
    return {
      doc: null,
      issues: [
        {
          severity: 'error',
          code: 'MISSING_ROOT',
          message: `Could not read the document: ${error instanceof Error ? error.message : 'invalid JSON'}`,
        },
      ],
      notes: [],
      fromVersion: -1,
    };
  }
}
