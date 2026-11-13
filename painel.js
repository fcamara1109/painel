// Painel de funil por cliente (tenant). Consulta o BigQuery ao vivo com o login Google de quem abre a página.
// Todas as contas ficam nos .sql; aqui só se consulta, converte e formata.
(function () {
  'use strict';

  const CFG = window.PAINEL_CONFIG;
  const FIXTURE = new URLSearchParams(location.search).get('fixture') === '1';
  const SCOPE = 'https://www.googleapis.com/auth/bigquery.readonly email'; // email: o servidor do check-in confere quem clicou
  const TOKEN_KEY = 'painel_token';
  const RENOVA_ANTES_MS = 5 * 60 * 1000; // tenta renovar o token 5 min antes de vencer
  const PAGE_SIZE = 25;
  const BQ = `https://bigquery.googleapis.com/bigquery/v2/projects/${CFG.PROJECT_ID}`;

  // [chave, rótulo, texto de "sem escolha"]
  const FILTROS = [
    ['attribution', 'Atribuição', 'Todas'],
    ['procedure', 'Procedimento', 'Todos'],
    ['location', 'Local', 'Todos'],
    ['modality', 'Modalidade', 'Todas'],
    ['event_type', 'Tipo de evento', 'Todos'],
    ['campaign', 'Campanha', 'Todas'],
    ['ad_group', 'Grupo', 'Todos'],
  ];
  // Estes quatro não se aplicam ao gasto (ver sql/funnel.sql).
  const FILTROS_SEM_CUSTO = ['procedure', 'location', 'modality', 'event_type'];

  // Canais de aquisição são DADO, não código: 'all' é o painel inteiro e o SQL devolve uma visão por canal que existe nos dados
  // (coluna channel: google_ads, meta_ads, doctoralia...) e, numa seleção parcial de canais, a visão 'selected'. Canal novo (outra plataforma de mídia, outro custo fixo) aparece sozinho.
  // O texto na tela vem do id: google_ads vira "Google Ads".
  function rotuloCanal(id) {
    if (id === 'all' || id === 'selected') return 'Total';
    return String(id).split('_').map((w) => (w === 'ads' ? 'Ads' : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
  }

  const FIXTURE_PERIODO = ['2026-09-01', '2026-09-30'];
  const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const MESES_POR_EXTENSO = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

  // Tabela única do detalhe, uma aba por vez. Coluna: [campo, título, formato, nota "sem valor"]
  const ABAS = {
    custo: [['cpm', 'CPM', 'money'], ['cpc', 'CPC', 'money'], ['cpl', 'CPL', 'money'], ['cpa', 'CPA', 'money'], ['cpr', 'CPR', 'money'], ['roas_honorario', 'ROAS honorário', 'x']],
    conv: [['ctr', 'CTR', 'pct'], ['click_to_lead', 'Clique para lead', 'pct'], ['lead_to_marked', 'Lead para marcação', 'pct'], ['marked_to_completed', 'Marcação para realizado', 'pct'], ['completed_to_upsell', 'Realizado para upsell', 'pct'], ['avg_ticket', 'Ticket médio', 'money', true], ['avg_fee', 'Honorário médio', 'money', true]],
    vol: [['spend', 'Investimento', 'money'], ['impressions', 'Impressões', 'int'], ['clicks', 'Cliques', 'int'], ['leads', 'Leads', 'int'], ['marked_patients', 'Marcações', 'int'], ['scheduled_patients', 'Agendamentos', 'int'], ['completed_patients', 'Realizados', 'int'], ['billed_amount', 'Faturado', 'money'], ['physician_fee', 'Honorário', 'money']],
  };
  const GRAO_TXT = { day: 'dia', week: 'semana', month: 'mês' };

  // Etapas do funil, na ordem. Tudo vem pronto do funnel.sql (taxa, % dos leads, variação); aqui só se escolhe o campo.
  // volume e variação: campo e campo_chg; "% dos leads": parte. O custo por etapa não fica no cartão: está no detalhe por período.
  const ETAPAS = [
    { campo: 'leads', rotulo: 'Leads', parte: 'leads_of_leads' },
    { campo: 'marked_patients', rotulo: 'Marcações', parte: 'marked_of_leads' },
    { campo: 'scheduled_patients', rotulo: 'Agendamentos', parte: 'scheduled_of_leads' },
    { campo: 'completed_patients', rotulo: 'Realizados', parte: 'completed_of_leads' },
  ];
  // Taxas de passagem entre uma etapa e a seguinte: campo da taxa (prev_ e _pp vêm do SQL).
  const PASSAGENS = ['lead_to_marked', 'marked_to_scheduled', 'scheduled_to_completed'];
  // Resumo (4 números): [campo, rótulo, formato, unidade, quando "sobe" é bom]. null = neutro (gastar mais não é bom nem ruim).
  // O "antes" sai do campo_chg do funnel.sql: antes = atual / (1 + variação).
  const FAIXA = [['spend', 'Gasto', 'money', '', null], ['cpa', 'CPA (por marcação)', 'money', '', false], ['roas_honorario', 'ROAS do honorário', 'ratio', 'x', true], ['physician_fee', 'Honorário', 'money', '', true]];
  const FAIXA_DE_MIDIA = ['spend', 'cpa', 'roas_honorario'];
  // Bloco "Por canal": [campo, título, formato]. A linha de cada canal é a linha 'total' dele no funnel.sql.
  const COLS_CANAIS = [['spend', 'Gasto', 'money'], ['scheduled_patients', 'Agendamentos', 'int'], ['completed_patients', 'Consultas', 'int'], ['physician_fee', 'Honorário', 'money'], ['cost_per_scheduled', 'Custo por agendamento', 'money'], ['roas_honorario', 'ROAS', 'x']];

  const TIPO_MARCACAO = { scheduled: 'Agendamento', referral: 'Encaminhamento' };
  const LISTAS = {
    completed: {
      bloco: 'bloco-realizados', sql: 'completed',
      cols: [['metric_date', 'Data', 'date'], ['channel', 'Canal', 'canal'], ['patient_name', 'Paciente', 'txt'], ['procedure_name', 'Procedimento', 'txt'], ['location', 'Local', 'txt'], ['modality', 'Modalidade', 'txt'], ['payer', 'Convênio', 'txt'], ['attribution', 'Atribuição', 'txt'], ['lead_campaign', 'Campanha', 'txt'], ['lead_ad_group', 'Grupo', 'txt'], ['billed_amount', 'Faturado', 'money'], ['physician_fee', 'Honorário', 'money']],
    },
    marked: {
      bloco: 'bloco-marcacoes', sql: 'marked',
      cols: [['metric_date', 'Data', 'date'], ['channel', 'Canal', 'canal'], ['marking_type', 'Tipo', 'tipo'], ['patient_name', 'Paciente', 'txt'], ['procedure_name', 'Procedimento', 'txt'], ['location', 'Local', 'txt'], ['modality', 'Modalidade', 'txt'], ['payer', 'Convênio', 'txt'], ['attribution', 'Atribuição', 'txt'], ['lead_campaign', 'Campanha', 'txt'], ['lead_ad_group', 'Grupo', 'txt'], ['source', 'Origem', 'txt'], ['referred_to', 'Encaminhado para', 'txt'], ['reason', 'Motivo', 'txt']],
    },
  };

  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------ formatação
  const nf = (casas) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
  const NF0 = nf(0), NF1 = nf(1), NF2 = nf(2);
  const VAZIO = '-';

  function fmt(valor, tipo) {
    if (valor === null || valor === undefined || valor === '') return VAZIO;
    switch (tipo) {
      case 'money': return 'R$ ' + NF2.format(valor);
      case 'pct': return NF1.format(valor * 100) + '%';
      case 'ratio': return NF2.format(valor);
      case 'x': return NF2.format(valor) + 'x';
      case 'canal': return rotuloCanal(valor);
      case 'int': return NF0.format(valor);
      case 'date': return fmtData(valor);
      case 'tipo': return TIPO_MARCACAO[valor] || valor;
      default: return String(valor);
    }
  }

  function fmtData(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? `${m[3]}/${m[2]}/${m[1]}` : VAZIO;
  }

  function rotuloPeriodo(period, grao) {
    if (period === 'total') return 'Total';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(period);
    if (!m) return period;
    if (grao === 'month') return `${MESES[Number(m[2]) - 1]}/${m[1]}`;
    if (grao === 'week') return `Semana de ${m[3]}/${m[2]}/${m[1]}`;
    return `${m[3]}/${m[2]}/${m[1]}`;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const isoLocal = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  const hojeIso = () => isoLocal(new Date());

  // Período: lógica pura do seletor (opção A, painel tipo Looker; réplica de prototipos/seletor_data.html). Datas sem fuso, por componentes via UTC.
  const PER = (() => {
    const pad = (n) => String(n).padStart(2, '0');
    const partes = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
    const monta = (a, m, d) => { const t = new Date(Date.UTC(a, m - 1, d)); return `${String(t.getUTCFullYear()).padStart(4, '0')}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
    const emMs = (iso) => { const [a, m, d] = partes(iso); return Date.UTC(a, m - 1, d); };
    const somaDias = (iso, n) => { const [a, m, d] = partes(iso); return monta(a, m, d + n); };
    const dias = (a, b) => Math.round((emMs(b) - emMs(a)) / 86400000);
    const ultimoDia = (a, m) => new Date(Date.UTC(a, m, 0)).getUTCDate();
    // DATE_SUB/DATE_ADD de meses do BigQuery: limita ao último dia do mês quando preciso.
    const somaMeses = (iso, n) => {
      const [a, m, d] = partes(iso);
      const t = a * 12 + (m - 1) + n;
      const na = Math.floor(t / 12);
      const nm = t - na * 12 + 1;
      return monta(na, nm, Math.min(d, ultimoDia(na, nm)));
    };
    const mesesEntre = (s, e) => { const [as, ms] = partes(s); const [ae, me] = partes(e); return (ae - as) * 12 + me - ms; }; // DATE_DIFF(e, s, MONTH)
    const primeiroDoMes = (iso) => { const [a, m] = partes(iso); return monta(a, m, 1); };
    const segunda = (iso) => somaDias(iso, -((new Date(emMs(iso)).getUTCDay() + 6) % 7));

    // Espelha prev_window de sql/_prelude.sql (3 regras). Se o SQL mudar, esta função muda junto; o test_painel_sql.py prova as duas contra o BigQuery.
    const prevWindow = (s, e) => {
      const k = mesesEntre(s, e) + 1;
      const [ea, em, ed] = partes(e);
      if (partes(s)[2] === 1 && ed === ultimoDia(ea, em)) return { start: somaMeses(s, -k), end: somaDias(s, -1) };
      if (partes(s)[2] === 1) return { start: somaMeses(s, -k), end: somaMeses(e, -k) };
      return { start: somaDias(s, -(dias(s, e) + 1)), end: somaDias(s, -1) };
    };

    // Sem atalho de dias e sem "Ano passado": a operação começou em 2026. "Todo o período" começa no primeiro dado do cliente (tenants.sql, first_date).
    const ATALHOS = [
      { id: 'esta-semana', grupo: 'Semanas', nome: 'Esta semana', calc: (h) => ({ start: segunda(h), end: h }) },
      { id: 'semana-passada', grupo: 'Semanas', nome: 'Semana passada', calc: (h) => ({ start: somaDias(segunda(h), -7), end: somaDias(segunda(h), -1) }) },
      { id: 'quatro-semanas', grupo: 'Semanas', nome: '4 semanas + a atual', calc: (h) => ({ start: somaDias(segunda(h), -28), end: h }) },
      { id: 'este-mes', grupo: 'Meses', nome: 'Este mês', calc: (h) => ({ start: primeiroDoMes(h), end: h }) },
      { id: 'mes-passado', grupo: 'Meses', nome: 'Mês passado', calc: (h) => ({ start: somaMeses(primeiroDoMes(h), -1), end: somaDias(primeiroDoMes(h), -1) }) },
      { id: 'tres-meses', grupo: 'Meses', nome: '3 meses + o atual', calc: (h) => ({ start: somaMeses(primeiroDoMes(h), -3), end: h }) },
      { id: 'este-ano', grupo: 'Longo prazo', nome: 'Este ano', calc: (h) => ({ start: monta(partes(h)[0], 1, 1), end: h }) },
      { id: 'todo', grupo: 'Longo prazo', nome: 'Todo o período', calc: (h, primeiro) => (primeiro ? { start: primeiro, end: h, todo: true } : null) },
    ];
    const GRUPOS = ['Semanas', 'Meses', 'Longo prazo'];
    const calcAtalho = (id, h, primeiro) => ATALHOS.find((a) => a.id === id).calc(h, primeiro);
    const atalhoAtivo = (sel, h, primeiro) => {
      const a = ATALHOS.find((x) => { const r = x.calc(h, primeiro); return r && r.start === sel.start && r.end === sel.end && !!r.todo === !!sel.todo; });
      return a ? a.id : null;
    };
    // Texto do rodapé do painel. Janela anterior que termina antes do primeiro dado do cliente não tem o que comparar.
    const comparaCom = (sel, primeiro) => {
      const p = prevWindow(sel.start, sel.end);
      if (primeiro && p.end < primeiro) return 'Sem período anterior para comparar';
      const ano = partes(sel.end)[0];
      const mesmo = partes(p.start)[0] === ano && partes(p.end)[0] === ano;
      const dm = (iso) => fmtData(iso).slice(0, 5);
      return `Compara com ${mesmo ? `${dm(p.start)} a ${dm(p.end)}` : `${fmtData(p.start)} a ${fmtData(p.end)}`}`;
    };
    const parseBR = (v) => {
      const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v || '');
      if (!m) return null;
      const a = Number(m[3]), mm = Number(m[2]), d = Number(m[1]);
      if (a < 1900 || a > 2100 || mm < 1 || mm > 12 || d < 1) return null;
      const iso = monta(a, mm, d);
      const p = partes(iso);
      return p[0] === a && p[1] === mm && p[2] === d ? iso : null;
    };
    return { partes, monta, somaDias, somaMeses, ultimoDia, primeiroDoMes, ATALHOS, GRUPOS, calcAtalho, atalhoAtivo, comparaCom, parseBR };
  })();

  // Padrão: 4 semanas fechadas + a atual, da segunda de 4 semanas atrás até hoje (quinta 05/11: 05/10 a 05/11; domingo 08/11: 05/10 a 08/11; segunda 09/11: 12/10 a 09/11).
  // O fixture é congelado: período fixo, para os rótulos das linhas do tempo baterem com o subtítulo.
  function periodoPadrao() {
    if (FIXTURE) return FIXTURE_PERIODO;
    const p = PER.calcAtalho('quatro-semanas', hojeIso());
    return [p.start, p.end];
  }

  // Topo em dois andares (redesign, 13/11/2026): GLOBAIS no andar de cima, sempre iguais; LOCAIS só dentro de um cliente (seletor + Funil | Cirurgias | Pacientes).
  // Sem ?pagina abre o Hoje.
  const GLOBAIS = { hoje: 'Hoje', clientes: 'Clientes', setup: 'Setup', atividades: 'Atividades', onboarding: 'Onboarding' };
  const LOCAIS = { funil: 'Funil', cirurgias: 'Cirurgias', pacientes: 'Pacientes' };
  function paginaDaUrl() {
    const p = new URLSearchParams(location.search).get('pagina');
    return GLOBAIS[p] || LOCAIS[p] ? p : 'hoje';
  }

  // ------------------------------------------------------------ estado
  const state = {
    tenant: new URLSearchParams(location.search).get('tenant') || CFG.TENANT,
    pagina: paginaDaUrl(),
    cirurgias: [], // linhas do surgeries.sql (último snapshot do radar)
    tenants: null, // [{tenant, n, spend_rows, first_date}] do tenants.sql, carregado uma vez
    basis: 'event',
    canal: [], // ids dos canais marcados no filtro Canal (vazio = Todos): escolhe a visão do funnel.sql (ver visaoDoCanal)
    aba: 'custo',
    start: periodoPadrao()[0],
    end: periodoPadrao()[1],
    todo: false, // atalho "Todo o período" ligado: o início é o primeiro dado do cliente e acompanha a troca de cliente
    grain: 'week',
    filters: Object.fromEntries(FILTROS.map(([k]) => [k, []])),
    options: {},
    funnel: [],
    canais: [], // linhas do funnel.sql em todos os canais (e na visão 'all')
    mensal: null, // funnel_month.sql do cliente: {tenant, rows} | {tenant, carregando} | {tenant, erro}; independe de canal, período e filtros
    modo: 'roas', // terceiro número do ritmo e linha do histórico: 'roas' | 'cac'
    meses: 6, // quantos meses o histórico mostra (3, 6 ou 12)
    mesSel: null, // mês lido no histórico (null = o último)
    tabHist: false, // tabela "Ver os números" aberta
    lists: { completed: { rows: [], page: 0 }, marked: { rows: [], page: 0 } },
  };
  let seq = 0;
  let canaisConsultados = null; // @channels da última consulta do funil: a seleção parcial só consulta de novo quando muda
  let token = null;
  let tokenClient = null;
  let modoPedido = null; // por que o último requestAccessToken saiu: 'clique' | 'silencioso' | 'renovacao'
  let timerRenova = null;
  const sqlCache = {};
  const MARCADOR_CANAL = /^-- @event_channel$/m; // linha-marcador das consultas que usam a CTE event_channel (sql/_channel.sql)
  if (FIXTURE) window.__consultas = [];

  // ------------------------------------------------------------ login (Google Identity Services)
  class AuthError extends Error {}

  // O token fica no localStorage: sobrevive a fechar a aba e o navegador (no sessionStorage morria junto com a aba).
  // Vencido ele continua lá: é o sinal de que este navegador já entrou, e a abertura tenta renovar sem clique.
  function lerRegistro() {
    try {
      const t = JSON.parse(localStorage.getItem(TOKEN_KEY));
      if (t && t.value && Number.isFinite(t.exp)) return t;
    } catch (e) { /* sem localStorage: segue sem token */ }
    return null;
  }

  function lerToken() {
    const t = lerRegistro();
    return t && t.exp > Date.now() + 30000 ? t : null;
  }

  function guardaToken(t) {
    token = t;
    try { localStorage.setItem(TOKEN_KEY, JSON.stringify(t)); } catch (e) { /* ok */ }
    agendaRenovacao();
  }

  // Com várias contas Google no navegador, o seletor abria a cada renovação. Guardado o e-mail da conta que entrou,
  // o pedido seguinte leva login_hint e o Google renova sem perguntar. Falhou ao descobrir: segue sem e-mail, o login não depende dele.
  function emailConhecido() {
    return (token || lerRegistro() || {}).email; // vencido também vale: o registro fica no localStorage
  }

  async function descobreEmail(valor) {
    try {
      const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${valor}` } });
      if (!r.ok) return;
      const { email } = await r.json();
      if (email && token && token.value === valor) guardaToken({ ...token, email });
    } catch (e) { /* sem e-mail: a renovação volta a abrir o seletor de contas */ }
  }

  function limpaToken() {
    token = null;
    clearTimeout(timerRenova);
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ok */ }
  }

  // Renova sem clique um pouco antes de vencer. Falhou (popup barrado, sessão Google fora): não mexe na tela,
  // quando o token vencer a próxima consulta mostra o botão de entrar.
  function agendaRenovacao() {
    clearTimeout(timerRenova);
    if (!token || FIXTURE) return;
    timerRenova = setTimeout(() => pedeToken('renovacao'), Math.max(token.exp - RENOVA_ANTES_MS - Date.now(), 0));
  }

  function mostraLogin(msg) {
    $('painel').hidden = true;
    $('login').hidden = false;
    $('btn-sair').hidden = true;
    document.body.classList.add('sem-login');
    $('estado-login').textContent = 'Sem login';
    $('login-msg').textContent = msg || 'Entre com a conta Google que tem acesso ao BigQuery.';
  }

  function mostraPainel() {
    $('login').hidden = true;
    $('painel').hidden = false;
    $('btn-sair').hidden = false;
    document.body.classList.remove('sem-login');
    $('estado-login').textContent = 'Login ativo';
  }

  function carregaGIS() {
    return new Promise((resolve, reject) => {
      if (window.google && window.google.accounts) return resolve();
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Não consegui carregar o login do Google.'));
      document.head.appendChild(s);
    });
  }

  // O pedido falhou. Renovação em segundo plano não mexe na tela; a abertura silenciosa volta ao botão sem alarme.
  function pedidoFalhou() {
    if (modoPedido === 'renovacao') return;
    mostraLogin(modoPedido === 'silencioso' ? undefined : 'Login não concluído. Tente de novo.');
  }

  // modo: sem modo só prepara o cliente do Google; com modo já pede o token em seguida.
  async function iniciaLogin(modo) {
    if (CFG.CLIENT_ID === 'PREENCHER') {
      if (!token) mostraLogin('Falta configurar o CLIENT_ID em config.js.');
      return;
    }
    try {
      await carregaGIS();
    } catch (e) {
      if (!token) mostraLogin(e.message);
      return;
    }
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CFG.CLIENT_ID,
        scope: SCOPE,
        callback: (resp) => {
          if (resp.error || !resp.access_token) {
            pedidoFalhou();
            return;
          }
          const jaNoPainel = !$('painel').hidden;
          // renovação mantém o e-mail se a descoberta falhar; o clique pode ser outra conta, então só vale o que o userinfo disser
          const email = modoPedido === 'clique' ? undefined : emailConhecido();
          guardaToken({ value: resp.access_token, exp: Date.now() + Number(resp.expires_in || 3600) * 1000, ...(email && { email }) });
          descobreEmail(resp.access_token);
          mostraPainel();
          if (!jaNoPainel) recarrega(true);
        },
        error_callback: pedidoFalhou,
      });
    }
    if (modo) pedeToken(modo);
  }

  function pedeToken(modo) {
    if (!tokenClient) { iniciaLogin(modo); return; }
    modoPedido = modo;
    const email = emailConhecido();
    tokenClient.requestAccessToken(email ? { prompt: '', login_hint: email } : { prompt: '' });
  }

  function pedeLogin() {
    if (FIXTURE) { mostraPainel(); recarrega(true); return; }
    pedeToken('clique');
  }

  // ------------------------------------------------------------ BigQuery (REST)
  function param(nome, valor) {
    if (Array.isArray(valor)) {
      return { name: nome, parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } }, parameterValue: { arrayValues: valor.map((v) => ({ value: v })) } };
    }
    const tipo = nome === 'start_date' || nome === 'end_date' ? 'DATE' : 'STRING';
    return { name: nome, parameterType: { type: tipo }, parameterValue: { value: valor } };
  }

  function converte(valor, tipo) {
    if (valor === null || valor === undefined) return null;
    switch (tipo) {
      case 'INTEGER': case 'INT64': return Number(valor);
      case 'FLOAT': case 'FLOAT64': case 'NUMERIC': case 'BIGNUMERIC': return Number(valor);
      case 'BOOLEAN': case 'BOOL': return valor === 'true' || valor === true;
      default: return valor; // DATE ('YYYY-MM-DD') e STRING ficam como texto
    }
  }

  function linhasDoResultado(resp, linhas) {
    const campos = resp.schema.fields.map((f) => [f.name, f.type]);
    return linhas.map((l) => Object.fromEntries(campos.map(([nome, tipo], i) => [nome, converte(l.f[i].v, tipo)])));
  }

  async function bqFetch(url, opts) {
    if (!token || token.exp <= Date.now() + 30000) {
      token = null; // o registro vencido fica no storage: a próxima abertura tenta renovar sem clique
      mostraLogin('Sua sessão expirou. Entre de novo.');
      throw new AuthError();
    }
    const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/json' } });
    if (r.status === 401) {
      limpaToken();
      mostraLogin('Sua sessão expirou. Entre de novo.');
      throw new AuthError();
    }
    if (!r.ok) {
      let detalhe = '';
      try { detalhe = (await r.json()).error.message; } catch (e) { detalhe = r.statusText; }
      throw new Error(`BigQuery ${r.status}: ${detalhe}`);
    }
    return r.json();
  }

  // Check-in pela Júlia. O servidor confere o token (app do painel, e-mail na lista do cliente) e a trava de 1 por dia.
  // Devolve 'enviado' | 'ja_enviado_hoje' | 'sem_whatsapp' | 'sem_permissao' | 'falha' | 'sem_login' (token vencido ou recusado: já voltou pro login).
  async function enviaCheckin(telefone, nome) {
    if (!token || token.exp <= Date.now() + 30000) {
      token = null;
      mostraLogin('Sua sessão expirou. Entre de novo.');
      return 'sem_login';
    }
    let r;
    try {
      r = await fetch(CFG.CHECKIN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tenant: state.tenant, phone: telefone, name: nome, access_token: token.value }) });
    } catch (e) {
      return 'falha';
    }
    if (r.status === 401) {
      limpaToken();
      mostraLogin('Entre de novo para liberar o envio do check-in.');
      return 'sem_login';
    }
    if (r.status === 403) return 'sem_permissao';
    let corpo = {};
    try { corpo = await r.json(); } catch (e) { /* resposta sem corpo: falha */ }
    if (r.ok && (corpo.status === 'enviado' || corpo.status === 'ja_enviado_hoje')) return corpo.status;
    return corpo.motivo === 'sem_whatsapp' ? 'sem_whatsapp' : 'falha';
  }

  // Grava eventos do quadro de setup (webhook setup-anotar). O servidor confere o token (app do painel, e-mail do Felipe) e só responde
  // 'ok' depois de gravar no BigQuery. Devolve 'ok' | 'sem_permissao' | 'falha' | 'sem_login' (token vencido ou recusado: já voltou pro login).
  async function anotaSetup(eventos) {
    if (!token || token.exp <= Date.now() + 30000) {
      token = null;
      mostraLogin('Sua sessão expirou. Entre de novo.');
      return 'sem_login';
    }
    let r;
    try {
      r = await fetch(CFG.SETUP_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access_token: token.value, events: eventos }) });
    } catch (e) {
      return 'falha';
    }
    if (r.status === 401) {
      limpaToken();
      mostraLogin('Entre de novo para gravar no quadro.');
      return 'sem_login';
    }
    if (r.status === 403) return 'sem_permissao';
    let corpo = {};
    try { corpo = await r.json(); } catch (e) { /* resposta sem corpo: falha */ }
    return r.ok && corpo.status === 'ok' ? 'ok' : 'falha';
  }

  async function textoSql(nome) {
    if (!sqlCache[nome]) {
      sqlCache[nome] = fetch(`sql/${nome}.sql?v=${CFG.VERSION}`).then((r) => {
        if (!r.ok) throw new Error(`Não achei sql/${nome}.sql`);
        return r.text();
      });
    }
    return sqlCache[nome];
  }

  async function bqQuery(nome, params) {
    const [prelude, bruto] = await Promise.all([textoSql('_prelude'), textoSql(nome)]);
    // O canal de cada evento é uma regra só (sql/_channel.sql), uma CTE: entra no WITH de toda consulta que tem a linha-marcador.
    // Só leitura: o login do navegador é bigquery.readonly, então nada de CREATE TEMP TABLE (só TEMP FUNCTION, no prelude).
    let sql = bruto;
    if (MARCADOR_CANAL.test(bruto)) {
      const canal = await textoSql('_channel');
      sql = bruto.replace(MARCADOR_CANAL, () => `${canal.trim()},`);
    }
    const nomeados = Object.entries(params).map(([k, v]) => param(k, v));
    const corpo = {
      query: `${prelude}\n${sql}`,
      useLegacySql: false,
      ...(nomeados.length ? { parameterMode: 'NAMED', queryParameters: nomeados } : {}),
      location: CFG.LOCATION,
      maximumBytesBilled: String(2 * 1024 ** 3),
      timeoutMs: 60000,
    };
    let resp = await bqFetch(`${BQ}/queries`, { method: 'POST', body: JSON.stringify(corpo) });
    const ref = resp.jobReference;
    const get = (extra) => {
      const q = new URLSearchParams({ location: ref.location || CFG.LOCATION, ...extra });
      return bqFetch(`${BQ}/queries/${ref.jobId}?${q}`);
    };
    while (!resp.jobComplete) {
      await new Promise((ok) => setTimeout(ok, 1000));
      resp = await get({ timeoutMs: '30000' });
    }
    // Consulta com função temporária é script: o resultado pode vir vazio no POST.
    if (!resp.schema) resp = await get({});
    let linhas = resp.rows || [];
    let pageToken = resp.pageToken;
    while (pageToken) {
      const p = await get({ pageToken });
      linhas = linhas.concat(p.rows || []);
      pageToken = p.pageToken;
    }
    return linhasDoResultado(resp, linhas);
  }

  async function fixtureBruto(nome) {
    const r = await fetch(`fixtures/${nome}.json?v=${CFG.VERSION}`);
    if (!r.ok) throw new Error(`Não achei fixtures/${nome}.json`);
    return r.json();
  }

  async function fixture(nome) {
    const resp = await fixtureBruto(nome);
    return linhasDoResultado(resp, resp.rows || []);
  }

  // Barra de carregamento: contador de consultas em andamento, não booleano. Só some quando a última termina,
  // com sucesso ou erro (inclusive consulta que ficou para trás depois de um erro das outras).
  let pendentes = 0;
  function emConsulta(delta) {
    pendentes += delta;
    $('barra-carga').hidden = pendentes <= 0;
  }

  async function consulta(nome, params) {
    emConsulta(1);
    try {
      if (FIXTURE) {
        window.__consultas.push({ nome, params: JSON.parse(JSON.stringify(params)) });
        // Pacientes e mensagens são listas simples (fixtures/README_pacientes.md), não o formato do BigQuery; as mensagens são só as do telefone pedido.
        if (nome === 'patients' || nome === 'patients_all') return await fixtureBruto(nome);
        if (nome === 'messages') return (await fixtureBruto('messages')).filter((m) => m.phone_key === params.phone_key).sort((a, b) => (a.sent_at || '').localeCompare(b.sent_at || '') || a.seq - b.seq);
        return await fixture(['completed', 'marked', 'options', 'tenants', 'surgeries', 'surgeries_all', 'setup_board', 'setup_events', 'onboarding_map', 'activities', 'funnel_month'].includes(nome) ? nome : 'funnel');
      }
      return await bqQuery(nome, params);
    } finally {
      emConsulta(-1);
    }
  }

  // Mesmos parâmetros em todas as consultas; os 7 arrays e os canais da seleção parcial (@channels) vão sempre, mesmo vazios. O custo fixo não vai aqui: vem do BigQuery (evento fixed_cost).
  function parametros() {
    return { tenant: state.tenant, start_date: state.start, end_date: state.end, grain: state.grain, basis: state.basis, channels: canaisParaSql(), ...state.filters };
  }

  // ------------------------------------------------------------ tela
  function mostraErro(msg) {
    const e = $('erro');
    e.textContent = msg || '';
    e.hidden = !msg;
  }

  function semMidia() {
    const t = (state.tenants || []).find((x) => x.tenant === state.tenant);
    return !!t && t.spend_rows === 0;
  }

  function atualizaAvisos() {
    const semCusto = FILTROS_SEM_CUSTO.some((k) => state.filters[k].length > 0);
    $('aviso-custo').hidden = !semCusto;
    $('aviso-midia').hidden = !semMidia();
  }

  // ------------------------------------------------------------ cliente (tenant)
  function rotuloCliente(t) {
    const s = t.replace(/_/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function renderSeletor() {
    const nomes = state.tenants ? state.tenants.map((t) => t.tenant) : [];
    if (!nomes.includes(state.tenant)) nomes.unshift(state.tenant);
    const sel = $('c-tenant');
    sel.innerHTML = nomes.map((t) => `<option value="${esc(t)}">${esc(rotuloCliente(t))}</option>`).join('');
    sel.value = state.tenant;
    sel.disabled = !state.tenants;
  }

  function guardaTenantNaUrl() {
    const q = new URLSearchParams(location.search);
    q.set('tenant', state.tenant);
    try { history.replaceState(null, '', `${location.pathname}?${q}`); } catch (e) { /* ok */ }
  }

  async function carregaClientes() {
    state.tenants = await consulta('tenants', {});
    const nomes = state.tenants.map((t) => t.tenant);
    if (nomes.length && !nomes.includes(state.tenant)) {
      state.tenant = nomes.includes(CFG.TENANT) ? CFG.TENANT : nomes[0];
      guardaTenantNaUrl();
    }
    renderSeletor();
    atualizaAvisos();
    if (state.mensal && state.mensal.rows) renderMensal(); // "sem dado de mídia" depende de tenants.spend_rows
  }

  function celula(valor, tipo, campo, extra) {
    return `<td data-col="${campo}"><span class="v">${esc(fmt(valor, tipo))}</span>${extra || ''}</td>`;
  }

  // ------------------------------------------------------------ funil (etapas, taxas, faixa)
  const totalFunil = () => state.funnel.find((r) => r.period === 'total') || null;
  const periodosFunil = () => state.funnel.filter((r) => r.period !== 'total');

  // Seta própria (traço 1,5px, ponta arredondada, cor do texto): a direção está no desenho e no sinal, não só na cor.
  const seta = (sobe) => `<svg class="vs" data-dir="${sobe ? 'up' : 'down'}" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="${sobe ? 'M6 10V2.5M2.8 5.5L6 2.3l3.2 3.2' : 'M6 2v7.5M2.8 6.5L6 9.7l3.2-3.2'}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  // Variação com seta e sinal; a cor só reforça. bomSobe: true = subir é bom, false = subir é pior (custo), null = neutro.
  // Cor inverte para custo, o sinal nunca. Sem base (null do SQL) nunca vira número.
  function variacao(frac, bomSobe, unidade) {
    if (frac === null || frac === undefined) return '<span class="sem-base">sem base</span>';
    const pontos = unidade === 'pp';
    const mag = Math.round(Math.abs(pontos ? frac : frac * 100) * 10) / 10;
    const txt = NF1.format(mag) + (pontos ? ' pp' : '%');
    if (mag === 0) return `<strong class="dlt neu">${txt}</strong>`;
    const sobe = frac > 0;
    const cor = bomSobe === null ? 'neu' : (sobe === bomSobe ? 'ok' : 'ruim');
    return `<strong class="dlt ${cor}">${seta(sobe)}${sobe ? '+' : '-'}${txt}</strong>`;
  }

  // Variação com o rótulo "contra o anterior"; sem base, só o aviso.
  const contraAnterior = (frac, bomSobe, unidade) => variacao(frac, bomSobe, unidade) + (frac === null || frac === undefined ? '' : ' <span class="peq">contra o anterior</span>');

  const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
  const dataDeISO = (iso) => { const m = ISO.exec(iso); return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])); };

  const SETA = '<svg class="seta" width="56" height="14" viewBox="0 0 56 14" aria-hidden="true"><path d="M2 7h50M46 2l6 5-6 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ESQ_NUM = '<span class="esq esq-numero"></span>';

  // Valor do período anterior a partir da variação relativa do SQL (antes = atual / (1 + variação)); sem base devolve null.
  const valorAntes = (valor, chg) => (valor === null || valor === undefined || chg === null || chg === undefined || 1 + chg === 0 ? null : valor / (1 + chg));

  // Cartão da etapa: volume, variação, barra proporcional à maior etapa e marca do período anterior. Sem custo (está no detalhe).
  function passoHtml(e, total, esperando, maior) {
    if (esperando) {
      return `<div class="passo" data-card="${e.campo}"><p class="fc-rotulo">${esc(e.rotulo)}</p><p class="num vol" aria-hidden="true">${ESQ_NUM}</p></div>`;
    }
    const vol = total ? total[e.campo] : null;
    const chg = total ? total[`${e.campo}_chg`] : null;
    const antes = valorAntes(vol, chg);
    const parte = total ? total[e.parte] : null;
    const pos = (v) => (v === null || v === undefined || !(maior > 0) ? 0 : Math.min(100, (v / maior) * 100));
    const marca = antes === null ? '' : `<span class="marca" data-marca="antes" style="left:${pos(antes).toFixed(1)}%"></span>`;
    const dVol = total ? `<span class="linha" data-var="vol">${contraAnterior(chg, true)}</span>` : '';
    const dAntes = antes === null ? '' : `<span class="peq">antes ${esc(fmt(Math.round(antes), 'int'))}</span>`;
    return `<div class="passo" data-card="${e.campo}"><p class="fc-rotulo">${esc(e.rotulo)}</p><p class="num vol"><span class="v">${esc(fmt(vol, 'int'))}</span></p>${dVol}<div class="parte"><div class="barra" aria-hidden="true"><i style="width:${pos(vol).toFixed(1)}%"></i>${marca}</div><span>${esc(fmt(parte, 'pct'))} dos leads${dAntes ? ' · ' : ''}${dAntes}</span></div></div>`;
  }

  function conexaoHtml(chave, total, esperando) {
    if (esperando) return `<div class="cn" aria-hidden="true"><p class="num">${ESQ_NUM}</p>${SETA}</div>`;
    const pp = total ? total[`${chave}_pp`] : null;
    const base = pp === null || pp === undefined
      ? '<span class="sem-base">sem base</span>'
      : `<span class="antes">antes ${esc(fmt(total[`prev_${chave}`], 'pct'))}</span><span class="pp" data-var="pp">${variacao(pp, true, 'pp')}</span>`;
    const eQueda = !!total && total.biggest_drop === chave;
    const queda = eQueda ? '<span class="queda">Maior queda</span>' : '';
    return `<div class="cn${eQueda ? ' quebra' : ''}" data-passagem="${chave}"${eQueda ? ' data-maior-queda' : ''}><p class="num taxa">${esc(fmt(total && total[chave], 'pct'))}</p>${SETA}${base}${queda}</div>`;
  }

  // Cartão do resumo: valor, variação contra o anterior e "antes X". Cliente sem mídia: "sem dado de mídia" nos três de mídia.
  function faixaHtml([campo, rotulo, tipo, unidade, bomSobe], total, esperando) {
    if (esperando) return `<div class="faixa-cartao fc-cartao" data-card="${campo}"><div class="txt"><p class="fc-rotulo">${esc(rotulo)}</p><p class="num" aria-hidden="true">${ESQ_NUM}</p></div></div>`;
    const valor = total ? total[campo] : null;
    const tem = valor !== null && valor !== undefined;
    const nota = semMidia() && FAIXA_DE_MIDIA.includes(campo) ? '<p class="fc-legenda">sem dado de mídia</p>' : '';
    const chg = total ? total[`${campo}_chg`] : null;
    const dlt = total && tem ? `<span class="linha">${contraAnterior(chg, bomSobe)}</span>` : '';
    const antes = valorAntes(valor, chg);
    const dAntes = antes === null ? '' : `<p class="fc-legenda antes">antes ${esc(fmt(antes, tipo))}${esc(unidade)}</p>`;
    const un = unidade && tem ? `<span class="un">${esc(unidade)}</span>` : '';
    return `<div class="faixa-cartao fc-cartao" data-card="${campo}"><div class="txt"><p class="fc-rotulo">${esc(rotulo)}</p><p class="num"><span class="v">${esc(fmt(valor, tipo))}</span>${un}</p>${dlt}${dAntes}${nota}</div></div>`;
  }

  function renderCartoes(esperando) {
    const total = esperando ? null : totalFunil();
    const maior = total ? Math.max(0, ...ETAPAS.flatMap((e) => [total[e.campo], valorAntes(total[e.campo], total[`${e.campo}_chg`])]).filter((v) => v !== null && v !== undefined)) : 0;
    const itens = [];
    ETAPAS.forEach((e, i) => {
      itens.push(passoHtml(e, total, esperando, maior));
      if (i < PASSAGENS.length) itens.push(conexaoHtml(PASSAGENS[i], total, esperando));
    });
    $('cartoes').innerHTML = itens.join('');
    $('faixa').innerHTML = FAIXA.map((f) => faixaHtml(f, total, esperando)).join('');
    const sub = $('funil-sub');
    if (esperando) { sub.textContent = ''; return; }
    sub.textContent = `${subtituloComparacao(total)}. Entre as etapas, a taxa de passagem e a mudança em pontos percentuais (pp).`;
  }

  // Período anterior sem dado nenhum (vazio, ou anterior ao primeiro dado do cliente): todas as variações de volume e de gasto vêm sem base.
  const VARIACOES_DE_VOLUME = ['leads_chg', 'marked_patients_chg', 'scheduled_patients_chg', 'completed_patients_chg', 'spend_chg'];
  const semPeriodoAnterior = (total) => VARIACOES_DE_VOLUME.every((c) => total[c] === null || total[c] === undefined);

  // Subtítulo do funil. Os 3 casos espelham prev_window (_prelude.sql); as datas do anterior vêm do SQL, o texto só as nomeia.
  // Sem dado no período anterior, só o período atual: "contra ..." seria uma comparação com nada.
  function subtituloComparacao(total) {
    const d = (iso) => (/^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '') || []).slice(1).map(Number);
    const [ai, mi, di] = d(state.start);
    const [af, mf, df] = d(state.end);
    const atual = `De ${fmtData(state.start)} a ${fmtData(state.end)}`;
    if (!total || !total.prev_start || !total.prev_end || semPeriodoAnterior(total)) return atual;
    const [pa, pm] = d(total.prev_start);
    const [pfa, pfm] = d(total.prev_end);
    const fimDoMes = df === new Date(Date.UTC(af, mf, 0)).getUTCDate();
    const nomeMes = (a, m) => `${MESES_POR_EXTENSO[m - 1]} de ${a}`;
    const intervaloMeses = (a1, m1, a2, m2) => (a1 === a2 && m1 === m2 ? nomeMes(a1, m1)
      : a1 === a2 ? `${MESES[m1 - 1]} a ${MESES[m2 - 1]} de ${a1}` : `${MESES[m1 - 1]} de ${a1} a ${MESES[m2 - 1]} de ${a2}`);
    const maiuscula = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    if (di === 1 && fimDoMes) {
      return `${maiuscula(intervaloMeses(ai, mi, af, mf))} contra ${intervaloMeses(pa, pm, pfa, pfm)}`;
    }
    if (di === 1) {
      const k = (ai - pa) * 12 + mi - pm;
      const dm = (iso) => fmtData(iso).slice(0, 5);
      const ref = k === 1 ? 'do mês anterior' : `de ${k} meses antes`;
      const ate = ai === af ? `${dm(state.end)}/${af}` : fmtData(state.end);
      return `De ${ai === af ? dm(state.start) : fmtData(state.start)} a ${ate}, contra o mesmo trecho ${ref} (${dm(total.prev_start)} a ${dm(total.prev_end)})`;
    }
    return `${atual}, contra ${fmtData(total.prev_start)} a ${fmtData(total.prev_end)} (mesma duração, logo antes)`;
  }

  // Estado de espera: bloco cinza no lugar do número e da tabela (sem opacity em texto, sem número velho).
  const ESQUELETO_TABELA = `<div class="esq-tabela" aria-hidden="true">${'<span class="esq esq-linha"></span>'.repeat(4)}</div>`;

  function atualizaTituloDetalhe() {
    $('t-detalhe').textContent = `Detalhe por ${GRAO_TXT[state.grain]}`;
    document.querySelectorAll('[data-aba]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.aba === state.aba)));
    document.querySelectorAll('[data-grao]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.grao === state.grain)));
  }

  function renderEsperando() {
    renderCartoes(true);
    atualizaTituloDetalhe();
    document.querySelector('#bloco-canais .rolagem').innerHTML = ESQUELETO_TABELA;
    document.querySelector('#bloco-detalhe .rolagem').innerHTML = ESQUELETO_TABELA;
    for (const chave of Object.keys(LISTAS)) {
      const bloco = $(LISTAS[chave].bloco);
      bloco.querySelector('.rolagem').innerHTML = ESQUELETO_TABELA;
      bloco.querySelector('.pag').innerHTML = '';
      bloco.querySelector('.hint').textContent = '';
    }
  }

  // Os canais que existem nos dados do período (sem 'all'), em ordem alfabética do nome na tela.
  function canaisDosDados() {
    const ids = [...new Set(state.canais.map((r) => r.channel).filter((c) => c && c !== 'all' && c !== 'selected'))];
    return ids.sort((a, b) => rotuloCanal(a).localeCompare(rotuloCanal(b), 'pt-BR'));
  }

  // "Por canal": uma linha por canal que existe nos dados e o Total, com a linha 'total' de cada um no funnel.sql.
  // Nenhuma linha inventada: canal sem dado no período não aparece, e campo sem valor aparece com "-".
  // Com o filtro Canal: só as linhas dos canais marcados; um canal não tem Total, 2 ou mais têm o Total deles (visaoDoCanal).
  function renderCanais() {
    const total = (canal) => state.canais.find((r) => (r.channel || 'all') === canal && r.period === 'total') || null;
    const cab = COLS_CANAIS.map((c) => `<th>${esc(c[1])}</th>`).join('');
    const marcados = state.canal.slice().sort((a, b) => rotuloCanal(a).localeCompare(rotuloCanal(b), 'pt-BR'));
    const linhas = !marcados.length ? canaisDosDados().concat(['all']) : marcados.length === 1 ? marcados : marcados.concat([visaoDoCanal()]);
    const corpo = linhas.map((canal) => {
      const r = total(canal);
      const cels = COLS_CANAIS.map(([campo, , tipo]) => celula(r ? r[campo] : null, tipo, campo)).join('');
      return `<tr${canal === 'all' || canal === 'selected' ? ' class="total"' : ''} data-linha-canal="${esc(canal)}"><td data-col="channel">${esc(rotuloCanal(canal))}</td>${cels}</tr>`;
    }).join('');
    document.querySelector('#bloco-canais .rolagem').innerHTML = `<table data-tabela="canais"><thead><tr><th>Canal</th>${cab}</tr></thead><tbody>${corpo}</tbody></table>`;
    $('nota-canais').textContent = 'Gasto = mídia + custo fixo do canal (o valor do mês, rateado por dia).';
  }

  function renderDetalhe() {
    atualizaTituloDetalhe();
    const grao = state.grain;
    const cols = ABAS[state.aba];
    const normais = periodosFunil().reverse();
    const total = totalFunil();
    const linhas = total ? normais.concat([total]) : normais;
    const cab = cols.map((c) => `<th>${esc(c[1])}</th>`).join('');
    const corpo = linhas.map((r) => {
      const semValor = (r.completed_patients || 0) - (r.completed_with_value || 0);
      const cels = cols.map(([campo, , tipo, comNota]) => {
        const nota = comNota && semValor > 0 ? `<small class="sv">${NF0.format(semValor)} sem valor</small>` : '';
        return celula(r[campo], tipo, campo, nota);
      }).join('');
      // Período sem gasto na aba de custo: um aviso na 1ª célula no lugar da fileira de "-" (não vale com filtro que anula o custo).
      const semGasto = state.aba === 'custo' && r.period !== 'total' && (r.spend === null || r.spend === undefined) && !FILTROS_SEM_CUSTO.some((k) => state.filters[k].length > 0);
      const linha = semGasto ? cols.map(([campo], i) => `<td data-col="${campo}"${i === 0 ? ' class="sem-gasto">sem gasto' : '>'}</td>`).join('') : cels;
      return `<tr${r.period === 'total' ? ' class="total"' : ''} data-period="${esc(r.period)}"><td data-col="period">${esc(rotuloPeriodo(r.period, grao))}</td>${linha}</tr>`;
    }).join('');
    const vazio = linhas.length ? '' : `<tr><td colspan="${cols.length + 1}" class="txt">Nenhum dado no período.</td></tr>`;
    document.querySelector('#bloco-detalhe .rolagem').innerHTML = `<table data-tabela="${state.aba}"><thead><tr><th>Período</th>${cab}</tr></thead><tbody>${corpo}${vazio}</tbody></table>`;
  }

  // "N pacientes" vem do funil (paciente distinto, igual aos cartões); sem a linha total, conta as linhas da lista.
  function hintLista(chave) {
    const total = totalFunil();
    const n = total ? total[chave === 'completed' ? 'completed_patients' : 'marked_patients'] : null;
    if (n === null || n === undefined) return `${NF0.format(linhasDaLista(chave).length)} linhas`;
    return `${NF0.format(n)} ${n === 1 ? 'paciente' : 'pacientes'}`;
  }

  // A lista de cada canal é a mesma consulta, filtrada pela coluna channel (como o funil).
  const linhasDaLista = (chave) => state.lists[chave].rows.filter((r) => !state.canal.length || state.canal.includes(r.channel));

  function renderLista(chave) {
    const def = LISTAS[chave];
    const est = state.lists[chave];
    const bloco = $(def.bloco);
    const linhas = linhasDaLista(chave);
    const total = linhas.length;
    const paginas = Math.max(1, Math.ceil(total / PAGE_SIZE));
    est.page = Math.min(est.page, paginas - 1);
    const fatia = linhas.slice(est.page * PAGE_SIZE, (est.page + 1) * PAGE_SIZE);
    const cab = def.cols.map((c) => `<th class="${c[2] === 'txt' || c[2] === 'tipo' ? 'txt' : ''}">${esc(c[1])}</th>`).join('');
    const corpo = fatia.map((r) => `<tr>${def.cols.map(([campo, , tipo]) => `<td class="${tipo === 'txt' || tipo === 'tipo' ? 'txt' : ''}" data-col="${campo}">${esc(fmt(r[campo], tipo))}</td>`).join('')}</tr>`).join('');
    bloco.querySelector('.rolagem').innerHTML = total
      ? `<table><thead><tr>${cab}</tr></thead><tbody>${corpo}</tbody></table>`
      : '<div class="vazio-lista">Nenhuma linha no período.</div>';
    bloco.querySelector('.hint').textContent = hintLista(chave);
    const pag = bloco.querySelector('.pag');
    pag.innerHTML = total
      ? `<button type="button" data-act="prev" ${est.page === 0 ? 'disabled' : ''}>Anterior</button><span class="info">Página ${est.page + 1} de ${paginas} (${NF0.format(total)} linhas)</span><button type="button" data-act="next" ${est.page >= paginas - 1 ? 'disabled' : ''}>Próxima</button>`
      : '';
  }

  // Seleção parcial (2 ou mais canais, nem todos): paciente distinto e taxa não somam, então o SQL calcula a visão 'selected' (@channels, ver
  // sql/funnel.sql) e a página consulta de novo quando ela muda. Nenhum canal ou todos = 'all'; um canal = a visão dele, sem nova consulta.
  function canaisParaSql() {
    const todos = (state.options.channel || []).map((o) => o.value);
    const cobreTodos = todos.length > 0 && todos.every((c) => state.canal.includes(c));
    return state.canal.length >= 2 && !cobreTodos ? state.canal.slice().sort() : [];
  }

  function visaoDoCanal() {
    if (canaisParaSql().length) return 'selected';
    return state.canal.length === 1 ? state.canal[0] : 'all';
  }

  // O funil, as tabelas e o bloco "Por canal" mostram os canais do filtro Canal (Todos: todos os canais e o Total).
  function aplicaCanal() {
    state.funnel = state.canais.filter((r) => (r.channel || 'all') === visaoDoCanal());
  }

  function renderTudo() {
    aplicaCanal();
    renderCartoes();
    renderCanais();
    renderDetalhe();
    renderLista('completed');
    renderLista('marked');
  }

  // ------------------------------------------------------------ ritmo do mês e histórico mês a mês (sql/funnel_month.sql)
  // Uma consulta por cliente, sempre SEM o canal, o período e os filtros da tela: o histórico não muda quando eles mudam.
  const mensalLinhas = () => (state.mensal && state.mensal.rows) || [];
  const mulK = (v, k) => (v === null || v === undefined ? null : v * k);
  const brl0 = (v) => (v === null || v === undefined ? VAZIO : 'R$ ' + NF0.format(v));
  const roas1 = (v) => (v === null || v === undefined ? VAZIO : NF1.format(v) + 'x');
  const mesPorExtenso = (per) => MESES_POR_EXTENSO[Number(per.slice(5, 7)) - 1];
  const maiuscula = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const SEM_MIDIA = 'sem dado de mídia';

  // Run rate = parcial x dias do mês / dias corridos (partial_until). Sem a linha parcial do mês corrente, não há ritmo.
  function ritmoDados() {
    const m = mensalLinhas();
    const cur = m[m.length - 1];
    if (!cur || !cur.partial_until) return null;
    const [ano, mes] = cur.period.split('-').map(Number);
    const diasMes = new Date(ano, mes, 0).getDate();
    const dia = Number(cur.partial_until.slice(8, 10));
    const ant = new Date(ano, mes - 2, 1);
    const perAnt = `${ant.getFullYear()}-${String(ant.getMonth() + 1).padStart(2, '0')}`;
    const k = diasMes / dia;
    return { cur, prev: m.find((x) => x.period === perAnt) || null, k, dia, diasMes, fee: mulK(cur.physician_fee, k), spend: mulK(cur.spend, k) };
  }

  const varMes = (a, b, bomSobe, mes) => {
    const f = a === null || a === undefined || b === null || b === undefined || b === 0 ? null : a / b - 1;
    return f === null ? '<span class="sem-base">sem base</span>' : `${variacao(f, bomSobe)} <span class="peq">contra ${esc(mes)}</span>`;
  };

  function cartaoRitmo(campo, rotulo, valor, txt, varHtml, real) {
    const num = valor === null || valor === undefined
      ? `<p class="sem-valor">${esc(txt)}</p>`
      : `<p class="num"><span class="v">${esc(txt)}</span></p><p class="linha">${varHtml}</p><p class="fc-legenda">${esc(real)}</p>`;
    return `<article class="ritmo-cartao fc-cartao" data-card="${campo}"><p class="fc-rotulo">${esc(rotulo)}</p>${num}</article>`;
  }

  function ritmoHtml() {
    const R = ritmoDados();
    if (!R) return '<h2 class="fc-h3" id="t-ritmo">Ritmo do mês</h2><p class="vazio-t">Sem dado neste mês</p>';
    const cac = state.modo === 'cac';
    const mp = R.prev ? mesPorExtenso(R.prev.period) : 'o mês anterior';
    const p = R.prev || {};
    const mes = mesPorExtenso(R.cur.period);
    const sem = semMidia();
    const gasto = sem ? null : R.spend;
    const terceiro = sem ? null : (cac ? R.cur.cpr : R.cur.roas_honorario);
    const seg = `<div class="seg" role="group" aria-label="Terceiro número"><button type="button" data-modo="roas" aria-pressed="${!cac}">ROAS</button><button type="button" data-modo="cac" aria-pressed="${cac}">CAC</button></div>`;
    const cartoes = [
      cartaoRitmo('physician_fee', 'Honorário (run rate)', R.fee, brl0(R.fee), varMes(R.fee, p.physician_fee, true, mp), `Realizado até hoje: ${brl0(R.cur.physician_fee)}`),
      cartaoRitmo('spend', 'Investimento em Ads (run rate)', gasto, sem ? SEM_MIDIA : brl0(gasto), varMes(gasto, p.spend, null, mp), `Realizado até hoje: ${brl0(R.cur.spend)}`),
      cac
        ? cartaoRitmo('cpr', 'CAC (run rate)', terceiro, sem ? SEM_MIDIA : fmt(terceiro, 'money'), varMes(terceiro, p.cpr, false, mp), `Realizado até hoje: ${fmt(terceiro, 'money')}`)
        : cartaoRitmo('roas_honorario', 'ROAS do honorário (run rate)', terceiro, sem ? SEM_MIDIA : roas1(terceiro), varMes(terceiro, p.roas_honorario, true, mp), `Realizado até hoje: ${roas1(terceiro)}`),
    ].join('');
    return `<div class="cab"><h2 class="fc-h3" id="t-ritmo">Ritmo de ${esc(mes)}</h2>${seg}</div><p class="fc-legenda">Projeção: o que já veio em ${R.dia} dias, estendido para ${R.diasMes} dias.</p><div class="ritmo-grade">${cartoes}</div>`;
  }

  // Leitura de um mês (toque ou foco na coluna). Mês corrente: projeção.
  function leituraMes(per, R) {
    const x = mensalLinhas().find((r) => r.period === per);
    if (!x) return '';
    const sem = semMidia();
    const k = x.partial_until && R ? R.k : 1;
    const item = (rot, val) => `<div><dt>${rot}</dt><dd>${esc(val)}</dd></div>`;
    const realizados = x.completed_patients === null || x.completed_patients === undefined ? VAZIO : NF0.format(Math.round(x.completed_patients * k));
    return `<p class="hist-leitura-t">${esc(maiuscula(mesPorExtenso(per)))}${x.partial_until ? ' (projeção)' : ''}</p><dl>${item('Ads', sem ? SEM_MIDIA : brl0(mulK(x.spend, k)))}${item('Honorário', brl0(mulK(x.physician_fee, k)))}${item('Realizados', realizados)}${item('ROAS', sem ? SEM_MIDIA : roas1(x.roas_honorario))}${item('CAC', sem ? SEM_MIDIA : fmt(x.cpr, 'money'))}</dl>`;
  }

  function tabelaMensal(rows, R) {
    const sem = semMidia();
    const linha = (rot, ads, hon, real, roas, cac, cls) => `<tr${cls ? ` class="${cls}"` : ''}><td>${esc(rot)}</td><td>${esc(sem ? SEM_MIDIA : ads)}</td><td>${esc(hon)}</td><td>${esc(real)}</td><td>${esc(sem ? SEM_MIDIA : roas)}</td><td>${esc(sem ? SEM_MIDIA : cac)}</td></tr>`;
    const corpo = rows.map((x) => linha(mesPorExtenso(x.period) + (x.partial_until ? ` (até ${fmtData(x.partial_until).slice(0, 5)})` : ''), brl0(x.spend), brl0(x.physician_fee), fmt(x.completed_patients, 'int'), roas1(x.roas_honorario), fmt(x.cpr, 'money'))).join('');
    const rr = R ? linha(`run rate de ${mesPorExtenso(R.cur.period)}`, brl0(R.spend), brl0(R.fee), NF0.format(Math.round((R.cur.completed_patients || 0) * R.k)), roas1(R.cur.roas_honorario), fmt(R.cur.cpr, 'money'), 'total') : '';
    return `<div class="rolagem" data-rolagem tabindex="0"><table data-tabela="mensal"><thead><tr><th>Mês</th><th>Ads</th><th>Honorário</th><th>Realizados</th><th>ROAS</th><th>CAC</th></tr></thead><tbody>${corpo}${rr}</tbody></table></div>`;
  }

  function historicoHtml() {
    const todas = mensalLinhas();
    if (!todas.length) return '<h2 class="fc-h3" id="t-hist">Mês a mês</h2><p class="vazio-t">Sem dado neste mês</p>';
    const R = ritmoDados();
    const rows = todas.slice(-state.meses);
    const sem = semMidia();
    const cac = state.modo === 'cac';
    const vals = rows.map((x) => {
      const parc = !!x.partial_until;
      const k = parc && R ? R.k : 1;
      return { x, per: x.period, parc, ads: sem ? null : mulK(x.spend, k), hon: mulK(x.physician_fee, k), lin: sem ? null : (cac ? x.cpr : x.roas_honorario) };
    });
    const maxV = Math.max(0, ...vals.flatMap((v) => [v.ads, v.hon]).filter((v) => v !== null && v !== undefined));
    const maxL = Math.max(0, ...vals.map((v) => v.lin).filter((v) => v !== null && v !== undefined)) * 1.15;
    const alt = (v) => (v === null || v === undefined || !(maxV > 0) ? 0 : (v / maxV) * 100);
    const sel = vals.some((v) => v.per === state.mesSel) ? state.mesSel : vals[vals.length - 1].per;
    const n = vals.length;
    const barra = (cls, rotulo, proj, real, parc) => (proj === null || proj === undefined ? ''
      : `<span class="hist-b ${cls}" data-barra="${rotulo}"${parc ? ' data-parcial' : ''} style="height:${alt(proj).toFixed(1)}%">${parc && proj > 0 ? `<i style="height:${Math.min(100, (real / proj) * 100).toFixed(1)}%"></i>` : ''}</span>`);
    const cols = vals.map((v) => {
      const rotLin = v.lin === null || v.lin === undefined ? VAZIO : (cac ? 'R$ ' + NF0.format(v.lin) : roas1(v.lin));
      const nome = `${MESES[Number(v.per.slice(5, 7)) - 1]}${v.parc ? '*' : ''}`;
      return `<button type="button" class="hist-mes" data-mes="${v.per}"${v.parc ? ' data-parcial' : ''} aria-pressed="${v.per === sel}" aria-label="${esc(mesPorExtenso(v.per))}: ${esc(brl0(v.hon))} de honorário"><span class="hist-barras">${barra('ads', 'ads', v.ads, v.x.spend, v.parc)}${barra('hon', 'honorario', v.hon, v.x.physician_fee, v.parc)}</span><span class="hist-mes-nome">${esc(nome)}</span><span class="hist-lin-v">${esc(rotLin)}</span></button>`;
    }).join('');
    const pts = vals.map((v, i) => (v.lin === null || v.lin === undefined || !(maxL > 0) ? null : [((i + 0.5) / n) * 100, 8 + (v.lin / maxL) * 84]));
    const ok = pts.filter(Boolean);
    const linha = ok.length > 1 ? `<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polyline points="${ok.map(([x, y]) => `${x.toFixed(1)},${(100 - y).toFixed(1)}`).join(' ')}"/></svg>` : '';
    const pontos = ok.map(([x, y]) => `<span class="hist-ponto" style="left:${x.toFixed(1)}%;bottom:${y.toFixed(1)}%"></span>`).join('');
    const meses = [3, 6, 12].map((m) => `<button type="button" data-meses="${m}" aria-pressed="${state.meses === m}">${m} meses</button>`).join('');
    const legenda = `<ul class="hist-legenda"><li><i class="sw ads"></i>Investimento em Ads</li><li><i class="sw hon"></i>Honorário</li><li><i class="sw lin"></i>${cac ? 'CAC' : 'ROAS'} (número sob o mês)</li><li><i class="sw proj"></i>* Mês corrente: projeção</li></ul>`;
    return `<div class="cab"><h2 class="fc-h3" id="t-hist">Mês a mês</h2><div class="seg" role="group" aria-label="Quantos meses">${meses}</div></div>${legenda}${sem ? `<p class="fc-legenda">Investimento em Ads, ROAS e CAC: ${SEM_MIDIA}.</p>` : ''}<div class="hist-leitura" aria-live="polite">${leituraMes(sel, R)}</div><div class="hist-rolagem" data-rolagem tabindex="0"><div class="hist-grade" style="--n:${n}"><div class="hist-linha" aria-hidden="true">${linha}${pontos}</div>${cols}</div></div><div class="hist-tab"><button type="button" class="btn ghost" data-act="tab-hist" aria-expanded="${state.tabHist}"><span>Ver os números</span>${CHEVRON}</button>${state.tabHist ? tabelaMensal(rows, R) : ''}</div>`;
  }

  function renderMensal() {
    const r = $('bloco-ritmo'), h = $('bloco-historico');
    const mm = state.mensal;
    if (!mm || mm.carregando) {
      r.innerHTML = `<h2 class="fc-h3" id="t-ritmo">Ritmo do mês</h2>${ESQUELETO_TABELA}`;
      h.innerHTML = `<h2 class="fc-h3" id="t-hist">Mês a mês</h2>${ESQUELETO_TABELA}`;
      return;
    }
    if (mm.erro) {
      r.innerHTML = `<h2 class="fc-h3" id="t-ritmo">Ritmo do mês</h2><p class="erro" role="alert">Não consegui carregar o histórico mensal. ${esc(mm.erro)}</p><button type="button" class="btn ghost" data-act="tentar-mensal">Tentar de novo</button>`;
      h.innerHTML = '<h2 class="fc-h3" id="t-hist">Mês a mês</h2><p class="vazio-t">Sem dado neste mês</p>';
      return;
    }
    r.innerHTML = ritmoHtml();
    h.innerHTML = historicoHtml();
  }

  let seqMensal = 0;
  async function carregaMensal() {
    const meu = ++seqMensal;
    const tenant = state.tenant;
    state.mensal = { tenant, carregando: true };
    renderMensal();
    try {
      const rows = await consulta('funnel_month', { tenant });
      if (meu !== seqMensal) return;
      state.mensal = { tenant, rows };
    } catch (e) {
      if (e instanceof AuthError || meu !== seqMensal) return;
      state.mensal = { tenant, erro: e.message };
    }
    renderMensal();
  }

  // ------------------------------------------------------------ página Cirurgias (só leitura)
  // O desenho mora em cirurgias.js (quem ainda pode operar, do mais quente ao mais frio, links do paciente no sistema da clínica).
  // Aqui fica o que depende do painel: login, consulta ao BigQuery, ?tenant= e o relógio.
  let seqCir = 0;
  const diasEntre = (deIso, ateIso) => Math.round((dataDeISO(ateIso) - dataDeISO(deIso)) / 86400000);
  const ctxCir = () => ({ esc, fmtData, nf0: NF0, hoje: hojeIso(), diasEntre, esqueleto: ESQUELETO_TABELA, tenant: state.tenant, enviaCheckin });

  async function carregaCirurgias() {
    const meu = ++seqCir;
    $('cir-erro').hidden = true;
    window.PainelCirurgias.render(null, ctxCir());
    const app = $('painel');
    app.classList.add('carregando');
    app.setAttribute('aria-busy', 'true');
    try {
      if (!state.tenants) await carregaClientes();
      if (meu !== seqCir) return;
      const linhas = await consulta('surgeries', { tenant: state.tenant });
      if (meu !== seqCir) return;
      state.cirurgias = linhas;
      window.PainelCirurgias.render(state.cirurgias, ctxCir());
    } catch (e) {
      if (e instanceof AuthError) return;
      if (meu === seqCir) {
        $('cir-erro').textContent = 'Não consegui carregar a lista de cirurgias. Tente de novo em alguns minutos.';
        $('cir-erro').hidden = false;
        state.cirurgias = [];
        window.PainelCirurgias.render(false, ctxCir()); // limpa a tela sem desenhar "lista vazia" em cima do erro
      }
    } finally {
      if (meu === seqCir) {
        app.classList.remove('carregando');
        app.removeAttribute('aria-busy');
      }
    }
  }

  // ------------------------------------------------------------ página Pacientes (acompanhamento pelo WhatsApp da Júlia)
  // O desenho e a regra moram em pacientes.js e _shared/followup.js. Aqui: a lista (analytics.patient_followup), a conversa de um telefone
  // por vez (analytics.messages), o estado do dia e o ÚNICO ponto de ação (acaoPaciente), que vai ao servidor.
  let seqPac = 0;
  const FIXTURE_ACAO_URL = 'https://acao.fixture.invalid/pacientes'; // literal-ok: só no ?fixture=1; o gabarito intercepta esta URL, nada sai da máquina
  const mensagensPaciente = async (phoneKey) => {
    try {
      return await consulta('messages', { tenant: state.tenant, phone_key: phoneKey });
    } catch (e) {
      if (e instanceof AuthError) return null; // a sessão caiu: o login já apareceu
      throw e;
    }
  };

  // Regras do cliente, agendados ativos, modelos de mensagem, teto do dia e telefone de teste. Quem entrega é o servidor: action=state do mesmo
  // webhook do check-in (contrato em _shared/fixtures/painel_acao/contrato.md). Sem resposta boa devolve null: a página mostra tudo, ações desligadas.
  async function estadoPacientes() {
    const r = await acaoPaciente('state', {});
    return r.resp && r.resp.status === 'ok' ? r.resp : null;
  }

  // Devolve { ok, resp } (resp = o corpo que o servidor respondeu; ok = a ação valeu), { semLogin: true } quando a sessão caiu, ou { ok: false, message }
  // quando nem houve resposta (sem rede, sem permissão, demora). Quem escolhe o texto de cada status é a página (pacientes.js).
  const ACAO_ESPERA_MS = 75000; // o servidor leva 22 a 35 s por ação com telefone (contrato.md); passou disso a resposta não vem mais
  const ACAO_VALEU = ['ok', 'enviado', 'agendado', 'cancelado'];
  async function acaoPaciente(nome, corpo) {
    const url = FIXTURE ? FIXTURE_ACAO_URL : CFG.CHECKIN_URL;
    if (!url) return { ok: false, message: 'As ações ainda não estão ligadas.' };
    if (!FIXTURE && (!token || token.exp <= Date.now() + 30000)) {
      token = null;
      mostraLogin('Sua sessão expirou. Entre de novo.');
      return { semLogin: true };
    }
    let r;
    try {
      r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: nome, tenant: state.tenant, access_token: token ? token.value : null, ...corpo }), signal: AbortSignal.timeout(ACAO_ESPERA_MS) });
    } catch (e) {
      if (e && e.name === 'TimeoutError') return { ok: false, message: 'O servidor demorou demais. A ação pode ter valido: confira o Log antes de repetir.' };
      return { ok: false, message: 'Não consegui falar com o servidor. Tente de novo.' };
    }
    if (r.status === 401) {
      limpaToken();
      mostraLogin('Entre de novo para liberar as ações.');
      return { semLogin: true };
    }
    if (r.status === 403) return { ok: false, message: 'Sem permissão para esta ação.' };
    let resp = {};
    try { resp = await r.json(); } catch (e) { /* resposta sem corpo: falha */ }
    return { ok: r.ok && ACAO_VALEU.indexOf(resp.status) >= 0, resp };
  }

  const ctxPac = () => ({ esc, fmtData, nf0: NF0, hoje: hojeIso(), esqueleto: ESQUELETO_TABELA, tenant: state.tenant, mensagens: mensagensPaciente, acao: acaoPaciente, recarrega: () => carregaPacientes(true) });

  async function carregaPacientes(silencioso) {
    const meu = ++seqPac;
    $('pc-erro').hidden = true;
    if (!silencioso) window.PainelPacientes.render(null, ctxPac());
    const app = $('painel');
    app.classList.add('carregando');
    app.setAttribute('aria-busy', 'true');
    try {
      if (!state.tenants) await carregaClientes();
      if (meu !== seqPac) return;
      const [linhas, estado] = await Promise.all([consulta('patients', { tenant: state.tenant }), estadoPacientes()]);
      if (meu !== seqPac) return;
      window.PainelPacientes.render({ linhas, estado }, ctxPac());
    } catch (e) {
      if (e instanceof AuthError) return;
      if (meu === seqPac) {
        $('pc-erro').textContent = 'Não consegui carregar os pacientes. Tente de novo em alguns minutos.';
        $('pc-erro').hidden = false;
        window.PainelPacientes.render(false, ctxPac()); // limpa a tela sem desenhar "lista vazia" em cima do erro
      }
    } finally {
      if (meu === seqPac) {
        app.classList.remove('carregando');
        app.removeAttribute('aria-busy');
      }
    }
  }

  // ------------------------------------------------------------ página Setup (quadro de setup, só do Felipe)
  // O desenho e a edição moram em setup.js. Aqui: a foto (analytics.setup_board) e o que veio depois dela (raw.events), pelo login.
  let seqSet = 0;

  async function carregaSetup() {
    const meu = ++seqSet;
    $('set-erro').hidden = true;
    const app = $('painel');
    app.classList.add('carregando');
    app.setAttribute('aria-busy', 'true');
    try {
      const [foto] = await consulta('setup_board', {});
      if (meu !== seqSet) return;
      const sobre = foto ? await consulta('setup_events', {}) : [];
      if (meu !== seqSet) return;
      window.PainelSetup.render(foto || null, sobre, { anota: anotaSetup });
    } catch (e) {
      if (e instanceof AuthError) return;
      if (meu === seqSet) {
        $('set-erro').textContent = 'Não consegui carregar o quadro de setup. Tente de novo em alguns minutos.';
        $('set-erro').hidden = false;
        window.PainelSetup.render(null, [], { anota: anotaSetup });
      }
    } finally {
      if (meu === seqSet) {
        app.classList.remove('carregando');
        app.removeAttribute('aria-busy');
      }
    }
  }

  // ------------------------------------------------------------ página Atividades (linha do tempo dos clientes, só leitura)
  // O desenho mora em atividades.js. Aqui: o período (últimos N dias, hoje incluído), a consulta (activities.sql) e os erros. Cliente e tipo filtram lá.
  let seqAtv = 0;
  let diasAtv = 30;

  async function carregaAtividades(dias) {
    const meu = ++seqAtv;
    diasAtv = dias || diasAtv;
    const fim = hojeIso();
    const ctx = { esc, inicio: PER.somaDias(fim, -(diasAtv - 1)), fim, dias: diasAtv, carrega: (n) => carregaAtividades(n) };
    $('atv-erro').hidden = true;
    window.PainelAtividades.render(null, ctx);
    const app = $('painel');
    app.classList.add('carregando');
    app.setAttribute('aria-busy', 'true');
    try {
      const linhas = await consulta('activities', { start_date: ctx.inicio, end_date: ctx.fim });
      if (meu !== seqAtv) return;
      window.PainelAtividades.render(linhas, ctx);
    } catch (e) {
      if (e instanceof AuthError) return;
      if (meu === seqAtv) {
        $('atv-erro').textContent = 'Não consegui carregar as atividades. Tente de novo em alguns minutos.';
        $('atv-erro').hidden = false;
        window.PainelAtividades.render(false, ctx);
      }
    } finally {
      if (meu === seqAtv) {
        app.classList.remove('carregando');
        app.removeAttribute('aria-busy');
      }
    }
  }

  // ------------------------------------------------------------ página Onboarding (mapa do onboarding, só leitura)
  // O desenho mora no html que o build.py do mapa grava em analytics.onboarding_map; o onboarding.js põe esse html num iframe com sandbox.
  // Aqui: a consulta (login do Google), a frase de espera e os erros. O mapa tem nome de cliente: só chega a quem o BigQuery deixa ler.
  let seqOnb = 0;

  async function carregaOnboarding() {
    const meu = ++seqOnb;
    $('onb-erro').hidden = true;
    $('onb-carregando').hidden = false;
    window.PainelOnboarding.limpa();
    const app = $('painel');
    app.classList.add('carregando');
    app.setAttribute('aria-busy', 'true');
    try {
      const [linha] = await consulta('onboarding_map', {});
      if (meu !== seqOnb) return;
      $('onb-carregando').hidden = true;
      window.PainelOnboarding.render(linha || null);
    } catch (e) {
      if (e instanceof AuthError) return;
      if (meu === seqOnb) {
        $('onb-carregando').hidden = true;
        window.PainelOnboarding.limpa();
        $('onb-erro').textContent = /^BigQuery 403/.test(String(e.message))
          ? 'Sua conta não tem permissão para ver o mapa do onboarding. Fale com o Felipe.'
          : 'Não consegui carregar o mapa do onboarding. Tente de novo em alguns minutos.';
        $('onb-erro').hidden = false;
      }
    } finally {
      if (meu === seqOnb) {
        app.classList.remove('carregando');
        app.removeAttribute('aria-busy');
      }
    }
  }

  function atualizaTitulo() {
    const p = state.pagina;
    $('t-funil-pagina').textContent = `${rotuloCliente(state.tenant)} · Funil`;
    document.title = LOCAIS[p] ? `${rotuloCliente(state.tenant)} · ${LOCAIS[p]} · Painel` : `${GLOBAIS[p]} · Painel`;
  }

  // Felipe, 13/11/2026: só Hoje e Funil foram redesenhados; as outras telas não se repetem aqui, abrem na versão antiga (classico/).
  const NO_CLASSICO = new Set(['cirurgias', 'pacientes', 'setup', 'atividades', 'onboarding']);
  function mudaPagina(pagina) {
    if (NO_CLASSICO.has(pagina)) {
      const q = new URLSearchParams(location.search);
      q.set('pagina', pagina);
      q.set('tenant', state.tenant);
      location.assign(`classico/index.html?${q}`);
      return;
    }
    state.pagina = pagina;
    $('pg-hoje').hidden = pagina !== 'hoje';
    $('pg-clientes').hidden = pagina !== 'clientes';
    $('pg-funil').hidden = pagina !== 'funil';
    $('pg-cirurgias').hidden = pagina !== 'cirurgias';
    $('pg-pacientes').hidden = pagina !== 'pacientes';
    $('pg-setup').hidden = pagina !== 'setup';
    $('pg-onboarding').hidden = pagina !== 'onboarding';
    $('pg-atividades').hidden = pagina !== 'atividades';
    document.querySelector('.pagina').classList.toggle('pagina-cheia', pagina === 'onboarding'); // o mapa vai até o fim da tela: sem o padding de baixo
    document.querySelector('[data-nav="local"]').hidden = !LOCAIS[pagina]; // andar local só dentro de um cliente
    document.querySelectorAll('[data-pagina]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pagina === pagina)));
    $('mais-painel').hidden = true;
    $('btn-mais').setAttribute('aria-expanded', 'false');
    atualizaTitulo();
    const q = new URLSearchParams(location.search);
    if (pagina === 'hoje') q.delete('pagina'); else q.set('pagina', pagina);
    if (q.toString() !== location.search.slice(1)) {
      try { history.replaceState(null, '', `${location.pathname}${q.toString() ? '?' + q : ''}`); } catch (e) { /* ok */ }
    }
  }

  // ------------------------------------------------------------ filtros
  const CHEVRON = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 5l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function resumoFiltro(chave) {
    const sel = chave === 'canal' ? state.canal : state.filters[chave];
    if (!sel.length) return chave === 'canal' ? 'Todos' : FILTROS.find((f) => f[0] === chave)[2];
    if (sel.length === 1) return chave === 'canal' ? rotuloCanal(sel[0]) : sel[0];
    return `${sel.length} selecionados`;
  }

  function renderFiltros() {
    const caixa = $('filtros');
    const abertos = new Set([...document.querySelectorAll('#filtro-canal details[open], #filtros details[open]')].map((d) => d.dataset.filtro));
    // Canal: múltipla escolha como os outros filtros, sem marcação = Todos; a lista vem dos canais que existem nos dados do período.
    const canais = (state.options.channel || []).map((o) => ({ value: o.value, n: o.n }));
    for (const c of state.canal) if (!canais.some((o) => o.value === c)) canais.push({ value: c, n: 0 });
    const campo = (chave, rotulo, opcoes, marcados, rotuloValor) => {
      const itens = opcoes.length
        ? opcoes.map((o) => `<label><input type="checkbox" value="${esc(o.value)}" ${marcados.has(o.value) ? 'checked' : ''}> <span>${esc(rotuloValor(o.value))}</span><span class="n">${NF0.format(o.n)}</span></label>`).join('')
        : '<div class="vazio">Sem valores no período.</div>';
      return `<div class="filtro-campo"><span class="fc-rotulo">${esc(rotulo)}</span><details class="filtro" id="f-${chave}" data-filtro="${chave}" ${abertos.has(chave) ? 'open' : ''}><summary><span class="val">${esc(resumoFiltro(chave))}</span>${CHEVRON}</summary><div class="opcoes">${itens}</div></details></div>`;
    };
    // O Canal fica fora do painel recolhido (é o filtro mais usado); os 7 outros ficam dentro de Filtros.
    $('filtro-canal').innerHTML = campo('canal', 'Canal', canais, new Set(state.canal), rotuloCanal);
    caixa.innerHTML = FILTROS.map(([chave, rotulo]) => {
      const opcoes = (state.options[chave] || []).slice();
      for (const v of state.filters[chave]) if (!opcoes.some((o) => o.value === v)) opcoes.push({ value: v, n: 0 });
      return campo(chave, rotulo, opcoes, new Set(state.filters[chave]), (v) => v);
    }).join('');
    atualizaContadorFiltros();
  }

  function atualizaContadorFiltros() {
    const n = FILTROS.filter(([k]) => state.filters[k].length > 0).length + (state.canal.length ? 1 : 0);
    $('filtros-ativos').textContent = n ? ` · ${n} ativo${n === 1 ? '' : 's'}` : '';
  }

  function atualizaResumoFiltro(chave) {
    document.querySelector(`#f-${chave} .val`).textContent = resumoFiltro(chave);
    atualizaContadorFiltros();
  }

  // ------------------------------------------------------------ recarga
  let debounce = null;
  function agenda(comOpcoes) {
    clearTimeout(debounce);
    debounce = setTimeout(() => recarrega(comOpcoes), 300);
  }

  async function recarrega(comOpcoes) {
    if (!FIXTURE && !token) return;
    if (state.pagina === 'hoje' || state.pagina === 'clientes') return carregaHoje();
    if (state.pagina === 'cirurgias') return carregaCirurgias();
    if (state.pagina === 'pacientes') return carregaPacientes();
    if (state.pagina === 'setup') return carregaSetup();
    if (state.pagina === 'onboarding') return carregaOnboarding();
    if (state.pagina === 'atividades') return carregaAtividades();
    if (state.start > state.end) {
      mostraErro('A data inicial vem depois da final.');
      return;
    }
    mostraErro('');
    atualizaAvisos();
    const meu = ++seq;
    const app = $('painel');
    app.classList.add('carregando');
    app.setAttribute('aria-busy', 'true');
    $('estado-carga').hidden = false;
    renderEsperando();
    if (!state.mensal || state.mensal.tenant !== state.tenant) carregaMensal(); // uma vez por cliente; não reconsulta quando canal, período ou filtro mudam
    try {
      if (!state.tenants) await carregaClientes();
      if (meu !== seq) return;
      const p = parametros();
      canaisConsultados = p.channels.join();
      const [funil, realizados, marcacoes, opcoes] = await Promise.all([
        consulta('funnel', p),
        consulta('completed', p),
        consulta('marked', p),
        comOpcoes ? consulta('options', p) : Promise.resolve(null),
      ]);
      if (meu !== seq) return;
      state.canais = funil;
      state.lists.completed = { rows: realizados, page: 0 };
      state.lists.marked = { rows: marcacoes, page: 0 };
      if (opcoes) {
        state.options = {};
        for (const o of opcoes) (state.options[o.filter] = state.options[o.filter] || []).push({ value: o.value, n: o.n });
        renderFiltros();
      }
      renderTudo();
    } catch (e) {
      if (e instanceof AuthError) return;
      if (meu === seq) {
        mostraErro(e.message);
        // o esqueleto não pode ficar para sempre, e o número velho não volta como se fosse deste período
        state.canais = [];
        canaisConsultados = null;
        state.lists = { completed: { rows: [], page: 0 }, marked: { rows: [], page: 0 } };
        renderTudo();
      }
    } finally {
      if (meu === seq) {
        app.classList.remove('carregando');
        app.removeAttribute('aria-busy');
        $('estado-carga').hidden = true;
      }
    }
  }

  // ------------------------------------------------------------ campo Período (painel com atalhos, 2 meses e datas digitadas)
  // Nasce fechado. Esc, clique fora e Cancelar descartam; só Aplicar muda o período e reconsulta, uma vez. A comparação é automática (prev_window do SQL).
  const SETA_ESQ = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M9 3L5 7l4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const SETA_DIR = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M5 3l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // Primeiro dia com dado do cliente atual (tenants.sql). Sem ele o atalho "Todo o período" fica desligado.
  function primeiroDado() {
    const t = (state.tenants || []).find((x) => x.tenant === state.tenant);
    return (t && t.first_date) || null;
  }

  function mostraPeriodo() {
    $('c-valor').textContent = `${state.todo ? 'Todo o período: ' : ''}${fmtData(state.start)} a ${fmtData(state.end)}`;
  }

  function ligaPeriodo() {
    const gatilho = $('c-periodo'), pop = $('c-pop'), iIni = $('c-ini'), iFim = $('c-fim'), erro = $('c-erro'), aplicar = $('c-aplicar'), host = $('c-cal');
    const botoes = (seletor) => Array.from(pop.querySelectorAll(seletor));
    let aberto = false;
    let pend = { start: state.start, end: state.end, todo: false };
    let valido = true;
    let base = PER.somaMeses(PER.primeiroDoMes(hojeIso()), -1); // primeiro dos 2 meses mostrados
    let ini = null, hover = null, foco = null; // calendário: ini = primeiro clique à espera do segundo

    $('c-atalhos').innerHTML = PER.GRUPOS.map((g, i) => `<div class="per-grupo" role="group" aria-labelledby="c-g${i}"><p class="fc-rotulo" id="c-g${i}">${g}</p>${
      PER.ATALHOS.filter((a) => a.grupo === g).map((a) => `<button type="button" class="per-atalho" data-atalho="${a.id}" aria-pressed="false">${a.nome}</button>`).join('')}</div>`).join('');

    // ---- calendário de 2 meses: o primeiro clique marca o início, o segundo o fim; passar o mouse mostra a faixa
    function mesHtml(m, k) {
      const [a, mm] = PER.partes(m);
      const vazios = (new Date(Date.UTC(a, mm - 1, 1)).getUTCDay() + 6) % 7;
      let cel = '<span></span>'.repeat(vazios);
      for (let d = 1; d <= PER.ultimoDia(a, mm); d++) {
        cel += `<button type="button" class="per-dia" data-iso="${PER.monta(a, mm, d)}" aria-label="${d} de ${MESES_POR_EXTENSO[mm - 1]} de ${a}" aria-pressed="false" tabindex="-1">${d}</button>`;
      }
      const esq = k === 0 ? `<button type="button" class="per-nav" data-dir="-1" aria-label="Mês anterior">${SETA_ESQ}</button>` : '<span class="per-nav-vazio"></span>';
      const dir = k === 1 ? `<button type="button" class="per-nav" data-dir="1" aria-label="Próximo mês">${SETA_DIR}</button>` : '<span class="per-nav-vazio"></span>';
      return `<div class="per-mes"><div class="per-mes-cab">${esq}<span class="per-mes-nome">${MESES_POR_EXTENSO[mm - 1]} de ${a}</span>${dir}</div>
        <div class="per-dias-sem" aria-hidden="true"><span>seg</span><span>ter</span><span>qua</span><span>qui</span><span>sex</span><span>sáb</span><span>dom</span></div>
        <div class="per-grade">${cel}</div></div>`;
    }
    function desenhaCalendario() {
      host.innerHTML = `<div class="per-meses">${[0, 1].map((k) => mesHtml(PER.somaMeses(base, k), k)).join('')}</div>`;
      pintaCalendario();
    }
    function pintaCalendario() {
      let s = pend.start, e = pend.end;
      if (ini !== null) { const h = hover || ini; s = ini < h ? ini : h; e = ini < h ? h : ini; }
      const hj = hojeIso();
      const dias = Array.from(host.querySelectorAll('.per-dia'));
      const alvo = dias.some((b) => b.dataset.iso === foco) ? foco : (dias[0] && dias[0].dataset.iso);
      dias.forEach((b) => {
        const i = b.dataset.iso;
        const dentro = i >= s && i <= e;
        b.classList.toggle('na-faixa', dentro);
        b.classList.toggle('ini', i === s);
        b.classList.toggle('fim', i === e);
        b.classList.toggle('hoje', i === hj);
        b.setAttribute('aria-pressed', String(dentro));
        b.tabIndex = i === alvo ? 0 : -1;
      });
    }
    function irPara(iso) { base = PER.somaMeses(PER.primeiroDoMes(iso), -1); desenhaCalendario(); } // o dia fica no 2º mês
    function garanteVisivel(iso) {
      const m = PER.primeiroDoMes(iso);
      const ultimo = PER.somaMeses(base, 1);
      let novo = base;
      if (m < base) novo = m;
      else if (m > ultimo) novo = PER.somaMeses(m, -1);
      if (novo !== base) { base = novo; desenhaCalendario(); }
    }
    function descartaCliqueNoCalendario() { ini = null; hover = null; pintaCalendario(); }

    // ---- painel
    function atualizaPend(escreveInputs) {
      if (escreveInputs) {
        iIni.value = fmtData(pend.start); iFim.value = fmtData(pend.end);
        iIni.removeAttribute('aria-invalid'); iFim.removeAttribute('aria-invalid');
        erro.textContent = '';
      }
      const primeiro = primeiroDado();
      const ativo = PER.atalhoAtivo(pend, hojeIso(), primeiro);
      botoes('.per-atalho').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.atalho === ativo)));
      $('c-cmp').textContent = valido ? PER.comparaCom(pend, primeiro) : 'Informe as duas datas.';
      aplicar.disabled = !valido;
      pintaCalendario();
    }
    function abre() {
      if (aberto) return;
      pend = { start: state.start, end: state.end, todo: state.todo };
      valido = true;
      pop.querySelector('[data-atalho=todo]').disabled = !primeiroDado();
      pop.hidden = false; aberto = true;
      gatilho.setAttribute('aria-expanded', 'true');
      descartaCliqueNoCalendario(); irPara(pend.end); atualizaPend(true);
    }
    function fecha(devolveFoco) {
      if (!aberto) return;
      pop.hidden = true; aberto = false;
      gatilho.setAttribute('aria-expanded', 'false');
      if (devolveFoco) gatilho.focus();
    }
    gatilho.addEventListener('click', () => (aberto ? fecha(true) : abre()));
    // captura: o alvo ainda está no DOM mesmo se o calendário se redesenhar no clique
    document.addEventListener('click', (e) => { if (aberto && !pop.contains(e.target) && !gatilho.contains(e.target)) fecha(false); }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && aberto) { e.preventDefault(); fecha(true); } });

    host.addEventListener('click', (e) => {
      const nav = e.target.closest('.per-nav');
      if (nav) {
        base = PER.somaMeses(base, Number(nav.dataset.dir));
        desenhaCalendario();
        const igual = host.querySelector(`.per-nav[data-dir="${nav.dataset.dir}"]`);
        if (igual) igual.focus();
        return;
      }
      const b = e.target.closest('.per-dia');
      if (!b) return;
      const iso = b.dataset.iso;
      foco = iso;
      if (ini === null) { ini = iso; hover = iso; pintaCalendario(); return; }
      const s = ini < iso ? ini : iso, f = ini < iso ? iso : ini;
      ini = null; hover = null;
      pend = { start: s, end: f, todo: false }; valido = true;
      atualizaPend(true);
    });
    host.addEventListener('mouseover', (e) => {
      const b = e.target.closest('.per-dia');
      if (b && ini !== null && hover !== b.dataset.iso) { hover = b.dataset.iso; pintaCalendario(); }
    });
    host.addEventListener('focusin', (e) => {
      const b = e.target.closest('.per-dia');
      if (!b) return;
      foco = b.dataset.iso;
      if (ini !== null) hover = foco;
      pintaCalendario();
    });
    host.addEventListener('keydown', (e) => {
      const b = e.target.closest('.per-dia');
      if (!b) return;
      const iso = b.dataset.iso;
      const alvo = { ArrowLeft: PER.somaDias(iso, -1), ArrowRight: PER.somaDias(iso, 1), ArrowUp: PER.somaDias(iso, -7), ArrowDown: PER.somaDias(iso, 7), PageUp: PER.somaMeses(iso, -1), PageDown: PER.somaMeses(iso, 1) }[e.key];
      if (!alvo) return;
      e.preventDefault();
      foco = alvo;
      garanteVisivel(alvo);
      const novo = host.querySelector(`.per-dia[data-iso="${alvo}"]`);
      if (novo) novo.focus();
    });

    // ---- Início e Fim digitados (dd/mm/aaaa, com máscara)
    function aoDigitar() {
      const s = PER.parseBR(iIni.value), f = PER.parseBR(iFim.value);
      let msg = '';
      valido = false;
      if (s && f) {
        if (s <= f) { pend = { start: s, end: f, todo: false }; valido = true; descartaCliqueNoCalendario(); garanteVisivel(f); } else msg = 'A data final vem antes da inicial.';
      } else if ((iIni.value.length === 10 && !s) || (iFim.value.length === 10 && !f)) {
        msg = 'Use dd/mm/aaaa, com uma data que existe.';
      }
      erro.textContent = msg;
      iIni.setAttribute('aria-invalid', String(iIni.value.length === 10 && (!s || !!msg)));
      iFim.setAttribute('aria-invalid', String(iFim.value.length === 10 && (!f || !!msg)));
      atualizaPend(false);
    }
    for (const inp of [iIni, iFim]) {
      inp.addEventListener('input', () => {
        let v = inp.value.replace(/\D/g, '').slice(0, 8);
        if (v.length > 4) v = `${v.slice(0, 2)}/${v.slice(2, 4)}/${v.slice(4)}`;
        else if (v.length > 2) v = `${v.slice(0, 2)}/${v.slice(2)}`;
        inp.value = v;
        aoDigitar();
      });
    }

    $('c-atalhos').addEventListener('click', (e) => {
      const b = e.target.closest('.per-atalho');
      if (!b || b.disabled) return;
      pend = PER.calcAtalho(b.dataset.atalho, hojeIso(), primeiroDado()); valido = true;
      descartaCliqueNoCalendario(); irPara(pend.end); atualizaPend(true);
    });
    $('c-cancelar').addEventListener('click', () => fecha(true));
    aplicar.addEventListener('click', () => {
      if (!valido) return;
      state.start = pend.start; state.end = pend.end; state.todo = !!pend.todo;
      mostraPeriodo();
      fecha(true);
      agenda(true);
    });
  }

  // ------------------------------------------------------------ eventos
  function ligaEventos() {
    $('btn-login').addEventListener('click', pedeLogin);

    document.querySelectorAll('[data-pagina]').forEach((b) => b.addEventListener('click', () => {
      if (state.pagina === b.dataset.pagina) return;
      mudaPagina(b.dataset.pagina);
      recarrega(true);
    }));

    document.querySelectorAll('[data-basis]').forEach((b) => b.addEventListener('click', () => {
      if (state.basis === b.dataset.basis) return;
      state.basis = b.dataset.basis;
      document.querySelectorAll('[data-basis]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      recarrega(true);
    }));

    document.querySelectorAll('[data-grao]').forEach((b) => b.addEventListener('click', () => {
      if (state.grain === b.dataset.grao) return;
      state.grain = b.dataset.grao;
      atualizaTituloDetalhe();
      agenda(false);
    }));

    document.querySelectorAll('[data-aba]').forEach((b) => b.addEventListener('click', () => {
      state.aba = b.dataset.aba;
      if ($('painel').classList.contains('carregando')) atualizaTituloDetalhe(); // a tabela vem com a resposta
      else renderDetalhe();
    }));

    // Ritmo e histórico: alternância ROAS/CAC, 3/6/12 meses, mês lido, tabela e nova tentativa. Nenhum grava nem reconsulta (só a nova tentativa).
    const refoca = (sel) => { const b = document.querySelector(sel); if (b) b.focus(); };
    $('pg-funil').addEventListener('click', (e) => {
      const b = e.target.closest('#bloco-ritmo button, #bloco-historico button');
      if (!b) return;
      if (b.dataset.modo) { state.modo = b.dataset.modo; renderMensal(); refoca(`[data-modo="${state.modo}"]`); return; }
      if (b.dataset.meses) { state.meses = Number(b.dataset.meses); renderMensal(); refoca(`[data-meses="${state.meses}"]`); return; }
      if (b.dataset.act === 'tab-hist') { state.tabHist = !state.tabHist; renderMensal(); refoca('[data-act="tab-hist"]'); return; }
      if (b.dataset.act === 'tentar-mensal') { carregaMensal(); return; }
      if (b.dataset.mes) {
        state.mesSel = b.dataset.mes;
        document.querySelectorAll('.hist-mes').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
        document.querySelector('.hist-leitura').innerHTML = leituraMes(state.mesSel, ritmoDados());
      }
    });

    $('btn-filtros').addEventListener('click', () => {
      const painel = $('painel-filtros');
      painel.hidden = !painel.hidden;
      $('btn-filtros').setAttribute('aria-expanded', String(!painel.hidden));
    });

    document.querySelectorAll('.acc').forEach((b) => b.addEventListener('click', () => {
      const abre = b.getAttribute('aria-expanded') !== 'true';
      b.setAttribute('aria-expanded', String(abre));
      $(b.getAttribute('aria-controls')).hidden = !abre;
    }));

    $('btn-sair').addEventListener('click', () => {
      limpaToken();
      token = null;
      seq++;
      mostraLogin();
      if (!FIXTURE) iniciaLogin();
    });

    $('btn-conta').addEventListener('click', () => {
      const abre = $('conta-painel').hidden;
      $('conta-painel').hidden = !abre;
      $('btn-conta').setAttribute('aria-expanded', String(abre));
    });
    $('btn-mais').addEventListener('click', () => {
      const abre = $('mais-painel').hidden;
      $('mais-painel').hidden = !abre;
      $('btn-mais').setAttribute('aria-expanded', String(abre));
    });
    $('btn-mais-conta').addEventListener('click', () => { $('mais-painel').hidden = true; $('btn-mais').setAttribute('aria-expanded', 'false'); $('btn-conta').click(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('conta-painel').hidden) { $('conta-painel').hidden = true; $('btn-conta').setAttribute('aria-expanded', 'false'); $('btn-conta').focus(); } });
    document.addEventListener('click', (e) => { if (!e.target.closest('[data-menu="conta"]') && !$('conta-painel').hidden) { $('conta-painel').hidden = true; $('btn-conta').setAttribute('aria-expanded', 'false'); } });
    $('c-tema').addEventListener('change', (e) => window.FcTema.troca(e.target.value));
    document.addEventListener('fc-tema', ligaTemaPainel);
    $('lk-marca').addEventListener('click', (e) => { e.preventDefault(); if (state.pagina !== 'hoje') { mudaPagina('hoje'); recarrega(true); } });

    $('c-tenant').addEventListener('change', (e) => {
      state.tenant = e.target.value;
      guardaTenantNaUrl();
      atualizaTitulo();
      for (const k of Object.keys(state.filters)) state.filters[k] = []; // as opções mudam por cliente
      state.canal = [];
      state.options = {};
      state.mensal = null;
      state.mesSel = null;
      if (state.todo) { // "Todo o período" acompanha o primeiro dado do novo cliente; sem ele, o período fica como está
        const primeiro = primeiroDado();
        if (primeiro) { state.start = primeiro; state.end = hojeIso(); } else state.todo = false;
        mostraPeriodo();
      }
      renderFiltros();
      recarrega(true);
    });

    ligaPeriodo();

    for (const host of [$('filtro-canal'), $('filtros')]) host.addEventListener('change', (e) => {
      const caixa = e.target.closest('details');
      if (!caixa || e.target.type !== 'checkbox') return;
      const chave = caixa.dataset.filtro;
      if (chave === 'canal') {
        state.canal = [...caixa.querySelectorAll('input:checked')].map((i) => i.value);
        for (const l of Object.keys(LISTAS)) state.lists[l].page = 0;
        atualizaResumoFiltro('canal');
        const sql = canaisParaSql().join();
        if (sql && sql !== canaisConsultados) return agenda(false); // seleção parcial nova: a visão 'selected' vem de uma consulta
        if ($('painel').classList.contains('carregando')) aplicaCanal(); // a tela vem com a resposta
        else renderTudo();
        return;
      }
      state.filters[chave] = [...caixa.querySelectorAll('input:checked')].map((i) => i.value);
      atualizaResumoFiltro(chave);
      atualizaAvisos();
      agenda(false);
    });

    document.addEventListener('click', (e) => {
      const alvo = e.target.closest('details.filtro');
      document.querySelectorAll('details.filtro[open]').forEach((d) => { if (d !== alvo) d.removeAttribute('open'); });
    });

    for (const chave of Object.keys(LISTAS)) {
      $(LISTAS[chave].bloco).querySelector('.pag').addEventListener('click', (e) => {
        const act = e.target.dataset && e.target.dataset.act;
        if (!act) return;
        state.lists[chave].page += act === 'next' ? 1 : -1;
        renderLista(chave);
      });
    }
  }

  // O painel só tem A e B (Felipe, 13/11/2026). O tema.js canônico guarda A, B ou E para tudo: um E salvo (do kit) abre o painel no A.
  // O painel-x.css (componentes do painel) acompanha o tema-x.css que o tema.js troca.
  function ligaTemaPainel() {
    let t = window.FcTema.atual();
    if (t !== 'a' && t !== 'b') { window.FcTema.troca('a'); return; } // a troca dispara o evento de novo, já com 'a'
    const l = $('painel-tema');
    const novo = l.getAttribute('href').replace(/painel-[a-z]\.css/, `painel-${t}.css`);
    if (l.getAttribute('href') !== novo) l.setAttribute('href', novo);
    $('c-tema').value = t;
  }

  // ------------------------------------------------------------ Hoje e Clientes (todos os clientes de uma vez)
  // O desenho e a regra de "o que precisa de você" moram em hoje.js. Aqui: as fontes (cada uma falha sozinha) e o login.
  // Fontes: clientes (tenants), quadro de setup mais os eventos depois da foto, pacientes e cirurgias de todos os clientes (sem @tenant),
  // e o estado do acompanhamento (action=state) de cada cliente que tem pacientes.
  let seqHoje = 0;
  const FONTES_HOJE = [
    ['clientes', 'a lista de clientes', () => carregaClientes()],
    ['setup', 'o quadro de setup', () => consulta('setup_board', {})],
    ['ajustes', 'os ajustes recentes do setup', () => consulta('setup_events', {})],
    ['pacientes', 'os pacientes', () => consulta('patients_all', {})],
    ['cirurgias', 'as listas de cirurgia', () => consulta('surgeries_all', {})],
  ];

  async function carregaHoje() {
    const meu = ++seqHoje;
    const modo = state.pagina === 'clientes' ? 'clientes' : 'hoje';
    const ctx = { esc, modo, alvo: $(modo === 'clientes' ? 'clientes-corpo' : 'hoje-corpo'), hoje: hojeIso(), diasEntre, nome: rotuloCliente, atualiza: () => carregaHoje() };
    window.PainelHoje.render(null, ctx);
    const app = $('painel');
    app.classList.add('carregando');
    app.setAttribute('aria-busy', 'true');
    try {
      const rs = await Promise.allSettled(FONTES_HOJE.map((f) => f[2]()));
      if (meu !== seqHoje) return;
      if (rs.some((r) => r.status === 'rejected' && r.reason instanceof AuthError)) return; // a sessão caiu: o login já apareceu
      const falhas = [];
      const v = {};
      rs.forEach((r, i) => {
        if (r.status === 'rejected') falhas.push({ fonte: FONTES_HOJE[i][0], rotulo: FONTES_HOJE[i][1] });
        else v[FONTES_HOJE[i][0]] = r.value;
      });
      if (falhas.length === FONTES_HOJE.length) { window.PainelHoje.render(false, ctx); return; }
      const pacientes = v.pacientes || [];
      const donos = [...new Set(pacientes.map((p) => p.tenant))];
      const estados = {};
      const sem = [];
      const es = await Promise.allSettled(donos.map((t) => acaoPaciente('state', { tenant: t })));
      if (meu !== seqHoje) return;
      if (es.some((r) => r.status === 'fulfilled' && r.value.semLogin)) return;
      es.forEach((r, i) => {
        const resp = r.status === 'fulfilled' && r.value.resp && r.value.resp.status === 'ok' ? r.value.resp : null;
        if (resp) estados[donos[i]] = resp; else sem.push(rotuloCliente(donos[i]));
      });
      if (sem.length) falhas.push({ fonte: 'acompanhamento', rotulo: `o acompanhamento de ${sem.join(', ')}` });
      window.PainelHoje.render({
        tenants: state.tenants || [], foto: (v.setup || [])[0] || null, eventos: v.ajustes || [], pacientes, cirurgias: v.cirurgias || [],
        estados, falhas, lidoEm: new Date(),
      }, ctx);
    } catch (e) {
      if (e instanceof AuthError) return;
      if (meu === seqHoje) window.PainelHoje.render(false, ctx);
    } finally {
      if (meu === seqHoje) {
        app.classList.remove('carregando');
        app.removeAttribute('aria-busy');
      }
    }
  }

  function inicia() {
    ligaTemaPainel();
    mostraPeriodo();
    renderSeletor();
    renderFiltros();
    renderCartoes(true);
    renderMensal();
    atualizaTituloDetalhe();
    $('selo-exemplo').hidden = !FIXTURE;
    mudaPagina(state.pagina);
    atualizaAvisos();
    ligaEventos();
    if (FIXTURE) {
      mostraPainel();
      recarrega(true);
      return;
    }
    const jaEntrou = !!lerRegistro();
    token = lerToken();
    if (token) {
      mostraPainel();
      recarrega(true);
      agendaRenovacao();
      iniciaLogin();
    } else if (jaEntrou) {
      mostraLogin('Renovando o login...');
      iniciaLogin('silencioso');
    } else {
      mostraLogin();
      iniciaLogin();
    }
  }

  inicia();
})();
