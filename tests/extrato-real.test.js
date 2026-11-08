// Confere o parser com os arquivos reais de extratos/, que não vão para o Git.
// Compara o OFX com o CSV exportado do mesmo período; sem os arquivos, os testes são pulados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { parseOfx } from '../src/inter-ofx.js';
import { compilarRegras } from '../src/categorias.js';
import { planejarImportacao } from '../src/importador.js';

const pasta = new URL('../extratos/', import.meta.url);
const arquivos = existsSync(pasta) ? readdirSync(pasta) : [];
const nomeOfx = arquivos.find((f) => f.toLowerCase().endsWith('.ofx'));
const nomeCsv = arquivos.find((f) => f.toLowerCase().endsWith('.csv'));
const opcoes = { skip: nomeOfx && nomeCsv ? false : 'sem extratos reais nesta máquina' };

function carregar() {
  const ofx = parseOfx(readFileSync(new URL(nomeOfx, pasta), 'latin1'));
  const linhas = readFileSync(new URL(nomeCsv, pasta), 'utf8').replace(/^﻿/, '').split(/\r?\n/);
  const paraCentavos = (s) => Math.round(parseFloat(s.replace(/\./g, '').replace(',', '.')) * 100);
  const csv = linhas.slice(6).filter(Boolean).map((l) => {
    const [data, historico, descricao, valor, saldo] = l.split(';');
    return {
      data: data.split('/').reverse().join('-'), historico: historico.trim(), descricao, centavos: paraCentavos(valor), saldo: paraCentavos(saldo),
    };
  });
  return { ofx, csv, saldoFinal: paraCentavos(linhas[3].split(';')[1]) };
}

test('extrato real: OFX e CSV têm as mesmas transações, na mesma ordem', opcoes, () => {
  const { ofx, csv } = carregar();
  assert.equal(ofx.length, csv.length);
  ofx.forEach((t, i) => {
    assert.equal(t.data, csv[i].data);
    assert.equal(t.centavos, csv[i].centavos);
  });
});

test('extrato real: o tipo bate com o histórico do banco', opcoes, () => {
  const { ofx, csv } = carregar();
  const esperado = {
    'Compra no débito': 'debito', 'Pix enviado': 'pix_enviado', 'Pix enviado devolvido': 'pix_devolvido', 'Pix recebido': 'pix_recebido', 'Pagamento efetuado': 'pagamento_fatura',
  };
  ofx.forEach((t, i) => assert.equal(t.tipo, esperado[csv[i].historico]));
});

test('extrato real: toda transação tem contraparte', opcoes, () => {
  assert.equal(carregar().ofx.filter((t) => !t.contraparte).length, 0);
});

test('extrato real: a soma reconstrói o saldo linha a linha', opcoes, () => {
  const { ofx, csv, saldoFinal } = carregar();
  assert.equal(csv[0].saldo, saldoFinal);
  for (let i = 0; i < ofx.length - 1; i++) assert.equal(csv[i + 1].saldo + ofx[i].centavos, csv[i].saldo);
});

test('extrato real: ids únicos e reimportação sem duplicar', opcoes, () => {
  const { ofx } = carregar();
  const regras = compilarRegras();
  const p1 = planejarImportacao({ novas: ofx, existentes: [], regras, salario: 0 });
  assert.equal(new Set(p1.adicionar.map((t) => t.id)).size, ofx.length);
  const p2 = planejarImportacao({ novas: ofx, existentes: p1.adicionar, regras, salario: 0 });
  assert.equal(p2.adicionar.length, 0);
});

test('extrato real: ids não mudam se a numeração do FITID mudar', opcoes, () => {
  const { ofx } = carregar();
  const regras = compilarRegras();
  const p1 = planejarImportacao({ novas: ofx, existentes: [], regras, salario: 0 });
  const renumeradas = ofx.map((t, i) => ({ ...t, fitid: `outro-${i}` }));
  assert.equal(planejarImportacao({ novas: renumeradas, existentes: p1.adicionar, regras, salario: 0 }).adicionar.length, 0);
});
