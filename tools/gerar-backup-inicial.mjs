// Gera privado/backup-inicial.json para carregar no iPhone o histórico já classificado.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { carregar, raiz } from './preparar-dados.mjs';
import { ITENS_PADRAO, montarBackup } from '../src/backup.js';

const { transacoes, ajustes, especificas } = carregar();
const limpas = transacoes.map(({ regra, ...t }) => t);
const { salario, investimento, fixos, foraDoEnvelope, inicioHistorico } = ajustes;
const backup = montarBackup({
  transacoes: limpas,
  regras: especificas.map(({ padrao, categoria }) => ({ padrao, categoria })),
  itens: ITENS_PADRAO,
  ajustes: { salario, investimento, fixos, foraDoEnvelope, inicioHistorico, fechamentos: {} },
}, new Date().toISOString());

writeFileSync(join(raiz, 'privado', 'backup-inicial.json'), JSON.stringify(backup));
console.log(`${limpas.length} transações, ${backup.regras.length} regras`);
