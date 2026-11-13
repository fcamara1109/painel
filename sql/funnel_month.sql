-- Ritmo do mês e histórico mês a mês (tela Funil): uma linha por mês, os últimos 12 (o corrente vai até hoje).
-- Mesmas definições do funnel.sql (gasto = mídia + custo fixo rateado por dia, paciente realizado distinto no mês, honorário do
-- completed_procedures, retorno fora, ROAS do honorário, CPR). Fixo: base 'event', visão 'all' (todos os canais), SEM filtro de canal,
-- período ou os 7 filtros da tela: o histórico não muda com eles. Por isso não leva @basis nem @channels, nem a CTE do canal.
-- Parâmetro: @tenant. Só leitura (só TEMP FUNCTION no prelúdio).
-- Mês corrente: partial_until = hoje (America/Sao_Paulo); os outros meses saem NULL. A página estende o parcial para o mês inteiro (run rate).
-- Cliente sem nenhuma linha de gasto de mídia (ad_spend): gasto, ROAS e CPR saem NULL, nunca 0 que pareça real.
WITH
cfg AS (
  SELECT
    EXISTS (SELECT 1 FROM `analytics.funnel_events_attributed` WHERE tenant = @tenant AND event_name = 'ad_spend') AS has_spend,
    CURRENT_DATE('America/Sao_Paulo') AS today
),
win AS (
  SELECT DATE_SUB(DATE_TRUNC(today, MONTH), INTERVAL 11 MONTH) AS first_day, today FROM cfg
),
visit_types AS (
  SELECT event_id, JSON_VALUE(body, '$.visit_type') AS visit_type
  FROM `raw.events`
  WHERE tenant = @tenant AND JSON_VALUE(body, '$._debug') IS NULL AND JSON_VALUE(body, '$.visit_type') IS NOT NULL
),
fixed_days AS (
  SELECT
    d AS metric_date,
    amount / (DATE_DIFF(LAST_DAY(m, MONTH), m, DAY) + 1) AS fixed_value
  FROM (
    SELECT
      DATE(CONCAT(JSON_VALUE(body, '$.month'), '-01')) AS m,
      SAFE_CAST(event_value AS FLOAT64) AS amount
    FROM `raw.events`
    WHERE tenant = @tenant AND event_name = 'fixed_cost' AND JSON_VALUE(body, '$._debug') IS NULL
  )
  CROSS JOIN UNNEST(GENERATE_DATE_ARRAY(m, LAST_DAY(m, MONTH))) AS d
),
dated AS (
  SELECT
    e.event_name, e.event_id, e.event_value, e.patient_key, e.completed_event_flag,
    e.event_date AS metric_date,
    CAST(NULL AS FLOAT64) AS fixed_value
  FROM `analytics.funnel_events_attributed` AS e
  CROSS JOIN win
  LEFT JOIN visit_types AS v ON v.event_id = e.event_id
  WHERE e.tenant = @tenant
    AND e.event_name != 'fixed_cost'
    AND counts_in_funnel(v.visit_type)
    AND e.event_date BETWEEN win.first_day AND win.today
  UNION ALL
  SELECT
    'fixed_cost', CAST(NULL AS INT64), CAST(NULL AS NUMERIC), CAST(NULL AS STRING), CAST(NULL AS INT64),
    f.metric_date, f.fixed_value
  FROM fixed_days AS f
  CROSS JOIN win
  WHERE f.metric_date BETWEEN win.first_day AND win.today
),
agg AS (
  SELECT
    DATE_TRUNC(dated.metric_date, MONTH) AS month,
    SUM(IF(dated.event_name = 'ad_spend', SAFE_CAST(dated.event_value AS FLOAT64), 0)) + SUM(IF(dated.event_name = 'fixed_cost', dated.fixed_value, 0)) AS spend,
    COUNT(DISTINCT IF(dated.completed_event_flag = 1, dated.patient_key, NULL)) AS completed_patients,
    SUM(IF(dated.event_name = 'attended', completed.physician_fee, NULL)) AS physician_fee
  FROM dated
  LEFT JOIN `analytics.completed_procedures` AS completed
    ON completed.tenant = @tenant
   AND completed.event_id = dated.event_id
  GROUP BY month
)
SELECT
  FORMAT_DATE('%Y-%m', agg.month) AS period,
  IF(cfg.has_spend, agg.spend, NULL) AS spend,
  agg.physician_fee,
  agg.completed_patients,
  IF(cfg.has_spend, SAFE_DIVIDE(agg.physician_fee, NULLIF(agg.spend, 0)), NULL) AS roas_honorario,
  IF(cfg.has_spend, SAFE_DIVIDE(NULLIF(agg.spend, 0), agg.completed_patients), NULL) AS cpr,
  IF(agg.month = DATE_TRUNC(cfg.today, MONTH), FORMAT_DATE('%Y-%m-%d', cfg.today), NULL) AS partial_until
FROM agg
CROSS JOIN cfg
ORDER BY agg.month;
