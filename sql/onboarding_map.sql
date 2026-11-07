-- Mapa do onboarding: a linha mais recente de analytics.onboarding_map (gravada por `_shared/onboarding-mapa/build.py --publicar`). Sem parâmetros.
-- generated_at em horário de São Paulo (texto, para mostrar). O html é o arquivo único do mapa (com script próprio) e entra num iframe com sandbox.
-- A tabela só acrescenta e não expira: o mapa vale até alguém publicar outro. O acesso é pelo login do BigQuery de quem entra; o repo público do painel não leva o mapa.
SELECT
  FORMAT_TIMESTAMP('%Y-%m-%d %H:%M', generated_at, 'America/Sao_Paulo') AS generated_at,
  version,
  html
FROM `analytics.onboarding_map`
ORDER BY generated_at DESC
LIMIT 1;
