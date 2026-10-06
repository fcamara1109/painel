// Página Cirurgias: quem ainda pode operar, do mais quente ao mais frio. Só leitura.
// O painel.js carrega o dado (login, token, consulta ao BigQuery, ?tenant=) e chama PainelCirurgias.render;
// aqui só se classifica e se desenha. Nada de segundo cliente do BigQuery nem de cliente fixo.
(function () {
  'use strict';

  const PARADO_DIAS = 30; // passou disso sem interação, o paciente esfria
  const FRIO_DIAS = 90; // passou disso, é caso frio

  // Link do paciente no sistema da clínica: um mapa por ERP, escrito UMA vez, aqui.
  // O ERP e o id do paciente vêm de cada linha do BigQuery (erp, erp_patient_id), gravados pelo radar do cliente.
  // ERP fora do mapa, ou linha sem id: a lista aparece sem os links.
  // Asa: rotas no legado ww1 (provado em 06/10/2026 com o login do Asa, só leitura). literal-ok: página estática pública, não importa de _shared (host canônico em _shared/adm/tools/asa_nav.py).
  const ERPS = {
    asa: {
      nome: 'Asa',
      agendamentos: (id) => `https://ww1.asasaude.app.br/instituicao/pessoas/${id}/agendamentos`,
      prontuario: (id) => `https://ww1.asasaude.app.br/instituicao/agendamentos/resumo/${id}/paciente`,
    },
  };

  function linkErp(erp, tipo, id) {
    const sistema = Object.prototype.hasOwnProperty.call(ERPS, erp) ? ERPS[erp] : null;
    if (!sistema || !/^\d+$/.test(String(id || ''))) return null;
    return sistema[tipo](String(id));
  }

  const STATUS = { indicated: 'Indicada', in_conversation: 'Em conversa', scheduled: 'Marcada', monitoring: 'Em observação', operated: 'Operou', dropped: 'Desistiu' };
  const ORIGEM = { funnel: 'Funil', clinic: 'Clínica' };
  const ACOMPANHAR = { yes: 'sim', no: 'não' };

  // Grupos da fila, do mais quente ao mais frio. Operou e desistiu saem da fila e ficam recolhidos embaixo.
  const GRUPOS = [
    ['andamento', 'Consulta marcada', 'consulta com data a partir de hoje'],
    ['quentes', 'Quentes', `última interação há até ${PARADO_DIAS} dias`],
    ['esfriando', 'Esfriando', `última interação há ${PARADO_DIAS + 1} a ${FRIO_DIAS} dias`],
    ['frios', 'Frios', `última interação há mais de ${FRIO_DIAS} dias`],
  ];

  const ICONE_FORA = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M5.5 3H3.2A1.2 1.2 0 0 0 2 4.2v6.6A1.2 1.2 0 0 0 3.2 12h6.6a1.2 1.2 0 0 0 1.2-1.2V8.5M8 2h4v4M12 2 6.5 7.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

  // dias: positivo = interação passada, zero = hoje, negativo = consulta marcada pra frente. null = sem data.
  function classifica(linhas, hoje, diasEntre) {
    const fila = [];
    const operaram = [];
    const desistiram = [];
    for (const r of linhas) {
      const dias = r.last_interaction_date ? diasEntre(r.last_interaction_date, hoje) : null;
      // consulta marcada de verdade: data pra frente, ou hoje quando o último registro é o "marcado" (interação de hoje já atendida não conta)
      const proxima = dias !== null && (dias < 0 || (dias === 0 && /marcad/i.test(r.last_interaction_kind || '')));
      const item = { ...r, dias, proxima };
      if (r.status === 'operated') operaram.push(item);
      else if (r.status === 'dropped') desistiram.push(item);
      else {
        item.grupo = proxima ? 'andamento'
          : dias === null || dias > FRIO_DIAS ? 'frios'
            : dias > PARADO_DIAS ? 'esfriando' : 'quentes';
        fila.push(item);
      }
    }
    const rankGrupo = (g) => GRUPOS.findIndex(([k]) => k === g);
    // Dentro do grupo: em observação por último; consulta marcada pela data mais próxima; o resto pela interação mais recente.
    const chaveDias = (x) => (x.dias === null ? Infinity : x.proxima ? -x.dias : x.dias);
    fila.sort((a, b) => rankGrupo(a.grupo) - rankGrupo(b.grupo)
      || (a.status === 'monitoring') - (b.status === 'monitoring')
      || (b.proxima - a.proxima)
      || chaveDias(a) - chaveDias(b)
      || a.first_name.localeCompare(b.first_name, 'pt-BR'));
    const maisRecentePrimeiro = (a, b) => (b.last_interaction_date || '').localeCompare(a.last_interaction_date || '') || a.first_name.localeCompare(b.first_name, 'pt-BR');
    operaram.sort(maisRecentePrimeiro);
    desistiram.sort(maisRecentePrimeiro);
    return { fila, operaram, desistiram };
  }

  function render(linhas, ctx) {
    const { esc, fmtData, nf0, hoje, diasEntre } = ctx;
    const $ = (id) => document.getElementById(id);
    const dm = (iso) => fmtData(iso).slice(0, 5);
    const dma = (iso) => (iso.slice(0, 4) === hoje.slice(0, 4) ? dm(iso) : fmtData(iso)); // dia e mês; com o ano quando não é o deste ano
    // d positivo = passado ("há 6 dias"), zero = hoje, negativo = futuro ("em 8 dias")
    const quando = (d) => (d === 0 ? 'hoje' : `${d > 0 ? 'há' : 'em'} ${plural(Math.abs(d), 'dia', 'dias')}`);

    const secoes = ['operaram', 'desistiram'];
    const limpa = () => {
      $('cir-resumo').innerHTML = '';
      $('cir-sub').textContent = '';
      $('cir-aviso').hidden = true;
      $('cir-sem-link').hidden = true;
      for (const s of secoes) $(`bloco-${s}`).hidden = true;
    };
    if (linhas === null) { // carregando
      limpa();
      $('cir-fila').innerHTML = `<div class="fc-cartao">${ctx.esqueleto}</div>`;
      return;
    }
    if (linhas === false) { // falhou: o painel já mostra o erro, aqui não se desenha "lista vazia"
      limpa();
      $('cir-fila').innerHTML = '';
      return;
    }

    const { fila, operaram, desistiram } = classifica(linhas, hoje, diasEntre);
    const grupos = { operaram, desistiram };

    if (!linhas.length) {
      limpa();
      $('cir-fila').innerHTML = '<div class="vazio-lista fc-cartao">Sem lista de cirurgia para este cliente.</div>';
      return;
    }

    const link = (r, tipo, rotulo) => {
      const url = linkErp(r.erp, tipo, r.erp_patient_id);
      if (!url) return '';
      const o = tipo === 'agendamentos' ? 'Histórico de agendamentos' : 'Histórico de prontuário';
      const quem = r.phone_last4 ? `${r.first_name}, telefone final ${r.phone_last4}` : r.first_name; // dois pacientes com o mesmo nome não se confundem
      return `<a class="cir-link" data-link="${tipo}" href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(`${o} de ${quem} no ${ERPS[r.erp].nome} (abre em nova aba)`)}">${rotulo}${ICONE_FORA}</a>`;
    };
    // Alguma linha com link e esta sem: a linha diz por quê. Lista inteira sem link: vale a nota única lá embaixo.
    const algumLink = linhas.some((r) => linkErp(r.erp, 'agendamentos', r.erp_patient_id));

    const item = (r) => {
      const meta = [r.phone_last4 ? `final ${esc(r.phone_last4)}` : '', ORIGEM[r.origin] ? esc(ORIGEM[r.origin]) : ''].filter(Boolean).join(' · ');
      const parado = r.dias === null ? 'sem interação registrada'
        : r.proxima ? `consulta ${quando(r.dias)}`
          : `última interação ${quando(r.dias)}`;
      const detalhe = r.last_interaction_date ? `${esc(dma(r.last_interaction_date))}${r.last_interaction_kind ? ' · ' + esc(r.last_interaction_kind) : ''}` : '';
      const indicada = r.consult_date ? `Indicação em ${esc(dma(r.consult_date))}` : '';
      const acomp = ACOMPANHAR[r.follow_up] ? `Acompanhar: ${ACOMPANHAR[r.follow_up]}` : '';
      const links = link(r, 'agendamentos', 'Agendamentos') + link(r, 'prontuario', 'Prontuário')
        || (algumLink ? `<span class="cir-sem">Sem link no ${esc(Object.prototype.hasOwnProperty.call(ERPS, r.erp) ? ERPS[r.erp].nome : 'sistema da clínica')}</span>` : '');
      return `<li class="cir-item" data-status="${esc(r.status)}"${r.proxima ? ' data-proxima="1"' : ''}>
<div class="cir-quem"><strong class="cir-nome">${esc(r.first_name)}</strong><small>${meta}</small></div>
<div class="cir-proc"><span>${esc(r.procedure || 'Procedimento a definir')}</span><small>${indicada}</small></div>
<div class="cir-quando"><span class="cir-dias">${parado}</span><small>${detalhe}</small></div>
<div class="cir-estado"><span class="cir-chip">${esc(STATUS[r.status] || r.status)}</span><small>${acomp}</small></div>
<div class="cir-links">${links}</div></li>`;
    };

    // Resumo do topo: quantos podem operar, quantos estão parados, próximas consultas.
    const parados = fila.filter((r) => r.grupo === 'esfriando' || r.grupo === 'frios').length; // os dois grupos que a tela desenha abaixo de Quentes
    const marcadas = fila.filter((r) => r.proxima);
    const proxima = marcadas.length ? marcadas.reduce((a, b) => (a.last_interaction_date <= b.last_interaction_date ? a : b)) : null;
    const fato = (n, texto, chave) => `<div class="cir-fato" data-fato="${chave}"><span class="num">${nf0.format(n)}</span><span class="cir-fato-t">${texto}</span></div>`;
    $('cir-resumo').innerHTML = fila.length
      ? fato(fila.length, `${fila.length === 1 ? 'paciente pode' : 'pacientes podem'} operar`, 'podem')
        + fato(parados, `sem interação há mais de ${PARADO_DIAS} dias, ou sem registro`, 'parados')
        + fato(marcadas.length, proxima
          ? `${marcadas.length === 1 ? 'consulta marcada' : 'consultas marcadas'}, a próxima ${esc(dma(proxima.last_interaction_date))} (${quando(proxima.dias)})`
          : 'consulta marcada', 'proximas')
      : '<p class="cir-fato-vazio">Ninguém na lista pode operar agora.</p>';

    $('cir-fila').innerHTML = GRUPOS.map(([k, titulo, regra]) => {
      const doGrupo = fila.filter((r) => r.grupo === k);
      if (!doGrupo.length) return '';
      return `<section class="cir-grupo fc-cartao" data-grupo="${k}" aria-labelledby="cg-${k}">
<h3 class="fc-h3 cir-gh" id="cg-${k}"><span class="cir-ponto" aria-hidden="true"></span><span class="cir-gt">${esc(titulo)}</span><span class="cir-gn">${nf0.format(doGrupo.length)}<span class="cir-so-leitor"> ${doGrupo.length === 1 ? 'paciente' : 'pacientes'}</span></span><span class="cir-regra">${esc(regra)}</span></h3>
<ol class="cir-itens">${doGrupo.map(item).join('')}</ol></section>`;
    }).join('') || '<div class="vazio-lista fc-cartao">Ninguém na lista pode operar agora.</div>';

    for (const s of secoes) {
      const lista = grupos[s];
      $(`bloco-${s}`).hidden = !lista.length;
      $(`corpo-${s}`).querySelector('.cir-itens').innerHTML = lista.map(item).join('');
      $(`acc-${s}`).querySelector('.hint').textContent = plural(lista.length, 'paciente', 'pacientes');
    }

    const dia = linhas[0].snapshot_date;
    const idade = diasEntre(dia, hoje);
    $('cir-sub').textContent = `Lista de ${fmtData(dia)}. Consulta marcada primeiro, depois quem falou com a clínica há menos tempo.`;
    $('cir-aviso').hidden = idade <= 15;
    $('cir-aviso').textContent = `Esta lista tem ${nf0.format(idade)} dias e pode estar desatualizada. Avise o Felipe para gerar uma nova.`;
    $('cir-sem-link').hidden = linhas.some((r) => linkErp(r.erp, 'agendamentos', r.erp_patient_id));
  }

  window.PainelCirurgias = { render, classifica, linkErp, ERPS, PARADO_DIAS, FRIO_DIAS };
})();
