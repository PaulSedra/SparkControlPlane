CREATE MATERIALIZED VIEW demo_orders AS
SELECT *
FROM VALUES
    (1, 'Ada', CAST(125.50 AS DECIMAL(10, 2))),
    (2, 'Grace', CAST(89.00 AS DECIMAL(10, 2))),
    (3, 'Katherine', CAST(240.25 AS DECIMAL(10, 2)))
AS orders(order_id, customer, amount);
