// tests/state.test.mjs — testes do estado puro e do pincel da borracha.
// Rodar com: node --test tests/
// Não depende de DOM nem de navegador; só do módulo de estado.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDoc,
  beginStroke,
  paintPixel,
  endStroke,
  undo,
  redo,
  addLayer,
  removeLayer,
  moveLayer,
  addFrame,
  duplicateFrame,
  selectFrame,
  removeFrame,
  setHistoryLimit,
  setLayerVisible,
  onChange,
} from '../src/state.js';
import { createPlayback, normalizeFps } from '../src/timeline.js';
import { createEraser } from '../src/tools/eraser.js';

const pixelAt = (layer, x, y, width) => {
  const i = (y * width + x) * 4;
  return [...layer.pixels.slice(i, i + 4)];
};

test('undo estrutural restaura a camada removida e o diff dela', () => {
  const doc = createDoc({ width: 2, height: 2 });
  const B = addLayer(doc); // [A, B], doc.layer = 1
  const stroke = beginStroke(doc, 'pencil');
  paintPixel(stroke, 0, 0, [9, 9, 9, 255]);
  endStroke(doc, stroke);

  removeLayer(doc, 1); // [A]
  addLayer(doc); // C ocupa o mesmo índice 1
  undo(doc); // desfaz "camada nova" (C)
  undo(doc); // desfaz "camada removida" (B)

  assert.equal(doc.frames[0].layers.length, 2, 'B precisa voltar');
  assert.ok(doc.frames[0].layers.includes(B), 'o objeto de B é o mesmo');
  assert.deepEqual(pixelAt(B, 0, 0, 2), [9, 9, 9, 255], 'o buffer de B volta intacto');

  undo(doc); // desfaz o pixel
  assert.deepEqual(pixelAt(B, 0, 0, 2), [0, 0, 0, 0], 'o diff do pixel continua vivo');
});

test('diff guarda 12 bytes por pixel alterado (índice + before + after)', () => {
  const doc = createDoc({ width: 2, height: 2 });
  const stroke = beginStroke(doc, 'x');
  paintPixel(stroke, 0, 0, [1, 2, 3, 255]);
  endStroke(doc, stroke);

  const packed = doc.history[0];
  assert.equal(packed.index.length, 1);
  const bytes = packed.index.byteLength + packed.before.byteLength + packed.after.byteLength;
  assert.equal(bytes, 12);
});

test('escrita repetida no mesmo pixel vira uma entrada só', () => {
  const doc = createDoc({ width: 2, height: 2 });
  const stroke = beginStroke(doc, 'x');
  paintPixel(stroke, 0, 0, [1, 0, 0, 255]);
  paintPixel(stroke, 0, 0, [2, 0, 0, 255]);
  endStroke(doc, stroke);

  const packed = doc.history[0];
  assert.equal(packed.index.length, 1);
  assert.equal(packed.before[0], 0); // before original
  assert.equal(packed.after[0], 2); // after último
});

test('traço que volta ao valor original não entra no histórico', () => {
  const doc = createDoc({ width: 2, height: 2 });
  const stroke = beginStroke(doc, 'x');
  paintPixel(stroke, 0, 0, [255, 0, 0, 255]);
  paintPixel(stroke, 0, 0, [0, 0, 0, 0]); // valor original do buffer
  assert.equal(endStroke(doc, stroke), false);
  assert.equal(doc.history.length, 0);
});

test('moveLayer remapeia o stroke de pixel e o undo volta ao lugar certo', () => {
  const doc = createDoc({ width: 2, height: 2 });
  const B = addLayer(doc); // doc.layer = 1
  const stroke = beginStroke(doc, 'p');
  paintPixel(stroke, 0, 0, [5, 0, 0, 255]);
  endStroke(doc, stroke);

  moveLayer(doc, 1, 0);
  assert.equal(doc.frames[0].layers[0], B);

  undo(doc); // desfaz o move: B volta para o índice 1
  assert.equal(doc.frames[0].layers[1], B);
  undo(doc); // desfaz o pixel: aplica no buffer de B
  assert.deepEqual(pixelAt(B, 0, 0, 2), [0, 0, 0, 0]);
});

test('touch isola listener que lança e os outros continuam rodando', () => {
  const doc = createDoc();
  let ran = false;
  onChange(doc, () => {
    throw new Error('boom');
  });
  onChange(doc, () => {
    ran = true;
  });

  const original = console.error;
  console.error = () => {};
  try {
    setLayerVisible(doc, 0, false);
  } finally {
    console.error = original;
  }

  assert.equal(ran, true, 'o segundo listener rodou apesar do primeiro lançar');
  assert.equal(doc.frames[0].layers[0].visible, false);
});

test('removeFrame clampa doc.layer quando o frame de destino tem menos camadas', () => {
  const doc = createDoc({ width: 1, height: 1 });
  const extra = {
    name: 'Frame 2',
    layers: [{ name: 'L', visible: true, opacity: 1, pixels: new Uint8ClampedArray(4) }],
  };
  doc.frames.push(extra);
  doc.frame = 1;
  doc.layer = 0;
  addLayer(doc); // frame 2 fica com 2 camadas, doc.layer = 1

  removeFrame(doc, 1);
  assert.equal(doc.frames.length, 1);
  assert.equal(doc.frame, 0);
  assert.equal(doc.layer, 0, 'doc.layer não pode apontar para camada inexistente');

  undo(doc); // restaura o frame
  assert.equal(doc.frames.length, 2);
  assert.equal(doc.frames[1], extra);
  assert.equal(doc.layer, 0);
});

test('limite do histórico poda as duas pilhas', () => {
  const doc = createDoc({ width: 4, height: 1, historyLimit: 3 });
  for (let i = 0; i < 5; i++) {
    const stroke = beginStroke(doc, `p${i}`);
    paintPixel(stroke, i, 0, [i + 1, 0, 0, 255]);
    endStroke(doc, stroke);
  }
  assert.equal(doc.history.length, 3);

  setHistoryLimit(doc, 1);
  assert.equal(doc.history.length, 1);
});

test('borracha tamanho 2 quadrada apaga 4 pixels (2×2)', () => {
  const doc = createDoc({ width: 8, height: 8 });
  const layer = doc.frames[0].layers[0];
  layer.pixels.fill(255);

  const eraser = createEraser(doc, { size: 2, shape: 'square' });
  eraser.onDown({ x: 4, y: 4 });
  eraser.onUp();

  let cleared = 0;
  for (let i = 3; i < layer.pixels.length; i += 4) if (layer.pixels[i] === 0) cleared++;
  assert.equal(cleared, 4);
});

test('borracha tamanho 3 redonda apaga 5 pixels (cruz)', () => {
  const doc = createDoc({ width: 8, height: 8 });
  const layer = doc.frames[0].layers[0];
  layer.pixels.fill(255);

  const eraser = createEraser(doc, { size: 3, shape: 'circle' });
  eraser.onDown({ x: 4, y: 4 });
  eraser.onUp();

  let cleared = 0;
  for (let i = 3; i < layer.pixels.length; i += 4) if (layer.pixels[i] === 0) cleared++;
  assert.equal(cleared, 5);
});

// --- frames (passo 2): criação/duplicação/seleção, remape e liberação de buffers ---

test('addFrame herda as camadas com buffer vazio e o undo/redo reinsere o mesmo objeto', () => {
  const doc = createDoc({ width: 2, height: 2 });
  const L1 = doc.frames[0].layers[0];
  const s0 = beginStroke(doc, 'p');
  paintPixel(s0, 0, 0, [1, 1, 1, 255]);
  endStroke(doc, s0);

  const F2 = addFrame(doc);
  assert.equal(doc.frames.length, 2);
  assert.equal(doc.frame, 1, 'o frame novo passa a ser o ativo');
  assert.equal(doc.frames[1].layers.length, 1, 'herda a estrutura de camadas');
  assert.notEqual(doc.frames[1].layers[0], L1, 'camada nova, não a mesma');
  assert.notEqual(doc.frames[1].layers[0].pixels, L1.pixels, 'buffer próprio');
  assert.deepEqual(pixelAt(F2.layers[0], 0, 0, 2), [0, 0, 0, 0], 'nasce vazio');

  const s1 = beginStroke(doc, 'p2');
  paintPixel(s1, 0, 0, [7, 0, 0, 255]);
  endStroke(doc, s1);
  assert.equal(doc.history.length, 3);

  undo(doc); // desfaz o pixel do frame novo
  assert.deepEqual(pixelAt(F2.layers[0], 0, 0, 2), [0, 0, 0, 0]);
  undo(doc); // remove F2 → o stroke do pixel (que está no futuro) fica morto
  assert.equal(doc.frames.length, 1);
  assert.equal(doc.frame, 0, 'a seleção acompanha a remoção');
  assert.equal(doc.future[0].dead, true, 'stroke órfão do frame removido');
  undo(doc); // desfaz o pixel de F1
  assert.deepEqual(pixelAt(L1, 0, 0, 2), [0, 0, 0, 0]);
  assert.equal(undo(doc), false, 'a pilha acabou: o stroke morto não empilha nada de novo');

  redo(doc); // refaz o pixel de F1
  assert.deepEqual(pixelAt(L1, 0, 0, 2), [1, 1, 1, 255]);
  redo(doc); // refaz o frame: o MESMO objeto, com os pixels que foram editados nele
  assert.equal(doc.frames[1], F2);
  assert.equal(doc.frame, 1);
  assert.deepEqual(pixelAt(F2.layers[0], 0, 0, 2), [0, 0, 0, 0], 'o stroke morto não aplicou nada ainda');
  redo(doc); // o stroke morto revive junto com o frame
  assert.deepEqual(pixelAt(F2.layers[0], 0, 0, 2), [7, 0, 0, 255]);
  assert.equal(redo(doc), false, 'a pilha acabou');
});

test('duplicateFrame copia os pixels em buffers próprios', () => {
  const doc = createDoc({ width: 2, height: 2 });
  const src = beginStroke(doc, 'p');
  paintPixel(src, 0, 0, [4, 4, 4, 255]);
  paintPixel(src, 1, 1, [8, 8, 8, 255]);
  endStroke(doc, src);

  const dup = duplicateFrame(doc, 0);
  assert.equal(doc.frames.length, 2);
  assert.equal(doc.frames[1], dup);
  assert.equal(dup.name, doc.frames[0].name, 'a duplicata mantém o nome');
  assert.notEqual(dup.layers[0].pixels, doc.frames[0].layers[0].pixels, 'buffer copiado, não compartilhado');
  assert.deepEqual(pixelAt(dup.layers[0], 0, 0, 2), [4, 4, 4, 255]);

  const s = beginStroke(doc, 'p'); // doc.frame = 1: a duplicata é a ativa
  paintPixel(s, 0, 0, [9, 0, 0, 255]);
  endStroke(doc, s);
  assert.deepEqual(pixelAt(doc.frames[0].layers[0], 0, 0, 2), [4, 4, 4, 255], 'original intacto');
  assert.deepEqual(pixelAt(dup.layers[0], 0, 0, 2), [9, 0, 0, 255]);

  undo(doc); // desfaz o pixel na cópia
  assert.deepEqual(pixelAt(dup.layers[0], 0, 0, 2), [4, 4, 4, 255]);
  undo(doc); // remove a duplicata: o stroke é o único dono do buffer dela
  assert.equal(doc.frames.length, 1);
  assert.ok(!doc.frames.includes(dup));
});

test('addFrame remapeia os strokes dos frames posteriores', () => {
  const doc = createDoc({ width: 2, height: 2 });
  const F2 = addFrame(doc); // F2 em 1, ativo
  const s = beginStroke(doc, 'p'); // desenha em F2 (índice 1)
  paintPixel(s, 0, 0, [3, 0, 0, 255]);
  endStroke(doc, s);

  selectFrame(doc, 0);
  addFrame(doc); // novo frame em 1 → F2 vira índice 2
  assert.equal(doc.frames.length, 3);
  assert.equal(doc.frames[2], F2);
  assert.equal(doc.history[1].frame, 2, 'o stroke de F2 acompanha o shift');
  assert.equal(doc.history[0].frame, 2);
  assert.equal(doc.history[0].index, 2, 'a posição de inserção de F2 também');

  undo(doc); // remove o frame novo → os índices voltam
  assert.equal(doc.frames.length, 2);
  assert.equal(doc.frames[1], F2);
  assert.equal(doc.history[1].frame, 1);
  assert.equal(doc.history[0].index, 1);

  undo(doc); // desfaz o stroke de F2 (índice remapeado de volta)
  assert.deepEqual(pixelAt(F2.layers[0], 0, 0, 2), [0, 0, 0, 0]);
});

test('selectFrame clampa doc.layer quando o frame ativo tem menos camadas', () => {
  const doc = createDoc({ width: 1, height: 1 });
  const F2 = addFrame(doc); // herda 1 camada, doc.frame = 1
  addLayer(doc); // F2 fica com 2 camadas, doc.layer = 1
  assert.equal(doc.frames[1].layers.length, 2);

  selectFrame(doc, 0);
  assert.equal(doc.frame, 0);
  assert.equal(doc.layer, 0, 'F1 só tem 1 camada: doc.layer não pode ficar órfão');
  assert.ok(doc.frames[0].layers[doc.layer], 'doc.layer aponta para uma camada existente');

  const s = beginStroke(doc, 'p'); // beginStroke usa doc.frame/doc.layer: não pode estourar
  paintPixel(s, 0, 0, [3, 0, 0, 255]);
  endStroke(doc, s);
  assert.equal(doc.history.at(-1).frame, 0);

  selectFrame(doc, 1);
  assert.equal(doc.layer, 0);
  assert.ok(F2.layers[doc.layer]);
});

test('removeFrame solta a referência do frame quando o stroke cai da pilha', () => {
  const doc = createDoc({ width: 2, height: 2, historyLimit: 2 });
  const F2 = addFrame(doc);
  removeFrame(doc, 1); // o stroke frame-remove é o único dono do frame
  const removeStroke = doc.history[1];
  assert.equal(removeStroke.kind, 'frame-remove');
  assert.equal(removeStroke.frameObj, F2);
  assert.ok(!doc.frames.includes(F2), 'o frame saiu do doc');

  const a = beginStroke(doc, 'a');
  paintPixel(a, 0, 0, [1, 0, 0, 255]);
  endStroke(doc, a); // derruba o stroke mais antigo (frame-add de F2)
  assert.equal(doc.history.length, 2);
  assert.equal(doc.history[0], removeStroke);
  assert.equal(removeStroke.frameObj, F2, 'ainda dá pra desfazer a remoção');

  const b = beginStroke(doc, 'b');
  paintPixel(b, 1, 0, [2, 0, 0, 255]);
  endStroke(doc, b); // derruba o frame-remove → a ref morre, buffer coletável
  assert.equal(doc.history.length, 2);
  assert.equal(doc.history[1].kind, 'pixel');
  assert.equal(removeStroke.frameObj, null, 'stroke caiu da pilha → referência solta');
  assert.ok(!doc.frames.includes(F2));
});

test('uma escrita nova solta os frames que estavam no futuro', () => {
  const doc = createDoc({ width: 2, height: 2 });
  const F2 = addFrame(doc);
  removeFrame(doc, 1);
  undo(doc); // desfaz a remoção: F2 volta
  undo(doc); // desfaz a criação: F2 sai do doc, só o stroke é dono dele
  assert.equal(doc.frames.length, 1);
  assert.equal(doc.future.length, 2);

  const strokes = [...doc.future];
  assert.equal(strokes.find((s) => s.kind === 'frame-remove').frameObj, F2);
  assert.equal(strokes.find((s) => s.kind === 'frame-add').frameObj, F2);

  const s = beginStroke(doc, 'p');
  paintPixel(s, 0, 0, [1, 0, 0, 255]);
  endStroke(doc, s); // invalida o futuro
  assert.equal(doc.future.length, 0);
  assert.equal(strokes.find((s2) => s2.kind === 'frame-remove').frameObj, null);
  assert.equal(strokes.find((s2) => s2.kind === 'frame-add').frameObj, null);
  assert.ok(!doc.frames.includes(F2), 'nenhum lugar do doc segura o frame → GC coleta os buffers');
});

test('playback: um frame não anima e o FPS é clampado', () => {
  const doc = createDoc({ width: 2, height: 2 });
  const playback = createPlayback(doc, { fps: 12 });
  assert.equal(playback.start(), false, '1 frame não anima');
  assert.equal(playback.isPlaying(), false);

  assert.equal(normalizeFps(999), 60);
  assert.equal(normalizeFps(-5), 1);
  assert.equal(normalizeFps('x'), 1);
  assert.equal(playback.setFps(99), true);
  assert.equal(playback.fps(), 60);
  assert.equal(playback.setFps(60), false, 'FPS igual não notifica');
  playback.destroy();
});
