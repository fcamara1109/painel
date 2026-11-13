-- Eventos do quadro de setup que podem estar depois da foto: o último de cada campo (planejado e estágio da célula, nota, prioridade, tipo e nome).
-- Sem parâmetro e SEM corte por horário: é o último estado de cada campo em todo o raw.events. Um clique que saiu antes do corte da foto e só
-- gravou depois de ela ler o log tem hora de origem antiga, e qualquer janela o esconderia até a próxima foto. O último de cada campo é idempotente:
-- se a foto já tem o evento, reler dá o mesmo valor, e a página pinta isto por cima da foto.
-- Custo (medido com bq show e dry-run em 03/11/2026): raw.events não tem partição nem cluster (3909 linhas, 0,6 MB no total); esta consulta lê as
-- colunas tenant, timestamp, event_name e body: 570 KB no dry-run (bq query --dry_run), abaixo de 0,6 MB. Se a tabela crescer, o filtro por event_name já limita o que sai, não o que se lê: aí vale clusterizar a tabela.
-- Fonte: os seis eventos setup_* (body: module?, value ou text, seq). O _debug fica de fora (teste nunca conta).
-- Empate no mesmo segundo se resolve pelo seq, o mesmo desempate do ops_log.py.
SELECT
  tenant,
  JSON_VALUE(body, '$.module') AS module,
  event_name,
  COALESCE(JSON_VALUE(body, '$.value'), JSON_VALUE(body, '$.text')) AS value,
  SAFE_CAST(JSON_VALUE(body, '$.seq') AS INT64) AS seq
FROM `raw.events`
WHERE event_name IN ('setup_planned', 'setup_stage', 'setup_note', 'setup_priority', 'setup_type', 'setup_name')
  AND JSON_VALUE(body, '$._debug') IS NULL
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY tenant, JSON_VALUE(body, '$.module'), event_name
  ORDER BY timestamp DESC, SAFE_CAST(JSON_VALUE(body, '$.seq') AS INT64) DESC
) = 1
ORDER BY tenant, module, event_name;
