-- Funções temporárias compartilhadas pelos .sql do painel. A página e o gabarito
-- colam este arquivo na frente de cada consulta (um script só, via jobs.query).
-- Procedimento, local e modalidade chegam sujos ("CONSULTA", "consulta em consultório",
-- "gastrus"): a normalização mora aqui, igual nos filtros, nas listas e nas opções.

CREATE TEMP FUNCTION norm_procedure(x STRING) AS (
  CASE LOWER(TRIM(x))
    WHEN '' THEN NULL
    WHEN 'consulta' THEN 'Consulta'
    WHEN 'consulta em consultório' THEN 'Consulta'
    WHEN 'consulta retorno' THEN 'Retorno'
    WHEN 'retorno online' THEN 'Retorno'
    ELSE INITCAP(LOWER(TRIM(x)))
  END
);

CREATE TEMP FUNCTION norm_location(x STRING) AS (
  CASE LOWER(TRIM(x))
    WHEN '' THEN NULL
    WHEN 'gastrus' THEN 'Gastrus'
    WHEN 'clínica gastrus' THEN 'Gastrus'
    WHEN 'clinica gastrus' THEN 'Gastrus'
    ELSE INITCAP(LOWER(TRIM(x)))
  END
);

CREATE TEMP FUNCTION norm_modality(x STRING) AS (
  IF(TRIM(x) = '', NULL, INITCAP(LOWER(TRIM(x))))
);

-- Campanha e grupo vazios viram valor próprio, filtrável.
CREATE TEMP FUNCTION label_campaign(x STRING) AS (COALESCE(NULLIF(TRIM(x), ''), 'sem campanha'));
CREATE TEMP FUNCTION label_ad_group(x STRING) AS (COALESCE(NULLIF(TRIM(x), ''), 'sem grupo'));

-- Retorno fica fora do funil (decisão do Felipe, 04/10/2026): marcação, agendamento, realizado e upsell
-- contam só visita nova, como o Looker fazia. Retorno = visit_type 'return' no body do raw.events: o BQ é a
-- fonte da verdade (Felipe, 06/10/2026), a mesma etiqueta que o fechamento do mês lê. O nome do procedimento
-- não decide. Cada consulta junta o visit_type pelo event_id.
CREATE TEMP FUNCTION is_return(visit_type STRING) AS (COALESCE(visit_type = 'return', FALSE));
CREATE TEMP FUNCTION counts_in_funnel(visit_type STRING) AS (NOT is_return(visit_type));

-- Início do período: dia, semana (segunda) ou mês.
CREATE TEMP FUNCTION bucket(d DATE, grain STRING) AS (
  CASE grain
    WHEN 'week' THEN DATE_TRUNC(d, WEEK(MONDAY))
    WHEN 'month' THEN DATE_TRUNC(d, MONTH)
    ELSE d
  END
);

-- Array vazio = sem filtro. Pelo REST, array vazio chega como NULL (arrayValues: [] some no JSON):
-- por isso a checagem de NULL. Sem ela, o filtro vazio vira NULL e a consulta devolve zero linha.
CREATE TEMP FUNCTION n_items(f ARRAY<STRING>) AS (COALESCE(ARRAY_LENGTH(f), 0));
CREATE TEMP FUNCTION in_filter(v STRING, f ARRAY<STRING>) AS (n_items(f) = 0 OR v IN UNNEST(f));

-- Evento de paciente: campanha e grupo são os do LEAD (lead_campaign, lead_ad_group_name).
CREATE TEMP FUNCTION event_matches(
  attribution STRING, procedure_name STRING, location STRING, modality STRING, event_name STRING,
  lead_campaign STRING, lead_ad_group_name STRING,
  f_attribution ARRAY<STRING>, f_procedure ARRAY<STRING>, f_location ARRAY<STRING>,
  f_modality ARRAY<STRING>, f_event_type ARRAY<STRING>, f_campaign ARRAY<STRING>, f_ad_group ARRAY<STRING>
) AS (
  in_filter(attribution, f_attribution)
  AND in_filter(norm_procedure(procedure_name), f_procedure)
  AND in_filter(norm_location(location), f_location)
  AND in_filter(norm_modality(modality), f_modality)
  AND in_filter(event_name, f_event_type)
  AND in_filter(label_campaign(lead_campaign), f_campaign)
  AND in_filter(label_ad_group(lead_ad_group_name), f_ad_group)
);

-- Gasto: só atribuição, campanha e grupo se aplicam, e são os do próprio gasto.
-- A atribuição do gasto vem do mapa de grupo de anúncio da view (100% preenchida).
CREATE TEMP FUNCTION spend_matches(
  attribution STRING, campaign STRING, ad_group_name STRING,
  f_attribution ARRAY<STRING>, f_campaign ARRAY<STRING>, f_ad_group ARRAY<STRING>
) AS (
  in_filter(attribution, f_attribution)
  AND in_filter(label_campaign(campaign), f_campaign)
  AND in_filter(label_ad_group(ad_group_name), f_ad_group)
);

-- Comparação com o período anterior. NULL quando não há base (anterior vazio, zero ou nulo): nunca inventa número.
-- chg: variação relativa (0,12 = +12%). pp: diferença em pontos percentuais entre duas taxas (0 a 1).
CREATE TEMP FUNCTION chg(cur FLOAT64, prev FLOAT64) AS (SAFE_DIVIDE(cur - prev, prev));
CREATE TEMP FUNCTION pp(cur FLOAT64, prev FLOAT64) AS ((cur - prev) * 100);
-- Período anterior da comparação (s = início, e = fim do intervalo atual):
-- 1) começa no dia 1 e termina no último dia de um mês (k meses inteiros): os k meses inteiros logo antes
--    (01/09 a 30/09 contra 01/08 a 31/08; 01/01 a 31/01 contra 01/12 a 31/12 do ano anterior);
-- 2) começa no dia 1 e termina no meio do mês: o mesmo trecho k meses antes (01/10 a 06/10 contra 01/09 a 06/09),
--    k = meses entre o mês do início e o do fim + 1;
-- 3) qualquer outro intervalo: mesma duração, logo antes.
CREATE TEMP FUNCTION prev_window(s DATE, e DATE) AS (
  CASE
    WHEN EXTRACT(DAY FROM s) = 1 AND e = LAST_DAY(e, MONTH) THEN
      STRUCT(DATE_SUB(s, INTERVAL DATE_DIFF(e, s, MONTH) + 1 MONTH) AS prev_start, DATE_SUB(s, INTERVAL 1 DAY) AS prev_end)
    WHEN EXTRACT(DAY FROM s) = 1 THEN
      STRUCT(DATE_SUB(s, INTERVAL DATE_DIFF(e, s, MONTH) + 1 MONTH) AS prev_start, DATE_SUB(e, INTERVAL DATE_DIFF(e, s, MONTH) + 1 MONTH) AS prev_end)
    ELSE
      STRUCT(DATE_SUB(s, INTERVAL DATE_DIFF(e, s, DAY) + 1 DAY) AS prev_start, DATE_SUB(s, INTERVAL 1 DAY) AS prev_end)
  END
);
