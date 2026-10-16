/**
 * Identifier generation.
 *
 * `crypto.randomUUID` is available in every target browser and in Node 19+, but
 * we fall back to a counter+random scheme so tests and unusual embeddings never
 * hand out duplicate ids.
 */

let counter = 0;

function fallbackId(prefix: string): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

export function createId(prefix: string): string {
  const globalCrypto = globalThis.crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return `${prefix}_${globalCrypto.randomUUID()}`;
  }
  return fallbackId(prefix);
}

export function createNodeId(): string {
  return createId('n');
}

export function createDocumentId(): string {
  return createId('doc');
}

/** Edge ids are derived from the relationship so they stay deterministic and unique. */
export function createEdgeId(sourceNodeId: string, targetNodeId: string): string {
  return `e:${sourceNodeId}->${targetNodeId}`;
}
