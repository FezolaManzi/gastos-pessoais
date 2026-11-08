// Lançamento em uma linha: "35 almoço", "almoço 12,50", "ontem 35 almoço".

const NUMERO = '\\d{1,3}(?:\\.\\d{3})+(?:,\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?';

export function parseValor(texto) {
  const t = texto.trim().replace(/^R\$\s*/i, '');
  if (!new RegExp(`^(?:${NUMERO})$`).test(t)) return null;
  const decimal = /^\d{1,3}(?:\.\d{3})+/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(',', '.');
  const centavos = Math.round(parseFloat(decimal) * 100);
  return centavos > 0 ? centavos : null;
}

export function parseLancamento(linha) {
  let texto = linha.trim().replace(/\s+/g, ' ');
  const ontem = /^ontem\s+/i.test(texto);
  texto = texto.replace(/^ontem\s+/i, '');
  const inicio = texto.match(new RegExp(`^(${NUMERO})(?:\\s+(.+))?$`));
  const fim = texto.match(new RegExp(`^(.+?)\\s+(${NUMERO})$`));
  const valor = inicio ? inicio[1] : fim?.[2];
  if (!valor) return null;
  const centavos = parseValor(valor);
  if (!centavos) return null;
  return { centavos: -centavos, descricao: (inicio ? inicio[2] : fim[1]) || 'Sem descrição', diasAtras: ontem ? 1 : 0 };
}

export function isoLocal(data) {
  const p = (n) => String(n).padStart(2, '0');
  return `${data.getFullYear()}-${p(data.getMonth() + 1)}-${p(data.getDate())}`;
}

export function diasAntes(iso, dias) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - dias * 86400000).toISOString().slice(0, 10);
}

export function mesAnterior(mes) {
  const [a, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(a, m - 2, 1)).toISOString().slice(0, 7);
}

export function mesSeguinte(mes) {
  const [a, m] = mes.split('-').map(Number);
  return new Date(Date.UTC(a, m, 1)).toISOString().slice(0, 7);
}

// O FITID termina na sequência do dia, em que 1 é a transação mais recente.
function ordemNoDia(t) {
  return Number(t.fitid?.slice(11)) || 0;
}

// O extrato não traz horário: no mesmo dia, lançamentos manuais vêm antes dos do banco.
export function maisRecentePrimeiro(a, b) {
  if (a.data !== b.data) return b.data.localeCompare(a.data);
  const manualA = a.tipo === 'manual';
  const manualB = b.tipo === 'manual';
  if (manualA !== manualB) return manualA ? -1 : 1;
  if (manualA) return (b.criadoEm || '').localeCompare(a.criadoEm || '');
  return ordemNoDia(a) - ordemNoDia(b);
}
