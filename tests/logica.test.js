import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOfx } from '../src/inter-ofx.js';
import { parseFaturaCsv } from '../src/inter-fatura.js';
import { maisRecentePrimeiro, parseLancamento, parseValor } from '../src/lancamento.js';
import { compilarRegras, categorizar, regraDeCorrecao, A_CLASSIFICAR } from '../src/categorias.js';
import {
  calcularEnvelope, contaNoEnvelope, dinheiroLivre, ehFixo, historicoFechamentos, registrarFechamentos, relatorioItens, resumoMes,
} from '../src/envelope.js';
import { desfazerVinculo, idsDeImportacao, planejarImportacao, retirarDasRevisoes, vincular, vincularSoma } from '../src/importador.js';
import { montarBackup, precisaLembrete, validarBackup } from '../src/backup.js';

const config = {
  salario: 600000,
  investimento: 100000,
  foraDoEnvelope: [],
  fechamentos: {},
  inicioHistorico: null,
  fixos: [
    { nome: 'A', padrao: 'terapeuta', centavos: 80000 },
    { nome: 'B', padrao: 'imposto', centavos: 9005 },
    { nome: 'C', padrao: 'fornecedor', centavos: 30000 },
  ],
};
const gasto = (data, centavos, extra = {}) => ({
  data, centavos: -centavos, tipo: 'debito', contraparte: 'Loja', memo: '', categoria: 'Mercado', ...extra,
});
const ofx = (itens) => itens.map(([dt, v, memo, nome, fitid = '1']) => `<STMTTRN>
<TRNTYPE>PAYMENT</TRNTYPE>
<DTPOSTED>${dt}</DTPOSTED>
<TRNAMT>${v}</TRNAMT>
<FITID>${fitid}</FITID>
<MEMO>${memo}</MEMO>
<NAME>${nome}</NAME>
</STMTTRN>`).join('\n');

test('OFX: separa estabelecimento e cidade das colunas fixas', () => {
  const [t] = parseOfx(ofx([['20261108', '-80.80', 'Compra no debito: "No estabelecimento X"', 'Padaria Exemplo Centrosao Jose Dos Bra']]));
  assert.equal(t.contraparte, 'Padaria Exemplo Centro');
  assert.equal(t.cidade, 'sao Jose Dos');
  assert.equal(t.centavos, -8080);
  assert.equal(t.data, '2026-11-08');
  assert.equal(t.tipo, 'debito');
});

test('OFX: usa o MEMO quando o NAME vem vazio', () => {
  const [t] = parseOfx(ofx([['20260826', '-10.00', 'Compra no debito: "No estabelecimento LOJA EXEMPLO"', '']]));
  assert.equal(t.contraparte, 'LOJA EXEMPLO');
});

test('OFX: reconhece todos os tipos', () => {
  const tipos = parseOfx(ofx([
    ['20261001', '-1.00', 'Pix enviado: "Cp :1-A"', 'A'],
    ['20261001', '1.00', 'Pix enviado devolvido: "Cp :1-A"', 'A'],
    ['20261001', '1.00', 'Pix recebido: "Cp :1-A"', 'A'],
    ['20261001', '-1.00', 'Pagamento efetuado: "Debito Automatico Fatura Cartao Inter"', 'Pagamento Fatura'],
    ['20261001', '-1.00', 'Tarifa qualquer', 'A'],
  ])).map((t) => t.tipo);
  assert.deepEqual(tipos, ['pix_enviado', 'pix_devolvido', 'pix_recebido', 'pagamento_fatura', 'outro']);
});

test('envelope: livre e valor por dia', () => {
  assert.equal(dinheiroLivre(config), 380995);
  const e = calcularEnvelope(config, [], '2026-11-01');
  assert.equal(e.porDia, 12700);
  assert.equal(e.podeHoje, 12700);
});

test('envelope: sobra passa para o dia seguinte', () => {
  const e = calcularEnvelope(config, [gasto('2026-11-01', 10000)], '2026-11-02');
  assert.equal(e.saldoAnterior, 12700 - 10000);
  assert.equal(e.podeHoje, 25400 - 10000);
});

test('envelope: falta passa para o dia seguinte', () => {
  const e = calcularEnvelope(config, [gasto('2026-11-01', 20000)], '2026-11-02');
  assert.equal(e.saldoAnterior, 12700 - 20000);
  assert.equal(e.podeHoje, 25400 - 20000);
});

test('envelope: último dia fecha exatamente no livre, sem perda por arredondamento', () => {
  const e = calcularEnvelope(config, [], '2026-11-30');
  assert.equal(e.podeHoje, 380995);
});

test('envelope: reinicia a cada mês', () => {
  const e = calcularEnvelope(config, [gasto('2026-10-31', 999999)], '2026-11-01');
  assert.equal(e.podeHoje, 12700);
});

test('envelope: repasse, investimento, entradas e fatura ficam fora', () => {
  const fora = [
    gasto('2026-11-01', 100000, { categoria: 'Repasse/terceiros' }),
    gasto('2026-11-01', 50000, { categoria: 'Investimento' }),
    { ...gasto('2026-11-01', 0), centavos: 600000, tipo: 'pix_recebido', categoria: 'Salário' },
    gasto('2026-11-01', 1990, { tipo: 'pagamento_fatura', categoria: 'Fatura do cartão' }),
  ];
  assert.equal(calcularEnvelope(config, fora, '2026-11-01').gastoMes, 0);
});

test('envelope: compra no cartão desconta no dia da compra e o pagamento da fatura não duplica', () => {
  const lista = [
    gasto('2026-11-03', 5000, { tipo: 'cartao' }),
    gasto('2026-11-15', 5000, { tipo: 'pagamento_fatura', categoria: 'Fatura do cartão' }),
  ];
  assert.equal(calcularEnvelope(config, lista, '2026-11-03').gastoHoje, 5000);
  assert.equal(calcularEnvelope(config, lista, '2026-11-20').gastoMes, 5000);
});

test('envelope: devolução de Pix devolve o valor', () => {
  const lista = [gasto('2026-11-05', 13750), { ...gasto('2026-11-05', 0), centavos: 13750, tipo: 'pix_devolvido' }];
  assert.equal(calcularEnvelope(config, lista, '2026-11-05').gastoMes, 0);
});

test('envelope: fixo não desconta, mesmo em categoria Viagem', () => {
  const t = gasto('2026-11-13', 30000, { contraparte: 'Fornecedor Exemplo', categoria: 'Viagem' });
  assert.equal(contaNoEnvelope(t, config), false);
});

test('envelope: fixo com valor diferente conta como gasto normal', () => {
  const t = gasto('2026-11-13', 50000, { contraparte: 'Fornecedor Exemplo' });
  assert.equal(ehFixo(t, config.fixos), false);
  assert.equal(contaNoEnvelope(t, config), true);
});

test('envelope: viagem conta, a não ser que seja retirada nos ajustes', () => {
  const t = gasto('2026-11-02', 30000, { categoria: 'Viagem' });
  assert.equal(contaNoEnvelope(t, config), true);
  assert.equal(contaNoEnvelope(t, { ...config, foraDoEnvelope: ['Viagem'] }), false);
});

test('lançamento: aceita as formas de escrever', () => {
  assert.deepEqual(parseLancamento('35 almoço'), { centavos: -3500, descricao: 'almoço', diasAtras: 0 });
  assert.deepEqual(parseLancamento('almoço 12,50'), { centavos: -1250, descricao: 'almoço', diasAtras: 0 });
  assert.deepEqual(parseLancamento('ontem 1.200,50 pneu'), { centavos: -120050, descricao: 'pneu', diasAtras: 1 });
  assert.equal(parseLancamento('almoço'), null);
  assert.equal(parseLancamento('0 nada'), null);
  assert.equal(parseValor('1.20'), 120);
  assert.equal(parseValor('1.200'), 120000);
});

test('regras: palavra-chave não pega pedaço de outra palavra', () => {
  const r = compilarRegras();
  assert.equal(categorizar({ contraparte: 'Joao Barb', memo: '' }, r).categoria, A_CLASSIFICAR);
  assert.equal(categorizar({ contraparte: 'Bar Exemplo', memo: '' }, r).categoria, 'Bares e festas');
});

test('regras: regra do usuário vence a palavra-chave', () => {
  const t = { contraparte: 'Posto Central', memo: '' };
  const regras = compilarRegras([regraDeCorrecao(t, 'Viagem')]);
  assert.equal(categorizar(t, regras).categoria, 'Viagem');
});

test('importação: reimportar não duplica', () => {
  const novas = [gasto('2026-11-01', 4000), gasto('2026-11-01', 4000)].map(({ categoria, ...t }) => t);
  const p1 = planejarImportacao({ novas, existentes: [], regras: compilarRegras(), salario: 0 });
  assert.equal(p1.adicionar.length, 2);
  const p2 = planejarImportacao({ novas, existentes: p1.adicionar, regras: compilarRegras(), salario: 0 });
  assert.equal(p2.adicionar.length, 0);
  assert.equal(p2.ignoradas, 2);
});

test('importação: arquivo maior traz só o que faltava entre transações iguais', () => {
  const base = gasto('2026-11-01', 4000);
  const p1 = planejarImportacao({ novas: [base, base], existentes: [], regras: compilarRegras(), salario: 0 });
  const p2 = planejarImportacao({ novas: [base, base, base, base], existentes: p1.adicionar, regras: compilarRegras(), salario: 0 });
  assert.equal(p2.adicionar.length, 2);
});

test('importação: o id não depende do FITID', () => {
  const [a] = idsDeImportacao([{ ...gasto('2026-11-01', 4000), fitid: '1' }]);
  const [b] = idsDeImportacao([{ ...gasto('2026-11-01', 4000), fitid: '9' }]);
  assert.equal(a.id, b.id);
});

test('importação: não muda a categoria que o usuário corrigiu', () => {
  const novas = [gasto('2026-11-01', 4000, { categoria: undefined })];
  const existentes = planejarImportacao({ novas, existentes: [], regras: compilarRegras(), salario: 0 }).adicionar
    .map((t) => ({ ...t, categoria: 'Lazer' }));
  const p = planejarImportacao({ novas, existentes, regras: compilarRegras(), salario: 0 });
  assert.equal(p.adicionar.length, 0);
});

const manual = (id, data, centavos, extra = {}) => ({
  id, tipo: 'manual', data, centavos: -centavos, contraparte: 'almoço', memo: '', categoria: 'Comida e delivery', ...extra,
});
const planejar = (novas, existentes) => planejarImportacao({ novas, existentes, regras: compilarRegras(), salario: 0 });

test('casamento: mesmo valor e data ±1 dia vira detalhe', () => {
  const p = planejar([gasto('2026-11-02', 3500)], [manual('m1', '2026-11-01', 3500)]);
  assert.equal(p.vinculos.length, 1);
  assert.equal(p.revisoes.length, 0);
  const b = vincular(p.vinculos[0].banco, p.vinculos[0].manual);
  assert.equal(b.detalhe.descricao, 'almoço');
  assert.equal(b.categoria, 'Comida e delivery');
});

test('casamento: dois dias de diferença não casa', () => {
  const p = planejar([gasto('2026-11-03', 3500)], [manual('m1', '2026-11-01', 3500)]);
  assert.equal(p.vinculos.length + p.revisoes.length, 0);
});

test('casamento: valor diferente não casa', () => {
  const p = planejar([gasto('2026-11-01', 3600)], [manual('m1', '2026-11-01', 3500)]);
  assert.equal(p.vinculos.length + p.revisoes.length, 0);
});

test('casamento: dois manuais para um extrato vai para revisão', () => {
  const p = planejar([gasto('2026-11-01', 3500)], [manual('m1', '2026-11-01', 3500), manual('m2', '2026-11-01', 3500)]);
  assert.equal(p.vinculos.length, 0);
  assert.equal(p.revisoes.length, 1);
  assert.equal(p.revisoes[0].candidatos.length, 2);
});

test('casamento: um manual para dois extratos vai para revisão', () => {
  const p = planejar([gasto('2026-11-01', 3500), gasto('2026-11-01', 3500)], [manual('m1', '2026-11-01', 3500)]);
  assert.equal(p.vinculos.length, 0);
  assert.equal(p.revisoes.length, 2);
});

test('casamento: lançamento manual depois da primeira importação casa na seguinte', () => {
  const novas = [gasto('2026-11-01', 3500, { categoria: undefined })];
  const importadas = planejar(novas, []).adicionar;
  const p = planejar(novas, [...importadas, manual('m1', '2026-11-01', 3500)]);
  assert.equal(p.adicionar.length, 0);
  assert.equal(p.vinculos.length, 1);
});

test('casamento: desfazer devolve o manual e impede novo casamento', () => {
  const b = vincular({ ...gasto('2026-11-01', 3500), id: 'b1' }, manual('m1', '2026-11-01', 3500, { item: 'Água' }));
  const { banco, manuais: [m] } = desfazerVinculo(b, 'Mercado');
  assert.equal(banco.detalhe, undefined);
  assert.equal(banco.semVinculo, true);
  assert.equal(banco.categoria, 'Mercado');
  assert.equal(m.id, 'm1');
  assert.equal(m.item, 'Água');
  assert.equal(m.centavos, -3500);
});

test('casamento: manual usado sai das outras revisões', () => {
  const [o] = retirarDasRevisoes([{ id: 'b2', revisao: ['m1'] }], ['m1']);
  assert.equal(o.revisao, undefined);
});

test('itens: quantidade e total no mês, inclusive os ligados ao extrato', () => {
  const lista = [
    manual('a', '2026-11-01', 500, { item: 'Água' }),
    { ...gasto('2026-11-02', 500), detalhe: { item: 'Água' } },
    manual('b', '2026-10-30', 500, { item: 'Água' }),
  ];
  assert.deepEqual(relatorioItens(lista, '2026-11'), [{ item: 'Água', quantidade: 2, total: 1000 }]);
});

test('resumo: separa dia a dia, viagem e aportes', () => {
  const lista = [
    gasto('2026-11-01', 10000),
    gasto('2026-11-02', 20000, { categoria: 'Viagem' }),
    gasto('2026-11-03', 50000, { categoria: 'Investimento' }),
    gasto('2026-11-04', 100000, { categoria: 'Repasse/terceiros' }),
    gasto('2026-11-05', 9005, { contraparte: 'Imposto Exemplo', categoria: 'Impostos' }),
  ];
  const r = resumoMes(lista, '2026-11', config);
  assert.equal(r.total, 39005);
  assert.equal(r.diaADia, 10000);
  assert.equal(r.viagem, 20000);
  assert.equal(r.aporte, 50000);
});

test('fatura: lê o CSV, ignora pagamento e trata estorno', () => {
  const csv = '"Data";"Lançamento";"Categoria";"Tipo";"Valor"\n'
    + '"03/11/2026";"Loja X";"Compras";"Compra à vista";"R$ 50,00"\n'
    + '"04/11/2026";"Loja Y";"Compras";"Parcela 2/3";"R$ 1.000,00"\n'
    + '"05/11/2026";"Pagamento on-line";"";"";"R$ 300,00"\n'
    + '"06/11/2026";"Estorno Loja X";"";"";"R$ 50,00"\n';
  const { transacoes, ignoradas } = parseFaturaCsv(csv);
  assert.equal(ignoradas, 1);
  assert.deepEqual(transacoes.map((t) => t.centavos), [-5000, -100000, 5000]);
  assert.equal(transacoes[1].parcela, 'Parcela 2/3');
  assert.equal(transacoes[0].tipo, 'cartao');
});

test('fatura: recusa arquivo desconhecido', () => {
  assert.throws(() => parseFaturaCsv('a;b;c\n1;2;3'), /não reconhecido/);
});

test('fatura: parcelas iguais de faturas diferentes não se confundem', () => {
  const base = { data: '2026-11-04', centavos: -1000, tipo: 'cartao', contraparte: 'Loja' };
  const [a] = idsDeImportacao([{ ...base, parcela: '1/3' }]);
  const [b] = idsDeImportacao([{ ...base, parcela: '2/3' }]);
  assert.notEqual(a.id, b.id);
});

test('backup: valida formato e devolve dados', () => {
  const b = montarBackup({ transacoes: [], regras: [], itens: [], ajustes: {} }, '2026-11-08T00:00:00Z');
  assert.equal(validarBackup(JSON.parse(JSON.stringify(b))).versao, 1);
  assert.throws(() => validarBackup({ app: 'outro' }), /não é um backup/);
});

test('backup: lembrete depois de 30 dias', () => {
  const agora = '2026-11-08T00:00:00Z';
  assert.equal(precisaLembrete('2026-10-10T00:00:00Z', agora, true), false);
  assert.equal(precisaLembrete('2026-10-01T00:00:00Z', agora, true), true);
  assert.equal(precisaLembrete(null, agora, true), true);
  assert.equal(precisaLembrete(null, agora, false), false);
});

const item = (id, data, centavos, nome = 'Água') => manual(id, data, centavos, { item: nome, contraparte: nome });

test('soma: itens do dia que somam o extrato vão para revisão, nunca direto', () => {
  const p = planejar([gasto('2026-11-01', 1500)], [item('a', '2026-11-01', 500), item('b', '2026-11-01', 500), item('c', '2026-11-01', 500)]);
  assert.equal(p.vinculos.length, 0);
  assert.equal(p.revisoesSoma.length, 1);
  assert.equal(p.revisoesSoma[0].itens.length, 3);
});

test('soma: lançamentos sem item não entram', () => {
  const p = planejar([gasto('2026-11-01', 1000)], [manual('a', '2026-11-01', 500), manual('b', '2026-11-01', 500)]);
  assert.equal(p.revisoesSoma.length, 0);
});

test('soma: valor igual tem prioridade sobre a soma', () => {
  const p = planejar([gasto('2026-11-01', 1000)], [item('a', '2026-11-01', 1000), item('b', '2026-11-01', 500), item('c', '2026-11-01', 500)]);
  assert.equal(p.vinculos.length, 1);
  assert.equal(p.revisoesSoma.length, 0);
});

test('soma: soma diferente não vai para revisão', () => {
  const p = planejar([gasto('2026-11-01', 1600)], [item('a', '2026-11-01', 500), item('b', '2026-11-01', 500)]);
  assert.equal(p.revisoesSoma.length, 0);
});

test('soma: dois dias de diferença não entram', () => {
  const p = planejar([gasto('2026-11-03', 1000)], [item('a', '2026-11-01', 500), item('b', '2026-11-01', 500)]);
  assert.equal(p.revisoesSoma.length, 0);
});

test('soma: item já em revisão não é proposto de novo', () => {
  const pendente = { ...gasto('2026-11-01', 1000), id: 'x', revisaoSoma: ['a', 'b'] };
  const p = planejar([gasto('2026-11-01', 1000, { contraparte: 'Outra' })], [pendente, item('a', '2026-11-01', 500), item('b', '2026-11-01', 500)]);
  assert.equal(p.revisoesSoma.length, 0);
});

test('soma: confirmar conta os itens no relatório e o dinheiro uma vez só', () => {
  const b = vincularSoma({ ...gasto('2026-11-01', 1500), id: 'b1' }, [item('a', '2026-11-01', 500), item('b', '2026-11-01', 500), item('c', '2026-11-01', 500, 'Café')]);
  assert.equal(b.detalhe.descricao, '2× Água, 1× Café');
  assert.deepEqual(relatorioItens([b], '2026-11'), [{ item: 'Água', quantidade: 2, total: 1000 }, { item: 'Café', quantidade: 1, total: 500 }]);
  assert.equal(calcularEnvelope(config, [b], '2026-11-01').gastoMes, 1500);
});

test('soma: separar devolve todos os itens', () => {
  const b = vincularSoma({ ...gasto('2026-11-01', 1000), id: 'b1' }, [item('a', '2026-11-01', 500), item('b', '2026-11-01', 500)]);
  const { banco, manuais } = desfazerVinculo(b, 'Mercado');
  assert.equal(manuais.length, 2);
  assert.deepEqual(manuais.map((m) => m.centavos), [-500, -500]);
  assert.equal(banco.semVinculo, true);
});

test('soma: usar um item invalida outra revisão que dependia dele', () => {
  const [o] = retirarDasRevisoes([{ id: 'b2', revisaoSoma: ['a', 'b'] }], ['a']);
  assert.equal(o.revisaoSoma, undefined);
});

test('envelope: viagem fora não desconta, mas segue visível no resumo', () => {
  const cfg = { ...config, foraDoEnvelope: ['Viagem'] };
  const lista = [gasto('2026-11-02', 30000, { categoria: 'Viagem' })];
  assert.equal(calcularEnvelope(cfg, lista, '2026-11-02').gastoMes, 0);
  assert.equal(resumoMes(lista, '2026-11', cfg).viagem, 30000);
});

test('fechamento: registra meses encerrados, não o mês atual', () => {
  const f = registrarFechamentos(config, [gasto('2026-09-10', 100)], '2026-11-08');
  assert.deepEqual(Object.keys(f), ['2026-09', '2026-10']);
  assert.equal(f['2026-09'].livre, 380995);
});

test('fechamento: respeita o início do histórico', () => {
  const f = registrarFechamentos({ ...config, inicioHistorico: '2026-09' }, [gasto('2026-08-10', 100), gasto('2026-09-10', 100)], '2026-10-01');
  assert.deepEqual(Object.keys(f), ['2026-09']);
});

test('fechamento: sem novidade não regrava', () => {
  const cfg = { ...config, fechamentos: { '2026-10': { livre: 1, reserva: false } } };
  assert.equal(registrarFechamentos(cfg, [gasto('2026-10-10', 100)], '2026-11-08'), null);
});

test('fechamento: aumento de salário não reescreve o passado', () => {
  const cfg = { ...config, salario: 900000, fechamentos: { '2026-10': { livre: 100000, reserva: false } } };
  const [h] = historicoFechamentos(cfg, [gasto('2026-10-10', 30000)]);
  assert.equal(h.resultado, 70000);
});

test('fechamento: extrato importado depois corrige o histórico', () => {
  const cfg = { ...config, fechamentos: { '2026-10': { livre: 100000, reserva: false } } };
  const [h] = historicoFechamentos(cfg, [gasto('2026-10-10', 30000), gasto('2026-10-11', 90000)]);
  assert.equal(h.resultado, -20000);
});

test('fechamento: a falta não passa para o mês seguinte', () => {
  const e = calcularEnvelope(config, [gasto('2026-10-10', 900000)], '2026-11-01');
  assert.equal(e.saldoAnterior, 0);
  assert.equal(e.podeHoje, 12700);
});

const ordenar = (lista) => [...lista].sort(maisRecentePrimeiro).map((t) => t.id);

test('ordem: datas mais recentes primeiro', () => {
  const lista = [{ id: 'a', data: '2026-10-01' }, { id: 'c', data: '2026-11-08' }, { id: 'b', data: '2026-11-01' }];
  assert.deepEqual(ordenar(lista), ['c', 'b', 'a']);
});

test('ordem: no mesmo dia segue a sequência do banco, mesmo com dois dígitos', () => {
  const lista = [
    { id: 'c', data: '2026-10-27', fitid: '2026102707712' },
    { id: 'a', data: '2026-10-27', fitid: '202610270771' },
    { id: 'b', data: '2026-10-27', fitid: '202610270772' },
  ];
  assert.deepEqual(ordenar(lista), ['a', 'b', 'c']);
});

test('ordem: manuais do dia vêm antes do banco, o último lançado primeiro', () => {
  const lista = [
    { id: 'banco', data: '2026-11-08', tipo: 'debito', fitid: '202611080771' },
    { id: 'antigo', data: '2026-11-08', tipo: 'manual' },
    { id: 'm1', data: '2026-11-08', tipo: 'manual', criadoEm: '2026-11-08T10:00:00Z' },
    { id: 'm2', data: '2026-11-08', tipo: 'manual', criadoEm: '2026-11-08T12:00:00Z' },
  ];
  assert.deepEqual(ordenar(lista), ['m2', 'm1', 'antigo', 'banco']);
});

test('ordem: o horário do lançamento sobrevive a ligar e separar do extrato', () => {
  const criadoEm = '2026-11-08T10:00:00Z';
  const banco = { ...gasto('2026-11-08', 500), id: 'b' };
  const unico = desfazerVinculo(vincular(banco, manual('m', '2026-11-08', 500, { criadoEm })), 'Mercado');
  assert.equal(unico.manuais[0].criadoEm, criadoEm);
  const soma = desfazerVinculo(vincularSoma(banco, [manual('m', '2026-11-08', 500, { criadoEm })]), 'Mercado');
  assert.equal(soma.manuais[0].criadoEm, criadoEm);
});
