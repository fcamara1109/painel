-- Lista de cirurgia de TODOS os clientes (tela Hoje): como surgeries.sql, sem filtro de tenant e com a coluna tenant na frente; vale o snapshot mais recente de cada cliente. Só leitura, sem parâmetros. Traz erp e erp_patient_id (o id do paciente no sistema da clínica) pra a tela montar os links
-- no navegador, e phone (E.164) pro botão de check-in. A tabela é protegida por login do BigQuery; o repo público do painel não leva id, nome nem telefone.
-- Fonte: fred/tools/asa_cirurgia_pipeline.py --bq --aplicar (só acrescenta; cada rodada é um snapshot_at).
SELECT
  tenant,
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
  follow_up_decided_on,
  phone,
  diagnosis
FROM `clean.surgery_followup`
WHERE TRUE
QUALIFY snapshot_at = MAX(snapshot_at) OVER (PARTITION BY tenant)
ORDER BY tenant, last_interaction_date, first_name;
