// followup.js: as regras do acompanhamento de pacientes pelo WhatsApp da Júlia (situação, cobertura, próximo passo, devido,
// limite de tentativas, fila e saída automática). JS puro, uma regra só para três lugares: o painel (navegador), o teste
// (Node, `painel/test_followup.mjs`) e os nós Code do n8n (inlinado como `_shared/disparo.js`: funções soltas, sem import).
// Os nomes começam com `fu` e `FU_` (lib inlinada colide em silêncio).
//
// Pureza (gabarito em `painel/test_followup.mjs`): sem DOM, sem estado global de tela, sem relógio escondido. O "agora" e as
// regras entram por parâmetro, em `ctx`:
//   ctx.now          dia 'AAAA-MM-DD' (dia de São Paulo) ou instante ISO 8601 com 'Z' / número em ms. Obrigatório.
//   ctx.rules        regras por audiência, saída de `fuRules(clients.crm.followup_rules)`. Sem ela vale o padrão.
//   ctx.test_phone   telefone de teste (o `FONE_FELIPE`, que o `action=state` devolve). Só ele escapa de `interno_ou_teste`.
//   ctx.daily_cap    teto de envios do dia; sem ele a checagem do teto não roda (o teto de verdade é o Redis do `disparo.js`).
//   ctx.daily_count  quantos envios já saíram hoje.
// O paciente (`p`) tem o formato das colunas de `analytics.patient_followup` (contrato em `painel/fixtures/README_pacientes.md`):
//   audience, attempts, last_attempt_at, last_speaker, last_message_at, snooze_until, skipped_on, converted_at, discarded_at,
//   discard_reason, block_reason, first_name, phone, phone_key; mais `scheduled_active` / `scheduled_at` (vêm do `crm.pending`
//   pelo `action=state`, não do BigQuery) e `next_contact_at` (opcional, só teste: ausente = deriva das regras, null = apagada).
// As listas aceitam `get(item)` para o caso de o item não ser o próprio paciente (o protótipo guarda mais coisa no item).

var FU_AUDIENCES = ['surgery', 'C', 'B', 'A', 'attended', 'lost', 'unsegmented'];
var FU_CONTACTABLE = ['surgery', 'C', 'B', 'A'];                       // as que recebem tentativa; a ordem é a da fila
var FU_AUDIENCE_LABEL = {
  surgery: 'Cirurgia', C: 'Cancelou ou faltou', B: 'Conversou e não marcou', A: 'Preencheu o form',
  attended: 'Atendidos', lost: 'Perdidos', unsegmented: 'Sem audiência'
};
// O padrão (Felipe, 02/11/2026): cirurgia 4 tentativas a cada 15 dias; C 3 a cada 7; B e A 2 a cada 7.
var FU_DEFAULT_RULES = {
  surgery: { max: 4, days: 15 }, C: { max: 3, days: 7 }, B: { max: 2, days: 7 }, A: { max: 2, days: 7 }
};
var FU_RULE_MAX_LIMIT = 10;        // tentativas: inteiro de 1 a 10
var FU_RULE_DAYS_LIMIT = 90;       // intervalo: inteiro de 1 a 90 dias
var FU_CONVERTED_DAYS = 7;         // quanto tempo um atendido aparece como "Converteu" antes de virar "Não contatar"
var FU_SP_OFFSET_MS = 3 * 3600000; // São Paulo, sem horário de verão desde 2019
var FU_NO_DATE = 9999;
var FU_DISCARD_REASONS = [
  { key: 'no_reply', label: 'Sem resposta' }, { key: 'not_interested', label: 'Não tem interesse' },
  { key: 'operated_elsewhere', label: 'Operou em outro lugar' }, { key: 'wrong_number', label: 'Número errado' },
  { key: 'other', label: 'Outro' }
];
var FU_SITUATIONS = [
  { key: 'due_today', label: 'Devido hoje', order: 'mais parado primeiro' },
  { key: 'julia_talking', label: 'Júlia conversando', order: 'resposta mais recente primeiro' },
  { key: 'scheduled', label: 'Agendado', order: 'por horário' },
  { key: 'waiting', label: 'Aguardando', order: 'volta mais próxima primeiro' },
  { key: 'converted', label: 'Converteu', order: 'conversão mais recente primeiro' },
  { key: 'discarded', label: 'Descartado', order: 'saída mais recente primeiro' },
  { key: 'do_not_contact', label: 'Não contatar', order: 'por nome' },
  { key: 'unsegmented', label: 'Sem audiência', order: 'por nome' },
  { key: 'no_next_step', label: 'Sem próximo passo', order: 'por nome' }
];
var FU_FILTERS = [
  { key: 'due', label: 'Devidos hoje' }, { key: 'answered', label: 'Júlia conversando' },
  { key: 'surgery', label: FU_AUDIENCE_LABEL.surgery }, { key: 'C', label: FU_AUDIENCE_LABEL.C },
  { key: 'B', label: FU_AUDIENCE_LABEL.B }, { key: 'A', label: FU_AUDIENCE_LABEL.A },
  { key: 'attended', label: FU_AUDIENCE_LABEL.attended }, { key: 'lost', label: FU_AUDIENCE_LABEL.lost },
  { key: 'unsegmented', label: FU_AUDIENCE_LABEL.unsegmented }
];
var FU_BADGE_RANK = { due: 0, answered: 1, scheduled: 2, later: 3, maxed: 4, locked: 5 };
// O motivo de bloqueio vem da view (`block_reason`, as exclusões de `crm_audiencias.py`); aqui só o texto que a tela mostra.
var FU_BLOCK_TEXT = {
  telefone_invalido: 'Telefone inválido.',
  interno_ou_teste: 'Número interno ou de teste.',
  consulta_futura: 'Já tem consulta marcada.',
  compareceu_depois: 'Já compareceu depois.',
  regua_7d: 'Recebeu mensagem da clínica nos últimos 7 dias.',
  humano_7d: 'Falou com a equipe nos últimos 7 dias.',
  risco_encaminhado_outra_clinica_ou_handoff_encaminhamento: 'Foi encaminhado para outra clínica.',
  risco_obito: 'Óbito informado na conversa.',
  risco_pediu_parar: 'Pediu para parar de receber mensagem.',
  risco_numero_errado: 'Número errado.',
  risco_ja_resolveu_em_outro_lugar: 'Já resolveu em outro lugar.',
  risco_encerrou_clinico_ou_urgencia: 'Conversa encerrada por caso clínico ou urgência.',
  risco_conversa_viva_48h: 'Conversa viva nas últimas 48 horas.'
};

/* ---------- datas: tudo em dia de São Paulo, a partir do que entra por parâmetro ---------- */

// 'AAAA-MM-DD' passa direto; instante (ISO com 'Z', Date ou ms) vira o dia de SP; vazio ou ilegível vira null
function fuDay(x) {
  if (x === null || x === undefined || x === '') { return null; }
  if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)) { return x; }
  var ms = fuMs(x);
  return ms === null ? null : new Date(ms - FU_SP_OFFSET_MS).toISOString().slice(0, 10);
}
function fuMs(x) {
  if (x === null || x === undefined || x === '') { return null; }
  var ms = typeof x === 'number' ? x : (x instanceof Date ? x.getTime() : Date.parse(String(x)));
  return isNaN(ms) ? null : ms;
}
// data e hora de parede de SP viram o instante ISO ('2026-11-02', '10:05' -> '2026-11-02T13:05:00Z')
function fuSpIso(date, time) {
  var d = String(date).split('-').map(Number), t = String(time || '00:00').split(':').map(Number);
  return new Date(Date.UTC(d[0], d[1] - 1, d[2], t[0], t[1]) + FU_SP_OFFSET_MS).toISOString().replace('.000Z', 'Z');
}
function fuDayNum(iso) { var p = iso.split('-').map(Number); return Math.round(Date.UTC(p[0], p[1] - 1, p[2]) / 86400000); }
function fuAddDays(iso, n) { return new Date((fuDayNum(iso) + n) * 86400000).toISOString().slice(0, 10); }
function fuDaysBetween(a, b) { return fuDayNum(b) - fuDayNum(a); }
function fuToday(ctx) {
  var d = fuDay(ctx && ctx.now);
  if (!d) { throw new Error('followup: ctx.now é obrigatório (dia AAAA-MM-DD ou instante ISO)'); }
  return d;
}

/* ---------- regras por audiência ---------- */

// `clients.crm.followup_rules` (JSON em texto ou já em objeto) vira as regras que as funções usam. Vazio = padrão. Valor fora do
// intervalo ou JSON quebrado LANÇA erro (falha calada aqui mandaria mensagem com a regra errada). Audiência bloqueada não se configura.
function fuRules(input) {
  var cfg = input;
  if (typeof input === 'string') {
    if (!input.trim()) { cfg = null; } else {
      try { cfg = JSON.parse(input); } catch (e) { throw new Error('followup: followup_rules não é JSON válido'); }
    }
  }
  if (cfg !== null && cfg !== undefined && (typeof cfg !== 'object' || Array.isArray(cfg))) { throw new Error('followup: followup_rules deve ser um objeto'); }
  var out = {};
  FU_CONTACTABLE.forEach(function (a) {
    var d = FU_DEFAULT_RULES[a], c = cfg && cfg[a] !== undefined ? cfg[a] : {};
    var max = c.max === undefined ? d.max : c.max, days = c.days === undefined ? d.days : c.days;
    if (!fuInt(max, FU_RULE_MAX_LIMIT)) { throw new Error('followup: max de ' + a + ' deve ser inteiro de 1 a ' + FU_RULE_MAX_LIMIT); }
    if (!fuInt(days, FU_RULE_DAYS_LIMIT)) { throw new Error('followup: days de ' + a + ' deve ser inteiro de 1 a ' + FU_RULE_DAYS_LIMIT); }
    out[a] = { max: max, days: days, locked: false };
  });
  ['attended', 'lost', 'unsegmented'].forEach(function (a) { out[a] = { locked: true }; });
  return out;
}
function fuInt(v, hi) { return typeof v === 'number' && Math.floor(v) === v && v >= 1 && v <= hi; }
var FU_RULES_PADRAO = fuRules(null);
function fuRuleOf(p, ctx) { var r = (ctx && ctx.rules) || FU_RULES_PADRAO; return r[p.audience] || null; }
function fuIsContactable(p, ctx) { var r = fuRuleOf(p, ctx); return !!r && !r.locked; }
// O limite de tentativas da pessoa: { max, days, attempts, reached }; null para quem não recebe tentativa
function fuAttemptsLimit(p, ctx) {
  if (!fuIsContactable(p, ctx)) { return null; }
  var r = fuRuleOf(p, ctx), n = Number(p.attempts) || 0;
  return { max: r.max, days: r.days, attempts: n, reached: n >= r.max };
}

/* ---------- fatos do paciente ---------- */

function fuIsPatientLast(p) { return p.last_speaker === 'patient'; }
function fuLastSpeakerDays(p, ctx) { var d = fuDay(p.last_message_at); return d ? fuDaysBetween(d, fuToday(ctx)) : null; }
function fuSinceAttempt(p, ctx) { var d = fuDay(p.last_attempt_at); return d ? fuDaysBetween(d, fuToday(ctx)) : FU_NO_DATE; }
function fuSnoozed(p, ctx) { var d = fuDay(p.snooze_until); return !!d && fuDaysBetween(fuToday(ctx), d) > 0; }
function fuSkippedToday(p, ctx) { return !!p.skipped_on && fuDay(p.skipped_on) === fuToday(ctx); }
// envio de hoje: o que já saiu (a tentativa de hoje) ou o que está agendado
function fuHasSendToday(p, ctx) { return !!p.scheduled_active || fuDay(p.last_attempt_at) === fuToday(ctx); }

/* ---------- devido, selo, próximo passo, situação, cobertura ---------- */

function fuIsDue(p, ctx) {
  if (!fuIsContactable(p, ctx)) { return false; }
  var r = fuRuleOf(p, ctx);
  if (fuIsPatientLast(p)) { return false; }
  if ((Number(p.attempts) || 0) >= r.max) { return false; }
  if (fuSinceAttempt(p, ctx) < r.days) { return false; }
  if (fuSnoozed(p, ctx)) { return false; }
  if (fuSkippedToday(p, ctx)) { return false; }
  if (fuHasSendToday(p, ctx)) { return false; }
  return true;
}
function fuDaysUntilDue(p, ctx) {
  var r = fuRuleOf(p, ctx), n = 0;
  if (p.last_attempt_at) { n = Math.max(n, r.days - fuSinceAttempt(p, ctx)); }
  if (fuSnoozed(p, ctx)) { n = Math.max(n, fuDaysBetween(fuToday(ctx), fuDay(p.snooze_until))); }
  if (fuSkippedToday(p, ctx) || fuHasSendToday(p, ctx)) { n = Math.max(n, 1); }
  return n;
}
function fuIsAnswered(p, ctx) { return fuIsContactable(p, ctx) && fuIsPatientLast(p); }
function fuBadge(p, ctx) {
  if (!fuIsContactable(p, ctx)) { return { kind: 'locked', text: p.audience === 'unsegmented' ? 'Sem audiência' : 'Bloqueado' }; }
  if (fuIsPatientLast(p)) { return { kind: 'answered', text: 'Respondeu: a Júlia está conversando' }; }
  if (p.scheduled_active) { return { kind: 'scheduled', text: 'Agendado hoje' }; }
  if (fuAttemptsLimit(p, ctx).reached) { return { kind: 'maxed', text: p.audience === 'surgery' ? 'Limite: decida' : 'Limite de tentativas' }; }
  if (fuIsDue(p, ctx)) { return { kind: 'due', text: 'Devido hoje' }; }
  var n = fuDaysUntilDue(p, ctx);
  return { kind: 'later', text: 'Volta em ' + n + (n === 1 ? ' dia' : ' dias') };
}

// A próxima data de contato de quem ainda pode ser contatado; null = ninguém marcou (o buraco que a cobertura procura).
// `next_contact_at`: ausente = deriva das regras; null = apagada de propósito (teste); texto = data fixa.
function fuNextStep(p, ctx) {
  if (!fuIsContactable(p, ctx)) { return null; }
  if (p.next_contact_at === null) { return null; }
  if (typeof p.next_contact_at === 'string') { return p.next_contact_at; }
  var today = fuToday(ctx), lim = fuAttemptsLimit(p, ctx), d;
  if (lim.reached) {
    // sem tentativa sobrando o passo é a saída automática; cirurgia nunca sai sozinha, então o passo é a decisão do Felipe
    if (p.audience !== 'surgery') { return fuAddDays(fuDay(p.last_attempt_at) || today, lim.days); }
    d = fuSkippedToday(p, ctx) ? fuAddDays(today, 1) : today;
    return fuSnoozed(p, ctx) ? fuDay(p.snooze_until) : d;
  }
  return fuAddDays(today, fuDaysUntilDue(p, ctx));
}
// cada paciente cai em exatamente 1 situação, na primeira linha que casar. `block_reason` NÃO muda a situação: só bloqueia o envio.
function fuSituation(p, ctx) {
  if (p.audience === 'unsegmented') { return 'unsegmented'; }
  if (p.audience === 'lost') { return 'discarded'; }
  if (p.audience === 'attended') {
    var c = fuDay(p.converted_at);
    return c && fuDaysBetween(c, fuToday(ctx)) <= FU_CONVERTED_DAYS ? 'converted' : 'do_not_contact';
  }
  if (p.scheduled_active) { return 'scheduled'; }
  if (fuIsPatientLast(p)) { return 'julia_talking'; }
  var d = fuNextStep(p, ctx);
  if (d === null) { return 'no_next_step'; }
  return d <= fuToday(ctx) ? 'due_today' : 'waiting';
}
function fuGet(get, x) { return get ? get(x) : x; }
// Cobertura: a soma das situações é o total. `ok` = ninguém sem audiência e ninguém sem próximo passo.
function fuCoverage(items, ctx, get) {
  var counts = {};
  FU_SITUATIONS.forEach(function (s) { counts[s.key] = 0; });
  (items || []).forEach(function (x) {
    var s = fuSituation(fuGet(get, x), ctx);
    if (counts[s] === undefined) { counts.unknown = (counts.unknown || 0) + 1; } else { counts[s] += 1; }
  });
  var total = (items || []).length;
  return { counts: counts, total: total, covered: total - counts.no_next_step - counts.unsegmented, ok: counts.no_next_step === 0 && counts.unsegmented === 0 };
}

/* ---------- saída automática ---------- */

// Esgotou as tentativas, passou o intervalo e ninguém respondeu: sai sozinho para Descartado (`expired`). Cirurgia nunca sai sozinha.
// Cálculo puro: não grava nada. Devolve o que mudaria (ou null). `expires_on` = última tentativa + intervalo, a data da saída.
function fuExpire(p, ctx) {
  if (p.audience === 'surgery' || !fuIsContactable(p, ctx)) { return null; }
  var lim = fuAttemptsLimit(p, ctx);
  if (!(lim.reached && !fuIsPatientLast(p) && fuSinceAttempt(p, ctx) >= lim.days)) { return null; }
  var last = fuDay(p.last_attempt_at);
  return { expired: true, audience: 'lost', lost_from: p.audience, discard_reason: 'no_reply', attempts: lim.attempts,
    expires_on: last ? fuAddDays(last, lim.days) : fuToday(ctx) };
}
// o paciente como a tela o mostra depois da saída automática (cópia; o original não muda)
function fuResolve(p, ctx) {
  var x = fuExpire(p, ctx);
  if (!x) { return p; }
  return Object.assign({}, p, { audience: 'lost', audience_source: 'expired', discard_reason: x.discard_reason, discarded_at: x.expires_on });
}
// quem sai sozinho agora: [{ item, patch }]
function fuSweepExpired(items, ctx, get) {
  var out = [];
  (items || []).forEach(function (x) { var patch = fuExpire(fuGet(get, x), ctx); if (patch) { out.push({ item: x, patch: patch }); } });
  return out;
}

/* ---------- envio: o que bloqueia ---------- */

// chave do telefone: DDD + 8 últimos dígitos (casa 12 e 13 dígitos). É a mesma de `fcChave` (`first_contact.js`); o teste prova a igualdade.
function fuPhoneKey(raw) {
  var d = String(raw === null || raw === undefined ? '' : raw).replace(/\D/g, '');
  if ((d.length === 12 || d.length === 13) && d.slice(0, 2) === '55') { d = d.slice(2); }
  return d.slice(0, 2) + d.slice(-8);
}
// O gancho do telefone de teste: o ÚNICO número que ignora `interno_ou_teste` é o de `ctx.test_phone`. Qualquer outro motivo,
// ou qualquer outro número interno, continua bloqueando.
function fuIsTestPhone(p, ctx) {
  if (!ctx || !ctx.test_phone) { return false; }
  var mine = p.phone_key || (p.phone ? fuPhoneKey(p.phone) : '');
  return !!mine && mine === fuPhoneKey(ctx.test_phone);
}
function fuBlockReason(p, ctx) {
  var br = p.block_reason || null;
  if (br === 'interno_ou_teste' && fuIsTestPhone(p, ctx)) { return null; }
  return br;
}
function fuBlockText(reason) { return FU_BLOCK_TEXT[reason] || 'Bloqueado: ' + reason + '.'; }
// null = pode enviar; senão [motivo, texto]. `extra` = quantos envios este pedido soma ao dia (padrão 1; o lote confere o teto à parte).
function fuSendBlock(p, ctx, extra) {
  if (!p) { return ['unknown_patient', 'Paciente não encontrado.']; }
  if (!fuIsContactable(p, ctx)) { return ['blocked_audience', FU_AUDIENCE_LABEL[p.audience] + ': bloqueado, nunca contatar.']; }
  var br = fuBlockReason(p, ctx);
  if (br) { return ['blocked_reason', fuBlockText(br)]; }
  var lim = fuAttemptsLimit(p, ctx);
  if (lim.reached) { return ['max_attempts', 'Já chegou ao máximo de ' + lim.max + ' tentativas.']; }
  if (fuHasSendToday(p, ctx)) { return ['already_today', 'Já existe envio de hoje para ' + (p.first_name || 'esta pessoa') + '.']; }
  if (ctx && ctx.daily_cap !== undefined && (Number(ctx.daily_count) || 0) + (extra === undefined ? 1 : extra) > ctx.daily_cap) {
    return ['daily_cap', 'Recusado: passaria de ' + ctx.daily_cap + ' envios hoje.'];
  }
  return null;
}
// Definir audiência: só para quem está sem audiência ou caiu em Perdidos pelo fallback da view (nenhuma regra classificou: `audience_detail`
// é um destes 4 motivos), e só para audiência contatável. Perdido por regra normal (descarte, tentativas esgotadas) continua travado.
var FU_FALLBACK_DETAILS = ['outside_window', 'appointment_in_window', 'no_history', 'no_conversation'];
function fuAudienceSettable(p) {
  return p.audience === 'unsegmented' || (p.audience === 'lost' && FU_FALLBACK_DETAILS.indexOf(p.audience_detail) >= 0);
}
function fuCanSetAudience(p, audience) {
  if (!p) { return ['unknown_patient', 'Paciente não encontrado.']; }
  if (!fuAudienceSettable(p)) { return ['not_unsegmented', 'Só quem está sem audiência, ou em Perdidos por falta de regra, recebe audiência por aqui.']; }
  if (FU_CONTACTABLE.indexOf(audience) < 0) { return ['invalid_audience', 'Escolha uma audiência para contatar.']; }
  return null;
}

/* ---------- fila e listas ---------- */

function fuQueueOrder(a, b, ctx) {
  var ia = FU_CONTACTABLE.indexOf(a.audience), ib = FU_CONTACTABLE.indexOf(b.audience);
  if (ia !== ib) { return ia - ib; }
  var da = fuLastSpeakerDays(a, ctx), db = fuLastSpeakerDays(b, ctx);
  return (db === null ? FU_NO_DATE : db) - (da === null ? FU_NO_DATE : da);
}
function fuSortQueue(items, ctx, get) {
  return (items || []).slice().sort(function (a, b) { return fuQueueOrder(fuGet(get, a), fuGet(get, b), ctx); });
}
function fuDueList(items, ctx, get) {
  return fuSortQueue((items || []).filter(function (x) { return fuIsDue(fuGet(get, x), ctx); }), ctx, get);
}
// posição na lista a partir de 1 (não de 0); 0 quando a pessoa não está na lista. `field`: 'phone_key' (padrão) ou 'id'.
function fuQueuePosition(list, key, field) {
  var f = field || 'phone_key';
  for (var i = 0; i < (list || []).length; i++) { if (list[i][f] === key) { return i + 1; } }
  return 0;
}
// a lista de cada filtro: "Devidos hoje" é a fila; os outros seguem a ordem da fila com devidos e respondidos primeiro
function fuFilterList(items, key, ctx, get) {
  if (key === 'due') { return fuDueList(items, ctx, get); }
  var base = (items || []).filter(function (x) {
    var p = fuGet(get, x);
    return key === 'answered' ? fuIsAnswered(p, ctx) : p.audience === key;
  });
  return fuSortQueue(base, ctx, get).sort(function (a, b) { return FU_BADGE_RANK[fuBadge(fuGet(get, a), ctx).kind] - FU_BADGE_RANK[fuBadge(fuGet(get, b), ctx).kind]; });
}
function fuCmp(f) { return function (a, b) { var x = f(a), y = f(b); return x < y ? -1 : (x > y ? 1 : 0); }; }
// a lista de cada situação, já na ordem escrita no título do grupo
function fuSituationList(items, key, ctx, get) {
  var list = (items || []).filter(function (x) { return fuSituation(fuGet(get, x), ctx) === key; });
  var P = function (x) { return fuGet(get, x); };
  var audIdx = function (p) { return FU_CONTACTABLE.indexOf(p.audience); };
  var byName = function (a, b) {
    var x = String(P(a).first_name || ''), y = String(P(b).first_name || '');
    return x < y ? -1 : (x > y ? 1 : (String(P(a).phone_key || '') < String(P(b).phone_key || '') ? -1 : 0));
  };
  var stamp = function (x) { var m = fuMs(P(x).last_message_at); return m === null ? -1 : m; };
  var sched = function (x) { var m = fuMs(P(x).scheduled_at); return m === null ? Infinity : m; };
  var main = {
    due_today: function (a, b) { var x = fuLastSpeakerDays(P(a), ctx), y = fuLastSpeakerDays(P(b), ctx); return ((y === null ? FU_NO_DATE : y) - (x === null ? FU_NO_DATE : x)) || (audIdx(P(a)) - audIdx(P(b))); },
    julia_talking: function (a, b) { return stamp(b) - stamp(a); },
    scheduled: fuCmp(sched),
    waiting: function (a, b) { var x = fuNextStep(P(a), ctx), y = fuNextStep(P(b), ctx); return x < y ? -1 : (x > y ? 1 : (audIdx(P(a)) - audIdx(P(b)))); },
    converted: function (a, b) { var x = fuDay(P(a).converted_at) || '', y = fuDay(P(b).converted_at) || ''; return x < y ? 1 : (x > y ? -1 : 0); },
    discarded: function (a, b) { var x = fuDay(P(a).discarded_at) || '', y = fuDay(P(b).discarded_at) || ''; return x < y ? 1 : (x > y ? -1 : 0); }
  }[key];
  return list.sort(function (a, b) { return (main ? main(a, b) : 0) || byName(a, b); });
}
// quem já fez a última tentativa e sai sozinho se não responder (cirurgia nunca sai sozinha)
function fuFinalAttemptList(items, ctx, get) {
  return (items || []).filter(function (x) {
    var p = fuGet(get, x), lim = fuAttemptsLimit(p, ctx);
    return !!lim && p.audience !== 'surgery' && lim.reached && fuSituation(p, ctx) !== 'julia_talking';
  }).sort(fuCmp(function (x) { return fuNextStep(fuGet(get, x), ctx); }));
}
// quem volta em cada um dos próximos n dias; `later` é quem volta depois disso
function fuAgenda(items, ctx, n, get) {
  var today = fuToday(ctx), days = [], waiting = fuSituationList(items, 'waiting', ctx, get);
  for (var i = 1; i <= n; i++) {
    var iso = fuAddDays(today, i);
    days.push({ date: iso, patients: waiting.filter(function (x) { return fuNextStep(fuGet(get, x), ctx) === iso; }) });
  }
  var limit = fuAddDays(today, n);
  return { days: days, later: waiting.filter(function (x) { return fuNextStep(fuGet(get, x), ctx) > limit; }) };
}

if (typeof module !== 'undefined') {
  module.exports = {
    FU_AUDIENCES: FU_AUDIENCES, FU_CONTACTABLE: FU_CONTACTABLE, FU_AUDIENCE_LABEL: FU_AUDIENCE_LABEL, FU_DEFAULT_RULES: FU_DEFAULT_RULES,
    FU_CONVERTED_DAYS: FU_CONVERTED_DAYS, FU_DISCARD_REASONS: FU_DISCARD_REASONS, FU_SITUATIONS: FU_SITUATIONS, FU_FILTERS: FU_FILTERS,
    FU_BADGE_RANK: FU_BADGE_RANK, FU_BLOCK_TEXT: FU_BLOCK_TEXT,
    fuDay: fuDay, fuMs: fuMs, fuSpIso: fuSpIso, fuAddDays: fuAddDays, fuDaysBetween: fuDaysBetween, fuToday: fuToday,
    fuRules: fuRules, fuRuleOf: fuRuleOf, fuIsContactable: fuIsContactable, fuAttemptsLimit: fuAttemptsLimit,
    fuLastSpeakerDays: fuLastSpeakerDays, fuSinceAttempt: fuSinceAttempt, fuSnoozed: fuSnoozed, fuHasSendToday: fuHasSendToday,
    fuIsDue: fuIsDue, fuDaysUntilDue: fuDaysUntilDue, fuIsAnswered: fuIsAnswered, fuBadge: fuBadge,
    fuNextStep: fuNextStep, fuSituation: fuSituation, fuCoverage: fuCoverage,
    fuExpire: fuExpire, fuResolve: fuResolve, fuSweepExpired: fuSweepExpired,
    fuPhoneKey: fuPhoneKey, fuIsTestPhone: fuIsTestPhone, fuBlockReason: fuBlockReason, fuBlockText: fuBlockText,
    fuSendBlock: fuSendBlock, fuCanSetAudience: fuCanSetAudience,
    fuQueueOrder: fuQueueOrder, fuSortQueue: fuSortQueue, fuDueList: fuDueList, fuQueuePosition: fuQueuePosition,
    fuFilterList: fuFilterList, fuSituationList: fuSituationList, fuFinalAttemptList: fuFinalAttemptList, fuAgenda: fuAgenda
  };
}
