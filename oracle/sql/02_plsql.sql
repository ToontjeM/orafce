-- PL/SQL: triggers, a package (spec + body), and two standalone subprograms.
CONNECT acme/acme@//localhost:1521/FREEPDB1
SET DEFINE OFF
WHENEVER SQLERROR EXIT FAILURE

CREATE OR REPLACE PACKAGE order_pkg AS
  c_vat_rate        CONSTANT NUMBER := 0.21;
  g_orders_placed   NUMBER := 0;                 -- package state, lives for the session

  e_out_of_stock    EXCEPTION;
  PRAGMA EXCEPTION_INIT(e_out_of_stock, -20010);

  FUNCTION  order_total     (p_order_id IN NUMBER) RETURN NUMBER;
  FUNCTION  order_total_vat (p_order_id IN NUMBER) RETURN NUMBER;
  FUNCTION  orders_placed RETURN NUMBER;
  FUNCTION  open_orders (p_customer_id IN NUMBER) RETURN SYS_REFCURSOR;
  PROCEDURE log_msg     (p_msg IN VARCHAR2);
  PROCEDURE place_order (p_customer_id IN NUMBER, p_sku IN VARCHAR2,
                         p_qty IN NUMBER, p_order_id OUT NUMBER);
  PROCEDURE close_stale_orders (p_days IN NUMBER, p_closed OUT NUMBER);
END order_pkg;
/

CREATE OR REPLACE PACKAGE BODY order_pkg AS

  FUNCTION order_total (p_order_id IN NUMBER) RETURN NUMBER IS
    v_total NUMBER;
  BEGIN
    SELECT NVL(SUM(quantity * unit_price), 0) INTO v_total
    FROM   order_items WHERE order_id = p_order_id;
    RETURN v_total;
  END order_total;

  FUNCTION order_total_vat (p_order_id IN NUMBER) RETURN NUMBER IS
  BEGIN
    RETURN ROUND(order_total(p_order_id) * (1 + c_vat_rate), 2);
  END order_total_vat;

  FUNCTION orders_placed RETURN NUMBER IS
  BEGIN
    RETURN g_orders_placed;
  END orders_placed;

  FUNCTION open_orders (p_customer_id IN NUMBER) RETURN SYS_REFCURSOR IS
    v_cur SYS_REFCURSOR;
  BEGIN
    OPEN v_cur FOR
      SELECT order_id, order_date, status FROM orders
      WHERE  customer_id = p_customer_id AND status = 'NEW'
      ORDER  BY order_date;
    RETURN v_cur;
  END open_orders;

  -- Autonomous transaction: the log row survives a rollback of the caller.
  PROCEDURE log_msg (p_msg IN VARCHAR2) IS
    PRAGMA AUTONOMOUS_TRANSACTION;
  BEGIN
    INSERT INTO audit_log (log_id, message) VALUES (audit_seq.NEXTVAL, p_msg);
    COMMIT;
  END log_msg;

  PROCEDURE place_order (p_customer_id IN NUMBER, p_sku IN VARCHAR2,
                         p_qty IN NUMBER, p_order_id OUT NUMBER) IS
    v_product  products%ROWTYPE;
  BEGIN
    SELECT * INTO v_product FROM products WHERE sku = p_sku;
    IF v_product.stock_qty < p_qty THEN
      RAISE_APPLICATION_ERROR(-20010, 'Out of stock: ' || p_sku);
    END IF;

    INSERT INTO orders (order_id, customer_id) VALUES (order_seq.NEXTVAL, p_customer_id)
    RETURNING order_id INTO p_order_id;

    INSERT INTO order_items (order_id, line_no, product_id, quantity, unit_price)
    VALUES (p_order_id, 1, v_product.product_id, p_qty, v_product.list_price);

    UPDATE products SET stock_qty = stock_qty - p_qty WHERE product_id = v_product.product_id;

    g_orders_placed := g_orders_placed + 1;
    DBMS_OUTPUT.PUT_LINE('Order ' || p_order_id || ' placed: ' || p_qty || ' x ' || p_sku);
    log_msg('order ' || p_order_id || ' placed for customer ' || p_customer_id);
  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      RAISE_APPLICATION_ERROR(-20011, 'Unknown product: ' || p_sku);
  END place_order;

  -- BULK COLLECT + FORALL: the batch idiom Oracle developers reach for.
  PROCEDURE close_stale_orders (p_days IN NUMBER, p_closed OUT NUMBER) IS
    TYPE t_ids IS TABLE OF orders.order_id%TYPE;
    v_ids t_ids;
  BEGIN
    SELECT order_id BULK COLLECT INTO v_ids
    FROM   orders
    WHERE  status = 'NEW' AND order_date < SYSDATE - p_days;

    FORALL i IN 1 .. v_ids.COUNT
      UPDATE orders SET status = 'STALE' WHERE order_id = v_ids(i);

    p_closed := v_ids.COUNT;
    DBMS_OUTPUT.PUT_LINE(p_closed || ' stale orders closed');
  END close_stale_orders;

END order_pkg;
/

CREATE OR REPLACE FUNCTION emp_tenure_months (p_employee_id IN NUMBER) RETURN NUMBER IS
  v_hired employees.hire_date%TYPE;
BEGIN
  SELECT hire_date INTO v_hired FROM employees WHERE employee_id = p_employee_id;
  RETURN TRUNC(MONTHS_BETWEEN(SYSDATE, v_hired));
END emp_tenure_months;
/

CREATE OR REPLACE PROCEDURE give_raise (p_department_id IN NUMBER, p_pct IN NUMBER) IS
  CURSOR c_emp IS
    SELECT employee_id, salary FROM employees WHERE department_id = p_department_id FOR UPDATE;
BEGIN
  FOR r IN c_emp LOOP
    UPDATE employees SET salary = ROUND(NVL(r.salary, 0) * (1 + p_pct / 100), 2)
    WHERE CURRENT OF c_emp;
  END LOOP;
  DBMS_OUTPUT.PUT_LINE('Raise of ' || p_pct || '% applied to department ' || p_department_id);
END give_raise;
/

CREATE OR REPLACE TRIGGER trg_orders_bi
BEFORE INSERT ON orders FOR EACH ROW
BEGIN
  IF :NEW.order_id IS NULL THEN
    SELECT order_seq.NEXTVAL INTO :NEW.order_id FROM dual;
  END IF;
  :NEW.ref_code := 'ORD-' || TO_CHAR(SYSDATE, 'YYYYMMDD') || '-' || :NEW.order_id;
END;
/

CREATE OR REPLACE TRIGGER trg_orders_status_au
AFTER UPDATE OF status ON orders FOR EACH ROW
WHEN (OLD.status <> NEW.status)
BEGIN
  INSERT INTO audit_log (log_id, message)
  VALUES (audit_seq.NEXTVAL, 'order ' || :NEW.order_id || ': ' || :OLD.status || ' -> ' || :NEW.status);
END;
/
EXIT
