// Página Onboarding: o mapa do onboarding dos clientes (botão Onboarding no topo do painel; ?pagina=onboarding abre direto).
// O painel.js carrega o dado (login, token, consulta ao BigQuery) e chama PainelOnboarding.render(linha):
//   linha = a linha mais recente de analytics.onboarding_map: { generated_at, version, html }. O html é o arquivo único que o build.py do mapa
//           gera (CSS e script próprios, nomes de cliente dentro): por isso ele NUNCA está neste repo, só no BigQuery.
// O html entra num <iframe srcdoc> (criado aqui) com sandbox "allow-scripts allow-popups allow-popups-to-escape-sandbox" e SEM allow-same-origin: o script do
// mapa roda (abas, filtros, abrir e recolher), mas a origem dele é opaca, então não alcança o token nem o armazenamento do painel.
//   - <base href="about:srcdoc">: num srcdoc o endereço-base é o do painel, e um link só com fragmento (#clientes) carregaria o painel inteiro
//     dentro do iframe. Com a base em about:srcdoc, #clientes e #e-<id> mudam só o hash do mapa.
//   - allow-popups-to-escape-sandbox: os links externos do Método (target=_blank) abrem em aba nova que roda normal, sem herdar o sandbox.
//   - altura: do topo do iframe até o fim da tela. A rolagem é a de dentro do iframe (as abas sticky do mapa seguem no topo) e a página não rola.
//     O painel.js tira o padding de baixo de .pagina nesta página (classe pagina-cheia), então não há folga a descontar.
(function () {
  'use strict';

  const ALTURA_MINIMA = 320;
  const SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';
  const BASE = '<base href="about:srcdoc">';

  // O iframe nasce na primeira vez que há mapa (não existe no index.html): quem não abre a página não carrega um documento isolado à toa.
  function criaQuadro() {
    let q = document.getElementById('onb-quadro');
    if (!q) {
      q = document.createElement('iframe');
      q.id = 'onb-quadro';
      q.title = 'Mapa do onboarding dos clientes';
      q.setAttribute('sandbox', SANDBOX);
      q.hidden = true;
      document.getElementById('pg-onboarding').appendChild(q);
    }
    return q;
  }

  function ajusta() {
    const quadro = document.getElementById('onb-quadro');
    if (!quadro || quadro.hidden) return;
    const topo = quadro.getBoundingClientRect().top + window.scrollY;
    // no celular a barra fixa de baixo (.barra-m) cobre o fim da tela e o body reserva esse espaço: o mapa para antes dela (uma rolagem só)
    const barra = document.querySelector('.barra-m');
    const embaixo = barra && getComputedStyle(barra).position === 'fixed' ? parseFloat(getComputedStyle(document.body).paddingBottom) || 0 : 0;
    quadro.style.height = Math.max(ALTURA_MINIMA, Math.floor(window.innerHeight - topo - embaixo)) + 'px';
  }
  window.addEventListener('resize', ajusta);

  function comBase(html) {
    return /<head[\s>]/i.test(html) ? html.replace(/<head(\s[^>]*)?>/i, (m) => m + BASE) : BASE + html;
  }

  // Sem mapa na tela: o iframe some e o html que estava nele também (mapa velho não fica à mão depois de um erro).
  function limpa() {
    const quadro = document.getElementById('onb-quadro');
    if (quadro) {
      quadro.hidden = true;
      quadro.removeAttribute('srcdoc');
      delete quadro.dataset.pronto;
    }
    document.getElementById('onb-vazio').hidden = true;
    document.getElementById('onb-sub').textContent = '';
  }

  function render(linha) {
    limpa();
    if (!linha || !linha.html) {
      document.getElementById('onb-vazio').hidden = false;
      return;
    }
    const quadro = criaQuadro();
    document.getElementById('onb-sub').textContent = 'Publicado em ' + linha.generated_at + '. O mapa não muda sozinho: só quando o Felipe publica de novo.';
    quadro.hidden = false;
    ajusta();
    quadro.addEventListener('load', function pronto() {
      quadro.removeEventListener('load', pronto);
      quadro.dataset.pronto = 'sim';
    });
    quadro.srcdoc = comBase(window.FcTema ? FcTema.injeta(linha.html) : linha.html); // o mapa segue o tema escolhido no topo
    ultima = linha;
  }

  // trocou o tema no topo: redesenha o mapa com o tema novo
  let ultima = null;
  document.addEventListener('fc-tema', () => { if (ultima && document.getElementById('onb-quadro')?.srcdoc) render(ultima); });

  window.PainelOnboarding = { render, limpa, ajusta };
})();
