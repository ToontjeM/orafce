'use strict';
// Oracle compatibility lab: orafce + ora2pg (community PostgreSQL) vs EPAS.
//
// The backend drives real tools against real databases:
//   - ora2pg           assessment, schema + data export (path A)
//   - psql / edb-psql  loading the converted SQL and replaying Oracle scripts
//   - EDB Migration Toolkit (runMTK.sh)  schema + data straight from Oracle (path B)
// Long-running work is a "job" whose console output the UI polls.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const express = require('express');
const db = require('./db');
const { PRESETS } = require('./presets');
const { FEATURES, scanFeatures } = require('./features');

const PORT = process.env.PORT || 8080;
const SQL_DIR = process.env.ORACLE_SQL_DIR || '/oracle-sql';
const FIXES_FILE = process.env.FIXES_FILE || '/fixes/pg-manual-fixes.sql';
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-'));

const PG_HOST = process.env.PG_HOST || 'localhost';
const EPAS_HOST = process.env.EPAS_HOST || 'localhost';
const ORACLE_CONNECT = process.env.ORACLE_CONNECT || 'localhost:1521/FREEPDB1';
const [ORA_HOSTPORT, ORA_SERVICE] = ORACLE_CONNECT.split('/');
const [ORA_HOST, ORA_PORT = '1521'] = ORA_HOSTPORT.split(':');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function send(res, fn) {
  Promise.resolve().then(fn).then((d) => res.json(d)).catch((err) => {
    if (!err.status) console.error(err);
    res.status(err.status || 500).json({ error: err.message });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ======================================================================== jobs

const jobs = new Map();
let busy = null;
const lastResult = { assess: null, A: null, A_fixed: null, B: null, B_replay: null };

function newJob(kind, stepLabels) {
  const job = {
    id: `${kind}-${Date.now().toString(36)}`, kind, status: 'running', started: Date.now(),
    steps: stepLabels.map((label) => ({ label, status: 'pending' })), step: -1,
    progress: null, lines: [], result: null, error: null,
    log(t, s) { if (this.lines.length < 8000) this.lines.push({ t, s: String(s) }); },
    begin(i, detail) { // finish the previous step, start step i
      if (this.step >= 0 && this.steps[this.step].status === 'running') this.steps[this.step].status = 'done';
      this.step = i; this.steps[i].status = 'running'; this.progress = null;
      this.log('step', `${i + 1}/${this.steps.length}  ${this.steps[i].label}${detail ? ' ' + detail : ''}`);
    },
    fail(i = this.step) { if (i >= 0) this.steps[i].status = 'failed'; },
  };
  jobs.set(job.id, job);
  return job;
}

function startJob(kind, labels, fn) {
  if (busy) { const e = new Error(`Busy: ${busy} is still running.`); e.status = 409; throw e; }
  const job = newJob(kind, labels);
  busy = kind;
  Promise.resolve().then(() => fn(job)).then(() => {
    if (job.step >= 0 && job.steps[job.step].status === 'running') job.steps[job.step].status = 'done';
    job.status = 'done';
  }).catch((err) => {
    console.error(err);
    job.fail(); job.status = 'error'; job.error = err.message; job.log('err', err.message);
  }).finally(() => { busy = null; job.ms = Date.now() - job.started; });
  return { id: job.id };
}

app.get('/api/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'No such job' });
  const since = Math.max(0, parseInt(req.query.since, 10) || 0);
  res.json({ id: job.id, kind: job.kind, status: job.status, steps: job.steps, step: job.step, progress: job.progress,
             lines: job.lines.slice(since), next: job.lines.length, result: job.status === 'running' ? null : job.result,
             error: job.error, ms: job.ms || Date.now() - job.started });
});

// Run a command and stream its output into the job console.
function sh(job, cmd, args, { env = {}, cwd, input, quiet = false, filter, label } = {}) {
  return new Promise((resolve) => {
    if (!quiet) job.log('cmd', `$ ${label || [cmd, ...args].join(' ')}`);
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
    let out = '';
    const feed = (chunk) => {
      const text = chunk.toString();
      out += text;
      if (quiet) return;
      text.split(/\r?\n|\r/).forEach((line) => {
        if (!line.trim()) return;
        if (filter && filter(line) === false) return;
        job.log(/ERROR|FATAL|Exception|failed/i.test(line) && !/(Failed|Invalid) count: 0/.test(line) ? 'err' : 'out', line);
      });
    };
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', (e) => { out += String(e); resolve({ code: 127, out }); });
    p.on('close', (code) => resolve({ code, out }));
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
  });
}

// ======================================================================== tool wrappers

const PGENV = { PGPASSWORD: 'acme', PGOPTIONS: '-c client_min_messages=warning' };
const PSQL = {
  pg: (extra = []) => ['psql', ['-X', '-q', '-h', PG_HOST, '-p', '5432', '-U', 'acme', '-d', 'acme', ...extra]],
  epas: (extra = []) => ['edb-psql', ['-X', '-q', '-h', EPAS_HOST, '-p', '5444', '-U', 'acme', '-d', 'acme', ...extra]],
};

async function psqlCmd(job, engine, extra, opts = {}) {
  const [cmd, args] = PSQL[engine](extra);
  return sh(job, cmd, args, { env: PGENV, ...opts });
}

async function psqlQuiet(engine, sql) {
  const [cmd, args] = PSQL[engine](['-At', '-c', sql]);
  const r = await sh({ log() {} }, cmd, args, { env: PGENV, quiet: true });
  return r;
}

// Load a SQL file and collect every error it raises (the file is not allowed to stop at the first one).
async function loadFile(job, engine, name, text, { collapse = false } = {}) {
  const file = path.join(WORK, `${engine}-${name}`);
  const body = text.split('\n').filter((l) => !/^\\set ON_ERROR_STOP/.test(l)).join('\n');
  fs.writeFileSync(file, body);
  const [cmd, args] = PSQL[engine](['-v', 'ON_ERROR_STOP=0', '-f', file]);
  const r = await sh(job, cmd, args, { env: PGENV, quiet: true });
  const errors = parseErrors(r.out, body);
  job.log(errors.length ? 'err' : 'ok', `${name}: ${errors.length ? errors.length + ' error(s)' : 'loaded without errors'}`);
  const cascade = (e) => /relation ".*" does not exist/.test(e.message);
  const shown = collapse ? errors.filter((e) => !cascade(e)) : errors;
  shown.forEach((e) => job.log('err', `  line ${e.line}: ${e.object ? e.object + ': ' : ''}${e.message}`));
  const hidden = errors.length - shown.length;
  if (hidden > 0) job.log('sys', `  ...and ${hidden} more statements failed only because the objects above were never created`);
  return errors;
}

function parseErrors(out, body) {
  const lines = out.split('\n');
  const errors = [];
  lines.forEach((l, i) => {
    const m = l.match(/(?:^|:)(\d+): ERROR:\s+(.*)$/) || l.match(/^()ERROR:\s+(.*)$/);
    if (!m) return;
    const line = m[1] ? parseInt(m[1], 10) : null;
    const ctx = [];
    for (let j = i + 1; j < lines.length && !/ERROR:/.test(lines[j]) && ctx.length < 4; j++) ctx.push(lines[j]);
    errors.push({ line, message: m[2].trim(), context: ctx.join('\n').trim(), object: line ? objectAt(body, line) : null });
  });
  return errors;
}

function objectAt(body, line) {
  const src = body.split('\n');
  for (let i = Math.min(line, src.length) - 1; i >= 0; i--) {
    const m = src[i].match(/^\s*(?:CREATE|ALTER)\s+(?:OR REPLACE\s+)?(?:UNIQUE\s+)?(?:EDITIONABLE\s+)?(TABLE|VIEW|SEQUENCE|FUNCTION|PROCEDURE|TRIGGER|INDEX|SYNONYM|PACKAGE BODY|PACKAGE|SCHEMA|EXTENSION)\s+(?:IF NOT EXISTS\s+)?([\w."$]+)/i);
    if (m) return `${m[1].toLowerCase()} ${m[2].replace(/^acme\./, '')}`;
  }
  return null;
}

// ======================================================================== source + features

function readSql(name) { return fs.readFileSync(path.join(SQL_DIR, name), 'utf8'); }
const SQL_FILES = ['01_schema.sql', '02_plsql.sql', '03_data.sql'];

app.get('/api/source', (req, res) => send(res, async () => ({
  files: SQL_FILES.map((name) => ({ name, text: readSql(name) })),
})));

app.get('/api/features', (req, res) => send(res, async () => {
  const text = SQL_FILES.map(readSql).join('\n');
  return { features: scanFeatures(text) };
}));

app.get('/api/fixes', (req, res) => send(res, async () => {
  const text = fs.readFileSync(FIXES_FILE, 'utf8');
  const code = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('--'));
  return { text, codeLines: code.length };
}));

// ======================================================================== state + status

const TABLES = ['DEPARTMENTS', 'EMPLOYEES', 'CUSTOMERS', 'PRODUCTS', 'ORDERS', 'ORDER_ITEMS', 'AUDIT_LOG'];

async function oracleCounts() {
  return db.withOracle(async (c) => {
    const out = {};
    for (const t of TABLES) {
      const r = await c.execute(`SELECT COUNT(*) FROM ${t}`, [], { outFormat: db.OUT_ARRAY });
      out[t.toLowerCase()] = Number(r.rows[0][0]);
    }
    return out;
  });
}
async function targetCounts(engine) {
  return db.withPg(engine, async (c) => {
    const out = {};
    for (const t of TABLES) {
      try { out[t.toLowerCase()] = Number((await c.query(`SELECT COUNT(*) AS n FROM acme.${t.toLowerCase()}`)).rows[0].n); }
      catch (_) { out[t.toLowerCase()] = null; }
    }
    return out;
  });
}

async function compareRows(job, engine) {
  const [o, t] = [await oracleCounts(), await targetCounts(engine)];
  const rows = Object.keys(o).map((k) => ({ table: k, oracle: o[k], target: t[k], ok: o[k] === t[k] }));
  rows.forEach((r) => job.log(r.ok ? 'ok' : 'err', `  ${r.table.padEnd(12)} Oracle ${String(r.oracle).padStart(5)}   ${engine === 'pg' ? 'PostgreSQL' : 'EPAS      '} ${String(r.target ?? 'missing').padStart(5)}  ${r.ok ? 'match' : 'MISMATCH'}`));
  return rows;
}

app.get('/api/status', (req, res) => send(res, async () => {
  const settle = async (id) => {
    try { return { up: true, ...(await db.ping(id)), migrated: await db.schemaMigrated(id) }; }
    catch (e) { return { up: false, error: e.message }; }
  };
  const [oracle, pg, epas] = await Promise.all([settle('oracle'), settle('pg'), settle('epas')]);
  return { oracle, pg, epas, busy, ports: { pg: process.env.HOST_PG_PORT, epas: process.env.HOST_EPAS_PORT, oracle: process.env.HOST_ORACLE_PORT },
           last: {
             A: lastResult.A && { smoke: lastResult.A.smoke, fixed: !!lastResult.A_fixed },
             B: lastResult.B && { smoke: lastResult.B.smoke },
           } };
}));

app.get('/api/oracle/inventory', (req, res) => send(res, async () => db.withOracle(async (c) => {
  const o = await c.execute(
    `SELECT object_type AS t, COUNT(*) AS n, SUM(CASE WHEN status = 'INVALID' THEN 1 ELSE 0 END) AS invalid
     FROM user_objects GROUP BY object_type ORDER BY 1`);
  return { objects: o.rows.map((r) => ({ type: r.T, count: r.N, invalid: r.INVALID })), rows: await oracleCounts() };
})));

// ======================================================================== assessment (ora2pg)

function ora2pgConf({ copy = false } = {}) {
  const out = path.join(WORK, 'ora2pg');
  fs.mkdirSync(out, { recursive: true });
  const conf = [
    `ORACLE_DSN dbi:Oracle:host=${ORA_HOST};service_name=${ORA_SERVICE};port=${ORA_PORT}`,
    'ORACLE_USER acme', 'ORACLE_PWD acme', 'SCHEMA ACME',
    'EXPORT_SCHEMA 1', 'CREATE_SCHEMA 1',
    'USE_ORAFCE 1',            // let orafce provide NVL, DECODE, ADD_MONTHS, DBMS_OUTPUT ...
    'PACKAGE_AS_SCHEMA 1',     // order_pkg.order_total(...) keeps its Oracle call syntax
    'PG_VERSION 18',
    `OUTPUT_DIR ${out}`,
    `PG_DSN dbi:Pg:dbname=acme;host=${PG_HOST};port=5432`, 'PG_USER acme', 'PG_PWD acme',
    'DISABLE_TRIGGERS ALL',    // load data without tripping foreign keys
  ].join('\n') + '\n';
  const file = path.join(WORK, copy ? 'ora2pg-copy.conf' : 'ora2pg.conf');
  fs.writeFileSync(file, conf);
  return { file, out };
}

function parseReport(text) {
  const rows = [];
  const lines = text.split('\n');
  let inTable = false;
  for (const l of lines) {
    if (/^Object\tNumber\tInvalid/.test(l)) { inTable = true; continue; }
    if (inTable) {
      if (/^-{10,}/.test(l)) { if (rows.length) inTable = false; continue; }
      const c = l.split('\t');
      if (c.length >= 4 && c[0] && c[0] !== 'Total') {
        rows.push({ object: c[0], number: +c[1], invalid: +c[2], cost: +c[3], comments: (c[4] || '').trim(), details: (c[5] || '').trim() });
      }
    }
  }
  const tm = text.match(/^Total\t(\d+)\t(\d+)\t([\d.]+)\t(.*)$/m);
  if (tm) rows.total = { number: +tm[1], cost: +tm[3], comments: tm[4].trim() };
  const level = (text.match(/Migration level\s*:\s*(\S+)/) || [])[1] || null;
  const version = (text.match(/^Version\t(.*)$/m) || [])[1] || null;
  const size = (text.match(/^Size\t(.*)$/m) || [])[1] || null;
  const perFn = [];
  const re = /Function ([\w.]+) total estimated cost: ([\d.]+)\n((?:\t.*\n?)*)/g;
  let m;
  while ((m = re.exec(text))) {
    const items = m[3].split('\n').map((s) => s.trim()).filter((s) => s && !/^(TEST|SIZE) =>/.test(s));
    perFn.push({ name: m[1], cost: +m[2], drivers: items });
  }
  return { rows: rows.filter((r) => r.number > 0 || r.cost > 0), all: rows, total: rows.total || null, level, version, size, perFn };
}

app.post('/api/assess/run', (req, res) => send(res, async () => startJob('assess', ['Connect to Oracle', 'Scan schema objects', 'Estimate migration cost'], async (job) => {
  job.begin(0);
  const { file } = ora2pgConf();
  job.log('sys', 'ora2pg reads the Oracle data dictionary and parses every stored program it finds.');
  job.begin(1);
  job.log('cmd', '$ ora2pg -t SHOW_REPORT --estimate_cost');
  const r = await sh(job, 'ora2pg', ['-c', file, '-t', 'SHOW_REPORT', '--estimate_cost', '-q'], { quiet: true });
  job.begin(2);
  const report = r.out.replace(/\[[\d: -]+\] \[[=> ]*\][^\n\r]*[\r\n]?/g, '').trim();
  const parsed = parseReport(report);
  if (!parsed.rows.length) throw new Error('ora2pg did not return a report:\n' + report.slice(0, 600));
  report.split('\n').slice(0, 24).forEach((l) => job.log('out', l));
  job.log('ok', `Migration level ${parsed.level}; ${parsed.total ? parsed.total.comments : ''}`);
  lastResult.assess = { ...parsed, report };
  job.result = lastResult.assess;
})));

app.get('/api/assess/last', (req, res) => res.json(lastResult.assess || {}));
app.get('/api/last', (req, res) => res.json(lastResult));

// ======================================================================== compare runner

function normalize(res) {
  const norm = (v) => {
    if (v === null || v === undefined) return 'NULL';
    let s = String(v).trim();
    if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) return String(Math.round(Number(s) * 1e6) / 1e6);
    s = s.replace(/ 00:00:00$/, '');
    return s;
  };
  return (res.rows || []).slice(0, 60).map((r) => (res.fields || []).map((f) => norm(r[f])).join('|')).join('\n');
}

function verdict(oracle, res) {
  if (!res) return 'none';
  if (res.skipped) return 'skipped';
  if (!res.ok) return 'error';
  if (!oracle || !oracle.ok) return 'ok';
  return normalize(res) === normalize(oracle) ? 'same' : 'diff';
}

async function runSteps(engine, steps, { output = false, noSandbox = false } = {}) {
  const t0 = Date.now();
  if (engine === 'oracle') {
    let c;
    try {
      c = await db.withOracleConn();
      if (output) await c.execute('BEGIN DBMS_OUTPUT.ENABLE(NULL); END;');
      let last = null;
      for (const s of steps) {
        if (/^ROLLBACK$/i.test(s.trim())) { await c.rollback(); continue; }
        const r = await c.execute(db.oracleSql(s), [], { autoCommit: false, outFormat: db.OUT_ARRAY });
        if (r.metaData) last = r;
      }
      const fields = (last && last.metaData || []).map((m) => m.name);
      const rows = db.shape(fields, (last && last.rows) || []);
      const out = output ? await db.oracleOutput(c) : [];
      await c.rollback().catch(() => {});
      return { ok: true, fields, rows, output: out, ms: Date.now() - t0 };
    } catch (err) {
      return { ok: false, error: db.cleanError(err), ms: Date.now() - t0 };
    } finally { if (c) await c.close().catch(() => {}); }
  }
  let c;
  try {
    c = await db.pgClient(engine);
    if (output) { try { await c.query('SELECT dbms_output.serveroutput(true)'); } catch (_) { /* no such package */ } }
    await c.query('BEGIN');
    let last = null;
    try {
      c.notices.length = 0;
      for (const s of steps) {
        let r = await c.query(s);
        if (Array.isArray(r)) r = r[r.length - 1];
        if (/^\s*(SELECT|WITH|VALUES|TABLE)/i.test(s) || (r.fields && r.fields.length)) last = r;
      }
    } finally { await c.query('ROLLBACK').catch(() => {}); }
    const fields = last ? last.fields.map((f) => f.name) : [];
    return { ok: true, fields, rows: last ? db.shape(fields, last.rows) : [], output: [...c.notices], ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: db.cleanError(err), output: c ? [...c.notices] : [], ms: Date.now() - t0 };
  } finally { if (c) await c.end().catch(() => {}); }
}

async function runPreset(p, engines = ['oracle', 'pg', 'epas']) {
  const token = Math.random().toString(36).slice(2, 10);
  const sub = (list) => list.map((s) => s.replace(/\{\{token\}\}/g, token));
  const steps = sub(p.steps);
  const opts = { output: !!p.output, noSandbox: !!p.noSandbox };
  const out = { id: p.id };
  const migrated = {};
  for (const e of ['pg', 'epas']) if (engines.includes(e) && p.migrated) migrated[e] = await db.schemaMigrated(e);

  if (engines.includes('oracle')) out.oracle = await runSteps('oracle', steps, opts);
  for (const e of ['pg', 'epas']) {
    if (!engines.includes(e)) continue;
    if (p.migrated && !migrated[e]) { out[e] = { skipped: true, error: 'Not migrated yet: run a migration first.' }; continue; }
    out[e] = await runSteps(e, steps, opts);
  }
  if (engines.includes('pg') && p.pgRewrite && !(p.migrated && !migrated.pg)) {
    out.pgRewrite = await runSteps('pg', sub(p.pgRewrite), opts);
  }
  if (p.cleanup) {
    for (const e of engines) {
      if (e !== 'oracle' && p.migrated && !migrated[e]) continue;
      for (const c of sub(p.cleanup)) await db.run(e, c);
    }
  }
  const volatile = !!p.volatile;
  const v = (res) => { const x = verdict(out.oracle, res); return volatile && (x === 'diff') ? 'same' : x; };
  out.verdict = { pg: v(out.pg), pgRewrite: out.pgRewrite ? v(out.pgRewrite) : null, epas: v(out.epas) };
  return out;
}

app.get('/api/compare/presets', (req, res) => res.json({
  presets: PRESETS.map(({ id, group, title, why, steps, pgRewrite, migrated, volatile, output }) =>
    ({ id, group, title, why, steps, pgRewrite: pgRewrite || null, migrated: !!migrated, volatile: !!volatile, output: !!output })),
}));

app.post('/api/compare/run', (req, res) => send(res, async () => {
  const p = PRESETS.find((x) => x.id === req.body.id);
  if (!p) { const e = new Error('Unknown preset'); e.status = 404; throw e; }
  return runPreset(p);
}));

// The "objects" presets, scored against one target, as used by the migration verify steps.
async function smoke(job, engine) {
  const items = [];
  for (const p of PRESETS.filter((x) => x.group === 'objects')) {
    const r = await runPreset(p, ['oracle', engine]);
    const asis = r.verdict[engine];
    const rew = engine === 'pg' ? r.verdict.pgRewrite : null;
    const pass = asis === 'same' || rew === 'same';
    const how = asis === 'same' ? 'unchanged' : (rew === 'same' ? 'after rewrite' : null);
    let detail = '';
    if (!pass) {
      const res = (engine === 'pg' && r.pgRewrite) ? r.pgRewrite : r[engine];
      detail = res && !res.ok ? res.error : 'runs, but the result differs from Oracle';
      if (engine === 'pg' && r.pgRewrite && r.pgRewrite.ok) detail = 'runs after the rewrite, but the result differs from Oracle';
    }
    items.push({ id: p.id, title: p.title, pass, how, verdict: asis, rewriteVerdict: rew, detail });
    job.log(pass ? 'ok' : 'err', `  ${pass ? 'PASS' : 'FAIL'}  ${p.title}${how ? ' (' + how + ')' : ''}${detail ? '\n        ' + detail.split('\n')[0].slice(0, 150) : ''}`);
  }
  return { pass: items.filter((i) => i.pass).length, total: items.length, items };
}

// ======================================================================== path A: ora2pg + orafce

const EXPORT_TYPES = [
  ['TABLE', 'table.sql'], ['SEQUENCE', 'sequence.sql'], ['SYNONYM', 'synonym.sql'], ['VIEW', 'view.sql'],
  ['PACKAGE', 'package.sql'], ['FUNCTION', 'function.sql'], ['PROCEDURE', 'procedure.sql'], ['TRIGGER', 'trigger.sql'],
];

async function resetPg(job) {
  const cmds = ['DROP SCHEMA IF EXISTS acme CASCADE', 'DROP SCHEMA IF EXISTS order_pkg CASCADE', 'ALTER DATABASE acme RESET ALL',
    // the baseline ora2pg itself assumes: the target schema first, then orafce's oracle schema
    'ALTER DATABASE acme SET search_path = acme, oracle, public'];
  for (const c of cmds) {
    job.log('cmd', `postgres> ${c};`);
    const r = await psqlQuiet('pg', c);
    if (r.code !== 0) throw new Error(r.out);
  }
}

app.post('/api/patha/run', (req, res) => send(res, async () => startJob('pathA',
  ['Reset target', 'Export schema (ora2pg)', 'Load tables', 'Copy data (ora2pg)', 'Load views, code and triggers', 'Verify against Oracle'], async (job) => {
  lastResult.A_fixed = null;
  const result = { export: [], load: [], rows: [], smoke: null };

  job.begin(0);
  await resetPg(job);

  job.begin(1);
  const { file, out } = ora2pgConf();
  fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  for (const [type, f] of EXPORT_TYPES) {
    const t0 = Date.now();
    job.log('cmd', `$ ora2pg -t ${type} -o ${f}`);
    const r = await sh(job, 'ora2pg', ['-c', file, '-t', type, '-o', f, '-q'], { quiet: true });
    const p = path.join(out, f);
    if (!fs.existsSync(p)) throw new Error(`ora2pg did not write ${f}:\n${r.out.slice(0, 500)}`);
    const text = fs.readFileSync(p, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('--')).length;
    result.export.push({ type, file: f, lines, seconds: +((Date.now() - t0) / 1000).toFixed(1) });
    job.log('out', `  ${f}: ${lines} lines of SQL generated`);
  }
  const text = (f) => fs.readFileSync(path.join(out, f), 'utf8');

  job.begin(2);
  const tableErrors = await loadFile(job, 'pg', 'table.sql', text('table.sql'));
  result.load.push({ type: 'TABLE', file: 'table.sql', errors: tableErrors });

  job.begin(3);
  job.log('sys', 'Data goes in before the triggers exist, otherwise they would rewrite the migrated rows.');
  const { file: copyConf } = ora2pgConf({ copy: true });
  const cp = await sh(job, 'ora2pg', ['-c', copyConf, '-t', 'COPY', '-q'], { label: 'ora2pg -t COPY   (direct load into PostgreSQL)', filter: (l) => !/^SET |^NOTICE:|^$/.test(l) });
  if (cp.code !== 0 || /FATAL/.test(cp.out)) throw new Error('Data copy failed:\n' + cp.out.slice(-600));
  job.log('ok', 'Data copied.');

  job.begin(4);
  for (const [type, f] of EXPORT_TYPES.slice(1)) {
    const errs = await loadFile(job, 'pg', f, text(f));
    result.load.push({ type, file: f, errors: errs });
  }

  job.begin(5);
  job.log('sys', 'Row counts, then every migrated object is exercised and compared with Oracle (each in a rolled-back session).');
  result.rows = await compareRows(job, 'pg');
  result.smoke = await smoke(job, 'pg');
  job.log(result.smoke.pass === result.smoke.total ? 'ok' : 'err', `${result.smoke.pass} of ${result.smoke.total} migrated objects behave like Oracle.`);
  lastResult.A = result;
  job.result = result;
})));

app.post('/api/patha/fixes', (req, res) => send(res, async () => startJob('pathA-fixes',
  ['Apply the manual fixes', 'Verify against Oracle'], async (job) => {
  if (!lastResult.A) throw new Error('Run the ora2pg migration first.');
  job.begin(0);
  const fix = fs.readFileSync(FIXES_FILE, 'utf8');
  const errs = await loadFile(job, 'pg', 'pg-manual-fixes.sql', fix);
  if (errs.length) throw new Error('The fixes did not apply cleanly.');
  job.begin(1);
  const result = { rows: await compareRows(job, 'pg'), smoke: await smoke(job, 'pg') };
  job.log(result.smoke.pass === result.smoke.total ? 'ok' : 'err', `${result.smoke.pass} of ${result.smoke.total} migrated objects behave like Oracle.`);
  lastResult.A_fixed = result;
  job.result = result;
})));

// ======================================================================== path B: EPAS

async function resetEpas(job) {
  for (const c of ['DROP SCHEMA IF EXISTS acme CASCADE']) {
    job.log('cmd', `epas> ${c};`);
    const r = await psqlQuiet('epas', c);
    if (r.code !== 0) throw new Error(r.out);
  }
}

function parseMtkSummary(out) {
  const objects = [];
  const block = out.split('Migration Summary')[1] || '';
  block.split('\n').forEach((l) => {
    const m = l.match(/^(\w[\w ]*): (\d+) out of (\d+)/);
    if (m) objects.push({ name: m[1], ok: +m[2], total: +m[3] });
  });
  const g = (re) => +((block.match(re) || [])[1] || 0);
  return { objects, total: g(/Total objects:\s*(\d+)/), ok: g(/Successful count:\s*(\d+)/), failed: g(/Failed count:\s*(\d+)/), invalid: g(/Invalid count:\s*(\d+)/) };
}

app.post('/api/pathb/mtk', (req, res) => send(res, async () => startJob('pathB',
  ['Reset target', 'Migrate schema and data (EDB Migration Toolkit)', 'Verify against Oracle'], async (job) => {
  const result = { mtk: null, rows: [], smoke: null };
  job.begin(0);
  await resetEpas(job);

  job.begin(1);
  const props = [
    `SRC_DB_URL=jdbc:oracle:thin:@//${ORACLE_CONNECT}`, 'SRC_DB_USER=acme', 'SRC_DB_PASSWORD=acme',
    `TARGET_DB_URL=jdbc:edb://${EPAS_HOST}:5444/acme`, 'TARGET_DB_USER=acme', 'TARGET_DB_PASSWORD=acme',
  ].join('\n') + '\n';
  fs.writeFileSync('/usr/edb/migrationtoolkit/etc/toolkit.properties', props);
  let rows = 0;
  const r = await sh(job, '/usr/edb/migrationtoolkit/bin/runMTK.sh', ['-targetSchema', 'acme', '-fastCopy', 'ACME'], {
    cwd: '/usr/edb/migrationtoolkit/bin', label: 'runMTK.sh -targetSchema acme -fastCopy ACME',
    filter: (l) => {
      const m = l.match(/Migrated (\d+) rows\./);
      if (m) { rows++; if (rows % 500 === 0) job.progress = { label: `${rows} rows copied` }; return false; }
      return !/^(conn|user|password)\s*=/.test(l);
    },
  });
  result.mtk = parseMtkSummary(r.out);
  if (r.code !== 0 || !result.mtk.total) throw new Error('Migration Toolkit failed:\n' + r.out.slice(-800));
  job.log(result.mtk.failed ? 'err' : 'ok', `${result.mtk.ok} of ${result.mtk.total} objects migrated, ${result.mtk.failed} failed.`);

  job.begin(2);
  job.log('sys', 'Row counts, then every migrated object is exercised and compared with Oracle (each in a rolled-back session).');
  result.rows = await compareRows(job, 'epas');
  result.smoke = await smoke(job, 'epas');
  job.log(result.smoke.pass === result.smoke.total ? 'ok' : 'err', `${result.smoke.pass} of ${result.smoke.total} migrated objects behave like Oracle.`);
  lastResult.B = result;
  job.result = result;
})));

// "Just try it": replay the Oracle scripts as written, no conversion tool at all.
const NO_SQLPLUS = (t) => t.split('\n').filter((l) => !/^(CONNECT\s+\w+\/|WHENEVER|SET DEFINE|EXIT\b)/i.test(l)).join('\n');
const ADJUST = (t) => t
  .replace(/VARCHAR2\((\d+)\s+CHAR\)/gi, 'VARCHAR2($1)')
  .replace(/DBMS_STATS\.GATHER_SCHEMA_STATS\('ACME'\);/gi, "NULL; -- DBMS_STATS does not exist in EPAS: ANALYZE instead");

app.post('/api/pathb/replay', (req, res) => send(res, async () => startJob('pathB-replay',
  ['Reset target', 'Run the Oracle scripts exactly as written', 'Make the adjustments and run again', 'Verify against Oracle'], async (job) => {
  const result = { first: [], second: [], rows: [], smoke: null, adjustments: [] };
  job.begin(0);
  await resetEpas(job);
  await psqlQuiet('epas', 'CREATE SCHEMA acme');

  const runAll = async (transform, label) => {
    const all = [];
    for (const f of SQL_FILES) {
      const errs = await loadFile(job, 'epas', f, transform(NO_SQLPLUS(readSql(f))), { collapse: true });
      all.push({ file: f, errors: errs });
    }
    return all;
  };

  job.begin(1);
  job.log('sys', 'The only edit: the sqlplus-only lines (CONNECT, WHENEVER, EXIT) are dropped. The SQL itself is untouched.');
  result.first = await runAll((t) => t);
  const all1 = result.first.flatMap((f) => f.errors.map((e) => ({ ...e, file: f.file })));
  const roots = all1.filter((e) => !/relation ".*" does not exist/.test(e.message));
  const n1 = all1.length;
  result.firstSummary = { total: n1, cascaded: n1 - roots.length, roots: roots.map((e) => ({ file: e.file, line: e.line, object: e.object, message: e.message })) };
  job.log(n1 ? 'err' : 'ok', `${n1} error(s) on the first run, from ${roots.length} root cause(s).`);

  job.begin(2);
  result.adjustments = [
    { from: 'VARCHAR2(40 CHAR)', to: 'VARCHAR2(40)', why: 'EPAS has no BYTE/CHAR length qualifier on VARCHAR2' },
    { from: "DBMS_STATS.GATHER_SCHEMA_STATS('ACME')", to: 'removed (use ANALYZE)', why: 'EPAS has no DBMS_STATS package' },
  ];
  result.adjustments.forEach((a) => job.log('sys', `  adjust: ${a.from}  ->  ${a.to}`));
  await resetEpas(job);
  await psqlQuiet('epas', 'CREATE SCHEMA acme');
  result.second = await runAll(ADJUST);
  const n2 = result.second.reduce((a, f) => a + f.errors.length, 0);
  job.log(n2 ? 'err' : 'ok', `${n2} error(s) after ${result.adjustments.length} adjustments.`);

  job.begin(3);
  result.rows = await compareRows(job, 'epas');
  result.smoke = await smoke(job, 'epas');
  job.log(result.smoke.pass === result.smoke.total ? 'ok' : 'err', `${result.smoke.pass} of ${result.smoke.total} migrated objects behave like Oracle.`);
  lastResult.B_replay = result;
  job.result = result;
})));

// ======================================================================== reset + SQL console

app.post('/api/reset', (req, res) => send(res, async () => {
  if (busy) { const e = new Error(`Busy: ${busy}`); e.status = 409; throw e; }
  const job = { log() {} };
  await resetPg(job); await resetEpas(job);
  lastResult.A = lastResult.A_fixed = lastResult.B = lastResult.B_replay = null;
  return { ok: true };
}));

const SQL_TARGETS = [
  { id: 'oracle', label: 'Oracle (source)' },
  { id: 'pg', label: 'PostgreSQL + orafce (path A)' },
  { id: 'epas', label: 'EPAS, Oracle-compatible mode (path B)' },
];
app.get('/api/sql/targets', (req, res) => res.json({ targets: SQL_TARGETS }));

app.post('/api/sql/run', (req, res) => send(res, async () => {
  const target = SQL_TARGETS.find((t) => t.id === req.body.target) ? req.body.target : 'oracle';
  const sql = String(req.body.sql || '').trim();
  if (!sql) return { ok: false, error: 'No SQL to run.' };
  const t0 = Date.now();
  if (target !== 'oracle' && sql.startsWith('\\')) {
    // psql meta-commands can run shell commands (\\!), write files (\\o, \\copy) and more: only the
    // read-only "describe" family is allowed here.
    if (!/^\\(d\S*|l\S*|conninfo|z|sf\S*|sv\S*)(\s|$)/.test(sql) || /[\n;]/.test(sql.trim())) {
      return { ok: false, error: 'Only read-only psql describe commands are allowed here (\\d, \\d+ name, \\dx, \\df, \\l, \\conninfo ...).' };
    }
    const [cmd, args] = PSQL[target](['-c', sql]);
    const r = await sh({ log() {} }, cmd, args, { env: PGENV, quiet: true });
    return { ok: r.code === 0, raw: r.out, error: r.code === 0 ? undefined : r.out, ms: Date.now() - t0 };
  }
  const withOutput = /dbms_output|BEGIN|DO\s+\$/i.test(sql);
  return db.run(target, sql, { dbmsOutput: withOutput });
}));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Oracle compatibility lab on :${PORT}`));
