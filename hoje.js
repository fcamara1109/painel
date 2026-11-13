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
  const PRIO_ROTULO = { alta: 'Alta', media: 'Média', baixa: 'Baixa', cortesia: 'Cortesia', outros: 'Sem prioridade' };
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

  // Ordem: prioridade do cliente, depois gravidade (sem passo ou sem audiência > travado > lista velha > devidos), depois a ordem da lista.
  function itensDe(clientes, sin) {
    const itens = [];
    clientes.forEach((c, ci) => {
      const s = sin[c.tenant], p = s.pacientes;
      const base = { tenant: c.tenant, nome: c.nome, prio: c.prio, ci };
      const novo = (g, sinal, texto, botao, alvo) => itens.push(Object.assign({}, base, { g, sinal, texto, botao, alvo }));
      if (p && p.sem_passo > 0) novo(1, 'no_next_step', `${p.sem_passo} sem próximo passo`, 'Ver sem próximo passo', { pagina: 'pacientes', tenant: c.tenant, view: 'no_next_step' });
      if (p && p.sem_aud > 0) novo(1, 'unsegmented', `${p.sem_aud} sem audiência`, 'Definir audiência', { pagina: 'pacientes', tenant: c.tenant, view: 'unsegmented' });
      s.travados.forEach((t) => novo(2, 'setup_blocked', `${t.titulo} travado${t.nota ? '. ' + t.nota : ''}`, 'Abrir no Setup', { pagina: 'setup', hash: `x-${c.tenant}-${t.modulo}` }));
      if (s.listaDias !== null && s.listaDias > LISTA_VELHA_DIAS) novo(3, 'surgeries_old', `Lista de cirurgia tem ${s.listaDias} dias`, 'Ver a lista', { pagina: 'cirurgias', tenant: c.tenant });
      if (p && p.sem_aud === 0 && p.sem_passo === 0 && p.devidos > 0) {
        const envios = p.teto !== undefined ? ` · ${p.enviados} de ${p.teto} envios` : '';
        novo(6, 'due_today', `${plural(p.devidos, 'devido hoje', 'devidos hoje')}${envios}`, 'Ver devidos', { pagina: 'pacientes', tenant: c.tenant, view: 'due_today' });
      }
    });
    return itens.sort((a, b) => (PRIO_ORDEM.indexOf(a.prio) - PRIO_ORDEM.indexOf(b.prio)) || (a.g - b.g) || (a.ci - b.ci));
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

  const titulo = (hoje) => {
    const d = new Date(Date.UTC(+hoje.slice(0, 4), +hoje.slice(5, 7) - 1, +hoje.slice(8, 10)));
    return `Hoje, ${SEMANA[d.getUTCDay()]} ${hoje.slice(8, 10)}/${hoje.slice(5, 7)}`;
  };
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
    return `<div data-estado="carregando" aria-live="polite"><p class="hj-sub">Carregando o que precisa de você...</p>` +
      `<div class="hj-bloco">${Array.from({ length: 3 }, () => '<div class="hj-esq hj-esq-linha"></div>').join('')}</div><div class="hj-cartoes">${cartoes}</div></div>`;
  }

  function render(dados, ctx) {
    const { esc } = ctx;
    const alvo = ctx.alvo;
    alvo.onclick = (e) => { if (e.target.closest('[data-act="atualizar"]')) ctx.atualiza(); };
    const h1 = document.getElementById('t-hoje');
    if (ctx.modo === 'hoje' && h1) h1.textContent = titulo(ctx.hoje); // o título já aparece com o esqueleto
    if (dados === null) { alvo.innerHTML = esqueleto(ctx); return; }
    if (dados === false) {
      alvo.innerHTML = '<div data-estado="erro" class="hj-erro" role="alert"><p>Não consegui ler os dados dos clientes. Tente de novo.</p><button type="button" class="btn" data-act="atualizar">Tentar de novo</button></div>';
      return;
    }
    const clientes = montaClientes(dados, ctx);
    const fotos = window.PainelHoje.fotoRecente(dados.cirurgias);
    const sin = {};
    clientes.forEach((c) => { sin[c.tenant] = sinais(c, dados, ctx, fotos); });
    const itens = itensDe(clientes, sin);
    const nCli = new Set(itens.map((i) => i.tenant)).size;
    const vazio = itens.length === 0;
    const avisos = (dados.falhas || []).map((f) =>
      `<div class="hj-aviso" data-aviso="fonte" data-fonte="${esc(f.fonte)}" role="status"><p>Não consegui ler ${esc(f.rotulo)}. Tente de novo.</p><button type="button" class="btn ghost" data-act="atualizar">Tentar de novo</button></div>`).join('');
    const rodape = `<footer class="hj-rodape"><p>Lido às ${hhmm(dados.lidoEm || new Date())} · <button type="button" class="btn ghost" data-act="atualizar">Atualizar</button></p></footer>`;

    if (ctx.modo === 'clientes') {
      alvo.innerHTML = `<div data-estado="ok">${avisos}${listaClientes(clientes, sin, false, esc)}${rodape}</div>`;
      return;
    }
    const sub = vazio ? 'Nada pendente. Nenhum cliente precisa de você agora.'
      : `${plural(itens.length, 'coisa precisa', 'coisas precisam')} de você em ${plural(nCli, 'cliente', 'clientes')}`;
    const lista = vazio
      ? '<ul class="hj-itens" data-lista="precisa"><li class="hj-vazio">Nada pendente.</li></ul>'
      : `<ul class="hj-itens" data-lista="precisa">${itens.map((i) =>
        `<li class="hj-item" data-tenant="${esc(i.tenant)}" data-sinal="${i.sinal}"><div class="hj-item-txt"><p class="hj-item-cli">${esc(i.nome)}</p><p class="hj-item-sinal">${esc(i.texto)}</p></div>` +
        `<a class="btn ghost" href="${esc(href(i.alvo))}">${esc(i.botao)}</a></li>`).join('')}</ul>`;
    alvo.innerHTML = `<div data-estado="${vazio ? 'vazio' : 'ok'}"><p class="hj-sub" data-hoje="sub">${esc(sub)}</p>${avisos}` +
      `<section class="hj-bloco" aria-labelledby="hj-precisa"><h2 id="hj-precisa" class="hj-h2">Precisa de você</h2>${lista}</section>` +
      `<section aria-labelledby="hj-clientes"><h2 id="hj-clientes" class="hj-h2">Clientes</h2>${listaClientes(clientes, sin, vazio, esc)}</section>${rodape}</div>`;
  }

  window.PainelHoje = { render, fotoRecente };
})();
