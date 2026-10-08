import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { attachDatabasePool } from "@vercel/functions";
import { TABLES, SCHEMA_VERSION, buildCreateTableSql } from "../schema.js";
import { postgresSql, validateSchema } from "./postgresSql.js";

// SQLite returns numeric counts and IDs. Preserve that contract for Postgres.
pg.types.setTypeParser(20, Number);

function makePool(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 4, idleTimeoutMillis: 5000, connectionTimeoutMillis: 15000 });
  pool.on("error", (error) => console.error("[DB] PostgreSQL idle connection error:", error.code || "connection error"));
  if (process.env.VERCEL === "1") attachDatabasePool(pool);
  return pool;
}

// Run additive migrations through a direct connection; the application's
// queries use Neon's pooled URL. No filesystem backup or SQLite fallback.
async function migrate(connectionString, schema) {
  const pool = makePool(connectionString);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`9router:${schema}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await client.query(postgresSql(buildCreateTableSql("_meta", TABLES._meta), schema));
    const { rows } = await client.query(postgresSql("SELECT value FROM _meta WHERE key = ?", schema), ["postgresSchemaVersion"]);
    const version = Number(rows[0]?.value || 0);
    if (version > SCHEMA_VERSION) throw new Error("PostgreSQL schema is newer than this application");
    if (version < SCHEMA_VERSION) {
      for (const [name, definition] of Object.entries(TABLES)) {
        await client.query(postgresSql(buildCreateTableSql(name, definition), schema));
        const columns = await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2", [schema, name]);
        const existing = new Set(columns.rows.map((row) => row.column_name));
        for (const [column, type] of Object.entries(definition.columns)) {
          if (existing.has(column)) continue;
          const safeType = type.replace(/PRIMARY KEY(?: AUTOINCREMENT)?/i, "").replace(/UNIQUE/i, "").trim();
          await client.query(postgresSql(`ALTER TABLE ${name} ADD COLUMN ${column} ${safeType}`, schema));
        }
        for (const index of definition.indexes || []) await client.query(postgresSql(index, schema));
      }
      await client.query(postgresSql("INSERT INTO _meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", schema), ["postgresSchemaVersion", String(SCHEMA_VERSION)]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

export async function createPostgresAdapter(connectionString, {
  schema = process.env.NINEROUTER_DB_SCHEMA || (process.env.VERCEL_ENV === "production" ? "nine_router" : process.env.VERCEL_ENV === "preview" ? "nine_router_preview" : "nine_router_development"),
  migrationUrl = process.env.DATABASE_URL_UNPOOLED || connectionString,
} = {}) {
  validateSchema(schema);
  await migrate(migrationUrl, schema);
  const pool = makePool(connectionString);
  const context = new AsyncLocalStorage();
  const query = (sql, parameters = []) => (context.getStore() || pool).query(postgresSql(sql, schema), parameters);

  return {
    driver: "postgres",
    schema,
    async run(sql, parameters = []) {
      const result = await query(sql, parameters);
      return { changes: result.rowCount || 0, lastInsertRowid: result.rows[0]?.id ?? null };
    },
    async get(sql, parameters = []) { return (await query(sql, parameters)).rows[0]; },
    async all(sql, parameters = []) { return (await query(sql, parameters)).rows; },
    async exec(sql) { await query(sql); },
    async transaction(callback) {
      if (context.getStore()) throw new Error("Nested PostgreSQL transactions are not supported");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Repositories perform read/merge/write and priority allocation. The
        // shared lock serializes those operations across all Vercel instances.
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`9router:${schema}`]);
        const result = await context.run(client, callback);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    checkpoint() {},
    async close() { await pool.end(); },
  };
}
