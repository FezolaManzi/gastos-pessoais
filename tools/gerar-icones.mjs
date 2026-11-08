// Gera os ícones PNG do app (envelope branco sobre verde), sem dependências.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const VERDE = [20, 121, 92];
const BRANCO = [255, 255, 255];

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function bloco(tipo, dados) {
  const corpo = Buffer.concat([Buffer.from(tipo), dados]);
  const tam = Buffer.alloc(4);
  tam.writeUInt32BE(dados.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([tam, corpo, crc]);
}

function pixel(x, y) {
  const dentro = x > 0.18 && x < 0.82 && y > 0.3 && y < 0.72;
  if (!dentro) return VERDE;
  // Linhas da aba do envelope
  const dist = Math.abs(y - 0.3 - (0.5 - Math.abs(x - 0.5)) * 0.72);
  return dist < 0.018 ? VERDE : BRANCO;
}

function png(lado) {
  const linhas = Buffer.alloc((lado * 3 + 1) * lado);
  for (let y = 0; y < lado; y++) {
    const ini = y * (lado * 3 + 1);
    for (let x = 0; x < lado; x++) Buffer.from(pixel(x / lado, y / lado)).copy(linhas, ini + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(lado, 0);
  ihdr.writeUInt32BE(lado, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    bloco('IHDR', ihdr),
    bloco('IDAT', deflateSync(linhas)),
    bloco('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('icons', { recursive: true });
for (const lado of [180, 192, 512]) writeFileSync(`icons/icon-${lado}.png`, png(lado));
