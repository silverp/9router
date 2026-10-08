import { it, expect } from 'vitest';
import { createNodeSqliteAdapter } from '../../src/lib/db/adapters/nodeSqliteAdapter.js';
import { withAsyncTransactions } from '../../src/lib/db/adapters/asyncSqliteAdapter.js';

it('rolls back awaited writes and isolates other requests until the transaction finishes', async () => {
  const db = withAsyncTransactions(await createNodeSqliteAdapter(':memory:'));
  db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)');
  let started, resume;
  const ready = new Promise(r => { started = r; });
  const gate = new Promise(r => { resume = r; });
  try {
    const transaction = db.transaction(async () => {
      await db.run('INSERT INTO items VALUES(1, ?)', ['rolled back']);
      started();
      await gate;
      throw new Error('abort');
    });
    const rejected = expect(transaction).rejects.toThrow('abort');
    await ready;
    const outsideWrite = db.run('INSERT INTO items VALUES(2, ?)', ['kept']);
    const outsideRead = db.all('SELECT * FROM items ORDER BY id');
    resume();
    await rejected;
    await outsideWrite;
    expect(await outsideRead).toEqual([{ id: 2, value: 'kept' }]);
  } finally { db.close(); }
});
