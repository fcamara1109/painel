-- Atividades dos clientes: tudo o que aconteceu entre o Felipe e cada cliente, uma linha por evento (setup, reunião gravada, tarefa, dia de WhatsApp).
-- Parâmetros: @start_date e @end_date (DATE, dias de São Paulo). Sem @tenant: a página filtra o cliente, o tipo e o período no navegador.
-- Fonte: raw.events (tabela única, coluna tenant). Os 12 eventos de atividade: seis setup_*, meeting_recorded, quatro task_* e whatsapp_day (contrato em state/plans/2026-11-11-aba-atividades.md).
-- O _debug (teste) fica de fora. O detail é o body inteiro em JSON, com as chaves em inglês; a página faz os rótulos em pt-BR. O link só existe em reunião (share_url do Fathom).
-- Custo: raw.events não tem partição nem cluster (cerca de 5 mil linhas, 0,6 MB); a consulta lê tenant, timestamp, event_name, body e event_id, como a setup_events.sql.
SELECT
  FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', timestamp, 'America/Sao_Paulo') AS ts,
  tenant,
  CASE
    WHEN STARTS_WITH(event_name, 'setup_') THEN 'setup'
    WHEN event_name = 'meeting_recorded' THEN 'meeting'
    WHEN STARTS_WITH(event_name, 'task_') THEN 'task'
    ELSE 'whatsapp_day'
  END AS kind,
  event_name,
  CASE
    WHEN event_name = 'meeting_recorded' THEN COALESCE(JSON_VALUE(body, '$.title'), 'Reunião')
    WHEN event_name = 'whatsapp_day' THEN CONCAT(COALESCE(JSON_VALUE(body, '$.group_name'), 'Grupo'), ': ', COALESCE(JSON_VALUE(body, '$.messages_total'), '0'), ' mensagens')
    WHEN STARTS_WITH(event_name, 'task_') THEN CONCAT(event_name, ' #', COALESCE(JSON_VALUE(body, '$.task_no'), '?'), ': ', COALESCE(JSON_VALUE(body, '$.name'), ''))
    ELSE CONCAT(COALESCE(CONCAT(JSON_VALUE(body, '$.module'), ': '), ''), event_name, ' → ', COALESCE(JSON_VALUE(body, '$.value'), JSON_VALUE(body, '$.text'), ''))
  END AS title,
  TO_JSON_STRING(body) AS detail,
  IF(event_name = 'meeting_recorded', JSON_VALUE(body, '$.share_url'), NULL) AS link,
  CAST(event_id AS STRING) AS event_id
FROM `raw.events`
WHERE event_name IN ('setup_planned', 'setup_stage', 'setup_note', 'setup_priority', 'setup_type', 'setup_name',
                     'meeting_recorded', 'task_created', 'task_prioritized', 'task_done', 'task_cancelled', 'whatsapp_day')
  AND JSON_VALUE(body, '$._debug') IS NULL
  AND DATE(timestamp, 'America/Sao_Paulo') BETWEEN @start_date AND @end_date
ORDER BY ts DESC, event_id DESC;
