/**
 * Minimal IndexedDB key/value wrapper.
 *
 * One object store, string keys, structured-clone values. That is the whole
 * requirement for local document storage, and it keeps the persistence layer
 * dependency-free.
 */

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  close(): void;
}

const DB_VERSION = 1;

export function indexedDbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export async function openKeyValueStore(
  databaseName: string,
  storeName = 'documents',
): Promise<KeyValueStore> {
  if (!indexedDbAvailable()) throw new Error('IndexedDB is not available in this environment');

  const openRequest = indexedDB.open(databaseName, DB_VERSION);
  openRequest.onupgradeneeded = () => {
    const db = openRequest.result;
    if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
  };
  const db = await requestToPromise(openRequest);

  const withStore = <T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let result: T;
      try {
        const request = run(store);
        request.onsuccess = () => {
          result = request.result;
        };
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
      } catch (error) {
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });

  return {
    get: <T>(key: string) => withStore<T | undefined>('readonly', (store) => store.get(key) as IDBRequest<T | undefined>),
    set: (key: string, value: unknown) =>
      withStore('readwrite', (store) => store.put(value, key) as IDBRequest<IDBValidKey>).then(() => undefined),
    delete: (key: string) =>
      withStore('readwrite', (store) => store.delete(key) as IDBRequest<undefined>).then(() => undefined),
    keys: () => withStore<IDBValidKey[]>('readonly', (store) => store.getAllKeys()).then((keys) => keys.map(String)),
    close: () => db.close(),
  };
}
