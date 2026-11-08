// Categorias e regras genéricas (só palavras-chave, sem nomes de pessoas).
// Regras com nomes ficam em privado/ e, no app, apenas no aparelho.
import { normalizar } from './inter-ofx.js';

export const A_CLASSIFICAR = 'A classificar';
export const VIAGEM = 'Viagem';
export const PRESENTES = 'Presentes';
export const REPASSE = 'Repasse/terceiros';
export const INVESTIMENTO = 'Investimento';
export const SALARIO = 'Salário';
export const OUTRAS_ENTRADAS = 'Outras entradas';
export const FATURA = 'Fatura do cartão';

export const CATEGORIAS_GASTO = [
  'Mercado',
  'Comida e delivery',
  'Bares e festas',
  'Lazer',
  'Transporte',
  'Saúde',
  VIAGEM,
  'Compras',
  PRESENTES,
  'Casa',
  'Contas fixas',
  'Impostos',
  'Transferências pessoais',
  REPASSE,
  INVESTIMENTO,
];

export const REGRAS_GENERICAS = [
  ['\\bifood', 'Comida e delivery'],
  ['restaurante|churr?ascaria|lanchonet|pizzaria|padaria|panificadora|sushi|gelato|\\bcafe\\b|gastronomia|\\bdoce\\b|casa de paes|snack|almoco|jantar|marmita', 'Comida e delivery'],
  ['cable park', 'Lazer'],
  ['\\bzig|\\bbar\\b|cervejaria|\\badega|drinks|eventos', 'Bares e festas'],
  ['supermercado|mercadinho|\\bmercado\\b|atacad|carrefour|\\boxxo\\b|\\bhirota\\b|hortifrut|\\bfrutas\\b|casa de carnes|emporio de carnes|\\bconven', 'Mercado'],
  ['\\bposto\\b|\\buber\\b|estaci|\\bvalet\\b|pedagio', 'Transporte'],
  ['\\bdrog|farmacia|psicolog|clinica', 'Saúde'],
  ['\\bhotel|pousada|booking|bungalow|airbnb|hostel', VIAGEM],
  ['receita federal', 'Impostos'],
  ['havaianas|duty paid', 'Compras'],
].map(([padrao, categoria]) => ({ padrao, categoria, origem: 'generica' }));

// Regras específicas vêm antes: a correção do usuário sempre vence a palavra-chave.
export function compilarRegras(especificas = []) {
  return [...especificas.map((r) => ({ ...r, origem: 'especifica' })), ...REGRAS_GENERICAS]
    .map((r) => ({ ...r, re: new RegExp(r.padrao, 'i') }));
}

export function categorizar(transacao, regras) {
  const alvo = normalizar(`${transacao.contraparte} ${transacao.memo}`);
  const regra = regras.find((r) => r.re.test(alvo));
  return regra ? { categoria: regra.categoria, regra } : { categoria: A_CLASSIFICAR, regra: null };
}

export function ehCredito(transacao) {
  return transacao.tipo === 'pix_recebido' || (transacao.tipo === 'outro' && transacao.centavos > 0);
}

export function categorizarTransacao(transacao, regras, salario) {
  if (ehCredito(transacao)) {
    return { categoria: transacao.centavos === salario ? SALARIO : OUTRAS_ENTRADAS, regra: null };
  }
  if (transacao.tipo === 'pagamento_fatura') return { categoria: FATURA, regra: null };
  return categorizar(transacao, regras);
}

export function regraDeCorrecao(transacao, categoria) {
  const padrao = normalizar(transacao.contraparte).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { padrao, categoria };
}
