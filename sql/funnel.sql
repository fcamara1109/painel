-- Painel de funil: uma linha por período e uma linha 'total'.
-- Mesmas definições de analytics.funnel_event_date / funnel_cohort (lead, marcado, agendado,
-- realizado, upsell, faturado, honorário, CPA, CPR, ROAS do honorário). Muda só a agregação:
-- paciente é contado DISTINTO dentro do período (as views contam por dia), e o total é
-- distinto no intervalo inteiro (ROLLUP), nunca a soma das linhas.
-- Parâmetros: @tenant, @start_date, @end_date, @grain, @basis ('event'|'lead') e os arrays
-- @attribution, @procedure, @location, @modality, @event_type, @campaign, @ad_group, e @channels (canais marcados no filtro Canal, só quando a seleção é parcial).
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
-- Canal (coluna `channel`): cada linha sai uma vez por canal que existe nos dados mais a visão 'all' (todos). O canal de cada evento vem do
-- event_channel (sql/_channel.sql, colado na frente: uma definição só para este arquivo, completed.sql, marked.sql e options.sql).
-- Gasto de mídia: o canal é a plataforma do ad_spend (google_ads, meta_ads...). Paciente: herda o canal do agendamento marcado mais recente.
-- Custo fixo de aquisição do canal: eventos `fixed_cost` do raw.events (1 por mês por custo: body.channel, body.month 'AAAA-MM', event_value =
-- valor do mês; escritos por _shared/tools/custo_fixo_evento.py). Aqui o valor do mês é rateado por dia (valor / dias do mês)
-- e entra no gasto (spend = mídia + custo fixo; media_spend e fixed_spend saem separados). CPM, CPC e CTR seguem só a mídia.
-- O custo fixo vale só sem filtro de atribuição, campanha ou grupo (não se atribui a um grupo de anúncio) e, como a mídia, sai NULL
-- com filtro de procedimento, local, modalidade ou tipo de evento. ROI = (honorário - gasto) / gasto, NULL nas mesmas condições do ROAS.
-- Seleção parcial de canais (2 ou mais, mas nem todos; só existe com 3 canais ou mais): paciente distinto e taxa não somam entre canais, então o
-- JS nunca soma linhas de canal. Com @channels preenchido, cada evento desses canais sai também na visão 'selected' (mesmas contas, mesmo ROLLUP e
-- mesma comparação com o período anterior das demais visões). @channels vazio: não existe visão 'selected'. Nenhum canal marcado ou todos os canais
-- = visão 'all'; um canal = a visão dele; a página só consulta de novo quando a seleção parcial muda.
-- Gasto zero (canal ou dia sem custo) deixa os custos por etapa (CPL, CPA, CPR, custo por agendamento) NULL: nunca R$ 0,00 que pareça real.
WITH
-- @event_channel
cfg AS (
  SELECT (n_items(@procedure) + n_items(@location) + n_items(@modality) + n_items(@event_type)) = 0
    AND EXISTS (SELECT 1 FROM `analytics.funnel_events_attributed` WHERE tenant = @tenant AND event_name = 'ad_spend') AS has_spend,
    (n_items(@attribution) + n_items(@campaign) + n_items(@ad_group)) = 0 AS fixed_applies
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
fixed_days AS (
  SELECT
    channel,
    d AS metric_date,
    amount / (DATE_DIFF(LAST_DAY(m, MONTH), m, DAY) + 1) AS fixed_value
  FROM (
    SELECT
      JSON_VALUE(body, '$.channel') AS channel,
      DATE(CONCAT(JSON_VALUE(body, '$.month'), '-01')) AS m,
      SAFE_CAST(event_value AS FLOAT64) AS amount
    FROM `raw.events`
    WHERE tenant = @tenant AND event_name = 'fixed_cost' AND JSON_VALUE(body, '$._debug') IS NULL
  )
  CROSS JOIN UNNEST(GENERATE_DATE_ARRAY(m, LAST_DAY(m, MONTH))) AS d
),
dated_events AS (
  SELECT
    e.event_name, e.event_id, e.event_value, e.impressions, e.clicks,
    e.lead_key, e.patient_key,
    e.lead_event_flag, e.marked_event_flag, e.scheduled_event_flag, e.completed_event_flag, e.upsell_event_flag,
    IF(e.event_name = 'ad_spend' OR @basis != 'lead', e.event_date, e.cohort_date) AS metric_date,
    COALESCE(ch.channel, media_channel(NULL)) AS channel,
    CAST(NULL AS FLOAT64) AS fixed_value
  FROM `analytics.funnel_events_attributed` AS e
  CROSS JOIN cfg
  LEFT JOIN visit_types AS v ON v.event_id = e.event_id
  LEFT JOIN event_channel AS ch ON ch.event_id = e.event_id
  WHERE e.tenant = @tenant
    AND e.event_name != 'fixed_cost'
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
dated AS (
  SELECT * FROM dated_events
  UNION ALL
  SELECT
    'fixed_cost', CAST(NULL AS INT64), CAST(NULL AS NUMERIC), CAST(NULL AS INT64), CAST(NULL AS INT64),
    CAST(NULL AS STRING), CAST(NULL AS STRING),
    CAST(NULL AS INT64), CAST(NULL AS INT64), CAST(NULL AS INT64), CAST(NULL AS INT64), CAST(NULL AS INT64),
    f.metric_date, f.channel, f.fixed_value
  FROM fixed_days AS f
  CROSS JOIN cfg
  WHERE cfg.fixed_applies
),
joined AS (
  SELECT
    IF(dated.metric_date >= win.cur_start, 'cur', 'prev') AS span,
    bucket(dated.metric_date, @grain) AS period_start,
    channel_view,
    dated.*,
    completed.physician_fee
  FROM dated
  CROSS JOIN UNNEST(ARRAY_CONCAT(['all', dated.channel], IF(dated.channel IN UNNEST(@channels), ['selected'], ARRAY<STRING>[]))) AS channel_view
  CROSS JOIN win
  LEFT JOIN `analytics.completed_procedures` AS completed
    ON completed.tenant = @tenant
   AND completed.event_id = dated.event_id
  WHERE dated.metric_date BETWEEN win.cur_start AND @end_date
     OR dated.metric_date BETWEEN win.prev_start AND win.prev_end
),
agg AS (
  SELECT
    channel_view AS channel,
    span,
    IF(GROUPING(period_start) = 1, 'total', FORMAT_DATE('%Y-%m-%d', period_start)) AS period,
    SUM(IF(event_name = 'ad_spend', SAFE_CAST(event_value AS FLOAT64), 0)) AS media_spend,
    SUM(IF(event_name = 'fixed_cost', fixed_value, 0)) AS fixed_spend,
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
  GROUP BY GROUPING SETS ((channel_view, span, period_start), (channel_view, span))  -- ROLLUP por canal
  HAVING GROUPING(span) = 0 AND (span = 'cur' OR GROUPING(period_start) = 1)  -- períodos só do atual; do anterior, só o total
),
spent AS (
  SELECT agg.*, agg.media_spend + agg.fixed_spend AS spend FROM agg
),
metrics AS (
  SELECT
    channel,
    span,
    period,
    IF(cfg.has_spend, spend, NULL) AS spend,
    IF(cfg.has_spend, media_spend, NULL) AS media_spend,
    IF(cfg.has_spend, fixed_spend, NULL) AS fixed_spend,
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
    IF(cfg.has_spend, SAFE_DIVIDE(media_spend * 1000, impressions), NULL) AS cpm,
    IF(cfg.has_spend, SAFE_DIVIDE(media_spend, clicks), NULL) AS cpc,
    IF(cfg.has_spend, SAFE_DIVIDE(NULLIF(spend, 0), leads), NULL) AS cpl,
    IF(cfg.has_spend, SAFE_DIVIDE(NULLIF(spend, 0), marked_patients), NULL) AS cpa,
    IF(cfg.has_spend, SAFE_DIVIDE(NULLIF(spend, 0), completed_patients), NULL) AS cpr,
    IF(cfg.has_spend, SAFE_DIVIDE(physician_fee, spend), NULL) AS roas_honorario,
    IF(cfg.has_spend, SAFE_DIVIDE(physician_fee - spend, spend), NULL) AS roi,
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
    IF(cfg.has_spend, SAFE_DIVIDE(NULLIF(spend, 0), scheduled_patients), NULL) AS cost_per_scheduled
    FROM spent
    CROSS JOIN cfg
)
SELECT
  c.channel, c.period, c.spend, c.media_spend, c.fixed_spend, c.impressions, c.clicks, c.leads, c.marked_patients, c.scheduled_patients, c.completed_patients,
  c.completed_with_value, c.upsell_patients, c.billed_amount, c.physician_fee,
  c.cpm, c.cpc, c.cpl, c.cpa, c.cpr, c.roas_honorario, c.roi, c.ctr, c.click_to_lead,
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
  chg(c.physician_fee, p.physician_fee) AS physician_fee_chg,
  chg(c.cpl, p.cpl) AS cpl_chg,
  chg(c.cpa, p.cpa) AS cpa_chg,
  chg(c.cost_per_scheduled, p.cost_per_scheduled) AS cost_per_scheduled_chg,
  chg(c.cpr, p.cpr) AS cpr_chg,
  chg(c.roas_honorario, p.roas_honorario) AS roas_honorario_chg,
  pp(c.roi, p.roi) AS roi_pp,
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
LEFT JOIN metrics AS p ON c.period = 'total' AND p.span = 'prev' AND p.channel = c.channel
WHERE c.span = 'cur'
ORDER BY c.channel, c.period = 'total', c.period;
