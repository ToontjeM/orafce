'use strict';
// "What is in the Oracle source, and how does each path deal with it?"
// Counts are real (a scan of the ACME scripts). The two verdict columns are what this lab
// observed, not marketing: where the lab disproved the easy answer, the note says so.
//
//   status: native   works as written
//           auto     the tool converts it (check the output)
//           orafce   supplied by the orafce library
//           manual   a person has to rewrite it
//           gap      not supported

const FEATURES = [
  { id: 'types', label: 'NUMBER, VARCHAR2, CLOB types', re: /\b(NUMBER|VARCHAR2|CLOB)\b/gi,
    a: ['auto', 'ora2pg maps them to numeric / integer / bigint, varchar, text. An unconstrained NUMBER became bigint here and silently dropped cents: check every mapping.'],
    b: ['native', 'Native types. The one gap seen here: VARCHAR2(40 CHAR). EPAS has no BYTE/CHAR length qualifier.'] },
  { id: 'sysdate', label: 'SYSDATE, SYSTIMESTAMP', re: /\bSYS(DATE|TIMESTAMP)\b/gi,
    a: ['auto', 'ora2pg rewrites it inside converted code. Ad-hoc SQL in the application still breaks: orafce offers sysdate(), not the bare keyword.'],
    b: ['native', 'Native.'] },
  { id: 'nvl', label: 'NVL, NVL2, DECODE', re: /\b(NVL2?|DECODE)\s*\(/gi,
    a: ['orafce', 'orafce provides them, and ora2pg rewrites them to coalesce / CASE in converted code.'],
    b: ['native', 'Native.'] },
  { id: 'datefn', label: 'ADD_MONTHS, MONTHS_BETWEEN, LAST_DAY', re: /\b(ADD_MONTHS|MONTHS_BETWEEN|LAST_DAY|NEXT_DAY)\b/gi,
    a: ['orafce', 'orafce implements them with Oracle semantics.'],
    b: ['native', 'Native. Watch date - date: it is an interval here, a number in Oracle.'] },
  { id: 'outer', label: 'Outer join with (+)', re: /\(\+\)/g,
    a: ['auto', 'ora2pg rewrites it to ANSI LEFT JOIN. In this lab one of the two views came out with a syntax error.'],
    b: ['native', 'Native.'] },
  { id: 'connect', label: 'CONNECT BY / START WITH / LEVEL', re: /\bCONNECT\s+BY\b/gi,
    a: ['manual', 'ora2pg produces a recursive CTE, but the generated view did not compile here. Needed a rewrite.'],
    b: ['native', 'Native, including SYS_CONNECT_BY_PATH and ORDER SIBLINGS BY.'] },
  { id: 'rownum', label: 'ROWNUM', re: /\bROWNUM\b/gi,
    a: ['auto', 'Simple top-N becomes LIMIT. Anything cleverer (ROWNUM in the select list, paging) needs a human.'],
    b: ['native', 'Native.'] },
  { id: 'dual', label: 'SELECT ... FROM dual', re: /\bFROM\s+dual\b/gi,
    a: ['orafce', 'orafce creates the dual table.'],
    b: ['native', 'Native.'] },
  { id: 'seq', label: 'sequence.NEXTVAL', re: /\b\w+\.(NEXTVAL|CURRVAL)\b/gi,
    a: ['auto', "Converted to nextval('seq'). The same pseudo-column in application SQL must be changed too."],
    b: ['native', 'Native.'] },
  { id: 'synonym', label: 'Synonyms', re: /\bCREATE\s+SYNONYM\b/gi,
    a: ['auto', 'ora2pg creates a view instead.'],
    b: ['native', 'Native private and public synonyms.'] },
  { id: 'package', label: 'PL/SQL packages', re: /\bCREATE\s+(OR\s+REPLACE\s+)?PACKAGE\s+(?!BODY)/gi,
    a: ['manual', 'Becomes a schema full of functions. Package constants and package variables turn into unset custom settings and need initialising. Calls like order_pkg.orders_placed (no parentheses) stop working.'],
    b: ['native', 'Packages with specification, body, constants, state and private subprograms.'] },
  { id: 'trigger', label: 'Triggers (:NEW / :OLD)', re: /\bCREATE\s+(OR\s+REPLACE\s+)?TRIGGER\b/gi,
    a: ['auto', 'A trigger function plus a trigger. Load order matters: data first, triggers last.'],
    b: ['native', 'Native.'] },
  { id: 'autonomous', label: 'PRAGMA AUTONOMOUS_TRANSACTION', re: /\bAUTONOMOUS_TRANSACTION\b/gi,
    a: ['manual', 'Emulated with a dblink loopback connection. The generated wrapper used the wrong dblink call here and failed.'],
    b: ['native', 'Native.'] },
  { id: 'bulk', label: 'BULK COLLECT, FORALL', re: /\b(BULK\s+COLLECT|FORALL)\b/gi,
    a: ['manual', 'ora2pg prices it as work, but does not convert it. Rewritten as a set-based UPDATE.'],
    b: ['native', 'Native, with collections.'] },
  { id: 'output', label: 'DBMS_OUTPUT', re: /\bDBMS_OUTPUT\./gi,
    a: ['orafce', 'orafce ships dbms_output (and dbms_pipe, dbms_alert, dbms_random, utl_file ...).'],
    b: ['native', 'Native, and a much longer list of DBMS_* / UTL_* packages.'] },
  { id: 'raise', label: 'RAISE_APPLICATION_ERROR', re: /\bRAISE_APPLICATION_ERROR\b/gi,
    a: ['auto', 'Becomes RAISE EXCEPTION ... USING ERRCODE.'],
    b: ['native', 'Native.'] },
  { id: 'rowtype', label: '%TYPE, %ROWTYPE, SYS_REFCURSOR', re: /%(TYPE|ROWTYPE)\b|SYS_REFCURSOR/gi,
    a: ['auto', 'PL/pgSQL has the same constructs.'],
    b: ['native', 'Native.'] },
];

const LABELS = { native: 'works as written', auto: 'tool converts it', orafce: 'orafce provides it', manual: 'manual rewrite', gap: 'not supported' };

function scanFeatures(text) {
  return FEATURES.map((f) => {
    const m = text.match(f.re);
    return { id: f.id, label: f.label, count: m ? m.length : 0,
             a: { status: f.a[0], note: f.a[1] }, b: { status: f.b[0], note: f.b[1] } };
  }).filter((f) => f.count > 0);
}

module.exports = { FEATURES, LABELS, scanFeatures };
