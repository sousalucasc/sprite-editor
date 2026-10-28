// src/serialize.js — formato JSON do projeto: doc ↔ texto. Puro (sem DOM), então dá pra
// testar em Node. Os pixels vão em base64 (4/3 bytes por byte de buffer); nada de array de
// números, que inflaria o JSON. O histórico NÃO é serializado: ao abrir um projeto o
// histórico nasce vazio (decisão do passo 6 no PLANO.md). FPS e onion skin também não
// fazem parte do doc, então não entram no JSON.
export const FORMAT = 'aseclone';
export const FORMAT_VERSION = 1;
export const MAX_DIM = 4096; // teto de largura/altura importada: evita alocação absurda

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_REV = new Map([...B64].map((ch, i) => [ch, i]));

const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1);

export function base64Encode(bytes) {
  const parts = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    parts.push(B64[n >> 18], B64[(n >> 12) & 63], B64[(n >> 6) & 63], B64[n & 63]);
  }
  const tail = bytes.length % 3;
  if (tail === 0) return parts.join('');
  // o último grupo só tem os caracteres dos bytes reais; o resto é padding
  const keep = Math.floor(bytes.length / 3) * 4 + (tail === 1 ? 2 : 3);
  return parts.slice(0, keep).join('') + (tail === 1 ? '==' : '=');
}

export function base64Decode(text) {
  const clean = String(text).replace(/\s+/g, '');
  if (clean.includes('=') && !/=+$/.test(clean)) throw new Error('base64 inválido');
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const quad = clean.slice(i, i + 4);
    const vals = [];
    for (const ch of quad) {
      if (ch === '=') continue;
      const v = B64_REV.get(ch);
      if (v === undefined) throw new Error('base64 inválido');
      vals.push(v);
    }
    const count = vals.length - 1; // 2 chars → 1 byte, 3 → 2, 4 → 3; 1 char é inválido
    if (count < 1 || count > 3) throw new Error('base64 inválido');
    const n = vals.reduce((acc, v) => (acc << 6) | v, 0);
    for (let k = 0; k < count; k++) out.push((n >> (vals.length * 6 - 8 * (k + 1))) & 255);
  }
  return Uint8Array.from(out);
}

export function serializeDoc(doc) {
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    width: doc.width,
    height: doc.height,
    frames: doc.frames.map((frame) => ({
      name: frame.name,
      layers: frame.layers.map((layer) => ({
        name: layer.name,
        visible: layer.visible !== false,
        opacity: clamp01(layer.opacity ?? 1),
        pixels: base64Encode(layer.pixels),
      })),
    })),
  };
}

export function toJSON(doc, { pretty = false } = {}) {
  return JSON.stringify(serializeDoc(doc), null, pretty ? 2 : 0);
}

// Valida e devolve `{ width, height, frames }` com pixels já decodificados (Uint8Array).
// Lança Error com mensagem legível para a UI ler; nunca muda o doc.
export function parseDocJSON(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`JSON não parseia: ${error.message}`);
  }
  if (!data || typeof data !== 'object') throw new Error('JSON não é um objeto');
  if (data.format !== FORMAT) throw new Error(`formato esperado "${FORMAT}", veio "${data.format}"`);
  if (data.version !== FORMAT_VERSION) throw new Error(`versão ${FORMAT_VERSION} esperada, veio ${data.version}`);

  const width = Math.floor(data.width);
  const height = Math.floor(data.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error(`tamanho inválido: ${data.width}×${data.height}`);
  }
  if (width > MAX_DIM || height > MAX_DIM) throw new Error(`tamanho máximo ${MAX_DIM}×${MAX_DIM}`);

  if (!Array.isArray(data.frames) || data.frames.length === 0) throw new Error('o documento precisa de ≥1 frame');
  const n = width * height * 4;

  const frames = data.frames.map((frame, i) => {
    if (!frame || typeof frame !== 'object') throw new Error(`frame ${i + 1} inválido`);
    if (!Array.isArray(frame.layers) || frame.layers.length === 0) throw new Error(`frame ${i + 1} precisa de ≥1 camada`);
    return {
      name: typeof frame.name === 'string' ? frame.name : `Frame ${i + 1}`,
      layers: frame.layers.map((layer, j) => {
        if (!layer || typeof layer !== 'object') throw new Error(`camada ${j + 1} do frame ${i + 1} é inválida`);
        let pixels;
        try {
          pixels = typeof layer.pixels === 'string' ? base64Decode(layer.pixels) : null;
        } catch (error) {
          throw new Error(`camada ${j + 1} do frame ${i + 1}: ${error.message}`);
        }
        if (!pixels) throw new Error(`camada ${j + 1} do frame ${i + 1}: pixels faltando`);
        if (pixels.length !== n) throw new Error(`camada ${j + 1} do frame ${i + 1}: ${pixels.length} bytes, esperado ${n}`);
        return {
          name: typeof layer.name === 'string' ? layer.name : `Camada ${j + 1}`,
          visible: layer.visible !== false,
          opacity: clamp01(layer.opacity ?? 1),
          pixels,
        };
      }),
    };
  });

  return { width, height, frames };
}
