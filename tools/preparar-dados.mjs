// Lê o OFX real e aplica regras e ajustes de privado/. Usado pelo diagnóstico e pelo backup inicial.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOfx, normalizar } from '../src/inter-ofx.js';
import { compilarRegras, categorizarTransacao, REPASSE, VIAGEM } from '../src/categorias.js';
import { idsDeImportacao } from '../src/importador.js';

export const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');

export function carregar() {
  const arquivo = readdirSync(join(raiz, 'extratos')).find((f) => f.toLowerCase().endsWith('.ofx'));
  const especificas = JSON.parse(readFileSync(join(raiz, 'privado', 'regras-pessoais.json'), 'utf8'));
  const ajustes = JSON.parse(readFileSync(join(raiz, 'privado', 'ajustes.json'), 'utf8'));
  const regras = compilarRegras(especificas);
  const transacoes = idsDeImportacao(parseOfx(readFileSync(join(raiz, 'extratos', arquivo), 'latin1'))).reverse();

  for (const t of transacoes) {
    const r = categorizarTransacao(t, regras, ajustes.salario);
    t.categoria = r.categoria;
    t.regra = r.regra;
    const naViagem = ajustes.viagens.some((v) => t.data >= v.inicio && t.data <= v.fim);
    if (naViagem && ['debito', 'pix_enviado', 'pix_devolvido'].includes(t.tipo) && t.categoria !== VIAGEM) {
      t.categoria = VIAGEM;
      t.fixada = true;
    }
    const repasse = ajustes.entradasRepasse.some((e) => e.data === t.data && e.centavos === t.centavos
      && normalizar(t.contraparte).includes(e.contraparte));
    if (repasse) {
      t.categoria = REPASSE;
      t.fixada = true;
    }
  }
  return { transacoes, ajustes, especificas, regras };
}
