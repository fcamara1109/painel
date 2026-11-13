-- Pacientes do acompanhamento de TODOS os clientes (tela Hoje): como patients.sql, sem filtro de tenant e com a coluna tenant na frente. Só leitura, sem parâmetros.
-- Colunas de painel/fixtures/README_pacientes.md mais tenant. A regra (situação, cobertura, devido, bloqueio) NÃO mora aqui: é _shared/followup.js, que lê estas colunas.
-- Instante sai como texto ISO em UTC com Z (o REST do BigQuery devolve TIMESTAMP em segundos, e a lib lê ISO); data sai AAAA-MM-DD.
-- Traz phone (E.164) e first_name para a tela: a tabela é protegida pelo login do BigQuery; o repo público do painel não leva id, nome nem telefone.
SELECT
  tenant,
  phone,
  phone_key,
  first_name,
  audience,
  audience_detail,
  audience_source,
  attempts,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', last_attempt_at) AS last_attempt_at,
  last_speaker,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', last_message_at) AS last_message_at,
  FORMAT_DATE('%Y-%m-%d', SAFE_CAST(snooze_until AS DATE)) AS snooze_until,
  FORMAT_DATE('%Y-%m-%d', SAFE_CAST(skipped_on AS DATE)) AS skipped_on,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', discarded_at) AS discarded_at,
  discard_reason,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', converted_at) AS converted_at,
  block_reason,
  origin,
  surgery_status,
  diagnosis,
  procedure,
  FORMAT_DATE('%Y-%m-%d', SAFE_CAST(consult_date AS DATE)) AS consult_date,
  erp,
  erp_patient_id
FROM `analytics.patient_followup`
ORDER BY tenant, phone_key;
