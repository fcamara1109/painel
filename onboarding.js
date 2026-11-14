// Página Onboarding: o mapa do onboarding dos clientes (botão Onboarding no topo do painel; ?pagina=onboarding abre direto).
// O painel.js carrega o dado (login, token, consulta ao BigQuery) e chama PainelOnboarding.render(linha):
//   linha = a linha mais recente de analytics.onboarding_map: { generated_at, version, html }. O html é o arquivo único que o build.py do mapa
//           gera (CSS e script próprios, nomes de cliente dentro): por isso ele NUNCA está neste repo, só no BigQuery.
// O html entra num <iframe srcdoc> (criado aqui) com sandbox "allow-scripts allow-popups allow-popups-to-escape-sandbox" e SEM allow-same-origin: o script do
// mapa roda (abas, filtros, abrir e recolher), mas a origem dele é opaca, então não alcança o token nem o armazenamento do painel.
//   - <base href="about:srcdoc">: num srcdoc o endereço-base é o do painel, e um link só com fragmento (#clientes) carregaria o painel inteiro
//     dentro do iframe. Com a base em about:srcdoc, #clientes e #e-<id> mudam só o hash do mapa.
//   - allow-popups-to-escape-sandbox: os links externos do Método (target=_blank) abrem em aba nova que roda normal, sem herdar o sandbox.
//   - Moldura (P5, 13/11/2026): o título é o da página (h1) e as abas do mapa (nav#abas a[data-aba], lidas do html com DOMParser, que não executa nada)
//     sobem para a página como abas e mudam o hash do iframe por mensagem. Dentro do iframe, um trecho nosso esconde o hero e as abas do mapa, tira a
//     rolagem e avisa a altura do conteúdo: o iframe tem a altura inteira do mapa e quem rola é a página (uma rolagem só).
(function () {
  'use strict';

  const SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';
  const BASE = '<base href="about:srcdoc">';
  const ABAS_PADRAO = [['caminho', 'Caminho'], ['clientes', 'Clientes'], ['metodo', 'Método']];
  const ALTURA_MAXIMA = 20000;
  // Dentro do iframe: esconde o hero e as abas do mapa (a página tem as dela), sem rolagem própria; avisa a altura e ouve o hash que a página manda.
  // Um hash #e-<id> (etapa) também avisa onde a etapa está, para a página rolar até ela.
  const INJETADO = '<style>html,body{margin:0}body{overflow:hidden}#titulo-exemplo,.hero,#abas{display:none!important}</style>'
    + '<script>(function(){function h(){var b=document.body;var o={fc:"mapa",h:Math.ceil(b.getBoundingClientRect().bottom+window.pageYOffset),hash:location.hash.replace(/^#/,"")};'
    + 'var e=o.hash&&document.getElementById(o.hash);if(e)o.topo=Math.round(e.getBoundingClientRect().top+window.pageYOffset);parent.postMessage(o,"*")}'
    + 'addEventListener("load",h);addEventListener("hashchange",function(){setTimeout(h,30)});addEventListener("resize",h);'
    + 'if(window.ResizeObserver)new ResizeObserver(h).observe(document.body);'
    + 'addEventListener("message",function(e){var d=e.data;if(d&&d.fc==="hash"){location.hash=d.v;setTimeout(h,30)}})})();<\/script>';

  let ultima = null;
  let abaAtual = 'caminho';

  // O iframe nasce na primeira vez que há mapa (não existe no index.html): quem não abre a página não carrega um documento isolado à toa.
  function criaQuadro() {
    let q = document.getElementById('onb-quadro');
    if (!q) {
      q = document.createElement('iframe');
      q.id = 'onb-quadro';
      q.title = 'Mapa do onboarding dos clientes';
      q.setAttribute('sandbox', SANDBOX);
      q.setAttribute('scrolling', 'no');
      q.hidden = true;
      document.getElementById('pg-onboarding').appendChild(q);
    }
    return q;
  }

  function comBase(html) {
    return /<head[\s>]/i.test(html) ? html.replace(/<head(\s[^>]*)?>/i, (m) => m + BASE) : BASE + html;
  }

  function comInjetado(html) {
    const i = html.search(/<\/body>(?![\s\S]*<\/body>)/i);
    return i >= 0 ? html.slice(0, i) + INJETADO + html.slice(i) : html + INJETADO;
  }

  // As abas do próprio mapa (nav#abas a[data-aba]): o DOMParser não roda script nem carrega nada; sem abas no html, as três de sempre.
  function abasDoMapa(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const lista = Array.prototype.map.call(doc.querySelectorAll('nav#abas a[data-aba]'), (a) => [a.getAttribute('data-aba'), a.textContent.trim()]);
    return lista.length ? lista : ABAS_PADRAO;
  }

  function desenhaAbas(abas) {
    const nav = document.getElementById('onb-abas');
    while (nav.firstChild) nav.removeChild(nav.firstChild);
    abas.forEach(([k, t]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'onb-aba';
      b.setAttribute('role', 'tab');
      b.setAttribute('data-aba-mapa', k);
      b.setAttribute('aria-selected', String(k === abaAtual));
      b.textContent = t;
      nav.appendChild(b);
    });
    nav.hidden = false;
  }

  function marcaAba(k) {
    abaAtual = k;
    document.querySelectorAll('#onb-abas [data-aba-mapa]').forEach((b) => b.setAttribute('aria-selected', String(b.getAttribute('data-aba-mapa') === k)));
  }

  // Sem mapa na tela: o iframe some e o html que estava nele também (mapa velho não fica à mão depois de um erro).
  function limpa() {
    const quadro = document.getElementById('onb-quadro');
    if (quadro) {
      quadro.hidden = true;
      quadro.removeAttribute('srcdoc');
      delete quadro.dataset.pronto;
    }
    const nav = document.getElementById('onb-abas');
    if (nav) { nav.hidden = true; while (nav.firstChild) nav.removeChild(nav.firstChild); }
    document.getElementById('onb-vazio').hidden = true;
    document.getElementById('onb-sub').textContent = '';
    ultima = null;
  }

  function dataBr(texto) {
    const m = /^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d:\d\d))?/.exec(texto || '');
    return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ? ' ' + m[4] : ''}` : String(texto || '');
  }

  function render(linha, manterAba) {
    limpa();
    if (!manterAba) abaAtual = 'caminho';
    if (!linha || !linha.html) {
      document.getElementById('onb-vazio').hidden = false;
      return;
    }
    ultima = linha;
    const quadro = criaQuadro();
    document.getElementById('onb-sub').textContent = 'Publicado em ' + dataBr(linha.generated_at) + '. O mapa não muda sozinho: só quando o Felipe publica de novo.';
    desenhaAbas(abasDoMapa(linha.html));
    quadro.hidden = false;
    quadro.addEventListener('load', function pronto() {
      quadro.removeEventListener('load', pronto);
      quadro.dataset.pronto = 'sim';
    });
    quadro.srcdoc = comBase(comInjetado(window.FcTema ? FcTema.injeta(linha.html) : linha.html)); // o mapa segue o tema escolhido no topo
  }

  // O mapa avisa a altura do conteúdo (e o hash, e onde a etapa do hash está); só vale o que vem do nosso iframe.
  window.addEventListener('message', (e) => {
    const quadro = document.getElementById('onb-quadro');
    if (!quadro || e.source !== quadro.contentWindow || !e.data || e.data.fc !== 'mapa') return;
    const h = Number(e.data.h);
    if (h > 0 && h < ALTURA_MAXIMA) quadro.style.height = h + 'px';
    const hash = String(e.data.hash || '');
    const aba = /^e-/.test(hash) ? 'caminho' : hash;
    if (aba && document.querySelector(`#onb-abas [data-aba-mapa="${aba.replace(/"/g, '')}"]`)) marcaAba(aba);
    if (e.data.topo !== undefined && Number(e.data.topo) >= 0) {
      const reduzido = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
      const topoPainel = (document.querySelector('.topo') || { offsetHeight: 0 }).offsetHeight;
      window.scrollTo({ top: Math.max(0, quadro.getBoundingClientRect().top + window.scrollY + Number(e.data.topo) - topoPainel - 16), behavior: reduzido ? 'auto' : 'smooth' });
    }
  });

  document.addEventListener('click', (e) => {
    const b = e.target.closest ? e.target.closest('#onb-abas [data-aba-mapa]') : null;
    const quadro = document.getElementById('onb-quadro');
    if (!b || !quadro || !quadro.contentWindow) return;
    marcaAba(b.getAttribute('data-aba-mapa'));
    quadro.contentWindow.postMessage({ fc: 'hash', v: abaAtual }, '*');
  });

  // trocou o tema no topo: redesenha o mapa com o tema novo (volta para a aba em que estava)
  document.addEventListener('fc-tema', () => {
    const q = document.getElementById('onb-quadro');
    if (ultima && q && q.srcdoc) {
      render(ultima, true);
      const quadro = document.getElementById('onb-quadro');
      quadro.addEventListener('load', function volta() {
        quadro.removeEventListener('load', volta);
        marcaAba(abaAtual);
        if (abaAtual !== 'caminho' && quadro.contentWindow) quadro.contentWindow.postMessage({ fc: 'hash', v: abaAtual }, '*');
      });
    }
  });

  window.PainelOnboarding = { render, limpa };
})();
