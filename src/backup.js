// Formato do backup em JSON e lembrete periódico.

export const VERSAO_BACKUP = 1;
const DIAS_LEMBRETE = 30;

export const ITENS_PADRAO = [
  { id: 'agua-com-gas', grupo: 'Bebidas', nome: 'Água c/ gás', categoria: 'Comida e delivery', ultimoPreco: null },
];

export function montarBackup({ transacoes, regras, itens, ajustes }, agora) {
  return { app: 'gastos-pessoais', versao: VERSAO_BACKUP, exportadoEm: agora, transacoes, regras, itens, ajustes };
}

export function validarBackup(dados) {
  const ok = dados?.app === 'gastos-pessoais'
    && dados.versao === VERSAO_BACKUP
    && Array.isArray(dados.transacoes)
    && Array.isArray(dados.regras)
    && Array.isArray(dados.itens)
    && typeof dados.ajustes === 'object' && dados.ajustes !== null;
  if (!ok) throw new Error('Este arquivo não é um backup válido deste app.');
  return dados;
}

export function precisaLembrete(ultimoBackup, agora, temDados) {
  if (!temDados) return false;
  if (!ultimoBackup) return true;
  return (Date.parse(agora) - Date.parse(ultimoBackup)) / 86400000 > DIAS_LEMBRETE;
}
