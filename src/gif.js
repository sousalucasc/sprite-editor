// src/gif.js — encoder GIF89a (animação + transparência) em JS puro, sem dependências.
// GIF não guarda alfa parcial: só 1 bit de transparência. Então alfa < ALPHA_THRESHOLD vira
// o índice transparente e alfa parcial é tratado como transparente/opaco conforme o limite.
// Cores além de GIF_MAX_COLORS são reduzidas às mais frequentes; as outras caem na mantida
// mais próxima (a tabela global tem 256 índices, um deles reservado pro transparente).
export const GIF_MAX_COLORS = 255;
export const ALPHA_THRESHOLD = 128; // alfa abaixo disso = pixel transparente no GIF
export const MAX_GIF_SCALE = 8;
const MIN_CODE_SIZE = 2; // a spec exige min code size ≥ 2
const MAX_CODE_SIZE = 12; // código LZW máximo
const MAX_CODES = 1 << MAX_CODE_SIZE;

const clampInt = (v, min, max) =>
  Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : min;

const colorKey = (r, g, b) => (r << 16) | (g << 8) | b;

function nearest(palette, key) {
  const r = (key >> 16) & 255;
  const g = (key >> 8) & 255;
  const b = key & 255;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const dr = ((p >> 16) & 255) - r;
    const dg = ((p >> 8) & 255) - g;
    const db = (p & 255) - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

// images: Uint8ClampedArray por frame (RGBA straight alpha, já compostos).
// Devolve a paleta (keys RGB) e o mapa colorKey → índice (as cores que não cabem já
// vêm mapeadas para a mais próxima, então quem gera os índices não precisa decidir).
export function buildPalette(images, { threshold = ALPHA_THRESHOLD } = {}) {
  const freq = new Map();
  for (const img of images) {
    for (let i = 0; i < img.length; i += 4) {
      if (img[i + 3] < threshold) continue;
      const key = colorKey(img[i], img[i + 1], img[i + 2]);
      freq.set(key, (freq.get(key) ?? 0) + 1);
    }
  }
  const entries = [...freq].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const palette = entries.slice(0, GIF_MAX_COLORS).map(([key]) => key);
  const index = new Map();
  if (entries.length <= GIF_MAX_COLORS) {
    palette.forEach((key, i) => index.set(key, i));
  } else {
    for (const [key] of entries) index.set(key, nearest(palette, key));
  }
  return { palette, index };
}

// Índices de um frame, já ampliados por `scale` (nearest neighbour: cada pixel do doc
// vira um bloco scale×scale). Ordem raster (linha a linha da imagem ampliada).
export function frameIndices(img, width, height, scale, index, transparentIndex, threshold = ALPHA_THRESHOLD) {
  const out = new Uint8Array(width * scale * height * scale);
  let o = 0;
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(width);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (img[i + 3] < threshold) {
        row[x] = transparentIndex;
        continue;
      }
      row[x] = index.get(colorKey(img[i], img[i + 1], img[i + 2])) ?? transparentIndex;
    }
    for (let sy = 0; sy < scale; sy++) {
      for (let x = 0; x < width; x++) {
        for (let sx = 0; sx < scale; sx++) out[o++] = row[x];
      }
    }
  }
  return out;
}

// LZW da spec GIF: LSB-first, clear code = 2^minCodeSize, end code = clear+1,
// código de 12 bits no máximo; tabela cheia → clear e recomeça.
export function lzwEncode(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  const initCodeSize = Math.max(MIN_CODE_SIZE, minCodeSize) + 1;
  let codeSize = initCodeSize;
  let next = end + 1;
  let dict = new Map(); // (prefixo * 256 + byte) → código
  const bytes = [];
  let acc = 0;
  let shift = 0;

  function emit(code) {
    acc |= code << shift;
    shift += codeSize;
    while (shift >= 8) {
      bytes.push(acc & 255);
      acc >>= 8;
      shift -= 8;
    }
  }

  function reset() {
    emit(clear);
    dict = new Map();
    codeSize = initCodeSize;
    next = end + 1;
  }

  reset();
  let prefix = indices[0] ?? 0;
  for (let i = 1; i < indices.length; i++) {
    const byte = indices[i];
    const key = prefix * 256 + byte;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    emit(prefix);
    // O decoder cria a entrada nova depois de ler o próximo código, então ele só aumenta a
    // largura um código depois do encoder. Checar o limite antes de inserir (e não depois)
    // atrasa o aumento em uma emissão e mantém o bit stream alinhado.
    if (next === (1 << codeSize) && codeSize < MAX_CODE_SIZE) codeSize += 1;
    if (next >= MAX_CODES) {
      reset(); // tabela cheia: clear e recomeça
      prefix = byte;
      continue;
    }
    dict.set(key, next);
    next += 1;
    prefix = byte;
  }
  emit(prefix);
  emit(end);
  if (shift > 0) bytes.push(acc & 255);
  return Uint8Array.from(bytes);
}

// delayMs em centésimos de segundo (o unidade do delay no GIF). 1 cs = 10 ms.
export function delayCentiseconds(delayMs) {
  const cs = Math.round((Number.isFinite(delayMs) ? delayMs : 100) / 10);
  return Math.max(1, cs);
}

/**
 * encodeGif(images, { width, height, scale, delayMs, loop, threshold }) → Uint8Array.
 * Cada frame é desenhado na tela lógica inteira e descartado (disposal 2), com o índice
 * transparente sempre declarado: assim o fundo fica transparente entre frames em vez de
 * acumular os frames anteriores.
 */
export function encodeGif(images, { width = 1, height = 1, scale = 1, delayMs = 1000 / 12, loop = true, threshold = ALPHA_THRESHOLD } = {}) {
  if (!Array.isArray(images) || images.length === 0) throw new Error('GIF precisa de pelo menos 1 frame');
  const w = clampInt(width, 1, 4096);
  const h = clampInt(height, 1, 4096);
  const s = clampInt(scale, 1, MAX_GIF_SCALE);
  const W = w * s;
  const H = h * s;

  const { palette, index } = buildPalette(images, { threshold });
  const transparentIndex = palette.length; // sempre o último: palette ≤ 255 → índice ≤ 255
  const tableBits = Math.max(1, Math.ceil(Math.log2(Math.max(2, transparentIndex + 1))));
  const tableSize = 1 << tableBits;
  const minCodeSize = Math.max(MIN_CODE_SIZE, tableBits);
  const delay = delayCentiseconds(delayMs);

  const out = [];
  const push = (...bytes) => { for (const b of bytes) out.push(b & 255); };
  const pushStr = (str) => { for (let i = 0; i < str.length; i++) out.push(str.charCodeAt(i)); };
  const pushU16 = (v) => push(v & 255, (v >> 8) & 255);

  pushStr('GIF89a');
  pushU16(W);
  pushU16(H);
  // packed: global color table flag (bit 7), color resolution (bits 6-4), sort (bit 3),
  // tamanho da tabela (bits 2-0) onde o tamanho real é 2^(campo+1)
  push(0x80 | ((tableBits - 1) << 4) | (tableBits - 1), 0); // + pixel aspect ratio
  for (let i = 0; i < tableSize; i++) {
    const key = palette[i] ?? 0; // entradas além das cores usadas ficam pretas
    push((key >> 16) & 255, (key >> 8) & 255, key & 255);
  }

  if (loop && images.length > 1) {
    push(0x21, 0xff, 0x0b);
    pushStr('NETSCAPE2.0');
    push(0x03, 0x01);
    pushU16(0); // 0 = loop infinito
    push(0x00);
  }

  for (const img of images) {
    if (img.length !== w * h * 4) throw new Error(`frame com ${img.length} bytes, esperado ${w * h * 4}`);
    // Graphic Control Extension: packed, delay (cs), índice transparente, terminator
    push(0x21, 0xf9, 0x04); // introducer, label, block size = 4
    push((2 << 2) | 0x01); // packed: disposal 2 (restore to background) + transparency flag
    pushU16(delay);
    push(transparentIndex, 0x00); // índice transparente + block terminator

    push(0x2a); // image descriptor
    pushU16(0);
    pushU16(0);
    pushU16(W);
    pushU16(H);
    push(0x00); // sem tabela local, sem interlace
    push(minCodeSize);

    const data = lzwEncode(frameIndices(img, w, h, s, index, transparentIndex, threshold), minCodeSize);
    for (let i = 0; i < data.length; i += 255) {
      const n = Math.min(255, data.length - i);
      push(n);
      for (let k = 0; k < n; k++) push(data[i + k]);
    }
    push(0x00);
  }

  push(0x3b);
  return Uint8Array.from(out);
}
