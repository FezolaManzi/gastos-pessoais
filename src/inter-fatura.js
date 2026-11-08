// Parser da fatura do cartão Inter em CSV.
// Feito sem um arquivo real: localiza as colunas pelo cabeçalho e recusa o que não reconhece.
import { normalizar } from './inter-ofx.js';

function separarCelulas(linha, separador) {
  const celulas = [];
  let atual = '';
  let aspas = false;
  for (const c of linha) {
    if (c === '"') aspas = !aspas;
    else if (c === separador && !aspas) {
      celulas.push(atual.trim());
      atual = '';
    } else atual += c;
  }
  celulas.push(atual.trim());
  return celulas;
}

function lerData(texto) {
  const br = texto.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  const iso = texto.match(/^\d{4}-\d{2}-\d{2}/);
  return iso ? iso[0] : null;
}

function lerValor(texto) {
  const limpo = texto.replace(/R\$|\s|\+|-/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(limpo);
  return Number.isNaN(n) ? null : Math.round(n * 100);
}

export function parseFaturaCsv(texto) {
  const linhas = texto.split(/\r?\n/).filter((l) => l.trim());
  const iCab = linhas.findIndex((l) => {
    const n = normalizar(l);
    return n.includes('data') && n.includes('valor') && /lancamento|descricao|estabelecimento/.test(n);
  });
  if (iCab < 0) throw new Error('Formato de fatura não reconhecido. Envie o arquivo para ajustarmos o leitor.');

  const sep = (linhas[iCab].match(/;/g) || []).length >= (linhas[iCab].match(/,/g) || []).length ? ';' : ',';
  const cab = separarCelulas(linhas[iCab], sep).map(normalizar);
  const coluna = (re) => cab.findIndex((c) => re.test(c));
  const iData = coluna(/data/);
  const iDesc = coluna(/lancamento|descricao|estabelecimento/);
  const iValor = coluna(/valor/);
  const iTipo = coluna(/tipo|parcela/);

  const transacoes = [];
  let ignoradas = 0;
  for (const linha of linhas.slice(iCab + 1)) {
    const c = separarCelulas(linha, sep);
    const data = lerData(c[iData] || '');
    const valor = lerValor(c[iValor] || '');
    const contraparte = c[iDesc] || '';
    if (!data || valor === null) continue;
    const nome = normalizar(contraparte);
    if (/pagamento|pag fatura/.test(nome)) {
      ignoradas += 1;
      continue;
    }
    const tipoLinha = iTipo >= 0 ? c[iTipo] || '' : '';
    const credito = /estorno|credito/.test(nome);
    transacoes.push({
      data,
      centavos: credito ? valor : -valor,
      tipo: 'cartao',
      contraparte: contraparte.replace(/\s+/g, ' '),
      cidade: '',
      memo: `Cartão ${tipoLinha}`.trim(),
      parcela: /\d+\s*(\/|de)\s*\d+/i.test(tipoLinha) ? tipoLinha : '',
    });
  }
  return { transacoes, ignoradas };
}
