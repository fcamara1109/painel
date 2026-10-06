-- Lista de acompanhamento de cirurgia do cliente: o snapshot mais recente do radar (clean.surgery_followup).
-- Parâmetro: só @tenant. Não traz o id do paciente no Asa: a tela mostra primeiro nome e final do telefone.
-- Fonte: fred/tools/asa_cirurgia_pipeline.py --bq --aplicar (só acrescenta; cada rodada é um snapshot_at).
SELECT
  FORMAT_DATE('%Y-%m-%d', DATE(snapshot_at, 'America/Sao_Paulo')) AS snapshot_date,
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
FROM `my-first-project-237704.clean.surgery_followup`
WHERE tenant = @tenant
  AND snapshot_at = (
    SELECT MAX(snapshot_at) FROM `my-first-project-237704.clean.surgery_followup` WHERE tenant = @tenant
  )
ORDER BY last_interaction_date, first_name;
