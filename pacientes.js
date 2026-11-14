// Página Pacientes: o acompanhamento pelo WhatsApp da Júlia. Lista por situação, conversa, prontuário e as ações do dia.
// A regra (situação, cobertura, devido, bloqueio de envio, saída automática) NÃO está aqui: é _shared/followup.js (as funções fu*), a mesma do
// n8n e do gabarito. Aqui só se desenha o que a lib decide e se chama UM ponto de ação, ctx.acao(nome, corpo), que o painel.js liga ao servidor.
// O painel.js carrega o dado (login, token, BigQuery, ?tenant=) e chama PainelPacientes.render; nada de segundo cliente do BigQuery.
(function () {
  'use strict';

  const ICONES = {
    ok: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/>',
    chev: '<path d="M6 9l6 6 6-6"/>',
    img: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M4 17l5-4 4 3 3-2 4 3"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>',
    down: '<path d="M12 4v10M8 10l4 4 4-4M5 19h14"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  };
  const ic = (n, cls) => `<svg class="pc-ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONES[n]}</svg>`;

  const SIT = {};
  FU_SITUATIONS.forEach((x) => { SIT[x.key] = x; });
  const FECHADOS = ['converted', 'discarded', 'do_not_contact'];
  const SOLTOS = ['no_next_step', 'unsegmented'];
  const VISOES = [['due_today', 'Devidos hoje'], ['julia_talking', 'Júlia conversando'], ['all', 'Todos']];
  const AUD_LISTA = ['surgery', 'C', 'B', 'A', 'attended', 'lost'];
  const SURGERY_LABEL = { indicated: 'Indicada', in_talk: 'Em conversa', booked: 'Marcada', observing: 'Em observação' };
  const AUTOR = { patient: 'Paciente', julia: 'Júlia', operator: 'Equipe', ours: 'Equipe' };
  const COMANDOS = [['send', 'Enviar agora', 'E'], ['schedule', 'Agendar', 'A'], ['skip', 'Pular hoje', 'P'], ['snooze', 'Soneca', 'S'], ['discard', 'Descartar', 'D'], ['convert', 'Converteu', 'C']];
  const DIA_MAX = 4;

  const ui = { tenant: null, view: 'due_today', aud: '', busca: '', closedOpen: false, diasAbertos: {}, sel: null, panel: null, pane: 'conversa', pendente: null, logOpen: false, ferrOpen: false, avisoPadrao: null, viewUrl: null };
  const conversas = {}; // phone_key -> { estado: 'carregando' | 'ok' | 'erro', msgs }, só desta sessão
  const rascunhos = {}; // phone_key -> texto editado antes de enviar
  const emCurso = {}; // phone_key -> { nome, id }: ação esperando o servidor (22 a 35 s com telefone); o paciente fica "processando" e a fila segue
  const resultados = {}; // phone_key -> { texto }: o que o servidor recusou ou errou na última ação, até a próxima ação do mesmo paciente
  const enviadosAgora = {}; // phone_key -> { sig, em }: envio que valeu e que a view ainda não mostra (ela grava o follow_up depois da resposta)
  let registro = []; // o Log desta sessão da página (o de verdade é o crm_action no BigQuery); some ao trocar de cliente
  let travaAte = 0; // depois de uma ação a fila anda: cliques seguidos (duplo clique) não podem cair no paciente que acabou de abrir
  let S = null; // o que o último desenho sabe: { ctx, entrada, estado, todos, fx, cov, idx }
  const TRAVA_MS = 500;
  // Envio padrão desta sessão da página, por cliente: { modo: 'agora' } ou { modo: 'agendar', hora: 'HH:MM' }. O que o Felipe usou ou escolheu por último vale para os próximos.
  let padrao = { modo: 'agora' }, horaUlt = '', dataUlt = ''; // horaUlt e dataUlt: a última escolha, para os campos do controle quando o padrão volta a ser 'agora'
  const HORA_OK = /^([01]\d|2[0-3]):[0-5]\d$/, DATA_OK = /^\d{4}-\d{2}-\d{2}$/;
  const DIAS_MAX = 90; // o servidor recusa agendamento além disso (at_longe_demais)
  const chavePadrao = (t) => `pc_envio_padrao:${t}`;
  function carregaPadrao(t, hoje) {
    padrao = { modo: 'agora' }; horaUlt = ''; dataUlt = '';
    try {
      const v = JSON.parse(sessionStorage.getItem(chavePadrao(t)) || 'null');
      if (v && v.modo === 'agendar' && HORA_OK.test(v.hora)) { padrao = { modo: 'agendar', data: DATA_OK.test(v.data) ? v.data : hoje, hora: v.hora }; horaUlt = v.hora; dataUlt = padrao.data; } // guardado sem dia (versão antiga): vale hoje
    } catch (err) { /* sem storage: vale só em memória */ }
  }
  function definePadrao(novo) {
    padrao = novo;
    if (novo.hora) { horaUlt = novo.hora; dataUlt = novo.data; }
    try { sessionStorage.setItem(chavePadrao(ui.tenant), JSON.stringify(padrao)); } catch (err) { /* sem storage: vale só em memória */ }
  }
  const hojeSp = () => fuDay(S.fx.now);
  const dataHora = (data, hora) => `${dd(data)} ${hora}`;
  const quando = (data, hora) => `${data === hojeSp() ? 'hoje' : dd(data)} ${hora}`; // rótulo do botão principal
  // dia e hora de São Paulo viram o `at` do servidor; passado e além de 90 dias não vão (o servidor recusaria do mesmo jeito)
  function resolveAgenda(data, hora) {
    const at = fuSpIso(data, hora);
    if (fuMs(at) - Date.now() <= 0) return { erro: 'passou' };
    if (fuDaysBetween(hojeSp(), data) > DIAS_MAX) return { erro: 'longe' };
    return { at };
  }
  const ROTULO_CURSO = { send_now: 'Enviando', schedule: 'Agendando', cancel_schedule: 'Cancelando', snooze: 'Soneca', skip: 'Pulando', discard: 'Descartando', mark_converted: 'Registrando', set_audience: 'Definindo' };
  const ERRO_MOTIVO = {
    sem_whatsapp: 'Esse número não tem WhatsApp.', at_no_passado: 'Esse horário já passou.', at_longe_demais: 'A data é longe demais (no máximo 90 dias).',
    texto_invalido: 'O texto está vazio ou passa de 1000 letras.', nao_gravou: 'Não consegui gravar a ação, então ela não valeu. Tente de novo.',
    leitura_ilegivel: 'O servidor não conseguiu ler o paciente agora. Nada foi feito. Tente de novo.', trava_ilegivel: 'O servidor não conseguiu conferir o envio de hoje. Nada foi feito. Tente de novo.',
    regras_invalidas: 'As regras deste cliente estão com erro. Avise o Felipe.',
  };
  const DETALHE_PERDIDO = {
    outside_window: 'Último contato há mais de 60 dias.', appointment_in_window: 'Marcou ou remarcou consulta nos últimos 60 dias, por fora das regras de acompanhamento.',
    no_history: 'Sem nenhum contato com data registrado.', no_conversation: 'Teve registros nos últimos 60 dias, mas nenhuma conversa nem consulta marcada.',
  };

  const $ = (id) => document.getElementById(id);
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  const dd = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  const nomeDe = (p) => p.first_name || 'Sem nome';
  const final4 = (p) => String(p.phone || '').slice(-4);
  const hhmm = (iso) => new Date(fuMs(iso) - FU_SP_OFFSET_MS).toISOString().slice(11, 16);

  // ---------------------------------------------------------------- dados derivados (tudo pela lib)
  // o agendado ativo mora em crm.pending (n8n), não no BigQuery: o state o entrega e entra na linha antes da lib decidir a situação
  const comAgendado = (r, a) => (a ? Object.assign({}, r, { scheduled_active: true, scheduled_at: a.at, scheduled_text: a.text, schedule_id: a.schedule_id }) : r);
  // a view só mostra o envio alguns segundos DEPOIS da resposta: até lá a página soma a tentativa, para o paciente não voltar a parecer devido
  const sigEnvio = (r) => `${r.attempts}|${r.last_attempt_at}`;
  function comEnvioAgora(r) {
    const e = enviadosAgora[r.phone_key];
    if (!e) return r;
    if (e.sig !== sigEnvio(r)) { delete enviadosAgora[r.phone_key]; return r; } // a view já alcançou
    return Object.assign({}, r, { attempts: (Number(r.attempts) || 0) + 1, last_attempt_at: e.em });
  }
  function monta(entrada, ctx) {
    const estado = entrada.estado || null;
    const base = { now: ctx.hoje, rules: fuRules(estado && estado.rules ? estado.rules : null) };
    if (estado && estado.test_phone) base.test_phone = estado.test_phone;
    if (estado && estado.daily_cap !== undefined) base.daily_cap = estado.daily_cap;
    const agendados = {};
    ((estado && estado.scheduled) || []).forEach((a) => { agendados[a.phone_key] = a; });
    const linhas = entrada.linhas.map((r) => comEnvioAgora(comAgendado(r, agendados[r.phone_key])));
    const enviadosHoje = estado && estado.daily_count !== undefined ? Number(estado.daily_count) : linhas.filter((r) => fuDay(r.last_attempt_at) === ctx.hoje).length;
    base.daily_count = enviadosHoje;
    const todos = linhas.map((r) => fuResolve(r, base)); // quem esgotou as tentativas e não respondeu já aparece como Perdido
    return { ctx, entrada, estado, todos, fx: base, enviadosHoje, cov: fuCoverage(todos, base), idx: new Map(todos.map((p, i) => [p, i])) };
  }
  const situacao = (p) => fuSituation(p, S.fx);
  const lim = (p) => fuAttemptsLimit(p, S.fx);
  const contatavel = (p) => fuIsContactable(p, S.fx);
  const travado = (p) => !contatavel(p);
  const listaDe = (k) => fuSituationList(S.todos, k, S.fx);
  const filtraAud = (l) => (ui.aud ? l.filter((p) => p.audience === ui.aud) : l);
  const listaGrupo = (k) => filtraAud(listaDe(k));
  const fechadosAbertos = () => ui.closedOpen || ui.aud === 'attended' || ui.aud === 'lost';
  const porChave = (k) => S.todos.find((p) => p.phone_key === k) || null;
  const selecionado = () => (ui.sel ? porChave(ui.sel) : null);
  const haDias = (iso) => { const d = fuDaysBetween(fuDay(iso), S.fx.now); return d === 0 ? 'hoje' : `há ${plural(d, 'dia', 'dias')}`; };
  const dataTxt = (iso) => (fuDay(iso) === S.fx.now ? 'hoje' : dd(fuDay(iso)));

  function gruposTodos() {
    const out = [];
    ['due_today', 'julia_talking', 'scheduled', 'waiting'].concat(SOLTOS).forEach((k) => {
      const l = listaGrupo(k);
      if (l.length || SOLTOS.indexOf(k) < 0) out.push({ key: k, list: l });
    });
    out.push({ key: 'closed', list: FECHADOS.reduce((acc, k) => acc.concat(listaGrupo(k)), []) });
    return out;
  }
  // busca por cima dos filtros: com texto, olha TODOS os pacientes (ignora a visão e a audiência). Só dígitos = trecho do telefone; texto = primeiro nome
  const semAcento = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  function buscados() {
    const bruto = ui.busca.trim(), digitos = bruto.replace(/[\s()\-+.]/g, '');
    if (/^\d+$/.test(digitos)) return S.todos.filter((p) => String(p.phone || '').replace(/\D/g, '').indexOf(digitos) >= 0);
    const nome = semAcento(bruto);
    return S.todos.filter((p) => semAcento(p.first_name).indexOf(nome) >= 0);
  }
  const buscando = () => ui.busca.trim() !== '';
  function listaAtual() {
    if (buscando()) return buscados();
    if (ui.view !== 'all') return listaGrupo(ui.view);
    return gruposTodos().reduce((acc, g) => (g.key !== 'closed' || fechadosAbertos() ? acc.concat(g.list) : acc), []);
  }
  const baseDe = (view) => (view === 'all' ? S.todos : listaDe(view));

  // ---------------------------------------------------------------- textos
  function motivo(p) {
    if (p.audience === 'surgery') {
      return { indicated: 'Cirurgia indicada, e o paciente ainda não marcou a data.', in_talk: 'Está conversando sobre a cirurgia e ainda não decidiu.', booked: 'Cirurgia marcada: confirmar que está tudo certo até a data.', observing: 'Em observação: acompanhar a evolução antes de insistir.' }[p.surgery_status] || 'Cirurgia indicada.';
    }
    if (p.audience === 'C') return 'Cancelou ou faltou à consulta e ainda não remarcou.';
    if (p.audience === 'B') return 'Conversou com a clínica e não marcou consulta.';
    if (p.audience === 'A') return 'Preencheu o formulário e ainda não marcou consulta.';
    if (p.audience === 'attended') return 'Já foi atendido. Não recebe mensagem de acompanhamento.';
    if (p.audience === 'lost') {
      const r = FU_DISCARD_REASONS.find((x) => x.key === p.discard_reason);
      if (!r && DETALHE_PERDIDO[p.audience_detail]) return DETALHE_PERDIDO[p.audience_detail];
      return `Saiu do acompanhamento${r ? ` (${r.label.toLowerCase()})` : ''}.`;
    }
    return 'Telefone chegou sem formulário nem agenda.';
  }
  function tentativa(p) {
    const l = lim(p);
    if (p.audience === 'unsegmented') return 'Sem audiência, ainda não há tentativas';
    if (!l) return 'Este paciente não recebe tentativas';
    if (l.reached) return `Limite atingido: ${l.attempts} de ${l.max} tentativas feitas`;
    return `Esta seria a tentativa ${l.attempts + 1} de ${l.max} (feitas ${l.attempts})`;
  }
  const tentCurta = (p) => { const l = lim(p); return l ? `${l.attempts} de ${l.max}` : 'sem tentativas'; };
  function falouPorUltimo(p) {
    if (!p.last_speaker || !p.last_message_at) return 'Sem mensagens';
    const d = fuLastSpeakerDays(p, S.fx);
    return `${AUTOR[p.last_speaker] || 'Equipe'} falou por último, ${d === 0 ? 'hoje' : `há ${plural(d, 'dia', 'dias')}`}`;
  }
  function modelo(p) {
    const t = S.estado && S.estado.templates ? S.estado.templates[p.audience] : null;
    return t ? t.replace(' {nome}', p.first_name ? ` ${p.first_name}` : '').replace('{nome}', p.first_name || '') : '';
  }
  const textoDe = (p) => (rascunhos[p.phone_key] !== undefined ? rascunhos[p.phone_key] : modelo(p));

  // ---------------------------------------------------------------- coluna da esquerda
  // Cobertura: faixa de largura inteira acima da grade (topo baixo: a lista e a conversa ficam acima da dobra). Barra por situação, legenda com nome
  // e contagem (não só cor), os dois alertas sempre na tela (mesmo com 0). Tudo clicável: filtra a lista pela situação.
  const COBERTURA = ['due_today', 'julia_talking', 'scheduled', 'waiting', 'converted', 'discarded', 'do_not_contact'];
  function bandaCobertura() {
    let b = $('pc-cob');
    if (!b) {
      b = document.createElement('section');
      b.id = 'pc-cob';
      b.className = 'pc-cobertura fc-cartao';
      b.setAttribute('data-cobertura', '');
      b.setAttribute('aria-label', 'Cobertura do acompanhamento');
      $('pc-nav-m').parentNode.insertBefore(b, $('pc-nav-m'));
    }
    return b;
  }
  function coberturaHtml() {
    const cv = S.cov, esc = S.ctx.esc;
    const ativos = COBERTURA.filter((k) => cv.counts[k] > 0);
    const segs = ativos.map((k) => `<button type="button" class="pc-cob-seg pc-s-${k}" style="flex-grow:${cv.counts[k]}" data-act="sit" data-val="${k}" aria-pressed="${ui.view === k}" aria-label="${esc(SIT[k].label)}: ${cv.counts[k]}" title="${esc(SIT[k].label)}: ${cv.counts[k]}"></button>`).join('');
    const alerta = (k, texto) => (cv.counts[k] > 0
      ? `<button type="button" class="pc-btn-alerta" data-alerta="${k}" data-act="sit" data-val="${k}" aria-pressed="${ui.view === k}">${ic('warn')}<b>${cv.counts[k]}</b> ${texto}</button>`
      : `<span class="pc-alerta-zero" data-alerta="${k}"><b>0</b> ${texto}</span>`);
    const leg = COBERTURA.map((k) => `<button type="button" class="pc-leg" data-act="sit" data-val="${k}" aria-pressed="${ui.view === k}"><i class="pc-dot pc-s-${k}"></i>${esc(SIT[k].label)} <b>${cv.counts[k]}</b></button>`).join('');
    return `<div class="pc-cob-topo"><p class="pc-cob-txt pc-${cv.ok ? 'ok' : 'alerta'}">${cv.ok ? ic('ok') : ic('warn')}${cv.total} acompanhados: ${cv.ok ? 'nenhum esquecido' : `${cv.total - cv.covered} sem próximo passo`}</p>`
      + `<div class="pc-cob-alertas">${alerta('unsegmented', 'sem audiência: definir')}${alerta('no_next_step', 'sem próximo passo: ver')}</div></div>`
      + `<div class="pc-cob-bar" role="group" aria-label="Situação de cada paciente">${segs}</div><div class="pc-cob-leg" role="group" aria-label="Legenda da situação">${leg}</div>`;
  }
  function desenhaCobertura() { bandaCobertura().innerHTML = coberturaHtml(); }
  function filtrosHtml() {
    const { esc } = S.ctx;
    let visoes = VISOES.map(([k, nome]) => {
      const n = k === 'all' ? S.todos.length : listaDe(k).length;
      return `<option value="${k}"${ui.view === k ? ` selected>${esc(nome)}` : `>${esc(nome)} (${n})`}</option>`;
    }).join('');
    if (!VISOES.some(([k]) => k === ui.view)) visoes += `<option value="${ui.view}" selected>${esc(SIT[ui.view].label)}</option>`;
    const base = baseDe(ui.view);
    const auds = `<option value="">Todas as audiências</option>${AUD_LISTA.map((k) => {
      const n = base.filter((p) => p.audience === k).length;
      return `<option value="${k}"${ui.aud === k ? ` selected>${esc(FU_AUDIENCE_LABEL[k])}` : `>${esc(FU_AUDIENCE_LABEL[k])} (${n})`}</option>`;
    }).join('')}`;
    return `<div class="pc-filtros"><label class="pc-so-leitor" for="pc-busca">Buscar por telefone ou nome</label><input class="pc-campo pc-busca" id="pc-busca" type="search" autocomplete="off" inputmode="search" placeholder="Telefone ou nome" value="${esc(ui.busca)}">`
      + `<label class="pc-so-leitor" for="pc-f-view">Quem mostrar</label><select class="pc-campo" id="pc-f-view" data-filter="view">${visoes}</select>`
      + `<label class="pc-so-leitor" for="pc-f-aud">Audiência</label><select class="pc-campo" id="pc-f-aud" data-filter="aud"${ui.view === 'unsegmented' ? ' disabled' : ''}>${auds}</select>`
      + `${ui.view === 'julia_talking' ? '<p class="pc-dica">Pacientes que responderam. A Júlia está no meio da conversa, não precisa enviar.</p>' : ''}</div>`;
  }
  function seloHtml(p, sit) {
    const l = lim(p), { esc } = S.ctx;
    let t = '', cls = '';
    if (sit === 'due_today' && l && l.reached) { t = 'Limite: decida'; cls = ' pc-limite'; }
    else if (sit === 'waiting') t = `${l && l.reached ? 'sai ' : 'volta '}${dd(fuNextStep(p, S.fx))}`;
    else if (sit === 'scheduled' && p.scheduled_at) t = `${fuDay(p.scheduled_at) === S.fx.now ? 'às' : `${dd(fuDay(p.scheduled_at))} às`} ${hhmm(p.scheduled_at)}`;
    else if (FECHADOS.indexOf(sit) >= 0) { t = SIT[sit].label; cls = ' pc-trava'; }
    return t ? `<span class="pc-selo${cls}">${esc(t)}</span>` : '';
  }
  function itemHtml(p) {
    const { esc } = S.ctx, sit = situacao(p), umaAud = !!ui.aud || ui.view === 'unsegmented';
    const fala = (sit === 'due_today' || sit === 'julia_talking') && p.last_message_at ? haDias(p.last_message_at) : falouPorUltimo(p);
    const sem = p.audience === 'unsegmented';
    const cur = emCurso[p.phone_key], res = resultados[p.phone_key];
    const selo = cur ? `<span class="pc-selo pc-proc"><span class="pc-giro" aria-hidden="true"></span>${esc(ROTULO_CURSO[cur.nome])}</span>` : seloHtml(p, sit);
    return `<li><button type="button" class="pc-item" data-act="pick" data-id="${S.idx.get(p)}"${p.phone_key === ui.sel ? ' aria-current="true"' : ''}${cur ? ' aria-busy="true"' : ''}>`
      + `<span class="pc-i-nome">${esc(nomeDe(p))} <small>final ${esc(final4(p))}</small></span>${selo || (buscando() ? `<span class="pc-selo">${esc(SIT[sit].label)}</span>` : '')}`
      + `<span class="pc-i-meta${sem ? ' pc-sem' : ''}">${sem ? ic('warn') : (travado(p) ? ic('lock') : '')}${umaAud ? esc(tentCurta(p)) : `<b>${esc(FU_AUDIENCE_LABEL[p.audience])}</b> · ${esc(tentCurta(p))}`}</span>`
      + (res && !cur ? `<span class="pc-i-fala pc-i-res">${esc(res.texto)}</span>` : `<span class="pc-i-fala">${esc(fala)}</span>`) + '</button></li>';
  }
  function grupoCab(k, n) {
    const x = k === 'closed' ? { label: 'Fechados', order: 'converteram, descartados e não contatar' } : SIT[k];
    return `<span class="pc-gr-dot pc-s-${k === 'closed' ? 'discarded' : k}"></span><b>${S.ctx.esc(x.label)}</b>${n === null ? '' : ` <span class="pc-gr-n">${n}</span>`} <span class="pc-gr-ord">${S.ctx.esc(x.order)}</span>`;
  }
  function listaHtml(vazio) {
    if (buscando()) {
      const l = listaAtual();
      return `<section class="pc-gr"><h3 class="pc-gr-t"><b>Resultado da busca</b> <span class="pc-gr-ord">em todos os pacientes, sem os filtros</span></h3><ul class="pc-gr-l">${l.map(itemHtml).join('') || `<li class="pc-vazio-lista">${S.ctx.esc(vazio)}</li>`}</ul></section>`;
    }
    if (ui.view !== 'all') {
      const l = listaAtual();
      return `<section class="pc-gr"><h3 class="pc-gr-t">${grupoCab(ui.view, null)}</h3><ul class="pc-gr-l">${l.map(itemHtml).join('') || `<li class="pc-vazio-lista">${S.ctx.esc(vazio)}</li>`}</ul></section>`;
    }
    return gruposTodos().map((g) => {
      if (g.key === 'closed') {
        const ab = fechadosAbertos();
        return `<section class="pc-gr"><h3 class="pc-gr-t pc-gr-t-btn"><button type="button" class="pc-gr-toggle" data-act="closed_toggle" aria-expanded="${ab}">${ic('chev', 'pc-chev')}${grupoCab('closed', g.list.length)}</button></h3>${ab ? `<ul class="pc-gr-l">${g.list.map(itemHtml).join('')}</ul>` : ''}</section>`;
      }
      return `<section class="pc-gr"><h3 class="pc-gr-t">${grupoCab(g.key, g.list.length)}</h3><ul class="pc-gr-l">${g.list.map(itemHtml).join('') || '<li class="pc-vazio-lista">Ninguém.</li>'}</ul></section>`;
    }).join('');
  }
  function desenhaLista() {
    const box = $('pc-lista'), antigo = box.querySelector('.pc-itens'), topo = antigo ? antigo.scrollTop : 0;
    const lista = listaAtual(), pos = fuQueuePosition(lista, ui.sel, 'phone_key');
    const cab = lista.length ? `Paciente ${pos} de ${lista.length}` : 'Nenhum paciente';
    const fila0 = ui.view === 'due_today' && !ui.aud && !lista.length && !buscando();
    const vazio = buscando() ? 'Ninguém com esse telefone ou nome.' : ui.view === 'unsegmented' ? 'Zerou: nenhum telefone sem audiência.' : (ui.view === 'due_today' ? 'Ninguém está devido agora.' : 'Ninguém neste filtro.');
    box.innerHTML = filtrosHtml()
      + (fila0 ? '' : `<div class="pc-posicao"><h2 class="fc-h3" id="pc-posicao">${S.ctx.esc(cab)}</h2></div>`)
      + `<div class="pc-itens">${fila0 ? '<p class="pc-vazio-lista">Fila zerada. Veja o resumo.</p>' : listaHtml(vazio)}</div>`;
    const nova = box.querySelector('.pc-itens');
    nova.scrollTop = topo;
    const cur = nova.querySelector('[aria-current="true"]');
    if (cur) { const a = cur.getBoundingClientRect(), b = nova.getBoundingClientRect(); if (a.top < b.top || a.bottom > b.bottom) cur.scrollIntoView({ block: 'nearest' }); }
  }

  // ---------------------------------------------------------------- coluna do meio
  function reguaHtml(p) {
    const l = lim(p);
    if (!l) return '';
    let li = '';
    for (let i = 1; i <= l.max; i++) li += `<li class="pc-${i <= l.attempts ? 'feita' : (i === l.attempts + 1 ? 'prox' : 'fut')}">${i}</li>`;
    return `<div class="pc-regua" title="Tentativas"><span class="pc-regua-t" aria-hidden="true">Tentativa</span><span class="pc-so-leitor">${S.ctx.esc(tentativa(p))}</span><ol class="pc-regua-l" aria-hidden="true">${li}</ol></div>`;
  }
  function ctxHtml(p) {
    const { esc } = S.ctx, trava = travado(p), sem = p.audience === 'unsegmented';
    const lead = sem ? ic('warn') : (trava ? ic('lock') : '');
    const sub = p.audience === 'surgery' && SURGERY_LABEL[p.surgery_status] ? ` · ${SURGERY_LABEL[p.surgery_status].toLowerCase()}` : '';
    return `<section class="pc-ctx fc-cartao" aria-label="Contexto do contato"><div class="pc-ctx-l1"><span class="pc-aud${sem ? ' pc-sem' : (trava ? ' pc-trava' : '')}">${lead}${esc(FU_AUDIENCE_LABEL[p.audience] + sub)}</span>`
      + `<h2 class="fc-h3 pc-ctx-nome">${esc(nomeDe(p))}</h2>${reguaHtml(p)}</div><p class="pc-ctx-l2">${esc(motivo(p))}</p></section>`;
  }
  function balHtml(p, m) {
    const { esc } = S.ctx;
    const foto = m.text === null && m.media_type === 'image';
    const corpo = foto ? `<div class="pc-foto"><span class="pc-foto-img" role="img" aria-label="Miniatura da foto enviada">${ic('img')}</span><span>Foto enviada</span></div>`
      : (m.text === null ? 'Mídia enviada' : esc(m.text));
    const quando = m.sent_at ? `${dataTxt(m.sent_at)} ${hhmm(m.sent_at)}` : 'sem hora';
    const autor = m.author === 'patient' ? nomeDe(p) : (AUTOR[m.author] || 'Equipe');
    const lado = m.author === 'patient' || m.author === 'julia' ? m.author : 'operator';
    return `<div class="pc-bal pc-${lado}"><span class="pc-quem">${esc(autor)} <span>${quando}</span></span>${corpo}</div>`;
  }
  function conversaHtml(p) {
    const c = conversas[p.phone_key] || { estado: 'carregando' };
    let corpo;
    if (c.estado === 'carregando') corpo = '<p class="pc-conversa-vazia">Carregando a conversa...</p>';
    else if (c.estado === 'erro') corpo = '<p class="pc-conversa-vazia">Não consegui carregar a conversa. Tente de novo em alguns minutos.</p>';
    else corpo = c.msgs.length ? c.msgs.map((m) => balHtml(p, m)).join('') : '<p class="pc-conversa-vazia">Sem mensagens ainda.</p>';
    return `<section class="pc-conversa" id="pc-conversa" tabindex="0" aria-label="Conversa com ${S.ctx.esc(nomeDe(p))}, telefone final ${S.ctx.esc(final4(p))}">${corpo}</section>`;
  }
  function selectDias(valores, atual) {
    return valores.map((v) => `<option value="${v}"${v === atual ? ' selected' : ''}>${v}${v === 1 ? ' dia' : ' dias'}</option>`).join('');
  }
  function painelHtml(p) {
    const { esc } = S.ctx;
    if (ui.panel === 'schedule') {
      const hoje = hojeSp(), pad = !ui.avisoPadrao && padrao.modo === 'agendar';
      return `<div class="pc-painel-acao">${ui.avisoPadrao ? `<div class="pc-aviso pc-perigo" role="alert">${ic('warn')}<span>${esc(ui.avisoPadrao)}</span></div>` : ''}<div class="pc-linha"><label class="pc-rot" for="pc-p-date">Agendar para que dia e hora?</label></div><div class="pc-linha"><input class="pc-campo" type="date" id="pc-p-date" aria-label="Dia do envio" min="${hoje}" max="${fuAddDays(hoje, DIAS_MAX)}" value="${pad ? padrao.data : hoje}"><input class="pc-campo" type="time" id="pc-p-time" aria-label="Hora do envio"${pad ? ` value="${padrao.hora}"` : ''}><button type="button" class="pc-btn" data-act="ok_schedule">Confirmar</button></div></div>`;
    }
    if (ui.panel === 'snooze') return `<div class="pc-painel-acao"><div class="pc-linha"><label class="pc-rot" for="pc-p-days">Soneca por quantos dias?</label></div><div class="pc-linha"><select class="pc-campo" id="pc-p-days">${selectDias([3, 7, 15, 30], 7)}</select><button type="button" class="pc-btn" data-act="ok_snooze">Confirmar</button></div></div>`;
    if (ui.panel === 'discard') return `<div class="pc-painel-acao"><div class="pc-linha"><label class="pc-rot" for="pc-p-reason">Por que descartar?</label></div><div class="pc-linha"><select class="pc-campo" id="pc-p-reason">${FU_DISCARD_REASONS.map((x) => `<option value="${x.key}">${esc(x.label)}</option>`).join('')}</select><button type="button" class="pc-btn pc-perigo pc-ghost" data-act="ok_discard">Descartar</button></div></div>`;
    if (ui.panel === 'convert') return `<div class="pc-painel-acao"><div class="pc-linha"><span class="pc-rot">O que foi marcado?</span></div><div class="pc-linha">${p.audience === 'surgery' ? '' : '<button type="button" class="pc-btn" data-act="ok_convert" data-val="consultation">Consulta marcada</button>'}<button type="button" class="pc-btn" data-act="ok_convert" data-val="surgery">Cirurgia marcada</button></div></div>`;
    return '';
  }
  function padraoHtml() {
    const ag = padrao.modo === 'agendar', hora = ag ? padrao.hora : horaUlt, hoje = hojeSp(), data = ag ? padrao.data : (dataUlt || hoje);
    return `<fieldset class="pc-padrao"><legend class="pc-rot">Envio padrão:</legend>`
      + `<label class="pc-padrao-op"><input type="radio" name="pc-padrao-modo" value="agora" data-padrao="modo"${ag ? '' : ' checked'}><span>Agora</span></label>`
      + `<label class="pc-padrao-op"><input type="radio" name="pc-padrao-modo" value="agendar" data-padrao="modo"${ag ? ' checked' : ''}><span>Agendar em</span></label>`
      + `<input class="pc-campo" type="date" id="pc-padrao-data" data-padrao="data" aria-label="Dia do envio padrão" min="${hoje}" max="${fuAddDays(hoje, DIAS_MAX)}" value="${data}">`
      + `<span class="pc-padrao-hr"><span class="pc-rot">às</span><input class="pc-campo" type="time" id="pc-padrao-hora" data-padrao="hora" aria-label="Hora do envio padrão" value="${hora}"></span></fieldset>`;
  }
  function acoesHtml(p, desligado, bloqueio) {
    const ag = padrao.modo === 'agendar';
    const btn = (k, nome, tecla, i) => {
      const off = desligado || (bloqueio && (k === 'send' || k === 'send_now' || k === 'schedule'));
      return `<button type="button" class="pc-btn${i === 0 ? '' : ' pc-ghost'}${k === 'discard' ? ' pc-perigo' : ''}" data-act="cmd" data-cmd="${k}"${tecla ? ` aria-keyshortcuts="${tecla}"` : ''}${off ? ' disabled' : ''}>${nome}</button>`;
    };
    return `<div class="pc-acoes" role="group" aria-label="Ações para ${S.ctx.esc(nomeDe(p))}">${COMANDOS.map(([k, nome, tecla], i) => (k === 'send' && ag ? btn(k, `Agendar ${quando(padrao.data, padrao.hora)}`, tecla, i) + btn('send_now', 'Enviar agora', '', 1) : btn(k, nome, tecla, i))).join('')}</div>`;
  }
  function defineHtml(p) {
    const { esc } = S.ctx;
    const opts = `<option value="" selected disabled>Escolha a audiência</option>${FU_CONTACTABLE.map((a) => `<option value="${a}">${esc(FU_AUDIENCE_LABEL[a])}</option>`).join('')}`;
    const ligado = !!S.estado;
    if (!ligado) return semAcaoHtml();
    return `<section class="pc-acao fc-cartao" aria-label="Definir audiência"><h3 class="pc-acao-t">Definir audiência</h3>`
      + `<p class="fc-legenda">${p.audience === 'lost' ? `Nenhuma regra encaixou ${esc(nomeDe(p))}, então ela ficou em Perdidos e a Júlia não contata.` : `Sem audiência, a Júlia não pode contatar ${esc(nomeDe(p))}.`} Escolha onde esta pessoa entra no acompanhamento. A escolha fica no log.</p>`
      + `<div class="pc-def-campos"><div><label class="pc-rot" for="pc-def-aud">Audiência</label><select class="pc-campo" id="pc-def-aud"${ligado ? '' : ' disabled'}>${opts}</select></div>`
      + `<button type="button" class="pc-btn" data-act="define"${ligado ? '' : ' disabled'}>Definir audiência</button></div>${resHtml(p)}</section>`;
  }
  // sem o state do servidor: um bloco de estado no lugar das ações (os botões ficam ocultos, não cinzas no mesmo lugar)
  const semAcaoHtml = () => `<section class="pc-acao fc-cartao" aria-label="Ações"><div class="pc-aviso pc-desligadas" data-estado="acoes-desligadas" role="alert">${ic('warn')}<span>As ações não estão disponíveis agora: não consegui falar com o servidor. Recarregue a página. Por enquanto ela só mostra a situação de cada paciente.</span><button type="button" class="pc-btn pc-ghost" data-act="recarregar">Recarregar</button></div></section>`;
  const resHtml = (p) => (resultados[p.phone_key] ? `<div class="pc-aviso pc-perigo">${ic('warn')}<span>${S.ctx.esc(resultados[p.phone_key].texto)}</span></div>` : '');
  function processandoHtml(p) {
    return `<section class="pc-acao fc-cartao" aria-label="Ações"><div class="pc-aviso pc-processando" role="status"><span class="pc-giro" aria-hidden="true"></span><span>${S.ctx.esc(ROTULO_CURSO[emCurso[p.phone_key].nome])} para ${S.ctx.esc(nomeDe(p))}... O servidor pode levar até 40 segundos. Siga com os outros pacientes, o resultado aparece no item e no Log.</span></div>${acoesHtml(p, true, null)}</section>`;
  }
  function composerHtml(p) {
    const { esc } = S.ctx;
    if (!S.estado) return semAcaoHtml();
    if (emCurso[p.phone_key]) return processandoHtml(p);
    if (fuAudienceSettable(p)) return defineHtml(p);
    if (travado(p)) {
      return `<section class="pc-acao fc-cartao" aria-label="Ações"><div class="pc-aviso">${ic('lock')}<span>${esc(p.audience === 'attended' ? 'Paciente atendido: não recebe mensagem de acompanhamento.' : 'Paciente perdido: não recebe mensagem.')}</span></div>${acoesHtml(p, true, null)}</section>`;
    }
    const b = fuSendBlock(p, S.fx), bloqueio = b ? b[1] : null, solto = situacao(p) === 'no_next_step';
    return `<section class="pc-acao fc-cartao" aria-label="Mensagem e ações"><div><label class="pc-so-leitor" for="pc-draft">Mensagem, já preenchida; pode editar antes de enviar</label>`
      + `<textarea class="pc-campo pc-rascunho" id="pc-draft">${esc(textoDe(p))}</textarea></div>`
      + resHtml(p)
      + (solto ? `<div class="pc-aviso pc-perigo">${ic('warn')}<span>Sem próximo passo: ninguém marcou o próximo contato de ${esc(nomeDe(p))}. Envie, agende ou use Soneca para devolver à fila.</span></div>` : '')
      + (bloqueio ? `<div class="pc-aviso">${ic('info')}<span>Envio bloqueado: ${esc(bloqueio)}</span></div>` : '')
      + padraoHtml() + acoesHtml(p, false, bloqueio) + painelHtml(p) + '</section>';
  }
  const diaTxt = (iso) => `${new Date(`${iso}T12:00:00Z`).toLocaleDateString('pt-BR', { weekday: 'short', timeZone: 'UTC' }).replace('.', '')} ${dd(iso)}`;
  function nomeBtn(p, txt) { return `<button type="button" class="pc-nome-btn" data-act="pick_sit" data-id="${S.idx.get(p)}">${S.ctx.esc(txt || nomeDe(p))}</button>`; }
  function nomesDia(d) {
    const ab = ui.diasAbertos[d.date], vis = ab ? d.patients : d.patients.slice(0, DIA_MAX), mais = d.patients.length - DIA_MAX;
    return vis.map((p) => nomeBtn(p)).join('') + (mais > 0 ? `<button type="button" class="pc-nome-btn pc-mais" data-act="dia_mais" data-val="${d.date}" aria-expanded="${!!ab}">${ab ? 'ver menos' : `mais ${mais}`}</button>` : '');
  }
  function fimDoDia() {
    const { esc } = S.ctx;
    const ag = fuAgenda(S.todos, S.fx, 7), ult = fuFinalAttemptList(S.todos, S.fx), jul = listaDe('julia_talking');
    const dias = ag.days.map((d) => `<div class="pc-dia"><h4>${esc(diaTxt(d.date))}</h4><p class="pc-dia-n${d.patients.length ? '' : ' pc-zero'}">${d.patients.length}</p>${nomesDia(d)}</div>`).join('');
    const depois = ag.later.length ? `<p class="pc-vazio-nota">Depois de ${dd(ag.days[ag.days.length - 1].date)}: ${ag.later.map((p) => nomeBtn(p)).join(' ')}</p>` : '';
    const linha = (p, detalhe) => `<li><span>${esc(nomeDe(p))} <span class="pc-res-d">${esc(detalhe)}</span></span><button type="button" class="pc-btn pc-ghost" data-act="pick_sit" data-id="${S.idx.get(p)}">Abrir</button></li>`;
    const ultHtml = ult.length ? `<ul class="pc-res-l">${ult.map((p) => linha(p, `${tentCurta(p)}, sai em ${dd(fuNextStep(p, S.fx))} se não responder`)).join('')}</ul>` : '<p class="pc-vazio-nota">Ninguém na tentativa final.</p>';
    const julHtml = jul.length ? `<ul class="pc-res-l">${jul.map((p) => linha(p, `respondeu ${haDias(p.last_message_at)}`)).join('')}</ul>` : '<p class="pc-vazio-nota">Nenhuma conversa aberta.</p>';
    const usados = S.estado && S.estado.daily_cap !== undefined ? ` ${S.enviadosHoje} de ${S.estado.daily_cap} envios usados.` : '';
    return `<section class="pc-fim-dia fc-cartao"><div><h2 class="fc-h2">Pronto por hoje</h2><p class="fc-corpo">Ninguém mais está devido.${usados}</p></div>`
      + `<div class="pc-res-bloco"><h3 class="pc-sec-t">Próximos 7 dias</h3><div class="pc-dias">${dias}</div>${depois}</div>`
      + `<div class="pc-res-duas"><div class="pc-res-bloco"><h3 class="pc-sec-t">Última tentativa</h3><p class="pc-vazio-nota">Já fizeram todas as tentativas e saem sozinhos se não responderem.</p>${ultHtml}</div>`
      + `<div class="pc-res-bloco"><h3 class="pc-sec-t">Com a Júlia</h3><p class="pc-vazio-nota">Responderam, a Júlia está na conversa.</p>${julHtml}</div></div></section>`;
  }
  const CAMPOS_PAINEL = ['pc-p-date', 'pc-p-time', 'pc-p-days', 'pc-p-reason', 'pc-def-aud'];
  let meioDe = null; // de quem é o meio desenhado por último
  function desenhaMeio() {
    const box = $('pc-meio'), p = selecionado();
    if (!p) {
      const sem = ui.view === 'unsegmented';
      box.innerHTML = buscando() ? '<section class="pc-fim-dia fc-cartao"><h2 class="fc-h2">Nenhum paciente encontrado</h2><p class="fc-corpo">Confira o telefone ou o primeiro nome. Apague a busca para voltar à lista.</p></section>'
        : ui.view === 'due_today' && !ui.aud ? fimDoDia()
        : `<section class="pc-fim-dia fc-cartao"><h2 class="fc-h2">${S.ctx.esc(sem ? 'Nenhum telefone sem audiência' : 'Ninguém neste filtro')}</h2><p class="fc-corpo">${S.ctx.esc(sem ? 'O alerta está zerado. Quando um telefone chegar sem formulário nem agenda, ele aparece aqui.' : 'Escolha outra opção na lista.')}</p></section>`;
      return;
    }
    const salvos = meioDe === p.phone_key ? CAMPOS_PAINEL.filter((id) => $(id)).map((id) => [id, $(id).value]) : []; // a resposta de outro paciente redesenha esta tela
    box.innerHTML = ctxHtml(p) + conversaHtml(p) + composerHtml(p);
    salvos.forEach(([id, v]) => { if ($(id)) $(id).value = v; });
    meioDe = p.phone_key;
    const conv = $('pc-conversa');
    conv.scrollTop = conv.scrollHeight;
  }

  // ---------------------------------------------------------------- coluna da direita
  function prontHtml(p) {
    const { esc } = S.ctx;
    const tem = p.consult_date || p.diagnosis || p.procedure;
    const corpo = tem
      ? `<dl>${p.consult_date ? `<div><dt>Última consulta</dt><dd>${esc(`${dd(p.consult_date)} (${haDias(p.consult_date)})`)}</dd></div>` : ''}`
        + `${p.diagnosis ? `<div><dt>Diagnóstico</dt><dd>${esc(p.diagnosis)}</dd></div>` : ''}`
        + `${p.procedure ? `<div><dt>Procedimento indicado</dt><dd>${esc(p.procedure)}</dd></div>` : ''}`
        + `<div><dt>${p.origin ? 'Origem' : 'Telefone'}</dt><dd>${esc(p.origin ? `${p.origin} · telefone final ${final4(p)}` : `Final ${final4(p)}`)}</dd></div></dl>`
      : `<div class="pc-pront-vazio"><p class="fc-corpo">Sem consulta registrada</p><p class="fc-legenda">Quando o sistema da clínica registrar uma consulta, o prontuário aparece aqui.</p></div><dl><div><dt>${p.origin ? 'Origem' : 'Telefone'}</dt><dd>${esc(p.origin ? `${p.origin} · telefone final ${final4(p)}` : `Final ${final4(p)}`)}</dd></div></dl>`;
    const url = window.PainelCirurgias.linkErp(p.erp, 'prontuario', p.erp_patient_id);
    const sistema = url ? window.PainelCirurgias.ERPS[p.erp].nome : '';
    const link = url ? `<a class="pc-link-asa" href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(`Abrir ${nomeDe(p)}, telefone final ${final4(p)}, no ${sistema} (abre em nova aba)`)}">Abrir no ${esc(sistema)} ${ic('ext')}</a>` : '';
    return `<section class="pc-pront fc-cartao" aria-label="Prontuário"><h2 class="pc-sec-t">Prontuário</h2>${corpo}${link}</section>`;
  }
  function agendadoHtml(p) {
    if (!S.estado) return '';
    const { esc } = S.ctx, t = String(p.scheduled_text || '');
    const quando = !p.scheduled_active ? '' : (fuDay(p.scheduled_at) === S.fx.now ? hhmm(p.scheduled_at) : `${dd(fuDay(p.scheduled_at))} ${hhmm(p.scheduled_at)}`);
    const cur = !!emCurso[p.phone_key];
    return '<section><h2 class="pc-sec-t">Envios agendados</h2>' + (p.scheduled_active
      ? `<div class="pc-agendado"><span>${esc(quando)} · ${esc(t.slice(0, 26))}${t.length > 26 ? '…' : ''}</span><button type="button" class="pc-btn pc-ghost pc-perigo" data-act="cancel" aria-label="${esc(`Cancelar o envio agendado de ${nomeDe(p)}`)}"${cur ? ' disabled' : ''}>Cancelar</button></div>`
      : '<p class="pc-vazio-nota">Nenhum envio agendado.</p>') + '</section>';
  }
  function perfilHtml(p) {
    const { esc } = S.ctx;
    const prox = contatavel(p) ? fuNextStep(p, S.fx) : null;
    const itens = [];
    if (contatavel(p)) itens.push(`<li><b>Tentativas</b> ${esc(tentCurta(p))}</li>`);
    if (contatavel(p)) itens.push(`<li><b>Próximo contato</b> ${prox ? esc(prox === S.fx.now ? 'hoje' : dd(prox)) : 'sem data'}</li>`);
    if (p.snooze_until && fuDaysBetween(S.fx.now, p.snooze_until) > 0) itens.push(`<li><b>Soneca até</b> ${esc(dd(p.snooze_until))}</li>`);
    if (p.last_message_at) itens.push(`<li><b>Última mensagem</b> ${esc(haDias(p.last_message_at))}</li>`);
    // Acompanhamento é um cartão à parte do Prontuário (decisão do Felipe, 13/11/2026)
    return '<section class="pc-perfil fc-cartao" aria-label="Acompanhamento"><h2 class="pc-sec-t">Acompanhamento</h2>'
      + (itens.length ? `<ul class="pc-fatos">${itens.join('')}</ul>` : '<p class="pc-vazio-nota">Sem acompanhamento ativo.</p>')
      + agendadoHtml(p) + '</section>';
  }
  function desenhaDir() {
    const p = selecionado();
    $('pc-dir').innerHTML = p ? prontHtml(p) + perfilHtml(p) : '<section class="pc-pront fc-cartao"><h2 class="pc-sec-t">Prontuário</h2><p class="fc-corpo">Escolha alguém na lista para ver o prontuário e o perfil.</p></section>';
  }

  // ---------------------------------------------------------------- topo e navegação do celular
  function desenhaTopo() {
    const cap = S.estado && S.estado.daily_cap !== undefined ? S.estado.daily_cap : null;
    const n = S.enviadosHoje;
    $('pc-contador').innerHTML = cap === null ? `<span class="pc-cont-n">${n}</span> ${n === 1 ? 'envio' : 'envios'} hoje`
      : `<span class="pc-cont-n">${n}</span> de ${cap} hoje${n >= cap ? ' (teto atingido)' : ''}`;
    $('pc-nav-m').innerHTML = [['lista', 'Lista'], ['conversa', 'Conversa'], ['pront', 'Prontuário']].map(([k, nome]) => `<button type="button" data-act="pane" data-val="${k}" aria-pressed="${ui.pane === k}">${nome}</button>`).join('');
    const grade = $('pc-grade');
    grade.removeAttribute('data-pane'); // o index.html nasce com data-pane na grade; agora cada coluna é um [data-pane] e a grade guarda só qual está à vista
    grade.dataset.ver = ui.pane;
    [['lista', 'pc-lista'], ['conversa', 'pc-meio'], ['pront', 'pc-dir']].forEach(([k, id]) => { $(id).closest('.pc-col').dataset.pane = k; });
  }

  // ---------------------------------------------------------------- seleção, conversa sob demanda e ações
  async function carregaConversa(chave) {
    const p = porChave(chave);
    if (!p || (conversas[chave] && conversas[chave].estado !== 'erro')) return;
    conversas[chave] = { estado: 'carregando' };
    const ctx = S.ctx;
    try {
      const msgs = await ctx.mensagens(chave);
      if (msgs === null) { delete conversas[chave]; return; } // a sessão caiu: o painel já mostrou o login
      conversas[chave] = { estado: 'ok', msgs };
    } catch (e) {
      conversas[chave] = { estado: 'erro' };
    }
    if (ui.sel === chave && S && S.ctx === ctx) desenhaMeio();
  }
  let timerBusca = null;
  function seleciona(chave) {
    ui.sel = chave;
    if (!chave) return;
    if (!buscando()) { carregaConversa(chave); return; }
    clearTimeout(timerBusca); // digitando, o primeiro resultado muda a cada tecla: só lê a conversa de quem fica aberto
    timerBusca = setTimeout(() => { if (S && ui.sel === chave) carregaConversa(chave); }, 300);
  }
  function desenha() {
    const lista = listaAtual();
    if (!ui.sel || !lista.some((p) => p.phone_key === ui.sel)) {
      let prox = null;
      if (ui.pendente) { // depois de uma ação: a próxima pessoa da fila, senão a anterior (como no protótipo)
        const { antes, idx } = ui.pendente, depois = lista.map((p) => p.phone_key);
        for (let k = idx + 1; k < antes.length && !prox; k++) if (depois.indexOf(antes[k]) >= 0) prox = antes[k];
        for (let k = idx - 1; k >= 0 && !prox; k--) if (depois.indexOf(antes[k]) >= 0) prox = antes[k];
      }
      seleciona(prox || (lista.length ? lista[0].phone_key : null));
    }
    ui.pendente = null;
    const ae = document.activeElement, foco = ae && ae.dataset ? (ae.dataset.cmd || null) : null, focoSel = ae && ae.dataset && ae.dataset.filter ? ae.id : null;
    const campo = ae && (ae.id === 'pc-draft' || ae.id === 'pc-busca' || CAMPOS_PAINEL.indexOf(ae.id) >= 0) ? { id: ae.id, ini: ae.selectionStart, fim: ae.selectionEnd } : null;
    const foiAct = !foco && !focoSel && ae && ae.dataset && ae.dataset.act ? { act: ae.dataset.act, val: ae.dataset.val } : null; // o redesenho troca o HTML: o teclado volta pro mesmo lugar
    desenhaTopo(); desenhaCobertura(); desenhaLista(); desenhaMeio(); desenhaDir(); desenhaLog();
    if (foiAct) {
      const alvo = foiAct.act === 'pick' || foiAct.act === 'pick_sit' ? document.querySelector('#pg-pacientes .pc-item[aria-current="true"]') : document.querySelector(`#pg-pacientes [data-act="${foiAct.act}"]${foiAct.val !== undefined ? `[data-val="${foiAct.val}"]` : ''}`);
      if (alvo) alvo.focus({ preventScroll: true });
    }
    if (campo && $(campo.id)) { // quem está escrevendo não perde o lugar quando a resposta de outra ação redesenha a tela
      $(campo.id).focus({ preventScroll: true });
      if (campo.ini !== null && campo.ini !== undefined && $(campo.id).setSelectionRange) { try { $(campo.id).setSelectionRange(campo.ini, campo.fim); } catch (e) { /* tipo sem seleção */ } }
    }
    if (foco) { const b = document.querySelector(`#pg-pacientes [data-cmd="${foco}"]:not(:disabled)`); if (b) b.focus({ preventScroll: true }); }
    if (focoSel) { const sf = $(focoSel); if (sf && !sf.disabled) sf.focus({ preventScroll: true }); }
  }

  let timerAviso = null;
  function aviso(msg, ok) {
    if (!msg) return;
    const t = $('pc-toast');
    t.textContent = msg;
    t.className = `pc-toast pc-on${ok === false ? ' pc-ruim' : ''}`;
    clearTimeout(timerAviso);
    timerAviso = setTimeout(() => { t.className = `pc-toast${ok === false ? ' pc-ruim' : ''}`; }, ok === false ? 10000 : 5000); // erro fica mais: dá tempo de ler
  }

  // ---------------------------------------------------------------- Log desta sessão (espelho local do crm_action que o servidor grava no BigQuery)
  const FRASE = {
    send_now: ['Enviando para {n}', 'Enviou para {n}'], schedule: ['Agendando para {n}', 'Agendou para {n}'],
    cancel_schedule: ['Cancelando o envio de {n}', 'Cancelou o envio de {n}'], skip: ['Pulando {n} hoje', 'Pulou {n} hoje'],
    snooze: ['Colocando {n} em soneca', '{n} em soneca'], discard: ['Descartando {n}', 'Descartou {n}'],
    mark_converted: ['Registrando que {n} converteu', '{n} converteu'], set_audience: ['Definindo a audiência de {n}', 'Definiu a audiência de {n}'],
  };
  function frase(e) {
    const n = e.first_name || 'o paciente', f = FRASE[e.action];
    if (e.status === 'processando') return f[0].replace('{n}', n);
    if (e.status === 'ok') return f[1].replace('{n}', n) + (e.extra || '');
    return `${e.status === 'recusado' ? 'Recusado' : 'Falhou'} para ${n}: ${e.message}`;
  }
  // o que sai no JSON: ação, resultado e o paciente só pelo primeiro nome e o final do telefone (nunca o telefone nem a chave)
  const logPublico = () => registro.map((e) => ({ ts: e.ts, action_id: e.action_id, action: e.action, status: e.status, tenant: e.tenant, first_name: e.first_name, phone_last4: e.phone_last4, audience: e.audience, reason: e.reason || null, message: frase(e) }));
  function logHtml() {
    const { esc } = S.ctx, ult = registro[registro.length - 1];
    const linhas = registro.slice(-14).reverse().map((e) => `<div class="pc-logl"><span class="pc-hora">${hhmm(e.ts)}</span>${esc(frase(e))}</div>`).join('') || '<p class="pc-vazio-nota">Nada gravado ainda.</p>';
    // Ferramentas: recolhido, no fim da página. Log da sessão, baixar, copiar e a dica dos atalhos (que não aparece mais dentro dos botões).
    return `<details class="pc-ferr" data-ferramentas${ui.ferrOpen ? ' open' : ''}><summary class="pc-ferr-t">${ic('chev', 'pc-chev')}Ferramentas <span class="pc-ferr-n">log da sessão e atalhos</span></summary><div class="pc-ferr-corpo">`
      + `<div class="pc-logcab"><button type="button" class="pc-btn pc-ghost pc-log-t" data-act="log_toggle" aria-expanded="${ui.logOpen}" aria-controls="pc-logcorpo">${ic('chev', 'pc-chev')}Log (${registro.length})</button>`
      + `<span class="pc-log-ult">${ui.logOpen ? '' : (ult ? `última: ${esc(frase(ult))}` : 'nada gravado')}</span>`
      + `<button type="button" class="pc-btn pc-ghost" data-act="log_dl">${ic('down')}Baixar log (JSON)</button><button type="button" class="pc-btn pc-ghost" data-act="log_copy">${ic('copy')}Copiar</button></div>`
      + `<div class="pc-logcorpo" id="pc-logcorpo"${ui.logOpen ? '' : ' hidden'}>${linhas}</div>`
      + '<p class="pc-dica-atalhos" data-dica="atalhos">Atalhos com um paciente aberto: E envia agora, A agenda, P pula hoje, S soneca, D descarta, C marca que converteu.</p></div></details>';
  }
  function desenhaLog() {
    const bar = $('pc-logbar');
    bar.innerHTML = logHtml();
    $('pg-pacientes').style.setProperty('--pc-log-h', `${bar.offsetHeight}px`); // a grade encolhe e o aviso sobe quando o Log abre (CSS)
  }
  function baixaLog() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(logPublico(), null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = `log-pacientes-${ui.tenant}-${S.fx.now}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    aviso('Log baixado');
  }
  function copiaLog() {
    const txt = JSON.stringify(logPublico(), null, 2);
    const plano = () => {
      const t = document.createElement('textarea');
      t.value = txt; document.body.appendChild(t); t.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { /* sem permissão */ }
      t.remove();
      aviso(ok ? 'Log copiado' : 'Não consegui copiar', ok);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(() => aviso('Log copiado'), plano); else plano();
  }

  // ---------------------------------------------------------------- ações
  const novoId = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
  // quem vem depois na fila que não esteja esperando o servidor; senão o anterior
  function proximoDaFila(antes, idx) {
    const livre = (k) => !emCurso[k];
    for (let k = idx + 1; k < antes.length; k++) if (livre(antes[k])) return antes[k];
    for (let k = idx - 1; k >= 0; k--) if (livre(antes[k])) return antes[k];
    return null;
  }
  function textoFalha(r) {
    if (r.message) return r.message; // nem houve resposta (rede, sem permissão, demora)
    const resp = r.resp || {};
    if (resp.status === 'falha') return 'O WhatsApp recusou o envio. Nada foi reenviado.';
    return ERRO_MOTIVO[resp.motivo] || `A ação não foi feita${resp.motivo ? ` (${resp.motivo})` : ''}. Tente de novo.`;
  }
  // depois do "ok" o que a página já sabe sem esperar a view: o envio, o agendado novo e o cancelado
  function aplicaOk(nome, p, corpo, r) {
    const linha = S.entrada.linhas.find((x) => x.phone_key === p.phone_key);
    if (nome === 'send_now' && linha) enviadosAgora[p.phone_key] = { sig: sigEnvio(linha), em: new Date().toISOString() };
    const ag = (S.estado.scheduled || []).filter((a) => a.phone_key !== p.phone_key && a.schedule_id !== corpo.schedule_id);
    if (nome === 'schedule') ag.push({ phone: p.phone, phone_key: p.phone_key, schedule_id: r.resp.schedule_id, at: r.resp.at || corpo.at, text: corpo.text || modelo(p), audience: p.audience });
    if (nome === 'schedule' || nome === 'cancel_schedule') S.estado.scheduled = ag;
    S = monta(S.entrada, S.ctx);
  }

  // O único ponto de ação: tudo que muda um paciente passa por aqui e vai ao servidor (ctx.acao). O servidor confere de novo.
  // O servidor leva até 40 s: o paciente fica "processando", a fila já anda e o resultado volta no item, no aviso e no Log.
  async function executa(nome, corpo, extra, quando) {
    const p = selecionado();
    if (!p || !S.estado || !S.ctx.acao || emCurso[p.phone_key] || Date.now() < travaAte) return;
    if (nome === 'send_now' || nome === 'schedule') {
      const b = fuSendBlock(p, S.fx);
      if (b) { aviso(b[1], false); return; }
      definePadrao(nome === 'send_now' ? { modo: 'agora' } : { modo: 'agendar', data: quando.data, hora: quando.hora });
    }
    const ctx = S.ctx, tenant = ui.tenant, chave = p.phone_key;
    const antes = listaAtual().map((x) => x.phone_key), idx = antes.indexOf(chave);
    const id = novoId(), marca = { nome, id };
    const e = { ts: new Date().toISOString(), action_id: id, action: nome, status: 'processando', tenant, first_name: p.first_name || null, phone_last4: final4(p), audience: p.audience, extra: extra || '', message: '' };
    registro.push(e);
    emCurso[chave] = marca;
    delete resultados[chave];
    travaAte = Date.now() + TRAVA_MS;
    ui.panel = null; ui.avisoPadrao = null;
    const prox = proximoDaFila(antes, idx);
    if (prox) seleciona(prox);
    desenha();
    let r;
    try {
      r = await ctx.acao(nome, { phone: p.phone, action_id: id, ...corpo });
    } catch (err) {
      r = { ok: false, message: 'Não consegui falar com o servidor. Tente de novo.' };
    }
    if (ui.tenant !== tenant || emCurso[chave] !== marca) return; // trocou de cliente: a resposta não é desta tela
    delete emCurso[chave];
    if (r.semLogin) { // a sessão caiu e o pedido nem saiu: o painel já mostrou o login
      e.status = 'erro'; e.message = 'sua sessão expirou, a ação não foi feita';
      aviso(frase(e), false); desenha();
      return;
    }
    const recusado = !r.ok && !!r.resp && r.resp.status === 'recusado';
    e.status = r.ok ? 'ok' : (recusado ? 'recusado' : 'erro');
    e.reason = (r.resp && r.resp.motivo) || null;
    if (r.ok) {
      delete rascunhos[chave];
      aplicaOk(nome, p, corpo, r);
      if (ui.sel === chave) ui.pendente = { antes, idx };
    } else {
      e.message = recusado ? (r.resp.texto || 'o servidor recusou a ação.') : textoFalha(r);
      resultados[chave] = { texto: `${recusado ? 'Recusado: ' : ''}${e.message}` };
    }
    aviso(frase(e), r.ok);
    desenha();
    ctx.recarrega(); // a view e o state voltam do servidor: o que a página supôs acima é trocado pelo que está gravado
  }
  const rascunho = () => { const ta = $('pc-draft'); return ta ? ta.value : undefined; };
  const textoOpc = () => { const t = rascunho(); return t && t.trim() ? { text: t } : {}; }; // sem texto o servidor usa o padrão da audiência
  const extraAgenda = (data, hora) => (data === hojeSp() ? ` às ${hora}` : ` em ${dd(data)} às ${hora}`);
  function focaPainel() {
    const painel = document.querySelector('#pg-pacientes .pc-painel-acao');
    if (painel) { painel.scrollIntoView({ block: 'nearest' }); const f = painel.querySelector('input,select,button'); if (f) f.focus({ preventScroll: true }); }
  }
  function comando(cmd) {
    const p = selecionado();
    if (!p) return;
    if (cmd === 'send' && padrao.modo === 'agendar') { // o botão principal segue o padrão: agenda direto na hora padrão
      const r = resolveAgenda(padrao.data, padrao.hora);
      if (r.erro) { // nunca agenda numa hora que o Felipe não escolheu: abre o painel para ele escolher outra
        ui.panel = 'schedule'; ui.avisoPadrao = r.erro === 'passou' ? `O horário padrão (${dataHora(padrao.data, padrao.hora)}) já passou. Escolha outro.` : ERRO_MOTIVO.at_longe_demais;
        desenhaMeio(); focaPainel(); return;
      }
      executa('schedule', { at: r.at, ...textoOpc() }, extraAgenda(padrao.data, padrao.hora), { data: padrao.data, hora: padrao.hora });
      return;
    }
    if (cmd === 'send' || cmd === 'send_now') { executa('send_now', textoOpc()); return; }
    if (cmd === 'skip') { executa('skip', {}); return; }
    ui.avisoPadrao = null;
    ui.panel = ui.panel === cmd ? null : cmd;
    desenhaMeio();
    focaPainel();
  }
  function confirma(tipo, val) {
    if (tipo === 'schedule') {
      const hora = $('pc-p-time').value, data = $('pc-p-date').value;
      if (!hora) { aviso('Escolha a hora do envio.', false); return; }
      if (!DATA_OK.test(data)) { aviso('Escolha o dia do envio.', false); return; }
      const r = resolveAgenda(data, hora); // dia e hora no horário de São Paulo
      if (r.erro === 'passou') { aviso(data === hojeSp() ? 'Esse horário já passou hoje. Escolha uma hora mais tarde.' : 'Esse horário já passou. Escolha outro.', false); return; }
      if (r.erro) { aviso(ERRO_MOTIVO.at_longe_demais, false); return; }
      executa('schedule', { at: r.at, ...textoOpc() }, extraAgenda(data, hora), { data, hora });
    }
    if (tipo === 'snooze') { const dias = Number($('pc-p-days').value); executa('snooze', { days: dias }, ` por ${plural(dias, 'dia', 'dias')}`); }
    if (tipo === 'discard') { const motivo = $('pc-p-reason').value; executa('discard', { reason: motivo }, `: ${FU_DISCARD_REASONS.find((x) => x.key === motivo).label.toLowerCase()}`); }
    if (tipo === 'convert') executa('mark_converted', { kind: val }, `: ${val === 'surgery' ? 'cirurgia' : 'consulta'} marcada`);
  }
  function definir() {
    const aud = $('pc-def-aud').value;
    if (!aud) { aviso('Escolha a audiência.', false); return; }
    executa('set_audience', { audience: aud }, `: ${FU_AUDIENCE_LABEL[aud].toLowerCase()}`);
  }
  function cancelar() {
    const p = selecionado();
    if (p && p.schedule_id) executa('cancel_schedule', { schedule_id: p.schedule_id });
  }

  // ---------------------------------------------------------------- eventos (ligados uma vez; só agem com a página aberta)
  const noTopo = () => { if (!window.matchMedia('(min-width: 1100px)').matches) $('pc-grade').scrollIntoView({ block: 'start' }); }; // celular: escolher alguém leva ao começo da conversa dele
  const aberta = () => { const s = $('pg-pacientes'); return !!s && !s.hidden && !!S; };
  document.addEventListener('click', (e) => {
    const el = e.target.closest ? e.target.closest('#pg-pacientes [data-act]') : null;
    if (!el || !aberta()) return;
    const a = el.dataset.act, v = el.dataset.val;
    const alvo = el.dataset.id !== undefined ? S.todos[Number(el.dataset.id)] : null;
    switch (a) {
      case 'sit': ui.view = ui.view === v ? 'due_today' : v; ui.aud = ''; ui.busca = ''; ui.panel = null; desenha(); break;
      case 'pick_sit': if (alvo) { ui.view = situacao(alvo); ui.aud = ''; ui.busca = ''; ui.panel = null; seleciona(alvo.phone_key); ui.pane = 'conversa'; desenha(); noTopo(); } break;
      case 'dia_mais': ui.diasAbertos[v] = !ui.diasAbertos[v]; desenha(); break;
      case 'closed_toggle': ui.closedOpen = !ui.closedOpen; desenha(); break;
      case 'pick': if (alvo) { ui.panel = null; seleciona(alvo.phone_key); ui.pane = 'conversa'; desenha(); noTopo(); } break;
      case 'pane': ui.pane = v; desenhaTopo(); break;
      case 'cmd': comando(el.dataset.cmd); break;
      case 'ok_schedule': confirma('schedule'); break;
      case 'ok_snooze': confirma('snooze'); break;
      case 'ok_discard': confirma('discard'); break;
      case 'ok_convert': confirma('convert', v); break;
      case 'define': definir(); break;
      case 'cancel': cancelar(); break;
      case 'log_toggle': ui.logOpen = !ui.logOpen; desenhaLog(); break;
      case 'log_dl': baixaLog(); break;
      case 'log_copy': copiaLog(); break;
      case 'recarregar': location.reload(); break;
      default: break;
    }
  });
  document.addEventListener('toggle', (e) => { // o evento não sobe: só a captura pega; o redesenho do Log mantém Ferramentas como o Felipe deixou
    if (e.target && e.target.matches && e.target.matches('#pg-pacientes [data-ferramentas]')) ui.ferrOpen = e.target.open;
  }, true);
  function mudaPadrao(t) { // o controle "Envio padrão": a última escolha vale; muda só os botões, sem redesenhar (o teclado não perde o lugar)
    const campo = $('pc-padrao-hora'), dia = $('pc-padrao-data'), p = selecionado();
    if (t.dataset.padrao === 'modo' && t.value === 'agora') definePadrao({ modo: 'agora' });
    else if (HORA_OK.test(campo.value) && DATA_OK.test(dia.value)) definePadrao({ modo: 'agendar', data: dia.value, hora: campo.value });
    else if (t.dataset.padrao === 'modo') { // Agendar sem dia ou hora escolhidos: o padrão só vira agendar quando houver os dois
      const ag = padrao.modo === 'agendar';
      document.querySelectorAll('#pg-pacientes input[name="pc-padrao-modo"]').forEach((r) => { r.checked = (r.value === 'agendar') === ag; });
      (DATA_OK.test(dia.value) ? campo : dia).focus(); return;
    } else return;
    document.querySelectorAll('#pg-pacientes input[name="pc-padrao-modo"]').forEach((r) => { r.checked = r.value === padrao.modo; });
    const acoes = document.querySelector('#pg-pacientes .pc-acoes');
    if (acoes && p) { const b = fuSendBlock(p, S.fx); acoes.outerHTML = acoesHtml(p, false, b ? b[1] : null); }
  }
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!aberta() || !t.dataset) return;
    if (t.dataset.padrao) { mudaPadrao(t); return; }
    if (t.dataset.filter) {
      if (t.dataset.filter === 'view') { ui.view = t.value; if (ui.view !== 'all' && (ui.aud === 'attended' || ui.aud === 'lost')) ui.aud = ''; }
      else { ui.aud = t.value; if (ui.aud === 'attended' || ui.aud === 'lost') ui.view = 'all'; else if (ui.view === 'unsegmented') ui.view = 'due_today'; }
      ui.busca = ''; // escolher um filtro é pedir a lista dele: a busca sai
      ui.panel = null;
      desenha();
    }
  });
  document.addEventListener('input', (e) => { // a cada tecla: uma resposta que redesenha a tela no meio da digitação não apaga o texto
    const t = e.target;
    if (aberta() && t.id === 'pc-busca') { ui.busca = t.value; ui.panel = null; desenha(); return; }
    if (!aberta() || t.id !== 'pc-draft') return;
    const p = selecionado();
    if (p) rascunhos[p.phone_key] = t.value;
  });
  document.addEventListener('keydown', (e) => {
    if (!aberta() || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return; // segurar a tecla não dispara de novo: a fila anda e cairia em outro paciente
    if (e.key === 'Escape' && e.target.id === 'pc-busca' && ui.busca) { e.preventDefault(); ui.busca = ''; ui.panel = null; desenha(); return; }
    if (e.key === 'Escape' && ui.panel) { ui.panel = null; desenhaMeio(); return; }
    if (['INPUT', 'TEXTAREA', 'SELECT'].indexOf(e.target.tagName) >= 0 || document.querySelector('dialog[open]')) return;
    const cmd = { e: 'send', a: 'schedule', p: 'skip', s: 'snooze', d: 'discard', c: 'convert' }[e.key.toLowerCase()];
    if (!cmd) return;
    const b = document.querySelector(`#pg-pacientes [data-cmd="${cmd}"]`);
    if (b && !b.disabled) { e.preventDefault(); comando(cmd); }
  });

  // ---------------------------------------------------------------- carregando: texto com a hora de início; passou de 10 s, avisa que o BigQuery está lento
  const LENTO_MS = 10000;
  let carr = null, timerLento = null; // carr: { hora, lento } enquanto a primeira leitura não volta
  const carrTxt = () => (carr.lento ? 'Ainda carregando, o BigQuery está lento. Pode levar mais um pouco.' : `Carregando os pacientes... desde ${carr.hora}.`);
  function paraCarregando() {
    clearTimeout(timerLento);
    carr = null;
  }
  function carregandoHtml(ctx) {
    if (!carr) {
      carr = { hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }), lento: false };
      timerLento = setTimeout(() => {
        if (!carr) return;
        carr.lento = true;
        const t = document.querySelector('#pg-pacientes [data-estado="carregando"] .pc-carr-t');
        if (t) t.textContent = carrTxt();
      }, LENTO_MS);
    }
    return `<div data-estado="carregando" role="status"><p class="pc-carr-t">${carrTxt()}</p>${ctx.esqueleto}</div>`;
  }
  // ?view=unsegmented (o Hoje manda): abre a lista já nessa situação, uma vez por valor
  function viewDaUrl() {
    const v = new URLSearchParams(location.search).get('view');
    if (!v || v === ui.viewUrl || !SIT[v]) return;
    ui.viewUrl = v; ui.view = v; ui.aud = ''; ui.busca = ''; ui.sel = null;
  }

  // ---------------------------------------------------------------- entrada
  // entrada: null = carregando; false = falhou (o painel já mostra o erro); { linhas, estado } = pronto (estado null = ações desligadas)
  function render(entrada, ctx) {
    if (ui.tenant !== ctx.tenant) { // outro cliente: lista, seleção e conversas começam do zero
      ui.tenant = ctx.tenant; carregaPadrao(ctx.tenant, ctx.hoje); ui.sel = null; ui.panel = null; ui.busca = ''; ui.pendente = null; registro = []; travaAte = 0;
      [conversas, rascunhos, emCurso, resultados, enviadosAgora].forEach((m) => Object.keys(m).forEach((k) => delete m[k]));
    }
    if (!entrada) {
      S = null;
      for (const id of ['pc-lista', 'pc-meio', 'pc-dir', 'pc-contador', 'pc-nav-m', 'pc-logbar', 'pc-cob']) if ($(id)) $(id).innerHTML = '';
      if (entrada === null) $('pc-lista').innerHTML = carregandoHtml(ctx); else paraCarregando();
      return;
    }
    paraCarregando();
    viewDaUrl();
    S = monta(entrada, ctx);
    if (!S.todos.length) {
      S = null;
      for (const id of ['pc-meio', 'pc-dir', 'pc-contador', 'pc-nav-m', 'pc-logbar', 'pc-cob']) if ($(id)) $(id).innerHTML = '';
      $('pc-lista').innerHTML = '<p class="pc-vazio-lista">Nenhum paciente em acompanhamento para este cliente.</p>';
      return;
    }
    desenha();
  }

  window.PainelPacientes = { render };
})();
