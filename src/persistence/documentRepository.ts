/**
 * Document storage behind a repository interface.
 *
 * The UI never touches IndexedDB (or anything else) directly, so storage can be
 * swapped — a backend, a file system, an in-memory store for tests — without
 * changing a single component.
 *
 * Layering:
 *   IndexedDB  primary store (async, large quota)
 *   localStorage  emergency mirror of the most recent document, written on
 *                 every save when the payload is small. It is what saves work if
 *                 the browser drops an IndexedDB write during an unload race, and
 *                 it is also the fallback store when IndexedDB is unavailable
 *                 (private windows, hardened privacy settings).
 *   memory     last-resort store so the app still runs if both are blocked.
 */

import { MIRROR_MAX_BYTES } from '../config';
import type { GraphDocument } from '../graph/types';
import { indexedDbAvailable, openKeyValueStore, type KeyValueStore } from './indexedDb';
import { deserializeDocument, serializeDocument } from './migrations';

export interface StoredDocument {
  doc: GraphDocument;
  savedAt: number;
}

export interface DocumentSummary {
  id: string;
  title: string;
  savedAt: number;
  nodeCount: number;
}

export type RepositoryKind = 'indexeddb' | 'localstorage' | 'memory';

export interface DocumentRepository {
  readonly kind: RepositoryKind;
  load(documentId: string): Promise<StoredDocument | null>;
  save(snapshot: StoredDocument): Promise<void>;
  list(): Promise<DocumentSummary[]>;
  remove(documentId: string): Promise<void>;
  getLastOpenedId(): string | null;
  setLastOpenedId(documentId: string): void;
}

const DB_NAME = 'lumieres';
const STORE_NAME = 'documents';
const MIRROR_KEY = 'lumieres:mirror';
const LAST_OPENED_KEY = 'lumieres:lastOpened';

/**
 * Returns a usable `localStorage`, or null.
 *
 * Reads it from `window` rather than the bare global and checks the API shape:
 * some runtimes expose a `localStorage` placeholder that lacks the methods, and
 * private windows throw on the first write. Both cases must degrade quietly.
 */
function safeLocalStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    const candidate: Storage | undefined = window.localStorage;
    if (!candidate || typeof candidate.setItem !== 'function') return null;
    const probe = '__lumieres_probe__';
    candidate.setItem(probe, '1');
    candidate.removeItem(probe);
    return candidate;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Stores                                                              */
/* ------------------------------------------------------------------ */

class IndexedDbRepository implements DocumentRepository {
  readonly kind = 'indexeddb' as const;

  constructor(
    private readonly store: KeyValueStore,
    private readonly mirror: Storage | null,
  ) {}

  async load(documentId: string): Promise<StoredDocument | null> {
    const record = await this.store.get<{ json: string; savedAt: number }>(documentId);
    if (record?.json) {
      const parsed = deserializeDocument(record.json);
      if (parsed.doc) return { doc: parsed.doc, savedAt: record.savedAt };
    }
    return this.loadMirror(documentId);
  }

  private loadMirror(documentId: string): StoredDocument | null {
    if (!this.mirror) return null;
    try {
      const raw = this.mirror.getItem(MIRROR_KEY);
      if (!raw) return null;
      const envelope = JSON.parse(raw) as { id?: string; json?: string; savedAt?: number };
      if (!envelope.json || envelope.id !== documentId) return null;
      const parsed = deserializeDocument(envelope.json);
      return parsed.doc ? { doc: parsed.doc, savedAt: envelope.savedAt ?? Date.now() } : null;
    } catch {
      return null;
    }
  }

  async save(snapshot: StoredDocument): Promise<void> {
    const json = serializeDocument(snapshot.doc);
    await this.store.set(snapshot.doc.id, { json, savedAt: snapshot.savedAt });
    if (this.mirror && json.length < MIRROR_MAX_BYTES) {
      try {
        this.mirror.setItem(
          MIRROR_KEY,
          JSON.stringify({ id: snapshot.doc.id, json, savedAt: snapshot.savedAt }),
        );
      } catch {
        // Quota or privacy mode: the IndexedDB write already succeeded.
      }
    }
  }

  async list(): Promise<DocumentSummary[]> {
    const keys = await this.store.keys();
    const out: DocumentSummary[] = [];
    for (const key of keys) {
      const record = await this.store.get<{ json: string; savedAt: number }>(key);
      if (!record?.json) continue;
      const parsed = deserializeDocument(record.json);
      if (!parsed.doc) continue;
      out.push({
        id: parsed.doc.id,
        title: parsed.doc.title,
        savedAt: record.savedAt,
        nodeCount: Object.keys(parsed.doc.nodes).length,
      });
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  async remove(documentId: string): Promise<void> {
    await this.store.delete(documentId);
    try {
      this.mirror?.removeItem(MIRROR_KEY);
    } catch {
      // ignore
    }
  }

  getLastOpenedId(): string | null {
    try {
      return this.mirror?.getItem(LAST_OPENED_KEY) ?? null;
    } catch {
      return null;
    }
  }

  setLastOpenedId(documentId: string): void {
    try {
      this.mirror?.setItem(LAST_OPENED_KEY, documentId);
    } catch {
      // ignore
    }
  }
}

class LocalStorageRepository implements DocumentRepository {
  readonly kind = 'localstorage' as const;

  constructor(private readonly storage: Storage) {}

  private key(id: string): string {
    return `lumieres:doc:${id}`;
  }

  async load(documentId: string): Promise<StoredDocument | null> {
    const raw = this.storage.getItem(this.key(documentId));
    if (!raw) return null;
    const parsed = deserializeDocument(raw);
    if (!parsed.doc) return null;
    const envelope = safeParse<{ savedAt?: number }>(raw);
    return { doc: parsed.doc, savedAt: envelope?.savedAt ?? Date.now() };
  }

  async save(snapshot: StoredDocument): Promise<void> {
    this.storage.setItem(
      this.key(snapshot.doc.id),
      JSON.stringify({ savedAt: snapshot.savedAt, ...JSON.parse(serializeDocument(snapshot.doc)) }),
    );
  }

  async list(): Promise<DocumentSummary[]> {
    const out: DocumentSummary[] = [];
    for (let i = 0; i < this.storage.length; i += 1) {
      const key = this.storage.key(i);
      if (!key?.startsWith('lumieres:doc:')) continue;
      const stored = await this.load(key.slice('lumieres:doc:'.length));
      if (stored) {
        out.push({
          id: stored.doc.id,
          title: stored.doc.title,
          savedAt: stored.savedAt,
          nodeCount: Object.keys(stored.doc.nodes).length,
        });
      }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  async remove(documentId: string): Promise<void> {
    this.storage.removeItem(this.key(documentId));
  }

  getLastOpenedId(): string | null {
    return this.storage.getItem(LAST_OPENED_KEY);
  }

  setLastOpenedId(documentId: string): void {
    this.storage.setItem(LAST_OPENED_KEY, documentId);
  }
}

class MemoryRepository implements DocumentRepository {
  readonly kind = 'memory' as const;
  private readonly documents = new Map<string, StoredDocument>();
  private lastOpened: string | null = null;

  async load(documentId: string): Promise<StoredDocument | null> {
    return this.documents.get(documentId) ?? null;
  }

  async save(snapshot: StoredDocument): Promise<void> {
    this.documents.set(snapshot.doc.id, snapshot);
  }

  async list(): Promise<DocumentSummary[]> {
    return [...this.documents.values()].map((stored) => ({
      id: stored.doc.id,
      title: stored.doc.title,
      savedAt: stored.savedAt,
      nodeCount: Object.keys(stored.doc.nodes).length,
    }));
  }

  async remove(documentId: string): Promise<void> {
    this.documents.delete(documentId);
  }

  getLastOpenedId(): string | null {
    return this.lastOpened;
  }

  setLastOpenedId(documentId: string): void {
    this.lastOpened = documentId;
  }
}

function safeParse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

export interface RepositoryOptions {
  /** Overridable so tests can use an isolated database. */
  databaseName?: string;
}

/**
 * Picks the best available store. Never throws: a browser that blocks both
 * IndexedDB and localStorage still gets a working, session-only canvas.
 */
export async function createDocumentRepository(
  options: RepositoryOptions = {},
): Promise<DocumentRepository> {
  const storage = safeLocalStorage();
  if (indexedDbAvailable()) {
    try {
      const store = await openKeyValueStore(options.databaseName ?? DB_NAME, STORE_NAME);
      return new IndexedDbRepository(store, storage);
    } catch {
      // fall through
    }
  }
  if (storage) return new LocalStorageRepository(storage);
  return new MemoryRepository();
}

export function createMemoryRepository(): DocumentRepository {
  return new MemoryRepository();
}
