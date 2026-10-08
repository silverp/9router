// Opt in with TEST_NEON_DATABASE_URL; all data lives in a disposable schema.
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import pg from 'pg';
import { createPostgresAdapter } from '../../src/lib/db/adapters/postgresAdapter.js';

const enabled = !!process.env.TEST_NEON_DATABASE_URL;
const schema = `nine_router_verification_${Date.now()}`;
let db, adapter, second;
const previous = global._dbAdapter;

describe.skipIf(!enabled)('Neon persistent database', () => {
  beforeAll(async () => {
    vi.stubEnv('DATABASE_URL', process.env.TEST_NEON_DATABASE_URL);
    vi.stubEnv('DATABASE_URL_UNPOOLED', process.env.TEST_NEON_DIRECT_URL || process.env.TEST_NEON_DATABASE_URL);
    vi.stubEnv('NINEROUTER_DB_SCHEMA', schema);
    global._dbAdapter = { instance: null, initPromise: null, logged: false };
    vi.resetModules();
    db = await import('@/lib/db/index.js');
    adapter = await (await import('@/lib/db/driver.js')).getAdapter();
    second = await createPostgresAdapter(process.env.DATABASE_URL, { schema });
  }, 60000);

  afterAll(async () => {
    await Promise.all([adapter?.close(), second?.close()]);
    const pool = new pg.Pool({ connectionString: process.env.TEST_NEON_DIRECT_URL || process.env.TEST_NEON_DATABASE_URL });
    try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await pool.end(); global._dbAdapter = previous; vi.unstubAllEnvs(); }
  }, 30000);

  it('merges concurrent settings without losing fields', async () => {
    await Promise.all(Array.from({ length: 15 }, (_, i) => db.updateSettings({ [`test${i}`]: i })));
    const settings = await db.getSettings();
    for (let i = 0; i < 15; i++) expect(settings[`test${i}`]).toBe(i);
    expect(JSON.parse((await second.get('SELECT data FROM settings WHERE id=1')).data).test14).toBe(14);
  }, 30000);

  it('stores provider credentials and API keys across independent connections', async () => {
    const provider = await db.createProviderConnection({ provider: 'openai', authType: 'apikey', name: 'test', apiKey: 'fake-provider-key' });
    expect((await db.getProviderConnectionById(provider.id)).apiKey).toBe('fake-provider-key');
    const key = await db.createApiKey('test', 'verification-machine');
    expect(await db.validateApiKey(key.key)).toBe(true);
    expect((await second.get('SELECT isActive FROM apiKeys WHERE key=?', [key.key])).isActive).toBe(1);
    await db.updateApiKey(key.id, { isActive: false });
    expect(await db.validateApiKey(key.key)).toBe(false);
    await db.deleteApiKey(key.id);
    expect(await second.get('SELECT id FROM apiKeys WHERE id=?', [key.id])).toBeUndefined();
  }, 30000);

  it('rolls back an asynchronous transaction', async () => {
    await expect(adapter.transaction(async () => {
      await adapter.run('INSERT INTO kv(scope,key,value) VALUES(?,?,?)', ['rollback', 'x', '1']);
      await Promise.resolve();
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(await second.get('SELECT value FROM kv WHERE scope=?', ['rollback'])).toBeUndefined();
  }, 30000);

  it('imports and exports settings, credentials, aliases and pricing', async () => {
    await db.setModelAlias('test-alias', 'openai/gpt-4');
    await db.updatePricing({ openai: { 'test-model': { input: 1, output: 2 } } });
    const data = await db.exportDb();
    await db.importDb(data);
    expect(await db.exportDb()).toEqual(data);
  }, 30000);

  it('aggregates concurrent usage and keeps duplicate-event suppression', async () => {
    const now = Date.now() - 1000;
    const entries = Array.from({ length: 12 }, (_, i) => ({ timestamp: new Date(now + i).toISOString(), provider: 'test', model: 'test-model', connectionId: 'test', tokens: { prompt_tokens: 10, completion_tokens: 5 }, status: 'ok' }));
    await Promise.all(entries.map(entry => db.saveRequestUsage(entry)));
    await db.saveRequestUsage(entries[0]);
    expect((await db.getUsageHistory({ provider: 'test' })).length).toBe(12);
    const stats = await db.getUsageStats('7d');
    expect(stats.byProvider.test.requests).toBe(12);
    expect(stats.byProvider.test.promptTokens).toBe(120);
    expect(await db.getChartData('7d')).toBeDefined();
  }, 30000);
});
