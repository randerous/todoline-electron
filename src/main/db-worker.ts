import { DocumentStore } from './storage';

type ParentPort = {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  postMessage(message: unknown): void;
};
type Request = { id: string | number; method: string; args: unknown[] };

/** Attach Electron utilityProcess's process.parentPort (not worker_threads.parentPort). */
export function attachDatabaseWorker(port: ParentPort, store = new DocumentStore()): void {
  // Explicit functions also prevent prototype/property traversal through an RPC method.
  const methods = new Map<string, { arity: number[]; call: (...args: any[]) => unknown }>([
    ['open', { arity: [1, 2], call: (path, create) => store.open(path, create) }],
    ['reload', { arity: [1], call: handle => store.reload(handle) }],
    ['save', { arity: [1], call: request => store.save(request) }],
    ['saveAs', { arity: [2,3], call: (request, path, overwrite) => store.saveAs(request, path, overwrite) }],
    ['renameCase', { arity: [2], call: (handle, path) => store.renameCase(handle,path) }],
    ['close', { arity: [1], call: handle => store.close(handle) }],
    ['discardEmpty', { arity: [2], call: (handle, identity) => store.discardEmpty(handle,identity) }],
    ['search', { arity: [2], call: (handle, query) => store.search(handle, query) }],
    ['asset', { arity: [2], call: (handle, id) => store.asset(handle, id) }],
    ['addAsset', { arity: [4], call: (handle, data, w, h) => store.addAsset(handle, data, w, h) }],
    ['addAssets', { arity: [2], call: (handle, assets) => store.addAssets(handle, assets) }],
    ['snapshots', { arity: [0], call: () => store.snapshots() }],
    ['readLegacySettings', { arity: [1], call: path => store.readLegacySettings(path) }],
  ]);
  let tail = Promise.resolve();
  port.on('message', event => {
    const request = event.data as Partial<Request> | null;
    // Serialize reads and close/reload too, including across asynchronous backups.
    tail = tail.then(async () => {
      const id = request?.id ?? null;
      try {
        if (!request || (typeof request.id !== 'string' &&
            !(typeof request.id === 'number' && Number.isSafeInteger(request.id))) ||
            typeof request.method !== 'string' || !Array.isArray(request.args)) {
          throw new Error('Invalid database request; expected { id, method, args }.');
        }
        const method = methods.get(request.method);
        if (!method) throw new Error(`Database method is not allowed: ${request.method}`);
        if (!method.arity.includes(request.args.length)) throw new Error(`Invalid arguments for ${request.method}.`);
        const result = await method.call(...request.args);
        port.postMessage({ id, result });
      } catch (error) {
        port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
      }
    }).catch(() => { /* A disconnected parent must not poison the operation queue. */ });
  });
}

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
if (parentPort) attachDatabaseWorker(parentPort);
