-- Lista de marcações (scheduled sem upsell + referral), com os mesmos filtros e a mesma base de data do funnel.sql.
-- Retorno fica fora (ver is_return em _prelude.sql).
-- Fonte: analytics.marked_patient_detail (marking_type = 'scheduled' ou 'referral').
-- Campanha e grupo do lead vêm de funnel_events_attributed. Parâmetros: os mesmos do funnel.sql.
WITH visit_types AS (
  SELECT event_id, JSON_VALUE(body, '$.visit_type') AS visit_type
  FROM `my-first-project-237704.raw.events`
  WHERE tenant = @tenant AND JSON_VALUE(body, '$._debug') IS NULL AND JSON_VALUE(body, '$.visit_type') IS NOT NULL
)
SELECT
  IF(@basis = 'lead', m.cohort_date, m.event_date) AS metric_date,
  m.event_date,
  m.cohort_date AS lead_date,
  m.appointment_date,
  m.marking_type,
  m.patient_name,
  norm_procedure(m.procedure_name) AS procedure_name,
  norm_location(m.location) AS location,
  norm_modality(m.modality) AS modality,
  m.payer,
  m.attribution,
  label_campaign(e.lead_campaign) AS lead_campaign,
  label_ad_group(e.lead_ad_group_name) AS lead_ad_group,
  m.source,
  m.referred_to,
  m.reason,
  m.event_id
FROM `my-first-project-237704.analytics.marked_patient_detail` AS m
JOIN `my-first-project-237704.analytics.funnel_events_attributed` AS e
  ON e.tenant = m.tenant
 AND e.event_id = m.event_id
LEFT JOIN visit_types AS v ON v.event_id = e.event_id
WHERE m.tenant = @tenant
  AND counts_in_funnel(v.visit_type, e.procedure_name)
  AND IF(@basis = 'lead', m.cohort_date, m.event_date) BETWEEN @start_date AND @end_date
  AND event_matches(
    e.attribution, e.procedure_name, e.location, e.modality, e.event_name, e.lead_campaign, e.lead_ad_group_name,
    @attribution, @procedure, @location, @modality, @event_type, @campaign, @ad_group
  )
ORDER BY metric_date DESC, m.event_id;
