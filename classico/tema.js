/* tema.js: escolhe o tema da marca (A, B, E) em qualquer página que carregue o tokens.css. Criado em 12/11/2026.
   Uso, no <head>, logo depois do tokens.css:
       <link rel="stylesheet" id="fc-tema" href="tema-a.css">
       <script src="tema.js"></script>
   e, onde houver seletor: <select data-fc-tema></select> (ou data-fc-tema="curto": só a letra).
   Um tema para tudo e sempre o último salvo (Felipe, 12/11/2026): a escolha vai para localStorage 'fc-tema'; sem escolha, vale o PADRAO.
   Trocar = trocar o href do link (tema-a.css -> tema-b.css). Quem precisa reagir (iframes) ouve o evento 'fc-tema' no document. */
(function () {
  var TEMAS = { a: 'A Prancha', b: 'B Pampulha', e: 'E Conversão' };
  var PADRAO = 'a';
  var CHAVE = 'fc-tema';

  function link() { return document.getElementById('fc-tema'); }
  function salvo() { try { var s = localStorage.getItem(CHAVE); return TEMAS[s] ? s : null; } catch (e) { return null; } }
  function atual() { return document.documentElement.getAttribute('data-tema') || PADRAO; }
  // href do tema t a partir do link da página (mantém pasta e ?v= do carimbo de versão)
  function href(t) { var l = link(); return l ? l.href.replace(/tema-[a-z]\.css/, 'tema-' + t + '.css') : ''; }

  function aplica(t) {
    var l = link();
    if (l && l.href !== href(t)) l.href = href(t);
    document.documentElement.setAttribute('data-tema', t);
  }

  function troca(t, deOutraAba) {
    if (!TEMAS[t] || t === atual()) return;
    aplica(t);
    if (!deOutraAba) try { localStorage.setItem(CHAVE, t); } catch (e) { /* sem armazenamento: vale só nesta aba */ }
    document.querySelectorAll('select[data-fc-tema]').forEach(function (s) { s.value = t; });
    document.dispatchEvent(new CustomEvent('fc-tema', { detail: t }));
  }

  // <link> do tema para pôr dentro de um iframe srcdoc (endereço absoluto: o base do iframe pode ser about:srcdoc).
  // Vai no FIM do html: depois do tokens.css e dos <style> do próprio documento, para o tema vencer.
  function tag() { return '<link rel="stylesheet" id="fc-tema" href="' + href(atual()) + '">'; }
  function injeta(html) { return /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, tag() + '</body>') : html + tag(); }

  function ligaSeletores() {
    document.querySelectorAll('select[data-fc-tema]').forEach(function (s) {
      if (s.dataset.ligado) return;
      s.dataset.ligado = 'sim';
      var curto = s.getAttribute('data-fc-tema') === 'curto'; // só a letra, para caber em barra apertada
      s.innerHTML = Object.keys(TEMAS).map(function (k) { return '<option value="' + k + '" title="' + TEMAS[k] + '">' + (curto ? k.toUpperCase() : TEMAS[k]) + '</option>'; }).join('');
      s.value = atual();
      s.addEventListener('change', function () { troca(s.value); });
    });
  }

  aplica(salvo() || PADRAO);
  // outra aba salvou outro tema: esta segue (um tema para tudo, sempre o último salvo)
  window.addEventListener('storage', function (ev) { if (ev.key === CHAVE) troca(salvo() || PADRAO, true); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ligaSeletores);
  else ligaSeletores();

  window.FcTema = { TEMAS: TEMAS, PADRAO: PADRAO, atual: atual, troca: troca, href: href, tag: tag, injeta: injeta };
})();
