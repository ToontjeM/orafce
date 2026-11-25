'use strict';

// ============================================================ helpers

const $ = (sel) => document.querySelector(sel);
const $all = (sel) => Array.from(document.querySelectorAll(sel));
const esc = (v) => (v === null || v === undefined ? '' : String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}
function setStatus(el, text, cls) { el.textContent = text; el.className = 'status-line' + (cls ? ` ${cls}` : ''); }
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ============================================================ tabs

function showView(view) {
  $all('.tab-rail button[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $all('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'scorecard') renderScorecard();
  if (view === 'bench') loadBench();
}
function initTabs() {
  $all('.tab-rail button[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-goto]');
    if (a) { e.preventDefault(); showView(a.dataset.goto); }
  });
}

// ============================================================ status chips + global busy

let lastStatus = null;
let jobRunning = false;

function renderStatus(st) {
  lastStatus = st;
  const chip = (name, s, extra) => {
    const on = s && s.up;
    const ver = on ? (s.version || '').replace(/Oracle (AI )?Database /, '').replace(/ Release.*/, '').replace(/ \(Debian.*|\(Enterprise.*/, '') : (s && s.error ? 'down' : '');
    return `<span class="status-chip ${on ? 'on' : 'off'}${on && s.migrated && extra ? ' mig' : ''}"><span class="dot"></span><b>${name}</b><small>${esc(ver)}</small>${on && extra && s.migrated ? '<span class="mig-tag">migrated</span>' : ''}</span>`;
  };
  $('#status-strip').innerHTML =
    chip('Oracle', st.oracle) + chip('PG + orafce', st.pg, true) + chip('EPAS', st.epas, true);
  const p = st.ports || {};
  $('#connect-info').innerHTML =
    `Connect from your own tools: <code>psql -h localhost -p ${esc(p.pg || 5432)} -U acme acme</code> (PostgreSQL + orafce), ` +
    `<code>psql -h localhost -p ${esc(p.epas || 5444)} -U acme acme</code> (EPAS), Oracle on <code>localhost:${esc(p.oracle || 1521)}/FREEPDB1</code>. User and password are both <code>acme</code>.`;
  updateButtons();
}
async function refreshStatus() {
  try { renderStatus(await api('GET', '/api/status')); } catch (_) { /* server restarting */ }
}

function updateButtons() {
  const migratedA = lastStatus && lastStatus.pg && lastStatus.pg.migrated && !!lastStatus.last.A;
  ['#assess-btn', '#a-run', '#b-run', '#b-replay', '#bench-run-all', '#reset-btn'].forEach((s) => { const b = $(s); if (b) b.disabled = jobRunning; });
  $('#a-fix').disabled = jobRunning || !migratedA || (lastStatus && lastStatus.last.A && lastStatus.last.A.fixed);
}

// ============================================================ generic job runner (live console)

function consoleLine(job, l) {
  const cls = { cmd: 'c-cmd', step: 'c-step', ok: 'c-ok', err: 'c-err', sys: 'c-sys', out: 'c-out' }[l.t] || 'c-out';
  return `<span class="${cls}">${esc(l.s)}\n</span>`;
}

function renderStepper(el, steps) {
  el.innerHTML = steps.map((s, i) => `<li class="step ${s.status}"><span class="step-dot">${s.status === 'done' ? '&#10003;' : s.status === 'failed' ? '!' : i + 1}</span><span class="step-label">${esc(s.label)}</span></li>`).join('');
}

async function runJob(endpoint, ui) {
  const { id } = await api('POST', endpoint);
  jobRunning = true; updateButtons();
  ui.stage.hidden = false;
  ui.console.innerHTML = '';
  if (ui.result) { ui.result.classList.remove('show'); ui.result.innerHTML = ''; }
  let since = 0;
  try {
    for (;;) {
      const j = await api('GET', `/api/job/${id}?since=${since}`);
      if (ui.stepper) renderStepper(ui.stepper, j.steps);
      if (ui.progress) ui.progress.textContent = j.progress ? j.progress.label : ' ';
      if (j.lines.length) {
        const c = ui.console;
        const stick = c.scrollTop + c.clientHeight >= c.scrollHeight - 30;
        c.insertAdjacentHTML('beforeend', j.lines.map((l) => consoleLine(j, l)).join(''));
        if (stick) c.scrollTop = c.scrollHeight;
      }
      since = j.next;
      if (j.status !== 'running') return j;
      await sleep(600);
    }
  } finally {
    jobRunning = false;
    await refreshStatus();
  }
}

function wireScrollButtons() {
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-scroll]');
    if (!b) return;
    const [id, dir] = b.dataset.scroll.split(':');
    const el = document.getElementById(id);
    el.scrollTo({ top: dir === 'top' ? 0 : el.scrollHeight, behavior: 'smooth' });
  });
}

// ============================================================ intro

async function loadInventory() {
  try {
    const inv = await api('GET', '/api/oracle/inventory');
    const n = (t) => (inv.objects.find((o) => o.type === t) || { count: 0 }).count;
    const rows = Object.values(inv.rows).reduce((a, b) => a + b, 0);
    const items = [
      [n('TABLE'), 'tables'], [rows.toLocaleString(), 'rows'], [n('VIEW'), 'views'], [n('SEQUENCE'), 'sequences'],
      [n('PACKAGE'), 'package (7 subprograms)'], [n('TRIGGER'), 'triggers'], [n('FUNCTION') + n('PROCEDURE'), 'standalone routines'], [n('SYNONYM'), 'synonym'],
    ];
    $('#inventory').innerHTML = items.map(([v, l]) => `<div class="inv-item"><b>${v}</b><span>${l}</span></div>`).join('');
  } catch (e) { $('#inventory').innerHTML = `<div class="op-log-empty">Oracle is not reachable yet: ${esc(e.message)}</div>`; }
}

// ============================================================ assess

const HL = new RegExp('(' + [
  '\\bCONNECT\\s+BY\\b', '\\bSTART\\s+WITH\\b', '\\bPRIOR\\b', '\\bROWNUM\\b', '\\(\\+\\)', '\\bDECODE\\b', '\\bNVL2?\\b', '\\bSYS(?:DATE|TIMESTAMP)\\b',
  '\\bVARCHAR2\\b', '\\bNUMBER\\b', '\\bCLOB\\b', '\\bFROM\\s+dual\\b', '\\b\\w+\\.(?:NEXTVAL|CURRVAL)\\b', '\\bSYNONYM\\b',
  '\\bPACKAGE(?:\\s+BODY)?\\b', '\\bAUTONOMOUS_TRANSACTION\\b', '\\bBULK\\s+COLLECT\\b', '\\bFORALL\\b', '\\bDBMS_\\w+', '\\bRAISE_APPLICATION_ERROR\\b',
  '\\bADD_MONTHS\\b', '\\bMONTHS_BETWEEN\\b', '\\bSYS_CONNECT_BY_PATH\\b', '\\bLEVEL\\b', '%(?:TYPE|ROWTYPE)\\b', '\\bSYS_REFCURSOR\\b', '\\bNUMTODSINTERVAL\\b',
].join('|') + ')', 'gi');

function highlightSql(text) {
  return text.split('\n').map((line, i) => {
    const body = /^\s*--/.test(line) ? `<span class="cm">${esc(line)}</span>` : esc(line).replace(HL, '<mark>$1</mark>');
    return `<span class="l"><span class="ln">${i + 1}</span>${body}</span>`;
  }).join('');
}

let sourceFiles = [];
async function loadSource() {
  try {
    sourceFiles = (await api('GET', '/api/source')).files;
    $('#file-tabs').innerHTML = sourceFiles.map((f, i) => `<button data-file="${i}" class="${i === 0 ? 'active' : ''}">${esc(f.name)}</button>`).join('');
    const show = (i) => {
      $all('#file-tabs button').forEach((b) => b.classList.toggle('active', +b.dataset.file === i));
      $('#source-code').innerHTML = highlightSql(sourceFiles[i].text);
      $('#source-code').scrollTop = 0;
    };
    $all('#file-tabs button').forEach((b) => b.addEventListener('click', () => show(+b.dataset.file)));
    show(0);
  } catch (e) { $('#source-code').textContent = e.message; }
}

async function loadFeatures() {
  try {
    const { features } = await api('GET', '/api/features');
    const lab = { native: 'works as written', auto: 'tool converts', orafce: 'orafce provides', manual: 'manual rewrite', gap: 'not supported' };
    $('#feature-table').innerHTML =
      '<tr><th>Construct</th><th>#</th><th>Route A &middot; ora2pg + orafce</th><th>Route B &middot; EPAS</th></tr>' +
      features.map((f) => `<tr>
        <td class="lab">${esc(f.label)}</td><td class="cnt">${f.count}</td>
        <td><span class="pill ${f.a.status}">${lab[f.a.status]}</span><span class="note">${esc(f.a.note)}</span></td>
        <td><span class="pill ${f.b.status}">${lab[f.b.status]}</span><span class="note">${esc(f.b.note)}</span></td></tr>`).join('');
  } catch (e) { $('#feature-table').innerHTML = `<tr><td>${esc(e.message)}</td></tr>`; }
}

function renderAssess(res) {
  const el = $('#assess-result');
  const total = res.total || {};
  const levelText = { A: 'Could run automatically', B: 'Needs code rewrite, up to 5 person-days', C: 'Needs code rewrite, more than 5 person-days' };
  const lv = (res.level || '').split('-');
  el.innerHTML = `
    <div class="grid-2" style="align-items:start">
      <div>
        <div class="score">
          <div class="level-badge"><b>${esc(res.level || '?')}</b><span>${esc(levelText[lv[0]] || '')}.<br>Technical level ${esc(lv[1] || '?')} of 5.</span></div>
          <div class="score-body"><div class="score-label">${esc(total.comments || '')}</div><div class="score-sub">${esc(res.version || '')} &middot; schema size ${esc(res.size || '')}</div></div>
        </div>
        <table class="data-table"><tr><th>Object</th><th>#</th><th>Cost units</th><th>What ora2pg says</th></tr>
        ${res.rows.map((r) => `<tr><td>${esc(r.object)}</td><td>${r.number}</td><td>${r.cost.toFixed(1)}</td><td style="font-family:var(--font-ui);white-space:normal;color:var(--text-muted);font-size:11.5px">${esc(r.comments.split('. ')[0])}${r.details ? `<br><span style="color:var(--text-dim)">${esc(r.details.slice(0, 160))}</span>` : ''}</td></tr>`).join('')}
        </table>
      </div>
      <div>
        <h4 style="margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted)">What drives the cost, per routine</h4>
        <table class="data-table"><tr><th>Routine</th><th>Cost</th><th>Drivers</th></tr>
        ${res.perFn.map((f) => `<tr><td>${esc(f.name)}</td><td>${f.cost}</td><td style="font-family:var(--font-ui);white-space:normal">${esc(f.drivers.join(', ') || '-')}</td></tr>`).join('')}
        </table>
        <div class="small-note">ora2pg's estimate (one unit = 5 minutes) covers <i>converting</i> the code. It does not price testing, and it did not predict the silent defects this lab found in Step 2: it rated this schema at roughly a person-day.</div>
      </div>
    </div>`;
  el.classList.add('show');
}

async function runAssess() {
  const j = await runJob('/api/assess/run', { stage: $('#assess-stage'), stepper: $('#assess-stepper'), console: $('#assess-console') });
  if (j.status === 'done' && j.result) renderAssess(j.result);
  else $('#assess-result').innerHTML = `<div class="status-line err">${esc(j.error || 'failed')}</div>`, $('#assess-result').classList.add('show');
}

// ============================================================ migrate: results

const meterClass = (p, t) => (p === t ? '' : p / t >= 0.6 ? 'warn' : 'bad');

function scoreBlock(label, pass, total, sub) {
  return `<div class="score"><div class="score-num">${pass}<small>/${total}</small></div><div class="score-body">
    <div class="score-label">${label}</div>${sub ? `<div class="score-sub">${sub}</div>` : ''}
    <div class="meter ${meterClass(pass, total)}"><i style="width:${Math.round((pass / total) * 100)}%"></i></div></div></div>`;
}

function smokeList(smoke) {
  return `<ul class="check-list">${smoke.items.map((i) => `<li><span class="mark ${i.pass ? 'ok' : 'bad'}">${i.pass ? '&#10003;' : '&#10007;'}</span>
    <span class="t">${esc(i.title)}${i.detail ? `<span class="why">${esc(i.detail.split('\n')[0].slice(0, 180))}</span>` : ''}</span>
    <span class="how">${esc(i.how || '')}</span></li>`).join('')}</ul>`;
}

function rowsLine(rows) {
  const ok = rows.every((r) => r.ok);
  const total = rows.reduce((a, r) => a + (r.target || 0), 0);
  return `<div class="score-sub" style="margin:4px 0 8px">${ok ? '&#10003;' : '&#10007;'} Data: ${total.toLocaleString()} rows in ${rows.length} tables, ${ok ? 'every row count matches Oracle' : 'row counts DO NOT match: ' + rows.filter((r) => !r.ok).map((r) => r.table).join(', ')}.</div>`;
}

function loadTable(load) {
  return `<table class="data-table"><tr><th>ora2pg output</th><th>Loaded into PostgreSQL</th></tr>${load.map((l) => `<tr><td>${esc(l.file)}</td><td style="font-family:var(--font-ui)">${l.errors.length
    ? `<span class="pill error">${plural(l.errors.length, 'error')}</span> <span class="muted" style="font-size:11.5px">${l.errors.map((e) => esc((e.object || 'statement') + ': ' + e.message)).join('; ')}</span>`
    : '<span class="pill same">loaded cleanly</span>'}</td></tr>`).join('')}</table>`;
}

let fixText = null;
async function renderA(res, fixed) {
  const el = $('#a-result');
  let html = '<h4>As converted by ora2pg</h4>';
  const nErr = res.load.reduce((a, l) => a + l.errors.length, 0);
  html += loadTable(res.load);
  html += `<div class="section-gap"></div>` + scoreBlock('migrated objects behave like Oracle', res.smoke.pass, res.smoke.total,
    `Only ${plural(nErr, 'statement')} raised an error while loading, yet <b>${res.smoke.total - res.smoke.pass} of ${res.smoke.total} objects are wrong when you actually use them</b>. Loading without errors proved little.`);
  html += rowsLine(res.rows);
  html += `<details class="fold" ${fixed ? '' : 'open'}><summary>Object by object</summary><div class="fold-body">${smokeList(res.smoke)}</div></details>`;

  if (fixed) {
    if (!fixText) { try { fixText = await api('GET', '/api/fixes'); } catch (_) { fixText = { text: '', codeLines: 0 }; } }
    html += '<h4>After the manual fixes</h4>';
    html += scoreBlock('migrated objects behave like Oracle', fixed.smoke.pass, fixed.smoke.total,
      `It took <b>${fixText.codeLines} lines of hand-written SQL</b> (<code>fixes/pg-manual-fixes.sql</code>) for a 50-object schema. Real estates scale from there.`);
    html += rowsLine(fixed.rows);
    html += `<details class="fold"><summary>What the fixes changed</summary><div class="fold-body"><pre class="code">${highlightSql(fixText.text)}</pre></div></details>`;
    html += `<details class="fold"><summary>Object by object, after the fixes</summary><div class="fold-body">${smokeList(fixed.smoke)}</div></details>`;
  } else {
    html += `<div class="small-note" style="margin-top:10px">Next: <b>2 &middot; Apply the manual fixes</b> applies the hand-written corrections and re-runs the same checks.</div>`;
  }
  el.innerHTML = html;
  el.classList.add('show');
}

function mtkTable(m) {
  return `<table class="data-table"><tr><th>Object type</th><th>Migrated</th></tr>${m.objects.map((o) => `<tr><td>${esc(o.name)}</td><td style="font-family:var(--font-ui)"><span class="pill ${o.ok === o.total ? 'same' : 'error'}">${o.ok} of ${o.total}</span></td></tr>`).join('')}</table>`;
}

function renderB(kind, res) {
  const el = $('#b-result');
  let html = '';
  if (kind === 'mtk') {
    html += '<h4>EDB Migration Toolkit</h4>';
    html += scoreBlock('objects migrated by one command', res.mtk.ok, res.mtk.total, `Tables, data, indexes, constraints, views, triggers, the PL/SQL package, procedure, function and synonym. ${res.mtk.failed} failed.`);
    html += mtkTable(res.mtk);
  } else {
    const f = res.firstSummary;
    html += '<h4>Run 1: the Oracle scripts, exactly as written</h4>';
    html += `<div class="score"><div class="score-num">${f.total}<small> errors</small></div><div class="score-body"><div class="score-label">from ${plural(f.roots.length, 'root cause')}</div><div class="score-sub">${f.cascaded} of them only because an earlier statement failed and its objects were never created.</div></div></div>`;
    html += `<ul class="error-list">${f.roots.map((r) => `<li><code>${esc(r.file)}:${r.line}</code> ${esc(r.object || '')}: ${esc(r.message)}</li>`).join('')}</ul>`;
    html += '<h4>Run 2: after two adjustments</h4>';
    const n2 = res.second.reduce((a, x) => a + x.errors.length, 0);
    html += `<ul class="check-list">${res.adjustments.map((a) => `<li><span class="mark ok">&#8594;</span><span class="t"><code>${esc(a.from)}</code> &rarr; <code>${esc(a.to)}</code><span class="why" style="color:var(--text-muted)">${esc(a.why)}</span></span></li>`).join('')}</ul>`;
    html += `<div class="score-sub" style="margin:6px 0 8px">${n2 === 0 ? '&#10003; The three scripts then ran without a single error.' : `${n2} error(s) remain.`}</div>`;
  }
  html += `<div class="section-gap"></div>` + scoreBlock('migrated objects behave like Oracle', res.smoke.pass, res.smoke.total,
    kind === 'mtk' ? 'No code was rewritten.' : 'Two one-line adjustments, no rewrite of any PL/SQL.');
  html += rowsLine(res.rows);
  html += `<details class="fold"><summary>Object by object</summary><div class="fold-body">${smokeList(res.smoke)}</div></details>`;
  el.innerHTML = html;
  el.classList.add('show');
}

function wireMigrate() {
  const A = { stage: $('#a-stage'), stepper: $('#a-stepper'), progress: $('#a-progress'), console: $('#a-console'), result: $('#a-result') };
  const B = { stage: $('#b-stage'), stepper: $('#b-stepper'), progress: $('#b-progress'), console: $('#b-console'), result: $('#b-result') };
  const guard = async (fn) => { try { await fn(); } catch (e) { alert(e.message); jobRunning = false; updateButtons(); } };

  $('#a-run').addEventListener('click', () => guard(async () => {
    const j = await runJob('/api/patha/run', A);
    if (j.status === 'done') { await renderA(j.result, null); await refreshStatus(); } else showJobError(A, j);
  }));
  $('#a-fix').addEventListener('click', () => guard(async () => {
    const j = await runJob('/api/patha/fixes', { ...A, result: null });
    if (j.status === 'done') { const last = await api('GET', '/api/last'); await renderA(last.A, j.result); await refreshStatus(); } else showJobError(A, j);
  }));
  $('#b-run').addEventListener('click', () => guard(async () => {
    const j = await runJob('/api/pathb/mtk', B);
    if (j.status === 'done') renderB('mtk', j.result); else showJobError(B, j);
  }));
  $('#b-replay').addEventListener('click', () => guard(async () => {
    const j = await runJob('/api/pathb/replay', B);
    if (j.status === 'done') renderB('replay', j.result); else showJobError(B, j);
  }));
}
function showJobError(ui, j) {
  ui.result.innerHTML = `<div class="status-line err">${esc(j.error || 'The job failed.')}</div>`;
  ui.result.classList.add('show');
}

async function restoreResults() {
  try {
    const last = await api('GET', '/api/last');
    if (last.A) { $('#a-stage').hidden = true; await renderA(last.A, last.A_fixed); }
    if (last.B_replay && !last.B) renderB('replay', last.B_replay);
    else if (last.B) renderB('mtk', last.B);
    if (last.assess && last.assess.rows) renderAssess(last.assess);
  } catch (_) { /* nothing yet */ }
}

// ============================================================ bench

let presets = [];
const benchResults = {};
let benchLoaded = false;

async function loadBench() {
  if (benchLoaded) return;
  benchLoaded = true;
  presets = (await api('GET', '/api/compare/presets')).presets;
  renderBench();
}

const VERDICT_TEXT = { same: 'same as Oracle', diff: 'differs', error: 'error', skipped: 'not migrated', ok: 'runs', none: '' };

function fmtVal(v) { return v === null || v === undefined ? 'NULL' : String(v); }
function resultBody(res) {
  if (!res) return '<span class="empty">not run</span>';
  if (res.skipped) return '<span class="empty">Run a migration in Step 2 first.</span>';
  if (!res.ok) return `<span class="err" title="${esc(res.error)}">${esc((res.error || '').split('\n')[0].slice(0, 170))}</span>`;
  let h = '';
  const rows = res.rows || [];
  if (rows.length) {
    h += rows.slice(0, 4).map((r) => `<span class="row">${esc(res.fields.map((f) => fmtVal(r[f])).join(' · '))}</span>`).join('');
    if (rows.length > 4) h += `<span class="row empty">+ ${rows.length - 4} more rows</span>`;
  } else if (!(res.output && res.output.length)) h += '<span class="empty">ok, no rows</span>';
  (res.output || []).slice(0, 3).forEach((o) => { h += `<span class="out">${esc(o.replace(/^NOTICE:\s*/, ''))}</span>`; });
  return h;
}
function cell(label, res, verdict) {
  const v = verdict || (res ? (res.skipped ? 'skipped' : res.ok ? 'ok' : 'error') : 'none');
  return `<div class="cell ${v}"><div class="cell-h"><span>${label}</span>${res && res.ms !== undefined ? `<span class="ms">${res.ms} ms</span>` : ''}</div>
    ${v !== 'none' && res ? `<div style="margin-bottom:4px"><span class="pill ${v}">${VERDICT_TEXT[v] || v}</span></div>` : ''}
    <div class="cell-v">${resultBody(res)}</div></div>`;
}

function presetCard(p) {
  const r = benchResults[p.id];
  const rewrite = p.pgRewrite
    ? cell('PG, rewritten', r && r.pgRewrite, r && r.verdict.pgRewrite)
    : `<div class="cell"><div class="cell-h"><span>PG, rewritten</span></div><div class="cell-v"><span class="empty">${r ? (r.verdict.pg === 'same' ? 'not needed: it runs unchanged' : 'no rewrite defined') : 'only where PostgreSQL needs one'}</span></div></div>`;
  return `<div class="preset" id="preset-${p.id}">
    <div class="preset-head"><h4>${esc(p.title)}</h4>${p.migrated ? '<span class="badge">needs migrated schema</span>' : ''}<button class="btn run" data-run="${p.id}">Run</button></div>
    <p class="why">${esc(p.why)}</p>
    <div class="cells">${cell('Oracle', r && r.oracle, r && (r.oracle.ok ? 'ok' : 'error'))}${cell('PG + orafce, as-is', r && r.pg, r && r.verdict.pg)}${rewrite}${cell('EPAS', r && r.epas, r && r.verdict.epas)}</div>
    <details class="sql"><summary>Statement</summary><div class="lbl">Oracle (sent unchanged to all three)</div><pre>${esc(p.steps.join(';\n'))}</pre>${p.pgRewrite ? `<div class="lbl">PostgreSQL rewrite</div><pre>${esc(p.pgRewrite.join(';\n'))}</pre>` : ''}</details>
  </div>`;
}

function renderBench() {
  const groups = [['dialect', 'SQL your application sends'], ['objects', 'What the migrations produced (needs Step 2)']];
  $('#bench-list').innerHTML = groups.map(([g, title]) =>
    `<div class="group-title">${title}</div>${presets.filter((p) => p.group === g).map(presetCard).join('')}`).join('');
  $all('[data-run]').forEach((b) => b.addEventListener('click', () => runOne(b.dataset.run)));
  renderBenchScore();
}

function renderBenchScore() {
  const done = presets.filter((p) => benchResults[p.id]);
  const el = $('#bench-score');
  if (!done.length) {
    el.innerHTML = ['Oracle', 'PostgreSQL + orafce', 'EPAS'].map((n, i) => `<div class="card" style="--node-color:var(--color-node-${[4, 3, 1][i]})"><div class="l">${n}</div><div class="s">Press <b>Run all</b>.</div></div>`).join('');
    return;
  }
  const valid = (e) => done.filter((p) => benchResults[p.id].verdict[e] !== 'skipped');
  const pgs = valid('pg'), eps = valid('epas');
  const pgSame = pgs.filter((p) => benchResults[p.id].verdict.pg === 'same').length;
  const pgAfter = pgs.filter((p) => benchResults[p.id].verdict.pg === 'same' || benchResults[p.id].verdict.pgRewrite === 'same').length;
  const epSame = eps.filter((p) => benchResults[p.id].verdict.epas === 'same').length;
  const epDiff = eps.filter((p) => benchResults[p.id].verdict.epas === 'diff').length;
  const skipped = done.length - Math.min(pgs.length, eps.length);
  el.innerHTML = `
    <div class="card" style="--node-color:var(--color-node-4)"><div class="n">${done.length}<small> statements</small></div><div class="l">Oracle (the reference)</div><div class="s">Every verdict below is relative to what Oracle returned.</div></div>
    <div class="card" style="--node-color:var(--color-node-3)"><div class="n">${pgSame}<small>/${pgs.length}</small></div><div class="l">PG + orafce: run unchanged and agree with Oracle</div><div class="s">${pgAfter}/${pgs.length} agree once you rewrite the statement for PostgreSQL. ${pgAfter - pgSame} needed your edit${skipped ? `; ${skipped} skipped (not migrated)` : ''}.</div></div>
    <div class="card" style="--node-color:var(--color-node-1)"><div class="n">${epSame}<small>/${eps.length}</small></div><div class="l">EPAS: run unchanged and agree with Oracle</div><div class="s">${epDiff ? `${epDiff} ran but returned something different: the honest gaps. ` : ''}${eps.length - epSame - epDiff} failed outright.</div></div>`;
}

async function runOne(id) {
  const btn = document.querySelector(`[data-run="${id}"]`);
  if (btn) btn.disabled = true;
  try {
    benchResults[id] = await api('POST', '/api/compare/run', { id });
    const p = presets.find((x) => x.id === id);
    $(`#preset-${id}`).outerHTML = presetCard(p);
    document.querySelector(`[data-run="${id}"]`).addEventListener('click', () => runOne(id));
    renderBenchScore();
  } catch (e) { alert(e.message); }
  const b2 = document.querySelector(`[data-run="${id}"]`); if (b2) b2.disabled = false;
}

async function runAll() {
  await loadBench();
  $('#bench-run-all').disabled = true;
  let i = 0;
  for (const p of presets) {
    setStatus($('#bench-status'), `Running ${++i} of ${presets.length}: ${p.title}`, '');
    await runOne(p.id);
  }
  setStatus($('#bench-status'), `Done: ${presets.length} statements run on three engines.`, 'ok');
  $('#bench-run-all').disabled = false;
}

// ============================================================ scorecard + considerations

const ROWS = [
  { group: 'Compatibility' },
  { dim: 'SQL syntax and PL/SQL', small: 'ROWNUM, CONNECT BY, (+), MINUS, packages', edge: 'b',
    a: 'The PostgreSQL parser is unchanged. orafce adds functions and types, not syntax, so every Oracle-only construct has to be converted by ora2pg or rewritten by hand. PL/SQL becomes PL/pgSQL.',
    b: 'The server parses Oracle SQL and runs SPL / PL/SQL: packages, autonomous transactions, BULK COLLECT, hierarchical queries. Most code is moved as written.',
    obs: (l) => (l.A && l.B ? `Objects behaving like Oracle: ${l.A.smoke.pass}/${l.A.smoke.total} on Route A as converted, ${l.B.smoke.pass}/${l.B.smoke.total} on EPAS.` : '') },
  { dim: 'Built-in Oracle packages', small: 'DBMS_*, UTL_*', edge: 'b',
    a: 'orafce ships a useful subset: DBMS_OUTPUT, DBMS_PIPE, DBMS_ALERT, DBMS_RANDOM, DBMS_UTILITY, DBMS_ASSERT, DBMS_SQL, UTL_FILE and the PLV* helpers. Anything else needs another extension, a rewrite, or application code.',
    b: 'A much broader set is built into the server, for example DBMS_LOB, DBMS_SCHEDULER, DBMS_JOB, DBMS_CRYPTO, DBMS_AQ, UTL_HTTP, UTL_SMTP and UTL_MAIL, next to the common ones.' },
  { dim: 'Data semantics', small: "'' vs NULL, DATE with time, || and NULL", edge: 'b',
    a: "PostgreSQL semantics apply: '' is not NULL, 'a' || NULL is NULL, DATE has no time (ora2pg maps it to timestamp). orafce fixes some of this inside functions, not in the engine.",
    b: "Oracle-compatible mode covers much of it: DATE carries a time, || ignores NULL, SUBSTR(x,0,n) behaves like Oracle.",
    obs: () => "On EPAS here, '' IS NULL was still false, and date - date returned an interval, not a number." },
  { dim: 'Where neither is complete', small: 'RAC, Flashback, Oracle Text, APEX, Data Pump',
    a: 'Oracle-specific features have no direct equivalent. Both routes need an assessment of your real code, not of a sample.',
    b: 'The same list, a shorter one. EPAS is highly compatible, not identical.',
    obs: () => 'On EPAS here: VARCHAR2(n CHAR) is rejected and there is no DBMS_STATS package.' },

  { group: 'Migration effort' },
  { dim: 'Assessment', small: 'knowing what you are in for',
    a: "ora2pg's report is free, scores every object and estimates person-days for the conversion. It rates conversion effort only.",
    b: "EDB's Migration Portal assesses DDL and PL/SQL for EPAS compatibility; the Migration Toolkit then performs the move.",
    obs: (l) => (l.assess ? `ora2pg rated this schema ${l.assess.level}${l.assess.total ? ': ' + l.assess.total.comments.split('. ')[0] : ''}. Step 2 found far more than that to fix.` : '') },
  { dim: 'Automation', small: 'how far the tool gets you', edge: 'b',
    a: 'Converts a lot mechanically, but the output must be reviewed line by line. Function bodies load without being validated, and some defects are silent: a wrong numeric type, integer division.',
    b: 'The Migration Toolkit moves tables, data, views, triggers and PL/SQL objects in one run. Or replay the Oracle scripts with a few adjustments.',
    obs: (l) => (l.A ? `Route A: ${l.A.smoke.pass}/${l.A.smoke.total} as converted${l.A_fixed ? `, ${l.A_fixed.smoke.pass}/${l.A_fixed.smoke.total} after ${l.fixLines} lines of hand-written SQL` : ''}. ${l.B ? `EPAS via MTK: ${l.B.smoke.pass}/${l.B.smoke.total}, nothing rewritten.` : ''}` : '') },
  { dim: 'Testing burden', edge: 'b',
    a: "High. Every converted routine needs functional tests against Oracle's results, because \"it loaded\" proves little.",
    b: 'Lower, not zero. You still test against Oracle, and the semantic differences that remain (date arithmetic, empty strings) still bite.' },
  { dim: 'Application changes', small: 'SQL embedded in apps and ORMs', edge: 'b',
    a: 'ROWNUM, (+), sequence.NEXTVAL, PL/SQL blocks and package calls in application code have to be rewritten and retested. Drivers are the community ones.',
    b: 'Most application SQL runs unchanged, so the application change is largely connection and driver configuration.',
    obs: (l) => (l.bench ? `Statements that ran unchanged: PG + orafce ${l.bench.pgSame}/${l.bench.pgN}, EPAS ${l.bench.epSame}/${l.bench.epN}.` : '') },
  { dim: 'Data movement and downtime',
    a: 'ora2pg copies in parallel; it is a bulk load. A low-downtime cutover needs a separate change-data-capture tool.',
    b: 'The Migration Toolkit does the bulk load; EDB also offers replication tooling for low-downtime cutovers.' },

  { group: 'Cost and support' },
  { dim: 'License cost', edge: 'a',
    a: 'None. PostgreSQL, orafce and ora2pg are free, open-source software.',
    b: 'An EDB subscription.' },
  { dim: 'Engineering cost',
    a: 'Scales with the amount of PL/SQL and Oracle-specific SQL. What the license saves is paid in developer and tester time.',
    b: 'Usually lower for PL/SQL-heavy estates, because code is moved instead of rewritten. Confirm with an assessment of your own code.' },
  { dim: 'Support', small: 'who you call', edge: 'b',
    a: 'Community support for PostgreSQL and orafce; commercial support from any PostgreSQL vendor. ora2pg is maintained mainly by one author, with paid support from third parties. No single party owns the whole chain.',
    b: 'One vendor supports the database, the compatibility layer and the migration tooling, under an SLA.' },

  { group: 'Operations and risk' },
  { dim: 'Portability, lock-in', edge: 'a',
    a: 'Runs on any PostgreSQL, including managed cloud services that offer orafce (check each one for its extension list and version). Leaving later costs nothing extra.',
    b: 'Code that uses SPL packages and other EDB features does not run on community PostgreSQL. Leaving EPAS later is another migration.' },
  { dim: 'Enterprise features', edge: 'b',
    a: 'Whatever PostgreSQL and its extensions provide.',
    b: 'Adds EDB features such as Transparent Data Encryption, auditing, Dynatune, resource management and Oracle-style profiles.' },
  { dim: 'Long-term direction',
    a: 'You end with idiomatic PostgreSQL code and fewer Oracle-isms over time: the better place to be if the goal is to leave the Oracle way of working.',
    b: 'Gets you off Oracle quickly with little rewriting. Modernising towards standard PostgreSQL can happen gradually, if at all.' },
  { dim: 'Skills',
    a: 'Teams learn PL/pgSQL and PostgreSQL tooling.',
    b: 'Oracle developers and DBAs keep most of their SQL and PL/SQL skills. The operations side is still PostgreSQL.' },
];

const CHOICES = [
  { title: 'Choose orafce + ora2pg when', color: 'var(--color-node-3)', items: [
    'The estate is small, or mostly tables, views and plain SQL, with little PL/SQL.',
    'You are rewriting the application anyway and want idiomatic PostgreSQL at the end.',
    'You want community PostgreSQL, or a managed cloud PostgreSQL, and no database license fee.',
    'You have developers and testers with capacity, and PostgreSQL skills in the team.',
    'Portability across PostgreSQL providers matters more than speed.' ] },
  { title: 'Choose EPAS when', color: 'var(--color-node-1)', items: [
    'There is a lot of PL/SQL: packages, triggers, hierarchical queries, hundreds of procedures.',
    'The Oracle contract ends on a date, and you cannot rewrite and retest everything before it.',
    'Applications you do not control, or cannot afford to change, send Oracle SQL.',
    'You want one vendor accountable for the database, the compatibility and the migration.',
    'You also need enterprise features (encryption, auditing, profiles) in the same platform.' ] },
  { title: 'In practice, often both', color: 'var(--color-node-4)', items: [
    'Assess first: run the ora2pg report and the Migration Portal on your real schema, then compare.',
    'An estate is rarely uniform: simple schemas can take Route A while the PL/SQL-heavy core takes Route B.',
    'EPAS to move fast, then refactor the hot spots towards standard SQL over time.',
    'Either way: test against Oracle with real data and a real workload. This lab shows why.' ] },
];

const PITFALLS = [
  { who: ['A'], title: 'A NUMBER becomes bigint and the cents disappear',
    text: 'An unconstrained <code>NUMBER</code> was mapped to <code>bigint</code>. <code>order_pkg.order_total(10001)</code> returned <b>2488</b> instead of <b>2487.9</b>, with no error anywhere. The only defence is comparing results against Oracle.', tab: 'migrate' },
  { who: ['A'], title: 'Integer division turns a 5% raise into 0%',
    text: 'With <code>p_pct bigint</code>, <code>1 + p_pct / 100</code> is <code>1 + 0</code>. <code>give_raise(30, 5)</code> ran cleanly and changed nothing.', tab: 'bench' },
  { who: ['A'], title: '"It loaded" proves almost nothing',
    text: 'ora2pg writes <code>SET check_function_bodies = false</code>, so PL/pgSQL bodies are not validated at load time. The <code>BULK COLLECT</code> / <code>FORALL</code> procedure loaded fine and only failed when called.', tab: 'migrate' },
  { who: ['A'], title: 'Package constants and state have no home',
    text: 'PL/pgSQL has no package variables. ora2pg reads them from custom settings that nothing initialises: <code>unrecognized configuration parameter "order_pkg.c_vat_rate"</code>. And a call written as <code>order_pkg.orders_placed</code> (no parentheses) stops working.', tab: 'bench' },
  { who: ['A'], title: 'Load order: data first, triggers last',
    text: 'Load a trigger before the data and it rewrites the rows you are migrating (here, <code>ref_code</code> was regenerated). The lab loads tables, then data, then everything else.', tab: 'migrate' },
  { who: ['A'], title: 'The autonomous transaction needs a loopback connection',
    text: 'ora2pg emulates <code>PRAGMA AUTONOMOUS_TRANSACTION</code> through <code>dblink</code>. The generated wrapper called the wrong function and failed, and the loopback needs a connection the server will accept.', tab: 'bench' },
  { who: ['A'], title: 'orafce only overrides PostgreSQL if the search_path says so',
    text: "<code>SUBSTR('Oracle', 0, 3)</code> returned <b>Or</b> with the search_path ora2pg emits (<code>acme, oracle, public</code>) and <b>Ora</b> once <code>oracle</code> came before <code>pg_catalog</code>. Same extension, different answer. <code>NVL(NULL, 'x')</code> on untyped literals is ambiguous, too.", tab: 'bench' },
  { who: ['A', 'B'], title: "'' is not NULL, and no tool can fix that",
    text: "In Oracle an empty string is NULL. <code>'' IS NULL</code> was false on PostgreSQL and on EPAS in this lab. It changes what your data means, so it needs a review of your code, whichever route you take.", tab: 'bench', ok: true },
  { who: ['B'], title: 'EPAS returns an interval where Oracle returns a number',
    text: '<code>TRUNC(SYSDATE) - TRUNC(SYSDATE - 5)</code> is <b>5</b> in Oracle and <b>5 days</b> (an interval) in EPAS. Anything that does arithmetic on that result needs a look.', tab: 'bench', ok: true },
  { who: ['B'], title: 'Two things EPAS does not accept as written',
    text: '<code>VARCHAR2(40 CHAR)</code> (EPAS has no BYTE/CHAR length qualifier) and <code>DBMS_STATS</code> (use <code>ANALYZE</code>). Migration Toolkit maps the first for you; replaying scripts needs the edit.', tab: 'migrate', ok: true },
];

function labData() {
  const l = { A: null, A_fixed: null, B: null, B_replay: null, assess: null, fixLines: fixText ? fixText.codeLines : 0, bench: null };
  Object.assign(l, window.__last || {});
  const done = presets.filter((p) => benchResults[p.id]);
  if (done.length) {
    const pgs = done.filter((p) => benchResults[p.id].verdict.pg !== 'skipped');
    const eps = done.filter((p) => benchResults[p.id].verdict.epas !== 'skipped');
    l.bench = { pgN: pgs.length, epN: eps.length,
      pgSame: pgs.filter((p) => benchResults[p.id].verdict.pg === 'same').length,
      epSame: eps.filter((p) => benchResults[p.id].verdict.epas === 'same').length };
  }
  return l;
}

async function renderScorecard() {
  try { window.__last = await api('GET', '/api/last'); if (!fixText && window.__last.A_fixed) fixText = await api('GET', '/api/fixes'); } catch (_) { window.__last = {}; }
  await loadBenchQuiet();
  const l = labData();
  const card = (title, n, of, label, color) => `<div class="card" style="border-top:3px solid ${color}"><div class="t">${title}</div>
    ${n === null ? `<div class="n" style="color:var(--text-dim)">&mdash;</div><div class="l">${label}</div>` : `<div class="n">${n}${/^</.test(of) ? of : `<small>${of}</small>`}</div><div class="l">${label}</div>`}</div>`;
  const aS = l.A && l.A.smoke, aF = l.A_fixed && l.A_fixed.smoke, bS = (l.B || l.B_replay) && (l.B || l.B_replay).smoke;
  $('#lab-numbers').innerHTML =
    card('Route A &middot; as converted', aS ? aS.pass : null, aS ? `/${aS.total}` : '', aS ? 'migrated objects behave like Oracle straight out of ora2pg' : 'Run Route A in Step 2', 'var(--color-node-3)') +
    card('Route A &middot; after manual fixes', aF ? aF.pass : null, aF ? `/${aF.total}` : '', aF ? `after ${l.fixLines} lines of hand-written SQL` : 'Apply the manual fixes in Step 2', 'var(--color-node-3)') +
    card('Route B &middot; EPAS', bS ? bS.pass : null, bS ? `/${bS.total}` : '', bS ? (l.B ? 'via Migration Toolkit, nothing rewritten' : 'replaying the Oracle scripts, two one-line adjustments') : 'Run Route B in Step 2', 'var(--color-node-1)') +
    card('Test bench &middot; unchanged SQL', l.bench ? `${l.bench.pgSame} vs ${l.bench.epSame}` : null, l.bench ? `<small> of ${l.bench.pgN}</small>` : '', l.bench ? 'statements that run unchanged and agree with Oracle: PG + orafce vs EPAS' : 'Run Step 3', 'var(--color-node-4)');

  $('#score-table-wrap').innerHTML = `<table class="score-table"><tr><th>Dimension</th><th>Route A &middot; orafce + ora2pg</th><th>Route B &middot; EPAS</th></tr>${ROWS.map((r) => {
    if (r.group) return `<tr class="group"><td colspan="3">${r.group}</td></tr>`;
    const obs = r.obs ? r.obs(l) : '';
    const o = obs ? `<br><span class="obs"><span class="badge">observed here</span> ${esc(obs)}</span>` : '';
    return `<tr class="${r.edge ? 'edge-' + r.edge : ''}"><td class="dim">${esc(r.dim)}${r.small ? `<small>${esc(r.small)}</small>` : ''}</td><td class="a-col">${esc(r.a)}</td><td class="b-col">${esc(r.b)}${o}</td></tr>`;
  }).join('')}</table>`;
}
async function loadBenchQuiet() { if (!benchLoaded) { try { await loadBench(); } catch (_) { /* ignore */ } } }

function renderConsiderations() {
  $('#choice-grid').innerHTML = CHOICES.map((c) => `<div class="card" style="--node-color:${c.color}"><h4>${c.title}</h4><ul>${c.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></div>`).join('');
  $('#pitfall-grid').innerHTML = PITFALLS.map((p) => `<div class="card pitfall ${p.ok ? 'ok' : ''}"><div class="who">${p.who.map((w) => `<span class="pill ${w === 'A' ? 'orafce' : 'manual'}">Route ${w}</span>`).join('')}</div><h4>${esc(p.title)}</h4><p>${p.text}</p>
    <div class="consideration-meta"><span class="see-live">See it live: <a href="#" data-goto="${p.tab}" style="color:var(--color-node-3)"><b>${p.tab === 'bench' ? 'Same SQL, 3 engines' : 'Migrate'}</b></a></span></div></div>`).join('');
}

// ============================================================ SQL console

const SNIPPETS = {
  oracle: [
    ['Package call', "SELECT order_pkg.order_total(10001) AS total, order_pkg.order_total_vat(10001) AS with_vat FROM dual"],
    ['Org chart (CONNECT BY)', 'SELECT employee_id, indented_name, depth FROM v_org_chart ORDER BY path'],
    ['PL/SQL block', "DECLARE\n  v NUMBER;\nBEGIN\n  order_pkg.place_order(1000, 'SKU-001', 1, v);\n  DBMS_OUTPUT.PUT_LINE('placed order ' || v);\nEND;"],
    ['Objects', 'SELECT object_type, object_name, status FROM user_objects ORDER BY 1, 2'],
  ],
  pg: [
    ['orafce installed', '\\dx'],
    ['Same package call', 'SELECT order_pkg.order_total(10001) AS total, order_pkg.order_total_vat(10001) AS with_vat'],
    ['Converted functions', '\\df order_pkg.*'],
    ['search_path', 'SHOW search_path'],
    ['PL/pgSQL block', "DO $$ DECLARE v numeric; BEGIN CALL order_pkg.place_order(1000, 'SKU-001', 1, v); RAISE NOTICE 'placed order %', v; END $$"],
  ],
  epas: [
    ['Compatibility mode', "SELECT name, setting FROM pg_settings WHERE name LIKE 'edb_redwood%' ORDER BY 1"],
    ['Same package call', 'SELECT order_pkg.order_total(10001) AS total, order_pkg.order_total_vat(10001) AS with_vat FROM dual'],
    ['PL/SQL block, as written', "DECLARE\n  v NUMBER;\nBEGIN\n  order_pkg.place_order(1000, 'SKU-001', 1, v);\n  DBMS_OUTPUT.PUT_LINE('placed order ' || v);\nEND;"],
    ['Objects', 'SELECT object_type, object_name, status FROM user_objects ORDER BY 1, 2'],
  ],
};

function renderTable(el, columns, rows) {
  if (!rows || !rows.length) { el.innerHTML = `<tr><th colspan="${columns.length}">&nbsp;</th></tr><tr class="empty-row"><td colspan="${columns.length}">No rows</td></tr>`; return; }
  el.innerHTML = `<tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>` + rows.map((r) => `<tr>${columns.map((c) => `<td>${esc(r[c] === null ? 'NULL' : r[c])}</td>`).join('')}</tr>`).join('');
}

async function wireSqlConsole() {
  const overlay = $('#sql-console-overlay');
  const select = $('#sql-target-select');
  const fillSnippets = () => {
    $('#sql-snippets').innerHTML = (SNIPPETS[select.value] || []).map(([l], i) => `<button class="btn ghost" data-snip="${i}">${esc(l)}</button>`).join('');
    $all('[data-snip]').forEach((b) => b.addEventListener('click', () => { $('#sql-input').value = SNIPPETS[select.value][+b.dataset.snip][1]; $('#sql-input').focus(); }));
  };
  const open = async () => {
    overlay.hidden = false;
    if (!select.options.length) {
      const { targets } = await api('GET', '/api/sql/targets');
      select.innerHTML = targets.map((t) => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join('');
      fillSnippets();
    }
    $('#sql-input').focus();
  };
  const close = () => { overlay.hidden = true; };
  $('#sql-console-toggle').addEventListener('click', open);
  $('#sql-console-close').addEventListener('click', close);
  select.addEventListener('change', fillSnippets);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) close(); });

  async function runSql() {
    const sql = $('#sql-input').value.trim();
    if (!sql) return;
    setStatus($('#sql-status'), 'Running...', '');
    try {
      const d = await api('POST', '/api/sql/run', { target: select.value, sql });
      const table = $('#sql-result-table'), raw = $('#sql-result-raw'), out = $('#sql-result-out');
      out.style.display = 'none';
      if (d.output && d.output.length) { out.style.display = ''; out.textContent = d.output.map((o) => o.replace(/^NOTICE:\s*/, '')).join('\n'); }
      if (d.raw !== undefined) {
        $('#sql-result-card').style.display = ''; table.style.display = 'none'; raw.style.display = ''; raw.textContent = d.raw || '(no output)';
        $('#sql-result-title').textContent = `${sql.split('\n')[0]} · ${d.ms} ms`;
        setStatus($('#sql-status'), d.ok ? 'Done.' : d.error, d.ok ? 'ok' : 'err');
      } else if (d.ok) {
        const hasCols = d.fields && d.fields.length;
        $('#sql-result-card').style.display = ''; table.style.display = hasCols ? '' : 'none'; raw.style.display = 'none';
        $('#sql-result-title').textContent = hasCols ? `${d.command || 'OK'} · ${d.rowCount == null ? 0 : d.rowCount} row(s) · ${d.ms} ms` : `${d.command || 'OK'} · ${d.ms} ms`;
        if (hasCols) renderTable(table, d.fields, d.rows);
        setStatus($('#sql-status'), 'Done.', 'ok');
      } else {
        $('#sql-result-card').style.display = out.style.display === '' ? '' : 'none';
        setStatus($('#sql-status'), d.error, 'err');
      }
    } catch (err) { setStatus($('#sql-status'), err.message, 'err'); }
  }
  $('#sql-run').addEventListener('click', runSql);
  $('#sql-input').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runSql(); } });
}

// ============================================================ boot

document.addEventListener('DOMContentLoaded', async () => {
  initTabs();
  wireScrollButtons();
  wireMigrate();
  wireSqlConsole();
  renderConsiderations();
  $('#assess-btn').addEventListener('click', () => runAssess().catch((e) => { alert(e.message); jobRunning = false; updateButtons(); }));
  $('#bench-run-all').addEventListener('click', runAll);
  $('#reset-btn').addEventListener('click', async () => {
    if (!confirm('Drop the migrated ACME schema from PostgreSQL and EPAS?')) return;
    try { await api('POST', '/api/reset'); ['#a-result', '#b-result'].forEach((s) => { $(s).innerHTML = ''; $(s).classList.remove('show'); }); ['#a-stage', '#b-stage'].forEach((s) => { $(s).hidden = true; }); fixText = null; Object.keys(benchResults).forEach((k) => delete benchResults[k]); if (benchLoaded) renderBench(); await refreshStatus(); } catch (e) { alert(e.message); }
  });
  await Promise.all([refreshStatus(), loadInventory(), loadSource(), loadFeatures()]);
  await restoreResults();
  updateButtons();
  setInterval(refreshStatus, 6000);
  // Oracle takes a few minutes to create its database on the very first start.
  const retry = setInterval(async () => {
    if (lastStatus && lastStatus.oracle && lastStatus.oracle.up) { clearInterval(retry); loadInventory(); loadSource(); loadFeatures(); return; }
    loadInventory();
  }, 8000);
});
