// Painel de funil por cliente (tenant). Consulta o BigQuery ao vivo com o login Google de quem abre a página.
// Todas as contas ficam nos .sql; aqui só se consulta, converte e formata.
(function () {
  'use strict';

  const CFG = window.PAINEL_CONFIG;
  const FIXTURE = new URLSearchParams(location.search).get('fixture') === '1';
  const SCOPE = 'https://www.googleapis.com/auth/bigquery.readonly';
  const TOKEN_KEY = 'painel_token';
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
  const FAIXA = [['spend', 'Gasto', 'money', '', null], ['cpa', 'CPA (por marcação)', 'money', '', false], ['roas_honorario', 'ROAS do honorário', 'ratio', 'x', true]];
  const FAIXA_DE_MIDIA = ['spend', 'cpa', 'roas_honorario'];

  const TIPO_MARCACAO = { scheduled: 'Agendamento', referral: 'Encaminhamento' };
  const LISTAS = {
    completed: {
      bloco: 'bloco-realizados', sql: 'completed',
      cols: [['metric_date', 'Data', 'date'], ['patient_name', 'Paciente', 'txt'], ['procedure_name', 'Procedimento', 'txt'], ['location', 'Local', 'txt'], ['modality', 'Modalidade', 'txt'], ['payer', 'Convênio', 'txt'], ['attribution', 'Atribuição', 'txt'], ['lead_campaign', 'Campanha', 'txt'], ['lead_ad_group', 'Grupo', 'txt'], ['billed_amount', 'Faturado', 'money'], ['physician_fee', 'Honorário', 'money']],
    },
    marked: {
      bloco: 'bloco-marcacoes', sql: 'marked',
      cols: [['metric_date', 'Data', 'date'], ['marking_type', 'Tipo', 'tipo'], ['patient_name', 'Paciente', 'txt'], ['procedure_name', 'Procedimento', 'txt'], ['location', 'Local', 'txt'], ['modality', 'Modalidade', 'txt'], ['payer', 'Convênio', 'txt'], ['attribution', 'Atribuição', 'txt'], ['lead_campaign', 'Campanha', 'txt'], ['lead_ad_group', 'Grupo', 'txt'], ['source', 'Origem', 'txt'], ['referred_to', 'Encaminhado para', 'txt'], ['reason', 'Motivo', 'txt']],
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

  // ------------------------------------------------------------ estado
  const state = {
    tenant: new URLSearchParams(location.search).get('tenant') || CFG.TENANT,
    tenants: null, // [{tenant, n, spend_rows}] do tenants.sql, carregado uma vez
    basis: 'event',
    aba: 'custo',
    start: periodoPadrao()[0],
    end: periodoPadrao()[1],
    grain: 'week',
    filters: Object.fromEntries(FILTROS.map(([k]) => [k, []])),
    options: {},
    funnel: [],
    lists: { completed: { rows: [], page: 0 }, marked: { rows: [], page: 0 } },
  };
  let seq = 0;
  let token = null;
  let tokenClient = null;
  const sqlCache = {};
  if (FIXTURE) window.__consultas = [];

  // ------------------------------------------------------------ login (Google Identity Services)
  class AuthError extends Error {}

  function lerToken() {
    try {
      const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY));
      if (t && t.value && t.exp > Date.now() + 30000) return t;
    } catch (e) { /* sem sessionStorage: segue sem token */ }
    return null;
  }

  function guardaToken(t) {
    token = t;
    try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify(t)); } catch (e) { /* ok */ }
  }

  function limpaToken() {
    token = null;
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* ok */ }
  }

  function mostraLogin(msg) {
    $('painel').hidden = true;
    $('login').hidden = false;
    $('btn-sair').hidden = true;
    $('estado-login').textContent = 'Sem login';
    $('login-msg').textContent = msg || 'Entre com a conta Google que tem acesso ao BigQuery.';
  }

  function mostraPainel() {
    $('login').hidden = true;
    $('painel').hidden = false;
    $('btn-sair').hidden = false;
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

  async function iniciaLogin() {
    if (CFG.CLIENT_ID === 'PREENCHER') {
      mostraLogin('Falta configurar o CLIENT_ID em config.js.');
      return;
    }
    try {
      await carregaGIS();
    } catch (e) {
      mostraLogin(e.message);
      return;
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CFG.CLIENT_ID,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error || !resp.access_token) {
          mostraLogin('Login não concluído. Tente de novo.');
          return;
        }
        guardaToken({ value: resp.access_token, exp: Date.now() + Number(resp.expires_in || 3600) * 1000 });
        mostraPainel();
        recarrega(true);
      },
      error_callback: () => mostraLogin('Login não concluído. Tente de novo.'),
    });
  }

  function pedeLogin() {
    if (FIXTURE) { mostraPainel(); recarrega(true); return; }
    if (tokenClient) tokenClient.requestAccessToken({ prompt: '' });
    else iniciaLogin();
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
      limpaToken();
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

  async function textoSql(nome) {
    if (!sqlCache[nome]) {
      sqlCache[nome] = fetch(`sql/${nome}.sql`).then((r) => {
        if (!r.ok) throw new Error(`Não achei sql/${nome}.sql`);
        return r.text();
      });
    }
    return sqlCache[nome];
  }

  async function bqQuery(nome, params) {
    const [prelude, sql] = await Promise.all([textoSql('_prelude'), textoSql(nome)]);
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

  async function fixture(nome) {
    const r = await fetch(`fixtures/${nome}.json`);
    if (!r.ok) throw new Error(`Não achei fixtures/${nome}.json`);
    const resp = await r.json();
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
        return await fixture(['completed', 'marked', 'options', 'tenants'].includes(nome) ? nome : 'funnel');
      }
      return await bqQuery(nome, params);
    } finally {
      emConsulta(-1);
    }
  }

  // Mesmos parâmetros em todas as consultas; os 7 arrays vão sempre, mesmo vazios.
  function parametros() {
    return { tenant: state.tenant, start_date: state.start, end_date: state.end, grain: state.grain, basis: state.basis, ...state.filters };
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
  const contraAnterior = (frac, bomSobe) => variacao(frac, bomSobe) + (frac === null || frac === undefined ? '' : ' <span class="peq">contra o anterior</span>');

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
    const pts = per.map((r, i) => [i, r[campo]]).filter(([, v]) => v !== null && v !== undefined);
    if (pts.length < 3) return '<div class="spark"></div>';
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

  function faixaHtml([campo, rotulo, tipo, unidade, bomSobe], total, esperando) {
    if (esperando) return `<div class="faixa-cartao fc-cartao" data-card="${campo}"><div class="txt"><p class="fc-rotulo">${esc(rotulo)}</p><p class="num" aria-hidden="true">${ESQ_NUM}</p></div></div>`;
    const valor = total ? total[campo] : null;
    const nota = semMidia() && FAIXA_DE_MIDIA.includes(campo) ? '<p class="fc-legenda">sem dado de mídia</p>' : '';
    const dlt = total && valor !== null && valor !== undefined ? `<span class="linha">${contraAnterior(total[`${campo}_chg`], bomSobe)}</span>` : '';
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
    document.querySelector('#bloco-detalhe .rolagem').innerHTML = ESQUELETO_TABELA;
    for (const chave of Object.keys(LISTAS)) {
      const bloco = $(LISTAS[chave].bloco);
      bloco.querySelector('.rolagem').innerHTML = ESQUELETO_TABELA;
      bloco.querySelector('.pag').innerHTML = '';
      bloco.querySelector('.hint').textContent = '';
    }
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
    if (n === null || n === undefined) return `${NF0.format(state.lists[chave].rows.length)} linhas`;
    return `${NF0.format(n)} ${n === 1 ? 'paciente' : 'pacientes'}`;
  }

  function renderLista(chave) {
    const def = LISTAS[chave];
    const est = state.lists[chave];
    const bloco = $(def.bloco);
    const total = est.rows.length;
    const paginas = Math.max(1, Math.ceil(total / PAGE_SIZE));
    est.page = Math.min(est.page, paginas - 1);
    const fatia = est.rows.slice(est.page * PAGE_SIZE, (est.page + 1) * PAGE_SIZE);
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

  function renderTudo() {
    renderCartoes();
    renderDetalhe();
    renderLista('completed');
    renderLista('marked');
  }

  // ------------------------------------------------------------ filtros
  const CHEVRON = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 5l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function resumoFiltro(chave) {
    const sel = state.filters[chave];
    if (!sel.length) return FILTROS.find((f) => f[0] === chave)[2];
    return sel.length === 1 ? sel[0] : `${sel.length} selecionados`;
  }

  function renderFiltros() {
    const caixa = $('filtros');
    const abertos = new Set([...caixa.querySelectorAll('details[open]')].map((d) => d.dataset.filtro));
    caixa.innerHTML = FILTROS.map(([chave, rotulo]) => {
      const opcoes = (state.options[chave] || []).slice();
      for (const v of state.filters[chave]) if (!opcoes.some((o) => o.value === v)) opcoes.push({ value: v, n: 0 });
      const marcados = new Set(state.filters[chave]);
      const itens = opcoes.length
        ? opcoes.map((o) => `<label><input type="checkbox" value="${esc(o.value)}" ${marcados.has(o.value) ? 'checked' : ''}> <span>${esc(o.value)}</span><span class="n">${NF0.format(o.n)}</span></label>`).join('')
        : '<div class="vazio">Sem valores no período.</div>';
      return `<div class="filtro-campo"><span class="fc-rotulo">${esc(rotulo)}</span><details class="filtro" id="f-${chave}" data-filtro="${chave}" ${abertos.has(chave) ? 'open' : ''}><summary><span class="val">${esc(resumoFiltro(chave))}</span>${CHEVRON}</summary><div class="opcoes">${itens}</div></details></div>`;
    }).join('');
    atualizaContadorFiltros();
  }

  function atualizaContadorFiltros() {
    const n = FILTROS.filter(([k]) => state.filters[k].length > 0).length;
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
      const [funil, realizados, marcacoes, opcoes] = await Promise.all([
        consulta('funnel', p),
        consulta('completed', p),
        consulta('marked', p),
        comOpcoes ? consulta('options', p) : Promise.resolve(null),
      ]);
      if (meu !== seq) return;
      state.funnel = funil;
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
        state.funnel = [];
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
    atualizaAvisos();
    ligaEventos();
    if (FIXTURE) {
      mostraPainel();
      recarrega(true);
      return;
    }
    token = lerToken();
    if (token) {
      mostraPainel();
      recarrega(true);
    } else {
      mostraLogin();
      iniciaLogin();
    }
  }

  inicia();
})();
