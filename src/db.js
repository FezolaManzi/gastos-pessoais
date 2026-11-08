// IndexedDB: todos os dados ficam no aparelho.

const NOME = 'gastos-pessoais';
const STORES = { transacoes: 'id', regras: 'padrao', itens: 'id', meta: 'chave' };
let conexao;

function abrir() {
  if (conexao) return conexao;
  conexao = new Promise((resolve, reject) => {
    const req = indexedDB.open(NOME, 1);
    req.onupgradeneeded = () => {
      for (const [store, keyPath] of Object.entries(STORES)) req.result.createObjectStore(store, { keyPath });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return conexao;
}

function concluir(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function lerTudo() {
  const db = await abrir();
  const tx = db.transaction(Object.keys(STORES));
  const leituras = Object.keys(STORES).map((store) => new Promise((resolve, reject) => {
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve([store, req.result]);
    req.onerror = () => reject(req.error);
  }));
  const dados = Object.fromEntries(await Promise.all(leituras));
  dados.meta = Object.fromEntries(dados.meta.map((m) => [m.chave, m.valor]));
  return dados;
}

// operacoes: { put: { store: [objetos] }, del: { store: [chaves] } }, tudo ou nada.
export async function gravar({ put = {}, del = {} }) {
  const db = await abrir();
  const tx = db.transaction(Object.keys(STORES), 'readwrite');
  for (const [store, lista] of Object.entries(put)) lista.forEach((o) => tx.objectStore(store).put(o));
  for (const [store, lista] of Object.entries(del)) lista.forEach((k) => tx.objectStore(store).delete(k));
  return concluir(tx);
}

export function gravarMeta(chave, valor) {
  return gravar({ put: { meta: [{ chave, valor }] } });
}

export async function substituirTudo({ transacoes, regras, itens, ajustes }, ultimoBackup) {
  const db = await abrir();
  const tx = db.transaction(Object.keys(STORES), 'readwrite');
  const dispositivo = (await lerDispositivo(tx));
  for (const store of Object.keys(STORES)) tx.objectStore(store).clear();
  transacoes.forEach((o) => tx.objectStore('transacoes').put(o));
  regras.forEach((o) => tx.objectStore('regras').put(o));
  itens.forEach((o) => tx.objectStore('itens').put(o));
  tx.objectStore('meta').put({ chave: 'ajustes', valor: ajustes });
  tx.objectStore('meta').put({ chave: 'ultimoBackup', valor: ultimoBackup });
  if (dispositivo) tx.objectStore('meta').put({ chave: 'dispositivo', valor: dispositivo });
  return concluir(tx);
}

function lerDispositivo(tx) {
  return new Promise((resolve, reject) => {
    const req = tx.objectStore('meta').get('dispositivo');
    req.onsuccess = () => resolve(req.result?.valor);
    req.onerror = () => reject(req.error);
  });
}
