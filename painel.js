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
    custo: [['cpm', 'CPM', 'money'], ['cpc', 'CPC', 'money'], ['cpl', 'CPL', 'money'], ['cpa', 'CPA', 'money'], ['cpr', 'CPR', 'money'], ['roas_honorario', 'ROAS honorário', 'x'], ['roi', 'ROI', 'roi']],
    conv: [['ctr', 'CTR', 'pct'], ['click_to_lead', 'Clique para lead', 'pct'], ['lead_to_marked', 'Lead para marcação', 'pct'], ['marked_to_completed', 'Marcação para realizado', 'pct'], ['completed_to_upsell', 'Realizado para upsell', 'pct'], ['avg_ticket', 'Ticket médio', 'money', true], ['avg_fee', 'Honorário médio', 'money', true]],
    vol: [['spend', 'Investimento', 'money'], ['impressions', 'Impressões', 'int'], ['clicks', 'Cliques', 'int'], ['leads', 'Leads', 'int'], ['marked_patients', 'Marcações', 'int'], ['scheduled_patients', 'Agendamentos', 'int'], ['completed_patients', 'Realizados', 'int'], ['billed_amount', 'Faturado', 'money'], ['physician_fee', 'Honorário', 'money']],
  };
  const GRAO_TXT = { day: 'dia', week: 'semana', month: 'mês' };

  // Etapas do funil, na ordem. Tudo vem pronto do funnel.sql (taxa, custo, % dos leads, variação); aqui só se escolhe o campo.
  // volume e variação: campo e campo_chg; custo e variação: custo e custo_chg; "% dos leads": parte.
  const ETAPAS = [
    { campo: 'leads', rotulo: 'Leads', custo: 'cpl', custoRotulo: 'Custo por lead', parte: 'leads_of_leads' },
    { campo: 'marked_patients', rotulo: 'Marcações', custo: 'cpa', custoRotulo: 'Custo por marcação (CPA)', parte: 'marked_of_leads' },
    { campo: 'scheduled_patients', rotulo: 'Agendamentos', custo: 'cost_per_scheduled', custoRotulo: 'Custo por agendamento', parte: 'scheduled_of_leads' },
    { campo: 'completed_patients', rotulo: 'Realizados', custo: 'cpr', custoRotulo: 'Custo por realizado', parte: 'completed_of_leads' },
  ];
  // Taxas de passagem entre uma etapa e a seguinte: campo da taxa (prev_ e _pp vêm do SQL).
  const PASSAGENS = ['lead_to_marked', 'marked_to_scheduled', 'scheduled_to_completed'];
  // Faixa de baixo: [campo, rótulo, formato, unidade, quando "sobe" é bom]. null = neutro (gastar mais não é bom nem ruim).
  // O sexto item é a variação: omitido = relativa (campo_chg); 'pp' = pontos percentuais (campo_pp). ROI usa pp: a variação relativa de um número que cruza o zero não faz sentido.
  const FAIXA = [['spend', 'Gasto', 'money', '', null], ['cpa', 'CPA (por marcação)', 'money', '', false], ['roas_honorario', 'ROAS do honorário', 'ratio', 'x', true], ['roi', 'ROI', 'roi', '', true, 'pp']];
  const FAIXA_DE_MIDIA = ['spend', 'cpa', 'roas_honorario', 'roi'];
  // Bloco "Por canal": [campo, título, formato]. A linha de cada canal é a linha 'total' dele no funnel.sql.
  const COLS_CANAIS = [['spend', 'Gasto', 'money'], ['scheduled_patients', 'Agendamentos', 'int'], ['completed_patients', 'Consultas', 'int'], ['physician_fee', 'Honorário', 'money'], ['cost_per_scheduled', 'Custo por agendamento', 'money'], ['roas_honorario', 'ROAS', 'x'], ['roi', 'ROI', 'roi']];

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
      case 'roi': return (valor > 0 ? '+' : '') + NF1.format(valor * 100) + '%'; // ROI leva sinal: +20,3% é lucro, -15,0% é prejuízo
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

  // Padrão: o último mês FECHADO pela data do dia (hoje 06/10: 01/09 a 30/09), para comparar com o mês anterior.
  // O fixture é congelado: período fixo, para os rótulos das linhas do tempo baterem com o subtítulo.
  function periodoPadrao() {
    if (FIXTURE) return FIXTURE_PERIODO;
    const h = new Date();
    return [isoLocal(new Date(h.getFullYear(), h.getMonth() - 1, 1)), isoLocal(new Date(h.getFullYear(), h.getMonth(), 0))];
  }

  // 'setup' só se abre pela URL (?pagina=setup): o quadro é do Felipe e não aparece no menu de quem recebe o painel.
  function paginaDaUrl() {
    const p = new URLSearchParams(location.search).get('pagina');
    return p === 'cirurgias' || p === 'setup' || p === 'pacientes' ? p : 'funil';
  }

  // ------------------------------------------------------------ estado
  const state = {
    tenant: new URLSearchParams(location.search).get('tenant') || CFG.TENANT,
    pagina: paginaDaUrl(),
    cirurgias: [], // linhas do surgeries.sql (último snapshot do radar)
    tenants: null, // [{tenant, n, spend_rows}] do tenants.sql, carregado uma vez
    basis: 'event',
    canal: [], // ids dos canais marcados no filtro Canal (vazio = Todos): escolhe a visão do funnel.sql (ver visaoDoCanal)
    aba: 'custo',
    start: periodoPadrao()[0],
    end: periodoPadrao()[1],
    grain: 'week',
    filters: Object.fromEntries(FILTROS.map(([k]) => [k, []])),
    options: {},
    funnel: [],
    canais: [], // linhas do funnel.sql em todos os canais (e na visão 'all')
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
    $('nav-pagina').hidden = true;
    $('estado-login').textContent = 'Sem login';
    $('login-msg').textContent = msg || 'Entre com a conta Google que tem acesso ao BigQuery.';
  }

  function mostraPainel() {
    $('login').hidden = true;
    $('painel').hidden = false;
    $('btn-sair').hidden = false;
    $('nav-pagina').hidden = false;
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
          guardaToken({ value: resp.access_token, exp: Date.now() + Number(resp.expires_in || 3600) * 1000 });
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
    tokenClient.requestAccessToken({ prompt: '' });
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
        if (nome === 'patients') return await fixtureBruto('patients');
        if (nome === 'messages') return (await fixtureBruto('messages')).filter((m) => m.phone_key === params.phone_key).sort((a, b) => (a.sent_at || '').localeCompare(b.sent_at || '') || a.seq - b.seq);
        return await fixture(['completed', 'marked', 'options', 'tenants', 'surgeries', 'setup_board', 'setup_events'].includes(nome) ? nome : 'funnel');
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

  // Rótulo do eixo: mês, ou dd/mm. Semana que começa antes da data inicial mostra a data inicial (o que de fato entrou no período).
  const rotuloCurto = (period, grao) => {
    if (!ISO.test(period)) return '';
    if (grao === 'month') return MESES[Number(period.slice(5, 7)) - 1];
    const dia = grao === 'week' && period < state.start ? state.start : period;
    return `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
  };

  // Último dia coberto pelo período que começa em `period`.
  function fimDoPeriodo(period, grao) {
    const d = dataDeISO(period);
    if (grao === 'month') return isoLocal(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    return isoLocal(new Date(d.getFullYear(), d.getMonth(), d.getDate() + (grao === 'week' ? 6 : 0)));
  }

  // Linha do tempo por período (a série do funnel.sql). Escala a partir do zero (a altura é proporcional ao valor);
  // menos de 3 pontos não forma tendência, então não há linha; o último período, se a data final o corta, vai tracejado.
  function spark(campo, escuro) {
    const per = periodosFunil();
    const brutos = per.map((r, i) => [i, r[campo]]).filter(([, v]) => v !== null && v !== undefined);
    if (brutos.length < 3) return '<div class="spark"></div>';
    const piso = Math.min(0, ...brutos.map(([, v]) => v)); // ROI pode ficar negativo: o piso desce até o menor valor; sem negativo, o piso é o zero
    const pts = brutos.map(([i, v]) => [i, v - piso]);
    const hi = Math.max(...pts.map(([, v]) => v));
    const i0 = pts[0][0], i1 = pts[pts.length - 1][0];
    const xy = pts.map(([i, v]) => [((i - i0) / (i1 - i0)) * 100, 8 + (hi > 0 ? v / hi : 0) * 84]);
    const ponto = ([x, y]) => `${x.toFixed(1)},${(100 - y).toFixed(1)}`;
    const incompleto = i1 === per.length - 1 && fimDoPeriodo(per[i1].period, state.grain) > state.end;
    const solido = (incompleto ? xy.slice(0, -1) : xy).map(ponto).join(' ');
    const tracejado = incompleto ? `<polyline class="tracejado" points="${xy.slice(-2).map(ponto).join(' ')}"/>` : '';
    const [ux, uy] = xy[xy.length - 1];
    return `<div class="spark${escuro ? ' escuro' : ''}"><div class="area"><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Tendência por período"><polyline class="solido" points="${solido}"/>${tracejado}</svg><span class="ponta${incompleto ? ' parcial' : ''}" aria-hidden="true" style="left:${ux.toFixed(1)}%;bottom:${uy.toFixed(1)}%"></span></div><div class="eixo"><span>${esc(rotuloCurto(per[i0].period, state.grain))}</span><span>${esc(rotuloCurto(per[i1].period, state.grain))}</span></div></div>`;
  }

  const SETA = '<svg class="seta" width="56" height="14" viewBox="0 0 56 14" aria-hidden="true"><path d="M2 7h50M46 2l6 5-6 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ESQ_NUM = '<span class="esq esq-numero"></span>';

  function passoHtml(e, total, esperando) {
    if (esperando) {
      return `<div class="passo" data-card="${e.campo}"><p class="fc-rotulo">${esc(e.rotulo)}</p><p class="num vol" aria-hidden="true">${ESQ_NUM}</p><hr><div class="custo-bloco"><span class="rot">${esc(e.custoRotulo)}</span><p class="num custo" aria-hidden="true">${ESQ_NUM}</p></div></div>`;
    }
    const parte = total ? total[e.parte] : null;
    const largura = parte === null || parte === undefined ? 0 : Math.min(100, parte * 100);
    const custo = total ? total[e.custo] : null;
    const temCusto = custo !== null && custo !== undefined;
    const nota = !temCusto && semMidia() ? '<span class="peq">sem dado de mídia</span>' : '';
    const dVol = total ? `<span class="linha" data-var="vol">${contraAnterior(total[`${e.campo}_chg`], true)}</span>` : '';
    const dCusto = total && temCusto ? `<span class="linha" data-var="custo">${variacao(total[`${e.custo}_chg`], false)}</span>` : '';
    return `<div class="passo" data-card="${e.campo}"><p class="fc-rotulo">${esc(e.rotulo)}</p><p class="num vol"><span class="v">${esc(fmt(total && total[e.campo], 'int'))}</span></p>${dVol}<div class="parte"><span>${esc(fmt(parte, 'pct'))} dos leads</span><div class="barra" aria-hidden="true"><i style="width:${largura.toFixed(1)}%"></i></div></div><hr><div class="custo-bloco"><span class="rot">${esc(e.custoRotulo)}</span><p class="num custo" data-custo="${e.custo}"><span class="vc">${esc(fmt(custo, 'money'))}</span></p>${dCusto}${nota}</div>${spark(e.campo)}</div>`;
  }

  function conexaoHtml(chave, total, esperando) {
    if (esperando) return `<div class="cn" aria-hidden="true"><p class="num">${ESQ_NUM}</p>${SETA}</div>`;
    const pp = total ? total[`${chave}_pp`] : null;
    const base = pp === null || pp === undefined
      ? '<span class="sem-base">sem base</span>'
      : `<span class="antes">antes ${esc(fmt(total[`prev_${chave}`], 'pct'))}</span><span class="pp" data-var="pp">${variacao(pp, true, 'pp')}</span>`;
    const eQueda = !!total && total.biggest_drop === chave;
    const queda = eQueda ? '<span class="queda">Maior queda</span>' : '';
    return `<div class="cn${eQueda ? ' quebra' : ''}" data-passagem="${chave}"><p class="num taxa">${esc(fmt(total && total[chave], 'pct'))}</p>${SETA}${base}${queda}</div>`;
  }

  function faixaHtml([campo, rotulo, tipo, unidade, bomSobe, variacaoEm], total, esperando) {
    if (esperando) return `<div class="faixa-cartao fc-cartao" data-card="${campo}"><div class="txt"><p class="fc-rotulo">${esc(rotulo)}</p><p class="num" aria-hidden="true">${ESQ_NUM}</p></div></div>`;
    const valor = total ? total[campo] : null;
    const nota = semMidia() && FAIXA_DE_MIDIA.includes(campo) ? '<p class="fc-legenda">sem dado de mídia</p>' : '';
    const dlt = total && valor !== null && valor !== undefined ? `<span class="linha">${contraAnterior(total[`${campo}_${variacaoEm || 'chg'}`], bomSobe, variacaoEm)}</span>` : '';
    const un = unidade && valor !== null && valor !== undefined ? `<span class="un">${esc(unidade)}</span>` : '';
    return `<div class="faixa-cartao fc-cartao" data-card="${campo}"><div class="txt"><p class="fc-rotulo">${esc(rotulo)}</p><p class="num"><span class="v">${esc(fmt(valor, tipo))}</span>${un}</p>${dlt}${nota}</div>${spark(campo, true)}</div>`;
  }

  function renderCartoes(esperando) {
    const total = esperando ? null : totalFunil();
    const itens = [];
    ETAPAS.forEach((e, i) => {
      itens.push(passoHtml(e, total, esperando));
      if (i < PASSAGENS.length) itens.push(conexaoHtml(PASSAGENS[i], total, esperando));
    });
    $('cartoes').innerHTML = itens.join('');
    $('faixa').innerHTML = FAIXA.map((f) => faixaHtml(f, total, esperando)).join('');
    const sub = $('funil-sub');
    if (esperando) { sub.textContent = ''; return; }
    sub.textContent = `${subtituloComparacao(total)}. Entre as etapas, a taxa de passagem e a mudança em pontos percentuais (pp).`;
  }

  // Subtítulo do funil. Os 3 casos espelham prev_window (_prelude.sql); as datas do anterior vêm do SQL, o texto só as nomeia.
  function subtituloComparacao(total) {
    const d = (iso) => (/^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '') || []).slice(1).map(Number);
    const [ai, mi, di] = d(state.start);
    const [af, mf, df] = d(state.end);
    const atual = `De ${fmtData(state.start)} a ${fmtData(state.end)}`;
    if (!total || !total.prev_start || !total.prev_end) return atual;
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
    $('nota-canais').textContent = 'Gasto = mídia + custo fixo do canal (o valor do mês, rateado por dia). ROI = (honorário - gasto) ÷ gasto.';
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

  // ------------------------------------------------------------ página Cirurgias (só leitura)
  // O desenho mora em cirurgias.js (quem ainda pode operar, do mais quente ao mais frio, links do paciente no sistema da clínica).
  // Aqui fica o que depende do painel: login, consulta ao BigQuery, ?tenant= e o relógio.
  let seqCir = 0;
  const hojeIso = () => isoLocal(new Date());
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

  function mudaPagina(pagina) {
    state.pagina = pagina;
    $('pg-funil').hidden = pagina !== 'funil';
    $('pg-cirurgias').hidden = pagina !== 'cirurgias';
    $('pg-pacientes').hidden = pagina !== 'pacientes';
    $('pg-setup').hidden = pagina !== 'setup';
    document.querySelector('.topo-campo').hidden = pagina === 'setup'; // o quadro é de todos os clientes: sem seletor
    document.querySelectorAll('[data-pagina]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pagina === pagina)));
    const q = new URLSearchParams(location.search);
    if (pagina === 'funil') q.delete('pagina'); else q.set('pagina', pagina);
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
    const abertos = new Set([...caixa.querySelectorAll('details[open]')].map((d) => d.dataset.filtro));
    // Canal: múltipla escolha como os outros filtros, sem marcação = Todos; a lista vem dos canais que existem nos dados do período.
    const canais = (state.options.channel || []).map((o) => ({ value: o.value, n: o.n }));
    for (const c of state.canal) if (!canais.some((o) => o.value === c)) canais.push({ value: c, n: 0 });
    const campo = (chave, rotulo, opcoes, marcados, rotuloValor) => {
      const itens = opcoes.length
        ? opcoes.map((o) => `<label><input type="checkbox" value="${esc(o.value)}" ${marcados.has(o.value) ? 'checked' : ''}> <span>${esc(rotuloValor(o.value))}</span><span class="n">${NF0.format(o.n)}</span></label>`).join('')
        : '<div class="vazio">Sem valores no período.</div>';
      return `<div class="filtro-campo"><span class="fc-rotulo">${esc(rotulo)}</span><details class="filtro" id="f-${chave}" data-filtro="${chave}" ${abertos.has(chave) ? 'open' : ''}><summary><span class="val">${esc(resumoFiltro(chave))}</span>${CHEVRON}</summary><div class="opcoes">${itens}</div></details></div>`;
    };
    caixa.innerHTML = campo('canal', 'Canal', canais, new Set(state.canal), rotuloCanal) + FILTROS.map(([chave, rotulo]) => {
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
    if (state.pagina === 'cirurgias') return carregaCirurgias();
    if (state.pagina === 'pacientes') return carregaPacientes();
    if (state.pagina === 'setup') return carregaSetup();
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

    $('c-tenant').addEventListener('change', (e) => {
      state.tenant = e.target.value;
      guardaTenantNaUrl();
      for (const k of Object.keys(state.filters)) state.filters[k] = []; // as opções mudam por cliente
      state.canal = [];
      state.options = {};
      renderFiltros();
      recarrega(true);
    });

    $('c-inicio').addEventListener('change', (e) => { state.start = e.target.value; agenda(true); });
    $('c-fim').addEventListener('change', (e) => { state.end = e.target.value; agenda(true); });

    $('filtros').addEventListener('change', (e) => {
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

  function inicia() {
    $('c-inicio').value = state.start;
    $('c-fim').value = state.end;
    renderSeletor();
    renderFiltros();
    renderCartoes(true);
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
