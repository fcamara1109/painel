-- Lista de acompanhamento de cirurgia do cliente: o snapshot mais recente do radar (clean.surgery_followup).
-- Parâmetro: só @tenant. Traz erp e erp_patient_id (o id do paciente no sistema da clínica) pra a tela montar os links
-- no navegador. A tabela é protegida por login do BigQuery; o repo público do painel não leva id, nome nem telefone.
-- Fonte: fred/tools/asa_cirurgia_pipeline.py --bq --aplicar (só acrescenta; cada rodada é um snapshot_at).
SELECT
  FORMAT_DATE('%Y-%m-%d', DATE(snapshot_at, 'America/Sao_Paulo')) AS snapshot_date,
  erp,
  erp_patient_id,
  first_name,
  phone_last4,
  consult_date,
  procedure,
  status,
  origin,
  last_interaction_date,
  last_interaction_kind,
  follow_up,
  follow_up_decided_on
FROM `clean.surgery_followup`
WHERE tenant = @tenant
  AND snapshot_at = (
    SELECT MAX(snapshot_at) FROM `clean.surgery_followup` WHERE tenant = @tenant
  )
ORDER BY last_interaction_date, first_name;
