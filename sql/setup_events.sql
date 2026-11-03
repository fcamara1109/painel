-- Eventos do quadro de setup que vieram DEPOIS da foto: o planejado e o estágio de cada célula, o último de cada um.
-- Parâmetro: só @events_until (texto UTC, a marca da foto que setup_board.sql devolveu). A página pinta estes por cima da foto.
-- Fonte: raw.events, eventos setup_planned e setup_stage (body: module, value, seq). O _debug fica de fora (teste nunca conta).
-- Empate no mesmo segundo se resolve pelo seq, o mesmo desempate do ops_log.py.
SELECT
  tenant,
  JSON_VALUE(body, '$.module') AS module,
  event_name,
  JSON_VALUE(body, '$.value') AS value,
  SAFE_CAST(JSON_VALUE(body, '$.seq') AS INT64) AS seq
FROM `raw.events`
WHERE event_name IN ('setup_planned', 'setup_stage')
  AND JSON_VALUE(body, '$._debug') IS NULL
  AND timestamp > TIMESTAMP(@events_until)
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY tenant, JSON_VALUE(body, '$.module'), event_name
  ORDER BY timestamp DESC, SAFE_CAST(JSON_VALUE(body, '$.seq') AS INT64) DESC
) = 1
ORDER BY tenant, module, event_name;
