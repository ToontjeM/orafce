-- Sample data. The bulk rows are generated with the classic Oracle row generator
-- (SELECT ... FROM dual CONNECT BY LEVEL <= n).
CONNECT acme/acme@//localhost:1521/FREEPDB1
WHENEVER SQLERROR EXIT FAILURE
SET DEFINE OFF

INSERT INTO departments VALUES (10, 'Executive',   'Amsterdam');
INSERT INTO departments VALUES (20, 'Sales',       'London');
INSERT INTO departments VALUES (30, 'Engineering', 'Berlin');
INSERT INTO departments VALUES (40, 'Support',     'Dublin');
INSERT INTO departments VALUES (50, 'Unassigned',  NULL);

INSERT INTO employees VALUES (100,'Anna','de Vries','anna@acme.example',    ADD_MONTHS(SYSDATE,-120),'CEO',            19500,NULL,NULL,10);
INSERT INTO employees VALUES (101,'Bram','Jansen',  'bram@acme.example',    ADD_MONTHS(SYSDATE,-96), 'VP Sales',       14200,0.10,100,20);
INSERT INTO employees VALUES (102,'Carla','Smit',   'carla@acme.example',   ADD_MONTHS(SYSDATE,-90), 'VP Engineering', 14800,NULL,100,30);
INSERT INTO employees VALUES (103,'Daan','Bakker',  'daan@acme.example',    ADD_MONTHS(SYSDATE,-84), 'VP Support',     12100,NULL,100,40);
INSERT INTO employees VALUES (110,'Eva','Visser',   'eva@acme.example',     ADD_MONTHS(SYSDATE,-60), 'Account Manager', 7200,0.08,101,20);
INSERT INTO employees VALUES (111,'Finn','Meijer',  'finn@acme.example',    ADD_MONTHS(SYSDATE,-48), 'Account Manager', 7000,0.08,101,20);
INSERT INTO employees VALUES (112,'Gina','Mulder',  'gina@acme.example',    ADD_MONTHS(SYSDATE,-30), 'Sales Rep',       5200,0.05,110,20);
INSERT INTO employees VALUES (113,'Hugo','Bos',     'hugo@acme.example',    ADD_MONTHS(SYSDATE,-18), 'Sales Rep',       5000,0.05,110,20);
INSERT INTO employees VALUES (120,'Iris','Peters',  'iris@acme.example',    ADD_MONTHS(SYSDATE,-70), 'Tech Lead',       9800,NULL,102,30);
INSERT INTO employees VALUES (121,'Jeroen','Hendriks','jeroen@acme.example',ADD_MONTHS(SYSDATE,-40), 'Developer',       7600,NULL,120,30);
INSERT INTO employees VALUES (122,'Kim','Dekker',   'kim@acme.example',     ADD_MONTHS(SYSDATE,-22), 'Developer',       7300,NULL,120,30);
INSERT INTO employees VALUES (123,'Lars','Brouwer', 'lars@acme.example',    ADD_MONTHS(SYSDATE,-9),  'Developer',       6900,NULL,120,30);
INSERT INTO employees VALUES (130,'Mila','Kok',     'mila@acme.example',    ADD_MONTHS(SYSDATE,-36), 'Support Lead',    6400,NULL,103,40);
INSERT INTO employees VALUES (131,'Noah','Vos',     'noah@acme.example',    ADD_MONTHS(SYSDATE,-14), 'Support Engineer',5100,NULL,130,40);
INSERT INTO employees VALUES (132,'Olivia','Prins', 'olivia@acme.example',  ADD_MONTHS(SYSDATE,-3),  'Support Engineer',4900,NULL,130,NULL);

INSERT INTO products
SELECT LEVEL,
       'SKU-' || LPAD(LEVEL, 3, '0'),
       DECODE(MOD(LEVEL, 4), 0, 'Widget ', 1, 'Gadget ', 2, 'Gizmo ', 'Doohickey ') || LEVEL,
       ROUND(5 + MOD(LEVEL * 37, 190) + LEVEL / 10, 2),
       200 + MOD(LEVEL * 53, 300)
FROM   dual CONNECT BY LEVEL <= 40;

INSERT INTO customers
SELECT customer_seq.NEXTVAL,
       'Customer ' || LPAD(LEVEL, 3, '0'),
       'contact' || LEVEL || '@customer.example',
       DECODE(MOD(LEVEL, 5), 0, 'Netherlands', 1, 'Germany', 2, 'France', 3, 'United Kingdom', 'Ireland'),
       1000 * (1 + MOD(LEVEL, 10)),
       CASE WHEN MOD(LEVEL, 7) = 0 THEN 'Key account. Prefers invoice by e-mail.' END,
       SYSTIMESTAMP - NUMTODSINTERVAL(LEVEL * 3, 'DAY')
FROM   dual CONNECT BY LEVEL <= 100;

-- 3,000 orders over the last 120 days; the trigger fills ref_code
INSERT INTO orders (order_id, customer_id, employee_id, order_date, status)
SELECT order_seq.NEXTVAL,
       1000 + MOD(LEVEL * 7, 100),
       DECODE(MOD(LEVEL, 4), 0, 112, 1, 113, 2, 110, 111),
       SYSDATE - MOD(LEVEL * 11, 120) - MOD(LEVEL, 24) / 24,
       DECODE(MOD(LEVEL, 10), 0, 'CANCELLED', 1, 'NEW', 2, 'NEW', 'SHIPPED')
FROM   dual CONNECT BY LEVEL <= 3000;

INSERT INTO order_items
SELECT o.order_id, n.lvl, p.product_id, 1 + MOD(o.order_id + n.lvl * 3, 9), p.list_price
FROM   orders o
JOIN  (SELECT LEVEL AS lvl FROM dual CONNECT BY LEVEL <= 3) n ON n.lvl <= 1 + MOD(o.order_id, 3)
JOIN   products p ON p.product_id = 1 + MOD(o.order_id * n.lvl * 7, 40);

COMMIT;

BEGIN
  DBMS_STATS.GATHER_SCHEMA_STATS('ACME');
END;
/
EXIT
