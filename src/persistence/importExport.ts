/**
 * Document import and export.
 *
 * Import never silently repairs away user content: structural problems are
 * fixed (see `normalizeDocument`) and reported, over-limit notes are kept intact
 * and flagged, and a document from a newer schema is refused with an explanation
 * rather than being partially read.
 */

import { computeStats, validateGraph, type GraphStats, type ValidationIssue } from '../graph/graphValidation';
import type { GraphDocument } from '../graph/types';
import { deserializeDocument, serializeDocument, type MigrationResult } from './migrations';

export interface ImportOutcome {
  doc: GraphDocument | null;
  issues: ValidationIssue[];
  notes: string[];
  stats: GraphStats | null;
}

export function importFromJson(json: string): ImportOutcome {
  const result: MigrationResult = deserializeDocument(json);
  if (!result.doc) return { doc: null, issues: result.issues, notes: result.notes, stats: null };
  return {
    doc: result.doc,
    issues: validateGraph(result.doc),
    notes: result.notes,
    stats: computeStats(result.doc),
  };
}

export async function importFromFile(file: File): Promise<ImportOutcome> {
  const text = await file.text();
  return importFromJson(text);
}

/** Triggers a browser download of the document as JSON. */
export function downloadDocument(doc: GraphDocument): void {
  const blob = new Blob([serializeDocument(doc)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${slugify(doc.title)}.lumieres.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the download a tick to start before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'lumieres-canvas';
}
