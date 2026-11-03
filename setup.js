// Página Setup: o quadro de setup dos clientes, com edição. Só do Felipe (?pagina=setup; o botão não aparece no menu).
// O painel.js carrega o dado (login, token, consulta ao BigQuery) e chama PainelSetup.render(foto, sobre, ctx):
//   foto  = a linha de analytics.setup_board: { generated_at, events_until, html, body }. O html vem SEM script; entra num iframe
//           sem permissão de rodar script (sandbox), então nada que venha do BigQuery executa. `body` é o JSON do quadro.
//   sobre = os eventos setup_planned e setup_stage com hora depois de events_until (o último de cada célula): pintados por cima da foto.
//   ctx   = { anota(eventos) }: o POST no webhook setup-anotar (painel.js). Devolve 'ok' | 'sem_login' | 'sem_permissao' | 'falha'.
// Cmd+clique (ou Ctrl+clique) numa célula abre o menu de estados. Escolher pinta na hora, grava e desfaz a pintura se a gravação falhar.
// Clique simples abre o histórico da célula, do cliente ou do módulo.
(function () {
  'use strict';

  const EVENTO = { planned: 'setup_planned', stage: 'setup_stage' };
  const MSG = {
    ok: 'Gravado.',
    sem_login: 'Sua sessão expirou. Entre de novo; a mudança foi desfeita.',
    sem_permissao: 'Esta conta não pode gravar no quadro. A mudança foi desfeita.',
    falha: 'Não consegui gravar. A mudança foi desfeita.',
    nada: 'Nada mudou nesta célula.',
  };

  let ctxAtual = null;

  function el(doc, tag, txt) { const e = doc.createElement(tag); if (txt !== undefined) e.textContent = txt; return e; }
  function limpa(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  // O quadro dentro do iframe: a gaveta de histórico e o editor. `doc` é o documento do iframe; `D` o `body` da foto.
  function ligaQuadro(quadro, D, sobre) {
    const doc = quadro.contentDocument;
    const win = doc.defaultView;
    const ed = doc.getElementById('ed');
    const aviso = doc.getElementById('aviso');
    const gaveta = doc.getElementById('painel');
    if (!ed || !aviso || !gaveta) return;
    const ops = Array.prototype.slice.call(ed.querySelectorAll('.ed-op'));
    const TINTAS = D.tintas;
    const cels = {};
    const orig = {};
    const doBq = {}; // k -> { planned, stage } do que veio depois da foto
    const locais = {}; // k -> [{ id, planned, stage, pendente }] o que este navegador gravou ou está gravando
    let alvo = null;
    let timer = null;
    let origem = null;

    Array.prototype.forEach.call(doc.querySelectorAll('td[data-tenant]'), (td) => {
      const k = td.getAttribute('data-tenant') + '|' + td.getAttribute('data-module');
      cels[k] = td;
      orig[k] = {
        forma: td.querySelector('i.f').className,
        tinta: TINTAS.filter((c) => td.classList.contains(c)),
        aria: td.querySelector('button').getAttribute('aria-label'),
      };
    });

    const escopo = (k) => D.escopos['x:' + k.replace('|', ':')] || {};
    const semEstagio = (v) => (v === D.sem ? '' : v);

    // O que veio depois da foto: o último planejado e o último estágio de cada célula.
    (sobre || []).forEach((r) => {
      const k = r.tenant + '|' + r.module;
      if (!cels[k]) return;
      const o = doBq[k] = doBq[k] || {};
      if (r.event_name === EVENTO.planned) o.planned = r.value;
      if (r.event_name === EVENTO.stage) o.stage = semEstagio(r.value);
    });

    const mexida = (k) => !!doBq[k] || (locais[k] || []).length > 0;

    // Planejado e estágio da célula: a foto, depois o que veio depois dela, depois o que este navegador gravou (em ordem).
    function efetivo(k) {
      const x = escopo(k);
      const e = { planned: x.planned || '', stage: x.stage || '' };
      const b = doBq[k] || {};
      if (b.planned !== undefined) e.planned = b.planned;
      if (b.stage !== undefined) e.stage = b.stage;
      (locais[k] || []).forEach((p) => {
        if (p.planned) e.planned = p.planned;
        if (p.stage !== undefined) e.stage = p.stage;
      });
      return e;
    }

    function desenha(k) {
      const td = cels[k];
      const icone = td.querySelector('i.f');
      const botao = td.querySelector('button');
      const o = orig[k];
      const marca = td.querySelector('.pend');
      if (marca) td.removeChild(marca);
      TINTAS.forEach((c) => td.classList.remove(c));
      if (!mexida(k)) {
        icone.className = o.forma;
        o.tinta.forEach((c) => td.classList.add(c));
        botao.setAttribute('aria-label', o.aria);
        return;
      }
      const e = efetivo(k);
      const s = D.estados[e.planned + '|' + e.stage + '|1']; // célula mexida tem histórico
      const corte = o.aria.lastIndexOf(': ') + 2;
      const pendente = (locais[k] || []).some((p) => p.pendente);
      icone.className = 'f ' + s.f;
      s.t.forEach((c) => td.classList.add(c));
      botao.setAttribute('aria-label', o.aria.slice(0, corte) + s.a + (pendente ? ' (gravando)' : ''));
      if (pendente) {
        const m = el(doc, 'span');
        const dica = el(doc, 'span', 'gravando');
        m.className = 'pend';
        dica.className = 'sr';
        m.appendChild(dica);
        m.title = 'gravando';
        td.appendChild(m);
      }
    }

    function mostra(txt) {
      aviso.textContent = txt;
      aviso.hidden = false;
      window.clearTimeout(timer); // o timer é do painel: no iframe sem script ele nunca dispararia
      timer = window.setTimeout(() => { aviso.hidden = true; }, 4500);
    }

    function fechaEditor() {
      const td = alvo ? alvo.td : null;
      ed.hidden = true;
      alvo = null;
      const b = td ? td.querySelector('button') : null;
      if (b) b.focus();
    }

    function abreEditor(td) {
      const k = td.getAttribute('data-tenant') + '|' + td.getAttribute('data-module');
      const e = efetivo(k);
      let foco = null;
      alvo = { td, k };
      ops.forEach((op) => {
        const p = op.getAttribute('data-planned');
        const s = op.getAttribute('data-stage');
        const sim = p === D.sim;
        const atual = (e.planned === D.sim) === sim && (s === '' ? !sim : s === D.sem ? e.stage === '' : e.stage === s);
        op.classList.toggle('on', atual);
        op.setAttribute('aria-checked', atual ? 'true' : 'false');
        if (atual || !foco) foco = op;
      });
      ed.hidden = false;
      const r = td.getBoundingClientRect();
      const esquerda = Math.max(8, Math.min(r.left, win.innerWidth - ed.offsetWidth - 8));
      ed.style.left = (esquerda + win.pageXOffset) + 'px';
      ed.style.top = (r.bottom + win.pageYOffset + 4) + 'px';
      if (foco) foco.focus();
    }

    // Escolheu um estado: pinta, grava e, se a gravação falhar, desfaz.
    async function escolhe(op) {
      const a = alvo;
      const p = op.getAttribute('data-planned');
      const s = op.getAttribute('data-stage');
      const e = efetivo(a.k);
      const tenant = a.td.getAttribute('data-tenant');
      const modulo = a.td.getAttribute('data-module');
      const pedido = { id: tenant + '|' + modulo + '|' + Date.now(), pendente: true };
      const eventos = [];
      if (p && p !== e.planned) {
        pedido.planned = p;
        eventos.push({ event_name: EVENTO.planned, tenant, body: { module: modulo, value: p } });
      }
      if (s && (s === D.sem ? e.stage !== '' : s !== e.stage)) {
        pedido.stage = semEstagio(s);
        eventos.push({ event_name: EVENTO.stage, tenant, body: { module: modulo, value: s } });
      }
      fechaEditor();
      if (!eventos.length) { mostra(MSG.nada); return; }
      (locais[a.k] = locais[a.k] || []).push(pedido);
      desenha(a.k);
      let resultado = 'falha';
      try { resultado = await ctxAtual.anota(eventos); } catch (err) { resultado = 'falha'; }
      if (resultado === 'ok') {
        pedido.pendente = false;
        desenha(a.k);
        mostra(MSG.ok);
      } else {
        locais[a.k] = locais[a.k].filter((x) => x !== pedido);
        desenha(a.k);
        mostra(MSG[resultado] || MSG.falha);
      }
    }

    // Gaveta de histórico (a mesma do quadro de antes): célula, cliente ou módulo.
    function lista(id, itens, vazio) {
      const ul = doc.getElementById(id);
      limpa(ul);
      if (!itens.length) { const v = el(doc, 'li', vazio); v.className = 'q'; ul.appendChild(v); return; }
      itens.forEach((t) => ul.appendChild(el(doc, 'li', t)));
    }

    function abreGaveta(k, btn) {
      const x = D.escopos[k];
      if (!x) return;
      origem = btn;
      doc.getElementById('p-titulo').textContent = x.titulo;
      let estado = '';
      if (x.tipo === 'cel') {
        const e = efetivo(k.slice(2).replace(':', '|'));
        estado = 'Planejado: ' + (e.planned || 'não definido') + ' · Estágio: ' + (e.stage || 'não definido');
      }
      if (x.tipo === 'cli') estado = [x.priority ? 'Prioridade: ' + x.priority : '', x.client_type ? 'Tipo: ' + x.client_type : ''].filter(Boolean).join(' · ');
      doc.getElementById('p-estado').textContent = estado;
      doc.getElementById('p-nota').textContent = x.nota ? 'Última nota: ' + x.nota : 'Sem nota.';
      doc.getElementById('p-precisa').textContent = x.precisa ? 'O que precisa: ' + x.precisa : '';
      lista('p-tarefas', x.tarefas.map((t) => '#' + t.numero + ' ' + t.nome), 'Nenhuma tarefa aberta.');
      lista('p-hist', x.historico.map((h) => h.quando + ' · ' + h.texto), 'Sem histórico.');
      gaveta.hidden = false;
      gaveta.focus();
    }

    function fechaGaveta() {
      gaveta.hidden = true;
      if (origem) origem.focus();
      origem = null;
    }

    ops.forEach((op) => op.addEventListener('click', () => { if (alvo) escolhe(op); }));
    doc.addEventListener('click', (ev) => {
      const td = ev.target.closest ? ev.target.closest('td[data-tenant]') : null;
      if ((ev.metaKey || ev.ctrlKey) && td) { ev.preventDefault(); abreEditor(td); return; }
      const b = ev.target.closest ? ev.target.closest('button[data-k]') : null;
      if (b) { abreGaveta(b.getAttribute('data-k'), b); return; }
      if (!ed.hidden && !ed.contains(ev.target)) fechaEditor();
      if (!gaveta.hidden && !gaveta.contains(ev.target)) fechaGaveta();
    });
    doc.getElementById('p-fechar').addEventListener('click', fechaGaveta);
    doc.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      if (!ed.hidden) fechaEditor();
      else if (!gaveta.hidden) fechaGaveta();
    });
    Object.keys(doBq).forEach(desenha);
    quadro.dataset.pronto = 'sim'; // o quadro está desenhado e os cliques ligados (o gabarito espera por isto)
  }

  function render(foto, sobre, ctx) {
    const quadro = document.getElementById('set-quadro');
    const vazio = document.getElementById('set-vazio');
    const sub = document.getElementById('set-sub');
    ctxAtual = ctx;
    if (!foto) {
      // sem foto (ainda não rodou, ou passou de 7 dias): não desenha quadro velho nem em branco
      quadro.hidden = true;
      vazio.hidden = false;
      sub.textContent = '';
      quadro.removeAttribute('srcdoc');
      delete quadro.dataset.pronto;
      return;
    }
    vazio.hidden = true;
    quadro.hidden = false;
    sub.textContent = 'Foto de ' + foto.generated_at + '. O que mudou depois dela aparece na hora.';
    let D;
    try { D = JSON.parse(foto.body); } catch (e) { D = null; }
    if (!D) {
      quadro.hidden = true;
      vazio.hidden = false;
      return;
    }
    delete quadro.dataset.pronto;
    quadro.addEventListener('load', function ligar() {
      quadro.removeEventListener('load', ligar);
      ligaQuadro(quadro, D, sobre);
    });
    quadro.srcdoc = foto.html;
  }

  window.PainelSetup = { render };
})();
