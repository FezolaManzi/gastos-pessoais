// Regras de importação: não duplicar e casar lançamentos manuais com o extrato.
import { normalizar } from './inter-ofx.js';
import { A_CLASSIFICAR, categorizarTransacao } from './categorias.js';

const TIPOS_CASAVEIS = ['debito', 'pix_enviado', 'cartao'];

// O FITID do Inter numera o dia a partir da transação mais recente e muda ao longo do dia.
// Por isso o id usa os dados da transação e a ordem de ocorrência entre iguais.
export function idsDeImportacao(transacoes) {
  const vistos = new Map();
  return transacoes.map((t) => {
    const chave = [t.tipo, t.data, t.centavos, normalizar(t.contraparte), t.parcela || ''].join('|');
    const n = (vistos.get(chave) || 0) + 1;
    vistos.set(chave, n);
    return { ...t, id: `${chave}#${n}` };
  });
}

function distanciaDias(a, b) {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;
}

function combinam(banco, manual) {
  return banco.centavos === manual.centavos && distanciaDias(banco.data, manual.data) <= 1;
}

export function vincular(banco, manual) {
  return {
    ...banco,
    categoria: manual.categoria !== A_CLASSIFICAR ? manual.categoria : banco.categoria,
    revisao: undefined,
    revisaoSoma: undefined,
    detalhe: {
      id: manual.id,
      descricao: manual.contraparte,
      data: manual.data,
      categoria: manual.categoria,
      item: manual.item,
      grupo: manual.grupo,
    },
  };
}

function resumirItens(itens) {
  const contagem = new Map();
  for (const m of itens) contagem.set(m.contraparte, (contagem.get(m.contraparte) || 0) + 1);
  return [...contagem].map(([nome, n]) => `${n}× ${nome}`).join(', ');
}

export function vincularSoma(banco, itens) {
  const categorias = [...new Set(itens.map((m) => m.categoria))];
  return {
    ...banco,
    categoria: categorias.length === 1 && categorias[0] !== A_CLASSIFICAR ? categorias[0] : banco.categoria,
    revisaoSoma: undefined,
    detalhe: {
      descricao: resumirItens(itens),
      itens: itens.map((m) => ({
        id: m.id, descricao: m.contraparte, data: m.data, categoria: m.categoria, item: m.item, grupo: m.grupo, centavos: m.centavos,
      })),
    },
  };
}

export function desfazerVinculo(banco, categoriaOriginal) {
  const { detalhe, ...resto } = banco;
  const lancados = detalhe.itens || [{ ...detalhe, centavos: banco.centavos }];
  const manuais = lancados.map((d) => ({
    id: d.id,
    tipo: 'manual',
    data: d.data,
    centavos: d.centavos,
    contraparte: d.descricao,
    memo: '',
    cidade: '',
    categoria: d.categoria,
    item: d.item,
    grupo: d.grupo,
  }));
  return { banco: { ...resto, categoria: categoriaOriginal, semVinculo: true }, manuais };
}

export function planejarImportacao({ novas, existentes, regras, salario }) {
  const ids = new Set(existentes.map((t) => t.id));
  const lidas = idsDeImportacao(novas);
  const adicionar = lidas
    .filter((t) => !ids.has(t.id))
    .map((t) => ({ ...t, categoria: categorizarTransacao(t, regras, salario).categoria }));

  const datas = lidas.map((t) => t.data).sort();
  const noPeriodo = (t) => t.data >= datas[0] && t.data <= datas.at(-1);
  const manuais = existentes.filter((t) => t.tipo === 'manual');
  const bancos = [...adicionar, ...existentes.filter(noPeriodo)].filter((t) => TIPOS_CASAVEIS.includes(t.tipo)
    && t.centavos < 0 && !t.detalhe && !t.semVinculo && !t.revisao && !t.revisaoSoma);

  const opcoesDoManual = new Map(manuais.map((m) => [m.id, bancos.filter((b) => combinam(b, m))]));
  const vinculos = [];
  const revisoes = [];
  for (const banco of bancos) {
    const candidatos = manuais.filter((m) => combinam(banco, m));
    if (!candidatos.length) continue;
    if (candidatos.length === 1 && opcoesDoManual.get(candidatos[0].id).length === 1) {
      vinculos.push({ banco, manual: candidatos[0] });
    } else {
      revisoes.push({ banco, candidatos });
    }
  }

  // Sem valor igual, a soma dos itens de um dia pode ser um único pagamento. Sempre vai para revisão.
  const ocupados = new Set([
    ...vinculos.map((v) => v.manual.id),
    ...revisoes.flatMap((r) => r.candidatos.map((c) => c.id)),
    ...existentes.flatMap((t) => [...(t.revisao || []), ...(t.revisaoSoma || [])]),
  ]);
  const comValorIgual = new Set([...vinculos, ...revisoes].map((v) => v.banco.id));
  const itensPorDia = new Map();
  for (const m of manuais.filter((x) => x.item && !ocupados.has(x.id))) {
    itensPorDia.set(m.data, [...(itensPorDia.get(m.data) || []), m]);
  }
  const revisoesSoma = [];
  for (const banco of bancos.filter((b) => !comValorIgual.has(b.id))) {
    const dias = [...itensPorDia.entries()]
      .filter(([data]) => distanciaDias(data, banco.data) <= 1)
      .sort(([a], [b]) => distanciaDias(a, banco.data) - distanciaDias(b, banco.data));
    const achado = dias.find(([, itens]) => itens.length > 1 && itens.reduce((s, m) => s + m.centavos, 0) === banco.centavos);
    if (achado) revisoesSoma.push({ banco, itens: achado[1] });
  }
  return { adicionar, ignoradas: lidas.length - adicionar.length, vinculos, revisoes, revisoesSoma };
}

// Ao resolver um caso, os manuais usados saem das outras revisões. Na soma, faltar um item invalida o caso.
export function retirarDasRevisoes(transacoes, ids) {
  const usados = (lista) => lista?.some((id) => ids.includes(id));
  return transacoes
    .filter((t) => usados(t.revisao) || usados(t.revisaoSoma))
    .map((t) => {
      const revisao = t.revisao?.filter((id) => !ids.includes(id));
      return { ...t, revisao: revisao?.length ? revisao : undefined, revisaoSoma: usados(t.revisaoSoma) ? undefined : t.revisaoSoma };
    });
}
