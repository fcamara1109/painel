-- Lista de realizados (um procedimento por linha), com os mesmos filtros e a mesma base de data do funnel.sql.
-- Retorno fica fora (ver is_return em _prelude.sql).
-- Fonte: analytics.completed_procedures (faturado e honorário, de clean.honorarios).
-- Campanha e grupo do lead vêm de funnel_events_attributed (completed_procedures não os traz).
-- Parâmetros: os mesmos do funnel.sql.
WITH visit_types AS (
  SELECT event_id, JSON_VALUE(body, '$.visit_type') AS visit_type
  FROM `my-first-project-237704.raw.events`
  WHERE tenant = @tenant AND JSON_VALUE(body, '$._debug') IS NULL AND JSON_VALUE(body, '$.visit_type') IS NOT NULL
)
SELECT
  IF(@basis = 'lead', c.cohort_date, c.event_date) AS metric_date,
  c.event_date,
  c.cohort_date AS lead_date,
  c.appointment_date,
  c.patient_name,
  norm_procedure(c.procedure_name) AS procedure_name,
  norm_location(c.location) AS location,
  norm_modality(c.modality) AS modality,
  c.payer,
  c.attribution,
  label_campaign(e.lead_campaign) AS lead_campaign,
  label_ad_group(e.lead_ad_group_name) AS lead_ad_group,
  c.billed_amount,
  c.physician_fee,
  c.event_id
FROM `my-first-project-237704.analytics.completed_procedures` AS c
JOIN `my-first-project-237704.analytics.funnel_events_attributed` AS e
  ON e.tenant = c.tenant
 AND e.event_id = c.event_id
LEFT JOIN visit_types AS v ON v.event_id = e.event_id
WHERE c.tenant = @tenant
  AND counts_in_funnel(v.visit_type, e.procedure_name)
  AND IF(@basis = 'lead', c.cohort_date, c.event_date) BETWEEN @start_date AND @end_date
  AND event_matches(
    e.attribution, e.procedure_name, e.location, e.modality, e.event_name, e.lead_campaign, e.lead_ad_group_name,
    @attribution, @procedure, @location, @modality, @event_type, @campaign, @ad_group
  )
ORDER BY metric_date DESC, c.event_id;
