-- Clientes (tenants) com evento no funil, para o seletor de cliente do painel. Sem parâmetros.
-- n = linhas de evento; spend_rows = linhas de gasto de mídia (0 = cliente sem dado de mídia).
-- first_date = primeiro dia com evento do cliente (custo fixo não conta): início do atalho "Todo o período" e
-- critério de "sem período anterior para comparar" no seletor de período.
-- A view já deixa o _debug de fora (ver _shared/sql/funnel_views.sql).
SELECT tenant, COUNT(*) AS n, COUNTIF(event_name = 'ad_spend') AS spend_rows,
  MIN(IF(event_name != 'fixed_cost', event_date, NULL)) AS first_date
FROM `analytics.funnel_events_attributed`
GROUP BY tenant
ORDER BY n DESC, tenant;
