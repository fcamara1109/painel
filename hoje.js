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
  const SITUACAO = {
    cresce: ['🟢', 'Cresce conosco'], sem_ver: ['🔵', 'Cresce sem nos ver'], esforco: ['🟡', 'Vê esforço, não vê retorno'],
    parado: ['🔴', 'Não cresce e não engaja'], sem: ['⚪', 'Sem medição ainda'],
  };
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const mesCurto = (p) => MES_CURTO[Number(p.slice(5, 7)) - 1];

  // Linhas de funnel_month.sql -> o que a tela mostra. null = sem gasto de mídia (sem medição).
  function medidas(rows) {
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
      antesFee: iGasto > 0 && m[iGasto - 1].fee !== null ? { v: m[iGasto - 1].fee, p: m[iGasto - 1].p } : null, // o mês antes de a mídia começar
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
    const subFee = med.antesFee ? `${variacao(fee, med.antesFee.v)} <span>era ${esc(BRL0.format(med.antesFee.v))} em ${mesCurto(med.antesFee.p)}</span>` : '<span>sem base de antes</span>';
    const subRoas = med.antesRoas ? `${variacao(roas, med.antesRoas.v)} <span>era ${esc(N1.format(med.antesRoas.v))} em ${mesCurto(med.antesRoas.p)}</span>` : '<span>sem base de antes</span>';
    return `<div class="ob-metricas">` +
      tile(esc, { rotulo: 'Honorário por mês', grande: fee === null ? 'sem dado' : BRL0.format(fee), sub: subFee, barras: barras(med.serieFee), href: funil, ir: 'funil', aria: `Honorário por mês, run rate: ${fee === null ? 'sem dado' : BRL0.format(fee)}. Abrir o Funil` }) +
      tile(esc, { rotulo: 'ROAS', grande: roas === null ? 'sem dado' : N1.format(roas), sub: subRoas, barras: barras(med.serieRoas), href: funil, ir: 'funil', aria: `ROAS: ${roas === null ? 'sem dado' : N1.format(roas)}. Abrir o Funil` }) + '</div>';
  }
  function setupHtml(c, esc) {
    const s = setupDe(c);
    const pc = s.planejados ? Math.round((s.noar / s.planejados) * 100) : 0;
    const pilulas = s.canais.length
      ? s.canais.map((x) => `<li data-estagio="${esc(x.stage || 'planejado')}">${esc(x.modulo)}<span class="ob-est">${esc(x.stage === 'em montagem' ? 'em teste' : (x.stage || 'planejado'))}</span></li>`).join('')
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
      `<header class="ob-topo"><span class="ob-sit" role="img" aria-label="${esc(nome)}" title="${esc(nome)}">${emoji}</span><h3 class="ob-nome">${esc(c.nome)}</h3>${sit === 'sem' ? '<span class="ob-semmed">sem medição ainda</span>' : ''}</header>` +
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
      if (li && e.key === 'Enter') { e.preventDefault(); li.blur(); }
    };
    alvo.onfocusout = (e) => {
      const li = e.target.closest && e.target.closest('.ob-meta');
      if (li && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.ob-metas') === li.closest('.ob-metas'))) salvaMetas(li.closest('.ob-cartao'), ctx);
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
    const avisos = (dados.falhas || []).map((f) =>
      `<div class="hj-aviso" data-aviso="fonte" data-fonte="${esc(f.fonte)}" role="status"><p>Não consegui ler ${esc(f.rotulo)}. Tente de novo.</p><button type="button" class="btn ghost" data-act="atualizar">Tentar de novo</button></div>`).join('');
    const grupos = PRIO_ORDEM.map((pr) => {
      const g = clientes.filter((c) => c.prio === pr);
      if (!g.length) return '';
      const cab = `<span class="ob-prio">${PRIO_ROTULO[pr]}</span><span class="hj-grupo-n">${plural(g.length, 'cliente', 'clientes')}</span>`;
      const grade = `<div class="ob-grade">${g.map((c) => cartaoObj(c, medidas((dados.mensais || {})[c.tenant]), metas[c.tenant], esc)).join('')}</div>`;
      // Cortesia e Admin (sem prioridade) vêm recolhidos: o foco é nos clientes que pagam ou vão pagar.
      return pr === 'cortesia' || pr === 'outros'
        ? `<details class="hj-grupo ob-grupo" data-prio="${pr}"><summary class="ob-grupo-t">${cab}</summary>${grade}</details>`
        : `<section class="hj-grupo ob-grupo" data-prio="${pr}" aria-label="${esc(PRIO_ROTULO[pr])}"><h2 class="ob-grupo-t">${cab}</h2>${grade}</section>`;
    }).join('');
    const legenda = Object.keys(SITUACAO).map((k) => `<li><span aria-hidden="true">${SITUACAO[k][0]}</span> ${esc(SITUACAO[k][1])}</li>`).join('');
    return `<div data-estado="ok">${avisos}${grupos}` +
      `<footer class="hj-rodape"><ul class="ob-legenda" aria-label="Legenda da situação">${legenda}</ul>` +
      `<p>Run rate: o mês corrente esticado até o fim. Resultado abre o Funil, Setup abre o Setup. Lido às ${hhmm(dados.lidoEm || new Date())} · <button type="button" class="btn ghost" data-act="atualizar">Atualizar</button></p></footer></div>`;
  }

  function render(dados, ctx) {
    const { esc } = ctx;
    const alvo = ctx.alvo;
    alvo.onclick = (e) => { if (e.target.closest('[data-act="atualizar"]')) ctx.atualiza(); };
    alvo.onkeydown = alvo.onfocusout = alvo.onpaste = null;
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
