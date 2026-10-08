import { AsyncLocalStorage } from "node:async_hooks";

// Repositories await both local SQLite and remote Postgres. Hold SQLite's
// transaction open until its async callback finishes and serialize unrelated
// operations so they cannot accidentally run inside another request's commit.
export function withAsyncTransactions(adapter) {
  const context = new AsyncLocalStorage();
  let tail = Promise.resolve();
  let pending = 0;
  let sequence = 0;
  const enqueue = (callback) => {
    const result = tail.then(callback);
    tail = result.catch(() => {});
    return result;
  };
  const wrapped = { ...adapter };
  for (const method of ["get", "all", "run", "exec"]) {
    wrapped[method] = (...args) => {
      if (!pending || context.getStore() === adapter) return adapter[method](...args);
      return enqueue(() => adapter[method](...args));
    };
  }
  async function runTransaction(callback) {
    const savepoint = `async_sp_${++sequence}`;
    adapter.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = await context.run(adapter, callback);
      adapter.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      adapter.exec(`ROLLBACK TO ${savepoint}`);
      adapter.exec(`RELEASE ${savepoint}`);
      throw error;
    }
  }
  wrapped.transaction = (callback) => {
    if (context.getStore() === adapter) return runTransaction(callback);
    pending++;
    return enqueue(() => runTransaction(callback)).finally(() => { pending--; });
  };
  return wrapped;
}
