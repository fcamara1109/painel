-- Foto do quadro de setup: a linha mais recente de analytics.setup_board (gravada a cada 30 min por `ops_log.py matriz --foto`). Sem parâmetros.
-- generated_at em horário de São Paulo (texto, para mostrar); events_until em UTC (texto, volta como @events_until em setup_events.sql).
-- A tabela é particionada por dia e pede o filtro da partição: a foto vale 7 dias. O acesso é pelo login do BigQuery do Felipe; o repo público do painel não leva dado de cliente.
SELECT
  FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', generated_at, 'America/Sao_Paulo') AS generated_at,
  FORMAT_TIMESTAMP('%Y-%m-%d %H:%M:%S+00', events_until) AS events_until,
  html,
  TO_JSON_STRING(body) AS body
FROM `analytics.setup_board`
WHERE DATE(generated_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
ORDER BY generated_at DESC
LIMIT 1;
