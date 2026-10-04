// Painel de funil do Fred. Consulta o BigQuery ao vivo com o login Google de quem abre a página.
// Todas as contas ficam nos .sql; aqui só se consulta, converte e formata.
(function () {
  'use strict';

  const CFG = window.PAINEL_CONFIG;
  const FIXTURE = new URLSearchParams(location.search).get('fixture') === '1';
  const SCOPE = 'https://www.googleapis.com/auth/bigquery.readonly';
  const TOKEN_KEY = 'painel_token';
  const PAGE_SIZE = 25;
  const BQ = `https://bigquery.googleapis.com/bigquery/v2/projects/${CFG.PROJECT_ID}`;

  const FILTROS = [
    ['attribution', 'Atribuição'],
    ['procedure', 'Procedimento'],
    ['location', 'Local'],
    ['modality', 'Modalidade'],
    ['event_type', 'Tipo de evento'],
    ['campaign', 'Campanha'],
    ['ad_group', 'Grupo'],
  ];
  // Estes quatro não se aplicam ao gasto (ver sql/funnel.sql).
  const FILTROS_SEM_CUSTO = ['procedure', 'location', 'modality', 'event_type'];

  const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

  // [campo, título, formato]
  const BLOCOS = [
    { id: 'bloco-custo', cols: [['cpm', 'CPM', 'money'], ['cpc', 'CPC', 'money'], ['cpl', 'CPL', 'money'], ['cpa', 'CPA', 'money'], ['cpr', 'CPR', 'money'], ['roas_honorario', 'ROAS honorário', 'ratio']] },
    { id: 'bloco-conv', cols: [['ctr', 'CTR', 'pct'], ['click_to_lead', 'Clique para lead', 'pct'], ['lead_to_marked', 'Lead para marcação', 'pct'], ['marked_to_completed', 'Marcação para realizado', 'pct'], ['completed_to_upsell', 'Realizado para upsell', 'pct'], ['avg_ticket', 'Ticket médio por paciente', 'money', true], ['avg_fee', 'Honorário médio por paciente', 'money', true]] },
    { id: 'bloco-vol', cols: [['spend', 'Investimento', 'money'], ['impressions', 'Impressões', 'int'], ['clicks', 'Cliques', 'int'], ['leads', 'Leads', 'int'], ['marked_patients', 'Marcações', 'int'], ['scheduled_patients', 'Agendamentos', 'int'], ['completed_patients', 'Realizados', 'int'], ['billed_amount', 'Faturado', 'money'], ['physician_fee', 'Honorário', 'money']] },
  ];

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

  function hojeISO() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // ------------------------------------------------------------ estado
  const state = {
    basis: 'event',
    start: CFG.START_DEFAULT,
    end: hojeISO(),
    grain: 'month',
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
    $('login-msg').textContent = msg || 'Entre com a conta Google que tem acesso ao BigQuery.';
  }

  function mostraPainel() {
    $('login').hidden = true;
    $('painel').hidden = false;
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
    const corpo = {
      query: `${prelude}\n${sql}`,
      useLegacySql: false,
      parameterMode: 'NAMED',
      queryParameters: Object.entries(params).map(([k, v]) => param(k, v)),
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

  async function consulta(nome, params) {
    if (FIXTURE) {
      window.__consultas.push({ nome, params: JSON.parse(JSON.stringify(params)) });
      return fixture(nome === 'completed' || nome === 'marked' || nome === 'options' ? nome : 'funnel');
    }
    return bqQuery(nome, params);
  }

  // Mesmos parâmetros em todas as consultas; os 7 arrays vão sempre, mesmo vazios.
  function parametros() {
    return { tenant: CFG.TENANT, start_date: state.start, end_date: state.end, grain: state.grain, basis: state.basis, ...state.filters };
  }

  // ------------------------------------------------------------ tela
  function mostraErro(msg) {
    const e = $('erro');
    e.textContent = msg || '';
    e.hidden = !msg;
  }

  function atualizaAvisos() {
    const semCusto = FILTROS_SEM_CUSTO.some((k) => state.filters[k].length > 0);
    $('aviso-custo').hidden = !semCusto;
  }

  function celula(valor, tipo, campo, extra) {
    return `<td data-col="${campo}"><span class="v">${esc(fmt(valor, tipo))}</span>${extra || ''}</td>`;
  }

  function renderBloco(def) {
    const grao = state.grain;
    const normais = state.funnel.filter((r) => r.period !== 'total').reverse();
    const total = state.funnel.find((r) => r.period === 'total');
    const linhas = total ? normais.concat([total]) : normais;
    const cab = def.cols.map((c) => `<th>${esc(c[1])}</th>`).join('');
    const corpo = linhas.map((r) => {
      const semValor = (r.completed_patients || 0) - (r.completed_with_value || 0);
      const cels = def.cols.map(([campo, , tipo, comNota]) => {
        const nota = comNota && semValor > 0 ? `<small class="sv">${NF0.format(semValor)} sem valor</small>` : '';
        return celula(r[campo], tipo, campo, nota);
      }).join('');
      return `<tr${r.period === 'total' ? ' class="total"' : ''} data-period="${esc(r.period)}"><td data-col="period">${esc(rotuloPeriodo(r.period, grao))}</td>${cels}</tr>`;
    }).join('');
    const vazio = linhas.length ? '' : `<tr><td colspan="${def.cols.length + 1}" class="txt">Nenhum dado no período.</td></tr>`;
    document.querySelector(`#${def.id} .rolagem`).innerHTML = `<table><thead><tr><th>Período</th>${cab}</tr></thead><tbody>${corpo}${vazio}</tbody></table>`;
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
    const pag = bloco.querySelector('.pag');
    pag.innerHTML = total
      ? `<button type="button" data-act="prev" ${est.page === 0 ? 'disabled' : ''}>Anterior</button><span class="info">Página ${est.page + 1} de ${paginas} (${NF0.format(total)} linhas)</span><button type="button" data-act="next" ${est.page >= paginas - 1 ? 'disabled' : ''}>Próxima</button>`
      : '';
  }

  function renderTudo() {
    BLOCOS.forEach(renderBloco);
    renderLista('completed');
    renderLista('marked');
  }

  // ------------------------------------------------------------ filtros
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
      return `<details class="filtro" id="f-${chave}" data-filtro="${chave}" ${abertos.has(chave) ? 'open' : ''}><summary>${esc(rotulo)} <span class="qtd">${marcados.size ? `(${marcados.size})` : ''}</span></summary><div class="opcoes">${itens}</div></details>`;
    }).join('');
  }

  function atualizaResumoFiltro(chave) {
    const n = state.filters[chave].length;
    document.querySelector(`#f-${chave} .qtd`).textContent = n ? `(${n})` : '';
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
    const p = parametros();
    try {
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
      if (meu === seq) mostraErro(e.message);
    } finally {
      if (meu === seq) app.classList.remove('carregando');
    }
  }

  // ------------------------------------------------------------ eventos
  function ligaEventos() {
    $('btn-login').addEventListener('click', pedeLogin);

    document.querySelectorAll('.abas button').forEach((b) => b.addEventListener('click', () => {
      if (state.basis === b.dataset.basis) return;
      state.basis = b.dataset.basis;
      document.querySelectorAll('.abas button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      recarrega(true);
    }));

    $('c-inicio').addEventListener('change', (e) => { state.start = e.target.value; agenda(true); });
    $('c-fim').addEventListener('change', (e) => { state.end = e.target.value; agenda(true); });
    $('c-grao').addEventListener('change', (e) => { state.grain = e.target.value; agenda(false); });

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
    renderFiltros();
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
