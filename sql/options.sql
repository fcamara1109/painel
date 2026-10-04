-- Valores distintos de cada filtro no intervalo, para os dropdowns (n = linhas de evento).
-- Usa @tenant, @start_date, @end_date e @basis. Os valores saem normalizados, iguais aos que
-- funnel.sql, completed.sql e marked.sql comparam. Retorno fica fora (ver is_return em _prelude.sql). Gasto entra só em atribuição, campanha e grupo.
WITH visit_types AS (
  SELECT event_id, JSON_VALUE(body, '$.visit_type') AS visit_type
  FROM `my-first-project-237704.raw.events`
  WHERE tenant = @tenant AND JSON_VALUE(body, '$._debug') IS NULL AND JSON_VALUE(body, '$.visit_type') IS NOT NULL
),
rows_in_range AS (
  SELECT
    e.event_name,
    e.attribution,
    IF(e.event_name = 'ad_spend', NULL, norm_procedure(e.procedure_name)) AS procedure_name,
    IF(e.event_name = 'ad_spend', NULL, norm_location(e.location)) AS location,
    IF(e.event_name = 'ad_spend', NULL, norm_modality(e.modality)) AS modality,
    IF(e.event_name = 'ad_spend', label_campaign(e.campaign), label_campaign(e.lead_campaign)) AS campaign,
    IF(e.event_name = 'ad_spend', label_ad_group(e.ad_group_name), label_ad_group(e.lead_ad_group_name)) AS ad_group
  FROM `my-first-project-237704.analytics.funnel_events_attributed` AS e
  LEFT JOIN visit_types AS v ON v.event_id = e.event_id
  WHERE e.tenant = @tenant
    AND counts_in_funnel(v.visit_type, e.procedure_name)
    AND IF(e.event_name = 'ad_spend' OR @basis != 'lead', e.event_date, e.cohort_date) BETWEEN @start_date AND @end_date
)
SELECT filter, value, n FROM (
  SELECT 'attribution' AS filter, attribution AS value, COUNT(*) AS n FROM rows_in_range WHERE attribution IS NOT NULL GROUP BY value
  UNION ALL
  SELECT 'procedure', procedure_name, COUNT(*) FROM rows_in_range WHERE procedure_name IS NOT NULL GROUP BY procedure_name
  UNION ALL
  SELECT 'location', location, COUNT(*) FROM rows_in_range WHERE location IS NOT NULL GROUP BY location
  UNION ALL
  SELECT 'modality', modality, COUNT(*) FROM rows_in_range WHERE modality IS NOT NULL GROUP BY modality
  UNION ALL
  SELECT 'event_type', event_name, COUNT(*) FROM rows_in_range WHERE event_name != 'ad_spend' GROUP BY event_name
  UNION ALL
  SELECT 'campaign', campaign, COUNT(*) FROM rows_in_range GROUP BY campaign
  UNION ALL
  SELECT 'ad_group', ad_group, COUNT(*) FROM rows_in_range GROUP BY ad_group
)
ORDER BY filter, value;
