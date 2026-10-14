CREATE MATERIALIZED VIEW demo_customer_totals AS
SELECT customer, COUNT(*) AS order_count, SUM(amount) AS total_amount
FROM demo_orders
GROUP BY customer;
