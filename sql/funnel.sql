-- Painel de funil: uma linha por período e uma linha 'total'.
-- Mesmas definições de analytics.funnel_event_date / funnel_cohort (lead, marcado, agendado,
-- realizado, upsell, faturado, honorário, CPA, CPR, ROAS do honorário). Muda só a agregação:
-- paciente é contado DISTINTO dentro do período (as views contam por dia), e o total é
-- distinto no intervalo inteiro (ROLLUP), nunca a soma das linhas.
-- Parâmetros: @tenant, @start_date, @end_date, @grain, @basis ('event'|'lead') e os arrays
-- @attribution, @procedure, @location, @modality, @event_type, @campaign, @ad_group.
-- Base 'lead': eventos de paciente caem na cohort_date; gasto, impressões e cliques ficam na data deles.
-- Retorno fica fora (visit_type 'return' ou procedimento Retorno): ver is_return em _prelude.sql.
-- Filtro de procedimento, local, modalidade ou tipo de evento não se aplica ao gasto: com
-- qualquer um ativo, gasto, impressões, cliques, custos, CTR, clique->lead e ROAS saem NULL.
WITH cfg AS (
  SELECT (n_items(@procedure) + n_items(@location) + n_items(@modality) + n_items(@event_type)) = 0 AS has_spend
),
visit_types AS (
  SELECT event_id, JSON_VALUE(body, '$.visit_type') AS visit_type
  FROM `my-first-project-237704.raw.events`
  WHERE tenant = @tenant AND JSON_VALUE(body, '$._debug') IS NULL AND JSON_VALUE(body, '$.visit_type') IS NOT NULL
),
dated AS (
  SELECT
    e.event_name, e.event_id, e.event_value, e.impressions, e.clicks,
    e.lead_key, e.patient_key,
    e.lead_event_flag, e.marked_event_flag, e.scheduled_event_flag, e.completed_event_flag, e.upsell_event_flag,
    IF(e.event_name = 'ad_spend' OR @basis != 'lead', e.event_date, e.cohort_date) AS metric_date
  FROM `my-first-project-237704.analytics.funnel_events_attributed` AS e
  CROSS JOIN cfg
  LEFT JOIN visit_types AS v ON v.event_id = e.event_id
  WHERE e.tenant = @tenant
    AND counts_in_funnel(v.visit_type, e.procedure_name)
    AND IF(
      e.event_name = 'ad_spend',
      cfg.has_spend AND spend_matches(e.attribution, e.campaign, e.ad_group_name, @attribution, @campaign, @ad_group),
      event_matches(
        e.attribution, e.procedure_name, e.location, e.modality, e.event_name, e.lead_campaign, e.lead_ad_group_name,
        @attribution, @procedure, @location, @modality, @event_type, @campaign, @ad_group
      )
    )
),
joined AS (
  SELECT
    bucket(dated.metric_date, @grain) AS period_start,
    dated.*,
    completed.physician_fee
  FROM dated
  LEFT JOIN `my-first-project-237704.analytics.completed_procedures` AS completed
    ON completed.tenant = @tenant
   AND completed.event_id = dated.event_id
  WHERE dated.metric_date BETWEEN @start_date AND @end_date
),
agg AS (
  SELECT
    IF(GROUPING(period_start) = 1, 'total', FORMAT_DATE('%Y-%m-%d', period_start)) AS period,
    SUM(IF(event_name = 'ad_spend', SAFE_CAST(event_value AS FLOAT64), 0)) AS spend,
    SUM(IF(event_name = 'ad_spend', impressions, 0)) AS impressions,
    SUM(IF(event_name = 'ad_spend', clicks, 0)) AS clicks,
    COUNT(DISTINCT IF(lead_event_flag = 1, lead_key, NULL)) AS leads,
    COUNT(DISTINCT IF(marked_event_flag = 1, patient_key, NULL)) AS marked_patients,
    COUNT(DISTINCT IF(scheduled_event_flag = 1, patient_key, NULL)) AS scheduled_patients,
    COUNT(DISTINCT IF(completed_event_flag = 1, patient_key, NULL)) AS completed_patients,
    COUNT(DISTINCT IF(completed_event_flag = 1 AND event_value IS NOT NULL AND physician_fee IS NOT NULL, patient_key, NULL)) AS completed_with_value,
    COUNT(DISTINCT IF(upsell_event_flag = 1, patient_key, NULL)) AS upsell_patients,
    SUM(IF(event_name = 'attended', SAFE_CAST(event_value AS FLOAT64), 0)) AS billed_amount,
    SUM(IF(event_name = 'attended', physician_fee, NULL)) AS physician_fee
  FROM joined
  GROUP BY ROLLUP(period_start)
)
SELECT
  period,
  IF(cfg.has_spend, spend, NULL) AS spend,
  IF(cfg.has_spend, impressions, NULL) AS impressions,
  IF(cfg.has_spend, clicks, NULL) AS clicks,
  leads,
  marked_patients,
  scheduled_patients,
  completed_patients,
  completed_with_value,
  upsell_patients,
  billed_amount,
  physician_fee,
  IF(cfg.has_spend, SAFE_DIVIDE(spend * 1000, impressions), NULL) AS cpm,
  IF(cfg.has_spend, SAFE_DIVIDE(spend, clicks), NULL) AS cpc,
  IF(cfg.has_spend, SAFE_DIVIDE(spend, leads), NULL) AS cpl,
  IF(cfg.has_spend, SAFE_DIVIDE(spend, marked_patients), NULL) AS cpa,
  IF(cfg.has_spend, SAFE_DIVIDE(spend, completed_patients), NULL) AS cpr,
  IF(cfg.has_spend, SAFE_DIVIDE(physician_fee, spend), NULL) AS roas_honorario,
  IF(cfg.has_spend, SAFE_DIVIDE(clicks, impressions), NULL) AS ctr,
  IF(cfg.has_spend, SAFE_DIVIDE(leads, clicks), NULL) AS click_to_lead,
  SAFE_DIVIDE(marked_patients, leads) AS lead_to_marked,
  SAFE_DIVIDE(completed_patients, marked_patients) AS marked_to_completed,
  SAFE_DIVIDE(upsell_patients, completed_patients) AS completed_to_upsell,
  SAFE_DIVIDE(billed_amount, completed_with_value) AS avg_ticket,
  SAFE_DIVIDE(physician_fee, completed_with_value) AS avg_fee
FROM agg
CROSS JOIN cfg
ORDER BY period = 'total', period;
