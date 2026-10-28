// tests/export.test.mjs — testes do passo 6: JSON do projeto (src/serialize.js) e encoder
// GIF89a (src/gif.js). O decoder GIF abaixo é mínimo (header, tabela global, extensões,
// image descriptor, LZW) e serve para provar o round trip: bytes → índices → cores.
// Rodar com: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDoc,
  beginStroke,
  paintPixel,
  endStroke,
  addLayer,
  removeLayer,
  addFrame,
  importDoc,
  setLayerOpacity,
  setLayerVisible,
  undo,
} from '../src/state.js';
import {
  FORMAT,
  FORMAT_VERSION,
  MAX_DIM,
  base64Encode,
  base64Decode,
  serializeDoc,
  parseDocJSON,
  toJSON,
} from '../src/serialize.js';
import { encodeGif, lzwEncode, buildPalette, delayCentiseconds } from '../src/gif.js';

// --- decoder GIF (só o necessário para validar o que o encoder escreve) ---

function decodeLZW(data, minCodeSize) {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let codeSize = minCodeSize + 1;
  let free = end + 1;
  const prefix = new Int32Array(4096).fill(-1);
  const suffix = new Uint8Array(4096);
  let prev = -1;
  const out = [];
  let acc = 0;
  let shift = 0;

  function walk(code) {
    const bytes = [];
    let c = code;
    while (c >= end) {
      bytes.unshift(suffix[c]);
      c = prefix[c];
    }
    bytes.unshift(c);
    return bytes;
  }

  for (const byte of data) {
    acc |= byte << shift;
    shift += 8;
    while (shift >= codeSize) {
      const code = acc & ((1 << codeSize) - 1);
      acc >>= codeSize;
      shift -= codeSize;
      if (code === clear) {
        codeSize = minCodeSize + 1;
        free = end + 1;
        prev = -1;
        continue;
      }
      if (code === end) return out;
      let bytes;
      if (code < free) {
        bytes = walk(code);
      } else {
        const base = walk(prev);
        bytes = [...base, base[0]]; // código recém-criado: string do anterior + 1º byte dele
      }
      out.push(...bytes);
      if (prev >= 0 && free < 4096) {
        prefix[free] = prev;
        suffix[free] = bytes[0];
        free += 1;
        if (free === (1 << codeSize) && codeSize < 12) codeSize += 1;
      }
      prev = code;
    }
  }
  return out;
}

function parseGif(bytes) {
  let p = 0;
  const u8 = () => bytes[p++];
  const u16 = () => bytes[p++] | (bytes[p++] << 8);
  const raw = (n) => {
    const s = bytes.subarray(p, p + n);
    p += n;
    return s;
  };

  assert.equal(String.fromCharCode(...raw(6)), 'GIF89a', 'header');
  const width = u16();
  const height = u16();
  const packed = u8();
  u8(); // pixel aspect ratio
  assert.ok(packed & 0x80, 'tabela global de cores presente');
  const tableSize = 2 ** ((packed & 7) + 1);
  const palette = [];
  for (let i = 0; i < tableSize; i++) palette.push([u8(), u8(), u8()]);

  let loop = null;
  let gce = null;
  const frames = [];
  let ended = false;
  while (p < bytes.length) {
    const marker = u8();
    if (marker === 0x3b) {
      ended = true;
      break;
    }

    if (marker === 0x21) {
      const label = u8();
      const chunks = [];
      for (;;) {
        const len = u8();
        if (len === 0) break;
        chunks.push(raw(len));
      }
      if (label === 0xf9) {
        const b = chunks[0];
        assert.equal(b.length, 4, 'GCE tem 4 bytes');
        gce = {
          disposal: (b[0] >> 2) & 7,
          transparency: b[0] & 1,
          delay: b[1] | (b[2] << 8),
          transparentIndex: b[3],
        };
      } else if (label === 0xff) {
        assert.equal(String.fromCharCode(...chunks[0]), 'NETSCAPE2.0', 'application block');
        assert.equal(chunks[1][0], 1, 'sub-bloco do loop');
        loop = chunks[1][1] | (chunks[1][2] << 8);
      } else {
        throw new Error(`extensão desconhecida 0x${label.toString(16)}`);
      }
      continue;
    }

    assert.equal(marker, 0x2a, 'image descriptor esperado');
    const left = u16();
    const top = u16();
    const w = u16();
    const h = u16();
    const ip = u8();
    const localSize = ip & 0x08 ? 2 ** ((ip & 7) + 1) : 0;
    const table = [];
    for (let i = 0; i < localSize; i++) table.push([u8(), u8(), u8()]);
    const minCodeSize = u8();
    const data = [];
    for (;;) {
      const len = u8();
      if (len === 0) break;
      assert.ok(len <= 255, 'sub-bloco de dados ≤ 255 bytes');
      data.push(...raw(len));
    }
    frames.push({
      left,
      top,
      w,
      h,
      minCodeSize,
      table: table.length ? table : palette,
      gce,
      indices: decodeLZW(Uint8Array.from(data), minCodeSize),
    });
    gce = null;
  }

  assert.ok(ended, 'trailer 0x3b');
  assert.equal(p, bytes.length, 'nada depois do trailer');
  return { width, height, palette, tableSize, loop, frames };
}

// Camada única visível com opacity 1: o buffer da camada É o frame composto. O blend de
// várias camadas é responsabilidade do render (view.composeInto), coberto no browser.
function docImages(doc) {
  return doc.frames.map((frame) => frame.layers[0].pixels);
}

function put(layer, width, x, y, rgba) {
  layer.pixels.set(rgba, (y * width + x) * 4);
}

// --- base64 ---

test('base64 round trip para todos os tamanhos de buffer', () => {
  for (let n = 0; n <= 12; n++) {
    const bytes = Uint8Array.from(Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256));
    const text = base64Encode(bytes);
    assert.equal(text.length % 4, 0, `grupo de 4 chars (${n} bytes)`);
    assert.deepEqual([...base64Decode(text)], [...bytes], `round trip de ${n} bytes`);
  }
  assert.equal(base64Encode(Uint8Array.from('Hello World', (c) => c.charCodeAt(0))), 'SGVsbG8gV29ybGQ=');
  assert.equal(base64Encode(new Uint8Array(0)), '');
});

test('base64Decode rejeita lixo e padding no meio', () => {
  assert.throws(() => base64Decode('!!!'), /base64 inválido/);
  assert.throws(() => base64Decode('AA=A'), /base64 inválido/);
  assert.throws(() => base64Decode('A'), /base64 inválido/);
  assert.deepEqual([...base64Decode('SGVsbG8gV29ybGQ=')], [...'Hello World'].map((c) => c.charCodeAt(0)));
});

// --- JSON do projeto ---

test('serialize/parse round trip: frames, camadas, alfa, visibilidade e opacidade', () => {
  const doc = createDoc({ width: 3, height: 2 });
  put(doc.frames[0].layers[0], 3, 0, 0, [255, 0, 0, 255]);
  put(doc.frames[0].layers[0], 3, 1, 1, [12, 34, 56, 90]); // alfa parcial preservado no JSON
  const top = addLayer(doc);
  put(top, 3, 2, 0, [0, 255, 0, 255]);
  setLayerVisible(doc, 1, false);
  setLayerOpacity(doc, 1, 0.5);
  const f2 = addFrame(doc);
  put(f2.layers[0], 3, 0, 1, [7, 7, 7, 255]);

  const parsed = parseDocJSON(toJSON(doc));
  assert.equal(parsed.width, 3);
  assert.equal(parsed.height, 2);
  assert.equal(parsed.frames.length, 2);
  assert.deepEqual(parsed.frames.map((f) => f.name), doc.frames.map((f) => f.name));
  assert.equal(parsed.frames[0].layers.length, 2);
  assert.equal(parsed.frames[0].layers[1].visible, false, 'camada oculta volta oculta');
  assert.equal(parsed.frames[0].layers[1].opacity, 0.5);
  assert.deepEqual([...parsed.frames[0].layers[0].pixels], [...doc.frames[0].layers[0].pixels]);
  assert.deepEqual([...parsed.frames[0].layers[1].pixels], [...top.pixels]);
  assert.deepEqual([...parsed.frames[1].layers[0].pixels], [...f2.layers[0].pixels]);

  const serial = serializeDoc(doc);
  assert.equal(serial.format, FORMAT);
  assert.equal(serial.version, FORMAT_VERSION);
  const pixels = doc.frames[0].layers[0].pixels;
  const b64 = serial.frames[0].layers[0].pixels;
  assert.ok(b64.length <= Math.ceil(pixels.length / 3) * 4, 'base64 tem grupos de 4 chars');
  assert.ok(b64.length < JSON.stringify(Array.from(pixels)).length, 'base64 é mais compacto que array de números');
});

test('importDoc abre o projeto no mesmo doc e solta as refs estruturais', () => {
  const doc = createDoc({ width: 2, height: 2 });
  const s = beginStroke(doc, 'p');
  paintPixel(s, 0, 0, [1, 2, 3, 255]);
  endStroke(doc, s);
  const B = addLayer(doc);
  removeLayer(doc, 1);
  const removeStroke = doc.history.at(-1);
  assert.equal(removeStroke.kind, 'remove');
  assert.equal(removeStroke.layer, B, 'o stroke é o dono da camada removida');

  const other = createDoc({ width: 4, height: 3 });
  put(other.frames[0].layers[0], 4, 3, 2, [9, 8, 7, 255]);
  importDoc(doc, parseDocJSON(toJSON(other)));

  assert.equal(doc.width, 4);
  assert.equal(doc.height, 3);
  assert.equal(doc.frames.length, 1);
  assert.equal(doc.frames[0].layers.length, 1);
  assert.equal(doc.frames[0].layers[0].pixels.length, 4 * 3 * 4);
  assert.equal(doc.frame, 0);
  assert.equal(doc.layer, 0);
  assert.equal(doc.history.length, 0, 'o histórico nasce vazio ao importar');
  assert.equal(doc.future.length, 0);
  assert.equal(undo(doc), false, 'importar não recria strokes');
  assert.equal(removeStroke.layer, null, 'ref solta → o buffer da camada removida fica coletável');
  assert.notEqual(doc.frames[0].layers[0].pixels.constructor, Uint8Array, 'buffer copiado, não o array do parse');
  assert.notEqual(doc.frames[0].layers[0].pixels, other.frames[0].layers[0].pixels, 'buffer próprio');
  assert.deepEqual(
    [...doc.frames[0].layers[0].pixels.slice((2 * 4 + 3) * 4, (2 * 4 + 3) * 4 + 4)],
    [9, 8, 7, 255],
    'o pixel importado chegou no lugar certo'
  );
});

test('parseDocJSON recusa JSON errado com mensagem legível', () => {
  assert.throws(() => parseDocJSON('{"format":"outro","version":1,"width":2,"height":2,"frames":[]}'), /formato esperado "aseclone"/);
  assert.throws(() => parseDocJSON(`{"format":"${FORMAT}","version":99,"width":2,"height":2,"frames":[]}`), /versão/);
  assert.throws(() => parseDocJSON(`{"format":"${FORMAT}","version":${FORMAT_VERSION},"width":0,"height":2,"frames":[]}`), /tamanho inválido/);
  assert.throws(() => parseDocJSON(`{"format":"${FORMAT}","version":${FORMAT_VERSION},"width":${MAX_DIM + 1},"height":1,"frames":[]}`), /tamanho máximo/);
  assert.throws(() => parseDocJSON(`{"format":"${FORMAT}","version":${FORMAT_VERSION},"width":2,"height":2,"frames":[]}`), /≥1 frame/);
  assert.throws(
    () => parseDocJSON(`{"format":"${FORMAT}","version":${FORMAT_VERSION},"width":2,"height":2,"frames":[{"name":"f","layers":[{"pixels":"AAA="}]}]}`),
    /camada 1 do frame 1: 2 bytes, esperado 16/
  );
  assert.throws(() => parseDocJSON('{ nao json'), /JSON não parseia/);
});

// --- GIF ---

test('GIF: estrutura, cores exatas, transparência e delay do playback', () => {
  const doc = createDoc({ width: 3, height: 2 });
  put(doc.frames[0].layers[0], 3, 0, 0, [255, 0, 0, 255]);
  put(doc.frames[0].layers[0], 3, 1, 1, [10, 20, 30, 200]); // alfa alto → opaco
  put(doc.frames[0].layers[0], 3, 2, 1, [0, 255, 0, 100]); // alfa baixo → transparente
  const f2 = addFrame(doc);
  put(f2.layers[0], 3, 2, 0, [0, 0, 255, 255]);
  const images = docImages(doc); // depois do addFrame: docImages lê doc.frames na hora

  const bytes = encodeGif(images, { width: 3, height: 2, delayMs: 1000 / 12 });
  const parsed = parseGif(bytes);
  assert.equal(parsed.width, 3);
  assert.equal(parsed.height, 2);
  assert.equal(parsed.frames.length, 2);
  assert.equal(parsed.loop, 0, 'loop infinito (NETSCAPE) com ≥2 frames');
  assert.equal(parsed.frames[0].minCodeSize, 2, 'poucas cores → min code size 2');
  assert.ok(parsed.tableSize >= 4, 'tabela cobre as cores + o índice transparente');
  assert.ok(parsed.tableSize % 2 === 0 && (parsed.tableSize & (parsed.tableSize - 1)) === 0, 'tabela é potência de 2');

  for (const frame of parsed.frames) {
    assert.equal(frame.left, 0);
    assert.equal(frame.top, 0);
    assert.equal(frame.w, 3);
    assert.equal(frame.h, 2);
    assert.equal(frame.indices.length, 6);
    assert.equal(frame.gce.disposal, 2, 'disposal 2: cada frame limpa o anterior');
    assert.equal(frame.gce.transparency, 1, 'índice transparente declarado');
    assert.equal(frame.gce.delay, delayCentiseconds(1000 / 12), 'delay em centésimos de segundo');
    assert.ok(frame.gce.transparentIndex < parsed.tableSize);
  }

  const colorOf = (frame, i) => frame.table[frame.indices[i]];
  assert.deepEqual(colorOf(parsed.frames[0], 0), [255, 0, 0], 'vermelho exato');
  assert.deepEqual(colorOf(parsed.frames[0], 4), [10, 20, 30], 'cor com alfa parcial é opaco (limite)');
  assert.equal(parsed.frames[0].indices[5], parsed.frames[0].gce.transparentIndex, 'alfa baixo → transparente');
  assert.deepEqual(colorOf(parsed.frames[1], 2), [0, 0, 255], 'frame 2 tem outra cor');
  const paletteKeys = parsed.palette.map(([r, g, b]) => `${r},${g},${b}`);
  for (const c of [[255, 0, 0], [10, 20, 30], [0, 0, 255]]) {
    assert.ok(paletteKeys.includes(c.join(',')), `a cor ${c.join(',')} está na tabela global`);
  }
});

test('GIF: escala nearest neighbour amplia os índices', () => {
  const doc = createDoc({ width: 2, height: 1 });
  put(doc.frames[0].layers[0], 2, 0, 0, [40, 60, 80, 255]);
  put(doc.frames[0].layers[0], 2, 1, 0, [200, 10, 10, 255]);

  const parsed = parseGif(encodeGif(docImages(doc), { width: 2, height: 1, scale: 3 }));
  assert.equal(parsed.width, 6);
  assert.equal(parsed.height, 3);
  const frame = parsed.frames[0];
  assert.equal(frame.indices.length, 18);
  // cada pixel do doc vira um bloco 3×3: as linhas são iguais e cada bloco repete o mesmo índice
  const rows = [0, 1, 2].map((y) => [...frame.indices.slice(y * 6, y * 6 + 6)]);
  const distinct = new Set(rows.flat().map((i) => frame.table[i].join(',')));
  assert.deepEqual([...distinct].sort(), ['200,10,10', '40,60,80'], 'as 2 cores do doc estão no GIF');
});

test('GIF: mais de 255 cores são reduzidas às mais frequentes', () => {
  const width = 300;
  const f1 = new Uint8ClampedArray(width * 4);
  for (let x = 0; x < width; x++) {
    f1.set([x % 256, (x * 7) % 256, (x * 13) % 256, 255], x * 4);
  }
  const f2 = new Uint8ClampedArray(width * 4);
  f2.set([255, 255, 255, 255], 0); // cor dominante
  for (let x = 1; x < width; x++) f2.set([255, 255, 255, 255], x * 4);

  const { palette, index } = buildPalette([f1, f2]);
  assert.equal(palette.length, 255, '255 cores + 1 índice transparente');
  assert.equal(palette[0], (255 << 16) | (255 << 8) | 255, 'a mais frequente fica no índice 0');
  assert.ok(index.size > 255, 'todas as cores originais têm destino');

  const parsed = parseGif(encodeGif([f1, f2], { width, height: 1 }));
  assert.equal(parsed.tableSize, 256);
  assert.equal(parsed.frames[0].gce.transparentIndex, 255);
  const kept = new Set(parsed.palette.slice(0, 255).map(([r, g, b]) => `${r},${g},${b}`));
  for (const i of parsed.frames[0].indices) {
    assert.ok(i < 255, 'nenhum pixel usa o índice transparente');
    assert.ok(kept.has(parsed.palette[i].join(',')), 'todo pixel cai numa cor mantida');
  }
  assert.deepEqual(parsed.frames[1].indices.every((i) => i === 0), true, 'a dominante é exata');
});

test('GIF de doc vazio: tudo transparente', () => {
  const doc = createDoc({ width: 2, height: 2 });
  const parsed = parseGif(encodeGif(docImages(doc), { width: 2, height: 2 }));
  assert.equal(parsed.frames.length, 1);
  assert.equal(parsed.loop, null, '1 frame não precisa do bloco de loop');
  assert.equal(parsed.frames[0].indices.every((i) => i === parsed.frames[0].gce.transparentIndex), true);
});

test('LZW: round trip com dados aleatórios (inclui reset por tabela cheia)', () => {
  let seed = 12345;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (const minCodeSize of [2, 4, 8]) {
    const indices = Uint8Array.from(Array.from({ length: 5000 }, () => rand(1 << minCodeSize)));
    const encoded = lzwEncode(indices, minCodeSize);
    assert.deepEqual([...decodeLZW(encoded, minCodeSize)], [...indices], `minCodeSize ${minCodeSize}`);
    assert.ok(encoded.length < indices.length * 2, 'compressão de fato reduz os bytes');
  }
  const solid = new Uint8Array(3000).fill(7);
  assert.ok(lzwEncode(solid, 2).length < 120, 'area sólida comprime muito');
});
