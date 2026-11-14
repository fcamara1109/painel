// Página Setup: o quadro de setup dos clientes, com edição (botão Setup no topo do painel; ?pagina=setup abre direto).
// O painel.js carrega o dado (login, token, consulta ao BigQuery) e chama PainelSetup.render(foto, sobre, ctx):
//   foto  = a linha de analytics.setup_board: { generated_at, events_until, html, body }. `body` é o JSON do quadro (escopos de célula, cliente e
//           módulo, mapa de estados, papéis). O `html` da foto NÃO entra na página: o DOMParser (inerte, não roda nada) só lê dele a estrutura
//           (quem é coluna, quais módulos em quais grupos, avisos, legenda, opções do menu, totais). Tudo que aparece é montado aqui com textContent.
//           Desde o P5 (13/11/2026) o quadro é desenho do próprio painel, nos temas A e B, e não mais um iframe: a ordem das colunas por prioridade
//           e os grupos (só os que têm cliente) saem do estado de AGORA, com os eventos aplicados sobre a foto.
//   sobre = o último de cada campo dos seis eventos setup_* (planejado, estágio, nota, prioridade, tipo, nome), em todo o raw.events, sem
//           corte por horário (a consulta é idempotente: o que a foto já tem volta com o mesmo valor). Valem por cima da foto, na ordem do seq.
//   ctx   = { anota(eventos) }: o POST no webhook setup-anotar (painel.js). Devolve 'ok' | 'sem_login' | 'sem_permissao' | 'falha'.
// Clique numa célula, num cliente ou num módulo abre a gaveta com o histórico. Na gaveta, "Mudar estado" abre o menu de estados (Cmd/Ctrl+clique
// numa célula abre a gaveta já com o menu). Escolher pinta na hora, grava e desfaz a pintura se a gravação falhar.
(function () {
  'use strict';

  const EVENTO = { planned: 'setup_planned', stage: 'setup_stage', note: 'setup_note', priority: 'setup_priority', type: 'setup_type', name: 'setup_name' };
  const MSG = {
    ok: 'Gravado.',
    sem_login: 'Sua sessão expirou. Entre de novo; a mudança foi desfeita.',
    sem_permissao: 'Esta conta não pode gravar no quadro. A mudança foi desfeita.',
    falha: 'Não consegui gravar. A mudança foi desfeita.',
    nada: 'Nada mudou nesta célula.',
  };
  const PRIO_ORDEM = ['alta', 'media', 'baixa', 'cortesia', 'outros'];
  const PRIO_ROTULO = { alta: 'Alta', media: 'Média', baixa: 'Baixa', cortesia: 'Cortesia', outros: 'Sem prioridade' };
  const normPrio = (p) => {
    const s = String(p || '').toLowerCase().replace('é', 'e');
    return PRIO_ORDEM.indexOf(s) >= 0 ? s : 'outros';
  };

  // O quadro de agora. Zerado a cada render.
  let ctxAtual = null;
  let S = null; // { D, est, sobre: doBq, locais, fila, k (escopo da gaveta), menu, origem, timer }

  function el(tag, classe, txt) {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (txt !== undefined) e.textContent = txt;
    return e;
  }
  function attrs(e, a) { Object.keys(a).forEach((k) => e.setAttribute(k, a[k])); return e; }
  function limpa(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  const slot = (cls) => { const s = el('span', 'set-slot'); s.appendChild(el('i', 'set-f ' + cls)); return s; };
  const maiuscula = (t) => t.charAt(0).toUpperCase() + t.slice(1);

  // ------------------------------------------------------------ a foto: estrutura lida do html (inerte) e estado de agora
  function leFoto(html) {
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    const todos = (sel) => Array.prototype.slice.call(doc.querySelectorAll(sel));
    const grupos = [];
    todos('tbody tr').forEach((tr) => {
      if (tr.classList.contains('g')) {
        const th = tr.querySelector('th.gr');
        grupos.push({ nome: th ? th.textContent.trim() : '', mods: [] });
        return;
      }
      const b = tr.querySelector('th.mod button.nm[data-k^="m:"]');
      if (b && grupos.length) grupos[grupos.length - 1].mods.push(b.getAttribute('data-k').slice(2));
    });
    const forma = (e) => { const i = e.querySelector('i.f'); return i ? i.className.replace(/^f\s+/, '') : ''; };
    return {
      cols: todos('thead th.cli button.nm').map((b) => b.getAttribute('data-k').slice(2)),
      grupos,
      avisos: todos('ul.avisos li').map((li) => li.textContent.trim()),
      legenda: todos('ul.legenda li').map((li) => ({ cls: forma(li), texto: li.textContent.trim() })),
      ops: todos('#ed .ed-op').map((b) => ({ planned: b.getAttribute('data-planned'), stage: b.getAttribute('data-stage'), cls: forma(b), rotulo: b.textContent.trim() })),
      totais: todos('.totals li').map((li) => ({ n: (li.querySelector('.fc-numero') || {}).textContent || '0', legenda: (li.querySelector('.fc-legenda') || {}).textContent || '' })),
    };
  }

  const escopo = (k) => S.D.escopos[k] || {};
  const semEstagio = (v) => (v === S.D.sem ? '' : v);
  const cliNome = (t) => escopo('c:' + t).titulo || t;
  const modNome = (m) => escopo('m:' + m).titulo || m;
  const celChave = (k) => k.slice(2).replace(':', '|');
  const mexida = (k) => !!S.sobre[k] || (S.locais[k] || []).length > 0;

  // O que veio depois da foto: o último de cada campo, na ordem do seq. Planejado e estágio vão pra célula (S.sobre); nota, prioridade, tipo e
  // nome, direto no escopo (a foto em memória é nossa; o html dela nunca entra na página).
  function aplicaEventos(sobre) {
    (sobre || []).slice().sort((a, b) => Number(a.seq) - Number(b.seq)).forEach((r) => {
      const mod = r.module || '';
      if (r.event_name === EVENTO.planned || r.event_name === EVENTO.stage) {
        const k = r.tenant + '|' + mod;
        if (!S.celulas[k]) return;
        const o = S.sobre[k] = S.sobre[k] || {};
        if (r.event_name === EVENTO.planned) o.planned = r.value;
        if (r.event_name === EVENTO.stage) o.stage = semEstagio(r.value);
        return;
      }
      if (r.event_name === EVENTO.note) { // tenant e módulo = a célula; só tenant = o cliente; só módulo = o módulo
        const alvo = S.D.escopos[r.tenant && mod ? 'x:' + r.tenant + ':' + mod : r.tenant ? 'c:' + r.tenant : 'm:' + mod];
        if (alvo) alvo.nota = r.value;
        return;
      }
      const cli = S.D.escopos['c:' + r.tenant];
      if (!cli) return;
      if (r.event_name === EVENTO.priority) cli.priority = r.value;
      if (r.event_name === EVENTO.type) cli.client_type = r.value;
      if (r.event_name === EVENTO.name) cli.titulo = r.value;
    });
  }

  // Planejado e estágio da célula: a foto, depois o que veio depois dela, depois o que este navegador gravou (em ordem).
  // `soConfirmado`: sem o que ainda está gravando (é de onde sai o que a próxima gravação da célula tem de mandar).
  function efetivo(k, soConfirmado) {
    const x = escopo('x:' + k.replace('|', ':'));
    const e = { planned: x.planned || '', stage: x.stage || '' };
    const b = S.sobre[k] || {};
    if (b.planned !== undefined) e.planned = b.planned;
    if (b.stage !== undefined) e.stage = b.stage;
    (S.locais[k] || []).forEach((p) => {
      if (soConfirmado && p.pendente) return;
      if (p.planned) e.planned = p.planned;
      if (p.stage !== undefined) e.stage = p.stage;
    });
    return e;
  }

  // A forma da célula: o mapa de estados que vem na foto (planejado|estágio|tem histórico). Célula mexida tem histórico.
  function formaDe(k) {
    const e = efetivo(k);
    const hist = ((escopo('x:' + k.replace('|', ':')).historico || []).length > 0 || mexida(k)) ? 1 : 0;
    return S.D.estados[e.planned + '|' + e.stage + '|' + hist] || S.D.estados['||0'];
  }

  // Colunas na ordem de AGORA: prioridade (com os eventos), depois a ordem da foto. Só os grupos que têm cliente existem.
  function colunas() {
    const ordem = {};
    S.est.cols.forEach((t, i) => { ordem[t] = i; });
    return S.est.cols.map((t) => ({ t, prio: normPrio(escopo('c:' + t).priority) }))
      .sort((a, b) => PRIO_ORDEM.indexOf(a.prio) - PRIO_ORDEM.indexOf(b.prio) || ordem[a.t] - ordem[b.t]);
  }

  // Os totais do topo e a linha 'No ar / planejados' de cada cliente, refeitos do estado de cada célula (a regra é a de Estado.resumo do
  // ops_log.py; os estágios de cada papel vêm na foto, D.roles). As tarefas abertas ficam as da foto.
  function contas() {
    const R = S.D.roles;
    const por = {};
    let noAr = 0; let plan = 0; let trav = 0; let mont = 0;
    Object.keys(S.celulas).forEach((k) => {
      const t = k.split('|')[0];
      const c = por[t] = por[t] || { plan: 0, noAr: 0 };
      const e = efetivo(k);
      if (e.planned !== S.D.sim) return;
      if (e.stage !== R.off) { c.plan += 1; plan += 1; }
      if (e.stage === R.live) { c.noAr += 1; noAr += 1; } else if (e.stage === R.stuck) trav += 1; else if (e.stage === R.building) mont += 1;
    });
    return { por, noAr, plan, trav, mont };
  }

  // ------------------------------------------------------------ desenho
  function totaisUl() {
    const c = contas();
    const t = S.est.totais;
    const ul = el('ul', 'set-totais');
    ul.id = 'set-totais';
    const itens = [
      [c.noAr, t[0] ? t[0].legenda.replace(/\d+/, String(c.plan)) : ''],
      [c.trav, t[1] ? t[1].legenda : ''],
      [c.mont, t[2] ? t[2].legenda : ''],
    ];
    if (t[3]) itens.push([t[3].n, t[3].legenda]);
    itens.forEach(([n, l]) => {
      const li = el('li');
      li.appendChild(el('span', 'set-tot-n fc-numero', String(n)));
      li.appendChild(el('span', 'set-tot-t fc-legenda', l));
      ul.appendChild(li);
    });
    return ul;
  }

  function tabela() {
    const cols = colunas();
    const c = contas();
    const t = attrs(el('table', 'set-tab'), { 'data-quadro': '' });
    t.appendChild(el('caption', 'set-sr', 'Estado de cada módulo, um cliente por coluna'));
    const gp = [];
    cols.forEach((x) => { const u = gp[gp.length - 1]; if (u && u.prio === x.prio) u.n += 1; else gp.push({ prio: x.prio, n: 1 }); });
    const cab = el('thead');
    const r1 = el('tr');
    r1.appendChild(attrs(el('th', 'set-canto', 'Prioridade'), { scope: 'col' }));
    gp.forEach((g) => r1.appendChild(attrs(el('th', 'set-gp set-gi', PRIO_ROTULO[g.prio]), { 'data-prio': g.prio, colspan: String(g.n), scope: 'colgroup' })));
    const r2 = el('tr');
    r2.appendChild(attrs(el('th', 'set-canto', 'Módulo'), { scope: 'col' }));
    cols.forEach((x) => {
      const th = attrs(el('th', 'set-cli set-gi'), { 'data-p': x.prio, scope: 'col' });
      const b = attrs(el('button', 'set-nm'), { type: 'button', 'data-k': 'c:' + x.t });
      b.appendChild(el('span', 'set-nm-t', cliNome(x.t)));
      const tipo = escopo('c:' + x.t).client_type;
      if (tipo) b.appendChild(attrs(el('span', 'set-tp', tipo), { 'data-tipo': tipo.replace(/ /g, '-') }));
      th.appendChild(b);
      r2.appendChild(th);
    });
    cab.appendChild(r1);
    cab.appendChild(r2);
    t.appendChild(cab);
    const resumo = el('tbody', 'set-resumo');
    const rr = el('tr');
    rr.appendChild(attrs(el('th', 'set-mod set-res', 'No ar / planejados'), { scope: 'row' }));
    cols.forEach((x) => {
      const n = c.por[x.t] || { noAr: 0, plan: 0 };
      rr.appendChild(attrs(el('td', 'set-tot set-gi', n.noAr + '/' + n.plan), { 'data-p': x.prio }));
    });
    resumo.appendChild(rr);
    t.appendChild(resumo);
    S.est.grupos.forEach((g) => {
      const tb = el('tbody');
      const rg = el('tr', 'set-g');
      rg.appendChild(attrs(el('th', 'set-gr', g.nome), { scope: 'rowgroup', colspan: String(cols.length + 1) }));
      tb.appendChild(rg);
      g.mods.forEach((m) => {
        const tr = el('tr');
        const th = attrs(el('th', 'set-mod'), { scope: 'row' });
        const bm = attrs(el('button', 'set-nm'), { type: 'button', 'data-k': 'm:' + m });
        bm.textContent = modNome(m);
        th.appendChild(bm);
        tr.appendChild(th);
        cols.forEach((x) => {
          const k = x.t + '|' + m;
          const e = S.celulas[k];
          const td = attrs(el('td', 'set-gi'), { 'data-p': x.prio, 'data-tenant': x.t, 'data-module': m });
          if (!e) { tr.appendChild(td); return; }
          const f = formaDe(k);
          (f.t || []).forEach((cl) => td.classList.add('set-t-' + cl));
          const pend = (S.locais[k] || []).some((p) => p.pendente);
          const b = attrs(el('button', 'set-cel' + (S.k === 'x:' + x.t + ':' + m ? ' sel' : '')), {
            type: 'button', 'data-k': 'x:' + x.t + ':' + m, 'data-cel': k,
            'aria-label': cliNome(x.t) + ' · ' + modNome(m) + ': ' + f.a + (pend ? ' (gravando)' : ''),
          });
          b.appendChild(slot(f.f));
          td.appendChild(b);
          if (pend) {
            const marca = attrs(el('span', 'pend'), { title: 'gravando' });
            marca.appendChild(el('span', 'set-sr', 'gravando'));
            td.appendChild(marca);
          }
          tr.appendChild(td);
        });
        tb.appendChild(tr);
      });
      t.appendChild(tb);
    });
    return t;
  }

  function item(dt, dd) {
    const d = el('div');
    d.appendChild(el('dt', '', dt));
    d.appendChild(el('dd', '', dd));
    return d;
  }
  function bloco(rot, filho) {
    const d = el('div', 'set-g-bloco');
    d.appendChild(el('p', 'set-g-rot', rot));
    d.appendChild(filho);
    return d;
  }
  function lista(itens, vazio) {
    if (!itens.length) return el('p', 'set-dim', vazio);
    const ul = el('ul');
    itens.forEach((t) => ul.appendChild(el('li', '', t)));
    return ul;
  }

  function gaveta() {
    const g = document.getElementById('set-gaveta');
    limpa(g);
    if (!S.k) { g.hidden = true; return; }
    g.hidden = false;
    const k = S.k;
    const x = escopo(k);
    const tipo = k.charAt(0);
    const p = k.split(':');
    const titulo = tipo === 'x' ? cliNome(p[1]) + ' · ' + modNome(p[2]) : tipo === 'c' ? cliNome(p[1]) : modNome(p[1]);
    const cab = el('div', 'set-g-cab');
    cab.appendChild(attrs(el('h2', 'set-g-t', titulo), { id: 'set-g-t' }));
    cab.appendChild(attrs(el('button', 'set-fechar', 'Fechar'), { type: 'button', 'data-act': 'fecha-gaveta' }));
    g.appendChild(cab);
    if (tipo === 'x') {
      const ck = celChave(k);
      const e = efetivo(ck);
      const f = formaDe(ck);
      const est = el('div', 'set-g-estado');
      est.appendChild(slot(f.f));
      est.appendChild(el('span', '', maiuscula(f.a) + ((S.locais[ck] || []).some((q) => q.pendente) ? ' (gravando...)' : '')));
      g.appendChild(est);
      const dl = el('dl', 'set-g-dl');
      dl.appendChild(item('Planejado', e.planned || 'não definido'));
      dl.appendChild(item('Estágio', e.stage || 'não definido'));
      g.appendChild(dl);
      const ctl = el('div', 'set-g-ctl');
      const bt = attrs(el('button', 'set-mudar', 'Mudar estado'), { type: 'button', 'data-act': 'mudar-estado', 'aria-expanded': String(S.menu), 'aria-controls': 'set-menu' });
      ctl.appendChild(bt);
      const menu = attrs(el('div', 'set-menu'), { id: 'set-menu', role: 'menu', 'aria-label': 'Novo estado' });
      menu.hidden = !S.menu;
      S.est.ops.forEach((op, i) => {
        const atual = (e.planned === S.D.sim) === (op.planned === S.D.sim) && (op.stage === '' ? op.planned !== S.D.sim : op.stage === S.D.sem ? e.stage === '' : e.stage === op.stage);
        const b = attrs(el('button', 'set-op'), { type: 'button', role: 'menuitemradio', 'data-act': 'op-estado', 'data-op': String(i), 'aria-checked': String(atual) });
        b.appendChild(slot(op.cls));
        b.appendChild(document.createTextNode(maiuscula(op.rotulo)));
        menu.appendChild(b);
      });
      ctl.appendChild(menu);
      g.appendChild(ctl);
    } else if (tipo === 'c') {
      const dl = el('dl', 'set-g-dl');
      dl.appendChild(item('Prioridade', PRIO_ROTULO[normPrio(x.priority)]));
      dl.appendChild(item('Tipo', x.client_type || 'a definir'));
      g.appendChild(dl);
    }
    g.appendChild(bloco('Última nota', el('p', x.nota ? '' : 'set-dim', x.nota ? 'Última nota: ' + x.nota : 'Sem nota.')));
    if (x.precisa) g.appendChild(bloco('O que precisa', el('p', '', 'O que precisa: ' + x.precisa)));
    g.appendChild(bloco('Tarefas abertas', lista((x.tarefas || []).map((t) => '#' + t.numero + ' ' + t.nome), 'Nenhuma tarefa aberta.')));
    g.appendChild(bloco('Histórico', lista((x.historico || []).map((h) => h.quando + ' · ' + h.texto), 'Sem histórico.')));
  }

  // Refaz tudo que muda com o estado (totais, tabela, gaveta) e devolve o foco ao que estava focado (pelo data-k). A rolagem lateral da tabela fica.
  function refaz() {
    const raiz = document.getElementById('set-quadro');
    const ativo = document.activeElement;
    const chave = ativo && raiz.contains(ativo) ? ativo.getAttribute('data-k') : null;
    const rol = document.getElementById('set-rolagem');
    const esquerda = rol.scrollLeft;
    const tot = document.getElementById('set-totais');
    tot.parentNode.replaceChild(totaisUl(), tot);
    limpa(rol);
    rol.appendChild(tabela());
    rol.scrollLeft = esquerda;
    gaveta();
    document.getElementById('set-grade').classList.toggle('com-gaveta', !!S.k);
    if (chave) {
      const alvo = raiz.querySelector('[data-k="' + chave.replace(/"/g, '') + '"]');
      if (alvo) alvo.focus({ preventScroll: true });
    }
  }

  function mostra(txt) {
    const a = document.getElementById('set-aviso');
    a.textContent = txt;
    a.hidden = false;
    window.clearTimeout(S.timer);
    S.timer = window.setTimeout(() => { a.hidden = true; }, 4500);
  }

  // ------------------------------------------------------------ gaveta: abrir, fechar, mudar estado
  function abreGaveta(k, menu) {
    if (!S.D.escopos[k]) return;
    S.origem = document.querySelector('#set-quadro [data-k="' + k + '"]');
    S.k = k;
    S.menu = !!menu && k.charAt(0) === 'x';
    refaz();
    const g = document.getElementById('set-gaveta');
    g.focus({ preventScroll: true });
    if (window.matchMedia && matchMedia('(max-width: 999px)').matches) g.scrollIntoView({ block: 'nearest' });
  }

  function fechaGaveta() {
    const k = S.k;
    S.k = null;
    S.menu = false;
    refaz();
    const b = k ? document.querySelector('#set-quadro [data-k="' + k + '"]') : null;
    if (b) b.focus({ preventScroll: true });
  }

  // Escolheu um estado: pinta na hora, grava e, se a gravação falhar, desfaz. A gravação é uma de cada vez por célula: o que vai no pedido
  // sai da comparação com o que já foi CONFIRMADO, calculada só quando a anterior respondeu. Assim um clique não herda o estado de outro
  // que ainda não gravou (ou que falhou), e os pedidos da mesma célula chegam ao servidor na ordem dos cliques.
  async function escolhe(op) {
    const kx = S.k;
    const ck = celChave(kx);
    const [, tenant, modulo] = kx.split(':');
    const p = op.planned;
    const s = op.stage;
    const diferencas = (c) => ({ planned: !!p && p !== c.planned, stage: !!s && (s === S.D.sem ? c.stage !== '' : s !== c.stage) });
    const agora = diferencas(efetivo(ck));
    S.menu = false;
    if (!agora.planned && !agora.stage) { refaz(); mostra(MSG.nada); return; }
    const pedido = { pendente: true };
    if (p) pedido.planned = p;
    if (s) pedido.stage = semEstagio(s);
    (S.locais[ck] = S.locais[ck] || []).push(pedido);
    refaz();
    const anterior = S.fila[ck] || Promise.resolve();
    const minha = anterior.then(async () => {
      const falta = diferencas(efetivo(ck, true));
      const eventos = [];
      if (falta.planned) eventos.push({ event_name: EVENTO.planned, tenant, body: { module: modulo, value: p } });
      if (falta.stage) eventos.push({ event_name: EVENTO.stage, tenant, body: { module: modulo, value: s } });
      let resultado = 'ok'; // nada a gravar: o que a célula confirmada já tem é o que o clique pede
      if (eventos.length) {
        try { resultado = await ctxAtual.anota(eventos); } catch (err) { resultado = 'falha'; }
      }
      if (resultado === 'ok') {
        pedido.pendente = false;
      } else {
        if (S) S.locais[ck] = (S.locais[ck] || []).filter((x) => x !== pedido); // a tela pode ter sido refeita durante a gravação: S.locais é outro
      }
      return resultado;
    });
    S.fila[ck] = minha;
    const resultado = await minha;
    refaz();
    mostra(resultado === 'ok' ? MSG.ok : (MSG[resultado] || MSG.falha));
  }

  document.addEventListener('click', (ev) => {
    const raiz = document.getElementById('set-quadro');
    if (!S || !raiz || raiz.hidden || !raiz.contains(ev.target)) return;
    const a = ev.target.closest('[data-act]');
    if (a) {
      const act = a.getAttribute('data-act');
      if (act === 'fecha-gaveta') fechaGaveta();
      else if (act === 'mudar-estado') {
        S.menu = !S.menu;
        refaz();
        const b = raiz.querySelector('[data-act="mudar-estado"]');
        if (b) b.focus({ preventScroll: true });
      } else if (act === 'op-estado' && S.k) escolhe(S.est.ops[Number(a.getAttribute('data-op'))]);
      return;
    }
    const b = ev.target.closest('button[data-k]');
    if (b) abreGaveta(b.getAttribute('data-k'), (ev.metaKey || ev.ctrlKey) && b.getAttribute('data-k').charAt(0) === 'x');
  });
  document.addEventListener('keydown', (ev) => {
    const raiz = document.getElementById('set-quadro');
    if (ev.key !== 'Escape' || !S || !raiz || raiz.hidden || !S.k) return;
    if (S.menu) {
      S.menu = false;
      refaz();
      const b = raiz.querySelector('[data-act="mudar-estado"]');
      if (b) b.focus({ preventScroll: true });
    } else fechaGaveta();
  });

  // ------------------------------------------------------------ render
  function dataBr(txt) {
    const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d:\d\d)/.exec(txt || '');
    return m ? m[3] + '/' + m[2] + ' ' + m[4] : String(txt || '');
  }

  function render(foto, sobre, ctx) {
    const raiz = document.getElementById('set-quadro');
    const vazio = document.getElementById('set-vazio');
    const sub = document.getElementById('set-sub');
    ctxAtual = ctx;
    S = null;
    delete raiz.dataset.pronto;
    let D = null;
    if (foto) { try { D = JSON.parse(foto.body); } catch (e) { D = null; } }
    if (!D) {
      // sem foto (ainda não rodou, ou passou de 7 dias) ou foto ilegível: não desenha quadro velho nem em branco
      raiz.hidden = true;
      vazio.hidden = false;
      sub.textContent = '';
      limpa(document.getElementById('set-rolagem'));
      return;
    }
    vazio.hidden = true;
    const est = leFoto(foto.html);
    const celulas = {};
    Object.keys(D.escopos).forEach((chave) => { if (chave.indexOf('x:') === 0) celulas[celChave(chave)] = true; });
    S = { D, est, celulas, sobre: {}, locais: {}, fila: {}, k: null, menu: false, origem: null, timer: null };
    aplicaEventos(sobre);
    sub.textContent = 'Foto de ' + dataBr(foto.generated_at) + '. Estados, notas, nomes, tipos, prioridades e totais mudam na hora; o histórico entra na próxima foto (até 30 minutos).';
    // legenda e avisos: da foto, como texto
    const leg = document.getElementById('set-legenda');
    limpa(leg);
    est.legenda.forEach((l) => { const li = el('li'); li.appendChild(slot(l.cls)); li.appendChild(document.createTextNode(l.texto)); leg.appendChild(li); });
    document.getElementById('set-legenda-box').hidden = !est.legenda.length;
    const av = document.getElementById('set-avisos');
    limpa(av);
    est.avisos.forEach((t) => av.appendChild(el('li', '', t)));
    av.hidden = !est.avisos.length;
    document.getElementById('set-aviso').hidden = true;
    raiz.hidden = false;
    refaz();
    raiz.dataset.pronto = 'sim'; // o quadro está desenhado e os cliques ligados (o gabarito espera por isto)
  }

  window.PainelSetup = { render };
})();
