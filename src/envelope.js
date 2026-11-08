// Conta do envelope e resumos mensais. Valores sempre em centavos.
import { normalizar } from './inter-ofx.js';
import { mesSeguinte } from './lancamento.js';
import { A_CLASSIFICAR, FATURA, INVESTIMENTO, OUTRAS_ENTRADAS, PRESENTES, REPASSE, SALARIO, VIAGEM } from './categorias.js';

const TOLERANCIA_FIXO = 0.1;
const SEMPRE_FORA = [REPASSE, INVESTIMENTO];
const NAO_GASTO = [REPASSE, INVESTIMENTO, FATURA, SALARIO, OUTRAS_ENTRADAS];

export const CONFIG_PADRAO = { salario: 0, investimento: 0, fixos: [], foraDoEnvelope: [], fechamentos: {}, inicioHistorico: null };

export function diasNoMes(mes) {
  const [ano, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(ano, m, 0)).getUTCDate();
}

export function totalFixos(config) {
  return config.fixos.reduce((t, f) => t + f.centavos, 0);
}

export function dinheiroLivre(config) {
  return config.salario - totalFixos(config) - config.investimento;
}

// Valor diferente do combinado não é o fixo: entra como gasto normal.
export function ehFixo(t, fixos) {
  if (t.centavos >= 0) return false;
  const nome = normalizar(t.contraparte);
  return fixos.some((f) => new RegExp(f.padrao, 'i').test(nome)
    && Math.abs(-t.centavos - f.centavos) <= f.centavos * TOLERANCIA_FIXO);
}

export function contaNoEnvelope(t, config) {
  if (t.tipo === 'pix_recebido' || t.tipo === 'pagamento_fatura') return false;
  if (t.centavos > 0 && !['pix_devolvido', 'cartao'].includes(t.tipo)) return false;
  if (SEMPRE_FORA.includes(t.categoria) || config.foraDoEnvelope.includes(t.categoria)) return false;
  return !ehFixo(t, config.fixos);
}

// A sobra ou falta passa de um dia para o outro porque a conta é acumulada no mês.
export function calcularEnvelope(config, transacoes, hoje) {
  const mes = hoje.slice(0, 7);
  const dia = Number(hoje.slice(8, 10));
  const dias = diasNoMes(mes);
  const livre = dinheiroLivre(config);
  const doMes = transacoes.filter((t) => t.data.slice(0, 7) === mes && t.data <= hoje && contaNoEnvelope(t, config));
  const gastoHoje = doMes.filter((t) => t.data === hoje).reduce((s, t) => s - t.centavos, 0);
  const gastoMes = doMes.reduce((s, t) => s - t.centavos, 0);
  const acumulado = (d) => Math.round((livre * d) / dias);
  const saldoAnterior = acumulado(dia - 1) - (gastoMes - gastoHoje);
  return {
    livre,
    dias,
    dia,
    porDia: Math.round(livre / dias),
    gastoHoje,
    gastoMes,
    saldoAnterior,
    podeHoje: acumulado(dia) - gastoMes,
  };
}

function gastoNoEnvelope(config, transacoes, mes) {
  return transacoes
    .filter((t) => t.data.slice(0, 7) === mes && contaNoEnvelope(t, config))
    .reduce((s, t) => s - t.centavos, 0);
}

// O livre de cada mês fica guardado ao fechar, para um aumento futuro não reescrever o passado.
// O gasto continua calculado na hora: um extrato importado depois ainda corrige o histórico.
export function registrarFechamentos(config, transacoes, hoje) {
  const atual = hoje.slice(0, 7);
  const meses = transacoes
    .map((t) => t.data.slice(0, 7))
    .filter((m) => m < atual && (!config.inicioHistorico || m >= config.inicioHistorico))
    .sort();
  if (!config.salario || !meses.length) return null;
  const fechamentos = { ...config.fechamentos };
  let mudou = false;
  for (let m = meses[0]; m < atual; m = mesSeguinte(m)) {
    if (!fechamentos[m]) {
      fechamentos[m] = { livre: dinheiroLivre(config), reserva: false };
      mudou = true;
    }
  }
  return mudou ? fechamentos : null;
}

export function historicoFechamentos(config, transacoes) {
  return Object.entries(config.fechamentos)
    .map(([mes, f]) => {
      const gasto = gastoNoEnvelope(config, transacoes, mes);
      return { mes, livre: f.livre, gasto, resultado: f.livre - gasto, reserva: f.reserva };
    })
    .sort((a, b) => b.mes.localeCompare(a.mes));
}

function somarPorCategoria(lista) {
  const mapa = new Map();
  for (const t of lista) mapa.set(t.categoria, (mapa.get(t.categoria) || 0) - t.centavos);
  return mapa;
}

export function resumoMes(transacoes, mes, config) {
  const doMes = transacoes.filter((t) => t.data.slice(0, 7) === mes);
  const gastos = doMes.filter((t) => !NAO_GASTO.includes(t.categoria));
  const porCategoria = somarPorCategoria(gastos);
  const total = [...porCategoria.values()].reduce((a, b) => a + b, 0);
  const diaADia = gastos
    .filter((t) => ![VIAGEM, PRESENTES].includes(t.categoria) && !ehFixo(t, config.fixos))
    .reduce((s, t) => s - t.centavos, 0);
  const aporte = doMes.filter((t) => t.categoria === INVESTIMENTO).reduce((s, t) => s - t.centavos, 0);
  return { mes, total, diaADia, aporte, viagem: porCategoria.get(VIAGEM) || 0, porCategoria, aClassificar: porCategoria.get(A_CLASSIFICAR) || 0 };
}

export function compararMeses(atual, anterior) {
  const nomes = new Set([...atual.porCategoria.keys(), ...anterior.porCategoria.keys()]);
  return [...nomes]
    .map((categoria) => ({
      categoria,
      atual: atual.porCategoria.get(categoria) || 0,
      anterior: anterior.porCategoria.get(categoria) || 0,
    }))
    .sort((a, b) => b.atual - a.atual);
}

export function relatorioItens(transacoes, mes) {
  const mapa = new Map();
  for (const t of transacoes) {
    if (t.data.slice(0, 7) !== mes) continue;
    const lancados = t.detalhe?.itens || [{ item: t.item || t.detalhe?.item, centavos: t.centavos }];
    for (const { item, centavos } of lancados) {
      if (!item) continue;
      const r = mapa.get(item) || { item, quantidade: 0, total: 0 };
      r.quantidade += 1;
      r.total -= centavos;
      mapa.set(item, r);
    }
  }
  return [...mapa.values()].sort((a, b) => b.total - a.total);
}
