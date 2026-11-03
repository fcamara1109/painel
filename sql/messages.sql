-- Mensagens de um telefone: a conversa de uma pessoa, lida só quando o paciente é aberto na tela (analytics.messages, fontes já fundidas).
-- Parâmetros: @tenant e @phone_key (a mesma chave de patients.phone_key). Colunas de painel/fixtures/README_pacientes.md.
-- Ordem: hora e depois seq (desempata a mesma hora). sent_at sai como texto ISO em UTC com Z; vazio quando a fonte não tem hora.
SELECT
  message_id,
  phone,
  phone_key,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', sent_at) AS sent_at,
  seq,
  author,
  text,
  media_type,
  media_ref,
  source
FROM `analytics.messages`
WHERE tenant = @tenant
  AND phone_key = @phone_key
ORDER BY sent_at, seq;
