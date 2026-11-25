'use strict';
// "Same statement, three engines". Every preset is written in Oracle dialect and is
// sent, unchanged, to Oracle, to PostgreSQL+orafce and to EPAS. Where plain
// PostgreSQL needs a different statement, `pgRewrite` holds the native version,
// so the UI can show both "what happens as-is" and "what you would have to write".
//
//   steps      statements run in ONE session, in order; the last result is shown
//   pgRewrite  the same thing written for PostgreSQL (optional)
//   migrated   needs the ACME schema to exist on the target (run a migration first)
//   output     collect DBMS_OUTPUT / NOTICE lines
//   volatile   value changes on every run: only check that it runs, not what it returns
//
// {{token}} is replaced by a random string per run (used to probe autonomous transactions).

const DIALECT = [
  {
    id: 'dual-funcs', group: 'dialect', title: 'Everyday functions: NVL, NVL2, DECODE', migrated: true,
    steps: ["SELECT employee_id, NVL(commission_pct,0) AS comm, NVL2(manager_id,'reports','top') AS lvl, DECODE(department_id,20,'Sales',30,'Eng','Other') AS grp FROM employees WHERE employee_id IN (100,101,110) ORDER BY 1"],
    pgRewrite: ["SELECT employee_id, NVL(commission_pct,0) AS comm, NVL2(manager_id,'reports','top') AS lvl, DECODE(department_id::integer,20,'Sales',30,'Eng','Other') AS grp FROM employees WHERE employee_id IN (100,101,110) ORDER BY 1"],
    why: 'The functions every Oracle query uses, which orafce exists to provide. But its DECODE is polymorphic: a smallint column against an integer literal does not match, so it needs a cast. ora2pg avoids the problem by rewriting DECODE to CASE in the code it converts.',
  },
  {
    id: 'date-funcs', group: 'dialect', title: 'Date functions: ADD_MONTHS, LAST_DAY, NEXT_DAY, TRUNC',
    steps: ["SELECT ADD_MONTHS(DATE '2024-01-31',1) a, LAST_DAY(DATE '2024-02-10') b, MONTHS_BETWEEN(DATE '2024-03-31', DATE '2024-01-31') c, NEXT_DAY(DATE '2024-05-01','FRIDAY') d, TRUNC(DATE '2024-05-17','MM') e FROM dual"],
    why: 'orafce implements these with Oracle semantics (last-day-of-month rules and all).',
  },
  {
    id: 'sysdate', group: 'dialect', title: 'SYSDATE without parentheses',
    steps: ["SELECT TO_CHAR(SYSDATE,'YYYY') AS yr FROM dual"],
    pgRewrite: ["SELECT TO_CHAR(sysdate(),'YYYY') AS yr FROM dual"],
    why: 'orafce can add a function sysdate(), but not the bare keyword. ora2pg rewrites it in code it converts; ad-hoc SQL in the application must be changed.',
  },
  {
    id: 'date-minus', group: 'dialect', title: 'Date arithmetic: date - date is a number of days',
    steps: ['SELECT TRUNC(SYSDATE) - TRUNC(SYSDATE - 5) AS days FROM dual'],
    pgRewrite: ['SELECT current_date - (current_date - 5) AS days'],
    why: 'In Oracle the difference of two dates is a number. In EPAS it is an interval, in PostgreSQL an integer: same wording, different type.',
  },
  {
    id: 'rownum', group: 'dialect', title: 'ROWNUM top-N', migrated: true,
    steps: ['SELECT * FROM (SELECT employee_id, salary FROM employees ORDER BY salary DESC) WHERE ROWNUM <= 3'],
    pgRewrite: ['SELECT employee_id, salary FROM employees ORDER BY salary DESC LIMIT 3'],
    why: 'ROWNUM is a pseudo-column. PostgreSQL has no equivalent; the query becomes LIMIT or row_number().',
  },
  {
    id: 'connect-by', group: 'dialect', title: 'Hierarchical query: START WITH / CONNECT BY', migrated: true,
    steps: ['SELECT employee_id, LEVEL AS lvl, last_name FROM employees START WITH manager_id IS NULL CONNECT BY PRIOR employee_id = manager_id ORDER SIBLINGS BY last_name'],
    pgRewrite: ['WITH RECURSIVE t AS (SELECT employee_id, 1 AS lvl, last_name, last_name::text AS sort_path FROM employees WHERE manager_id IS NULL UNION ALL SELECT e.employee_id, t.lvl + 1, e.last_name, t.sort_path || \'/\' || e.last_name FROM employees e JOIN t ON e.manager_id = t.employee_id) SELECT employee_id, lvl, last_name FROM t ORDER BY sort_path'],
    why: 'No CONNECT BY in PostgreSQL: it becomes a recursive CTE, and ORDER SIBLINGS BY needs a hand-built sort path.',
  },
  {
    id: 'outer-plus', group: 'dialect', title: 'Old-style outer join with (+)', migrated: true,
    steps: ['SELECT d.department_name, COUNT(e.employee_id) AS n FROM departments d, employees e WHERE d.department_id = e.department_id (+) GROUP BY d.department_name ORDER BY 1'],
    pgRewrite: ['SELECT d.department_name, COUNT(e.employee_id) AS n FROM departments d LEFT JOIN employees e ON d.department_id = e.department_id GROUP BY d.department_name ORDER BY 1'],
    why: 'A syntax error in PostgreSQL. ora2pg can rewrite it into ANSI joins, but only in the objects it converts.',
  },
  {
    id: 'minus', group: 'dialect', title: 'MINUS set operator', migrated: true,
    steps: ['SELECT department_id FROM departments MINUS SELECT department_id FROM employees ORDER BY 1'],
    pgRewrite: ['SELECT department_id FROM departments EXCEPT SELECT department_id FROM employees ORDER BY 1'],
    why: 'PostgreSQL calls it EXCEPT.',
  },
  {
    id: 'seq-nextval', group: 'dialect', title: 'sequence.NEXTVAL', migrated: true, volatile: true,
    steps: ['SELECT order_seq.NEXTVAL AS id FROM dual'],
    pgRewrite: ["SELECT nextval('order_seq') AS id"],
    why: 'PostgreSQL has a function, not a pseudo-column on the sequence.',
  },
  {
    id: 'number-type', group: 'dialect', title: 'The NUMBER data type',
    steps: ["SELECT CAST('12.50' AS NUMBER(6,1)) AS n FROM dual"],
    pgRewrite: ["SELECT CAST('12.50' AS numeric(6,1)) AS n"],
    why: 'PostgreSQL has no type called NUMBER, so every DDL statement and every CAST that names it has to change.',
  },
  {
    id: 'empty-null', group: 'dialect', title: "Semantics: is '' the same as NULL?",
    steps: ["SELECT CASE WHEN '' IS NULL THEN 'empty string IS NULL' ELSE 'empty string is a value' END AS semantics FROM dual"],
    why: "In Oracle an empty string is NULL. In PostgreSQL it is a value. No tool can translate this: it changes what your data means. Compare the EPAS column honestly.",
  },
  {
    id: 'null-concat', group: 'dialect', title: "Semantics: 'a' || NULL || 'b'",
    steps: ["SELECT 'a' || NULL || 'b' AS s FROM dual"],
    pgRewrite: ["SELECT concat('a', NULL, 'b') AS s"],
    why: 'Oracle ignores NULL in a concatenation. PostgreSQL returns NULL. Silent, and found only by testing.',
  },
  {
    id: 'substr-zero', group: 'dialect', title: 'Semantics: SUBSTR(x, 0, n)',
    steps: ["SELECT SUBSTR('Oracle',0,3) AS s FROM dual"],
    pgRewrite: ["SELECT SUBSTR('Oracle',1,3) AS s"],
    why: 'Oracle treats start position 0 as 1. PostgreSQL does not, and returns one character fewer. orafce has an oracle.substr that fixes this, but only if the oracle schema comes first in search_path.',
  },
  {
    id: 'listagg', group: 'dialect', title: 'LISTAGG', migrated: true,
    steps: ["SELECT LISTAGG(last_name, ', ') WITHIN GROUP (ORDER BY last_name) AS names FROM employees WHERE department_id = 30"],
    pgRewrite: ["SELECT string_agg(last_name, ', ' ORDER BY last_name) AS names FROM employees WHERE department_id = 30"],
    why: 'string_agg in PostgreSQL.',
  },
  {
    id: 'plsql-block', group: 'dialect', title: 'Anonymous PL/SQL block with DBMS_OUTPUT', output: true,
    steps: ["DECLARE\n  v_msg VARCHAR2(50) := 'hello';\nBEGIN\n  DBMS_OUTPUT.PUT_LINE(UPPER(v_msg) || ' from a PL/SQL block');\nEND;"],
    pgRewrite: ["DO $$ DECLARE v_msg text := 'hello'; BEGIN RAISE NOTICE '%', upper(v_msg) || ' from a PL/SQL block'; END $$"],
    why: 'PostgreSQL has DO blocks in PL/pgSQL, a different language. orafce supplies DBMS_OUTPUT as a library, but not the PL/SQL syntax around it.',
  },
  {
    id: 'fetch-first', group: 'dialect', title: 'FETCH FIRST n ROWS ONLY (standard SQL)', migrated: true,
    steps: ['SELECT employee_id FROM employees ORDER BY salary DESC FETCH FIRST 3 ROWS ONLY'],
    why: 'Not everything is a gap: standard SQL runs everywhere.',
  },
  {
    id: 'regexp', group: 'dialect', title: 'REGEXP_SUBSTR, TO_CHAR, TO_DATE, INSTR, LPAD',
    steps: ["SELECT REGEXP_SUBSTR('abc123def','[0-9]+') AS digits, TO_CHAR(1234.5,'FM9,999.00') AS amt, TO_DATE('17-MAY-2024','DD-MON-YYYY') AS d, INSTR('hello world','o',1,2) AS pos, LPAD('7',3,'0') AS padded FROM dual"],
    why: 'Another case where modern PostgreSQL and orafce cover the ground.',
  },
];

const OBJECTS = [
  {
    id: 'o-synonym', group: 'objects', title: 'Synonym: SELECT FROM emp', migrated: true,
    steps: ['SELECT COUNT(*) AS n FROM emp'],
    why: 'ora2pg turns a synonym into a view. MTK keeps it a synonym.',
  },
  {
    id: 'o-view-dir', group: 'objects', title: 'View with DECODE / NVL / (+)', migrated: true,
    steps: ['SELECT employee_id, full_name, site, commission_pct, level_flag FROM v_employee_dir ORDER BY employee_id'],
    why: 'v_employee_dir uses DECODE, NVL, NVL2 and an old-style outer join.',
  },
  {
    id: 'o-view-org', group: 'objects', title: 'View with CONNECT BY (org chart)', migrated: true,
    steps: ['SELECT employee_id, indented_name, depth FROM v_org_chart ORDER BY path'],
    why: 'ora2pg converts CONNECT BY to a recursive CTE, but the generated view does not even compile in this lab.',
  },
  {
    id: 'o-view-rev', group: 'objects', title: 'View with two (+) joins and NVL', migrated: true,
    steps: ['SELECT customer_id, name, order_count, revenue FROM v_customer_revenue ORDER BY customer_id FETCH FIRST 5 ROWS ONLY'],
    why: 'ora2pg rewrites (+) into LEFT JOINs. Here the generated SQL is missing a closing parenthesis.',
  },
  {
    id: 'o-view-top', group: 'objects', title: 'View with ROWNUM top-N', migrated: true,
    steps: ['SELECT sku, revenue FROM v_top_products ORDER BY revenue DESC'],
    why: 'ROWNUM becomes LIMIT in the converted view.',
  },
  {
    id: 'o-func-tenure', group: 'objects', title: 'Standalone function: emp_tenure_months(100)', migrated: true,
    steps: ['SELECT emp_tenure_months(100) AS months FROM dual'],
    why: 'MONTHS_BETWEEN and TRUNC on dates.',
  },
  {
    id: 'o-pkg-total', group: 'objects', title: 'Package function: order_pkg.order_total(10001)', migrated: true,
    steps: ['SELECT order_pkg.order_total(10001) AS total FROM dual'],
    why: 'A NUMBER with no precision. Watch what type it becomes.',
  },
  {
    id: 'o-pkg-vat', group: 'objects', title: 'Package constant: order_pkg.order_total_vat(10001)', migrated: true,
    steps: ['SELECT order_pkg.order_total_vat(10001) AS total_vat FROM dual'],
    why: 'Uses the package constant c_vat_rate. PL/pgSQL has no package constants.',
  },
  {
    id: 'o-pkg-place', group: 'objects', title: 'Package procedure with OUT parameter, package state', migrated: true, output: true,
    steps: [
      "DECLARE\n  v_id NUMBER;\nBEGIN\n  order_pkg.place_order(1000, 'SKU-001', 2, v_id);\n  DBMS_OUTPUT.PUT_LINE('placed order ' || v_id);\nEND;",
      "SELECT order_pkg.orders_placed AS placed_in_session FROM dual",
    ],
    pgRewrite: [
      "DO $$ DECLARE v_id numeric; BEGIN CALL order_pkg.place_order(1000, 'SKU-001', 2, v_id); RAISE NOTICE 'placed order %', v_id; END $$",
      "SELECT order_pkg.orders_placed() AS placed_in_session",
    ],
    cleanup: ["DELETE FROM audit_log WHERE message LIKE 'order % placed for customer %'"],
    why: 'place_order uses %ROWTYPE, RETURNING INTO, RAISE_APPLICATION_ERROR, DBMS_OUTPUT and a package variable that lives for the session.',
  },
  {
    id: 'o-pkg-bulk', group: 'objects', title: 'BULK COLLECT + FORALL batch procedure', migrated: true, output: true,
    steps: [
      "DECLARE\n  v_n NUMBER;\nBEGIN\n  order_pkg.close_stale_orders(30, v_n);\nEND;",
      "SELECT COUNT(*) AS stale FROM orders WHERE status = 'STALE'",
    ],
    pgRewrite: [
      "DO $$ DECLARE v_n numeric; BEGIN CALL order_pkg.close_stale_orders(30, v_n); END $$",
      "SELECT COUNT(*) AS stale FROM orders WHERE status = 'STALE'",
    ],
    why: 'BULK COLLECT and FORALL have no PL/pgSQL equivalent. ora2pg prices them as work but does not convert them.',
  },
  {
    id: 'o-autonomous', group: 'objects', title: 'Autonomous transaction survives a rollback', migrated: true,
    steps: [
      "BEGIN\n  order_pkg.log_msg('probe {{token}}');\nEND;",
      'ROLLBACK',
      "SELECT COUNT(*) AS rows_kept FROM audit_log WHERE message = 'probe {{token}}'",
    ],
    pgRewrite: [
      "CALL order_pkg.log_msg('probe {{token}}')",
      'ROLLBACK',
      "SELECT COUNT(*) AS rows_kept FROM audit_log WHERE message = 'probe {{token}}'",
    ],
    noSandbox: true,
    cleanup: ["DELETE FROM audit_log WHERE message = 'probe {{token}}'"],
    why: 'PRAGMA AUTONOMOUS_TRANSACTION. ora2pg emulates it with a dblink loopback connection, which has to be allowed and configured.',
  },
  {
    id: 'o-raise', group: 'objects', title: 'Procedure with cursor loop: give_raise(30, 5)', migrated: true, output: true,
    steps: [
      'BEGIN\n  give_raise(30, 5);\nEND;',
      'SELECT SUM(salary) AS dept_salary_total FROM employees WHERE department_id = 30',
    ],
    pgRewrite: ['CALL give_raise(30, 5)', 'SELECT SUM(salary) AS dept_salary_total FROM employees WHERE department_id = 30'],
    why: 'A 5% raise. Watch the total: integer division is a classic silent bug in converted code.',
  },
  {
    id: 'o-trigger-bi', group: 'objects', title: 'BEFORE INSERT trigger with sequence', migrated: true,
    steps: [
      'INSERT INTO orders (customer_id, employee_id) VALUES (1000, 110)',
      "SELECT SUBSTR(ref_code, 1, 4) AS prefix, LENGTH(ref_code) AS len, status FROM orders WHERE order_id = (SELECT MAX(order_id) FROM orders)",
    ],
    why: 'The trigger fills order_id from a sequence and builds ref_code.',
  },
  {
    id: 'o-trigger-au', group: 'objects', title: 'AFTER UPDATE OF trigger writes an audit row', migrated: true,
    steps: [
      "UPDATE orders SET status = 'STALE' WHERE order_id = 10001",
      "SELECT COUNT(*) AS audit_rows FROM audit_log WHERE message LIKE 'order 10001: % -> STALE'",
    ],
    why: 'WHEN (OLD.status <> NEW.status) and :OLD / :NEW references.',
  },
];

const PRESETS = [...DIALECT, ...OBJECTS];

module.exports = { PRESETS };
