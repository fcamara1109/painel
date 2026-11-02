-- Canal de cada evento do cliente (@tenant), uma definição só: é a CTE `event_channel`. Só leitura (o login do navegador é
-- bigquery.readonly: CREATE TEMP TABLE é recusado). funnel.sql, completed.sql, marked.sql e options.sql têm uma linha só com o marcador
-- (comentário "@event_channel") logo depois do WITH; a página (painel.js, bqQuery) troca a linha pelo texto deste arquivo mais uma vírgula.
-- Quem usa junta por event_id e nunca recalcula o canal.
--
-- Gasto de mídia (ad_spend): o canal é media_channel(body.platform), ver _prelude.sql.
-- Evento de paciente (Felipe, 01/11/2026): quem chegou pela Doctoralia é Doctoralia mesmo remarcando. Cada evento herda o canal
-- do agendamento (scheduled) MARCADO mais recente do mesmo paciente no momento do evento ou antes dele:
-- remarcação e atendimento herdam o do agendamento que os gerou, e um scheduled sem marca (a remarcação feita pela IA ou
-- pelo Asa) herda o do scheduled marcado anterior. A marca é body.booking_channel (_shared/canal_agendamento.js).
-- Marca no próprio evento vale para ele. Sem agendamento marcado até aquele momento (o lead antes de marcar, o paciente
-- sem marca): canal de mídia padrão, media_channel(NULL).
event_channel AS (
  WITH base AS (
    SELECT
      e.event_id, e.event_name, e.patient_key, e.event_timestamp,
      JSON_VALUE(r.body, '$.booking_channel') AS booking_channel,
      JSON_VALUE(r.body, '$.platform') AS platform
    FROM `analytics.funnel_events_attributed` AS e
    JOIN `raw.events` AS r ON r.event_id = e.event_id AND r.tenant = e.tenant
    WHERE e.tenant = @tenant AND JSON_VALUE(r.body, '$._debug') IS NULL
  ),
  marks AS (
    SELECT patient_key, event_timestamp AS marked_at, booking_channel AS channel
    FROM base
    WHERE event_name = 'scheduled' AND booking_channel IS NOT NULL AND patient_key IS NOT NULL
  )
  SELECT
    b.event_id,
    IF(b.event_name = 'ad_spend', media_channel(b.platform), COALESCE(b.booking_channel, m.channel, media_channel(NULL))) AS channel
  FROM base AS b
  LEFT JOIN marks AS m ON b.event_name != 'ad_spend' AND m.patient_key = b.patient_key AND m.marked_at <= b.event_timestamp
  WHERE TRUE
  QUALIFY ROW_NUMBER() OVER (PARTITION BY b.event_id ORDER BY m.marked_at DESC, m.channel) = 1
)
