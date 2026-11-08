// Parser do extrato OFX da conta corrente do Banco Inter.
// Sem dependências de DOM ou Node: usado pelo app e pelos scripts de diagnóstico.

const TIPOS_POR_MEMO = [
  [/^compra no debito/i, 'debito'],
  [/^pix enviado devolvido/i, 'pix_devolvido'],
  [/^pix enviado/i, 'pix_enviado'],
  [/^pix recebido/i, 'pix_recebido'],
  [/^pagamento efetuado/i, 'pagamento_fatura'],
];

function campo(bloco, nome) {
  const m = bloco.match(new RegExp(`<${nome}>([^<\\r\\n]*)`, 'i'));
  return m ? m[1].trim() : '';
}

function paraCentavos(texto) {
  return Math.round(parseFloat(texto) * 100);
}

function limpar(texto) {
  return texto.replace(/\s+/g, ' ').trim();
}

// Débito vem em colunas fixas: 22 de estabelecimento, 13 de cidade e o país.
// Quando o NAME vem vazio, o estabelecimento só existe no MEMO.
function separarEstabelecimento(nome, memo) {
  const semPais = nome.replace(/bra$/i, '');
  if (nome && semPais !== nome && nome.length >= 38) {
    return { contraparte: limpar(semPais.slice(0, 22)), cidade: limpar(semPais.slice(22)) };
  }
  if (nome) return { contraparte: limpar(semPais), cidade: '' };
  const m = memo.match(/No estabelecimento ([^"]*)/i);
  return { contraparte: limpar(m ? m[1] : ''), cidade: '' };
}

export function parseOfx(texto) {
  const blocos = texto.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) || [];
  return blocos.map((bloco) => {
    const memo = campo(bloco, 'MEMO');
    const nome = campo(bloco, 'NAME');
    const dt = campo(bloco, 'DTPOSTED');
    const regra = TIPOS_POR_MEMO.find(([re]) => re.test(memo));
    const tipo = regra ? regra[1] : 'outro';
    const base = { contraparte: limpar(nome), cidade: '' };
    return {
      data: `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`,
      centavos: paraCentavos(campo(bloco, 'TRNAMT')),
      tipo,
      ...(tipo === 'debito' ? separarEstabelecimento(nome, memo) : base),
      memo,
      fitid: campo(bloco, 'FITID'),
    };
  });
}

export function normalizar(texto) {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
