'use strict';
// Connections and statement runners for the three engines of the lab.
//   oracle  the source (node-oracledb in "thin" mode: no client libraries needed)
//   pg      community PostgreSQL + orafce
//   epas    EDB Postgres Advanced Server, Oracle-compatible mode

const { Client, types: pgTypes } = require('pg');
const oracledb = require('oracledb');

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.fetchAsString = [oracledb.CLOB];

const ENGINES = {
  oracle: { id: 'oracle', label: 'Oracle', short: 'Oracle' },
  pg: { id: 'pg', label: 'PostgreSQL + orafce', short: 'PG + orafce',
        host: process.env.PG_HOST || 'localhost', port: +(process.env.PG_PORT || 5432),
        user: 'acme', password: 'acme', database: 'acme', searchPath: 'acme, oracle, public' },
  epas: { id: 'epas', label: 'EPAS (Oracle mode)', short: 'EPAS',
          host: process.env.EPAS_HOST || 'localhost', port: +(process.env.EPAS_PORT || 5444),
          user: 'acme', password: 'acme', database: 'acme', searchPath: 'acme, public' },
};

const ORACLE = {
  user: 'acme', password: 'acme',
  connectString: process.env.ORACLE_CONNECT || 'localhost:1521/FREEPDB1',
};

// ------------------------------------------------------------------ helpers

// Make a value printable and comparable: dates, buffers and objects become strings.
function plain(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())} ${p(v.getHours())}:${p(v.getMinutes())}:${p(v.getSeconds())}`;
  }
  if (Buffer.isBuffer(v)) return '\\x' + v.toString('hex');
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function shapeRows(fields, rows) {
  return rows.map((r) => {
    const o = {};
    fields.forEach((f, i) => { o[f] = plain(Array.isArray(r) ? r[i] : r[f]); });
    return o;
  });
}

// ------------------------------------------------------------------ PostgreSQL family

// Dates and intervals come back as the server's own text. node-postgres cannot parse the
// Oracle-style output EPAS produces ("29-FEB-24 00:00:00") and would silently return null.
const RAW_OIDS = new Set([1082, 1114, 1184, 1186]);
const typeParsers = { getTypeParser: (oid, fmt) => (RAW_OIDS.has(oid) ? (v) => v : pgTypes.getTypeParser(oid, fmt)) };

async function pgClient(id) {
  const e = ENGINES[id];
  const c = new Client({ host: e.host, port: e.port, user: e.user, password: e.password, database: e.database,
                         connectionTimeoutMillis: 4000, application_name: 'orafce-lab', types: typeParsers });
  c.notices = [];
  c.on('notice', (n) => c.notices.push(n.message));
  await c.connect();   // search_path comes from the database/role defaults, as for a real application
  await c.query("SET datestyle = 'ISO, MDY'");   // a display setting only; the values are unchanged
  return c;
}

async function withPg(id, fn) {
  const c = await pgClient(id);
  try { return await fn(c); } finally { await c.end().catch(() => {}); }
}

// Run one statement. `rollback` makes it a sandbox: nothing it does is kept.
async function runPg(id, sql, { rollback = false, dbmsOutput = false } = {}) {
  const t0 = Date.now();
  let c;
  try {
    c = await pgClient(id);
    if (dbmsOutput) await enablePgOutput(id, c);
    if (rollback) await c.query('BEGIN');
    c.notices.length = 0;
    let r;
    try { r = await c.query(sql); }
    finally { if (rollback) await c.query('ROLLBACK').catch(() => {}); }
    if (Array.isArray(r)) r = r[r.length - 1];
    const fields = (r.fields || []).map((f) => f.name);
    return { ok: true, command: r.command, rowCount: r.rowCount, fields,
             rows: shapeRows(fields, r.rows || []), output: [...c.notices], ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: cleanError(err), output: c ? [...c.notices] : [], ms: Date.now() - t0 };
  } finally {
    if (c) await c.end().catch(() => {});
  }
}

async function enablePgOutput(id, c) {
  // EPAS: DBMS_OUTPUT output is sent to the client as NOTICEs once serveroutput is on.
  // orafce: the same call exists and behaves the same way.
  try { await c.query('SELECT dbms_output.serveroutput(true)'); } catch (_) { /* package may not exist */ }
}

function cleanError(err) {
  let m = (err && err.message) || String(err);
  if (err && err.position) m += ` (at character ${err.position})`;
  return m.replace(/^error: /i, '');
}

// ------------------------------------------------------------------ Oracle

async function oracleConn() { return oracledb.getConnection(ORACLE); }

async function withOracle(fn) {
  const c = await oracleConn();
  try { return await fn(c); } finally { await c.close().catch(() => {}); }
}

function oracleSql(sql) {
  const s = sql.trim();
  const isBlock = /^(BEGIN|DECLARE|CALL)\b/i.test(s);
  return isBlock ? s : s.replace(/[;\s]+$/, '');
}

async function runOracle(sql, { rollback = false, dbmsOutput = false } = {}) {
  const t0 = Date.now();
  let c;
  try {
    c = await oracleConn();
    if (dbmsOutput) await c.execute('BEGIN DBMS_OUTPUT.ENABLE(NULL); END;');
    let r;
    try { r = await c.execute(oracleSql(sql), [], { autoCommit: !rollback, outFormat: oracledb.OUT_FORMAT_ARRAY }); }
    finally { if (rollback) await c.rollback().catch(() => {}); }
    const fields = (r.metaData || []).map((m) => m.name);
    let output = [];
    if (dbmsOutput) output = await oracleOutput(c);
    return { ok: true, command: r.metaData ? 'SELECT' : 'OK', rowCount: r.rows ? r.rows.length : (r.rowsAffected || 0),
             fields, rows: shapeRows(fields, r.rows || []), output, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: cleanError(err), output: [], ms: Date.now() - t0 };
  } finally {
    if (c) await c.close().catch(() => {});
  }
}

async function oracleOutput(c) {
  const lines = [];
  for (;;) {
    const r = await c.execute('BEGIN DBMS_OUTPUT.GET_LINE(:l, :s); END;',
      { l: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 32767 }, s: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } },
      { outFormat: oracledb.OUT_FORMAT_ARRAY });
    if (r.outBinds.s !== 0) break;
    lines.push(r.outBinds.l);
  }
  return lines;
}

// ------------------------------------------------------------------ dispatch

function run(engine, sql, opts) {
  if (engine === 'oracle') return runOracle(sql, opts);
  if (engine === 'pg' || engine === 'epas') return runPg(engine, sql, opts);
  return Promise.resolve({ ok: false, error: `Unknown engine ${engine}` });
}

async function ping(engine) {
  if (engine === 'oracle') {
    return withOracle(async (c) => {
      const r = await c.execute("SELECT banner_full FROM v$version WHERE ROWNUM = 1", [], { outFormat: oracledb.OUT_FORMAT_ARRAY })
        .catch(() => ({ rows: [['Oracle Database']] }));
      return { version: String(r.rows[0][0]).replace(/\s+/g, ' ').trim() };
    });
  }
  return withPg(engine, async (c) => {
    const v = (await c.query('SELECT version() AS v')).rows[0].v;
    const out = { version: v.replace(/ on .*/, '') };
    if (engine === 'pg') {
      const x = await c.query("SELECT extversion FROM pg_extension WHERE extname = 'orafce'");
      out.orafce = x.rows[0] ? x.rows[0].extversion : null;
    } else {
      const x = await c.query("SELECT setting FROM pg_settings WHERE name = 'edb_redwood_date'");
      out.redwood = x.rows[0] ? x.rows[0].setting : null;
    }
    return out;
  });
}

// Does the migrated ACME schema exist on a target?
async function schemaMigrated(engine) {
  if (engine === 'oracle') return true;
  try {
    return await withPg(engine, async (c) => {
      const r = await c.query(
        "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'acme' AND table_name = 'employees'");
      return r.rows[0].n > 0;
    });
  } catch (_) { return false; }
}

module.exports = { ENGINES, ORACLE, withPg, withOracle, withOracleConn: oracleConn, pgClient, run, runPg, runOracle, ping,
                   schemaMigrated, plain, cleanError, shape: shapeRows, oracleSql, oracleOutput, OUT_ARRAY: oracledb.OUT_FORMAT_ARRAY };
