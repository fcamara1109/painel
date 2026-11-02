-- Painel de funil: uma linha por período e uma linha 'total'.
-- Mesmas definições de analytics.funnel_event_date / funnel_cohort (lead, marcado, agendado,
-- realizado, upsell, faturado, honorário, CPA, CPR, ROAS do honorário). Muda só a agregação:
-- paciente é contado DISTINTO dentro do período (as views contam por dia), e o total é
-- distinto no intervalo inteiro (ROLLUP), nunca a soma das linhas.
-- Parâmetros: @tenant, @start_date, @end_date, @grain, @basis ('event'|'lead') e os arrays
-- @attribution, @procedure, @location, @modality, @event_type, @campaign, @ad_group.
-- Base 'lead': eventos de paciente caem na cohort_date; gasto, impressões e cliques ficam na data deles.
-- Retorno fica fora (visit_type 'return' do BQ): ver is_return em _prelude.sql.
-- Filtro de procedimento, local, modalidade ou tipo de evento não se aplica ao gasto: com
-- qualquer um ativo, gasto, impressões, cliques, custos, CTR, clique->lead e ROAS saem NULL.
-- Cliente sem nenhuma linha de gasto de mídia (ad_spend) também sai NULL: vazio, nunca 0 que pareça real.
-- Comparação: a linha 'total' traz também o período anterior, com os MESMOS cliente, base e filtros. Regra em prev_window
-- (_prelude.sql): mês inteiro contra o(s) mês(es) inteiro(s) anterior(es); trecho do mês contra o mesmo trecho do mês anterior;
-- outro intervalo, mesma duração logo antes. *_chg = variação relativa (0,12 = +12%), *_pp = mudança de
-- taxa em pontos percentuais, prev_* = taxa do período anterior, biggest_drop = a passagem com a maior queda em pp.
-- Anterior vazio, zero ou nulo = NULL (sem base): nunca uma variação inventada. As linhas por período não levam comparação.
WITH cfg AS (
  SELECT (n_items(@procedure) + n_items(@location) + n_items(@modality) + n_items(@event_type)) = 0
    AND EXISTS (SELECT 1 FROM `analytics.funnel_events_attributed` WHERE tenant = @tenant AND event_name = 'ad_spend') AS has_spend
),
win AS (
  SELECT
    @start_date AS cur_start,
    w.prev_start AS prev_start,
    w.prev_end AS prev_end
  FROM (SELECT prev_window(@start_date, @end_date) AS w)
),
visit_types AS (
  SELECT event_id, JSON_VALUE(body, '$.visit_type') AS visit_type
  FROM `raw.events`
  WHERE tenant = @tenant AND JSON_VALUE(body, '$._debug') IS NULL AND JSON_VALUE(body, '$.visit_type') IS NOT NULL
),
dated AS (
  SELECT
    e.event_name, e.event_id, e.event_value, e.impressions, e.clicks,
    e.lead_key, e.patient_key,
    e.lead_event_flag, e.marked_event_flag, e.scheduled_event_flag, e.completed_event_flag, e.upsell_event_flag,
    IF(e.event_name = 'ad_spend' OR @basis != 'lead', e.event_date, e.cohort_date) AS metric_date
  FROM `analytics.funnel_events_attributed` AS e
  CROSS JOIN cfg
  LEFT JOIN visit_types AS v ON v.event_id = e.event_id
  WHERE e.tenant = @tenant
    AND counts_in_funnel(v.visit_type)
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
    IF(dated.metric_date >= win.cur_start, 'cur', 'prev') AS span,
    bucket(dated.metric_date, @grain) AS period_start,
    dated.*,
    completed.physician_fee
  FROM dated
  CROSS JOIN win
  LEFT JOIN `analytics.completed_procedures` AS completed
    ON completed.tenant = @tenant
   AND completed.event_id = dated.event_id
  WHERE dated.metric_date BETWEEN win.cur_start AND @end_date
     OR dated.metric_date BETWEEN win.prev_start AND win.prev_end
),
agg AS (
  SELECT
    span,
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
  GROUP BY ROLLUP(span, period_start)
  HAVING GROUPING(span) = 0 AND (span = 'cur' OR GROUPING(period_start) = 1)  -- períodos só do atual; do anterior, só o total
),
metrics AS (
  SELECT
    span,
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
    SAFE_DIVIDE(physician_fee, completed_with_value) AS avg_fee,
    SAFE_DIVIDE(scheduled_patients, marked_patients) AS marked_to_scheduled,
    SAFE_DIVIDE(completed_patients, scheduled_patients) AS scheduled_to_completed,
    SAFE_DIVIDE(leads, leads) AS leads_of_leads,
    SAFE_DIVIDE(marked_patients, leads) AS marked_of_leads,
    SAFE_DIVIDE(scheduled_patients, leads) AS scheduled_of_leads,
    SAFE_DIVIDE(completed_patients, leads) AS completed_of_leads,
    IF(cfg.has_spend, SAFE_DIVIDE(spend, scheduled_patients), NULL) AS cost_per_scheduled
    FROM agg
    CROSS JOIN cfg
)
SELECT
  c.period, c.spend, c.impressions, c.clicks, c.leads, c.marked_patients, c.scheduled_patients, c.completed_patients,
  c.completed_with_value, c.upsell_patients, c.billed_amount, c.physician_fee,
  c.cpm, c.cpc, c.cpl, c.cpa, c.cpr, c.roas_honorario, c.ctr, c.click_to_lead,
  c.lead_to_marked, c.marked_to_completed, c.completed_to_upsell, c.avg_ticket, c.avg_fee,
  c.marked_to_scheduled, c.scheduled_to_completed, c.leads_of_leads, c.marked_of_leads, c.scheduled_of_leads, c.completed_of_leads,
  c.cost_per_scheduled,
  IF(c.period = 'total', win.prev_start, NULL) AS prev_start,
  IF(c.period = 'total', win.prev_end, NULL) AS prev_end,
  chg(c.leads, p.leads) AS leads_chg,
  chg(c.marked_patients, p.marked_patients) AS marked_patients_chg,
  chg(c.scheduled_patients, p.scheduled_patients) AS scheduled_patients_chg,
  chg(c.completed_patients, p.completed_patients) AS completed_patients_chg,
  chg(c.spend, p.spend) AS spend_chg,
  chg(c.cpl, p.cpl) AS cpl_chg,
  chg(c.cpa, p.cpa) AS cpa_chg,
  chg(c.cost_per_scheduled, p.cost_per_scheduled) AS cost_per_scheduled_chg,
  chg(c.cpr, p.cpr) AS cpr_chg,
  chg(c.roas_honorario, p.roas_honorario) AS roas_honorario_chg,
  p.lead_to_marked AS prev_lead_to_marked,
  p.marked_to_scheduled AS prev_marked_to_scheduled,
  p.scheduled_to_completed AS prev_scheduled_to_completed,
  pp(c.lead_to_marked, p.lead_to_marked) AS lead_to_marked_pp,
  pp(c.marked_to_scheduled, p.marked_to_scheduled) AS marked_to_scheduled_pp,
  pp(c.scheduled_to_completed, p.scheduled_to_completed) AS scheduled_to_completed_pp,
  IF(c.period = 'total', (
    SELECT s.step
    FROM UNNEST([
      STRUCT(1 AS ord, 'lead_to_marked' AS step, pp(c.lead_to_marked, p.lead_to_marked) AS drop_pp),
      STRUCT(2, 'marked_to_scheduled', pp(c.marked_to_scheduled, p.marked_to_scheduled)),
      STRUCT(3, 'scheduled_to_completed', pp(c.scheduled_to_completed, p.scheduled_to_completed))
    ]) AS s
    WHERE s.drop_pp < 0
    ORDER BY s.drop_pp, s.ord
    LIMIT 1
  ), NULL) AS biggest_drop
FROM metrics AS c
CROSS JOIN win
LEFT JOIN metrics AS p ON c.period = 'total' AND p.span = 'prev'
WHERE c.span = 'cur'
ORDER BY c.period = 'total', c.period;
