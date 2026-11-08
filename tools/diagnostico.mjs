// Etapa 1: gera privado/relatorio-etapa1.md a partir do OFX em extratos/.
// Uso: node tools/diagnostico.mjs
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { carregar, raiz } from './preparar-dados.mjs';
import { normalizar } from '../src/inter-ofx.js';
import { A_CLASSIFICAR, FATURA, INVESTIMENTO, OUTRAS_ENTRADAS, PRESENTES, REPASSE, SALARIO, VIAGEM } from '../src/categorias.js';
import { dinheiroLivre, diasNoMes, ehFixo, totalFixos } from '../src/envelope.js';

const CORTE_TESTE = '2026-10-01';
const { transacoes, ajustes, regras } = carregar();

const brl = (c) => ((c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = (a, b) => `${((a / b) * 100).toFixed(1).replace('.', ',')}%`;
const tabela = (cab, linhas) =>
  [`| ${cab.join(' | ')} |`, `|${cab.map(() => '---').join('|')}|`, ...linhas.map((l) => `| ${l.join(' | ')} |`)].join('\n');
const soma = (lista) => lista.reduce((t, x) => t + x.centavos, 0);

// O salário recebido do dia 25 em diante é adiantamento do mês seguinte.
function competencia(t) {
  if (t.categoria !== SALARIO || Number(t.data.slice(8)) < 25) return t.data.slice(0, 7);
  const [a, m] = t.data.split('-').map(Number);
  return new Date(Date.UTC(a, m, 1)).toISOString().slice(0, 7);
}
for (const t of transacoes) t.mes = competencia(t);

const meses = [...new Set(transacoes.map((t) => t.mes))].sort();
const noMes = (lista, m) => lista.filter((t) => t.mes === m);
const cat = (...nomes) => transacoes.filter((t) => nomes.includes(t.categoria));
const gastosCob = transacoes.filter((t) => ['debito', 'pix_enviado'].includes(t.tipo));
const liquidos = transacoes.filter((t) => ['debito', 'pix_enviado', 'pix_devolvido'].includes(t.tipo));
const fixos = liquidos.filter((t) => ehFixo(t, ajustes.fixos) && t.categoria !== VIAGEM);
const viagem = liquidos.filter((t) => t.categoria === VIAGEM);
const diaADia = liquidos.filter((t) => ![VIAGEM, REPASSE, INVESTIMENTO, PRESENTES].includes(t.categoria));
const semFixos = diaADia.filter((t) => !ehFixo(t, ajustes.fixos));
const repasse = cat(REPASSE);
if (soma(transacoes) !== ajustes.saldoFinal - ajustes.saldoInicial) throw new Error('Total não fecha com o saldo do banco');

const linhasMes = meses.map((m) => {
  const v = (l) => -soma(noMes(l, m));
  const sal = -v(cat(SALARIO));
  const total = v(diaADia) + v(viagem) + v(cat(INVESTIMENTO)) + v(cat(PRESENTES)) + v(repasse) + v(cat(FATURA));
  return [m, brl(sal), brl(-v(cat(OUTRAS_ENTRADAS))), brl(v(semFixos)), brl(v(fixos)), brl(v(diaADia)), brl(v(viagem)),
    brl(v(cat(PRESENTES))), brl(v(cat(INVESTIMENTO))), brl(v(repasse)), brl(sal - total)];
});

const nomesCat = [...new Set(diaADia.map((t) => t.categoria))]
  .sort((a, b) => soma(diaADia.filter((t) => t.categoria === a)) - soma(diaADia.filter((t) => t.categoria === b)));
const linhasCat = nomesCat.map((c) => {
  const l = diaADia.filter((t) => t.categoria === c);
  return [c, ...meses.map((m) => brl(-soma(noMes(l, m)))), brl(-soma(l)), pct(soma(l), soma(diaADia))];
});

const porRegra = gastosCob.filter((t) => t.regra);
const final = gastosCob.filter((t) => t.categoria !== A_CLASSIFICAR);
const teste = gastosCob.filter((t) => t.data >= CORTE_TESTE);
const conhecidas = new Set(gastosCob.filter((t) => t.data < CORTE_TESTE && t.regra?.origem === 'especifica').map((t) => t.regra.padrao));
const cobTeste = teste.filter((t) => t.regra && (t.regra.origem === 'generica' || conhecidas.has(t.regra.padrao)));

const porDest = new Map();
for (const t of liquidos.filter((x) => x.categoria === A_CLASSIFICAR)) {
  const k = normalizar(t.contraparte);
  if (!porDest.has(k)) porDest.set(k, { nome: t.contraparte, lista: [] });
  porDest.get(k).lista.push(t);
}
const naoClass = [...porDest.values()].sort((a, b) => soma(a.lista) - soma(b.lista));

const livre = dinheiroLivre(ajustes);
const dias = (m) => diasNoMes(m);
const saida = `# Diagnóstico revisado: extrato Inter ${transacoes[0].data} a ${transacoes.at(-1).data}

${transacoes.length} transações. Agosto e novembro são parciais. Salário por competência (27/10 entra em novembro).

## Por mês
${tabela(['Mês', 'Salário', 'Ajuda família', 'Dia a dia s/ fixos', 'Fixos (fora viagem)', 'Dia a dia c/ fixos', 'Viagem', 'Presentes', 'Investimento', 'Repasse líq.', 'Sobrou/faltou só c/ salário'], linhasMes)}

## Dia a dia por categoria
${tabela(['Categoria', ...meses, 'Total', '%'], linhasCat)}

## Viagem
Total ${brl(-soma(viagem))} em ${viagem.length} lançamentos.
${tabela(['Mês', 'Viagem'], meses.map((m) => [m, brl(-soma(noMes(viagem, m)))]))}

## Cobertura
- Por regra: ${porRegra.length} de ${gastosCob.length} = **${pct(porRegra.length, gastosCob.length)}** das transações, ${pct(soma(porRegra), soma(gastosCob))} do valor.
- Com a viagem por período: ${final.length} de ${gastosCob.length} = **${pct(final.length, gastosCob.length)}**, ${pct(soma(final), soma(gastosCob))} do valor.
- Simulação em dados novos (desde ${CORTE_TESTE}): ${cobTeste.length} de ${teste.length} = **${pct(cobTeste.length, teste.length)}**, ${pct(soma(cobTeste), soma(teste))} do valor.

## Envelope
Salário ${brl(ajustes.salario)} − fixos ${brl(totalFixos(ajustes))} − investimento ${brl(ajustes.investimento)} = **${brl(livre)}** livre.
${tabela(['Dias no mês', 'Por dia'], [28, 30, 31].map((d) => [d, brl(Math.round(livre / d))]))}

## A classificar
${tabela(['Destinatário', 'Tipo', 'Vezes', 'Total'], naoClass.map(({ nome, lista }) => [nome, lista[0].tipo, lista.length, brl(-soma(lista))]))}
`;

writeFileSync(join(raiz, 'privado', 'relatorio-etapa1.md'), saida);
console.log(saida);
