// Página Setup: o quadro de setup dos clientes, com edição. Só do Felipe (?pagina=setup; o botão não aparece no menu).
// O painel.js carrega o dado (login, token, consulta ao BigQuery) e chama PainelSetup.render(foto, sobre, ctx):
//   foto  = a linha de analytics.setup_board: { generated_at, events_until, html, body }. O html vem SEM script; entra num iframe
//           sem permissão de rodar script (sandbox), então nada que venha do BigQuery executa. `body` é o JSON do quadro.
//   sobre = o último de cada campo dos seis eventos setup_* (planejado, estágio, nota, prioridade, tipo, nome), em todo o raw.events, sem
//           corte por horário (a consulta é idempotente: o que a foto já tem volta com o mesmo valor). Pintados por cima da foto.
//           Cobertura: células, totais, resumo por cliente, nome, tipo (chip), nota e prioridade (gaveta). Fica pra próxima foto: a ordem e os
//           grupos das colunas por prioridade, e as linhas novas do histórico.
//   ctx   = { anota(eventos) }: o POST no webhook setup-anotar (painel.js). Devolve 'ok' | 'sem_login' | 'sem_permissao' | 'falha'.
// Cmd+clique (ou Ctrl+clique) numa célula abre o menu de estados. Escolher pinta na hora, grava e desfaz a pintura se a gravação falhar.
// Clique simples abre o histórico da célula, do cliente ou do módulo.
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
    const locais = {}; // k -> [{ planned, stage, pendente }] o que este navegador gravou ou está gravando
    const fila = {}; // k -> promessa da última gravação da célula: uma de cada vez, a seguinte só sai depois da anterior responder
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

    // O nome novo do cliente: cabeçalho, título da gaveta e texto do leitor de tela das células dele.
    function renomeia(tenant, nome) {
      const c = D.escopos['c:' + tenant];
      const antigo = c.titulo;
      c.titulo = nome;
      Object.keys(D.escopos).forEach((chave) => {
        if (chave.indexOf('x:' + tenant + ':') === 0) D.escopos[chave].titulo = nome + D.escopos[chave].titulo.slice(antigo.length);
      });
      Object.keys(orig).forEach((k) => {
        if (k.split('|')[0] === tenant) orig[k].aria = nome + orig[k].aria.slice(antigo.length);
      });
      const nm = doc.querySelector('th button.nm[data-k="c:' + tenant + '"]');
      if (nm && nm.firstChild && nm.firstChild.nodeType === 3) nm.firstChild.nodeValue = nome;
    }

    // O tipo novo no chip do cabeçalho: o desenho é copiado de outro chip do mesmo tipo, se houver (o texto sempre muda).
    function retipa(tenant, tipo) {
      const nm = doc.querySelector('th button.nm[data-k="c:' + tenant + '"]');
      if (!nm) return;
      const chave = tipo.replace(/ /g, '-');
      let chip = nm.querySelector('.tp');
      if (!chip) { chip = el(doc, 'span'); chip.className = 'tp'; nm.appendChild(chip); }
      const igual = Array.prototype.filter.call(doc.querySelectorAll('.tp'), (c) => c !== chip && c.getAttribute('data-tipo') === chave && c.querySelector('svg'))[0];
      limpa(chip);
      chip.setAttribute('data-tipo', chave);
      if (igual) chip.appendChild(igual.querySelector('svg').cloneNode(true));
      chip.appendChild(doc.createTextNode(tipo));
    }

    // O que veio depois da foto: o último de cada campo. Planejado e estágio vão pra célula; nota, prioridade, tipo e nome, pro escopo deles.
    (sobre || []).forEach((r) => {
      const mod = r.module || '';
      if (r.event_name === EVENTO.planned || r.event_name === EVENTO.stage) {
        const k = r.tenant + '|' + mod;
        if (!cels[k]) return;
        const o = doBq[k] = doBq[k] || {};
        if (r.event_name === EVENTO.planned) o.planned = r.value;
        if (r.event_name === EVENTO.stage) o.stage = semEstagio(r.value);
        return;
      }
      if (r.event_name === EVENTO.note) { // tenant e módulo = a célula; só tenant = o cliente; só módulo = o módulo
        const alvoNota = D.escopos[r.tenant && mod ? 'x:' + r.tenant + ':' + mod : r.tenant ? 'c:' + r.tenant : 'm:' + mod];
        if (alvoNota) alvoNota.nota = r.value;
        return;
      }
      const cli = D.escopos['c:' + r.tenant];
      if (!cli) return;
      if (r.event_name === EVENTO.priority) cli.priority = r.value;
      if (r.event_name === EVENTO.type) { cli.client_type = r.value; retipa(r.tenant, r.value); }
      if (r.event_name === EVENTO.name) renomeia(r.tenant, r.value);
    });

    const mexida = (k) => !!doBq[k] || (locais[k] || []).length > 0;

    // Planejado e estágio da célula: a foto, depois o que veio depois dela, depois o que este navegador gravou (em ordem).
    // `soConfirmado`: sem o que ainda está gravando (é de onde sai o que a próxima gravação da célula tem de mandar).
    function efetivo(k, soConfirmado) {
      const x = escopo(k);
      const e = { planned: x.planned || '', stage: x.stage || '' };
      const b = doBq[k] || {};
      if (b.planned !== undefined) e.planned = b.planned;
      if (b.stage !== undefined) e.stage = b.stage;
      (locais[k] || []).forEach((p) => {
        if (soConfirmado && p.pendente) return;
        if (p.planned) e.planned = p.planned;
        if (p.stage !== undefined) e.stage = p.stage;
      });
      return e;
    }

    // Os totais do topo e a linha 'No ar / planejados' de cada cliente, refeitos do estado de cada célula (a regra é a de Estado.resumo do
    // ops_log.py; os estágios de cada papel vêm na foto, D.roles).
    function recalcula() {
      const R = D.roles;
      const por = {};
      let noAr = 0;
      let plan = 0;
      let trav = 0;
      let mont = 0;
      Object.keys(cels).forEach((k) => {
        const t = k.split('|')[0];
        const c = por[t] = por[t] || { plan: 0, noAr: 0 };
        const e = efetivo(k);
        if (e.planned !== D.sim) return;
        if (e.stage !== R.off) { c.plan += 1; plan += 1; }
        if (e.stage === R.live) { c.noAr += 1; noAr += 1; } else if (e.stage === R.stuck) trav += 1; else if (e.stage === R.building) mont += 1;
      });
      const itens = doc.querySelectorAll('.totals li');
      const poe = (i, numero, legenda) => {
        if (!itens[i]) return;
        itens[i].querySelector('.fc-numero').textContent = String(numero);
        if (legenda !== undefined) itens[i].querySelector('.fc-legenda').textContent = legenda;
      };
      poe(0, noAr, itens[0] ? itens[0].querySelector('.fc-legenda').textContent.replace(/\d+/, String(plan)) : '');
      poe(1, trav);
      poe(2, mont);
      const colunas = doc.querySelectorAll('tbody.resumo td');
      Array.prototype.forEach.call(doc.querySelectorAll('thead th.cli button.nm'), (b, i) => {
        const c = por[b.getAttribute('data-k').slice(2)];
        if (c && colunas[i]) colunas[i].textContent = c.noAr + '/' + c.plan;
      });
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
        recalcula();
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
      recalcula();
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

    // Escolheu um estado: pinta na hora, grava e, se a gravação falhar, desfaz. A gravação é uma de cada vez por célula: o que vai no pedido
    // sai da comparação com o que já foi CONFIRMADO, calculada só quando a anterior respondeu. Assim um clique não herda o estado de outro
    // que ainda não gravou (ou que falhou), e os pedidos da mesma célula chegam ao servidor na ordem dos cliques.
    async function escolhe(op) {
      const a = alvo;
      const p = op.getAttribute('data-planned');
      const s = op.getAttribute('data-stage');
      const tenant = a.td.getAttribute('data-tenant');
      const modulo = a.td.getAttribute('data-module');
      const diferencas = (c) => ({ planned: !!p && p !== c.planned, stage: !!s && (s === D.sem ? c.stage !== '' : s !== c.stage) });
      const agora = diferencas(efetivo(a.k));
      fechaEditor();
      if (!agora.planned && !agora.stage) { mostra(MSG.nada); return; }
      const pedido = { pendente: true };
      if (p) pedido.planned = p;
      if (s) pedido.stage = semEstagio(s);
      (locais[a.k] = locais[a.k] || []).push(pedido);
      desenha(a.k);
      const anterior = fila[a.k] || Promise.resolve();
      const minha = anterior.then(async () => {
        const falta = diferencas(efetivo(a.k, true));
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
          locais[a.k] = locais[a.k].filter((x) => x !== pedido);
        }
        return resultado;
      });
      fila[a.k] = minha;
      const resultado = await minha;
      desenha(a.k);
      mostra(resultado === 'ok' ? MSG.ok : (MSG[resultado] || MSG.falha));
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
    Object.keys(cels).forEach(desenha); // nome novo, estado novo e totais refeitos antes de o gabarito (e a pessoa) mexerem
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
    sub.textContent = 'Foto de ' + foto.generated_at + '. Estados, notas, nomes, tipos e totais mudam na hora; a ordem por prioridade e o histórico entram na próxima foto (até 30 minutos).';
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
