// Interface do app. A lógica de cálculo e importação fica nos outros módulos.
import { lerTudo, gravar, gravarMeta, substituirTudo } from './db.js';
import { parseOfx, normalizar } from './inter-ofx.js';
import { parseFaturaCsv } from './inter-fatura.js';
import {
  A_CLASSIFICAR, CATEGORIAS_GASTO, OUTRAS_ENTRADAS, PRESENTES, REPASSE, SALARIO, VIAGEM,
  categorizar, categorizarTransacao, compilarRegras, ehCredito, regraDeCorrecao,
} from './categorias.js';
import {
  CONFIG_PADRAO, calcularEnvelope, compararMeses, dinheiroLivre, historicoFechamentos, registrarFechamentos, relatorioItens, resumoMes, totalFixos,
} from './envelope.js';
import { desfazerVinculo, planejarImportacao, retirarDasRevisoes, vincular, vincularSoma } from './importador.js';
import { diasAntes, isoLocal, maisRecentePrimeiro, mesAnterior, mesSeguinte, parseLancamento, parseValor } from './lancamento.js';
import { ITENS_PADRAO, montarBackup, precisaLembrete, validarBackup } from './backup.js';

const S = { transacoes: [], regras: [], itens: [], meta: {}, mes: null, grupo: null };
const CATEGORIAS_ENTRADA = [SALARIO, OUTRAS_ENTRADAS, REPASSE];
const ABAS = [['hoje', 'Hoje'], ['lancar', 'Lançar'], ['extrato', 'Extrato'], ['resumo', 'Resumo'], ['ajustes', 'Ajustes']];
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

const $ = (id) => document.getElementById(id);
const hoje = () => isoLocal(new Date());
const ajustes = () => ({ ...CONFIG_PADRAO, ...S.meta.ajustes });
const brl = (c) => ((c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataCurta = (iso) => `${iso.slice(8)}/${iso.slice(5, 7)}`;
const nomeMes = (mes) => `${MESES[Number(mes.slice(5)) - 1]} ${mes.slice(0, 4)}`;
const paraCampo = (c) => (c / 100).toFixed(2).replace('.', ',');
const aClassificar = () => S.transacoes.filter((t) => t.categoria === A_CLASSIFICAR);
const emRevisao = () => S.transacoes.filter((t) => t.revisao || t.revisaoSoma).sort(maisRecentePrimeiro);
const ehEntrada = (t) => ehCredito(t);
const modoInstalado = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

function el(tag, props = {}, ...filhos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else if (v !== undefined && v !== false) n[k] = v;
  }
  n.append(...filhos.flat().filter((f) => f !== null && f !== undefined && f !== false));
  return n;
}

function fecharSheet() {
  $('sheet').replaceChildren();
}

function abrirSheet(...filhos) {
  const folha = el('div', { class: 'folha' }, ...filhos);
  const veu = el('div', { class: 'veu', onclick: (e) => { if (e.target === veu) fecharSheet(); } }, folha);
  $('sheet').replaceChildren(veu);
}

let timerToast;
function toast(texto, acoes = []) {
  clearTimeout(timerToast);
  const botoes = acoes.map(([nome, fn]) => el('button', { onclick: () => { $('toast').replaceChildren(); fn(); } }, nome));
  $('toast').replaceChildren(el('span', {}, texto), el('span', {}, botoes));
  timerToast = setTimeout(() => $('toast').replaceChildren(), acoes.length ? 6000 : 3000);
}

function pedirValor(titulo, inicial) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', inputMode: 'decimal', value: inicial ? paraCampo(inicial) : '', placeholder: '0,00' });
    const confirmar = () => {
      const v = parseValor(input.value);
      if (!v) return toast('Valor inválido');
      fecharSheet();
      return resolve(v);
    };
    abrirSheet(
      el('h2', {}, titulo),
      el('div', { class: 'linha-lanc' }, input, el('button', { class: 'botao', onclick: confirmar }, 'OK')),
      el('button', { class: 'botao sec bloco', onclick: () => { fecharSheet(); resolve(null); } }, 'Cancelar'),
    );
    input.focus();
  });
}

async function recarregar() {
  const dados = await lerTudo();
  Object.assign(S, dados);
  render();
}

// ---- Ações ----

async function adicionarManual({ centavos, descricao, data, item, grupo, categoria }) {
  const base = { contraparte: descricao, memo: '' };
  const manual = {
    id: `manual-${crypto.randomUUID()}`,
    tipo: 'manual',
    data,
    criadoEm: new Date().toISOString(),
    centavos,
    ...base,
    cidade: '',
    categoria: categoria || categorizar(base, compilarRegras(S.regras)).categoria,
    ...(item ? { item, grupo } : {}),
  };
  await gravar({ put: { transacoes: [manual] } });
  await recarregar();
  return manual;
}

async function desfazerManual(id) {
  await gravar({ put: { transacoes: retirarDasRevisoes(S.transacoes, [id]) }, del: { transacoes: [id] } });
  await recarregar();
  toast('Lançamento removido');
}

async function lancarLinha(texto) {
  const r = parseLancamento(texto);
  if (!r) return toast('Escreva o valor e o que foi. Ex.: 35 almoço');
  const m = await adicionarManual({ centavos: r.centavos, descricao: r.descricao, data: diasAntes(hoje(), r.diasAtras) });
  return toast(`${brl(-r.centavos)} · ${r.descricao}`, [['Desfazer', () => desfazerManual(m.id)]]);
}

async function editarPrecoLancado(item, manual) {
  const v = await pedirValor(`Preço de ${item.nome}`, -manual.centavos);
  if (!v) return;
  await gravar({ put: { transacoes: [{ ...manual, centavos: -v }], itens: [{ ...item, ultimoPreco: v }] } });
  await recarregar();
  toast(`${item.nome}: ${brl(v)}`);
}

async function lancarItem(item) {
  const preco = item.ultimoPreco || await pedirValor(`Preço de ${item.nome}`);
  if (!preco) return;
  const atualizado = { ...item, ultimoPreco: preco };
  await gravar({ put: { itens: [atualizado] } });
  const m = await adicionarManual({
    centavos: -preco, descricao: item.nome, data: hoje(), item: item.nome, grupo: item.grupo, categoria: item.categoria,
  });
  toast(`${item.nome} · ${brl(preco)}`, [['Editar', () => editarPrecoLancado(atualizado, m)], ['Desfazer', () => desfazerManual(m.id)]]);
}

async function corrigirCategoria(t, categoria) {
  const atualizada = [{ ...t, categoria, fixada: true }];
  const put = { transacoes: atualizada };
  if (!ehEntrada(t) && normalizar(t.contraparte)) {
    const regra = regraDeCorrecao(t, categoria);
    put.regras = [regra];
    const nome = normalizar(t.contraparte);
    for (const o of S.transacoes) {
      if (o.id !== t.id && !o.fixada && !ehEntrada(o) && o.tipo !== 'pagamento_fatura' && normalizar(o.contraparte) === nome) {
        atualizada.push({ ...o, categoria });
      }
    }
  }
  await gravar({ put });
  await recarregar();
  const extras = atualizada.length - 1;
  toast(extras ? `${categoria}: regra criada e ${extras} iguais atualizadas` : `${categoria}: regra criada`);
}

async function importarArquivo(arquivo) {
  try {
    const buffer = await arquivo.arrayBuffer();
    const latin = new TextDecoder('windows-1252').decode(buffer);
    let novas;
    let foraDaConta = 0;
    if (/<OFX>/i.test(latin)) {
      novas = parseOfx(latin);
    } else {
      const fatura = parseFaturaCsv(new TextDecoder('utf-8').decode(buffer).replace(/^﻿/, ''));
      novas = fatura.transacoes;
      foraDaConta = fatura.ignoradas;
    }
    if (!novas.length) throw new Error('Nenhuma transação encontrada neste arquivo.');

    const plano = planejarImportacao({
      novas, existentes: S.transacoes, regras: compilarRegras(S.regras), salario: ajustes().salario,
    });
    const mapa = new Map(plano.adicionar.map((t) => [t.id, t]));
    const del = [];
    for (const { banco, manual } of plano.vinculos) {
      mapa.set(banco.id, vincular(banco, manual));
      del.push(manual.id);
    }
    for (const { banco, candidatos } of plano.revisoes) mapa.set(banco.id, { ...banco, revisao: candidatos.map((c) => c.id) });
    for (const { banco, itens } of plano.revisoesSoma) mapa.set(banco.id, { ...banco, revisaoSoma: itens.map((m) => m.id) });
    const maior = novas.map((t) => t.data).sort().at(-1);
    await gravar({
      put: { transacoes: [...mapa.values()], meta: [{ chave: 'ultimoExtrato', valor: maior }] },
      del: { transacoes: del },
    });
    await recarregar();
    const partes = [`${plano.adicionar.length} novas`, `${plano.ignoradas} já existiam`];
    if (foraDaConta) partes.push(`${foraDaConta} pagamentos de fatura ignorados`);
    if (plano.vinculos.length) partes.push(`${plano.vinculos.length} ligadas a lançamentos manuais`);
    const paraRevisar = plano.revisoes.length + plano.revisoesSoma.length;
    if (paraRevisar) partes.push(`${paraRevisar} para revisar`);
    abrirSheet(
      el('h2', {}, 'Importação concluída'),
      el('p', {}, partes.join(' · ')),
      el('button', { class: 'botao bloco', onclick: fecharSheet }, 'OK'),
    );
  } catch (erro) {
    abrirSheet(
      el('h2', {}, 'Não consegui importar'),
      el('p', {}, erro.message),
      el('button', { class: 'botao bloco', onclick: fecharSheet }, 'OK'),
    );
  }
}

function escolherArquivo(aoEscolher) {
  // No iOS o campo precisa estar na página para o evento de escolha disparar.
  const input = el('input', {
    type: 'file',
    hidden: true,
    onchange: () => {
      const arquivo = input.files[0];
      input.remove();
      if (arquivo) aoEscolher(arquivo);
    },
  });
  document.body.append(input);
  input.click();
}

async function exportarBackup() {
  const agora = new Date().toISOString();
  const dados = montarBackup({ transacoes: S.transacoes, regras: S.regras, itens: S.itens, ajustes: ajustes() }, agora);
  const nome = `gastos-backup-${hoje()}.json`;
  const arquivo = new File([JSON.stringify(dados)], nome, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [arquivo] })) {
      await navigator.share({ files: [arquivo], title: nome });
    } else {
      const url = URL.createObjectURL(arquivo);
      el('a', { href: url, download: nome }).click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
  } catch (erro) {
    if (erro.name === 'AbortError') return;
    toast('Não consegui gerar o backup');
    return;
  }
  await gravarMeta('ultimoBackup', agora);
  await recarregar();
  toast('Backup gerado');
}

async function importarBackup(arquivo) {
  try {
    const dados = validarBackup(JSON.parse(await arquivo.text()));
    const resumo = `${dados.transacoes.length} transações de ${dados.exportadoEm.slice(0, 10)}`;
    if (!confirm(`Substituir todos os dados deste aparelho por este backup (${resumo})?`)) return;
    await substituirTudo(dados, new Date().toISOString());
    await recarregar();
    await atualizarFechamentos();
    await recarregar();
    toast('Backup restaurado');
  } catch (erro) {
    toast(erro instanceof SyntaxError ? 'Arquivo inválido' : erro.message);
  }
}

async function salvarAjustes(mudancas) {
  await gravarMeta('ajustes', { ...ajustes(), ...mudancas });
  await recarregar();
}

async function resolverRevisao(t, manualId) {
  const manual = S.transacoes.find((x) => x.id === manualId);
  const outras = retirarDasRevisoes(S.transacoes.filter((x) => x.id !== t.id), [manualId]);
  await gravar({ put: { transacoes: [vincular(t, manual), ...outras] }, del: { transacoes: [manualId] } });
  await recarregar();
  toast('Lançamento ligado ao extrato');
}

async function resolverSoma(t) {
  const itens = t.revisaoSoma.map((id) => S.transacoes.find((x) => x.id === id));
  const outras = retirarDasRevisoes(S.transacoes.filter((x) => x.id !== t.id), t.revisaoSoma);
  await gravar({ put: { transacoes: [vincularSoma(t, itens), ...outras] }, del: { transacoes: t.revisaoSoma } });
  await recarregar();
  toast('Itens ligados ao extrato');
}

async function marcarDiferentes(t) {
  await gravar({ put: { transacoes: [{ ...t, revisao: undefined, revisaoSoma: undefined, semVinculo: true }] } });
  await recarregar();
}

async function marcarReserva(mes) {
  const cfg = ajustes();
  await salvarAjustes({ fechamentos: { ...cfg.fechamentos, [mes]: { ...cfg.fechamentos[mes], reserva: true } } });
}

async function atualizarFechamentos() {
  const fechamentos = registrarFechamentos(ajustes(), S.transacoes, hoje());
  if (fechamentos) await gravarMeta('ajustes', { ...ajustes(), fechamentos });
}

async function separarManual(t) {
  const original = categorizarTransacao(t, compilarRegras(S.regras), ajustes().salario).categoria;
  const { banco, manuais } = desfazerVinculo(t, original);
  await gravar({ put: { transacoes: [banco, ...manuais] } });
  fecharSheet();
  await recarregar();
}

// ---- Telas ----

function chipsCategorias(t, aoEscolher) {
  const lista = ehEntrada(t) ? CATEGORIAS_ENTRADA : CATEGORIAS_GASTO;
  return el('div', { class: 'chips' }, lista.map((c) => el('button', {
    class: `chip${c === t.categoria ? ' ativo' : ''}`,
    onclick: () => aoEscolher(c),
  }, c)));
}

function linhaTransacao(t) {
  const positivo = t.centavos > 0;
  const nota = t.detalhe ? ` · ${t.detalhe.descricao}` : '';
  return el('button', { class: 'tx', onclick: () => abrirTransacao(t) },
    el('span', {},
      el('div', { class: 'nome' }, t.contraparte),
      el('div', { class: 'suave' }, `${dataCurta(t.data)} · ${t.categoria}${nota}`)),
    el('span', { class: `valor${positivo ? ' positivo' : ''}` }, `${positivo ? '+' : ''}${brl(t.centavos).replace('-', '−')}`));
}

function abrirTransacao(t) {
  const acoes = [];
  if (t.detalhe) acoes.push(el('button', { class: 'botao sec bloco', onclick: () => separarManual(t) }, 'Separar do lançamento manual'));
  if (t.tipo === 'manual') {
    acoes.push(el('button', {
      class: 'botao sec bloco falta',
      onclick: async () => { fecharSheet(); await desfazerManual(t.id); },
    }, 'Apagar lançamento'));
  }
  abrirSheet(
    el('h2', {}, t.contraparte),
    el('p', { class: 'suave' }, `${dataCurta(t.data)} · ${brl(t.centavos).replace('-', '−')}${t.cidade ? ` · ${t.cidade}` : ''}`),
    t.detalhe ? el('p', {}, `Detalhe: ${t.detalhe.descricao}`) : null,
    t.tipo === 'pagamento_fatura'
      ? el('p', { class: 'suave' }, 'Pagamento de fatura não conta como gasto.')
      : [el('p', { class: 'suave' }, ehEntrada(t) ? 'Categoria:' : 'Categoria (vira regra para este nome):'),
        chipsCategorias(t, async (c) => { fecharSheet(); await corrigirCategoria(t, c); })],
    acoes,
    el('button', { class: 'botao sec bloco', onclick: fecharSheet }, 'Fechar'),
  );
}

function linhaRapida() {
  const input = el('input', { type: 'text', placeholder: '35 almoço', enterKeyHint: 'done', autocomplete: 'off' });
  return el('form', {
    class: 'linha-lanc',
    onsubmit: async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      await lancarLinha(input.value);
    },
  }, input, el('button', { class: 'botao' }, 'Lançar'));
}

function avisos() {
  const lista = [];
  if (/iPhone|iPad/.test(navigator.userAgent) && !modoInstalado()) {
    lista.push(el('div', { class: 'aviso' }, 'Você está no Safari. Os dados daqui são separados do app instalado na tela inicial.'));
  }
  if (precisaLembrete(S.meta.ultimoBackup, new Date().toISOString(), S.transacoes.length > 0)) {
    lista.push(el('button', { class: 'aviso', onclick: exportarBackup }, 'Faz mais de 30 dias sem backup. Toque para fazer agora.'));
  }
  const sobra = historicoFechamentos(ajustes(), S.transacoes).find((f) => f.resultado > 0 && !f.reserva);
  if (sobra) {
    lista.push(el('div', { class: 'aviso' },
      `${nomeMes(sobra.mes)}: sobrou ${brl(sobra.resultado)} → mandar para a reserva `,
      el('button', { class: 'chip', onclick: () => marcarReserva(sobra.mes) }, 'Feito')));
  }
  if (emRevisao().length) lista.push(el('a', { class: 'aviso', href: '#revisar' }, `${emRevisao().length} para revisar: extrato parecido com lançamento manual`));
  if (aClassificar().length) lista.push(el('a', { class: 'aviso', href: '#classificar' }, `${aClassificar().length} transações a classificar`));
  return lista;
}

function telaHoje() {
  const cfg = ajustes();
  if (!cfg.salario) {
    return [
      el('h1', {}, 'Vamos começar'),
      el('div', { class: 'cartao' },
        el('p', {}, 'Informe salário, fixos e investimento, ou restaure um backup.'),
        el('a', { class: 'botao bloco', href: '#ajustes', style: 'text-align:center;text-decoration:none' }, 'Abrir Ajustes')),
    ];
  }
  const e = calcularEnvelope(cfg, S.transacoes, hoje());
  const negativo = e.podeHoje < 0;
  return [
    el('div', { class: 'cartao destaque' },
      el('div', { class: 'rotulo' }, negativo ? 'Hoje você passou do limite em' : 'Hoje você pode gastar'),
      el('div', { class: `valor ${negativo ? 'falta' : 'positivo'}` }, brl(Math.abs(e.podeHoje))),
      el('div', { class: 'suave' }, `${brl(e.porDia)} por dia · ${e.saldoAnterior >= 0 ? 'sobra' : 'falta'} de ontem ${brl(Math.abs(e.saldoAnterior))}`),
      el('div', { class: 'suave' }, `Gasto hoje ${brl(e.gastoHoje)} · no mês ${brl(e.gastoMes)} de ${brl(e.livre)}`),
      S.meta.ultimoExtrato ? el('div', { class: 'suave' }, `Extrato importado até ${dataCurta(S.meta.ultimoExtrato)}`) : null),
    linhaRapida(),
    avisos(),
    el('button', { class: 'botao sec bloco', onclick: () => escolherArquivo(importarArquivo) }, 'Importar extrato ou fatura'),
  ];
}

function novoItem() {
  const grupo = el('input', { type: 'text', placeholder: 'Grupo (ex.: Bebidas)', value: S.grupo || '' });
  const nome = el('input', { type: 'text', placeholder: 'Item (ex.: Água c/ gás)' });
  const preco = el('input', { type: 'text', inputMode: 'decimal', placeholder: 'Preço (opcional)' });
  let categoria = 'Comida e delivery';
  const chips = el('div', { class: 'chips' });
  const desenhar = () => chips.replaceChildren(...CATEGORIAS_GASTO.map((c) => el('button', {
    class: `chip${c === categoria ? ' ativo' : ''}`,
    onclick: () => { categoria = c; desenhar(); },
  }, c)));
  desenhar();
  abrirSheet(
    el('h2', {}, 'Novo item favorito'),
    el('div', { class: 'linha-lanc' }, grupo),
    el('div', { class: 'linha-lanc' }, nome),
    el('div', { class: 'linha-lanc' }, preco),
    el('p', { class: 'suave' }, 'Categoria do gasto:'),
    chips,
    el('button', {
      class: 'botao bloco',
      onclick: async () => {
        if (!grupo.value.trim() || !nome.value.trim()) return toast('Preencha grupo e item');
        const item = {
          id: crypto.randomUUID(), grupo: grupo.value.trim(), nome: nome.value.trim(), categoria, ultimoPreco: parseValor(preco.value),
        };
        S.grupo = item.grupo;
        await gravar({ put: { itens: [item] } });
        fecharSheet();
        return recarregar();
      },
    }, 'Salvar'),
    el('button', { class: 'botao sec bloco', onclick: fecharSheet }, 'Cancelar'),
  );
}

function telaLancar() {
  const grupos = [...new Set(S.itens.map((i) => i.grupo))];
  const doGrupo = S.itens.filter((i) => i.grupo === S.grupo);
  return [
    el('h1', {}, 'Lançar'),
    linhaRapida(),
    el('h2', {}, 'Favoritos'),
    el('div', { class: 'chips' },
      grupos.map((g) => el('button', {
        class: `chip${g === S.grupo ? ' ativo' : ''}`,
        onclick: () => { S.grupo = g; render(); },
      }, g)),
      el('button', { class: 'chip', onclick: novoItem }, '+ Novo item')),
    el('div', { class: 'grade' }, doGrupo.map((i) => el('button', { class: 'item', onclick: () => lancarItem(i) },
      i.nome, el('small', {}, i.ultimoPreco ? brl(i.ultimoPreco) : 'sem preço')))),
  ];
}

function navMes() {
  const atual = S.mes || hoje().slice(0, 7);
  const proximo = mesSeguinte(atual);
  return el('div', { class: 'mes-nav' },
    el('button', { 'aria-label': 'Mês anterior', onclick: () => { S.mes = mesAnterior(atual); render(); } }, '‹'),
    el('strong', {}, nomeMes(atual)),
    el('button', { 'aria-label': 'Próximo mês', onclick: () => { S.mes = proximo; render(); } }, '›'));
}

function telaExtrato() {
  const mes = S.mes || hoje().slice(0, 7);
  const lista = S.transacoes.filter((t) => t.data.slice(0, 7) === mes).sort(maisRecentePrimeiro);
  return [
    el('h1', {}, 'Extrato'),
    el('div', { class: 'chips' },
      el('a', { class: 'chip', href: '#classificar', style: 'color:inherit;text-decoration:none' }, `A classificar (${aClassificar().length})`),
      el('a', { class: 'chip', href: '#revisar', style: 'color:inherit;text-decoration:none' }, `Revisar (${emRevisao().length})`)),
    navMes(),
    lista.length
      ? el('div', {}, lista.map(linhaTransacao))
      : el('p', { class: 'suave' }, 'Nada neste mês.'),
  ];
}

function telaClassificar() {
  const grupos = new Map();
  for (const t of aClassificar()) {
    const k = normalizar(t.contraparte);
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(t);
  }
  const ordenados = [...grupos.values()].map((l) => l.sort(maisRecentePrimeiro)).sort((a, b) => maisRecentePrimeiro(a[0], b[0]));
  return [
    el('h1', {}, 'A classificar'),
    el('p', { class: 'suave' }, 'Um toque categoriza e cria a regra para esse nome.'),
    ordenados.length ? ordenados.map((lista) => el('div', { class: 'cartao' },
      el('strong', {}, lista[0].contraparte),
      el('div', { class: 'suave' }, `${lista.length}× · ${brl(-lista.reduce((s, t) => s + t.centavos, 0))} · último em ${dataCurta(lista[0].data)}`),
      chipsCategorias(lista[0], (c) => corrigirCategoria(lista[0], c)))) : el('p', {}, 'Tudo classificado.'),
  ];
}

function cartaoRevisao(t) {
  const cabecalho = [el('strong', {}, t.contraparte), el('div', { class: 'suave' }, `Extrato · ${dataCurta(t.data)} · ${brl(-t.centavos)}`)];
  const diferentes = el('button', { class: 'botao sec bloco', onclick: () => marcarDiferentes(t) }, 'Nenhum, são gastos diferentes');
  if (t.revisaoSoma) {
    const itens = t.revisaoSoma.map((id) => S.transacoes.find((x) => x.id === id)).filter(Boolean).sort(maisRecentePrimeiro);
    return el('div', { class: 'cartao' }, cabecalho,
      el('p', {}, 'Estes itens do dia somam esse valor. Foram este pagamento?'),
      itens.map((m) => el('div', { class: 'barra-topo barra-linha' }, el('span', {}, m.contraparte), el('strong', {}, brl(-m.centavos)))),
      el('button', { class: 'botao bloco', style: 'margin-top:10px', onclick: () => resolverSoma(t) }, 'Sim, foram este pagamento'),
      diferentes);
  }
  return el('div', { class: 'cartao' }, cabecalho,
    el('p', {}, 'Corresponde a qual lançamento manual?'),
    t.revisao.map((id) => S.transacoes.find((x) => x.id === id)).filter(Boolean).sort(maisRecentePrimeiro).map((m) => el('button', {
      class: 'botao sec bloco',
      onclick: () => resolverRevisao(t, m.id),
    }, `${m.contraparte} (${dataCurta(m.data)})`)),
    diferentes);
}

function telaRevisar() {
  return [
    el('h1', {}, 'Revisar'),
    el('p', { class: 'suave' }, 'Até decidir, os dois lançamentos contam como gasto.'),
    emRevisao().length ? emRevisao().map(cartaoRevisao) : el('p', {}, 'Nada para revisar.'),
  ];
}

function textoFechamento(f) {
  return f.resultado >= 0 ? `sobrou ${brl(f.resultado)} → mandar para a reserva` : `faltou ${brl(-f.resultado)}`;
}

function textoVariacao(atual, anterior) {
  if (!anterior) return 'sem mês anterior';
  const dif = atual - anterior;
  return `${dif > 0 ? '+' : '−'}${brl(Math.abs(dif))} (${dif > 0 ? '+' : '−'}${Math.abs(Math.round((dif / anterior) * 100))}%) vs. mês anterior`;
}

function telaResumo() {
  const cfg = ajustes();
  const mes = S.mes || hoje().slice(0, 7);
  const atual = resumoMes(S.transacoes, mes, cfg);
  const anterior = resumoMes(S.transacoes, mesAnterior(mes), cfg);
  const linhas = compararMeses(atual, anterior);
  const maior = Math.max(...linhas.map((l) => l.atual), 1);
  const itens = relatorioItens(S.transacoes, mes);
  const historico = historicoFechamentos(cfg, S.transacoes);
  const fechamento = historico.find((f) => f.mes === mes);
  return [
    el('h1', {}, 'Resumo'),
    navMes(),
    el('div', { class: 'cartao' },
      el('div', { class: 'suave' }, 'Total gasto'),
      el('div', { style: 'font-size:28px;font-weight:700' }, brl(atual.total)),
      el('div', { class: 'suave' }, textoVariacao(atual.total, anterior.total)),
      el('p', { style: 'margin-top:10px' }, `Dia a dia (sem fixos, viagem e presentes): ${brl(atual.diaADia)}`),
      el('p', {}, `Viagem${cfg.foraDoEnvelope.includes(VIAGEM) ? ' (fora do envelope)' : ''}: ${brl(atual.viagem)}`),
      el('p', {}, `Aportes: ${brl(atual.aporte)} de ${brl(cfg.investimento)}`)),
    fechamento ? el('div', { class: `cartao ${fechamento.resultado < 0 ? 'falta' : 'positivo'}` }, `Fechamento: ${textoFechamento(fechamento)}`) : null,
    el('h2', {}, 'Por categoria'),
    linhas.length ? linhas.map((l) => el('div', { class: 'barra-linha' },
      el('div', { class: 'barra-topo' }, el('span', {}, l.categoria), el('strong', {}, brl(l.atual))),
      el('div', { class: 'suave' }, `mês anterior ${brl(l.anterior)}`),
      el('div', { class: 'barra' }, el('div', { style: `width:${Math.max(0, (l.atual / maior) * 100)}%` })))) : el('p', { class: 'suave' }, 'Sem gastos neste mês.'),
    el('h2', {}, 'Por item'),
    itens.length ? itens.map((i) => el('div', { class: 'barra-topo barra-linha' },
      el('span', {}, `${i.quantidade}× ${i.item}`), el('strong', {}, brl(i.total)))) : el('p', { class: 'suave' }, 'Nenhum item lançado neste mês.'),
    el('h2', {}, 'Histórico do envelope'),
    historico.length ? historico.map((f) => el('div', { class: 'barra-topo barra-linha' },
      el('span', {}, nomeMes(f.mes)),
      el('span', { class: f.resultado < 0 ? 'falta' : 'positivo' }, f.resultado < 0 ? `faltou ${brl(-f.resultado)}` : `sobrou ${brl(f.resultado)}`))) : el('p', { class: 'suave' }, 'Nenhum mês fechado ainda.'),
  ];
}

function campoDinheiro(rotulo, valor, salvar) {
  const input = el('input', {
    type: 'text',
    inputMode: 'decimal',
    value: paraCampo(valor),
    onchange: async () => {
      const v = input.value.trim() === '0' ? 0 : parseValor(input.value);
      if (v === null) return toast('Valor inválido');
      await salvar(v);
      return toast('Salvo');
    },
  });
  return el('div', { class: 'campo' }, el('label', {}, rotulo), input);
}

function adicionarFixo() {
  const nome = el('input', { type: 'text', placeholder: 'Nome como aparece no extrato' });
  const valor = el('input', { type: 'text', inputMode: 'decimal', placeholder: 'Valor mensal' });
  abrirSheet(
    el('h2', {}, 'Novo gasto fixo'),
    el('div', { class: 'linha-lanc' }, nome),
    el('div', { class: 'linha-lanc' }, valor),
    el('button', {
      class: 'botao bloco',
      onclick: async () => {
        const c = parseValor(valor.value);
        if (!nome.value.trim() || !c) return toast('Preencha nome e valor');
        const fixos = [...ajustes().fixos, {
          nome: nome.value.trim(), padrao: normalizar(nome.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), centavos: c,
        }];
        fecharSheet();
        return salvarAjustes({ fixos });
      },
    }, 'Salvar'),
    el('button', { class: 'botao sec bloco', onclick: fecharSheet }, 'Cancelar'),
  );
}

function telaAjustes() {
  const cfg = ajustes();
  const fora = (categoria) => el('label', { class: 'check' },
    el('input', {
      type: 'checkbox',
      checked: cfg.foraDoEnvelope.includes(categoria),
      onchange: (e) => salvarAjustes({
        foraDoEnvelope: e.target.checked ? [...cfg.foraDoEnvelope, categoria] : cfg.foraDoEnvelope.filter((c) => c !== categoria),
      }),
    }),
    `${categoria} fora do envelope`);
  return [
    el('h1', {}, 'Ajustes'),
    el('div', { class: 'cartao' },
      campoDinheiro('Salário', cfg.salario, (v) => salvarAjustes({ salario: v })),
      campoDinheiro('Investimento mensal', cfg.investimento, (v) => salvarAjustes({ investimento: v })),
      el('p', { class: 'suave' }, `Fixos ${brl(totalFixos(cfg))} · livre ${brl(dinheiroLivre(cfg))} por mês`),
      fora(VIAGEM),
      fora(PRESENTES)),
    el('h2', {}, 'Gastos fixos'),
    el('div', { class: 'cartao' },
      cfg.fixos.map((f, i) => el('div', { class: 'lista-acao' },
        el('span', {}, `${f.nome} · ${brl(f.centavos)}`),
        el('button', { 'aria-label': `Remover ${f.nome}`, onclick: () => salvarAjustes({ fixos: cfg.fixos.filter((_, j) => j !== i) }) }, 'Remover'))),
      el('button', { class: 'chip', style: 'margin-top:10px', onclick: adicionarFixo }, '+ Adicionar fixo')),
    el('h2', {}, 'Dados'),
    el('button', { class: 'botao bloco', onclick: () => escolherArquivo(importarArquivo) }, 'Importar extrato (.ofx) ou fatura (.csv)'),
    el('button', { class: 'botao sec bloco', onclick: exportarBackup }, 'Exportar backup'),
    el('button', { class: 'botao sec bloco', onclick: () => escolherArquivo(importarBackup) }, 'Restaurar backup'),
    el('p', { class: 'suave' }, S.meta.ultimoBackup ? `Último backup: ${S.meta.ultimoBackup.slice(0, 10)}` : 'Nenhum backup feito ainda.'),
    el('h2', {}, `Regras criadas (${S.regras.length})`),
    el('div', { class: 'cartao' }, S.regras.length ? S.regras.map((r) => el('div', { class: 'lista-acao' },
      el('span', {}, `${r.padrao} → ${r.categoria}`),
      el('button', {
        onclick: async () => { await gravar({ del: { regras: [r.padrao] } }); await recarregar(); },
      }, 'Remover'))) : el('p', { class: 'suave' }, 'Nenhuma ainda.')),
    el('h2', {}, 'Diagnóstico'),
    el('div', { class: 'cartao suave', id: 'diagnostico' },
      el('p', {}, `Modo: ${modoInstalado() ? 'app instalado' : 'navegador'}`),
      el('p', {}, `Transações neste aparelho: ${S.transacoes.length}`),
      el('p', {}, `Identificador destes dados: ${S.meta.dispositivo || '-'}`),
      el('p', {}, `Rota atual: ${location.hash || '(início)'}`)),
  ];
}

const TELAS = {
  hoje: telaHoje, lancar: telaLancar, extrato: telaExtrato, classificar: telaClassificar, revisar: telaRevisar, resumo: telaResumo, ajustes: telaAjustes,
};

function render() {
  const rota = location.hash.slice(1);
  const nome = TELAS[rota] ? rota : 'hoje';
  $('tela').replaceChildren(...TELAS[nome]().flat().filter(Boolean));
  const pendentes = aClassificar().length + emRevisao().length;
  $('abas').replaceChildren(...ABAS.map(([id, rotulo]) => el('a', {
    href: `#${id}`,
    class: id === nome || (id === 'extrato' && ['classificar', 'revisar'].includes(nome)) ? 'ativa' : '',
  }, rotulo, id === 'extrato' && pendentes ? el('span', { class: 'bolha' }, String(pendentes)) : null)));
}

async function iniciar() {
  await recarregar();
  await atualizarFechamentos();
  const put = [];
  if (!S.meta.dispositivo) put.push({ chave: 'dispositivo', valor: crypto.randomUUID().slice(0, 8) });
  if (put.length || !S.itens.length) {
    await gravar({ put: { meta: put, itens: S.itens.length ? [] : ITENS_PADRAO } });
    await recarregar();
  }
  window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });
  // O app costuma ficar aberto em segundo plano: ao voltar, o dia pode ter mudado.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    await atualizarFechamentos();
    await recarregar();
  });
  navigator.storage?.persist?.();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
}

iniciar();
