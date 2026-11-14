// Telas Hoje e Clientes: o que precisa do Felipe, entre todos os clientes, e a lista de clientes por prioridade.
// Criado em 13/11/2026 (P2 do plano state/plans/2026-11-13-painel-redesign-codigo.md); spec: prototipos/redesign/CONTRATO.md, seção 1.
// O painel.js busca as fontes (cada uma falha sozinha) e chama PainelHoje.render(dados, ctx):
//   dados = { tenants, foto, eventos, pacientes, cirurgias, estados, falhas, lidoEm }
//     tenants    = linhas de tenants.sql        foto/eventos = analytics.setup_board (1 linha) e setup_events.sql
//     pacientes  = patients_all.sql (lista com tenant)   cirurgias = surgeries_all.sql (com tenant; várias fotos por cliente)
//     estados    = { tenant: resposta do action=state }  falhas = [{ fonte, rotulo }]  lidoEm = Date
//   null = carregando; false = erro (nenhuma fonte respondeu).
//   ctx   = { esc, modo ('hoje'|'clientes'), alvo (elemento), hoje (AAAA-MM-DD), diasEntre, nome(tenant), atualiza() }
// A regra de pacientes (sem audiência, sem próximo passo, devidos) é a do _shared/followup.js (funções globais fu*); aqui só se junta.
(function () {
  'use strict';

  const PRIO_ORDEM = ['alta', 'media', 'baixa', 'cortesia', 'outros'];
  const PRIO_ROTULO = { alta: 'Alta', media: 'Média', baixa: 'Baixa', cortesia: 'Cortesia', outros: 'Admin' };
  const PRIO_SELO = { alta: 'Alta', media: 'Média', baixa: 'Baixa', cortesia: 'Cortesia' }; // sem prioridade não tem selo
  const SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  const LISTA_VELHA_DIAS = 15;

  const normPrio = (p) => {
    const s = String(p || '').toLowerCase().replace('é', 'e');
    return PRIO_ORDEM.indexOf(s) >= 0 ? s : 'outros';
  };
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  const pad = (n) => String(n).padStart(2, '0');

  // ------------------------------------------------------------ dados: clientes (tenants + quadro de setup com os eventos por cima)
  // Os eventos setup_* valem por cima da foto, na ordem do seq (prioridade, tipo, nome, estágio, planejado e nota): o último vence.
  function doQuadro(foto, eventos) {
    let corpo = null;
    try { corpo = foto ? (typeof foto.body === 'string' ? JSON.parse(foto.body) : foto.body) : null; } catch (e) { corpo = null; }
    const esc2 = (corpo && corpo.escopos) || {};
    const mods = Object.keys(esc2).filter((k) => k.indexOf('m:') === 0).map((k) => ({ id: k.slice(2), titulo: esc2[k].titulo }));
    const clientes = Object.keys(esc2).filter((k) => k.indexOf('c:') === 0).map((k) => {
      const t = k.slice(2), e = esc2[k], celulas = {};
      mods.forEach((m) => {
        const c = esc2['x:' + t + ':' + m.id] || {};
        celulas[m.id] = { stage: c.stage || '', planned: c.planned || '', nota: c.nota || '', modulo: m.titulo };
      });
      return { tenant: t, titulo: e.titulo, prio: normPrio(e.priority), tipo: e.client_type || '', celulas };
    });
    if (!foto) return clientes;
    (eventos || []).slice().sort((a, b) => Number(a.seq) - Number(b.seq)).forEach((r) => {
      const c = clientes.filter((x) => x.tenant === r.tenant)[0];
      if (!c) return;
      if (r.event_name === 'setup_name') { c.titulo = r.value; return; }
      if (r.event_name === 'setup_priority') { c.prio = normPrio(r.value); return; }
      if (r.event_name === 'setup_type') { c.tipo = r.value; return; }
      const cel = c.celulas[r.module];
      if (!cel) return;
      if (r.event_name === 'setup_stage') cel.stage = r.value === 'sem estágio' ? '' : r.value;
      if (r.event_name === 'setup_planned') cel.planned = r.value;
      if (r.event_name === 'setup_note') cel.nota = r.value;
    });
    return clientes;
  }

  // Uma foto por cliente: a mais recente (a consulta já filtra; aqui de novo porque a conta é nossa). Devolve { tenant: 'AAAA-MM-DD' }.
  // Exposta em PainelHoje.fotoRecente e chamada por lá (o gabarito troca a escolha em memória para provar que o teste pega).
  function fotoRecente(linhas) {
    const por = {};
    (linhas || []).forEach((r) => {
      if (!r.tenant || !r.snapshot_date) return;
      if (!por[r.tenant] || r.snapshot_date > por[r.tenant]) por[r.tenant] = r.snapshot_date;
    });
    return por;
  }

  // Cobertura dos pacientes de um cliente pela regra única (followup.js). Mesma montagem de pacientes.js: agendados do state entram na linha antes da regra.
  function pacientesDe(linhas, estado, hoje) {
    const base = { now: hoje, rules: fuRules(estado && estado.rules ? estado.rules : null) };
    if (estado && estado.test_phone) base.test_phone = estado.test_phone;
    if (estado && estado.daily_cap !== undefined) base.daily_cap = estado.daily_cap;
    const agendados = {};
    ((estado && estado.scheduled) || []).forEach((a) => { agendados[a.phone_key] = a; });
    const todos = linhas.map((r) => {
      const a = agendados[r.phone_key];
      const x = a ? Object.assign({}, r, { scheduled_active: true, scheduled_at: a.at, scheduled_text: a.text, schedule_id: a.schedule_id }) : r;
      return fuResolve(x, base);
    });
    const cov = fuCoverage(todos, base);
    const enviados = estado && estado.daily_count !== undefined ? Number(estado.daily_count) : todos.filter((p) => fuDay(p.last_attempt_at) === hoje).length;
    return { sem_passo: cov.counts.no_next_step, sem_aud: cov.counts.unsegmented, devidos: cov.counts.due_today, total: cov.total, enviados, teto: base.daily_cap };
  }

  function montaClientes(dados, ctx) {
    const lista = doQuadro(dados.foto, dados.eventos).map((c) => ({
      tenant: c.tenant, nome: c.titulo || ctx.nome(c.tenant), prio: c.prio, tipo: c.tipo, celulas: c.celulas, spend: null, naTabela: false,
    }));
    (dados.tenants || []).forEach((t) => {
      let c = lista.filter((x) => x.tenant === t.tenant)[0];
      if (!c) { c = { tenant: t.tenant, nome: ctx.nome(t.tenant), prio: 'outros', tipo: '', celulas: null }; lista.push(c); }
      c.spend = Number(t.spend_rows);
      c.naTabela = true;
    });
    lista.forEach((c) => { c.midia = c.naTabela ? c.spend > 0 : true; });
    return lista.map((c, i) => ({ c, i })).sort((a, b) => (PRIO_ORDEM.indexOf(a.c.prio) - PRIO_ORDEM.indexOf(b.c.prio)) || (a.i - b.i)).map((x) => x.c);
  }

  // ------------------------------------------------------------ sinais por cliente e a lista "Precisa de você"
  function sinais(c, dados, ctx, fotos) {
    const s = { pacientes: null, listaDias: null, travados: [], noar: 0, planejados: 0 };
    const linhas = dados.pacientes.filter((p) => p.tenant === c.tenant);
    if (linhas.length) s.pacientes = pacientesDe(linhas, dados.estados[c.tenant] || null, ctx.hoje);
    if (fotos[c.tenant]) s.listaDias = ctx.diasEntre(fotos[c.tenant], ctx.hoje);
    if (c.celulas) {
      Object.keys(c.celulas).forEach((m) => {
        const x = c.celulas[m];
        if (x.planned === 'sim') s.planejados++;
        if (x.stage === 'no ar') s.noar++;
        if (x.stage === 'travado') s.travados.push({ modulo: m, titulo: x.modulo, nota: x.nota });
      });
    }
    return s;
  }

  // ------------------------------------------------------------ desenho
  // Links comuns (recarrega a página, como os links do protótipo): só o ?fixture=1 atravessa.
  function href(p) {
    const u = new URLSearchParams();
    if (p.pagina !== 'hoje') u.set('pagina', p.pagina);
    if (p.tenant) u.set('tenant', p.tenant);
    if (p.view) u.set('view', p.view);
    try { if (new URLSearchParams(location.search).get('fixture') === '1') u.set('fixture', '1'); } catch (e) { /* ok */ }
    const q = u.toString();
    return `?${q}${p.hash ? '#' + p.hash : ''}`;
  }

  const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  function cartao(c, s, semAlerta, esc) {
    const alertas = [];
    if (!semAlerta) {
      const p = s.pacientes;
      if (p && p.sem_passo > 0) alertas.push(`${p.sem_passo} sem passo`);
      if (p && p.sem_aud > 0) alertas.push(`${p.sem_aud} sem audiência`);
      s.travados.forEach((t) => alertas.push(`${t.titulo} travado`));
      if (s.listaDias !== null && s.listaDias > LISTA_VELHA_DIAS) alertas.push(`lista ${s.listaDias} d`);
    }
    const infos = [];
    if (s.pacientes && s.pacientes.devidos > 0) infos.push(`${plural(s.pacientes.devidos, 'devido hoje', 'devidos hoje')}`);
    if (s.planejados) infos.push(`setup ${s.noar}/${s.planejados}`);
    if (!c.midia) infos.push('sem mídia');
    if (!s.pacientes) infos.push('sem acompanhamento');
    const selos = alertas.map((t) => ({ t, a: true })).concat(infos.map((t) => ({ t, a: false }))).slice(0, 3);
    const meta = [PRIO_SELO[c.prio], c.tipo].filter(Boolean).join(' · ');
    const destino = c.midia ? 'funil' : 'pacientes';
    return `<a class="hj-cli" href="${esc(href({ pagina: destino, tenant: c.tenant }))}" data-tenant="${esc(c.tenant)}">` +
      `<span class="hj-cli-nome">${esc(c.nome)}</span>` +
      (meta ? `<span class="hj-cli-meta">${esc(meta)}</span>` : '') +
      (selos.length ? `<ul class="hj-selos">${selos.map((x) => `<li class="hj-selo"${x.a ? ' data-alerta="1"' : ''}>${esc(x.t)}</li>`).join('')}</ul>` : '') +
      '</a>';
  }

  function listaClientes(clientes, sin, semAlerta, esc) {
    let html = '<div data-lista="clientes">';
    PRIO_ORDEM.forEach((pr) => {
      const grupo = clientes.filter((c) => c.prio === pr);
      if (!grupo.length) return;
      html += `<div class="hj-grupo" data-prio="${pr}"><h3 class="hj-grupo-t">${PRIO_ROTULO[pr]}<span class="hj-grupo-n">${plural(grupo.length, 'cliente', 'clientes')}</span></h3><div class="hj-cartoes">` +
        grupo.map((c) => cartao(c, sin[c.tenant], semAlerta, esc)).join('') + '</div></div>';
    });
    return html + '</div>';
  }

  function esqueleto(ctx) {
    const cartoes = Array.from({ length: 4 }, () => '<div class="hj-esq hj-esq-cartao"></div>').join('');
    if (ctx.modo === 'clientes') return `<div data-estado="carregando" aria-live="polite"><p class="hj-sub">Carregando os clientes...</p><div class="hj-cartoes">${cartoes}</div></div>`;
    return `<div data-estado="carregando" aria-live="polite"><p class="hj-sub">Carregando os objetivos...</p><div class="ob-grade">${cartoes}</div></div>`;
  }

  // ------------------------------------------------------------ Objetivos (a tela Hoje virou Objetivos em 14/11/2026)
  // Matriz 1 do Felipe (Resultado x Entrega de valor). Resultado = honorário e ROAS em run rate (o mês corrente esticado até o fim),
  // contra o antes. Setup = realizado x planejado e os canais de aquisição. Objetivos = texto editável (evento setup_goal, uma linha por objetivo).
  const BRL0 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  const N1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const MES_CURTO = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const CANAIS = ['ads_search', 'ads_meta', 'ads_bing', 'doctoralia_paid']; // ids de _shared/adm/setup/modulos.json: onde a aquisição de pacientes acontece
  // Logomarca de cada canal de aquisição (id de modulos.json). Arquivos SVG/PNG das marcas (Wikimedia Commons e SVG Repo); o nome vai no aria-label e no title.
  const LOGO_CANAL = {
    ads_search: '<img alt="" src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iODAwcHgiIGhlaWdodD0iODAwcHgiIHZpZXdCb3g9IjAgLTEzIDI1NiAyNTYiIHZlcnNpb249IjEuMSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiB4bWxuczp4bGluaz0iaHR0cDovL3d3dy53My5vcmcvMTk5OS94bGluayIgcHJlc2VydmVBc3BlY3RSYXRpbz0ieE1pZFlNaWQiPgogICAgPGc+CgkJCQk8cGF0aCBkPSJNNS44ODgsMTY2LjQwNTEwMyBMOTAuODgsMjAuOSBDMTAxLjY3NjEzOCwyNy4yNTU4NjIxIDE1Ni4xMTU4NjIsNTcuMzg0NDEzOCAxNjQuOTA4MTM4LDYzLjExMzUxNzIgTDc5LjkxNjEzNzksMjA4LjYyNzQ0OCBDNzAuNjIwNjg5NywyMjAuOTA2NjIxIC01Ljg4OCwxODUuMDQwMTM4IDUuODg4LDE2Ni4zOTYyNzYgTDUuODg4LDE2Ni40MDUxMDMgWiIgZmlsbD0iI0ZCQkMwNCI+Cgo8L3BhdGg+CgkJCQk8cGF0aCBkPSJNMjUwLjA4NDIyNCwxNjYuNDAxNzg5IEwxNjUuMDkyMjI0LDIwLjkwNTUxMzEgQzE1My4yMTAyOTMsMS4xMzE3MiAxMjcuNjE5MTIxLC02LjA1MzkzNTE3IDEwNi42MDA2MzgsNS42MjQ5NjEzOCBDODUuNTgyMTU1LDE3LjMwMzg1NzkgNzkuMTgyMTU1LDQyLjQ2MjQ3ODYgOTEuMDY0MDg2MSw2My4xMTkwMzAzIEwxNzYuMDU2MDg2LDIwOC42MzI5NjEgQzE4Ny45MzgwMTcsMjI4LjM5NzkyNyAyMTMuNTI5MTksMjM1LjU4MzU4MiAyMzQuNTQ3NjcyLDIyMy45MDQ2ODYgQzI1NC42NDgwODYsMjEyLjIyNTc4OSAyNjEuOTY2MTU1LDE4Ni4xNzU1ODIgMjUwLjA4NDIyNCwxNjYuNDE5NDQ0IEwyNTAuMDg0MjI0LDE2Ni40MDE3ODkgWiIgZmlsbD0iIzQyODVGNCI+Cgo8L3BhdGg+CgkJCQk8ZWxsaXBzZSBmaWxsPSIjMzRBODUzIiBjeD0iNDIuNjYzNzI0MSIgY3k9IjE4Ny45MjQ0MTQiIHJ4PSI0Mi42NjM3MjQxIiByeT0iNDEuNjA0NDEzOCI+Cgo8L2VsbGlwc2U+CiAgICA8L2c+Cjwvc3ZnPg==">',
    ads_meta: '<img alt="" src="data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0idXRmLTgiPz4KPHN2ZyB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgeG1sbnM6eGxpbms9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiIHhtbG5zOmNjPSJodHRwOi8vY3JlYXRpdmVjb21tb25zLm9yZy9ucyMiIHZpZXdCb3g9IjAgMCAzMjAgMTkxIj4KPGRlc2M+TG9nbyBvZiBNZXRhIFBsYXRmb3JtcyAtLSBHcmFwaGljIGNyZWF0ZWQgYnkgRGV0bWFyIE93ZW48L2Rlc2M+CjxkZWZzPgo8bGluZWFyR3JhZGllbnQgaWQ9IkdyYWRfTG9nbzEiIHgxPSI2MSIgeTE9IjExNyIgeDI9IjI1OSIgeTI9IjEyNyIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPgo8c3RvcCBzdHlsZT0ic3RvcC1jb2xvcjojMDA2NGUxIiBvZmZzZXQ9IjAiLz4KPHN0b3Agc3R5bGU9InN0b3AtY29sb3I6IzAwNjRlMSIgb2Zmc2V0PSIwLjQiLz4KPHN0b3Agc3R5bGU9InN0b3AtY29sb3I6IzAwNzNlZSIgb2Zmc2V0PSIwLjgzIi8+CjxzdG9wIHN0eWxlPSJzdG9wLWNvbG9yOiMwMDgyZmIiIG9mZnNldD0iMSIvPgo8L2xpbmVhckdyYWRpZW50Pgo8bGluZWFyR3JhZGllbnQgaWQ9IkdyYWRfTG9nbzIiIHgxPSI0NSIgeTE9IjEzOSIgeDI9IjQ1IiB5Mj0iNjYiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KPHN0b3Agc3R5bGU9InN0b3AtY29sb3I6IzAwODJmYiIgb2Zmc2V0PSIwIi8+CjxzdG9wIHN0eWxlPSJzdG9wLWNvbG9yOiMwMDY0ZTAiIG9mZnNldD0iMSIvPgo8L2xpbmVhckdyYWRpZW50Pgo8L2RlZnM+CjxwYXRoIGlkPSJMb2dvMCIgc3R5bGU9ImZpbGw6IzAwODFmYiIgZD0ibTMxLjA2LDEyNS45NmMwLDEwLjk4IDIuNDEsMTkuNDEgNS41NiwyNC41MSA0LjEzLDYuNjggMTAuMjksOS41MSAxNi41Nyw5LjUxIDguMSwwIDE1LjUxLTIuMDEgMjkuNzktMjEuNzYgMTEuNDQtMTUuODMgMjQuOTItMzguMDUgMzMuOTktNTEuOThsMTUuMzYtMjMuNmMxMC42Ny0xNi4zOSAyMy4wMi0zNC42MSAzNy4xOC00Ni45NiAxMS41Ni0xMC4wOCAyNC4wMy0xNS42OCAzNi41OC0xNS42OCAyMS4wNywwIDQxLjE0LDEyLjIxIDU2LjUsMzUuMTEgMTYuODEsMjUuMDggMjQuOTcsNTYuNjcgMjQuOTcsODkuMjcgMCwxOS4zOC0zLjgyLDMzLjYyLTEwLjMyLDQ0Ljg3LTYuMjgsMTAuODgtMTguNTIsMjEuNzUtMzkuMTEsMjEuNzVsMC0zMS4wMmMxNy42MywwIDIyLjAzLTE2LjIgMjIuMDMtMzQuNzQgMC0yNi40Mi02LjE2LTU1Ljc0LTE5LjczLTc2LjY5LTkuNjMtMTQuODYtMjIuMTEtMjMuOTQtMzUuODQtMjMuOTQtMTQuODUsMC0yNi44LDExLjItNDAuMjMsMzEuMTctNy4xNCwxMC42MS0xNC40NywyMy41NC0yMi43LDM4LjEzbC05LjA2LDE2LjA1Yy0xOC4yLDMyLjI3LTIyLjgxLDM5LjYyLTMxLjkxLDUxLjc1LTE1Ljk1LDIxLjI0LTI5LjU3LDI5LjI5LTQ3LjUsMjkuMjktMjEuMjcsMC0zNC43Mi05LjIxLTQzLjA1LTIzLjA5LTYuOC0xMS4zMS0xMC4xNC0yNi4xNS0xMC4xNC00My4wNnoiLz4KPHBhdGggaWQ9IkxvZ28xIiBzdHlsZT0iZmlsbDp1cmwoI0dyYWRfTG9nbzEpIiBkPSJtMjQuNDksMzcuM2MxNC4yNC0yMS45NSAzNC43OS0zNy4zIDU4LjM2LTM3LjMgMTMuNjUsMCAyNy4yMiw0LjA0IDQxLjM5LDE1LjYxIDE1LjUsMTIuNjUgMzIuMDIsMzMuNDggNTIuNjMsNjcuODFsNy4zOSwxMi4zMmMxNy44NCwyOS43MiAyNy45OSw0NS4wMSAzMy45Myw1Mi4yMiA3LjY0LDkuMjYgMTIuOTksMTIuMDIgMTkuOTQsMTIuMDIgMTcuNjMsMCAyMi4wMy0xNi4yIDIyLjAzLTM0Ljc0bDI3LjQtLjg2YzAsMTkuMzgtMy44MiwzMy42Mi0xMC4zMiw0NC44Ny02LjI4LDEwLjg4LTE4LjUyLDIxLjc1LTM5LjExLDIxLjc1LTEyLjgsMC0yNC4xNC0yLjc4LTM2LjY4LTE0LjYxLTkuNjQtOS4wOC0yMC45MS0yNS4yMS0yOS41OC0zOS43MWwtMjUuNzktNDMuMDhjLTEyLjk0LTIxLjYyLTI0LjgxLTM3Ljc0LTMxLjY4LTQ1LjA0LTcuMzktNy44NS0xNi44OS0xNy4zMy0zMi4wNS0xNy4zMy0xMi4yNywwLTIyLjY5LDguNjEtMzEuNDEsMjEuNzh6Ii8+CjxwYXRoIGlkPSJMb2dvMiIgc3R5bGU9ImZpbGw6dXJsKCNHcmFkX0xvZ28yKSIgZD0ibTgyLjM1LDMxLjIzYy0xMi4yNywwLTIyLjY5LDguNjEtMzEuNDEsMjEuNzgtMTIuMzMsMTguNjEtMTkuODgsNDYuMzMtMTkuODgsNzIuOTUgMCwxMC45OCAyLjQxLDE5LjQxIDUuNTYsMjQuNTFsLTI2LjQ4LDE3LjQ0Yy02LjgtMTEuMzEtMTAuMTQtMjYuMTUtMTAuMTQtNDMuMDYgMC0zMC43NSA4LjQ0LTYyLjggMjQuNDktODcuNTUgMTQuMjQtMjEuOTUgMzQuNzktMzcuMyA1OC4zNi0zNy4zeiIvPgoKPC9zdmc+Cg==">',
    ads_bing: '<img alt="" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMDAgNDA1Ij48cGF0aCBmaWxsPSIjMDA4MzczIiB0cmFuc2Zvcm09InRyYW5zbGF0ZSgzMTIgLTc5NS42NykiIGQ9Im0tMzExLjUgNzk2LjE2OSA4MC42MjczIDI4LjM2NHYyODMuODA4bDExMy41NjctNjUuNTU5OS01NS42Nzk2LTI2LjEyNDYtMzUuMTI3NC04Ny40MzA3IDE3OC45MzkgNjIuODY0NXY5MS4zOTUybC0yMDEuNjU0IDExNi4zMS04MC42NzMzLTQ0Ljg3NXoiLz48L3N2Zz4=">',
    doctoralia_paid: '<img alt="" src="data:image/png;base64,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">',
  };
  const SITUACAO = {
    cresce: ['🟢', 'Cresce conosco'], sem_ver: ['🔵', 'Cresce sem nos ver'], esforco: ['🟡', 'Vê esforço, não vê retorno'],
    parado: ['🔴', 'Não cresce e não engaja'], sem: ['⚪', 'Sem medição ainda'],
  };
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const mesCurto = (p) => MES_CURTO[Number(p.slice(5, 7)) - 1];

  // Linhas de funnel_month.sql -> o que a tela mostra. null = sem gasto de mídia (sem medição).
  function medidas(rows, base) {
    const m = (rows || []).map((r) => ({ p: r.period, fee: num(r.physician_fee), spend: num(r.spend), pac: num(r.completed_patients), roas: num(r.roas_honorario), parcial: r.partial_until || null }));
    const ini = m.findIndex((x) => x.fee !== null || (x.spend || 0) > 0);
    if (ini < 0) return null;
    const cur = m[m.length - 1];
    let k = 1;
    if (cur.parcial) { const [a, me] = cur.p.split('-').map(Number); k = new Date(a, me, 0).getDate() / Number(cur.parcial.slice(8, 10)); }
    const fee = cur.fee === null ? null : cur.fee * k;
    const serie = m.slice(ini);
    const iRoas = m.findIndex((x, i) => i < m.length - 1 && x.roas !== null);
    const iGasto = m.findIndex((x) => (x.spend || 0) > 0);
    return {
      cur, k, fee, roas: cur.roas,
      serieFee: serie.map((x, i) => (i === serie.length - 1 ? fee : x.fee)), serieRoas: serie.map((x) => x.roas),
      // o antes do honorário: o que o Felipe cadastrou (setup_baseline); sem isso, o mês antes de a mídia começar, se o funil tiver
      antesFee: base || (iGasto > 0 && m[iGasto - 1].fee !== null ? { v: m[iGasto - 1].fee, p: m[iGasto - 1].p } : null),
      antesRoas: iRoas >= 0 ? { v: m[iRoas].roas, p: m[iRoas].p } : null,
      temGasto: iGasto >= 0, temPaciente: m.some((x) => x.pac > 0), gasto: m.reduce((t, x) => t + (x.spend || 0), 0),
    };
  }

  function canaisDe(c) {
    return CANAIS.map((id) => (c.celulas && c.celulas[id] ? Object.assign({ id }, c.celulas[id]) : null))
      .filter((x) => x && (x.planned === 'sim' || x.stage));
  }
  function setupDe(c) {
    const cel = c.celulas ? Object.keys(c.celulas).map((k) => c.celulas[k]) : [];
    const plan = cel.filter((x) => x.planned === 'sim');
    return { planejados: plan.length, noar: plan.filter((x) => x.stage === 'no ar').length, canais: canaisDe(c) };
  }
  // Resultado alto = tem paciente e o honorário cobre o gasto (ROAS >= 1). Entrega alta = a aquisição de pacientes já começou (canal no ar ou em teste).
  function situacao(c, med) {
    if (!med || !med.temGasto) return 'sem';
    const resultado = med.temPaciente && med.roas !== null && med.roas >= 1;
    const entrega = canaisDe(c).some((x) => x.stage === 'no ar' || x.stage === 'em montagem');
    if (resultado) return entrega ? 'cresce' : 'sem_ver';
    return entrega ? 'esforco' : 'parado';
  }
  function objetivosDe(eventos) {
    const por = {};
    (eventos || []).slice().sort((a, b) => Number(a.seq) - Number(b.seq)).forEach((r) => { if (r.event_name === 'setup_goal') por[r.tenant] = String(r.value || ''); });
    return por;
  }
  // Ordem dos cartões que o Felipe escolheu (arrastar ou setas): lista de tenants, só neste navegador, só dentro de cada prioridade.
  const ORDEM_KEY = 'painel.objetivos.ordem';
  const lerOrdem = () => { try { const o = JSON.parse(localStorage.getItem(ORDEM_KEY)); return Array.isArray(o) ? o : []; } catch (e) { return []; } };
  const salvaOrdem = (alvo) => { try { localStorage.setItem(ORDEM_KEY, JSON.stringify(Array.from(alvo.querySelectorAll('.ob-cartao')).map((c) => c.dataset.tenant))); } catch (e) { /* sem armazenamento: a ordem não persiste */ } };
  // setup_baseline: texto JSON {period, physician_fee}; o último vale. Texto torto vira sem base (nunca derruba a tela).
  function baselinesDe(eventos) {
    const por = {};
    (eventos || []).slice().sort((a, b) => Number(a.seq) - Number(b.seq)).forEach((r) => {
      if (r.event_name !== 'setup_baseline') return;
      try {
        const j = JSON.parse(String(r.value || ''));
        por[r.tenant] = /^\d{4}-\d{2}$/.test(j.period) && Number.isFinite(Number(j.physician_fee)) ? { p: j.period, v: Number(j.physician_fee), agendaToda: true } : null;
      } catch (e) { por[r.tenant] = null; }
    });
    return por;
  }
  const linhasDe = (txt) => String(txt || '').split('\n').map((l) => l.trim()).filter(Boolean);

  function barras(serie) {
    const v = serie.map((x) => (x === null || x === undefined ? 0 : Math.max(x, 0)));
    const mx = Math.max(0, ...v);
    if (!mx || v.length < 2) return '';
    const w = 100 / v.length;
    return '<svg class="ob-barras" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true" focusable="false">' + v.map((x, i) => {
      const h = x ? Math.max((x / mx) * 24, 1.5) : 0;
      return `<rect${i === v.length - 1 ? ' class="agora"' : ''} x="${(i * w + w * 0.15).toFixed(2)}" y="${(24 - h).toFixed(2)}" width="${(w * 0.7).toFixed(2)}" height="${h.toFixed(2)}"/>`;
    }).join('') + '</svg>';
  }
  function variacao(agora, antes) {
    if (agora === null || antes === null || !antes) return '';
    const f = agora / antes - 1;
    return `<span class="ob-var" data-sobe="${f >= 0}">${f >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(f * 100))}%</span>`;
  }
  function tile(esc, o) {
    const sub = o.sub ? `<span class="ob-sub">${o.sub}</span>` : '';
    const corpo = `<span class="fc-rotulo">${esc(o.rotulo)}</span><span class="ob-linha"><span class="ob-grande"${o.vazio ? ' data-vazio="1"' : ''}>${esc(o.grande)}</span>${o.barras || ''}</span>${sub}`;
    return o.href ? `<a class="ob-tile" href="${esc(o.href)}" data-ir="${o.ir}" aria-label="${esc(o.aria)}">${corpo}</a>` : `<div class="ob-tile">${corpo}</div>`;
  }
  function metricasHtml(c, med, esc) {
    const funil = href({ pagina: 'funil', tenant: c.tenant });
    if (!med || !med.temGasto) return '';
    if (!med.temPaciente) {
      return `<div class="ob-metricas">${tile(esc, { rotulo: 'Resultado', grande: 'Nenhum paciente ainda', vazio: true, sub: esc(`${BRL0.format(med.gasto)} investidos no teste`), href: funil, ir: 'funil', aria: 'Resultado: nenhum paciente ainda. Abrir o Funil' })}</div>`;
    }
    const fee = med.fee, roas = med.roas;
    const subFee = med.antesFee ? (med.antesFee.agendaToda ? `<span>${esc(mesCurto(med.antesFee.p).replace(/^./, (x) => x.toUpperCase()))}/${esc(med.antesFee.p.slice(2, 4))}: ${esc(BRL0.format(med.antesFee.v))} (tudo)</span>` : `${variacao(fee, med.antesFee.v)} <span>era ${esc(BRL0.format(med.antesFee.v))} em ${mesCurto(med.antesFee.p)}</span>`) : '<span>sem base de antes</span>';
    const subRoas = med.antesRoas ? `${variacao(roas, med.antesRoas.v)} <span>era ${esc(N1.format(med.antesRoas.v))} em ${mesCurto(med.antesRoas.p)}</span>` : '<span>sem base de antes</span>';
    return `<div class="ob-metricas">` +
      tile(esc, { rotulo: 'Honorário por mês', grande: fee === null ? 'sem dado' : (med.antesFee && med.antesFee.agendaToda ? '+' : '') + BRL0.format(fee), sub: subFee, barras: barras(med.serieFee), href: funil, ir: 'funil', aria: `Honorário por mês, run rate: ${fee === null ? 'sem dado' : BRL0.format(fee)}. Abrir o Funil` }) +
      tile(esc, { rotulo: 'ROAS', grande: roas === null ? 'sem dado' : N1.format(roas), sub: subRoas, barras: barras(med.serieRoas), href: funil, ir: 'funil', aria: `ROAS: ${roas === null ? 'sem dado' : N1.format(roas)}. Abrir o Funil` }) + '</div>';
  }
  function setupHtml(c, esc) {
    const s = setupDe(c);
    const pc = s.planejados ? Math.round((s.noar / s.planejados) * 100) : 0;
    const pilulas = s.canais.length
      ? s.canais.map((x) => { const est = x.stage === 'em montagem' ? 'em teste' : (x.stage || 'planejado'); const nome = `${x.modulo}: ${est}`; return `<li data-estagio="${esc(x.stage || 'planejado')}" title="${esc(nome)}" aria-label="${esc(nome)}">${LOGO_CANAL[x.id] || esc(x.modulo)}${x.id === 'ads_search' ? '<span>Search</span>' : ''}</li>`; }).join('')
      : '<li data-estagio="nenhum">Aquisição não começou</li>';
    return `<a class="ob-setup" href="${esc(href({ pagina: 'setup', tenant: c.tenant }))}" data-ir="setup" aria-label="${esc(`Setup: ${s.noar} de ${s.planejados} no ar. Abrir o Setup`)}">` +
      `<span class="ob-setup-t"><span class="fc-rotulo">Setup</span><span class="ob-frac">${s.planejados ? `<b>${s.noar}</b> de ${s.planejados} no ar` : 'nada planejado'}</span></span>` +
      `<span class="ob-barra" aria-hidden="true"><i style="width:${pc}%"></i></span><ul class="ob-canais">${pilulas}</ul></a>`;
  }
  const metaHtml = (txt, esc) => `<li class="ob-meta" contenteditable="plaintext-only" role="textbox" aria-label="Objetivo" data-ph="Escreva o objetivo" spellcheck="true">${esc(txt)}</li>`;

  function cartaoObj(c, med, metas, esc) {
    const sit = situacao(c, med), [emoji, nome] = SITUACAO[sit];
    const linhas = linhasDe(metas);
    return `<article class="ob-cartao" data-tenant="${esc(c.tenant)}" data-sit="${sit}" data-metas="${esc(linhas.join('\n'))}">` +
      `<header class="ob-topo"><span class="ob-sit" role="img" aria-label="${esc(nome)}" title="${esc(nome)}">${emoji}</span><h3 class="ob-nome">${esc(c.nome)}</h3>${sit === 'sem' ? '<span class="ob-semmed">sem medição ainda</span>' : ''}` +
      `<button type="button" class="ob-alca" data-act="mover" aria-label="${esc(`Mover o cartão de ${c.nome}. Arraste, ou use as setas`)}" title="Arrastar para reordenar">⠿</button></header>` +
      metricasHtml(c, med, esc) + setupHtml(c, esc) +
      `<section class="ob-metas" aria-label="Objetivos do momento"><div class="ob-metas-t"><span class="fc-rotulo">Objetivos do momento</span><span class="ob-estado" role="status" aria-live="polite"></span>` +
      `<button type="button" class="ob-mais" data-act="mais" aria-label="Adicionar objetivo" title="Adicionar objetivo">+</button></div>` +
      `<ul class="ob-lista">${(linhas.length ? linhas : ['']).map((l) => metaHtml(l, esc)).join('')}</ul></section></article>`;
  }

  // Grava o texto dos objetivos de um cartão (um evento setup_goal; o último vale). Só grava se mudou.
  async function salvaMetas(card, ctx) {
    const lista = card.querySelector('.ob-lista');
    lista.querySelectorAll('.ob-meta').forEach((li) => { if (!li.textContent.trim() && lista.children.length > 1) li.remove(); });
    const texto = Array.from(lista.querySelectorAll('.ob-meta')).map((li) => li.textContent.trim()).filter(Boolean).join('\n');
    if (texto === card.dataset.metas) return;
    const estado = card.querySelector('.ob-estado');
    estado.textContent = 'Salvando...';
    let r = 'falha';
    try { r = await ctx.anota([{ event_name: 'setup_goal', tenant: card.dataset.tenant, body: { value: texto } }]); } catch (e) { r = 'falha'; }
    if (r === 'ok') card.dataset.metas = texto;
    estado.textContent = { ok: 'Salvo', sem_login: 'Entre de novo para salvar', sem_permissao: 'Sem permissão para salvar' }[r] || 'Não salvou. Edite de novo para tentar.';
    estado.dataset.erro = r === 'ok' ? '' : '1';
  }

  function ligaEdicao(alvo, ctx) {
    alvo.onclick = (e) => {
      if (e.target.closest('[data-act="atualizar"]')) { ctx.atualiza(); return; }
      const mais = e.target.closest('[data-act="mais"]');
      if (!mais) return;
      const lista = mais.closest('.ob-metas').querySelector('.ob-lista');
      const vazio = Array.from(lista.querySelectorAll('.ob-meta')).find((li) => !li.textContent.trim());
      const li = vazio || lista.appendChild(Object.assign(document.createElement('li'), { className: 'ob-meta', contentEditable: 'plaintext-only', spellcheck: true }));
      if (!vazio) { li.setAttribute('role', 'textbox'); li.setAttribute('aria-label', 'Objetivo'); li.dataset.ph = 'Escreva o objetivo'; }
      li.focus();
    };
    alvo.onkeydown = (e) => {
      const li = e.target.closest && e.target.closest('.ob-meta');
      if (li && e.key === 'Enter') { e.preventDefault(); li.blur(); return; }
      const alca = e.target.closest && e.target.closest('.ob-alca');
      const volta = ['ArrowUp', 'ArrowLeft'].includes(e.key), avanca = ['ArrowDown', 'ArrowRight'].includes(e.key);
      if (!alca || !(volta || avanca)) return;
      e.preventDefault();
      const c = alca.closest('.ob-cartao');
      const viz = volta ? c.previousElementSibling : c.nextElementSibling;
      if (!viz) return;
      c.parentNode.insertBefore(c, volta ? viz : viz.nextSibling);
      alca.focus();
      salvaOrdem(alvo);
    };
    alvo.onfocusout = (e) => {
      const li = e.target.closest && e.target.closest('.ob-meta');
      if (li && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.ob-metas') === li.closest('.ob-metas'))) salvaMetas(li.closest('.ob-cartao'), ctx);
    };
    // Arrastar: só pela alça (o cartão tem texto editável e links). Troca de lugar dentro da mesma prioridade; as setas fazem o mesmo.
    alvo.onpointerdown = (e) => { const a = e.target.closest && e.target.closest('.ob-alca'); if (a) a.closest('.ob-cartao').draggable = true; };
    alvo.ondragstart = (e) => {
      const c = e.target;
      if (!c.classList || !c.classList.contains('ob-cartao')) return;
      c.dataset.arrastando = '1';
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', c.dataset.tenant);
    };
    alvo.ondragover = (e) => {
      const arr = alvo.querySelector('[data-arrastando]');
      const alvoC = e.target.closest && e.target.closest('.ob-cartao');
      if (!arr || !alvoC || alvoC === arr || alvoC.parentNode !== arr.parentNode) return;
      e.preventDefault();
      const depois = arr.compareDocumentPosition(alvoC) & Node.DOCUMENT_POSITION_FOLLOWING;
      alvoC.parentNode.insertBefore(arr, depois ? alvoC.nextSibling : alvoC);
    };
    alvo.ondragend = (e) => {
      const c = e.target;
      if (!c.classList || !c.classList.contains('ob-cartao')) return;
      c.draggable = false;
      delete c.dataset.arrastando;
      salvaOrdem(alvo);
    };
    alvo.onpaste = (e) => {
      if (!e.target.closest || !e.target.closest('.ob-meta')) return;
      e.preventDefault();
      document.execCommand('insertText', false, (e.clipboardData.getData('text/plain') || '').replace(/\s*\n\s*/g, ' '));
    };
  }

  function objetivosHtml(dados, ctx) {
    const { esc } = ctx;
    const clientes = montaClientes(dados, ctx);
    const metas = objetivosDe(dados.eventos);
    const bases = baselinesDe(dados.eventos);
    const avisos = (dados.falhas || []).map((f) =>
      `<div class="hj-aviso" data-aviso="fonte" data-fonte="${esc(f.fonte)}" role="status"><p>Não consegui ler ${esc(f.rotulo)}. Tente de novo.</p><button type="button" class="btn ghost" data-act="atualizar">Tentar de novo</button></div>`).join('');
    const grupos = PRIO_ORDEM.map((pr) => {
      const ord = lerOrdem();
      const pos = (c) => (ord.indexOf(c.tenant) < 0 ? 1e6 : ord.indexOf(c.tenant));
      const g = clientes.filter((c) => c.prio === pr).map((c, i) => ({ c, i })).sort((a, b) => (pos(a.c) - pos(b.c)) || (a.i - b.i)).map((x) => x.c);
      if (!g.length) return '';
      const cab = `<span class="ob-prio">${PRIO_ROTULO[pr]}</span><span class="hj-grupo-n">${plural(g.length, 'cliente', 'clientes')}</span>`;
      const grade = `<div class="ob-grade">${g.map((c) => cartaoObj(c, medidas((dados.mensais || {})[c.tenant], bases[c.tenant]), metas[c.tenant], esc)).join('')}</div>`;
      // Cortesia e Admin (sem prioridade) vêm recolhidos: o foco é nos clientes que pagam ou vão pagar.
      return pr === 'cortesia' || pr === 'outros'
        ? `<details class="hj-grupo ob-grupo" data-prio="${pr}"><summary class="ob-grupo-t">${cab}</summary>${grade}</details>`
        : `<section class="hj-grupo ob-grupo" data-prio="${pr}" aria-label="${esc(PRIO_ROTULO[pr])}"><h2 class="ob-grupo-t">${cab}</h2>${grade}</section>`;
    }).join('');
    const legenda = Object.keys(SITUACAO).map((k) => `<li><span aria-hidden="true">${SITUACAO[k][0]}</span> ${esc(SITUACAO[k][1])}</li>`).join('');
    return `<div data-estado="ok">${avisos}${grupos}` +
      `<footer class="hj-rodape"><ul class="ob-legenda" aria-label="Legenda da situação">${legenda}</ul>` +
      `<p>Run rate: o mês corrente esticado até o fim. Resultado abre o Funil, Setup abre o Setup. Em breve: valor por hora, % de ocupação, retorno de cada R$ 100 investidos. Lido às ${hhmm(dados.lidoEm || new Date())} · <button type="button" class="btn ghost" data-act="atualizar">Atualizar</button></p></footer></div>`;
  }

  function render(dados, ctx) {
    const { esc } = ctx;
    const alvo = ctx.alvo;
    alvo.onclick = (e) => { if (e.target.closest('[data-act="atualizar"]')) ctx.atualiza(); };
    alvo.onkeydown = alvo.onfocusout = alvo.onpaste = alvo.onpointerdown = alvo.ondragstart = alvo.ondragover = alvo.ondragend = null;
    const h1 = document.getElementById('t-hoje');
    if (ctx.modo === 'hoje' && h1) h1.textContent = 'Objetivos';
    if (dados === null) { alvo.innerHTML = esqueleto(ctx); return; }
    if (dados === false) {
      alvo.innerHTML = '<div data-estado="erro" class="hj-erro" role="alert"><p>Não consegui ler os dados dos clientes. Tente de novo.</p><button type="button" class="btn" data-act="atualizar">Tentar de novo</button></div>';
      return;
    }
    if (ctx.modo === 'hoje') { alvo.innerHTML = objetivosHtml(dados, ctx); ligaEdicao(alvo, ctx); return; }
    const clientes = montaClientes(dados, ctx);
    const fotos = window.PainelHoje.fotoRecente(dados.cirurgias);
    const sin = {};
    clientes.forEach((c) => { sin[c.tenant] = sinais(c, dados, ctx, fotos); });
    const avisos = (dados.falhas || []).map((f) =>
      `<div class="hj-aviso" data-aviso="fonte" data-fonte="${esc(f.fonte)}" role="status"><p>Não consegui ler ${esc(f.rotulo)}. Tente de novo.</p><button type="button" class="btn ghost" data-act="atualizar">Tentar de novo</button></div>`).join('');
    const rodape = `<footer class="hj-rodape"><p>Lido às ${hhmm(dados.lidoEm || new Date())} · <button type="button" class="btn ghost" data-act="atualizar">Atualizar</button></p></footer>`;
    alvo.innerHTML = `<div data-estado="ok">${avisos}${listaClientes(clientes, sin, false, esc)}${rodape}</div>`;
  }

  window.PainelHoje = { render, fotoRecente, medidas, situacao };
})();
