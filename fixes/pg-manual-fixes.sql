-- Hand-written corrections to what ora2pg generated for the ACME schema.
-- Everything in here was needed to make the converted code behave like the Oracle original.
-- Applied by the "Apply the manual fixes" button, as the ACME user.

-- 1. Session defaults. orafce lives in the "oracle" schema, and its Oracle-style SUBSTR, TO_CHAR ...
--    only override PostgreSQL's when "oracle" comes BEFORE pg_catalog in the search_path
--    (what ora2pg emits, "acme, oracle, public", puts pg_catalog first). Set at database level so
--    the dblink loopback used for the autonomous transaction, which opens a NEW session, sees it too.
ALTER DATABASE acme SET search_path = oracle, pg_catalog, acme, public;

-- 2. Package constants and package state. PL/pgSQL has neither, so ora2pg reads them from
--    custom settings (current_setting) that nobody ever initialised.
ALTER DATABASE acme SET order_pkg.c_vat_rate = '0.21';
ALTER DATABASE acme SET order_pkg.g_orders_placed = '0';

SET search_path = oracle, pg_catalog, acme, public;

-- 3. Views whose generated SQL does not compile.
CREATE OR REPLACE VIEW v_org_chart (employee_id, indented_name, depth, path) AS
WITH RECURSIVE cte AS (
  SELECT employee_id, last_name::text AS indented_name, 1 AS depth, '/' || last_name AS path
  FROM   employees WHERE manager_id IS NULL
  UNION ALL
  SELECT e.employee_id, lpad(' ', 2 * c.depth) || e.last_name, c.depth + 1, c.path || '/' || e.last_name
  FROM   employees e JOIN cte c ON e.manager_id = c.employee_id
)
SELECT employee_id, indented_name, depth, path FROM cte;

CREATE OR REPLACE VIEW v_customer_revenue (customer_id, name, country, order_count, revenue) AS
SELECT c.customer_id, c.name, c.country,
       COUNT(DISTINCT o.order_id)                  AS order_count,
       coalesce(SUM(i.quantity * i.unit_price), 0) AS revenue
FROM   customers c
LEFT   JOIN orders      o ON c.customer_id = o.customer_id
LEFT   JOIN order_items i ON o.order_id    = i.order_id
GROUP  BY c.customer_id, c.name, c.country;

-- 4. Standalone procedure: NUMBER became bigint, so p_pct / 100 was integer division
--    and every raise was 0%.
DROP PROCEDURE IF EXISTS give_raise(bigint, bigint);
CREATE OR REPLACE PROCEDURE give_raise(p_department_id numeric, p_pct numeric) AS $$
BEGIN
  UPDATE employees
  SET    salary = round(coalesce(salary, 0) * (1 + p_pct / 100), 2)
  WHERE  department_id = p_department_id;
  PERFORM dbms_output.put_line('Raise of ' || p_pct || '% applied to department ' || p_department_id);
END;
$$ LANGUAGE plpgsql;

-- 5. The package, rewritten. Differences from the generated version:
--      - numeric instead of bigint (the generated order_total silently rounded cents away)
--      - constants and state initialised in step 2, set_config() gets text
--      - autonomous transaction: dblink_exec() instead of dblink() (CALL returns no rows)
--      - BULK COLLECT / FORALL replaced by one set-based UPDATE
DROP SCHEMA IF EXISTS order_pkg CASCADE;
CREATE SCHEMA order_pkg;

CREATE FUNCTION order_pkg.order_total(p_order_id numeric) RETURNS numeric AS $$
DECLARE v_total numeric;
BEGIN
  SELECT coalesce(SUM(quantity * unit_price), 0) INTO v_total FROM order_items WHERE order_id = p_order_id;
  RETURN v_total;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION order_pkg.order_total_vat(p_order_id numeric) RETURNS numeric AS $$
BEGIN
  RETURN round(order_pkg.order_total(p_order_id) * (1 + current_setting('order_pkg.c_vat_rate')::numeric), 2);
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION order_pkg.orders_placed() RETURNS numeric AS $$
BEGIN
  RETURN current_setting('order_pkg.g_orders_placed')::numeric;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION order_pkg.open_orders(p_customer_id numeric) RETURNS refcursor AS $$
DECLARE v_cur refcursor;
BEGIN
  OPEN v_cur FOR SELECT order_id, order_date, status FROM orders
                 WHERE customer_id = p_customer_id AND status = 'NEW' ORDER BY order_date;
  RETURN v_cur;
END;
$$ LANGUAGE plpgsql;

CREATE EXTENSION IF NOT EXISTS dblink;

CREATE PROCEDURE order_pkg.log_msg_atx(p_msg text) AS $$
BEGIN
  INSERT INTO audit_log (log_id, message) VALUES (nextval('audit_seq'), p_msg);
END;
$$ LANGUAGE plpgsql;

CREATE PROCEDURE order_pkg.log_msg(p_msg text) AS $$
BEGIN
  -- separate session = separate transaction: the row survives a rollback of the caller
  PERFORM dblink_exec(format('port=%s dbname=%s user=%s', current_setting('port'), current_database(), current_user),
                      format('CALL order_pkg.log_msg_atx(%L)', p_msg));
END;
$$ LANGUAGE plpgsql;

CREATE PROCEDURE order_pkg.place_order(p_customer_id numeric, p_sku text, p_qty numeric, INOUT p_order_id numeric DEFAULT NULL) AS $$
DECLARE v_product products%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_product FROM products WHERE sku = p_sku;
  IF v_product.stock_qty < p_qty THEN
    RAISE EXCEPTION 'Out of stock: %', p_sku USING ERRCODE = '45010';
  END IF;

  INSERT INTO orders (order_id, customer_id) VALUES (nextval('order_seq'), p_customer_id)
  RETURNING order_id INTO p_order_id;

  INSERT INTO order_items (order_id, line_no, product_id, quantity, unit_price)
  VALUES (p_order_id, 1, v_product.product_id, p_qty, v_product.list_price);

  UPDATE products SET stock_qty = stock_qty - p_qty WHERE product_id = v_product.product_id;

  PERFORM set_config('order_pkg.g_orders_placed', (current_setting('order_pkg.g_orders_placed')::numeric + 1)::text, false);
  PERFORM dbms_output.put_line('Order ' || p_order_id || ' placed: ' || p_qty || ' x ' || p_sku);
  CALL order_pkg.log_msg('order ' || p_order_id || ' placed for customer ' || p_customer_id);
EXCEPTION
  WHEN no_data_found THEN
    RAISE EXCEPTION 'Unknown product: %', p_sku USING ERRCODE = '45011';
END;
$$ LANGUAGE plpgsql;

CREATE PROCEDURE order_pkg.close_stale_orders(p_days numeric, INOUT p_closed numeric DEFAULT NULL) AS $$
BEGIN
  UPDATE orders SET status = 'STALE'
  WHERE  status = 'NEW' AND order_date < localtimestamp - make_interval(days => p_days::int);
  GET DIAGNOSTICS p_closed = ROW_COUNT;
  PERFORM dbms_output.put_line(p_closed || ' stale orders closed');
END;
$$ LANGUAGE plpgsql;
