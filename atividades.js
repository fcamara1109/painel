// Página Atividades: a linha do tempo do que aconteceu entre o Felipe e cada cliente (setup, reunião gravada, tarefa, dia de WhatsApp).
// O painel.js carrega o dado (login, token, consulta sql/activities.sql ao BigQuery) e chama PainelAtividades.render(linhas, ctx):
//   linhas = [{ ts 'AAAA-MM-DD HH:MM' (São Paulo), tenant, kind, event_name, title, detail (JSON do body, chaves em inglês), link, event_id }]
//            null = carregando; false = a consulta falhou (só limpa a lista).
//   ctx    = { esc, inicio, fim, dias, tenant, carrega(dias) }: o período consultado, o cliente do ?tenant= (pré-filtro; '' = todos) e o pedido de nova consulta quando o período muda.
// Os rótulos em pt-BR nascem aqui, do event_name e do detail; o id do módulo vira nome por modulos.js (gerado do catálogo do adm).
// Cliente e tipo filtram aqui, sem nova consulta. Só leitura: nada nesta página grava.
(function () {
  'use strict';

  const TIPOS = {
    setup: { rotulo: 'Setup', icone: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>' },
    meeting: { rotulo: 'Reunião', icone: '<rect x="3" y="6" width="12" height="12" rx="2"/><path d="m15 10 6-3v10l-6-3"/>' },
    task: { rotulo: 'Tarefa', icone: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/>' },
    whatsapp_day: { rotulo: 'WhatsApp', icone: '<path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z"/>' },
  };
  const CARTAO = new Set(['meeting', 'whatsapp_day']); // têm resumo: viram cartão; setup e tarefa ficam em linha compacta
  const svg = (classe, miolo) => `<svg class="${classe}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${miolo}</svg>`;
  const TAREFA = { task_created: 'Tarefa criada', task_prioritized: 'Tarefa priorizada', task_done: 'Tarefa feita', task_cancelled: 'Tarefa cancelada' };
  const SETUP = { setup_stage: 'Estágio', setup_planned: 'Planejado', setup_note: 'Nota', setup_priority: 'Prioridade do cliente', setup_type: 'Tipo do cliente', setup_name: 'Nome do cliente' };
  const PERIODOS = [[7, 'Últimos 7 dias'], [30, 'Últimos 30 dias'], [90, 'Últimos 90 dias']];
  const SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

  const estado = { ligado: new Set(Object.keys(TIPOS)), cliente: '' };
  let linhasAtuais = []; // a última lista recebida (o filtro de cliente e tipo redesenha sem consultar de novo)
  let ctxAtual = null;
  let tenantInicial = false; // o ?tenant= vale só na primeira desenhada: depois quem manda é o seletor da página

  const nomeModulo = (id) => (window.MODULOS_SETUP && Object.prototype.hasOwnProperty.call(window.MODULOS_SETUP, id) ? window.MODULOS_SETUP[id] : id);
  const rotuloCliente = (t) => (t === 'felipe' ? 'Sem cliente' : t);
  const dataBr = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

  function leDetail(l) {
    try {
      const d = JSON.parse(l.detail || '{}');
      return d && typeof d === 'object' ? d : {};
    } catch (e) {
      return {};
    }
  }

  function titulo(l, d) {
    if (l.kind === 'meeting') return (d.title || l.title || 'Reunião') + (d.duration_min ? ` (${d.duration_min} min)` : '');
    if (l.kind === 'whatsapp_day') return `${d.group_name || 'Grupo'}: ${d.messages_total || 0} mensagens`;
    if (l.kind === 'task') return `${TAREFA[l.event_name] || 'Tarefa'} #${d.task_no || '?'}: ${d.name || ''}`;
    if (l.kind === 'setup') {
      const quem = d.module ? `${nomeModulo(d.module)}: ` : '';
      const valor = d.value !== undefined && d.value !== null ? d.value : '';
      return `${quem}${SETUP[l.event_name] || 'Mudança'}${l.event_name === 'setup_note' ? '' : ` → ${valor}`}`;
    }
    return l.title || '';
  }

  function lista(rotulo, itens, esc) {
    return itens.length ? `<p class="atv-rot">${rotulo}</p><ul>${itens.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  }

  function corpo(l, d, esc) {
    let h = '';
    if (l.kind === 'meeting') {
      if (d.summary) h += `<p>${esc(d.summary)}</p>`;
      h += lista('Decisões', Array.isArray(d.decisions) ? d.decisions : [], esc);
      h += lista('Próximos passos', (Array.isArray(d.next_steps) ? d.next_steps : []).map((p) => (p && p.who ? `${p.who}: ${p.what || ''}` : String((p && p.what) || ''))), esc);
      if (l.link && /^https:\/\//.test(l.link)) h += `<p><a href="${esc(l.link)}" target="_blank" rel="noopener">Abrir gravação no Fathom ↗</a></p>`;
    } else if (l.kind === 'whatsapp_day') {
      const por = Array.isArray(d.by_person) ? d.by_person : [];
      if (por.length) h += `<p>${por.map((p) => `${esc(p.name)}: <b>${esc(p.n)}</b>`).join(' · ')}</p>`;
      if (d.summary) h += `<p>${esc(d.summary)}</p>`;
    } else if (l.kind === 'task') {
      if (d.assignee && d.assignee !== 'felipe') h += `<p>Responsável: ${esc(d.assignee)}</p>`; // o Felipe é o padrão: só aparece quando é outra pessoa
    } else if (l.kind === 'setup' && l.event_name === 'setup_note' && d.text) {
      h += `<p>${esc(d.text)}</p>`;
    }
    return h;
  }

  function unicas(linhas, ctx) {
    const vistos = new Set();
    return linhas.filter((l) => {
      const dia = String(l.ts || '').slice(0, 10);
      const dentro = dia >= ctx.inicio && dia <= ctx.fim && TIPOS[l.kind];
      const chave = l.event_id || `${l.ts}|${l.tenant}|${l.event_name}`;
      if (!dentro || vistos.has(chave)) return false;
      vistos.add(chave);
      return true;
    });
  }

  function diaRotulo(dia) {
    const [a, m, d] = dia.split('-').map(Number);
    return `${SEMANA[new Date(a, m - 1, d, 12).getDay()]}, ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
  }

  function filtros(ctx, clientes) {
    const opCli = ['<option value="">Todos os clientes</option>'].concat(clientes.map((t) => `<option value="${ctx.esc(t)}"${t === estado.cliente ? ' selected' : ''}>${ctx.esc(rotuloCliente(t))}</option>`));
    const opPer = PERIODOS.map(([n, r]) => `<option value="${n}"${n === ctx.dias ? ' selected' : ''}>${r}</option>`);
    return `<label class="atv-campo"><span class="fc-rotulo">Cliente</span><select class="campo" id="atv-cliente">${opCli.join('')}</select></label>`
      + `<label class="atv-campo"><span class="fc-rotulo">Período</span><select class="campo" id="atv-periodo">${opPer.join('')}</select></label>`
      + '<div class="atv-campo"><span class="fc-rotulo" id="atv-tipos-r">Tipo</span><div class="atv-chips" id="atv-chips" data-filtro="kind" role="group" aria-labelledby="atv-tipos-r"></div></div>';
  }

  function desenha() {
    const ctx = ctxAtual;
    const todas = unicas(linhasAtuais, ctx);
    const doCliente = todas.filter((l) => !estado.cliente || l.tenant === estado.cliente);
    document.getElementById('atv-chips').innerHTML = Object.keys(TIPOS).map((k) => {
      const n = doCliente.filter((l) => l.kind === k).length;
      return `<button type="button" class="atv-chip" data-kind="${k}" aria-pressed="${estado.ligado.has(k)}">${svg('atv-ok', '<path d="m5 12.5 4.5 4.5L19 7.5"/>')}${svg('atv-tp', TIPOS[k].icone)}${TIPOS[k].rotulo} <span class="atv-n">${n}</span></button>`;
    }).join('');
    const mostradas = doCliente.filter((l) => estado.ligado.has(l.kind)).sort((a, b) => (`${b.ts} ${b.event_id || ''}`).localeCompare(`${a.ts} ${a.event_id || ''}`));
    document.getElementById('atv-sub').textContent = `${mostradas.length} ${mostradas.length === 1 ? 'atividade' : 'atividades'} de ${dataBr(ctx.inicio)} a ${dataBr(ctx.fim)}`;
    const saida = document.getElementById('atv-lista');
    if (!mostradas.length) {
      saida.innerHTML = '<p class="nota atv-vazio">Nada neste período com estes filtros.</p>';
      return;
    }
    const porDia = [];
    mostradas.forEach((l) => {
      const dia = l.ts.slice(0, 10);
      if (!porDia.length || porDia[porDia.length - 1][0] !== dia) porDia.push([dia, []]);
      porDia[porDia.length - 1][1].push(l);
    });
    saida.innerHTML = porDia.map(([dia, itens]) => `<section class="atv-dia"><h3>${diaRotulo(dia)}</h3><div class="atv-linha">`
      + itens.map((l) => {
        const d = leDetail(l);
        const hora = l.kind === 'whatsapp_day' ? 'dia todo' : l.ts.slice(11);
        return `<article class="atv-item ${CARTAO.has(l.kind) ? 'atv-cartao' : 'atv-compacto'}" data-kind="${ctx.esc(l.kind)}" data-tenant="${ctx.esc(l.tenant)}">`
          + `<span class="atv-ic">${svg('atv-tp', TIPOS[l.kind].icone)}</span>`
          + `<header><h4>${ctx.esc(titulo(l, d))}</h4><span class="atv-meta">${hora} · <span class="atv-cli">${ctx.esc(rotuloCliente(l.tenant))}</span></span></header>`
          + `<div class="atv-det">${corpo(l, d, ctx.esc)}</div></article>`;
      }).join('') + '</div></section>').join('');
  }

  function render(linhas, ctx) {
    ctxAtual = ctx;
    const saida = document.getElementById('atv-lista');
    if (linhas === null || linhas === false) {
      document.getElementById('atv-sub').textContent = '';
      saida.innerHTML = linhas === null ? '<p class="nota atv-carregando" role="status">Carregando as atividades...</p>' : '';
      if (!document.getElementById('atv-cliente')) document.getElementById('atv-filtros').innerHTML = filtros(ctx, []);
      return;
    }
    linhasAtuais = linhas;
    if (!tenantInicial) { estado.cliente = ctx.tenant || ''; tenantInicial = true; }
    const clientes = [...new Set(unicas(linhas, ctx).map((l) => l.tenant).concat(estado.cliente ? [estado.cliente] : []))].sort(); // cliente do ?tenant= sem atividade segue escolhido: lista vazia, não "todos"

    document.getElementById('atv-filtros').innerHTML = filtros(ctx, clientes);
    desenha();
  }

  document.addEventListener('change', (e) => {
    if (e.target.id === 'atv-cliente') {
      estado.cliente = e.target.value;
      desenha();
    } else if (e.target.id === 'atv-periodo' && ctxAtual) {
      ctxAtual.carrega(Number(e.target.value));
    }
  });

  document.addEventListener('click', (e) => {
    const b = e.target.closest ? e.target.closest('#atv-chips .atv-chip') : null;
    if (!b) return;
    if (estado.ligado.has(b.dataset.kind)) estado.ligado.delete(b.dataset.kind); else estado.ligado.add(b.dataset.kind);
    desenha();
  });

  window.PainelAtividades = { render, titulo, TIPOS };
})();
