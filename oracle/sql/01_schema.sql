-- ACME order management: the Oracle source schema for the migration.
-- Tables, sequences, indexes, a synonym and four views that lean on Oracle SQL dialect.
CONNECT acme/acme@//localhost:1521/FREEPDB1
WHENEVER SQLERROR EXIT FAILURE

CREATE TABLE departments (
  department_id    NUMBER(4)          CONSTRAINT dept_pk PRIMARY KEY,
  department_name  VARCHAR2(40 CHAR)  NOT NULL,
  location         VARCHAR2(60)
);

CREATE TABLE employees (
  employee_id     NUMBER(6)     CONSTRAINT emp_pk PRIMARY KEY,
  first_name      VARCHAR2(30),
  last_name       VARCHAR2(40)  NOT NULL,
  email           VARCHAR2(60)  CONSTRAINT emp_email_uk UNIQUE,
  hire_date       DATE          DEFAULT SYSDATE NOT NULL,
  job_title       VARCHAR2(40),
  salary          NUMBER(9,2),
  commission_pct  NUMBER(3,2),
  manager_id      NUMBER(6)     CONSTRAINT emp_mgr_fk REFERENCES employees (employee_id),
  department_id   NUMBER(4)     CONSTRAINT emp_dept_fk REFERENCES departments (department_id)
);

CREATE TABLE customers (
  customer_id   NUMBER(8)      CONSTRAINT cust_pk PRIMARY KEY,
  name          VARCHAR2(80)   NOT NULL,
  email         VARCHAR2(80),
  country       VARCHAR2(40),
  credit_limit  NUMBER(10,2),
  notes         CLOB,
  created_at    TIMESTAMP      DEFAULT SYSTIMESTAMP
);

CREATE TABLE products (
  product_id  NUMBER(8)     CONSTRAINT prod_pk PRIMARY KEY,
  sku         VARCHAR2(20)  NOT NULL CONSTRAINT prod_sku_uk UNIQUE,
  name        VARCHAR2(80)  NOT NULL,
  list_price  NUMBER(10,2)  NOT NULL,
  stock_qty   NUMBER(8)     DEFAULT 0 NOT NULL
);

CREATE TABLE orders (
  order_id     NUMBER(10)    CONSTRAINT ord_pk PRIMARY KEY,
  customer_id  NUMBER(8)     NOT NULL CONSTRAINT ord_cust_fk REFERENCES customers (customer_id),
  employee_id  NUMBER(6)     CONSTRAINT ord_emp_fk REFERENCES employees (employee_id),
  order_date   DATE          DEFAULT SYSDATE NOT NULL,
  status       VARCHAR2(12)  DEFAULT 'NEW' NOT NULL
               CONSTRAINT ord_status_ck CHECK (status IN ('NEW','SHIPPED','CANCELLED','STALE')),
  ref_code     VARCHAR2(20)
);

CREATE TABLE order_items (
  order_id    NUMBER(10)    NOT NULL CONSTRAINT oi_ord_fk REFERENCES orders (order_id),
  line_no     NUMBER(4)     NOT NULL,
  product_id  NUMBER(8)     NOT NULL CONSTRAINT oi_prod_fk REFERENCES products (product_id),
  quantity    NUMBER(6)     NOT NULL,
  unit_price  NUMBER(10,2)  NOT NULL,
  CONSTRAINT oi_pk PRIMARY KEY (order_id, line_no)
);

CREATE TABLE audit_log (
  log_id     NUMBER         CONSTRAINT audit_pk PRIMARY KEY,
  logged_at  TIMESTAMP      DEFAULT SYSTIMESTAMP,
  message    VARCHAR2(400)
);

CREATE SEQUENCE order_seq    START WITH 10000 INCREMENT BY 1 NOCACHE;
CREATE SEQUENCE audit_seq    START WITH 1     INCREMENT BY 1 CACHE 20;
CREATE SEQUENCE customer_seq START WITH 1000  INCREMENT BY 1;

CREATE INDEX orders_cust_ix  ON orders (customer_id);
CREATE INDEX orders_date_ix  ON orders (order_date);
CREATE INDEX emp_dept_ix     ON employees (department_id);
CREATE INDEX emp_mgr_ix      ON employees (manager_id);

CREATE SYNONYM emp FOR employees;

-- DECODE, NVL, NVL2, SYSDATE, MONTHS_BETWEEN: the everyday Oracle functions.
CREATE OR REPLACE VIEW v_employee_dir AS
SELECT e.employee_id,
       e.first_name || ' ' || e.last_name                         AS full_name,
       d.department_name,
       DECODE(d.department_id, 10, 'Headquarters', 20, 'Field', 'Other') AS site,
       NVL(e.commission_pct, 0)                                   AS commission_pct,
       NVL2(e.manager_id, 'reports', 'top')                       AS level_flag,
       TRUNC(MONTHS_BETWEEN(SYSDATE, e.hire_date) / 12)           AS years_of_service
FROM   employees e, departments d
WHERE  e.department_id = d.department_id (+);

-- Hierarchical query: CONNECT BY / START WITH / LEVEL / SYS_CONNECT_BY_PATH.
CREATE OR REPLACE VIEW v_org_chart AS
SELECT employee_id,
       LPAD(' ', 2 * (LEVEL - 1)) || last_name  AS indented_name,
       LEVEL                                    AS depth,
       SYS_CONNECT_BY_PATH(last_name, '/')      AS path
FROM   employees
START WITH manager_id IS NULL
CONNECT BY PRIOR employee_id = manager_id;

-- Old-style outer join with (+), plus NVL on the aggregate.
CREATE OR REPLACE VIEW v_customer_revenue AS
SELECT c.customer_id,
       c.name,
       c.country,
       COUNT(DISTINCT o.order_id)                AS order_count,
       NVL(SUM(i.quantity * i.unit_price), 0)    AS revenue
FROM   customers c, orders o, order_items i
WHERE  c.customer_id = o.customer_id (+)
AND    o.order_id    = i.order_id    (+)
GROUP  BY c.customer_id, c.name, c.country;

-- ROWNUM top-N over an ordered inline view.
CREATE OR REPLACE VIEW v_top_products AS
SELECT *
FROM  (SELECT p.sku, p.name, SUM(i.quantity * i.unit_price) AS revenue
       FROM   products p, order_items i
       WHERE  p.product_id = i.product_id
       GROUP  BY p.sku, p.name
       ORDER  BY revenue DESC)
WHERE ROWNUM <= 5;
