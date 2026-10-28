// src/state.js — estado do documento. Não conhece canvas, zoom nem DOM.
// Pixels são RGBA (straight alpha) em Uint8ClampedArray por camada; o ImageData
// do render usa esse mesmo buffer, então não há cópia por frame.
// O histórico guarda só os pixels alterados por traço (diff), nunca cópias inteiras:
// cada stroke armazena `index` (byte index do buffer) + `before`/`after` compactados
// em typed arrays. N strokes no histórico, os mais antigos caem quando estoura.
// Operações estruturais (camada add/remove/mov/prop e frame add/remove) entram na mesma
// pilha como strokes de `kind` minúsculos: nunca copiam pixels — a remoção guarda uma
// REFERÊNCIA ao objeto removido (não uma cópia) e o buffer só é liberado quando o
// stroke sai da pilha (estouro do limite) ou o futuro é invalidado por uma escrita nova.
// O mesmo vale para o frame criado: o stroke `frame-add` é o único dono da referência
// enquanto o frame está fora do doc (desfeito), então o GC só coleta o buffer dele quando
// a referência morre.

export const DEFAULT_HISTORY_LIMIT = 64;

function normalizeLimit(limit) {
  return Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : DEFAULT_HISTORY_LIMIT;
}

const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1);

let opSeq = 0; // id dos strokes estruturais, usado para "matar" e reativar diffs órfãos

function makeLayer(name, width, height) {
  return { name, visible: true, opacity: 1, pixels: new Uint8ClampedArray(width * height * 4) };
}

function makeFrame(name, width, height, source = null, copyPixels = false) {
  if (!source) return { name, layers: [makeLayer('Layer 1', width, height)] };
  // Frame novo herda a estrutura de camadas do frame de origem. Os pixels são buffers
  // próprios: frames são conteúdo do doc, não histórico (o histórico nunca copia a imagem).
  return {
    name,
    layers: source.layers.map((layer) => ({
      name: layer.name,
      visible: layer.visible,
      opacity: layer.opacity ?? 1,
      pixels: copyPixels ? layer.pixels.slice() : new Uint8ClampedArray(width * height * 4),
    })),
  };
}

export function createDoc({ width = 32, height = 32, frameName = 'Frame 1', historyLimit = DEFAULT_HISTORY_LIMIT } = {}) {
  return {
    width,
    height,
    frame: 0,
    layer: 0,
    frames: [makeFrame(frameName, width, height)],
    history: [],
    future: [],
    historyLimit: normalizeLimit(historyLimit),
    version: 0,
    listeners: new Set(),
  };
}

// Abre um projeto serializado (passo 6): troca width/height/frames no MESMO objeto doc,
// para as assinaturas (render, painéis, playback) continuarem válidas. Os buffers vêm
// copiados do parse — nada no doc referencia o array decodificado do JSON.
// O histórico das pilhas antigas não faz sentido sobre os frames novos (referencia objetos
// que não existem mais), então as duas pilhas são limpas e as referências estruturais são
// soltas: é isso que libera os buffers do conteúdo substituído (regra do AGENTS.md).
// O histórico nasce vazio — importar não recria strokes (decisão do passo 6).
export function importDoc(doc, parsed) {
  const width = Math.max(1, Math.floor(parsed.width) || 1);
  const height = Math.max(1, Math.floor(parsed.height) || 1);
  const size = width * height * 4;

  for (const stroke of doc.history) releaseStroke(stroke);
  doc.history.length = 0;
  for (const stroke of doc.future) releaseStroke(stroke);
  doc.future.length = 0;

  doc.width = width;
  doc.height = height;
  doc.frames = parsed.frames.map((frame, i) => ({
    name: frame.name ?? `Frame ${i + 1}`,
    layers: frame.layers.map((layer, j) => {
      const pixels = new Uint8ClampedArray(size);
      pixels.set(layer.pixels.subarray(0, Math.min(layer.pixels.length, size)));
      return {
        name: layer.name ?? `Camada ${j + 1}`,
        visible: layer.visible !== false,
        opacity: clamp01(layer.opacity ?? 1),
        pixels,
      };
    }),
  }));
  doc.frame = 0;
  doc.layer = 0;
  clampActiveLayer(doc);
  touch(doc);
  return doc;
}

// Contrato com o render: o estado avisa, o render redesenha. Retorna unsubscribe.
export function onChange(doc, fn) {
  doc.listeners.add(fn);
  return () => doc.listeners.delete(fn);
}

function touch(doc) {
  doc.version += 1;
  // Um listener que lança não pode impedir os outros nem propagar para quem mutou
  // o estado (já congelou a UI uma vez: o render parava no primeiro listener).
  for (const fn of doc.listeners) {
    try {
      fn(doc);
    } catch (error) {
      console.error('aseclone: listener de onChange falhou', error);
    }
  }
}

function same(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

export function beginStroke(doc, label = 'paint') {
  const frame = doc.frame;
  const layer = doc.layer;
  return {
    doc,
    label,
    frame,
    layer,
    pixels: doc.frames[frame].layers[layer].pixels, // buffer da camada, sem cópia
    writes: new Map(), // byte index -> diff; escrita repetida vira uma entrada só
  };
}

export function paintPixel(stroke, x, y, rgba) {
  const { width, height } = stroke.doc;
  if (x < 0 || y < 0 || x >= width || y >= height) return null;

  const p = stroke.pixels;
  const i = (y * width + x) * 4;
  const r = rgba[0];
  const g = rgba[1];
  const b = rgba[2];
  const a = rgba[3];

  // Valor atual: se o pixel já foi escrito neste traço, o valor vivo é `prev.after`
  // (o buffer já reflete isso); senão, lê o buffer. Evita alocar before/after em
  // escritas no-op (o balde e a linha do lápis repetem muitos pixels).
  const prev = stroke.writes.get(i);
  const current = prev ? prev.after : [p[i], p[i + 1], p[i + 2], p[i + 3]];
  if (current[0] === r && current[1] === g && current[2] === b && current[3] === a) return null;

  const after = [r, g, b, a];
  p[i] = r;
  p[i + 1] = g;
  p[i + 2] = b;
  p[i + 3] = a;

  if (prev) {
    prev.after = after;
    if (same(prev.before, prev.after)) stroke.writes.delete(i);
    return prev;
  }
  const entry = { i, before: current, after };
  stroke.writes.set(i, entry);
  return entry;
}

// Compacta o Map do traço em typed arrays: n índices + n*4 bytes before + n*4 after.
// É o único custo de memória do histórico — nada de buffer inteiro por stroke.
function packStroke(stroke) {
  const n = stroke.writes.size;
  const index = new Uint32Array(n);
  const before = new Uint8Array(n * 4);
  const after = new Uint8Array(n * 4);
  let k = 0;
  for (const [i, e] of stroke.writes) {
    index[k] = i;
    before.set(e.before, k * 4);
    after.set(e.after, k * 4);
    k += 1;
  }
  return { kind: 'pixel', label: stroke.label, frame: stroke.frame, layer: stroke.layer, index, before, after };
}

function pushCapped(list, stroke, limit) {
  list.push(stroke);
  if (list.length > limit) releaseStroke(list.shift()); // derruba o stroke mais antigo
}

// Libera a referência que um stroke estrutural de remoção/adição mantém sobre o objeto
// removido/criado. Quando o stroke não pode mais ser desfeito/refeito, soltar a ref é o
// que liberta o buffer da camada/frame (regra do AGENTS.md) — o GC coleta o buffer.
function releaseStroke(stroke) {
  if (stroke.kind === 'add' || stroke.kind === 'remove') stroke.layer = null;
  // `frame-add` segura o frame criado quando ele foi desfeito (está fora do doc); soltar a
  // ref é o que liberta os buffers das camadas dele.
  if (stroke.kind === 'frame-remove' || stroke.kind === 'frame-add') stroke.frameObj = null;
}

// Uma escrita nova (pixels ou operação estrutural) invalida tudo que poderia ser refazido.
function clearFuture(doc) {
  for (const s of doc.future) releaseStroke(s);
  doc.future.length = 0;
}

export function endStroke(doc, stroke) {
  if (stroke.writes.size === 0) return false;
  pushCapped(doc.history, packStroke(stroke), doc.historyLimit);
  clearFuture(doc);
  touch(doc);
  return true;
}

// --- pilha de operações estruturais ---

function pushOp(doc, stroke) {
  clearFuture(doc);
  pushCapped(doc.history, stroke, doc.historyLimit);
}

function eachStroke(doc, fn) {
  for (const s of doc.history) fn(s);
  for (const s of doc.future) fn(s);
}

// O diff referencia frame/camada por índice; quando uma camada/frame é removido ou
// reordenado, os índices dos strokes vivos são remapeados para o espaço novo (decisão
// do PLANO). Strokes que apontavam para o objeto removido ficam "mortos": sua diff
// nunca é aplicada até a remoção ser desfeita (o objeto volta inteiro, e os diffs
// órfãos reativam porque o buffer restaurado é o MESMO objeto).
function targetsLayer(stroke, index, layer) {
  switch (stroke.kind) {
    case 'add':
    case 'remove':
      // Identidade do objeto, nunca o índice: dois strokes em índices iguais podem
      // ser camadas diferentes. Comparar por índice matava o stroke `remove` de uma
      // camada só porque outra camada ocupou o mesmo índice depois (undo perdia a
      // camada removida de vez).
      return stroke.layer === layer;
    case 'move':
      return stroke.from === index || stroke.to === index;
    default: // pixel / prop
      return stroke.layer === index;
  }
}

function markDeadLayers(doc, frame, index, layer, token, skip) {
  eachStroke(doc, (s) => {
    if (s === skip || s.dead || s.frame !== frame) return;
    if (targetsLayer(s, index, layer)) {
      s.dead = true;
      s.deadBy = token;
    }
  });
}

function markDeadFrames(doc, frame, token, skip) {
  eachStroke(doc, (s) => {
    if (s === skip || s.dead || s.frame !== frame) return;
    s.dead = true;
    s.deadBy = token;
  });
}

function reviveStrokes(doc, token) {
  if (token == null) return;
  eachStroke(doc, (s) => {
    if (s.dead && s.deadBy === token) {
      s.dead = false;
      s.deadBy = null;
    }
  });
}

// Mapa de índices para um move(from→to): elementos entre os dois índices deslocam ±1.
function moveMap(from, to) {
  if (from === to) return (i) => i;
  if (to > from) return (i) => (i === from ? to : i > from && i <= to ? i - 1 : i);
  return (i) => (i === from ? to : i >= to && i < from ? i + 1 : i);
}

function remapLayerStrokes(doc, frame, map, skip) {
  eachStroke(doc, (s) => {
    if (s === skip || s.dead || s.frame !== frame) return;
    if (s.kind === 'pixel' || s.kind === 'prop') s.layer = map(s.layer);
    else if (s.kind === 'add' || s.kind === 'remove') s.index = map(s.index);
    else if (s.kind === 'move') {
      s.from = map(s.from);
      s.to = map(s.to);
    }
  });
}

function remapFrameStrokes(doc, map, skip) {
  eachStroke(doc, (s) => {
    if (s === skip || s.dead) return;
    s.frame = map(s.frame);
    if (s.kind === 'frame-add') s.index = map(s.index); // posição de inserção acompanha o shift
  });
}

function deleteLayerAt(doc, frameIdx, index, skip, token) {
  const frame = doc.frames[frameIdx];
  const layer = frame?.layers[index];
  if (!layer) return null;
  markDeadLayers(doc, frameIdx, index, layer, token, skip);
  remapLayerStrokes(doc, frameIdx, (i) => (i > index ? i - 1 : i), skip);
  frame.layers.splice(index, 1);
  if (doc.frame === frameIdx) {
    if (doc.layer > index) doc.layer -= 1;
    else if (doc.layer >= frame.layers.length) doc.layer = frame.layers.length - 1;
  }
  return layer;
}

function insertLayerAt(doc, frameIdx, index, layer, skip) {
  if (!layer) return false;
  const frame = doc.frames[frameIdx];
  if (!frame) return false;
  const i = Math.max(0, Math.min(index, frame.layers.length));
  remapLayerStrokes(doc, frameIdx, (j) => (j >= i ? j + 1 : j), skip);
  frame.layers.splice(i, 0, layer);
  if (doc.frame === frameIdx && doc.layer >= i) doc.layer += 1;
  return true;
}

function moveLayerCore(doc, frameIdx, from, to, skip) {
  const frame = doc.frames[frameIdx];
  const layer = frame?.layers[from];
  if (!layer || from === to) return false;
  frame.layers.splice(from, 1);
  frame.layers.splice(to, 0, layer);
  const map = moveMap(from, to);
  remapLayerStrokes(doc, frameIdx, map, skip);
  if (doc.frame === frameIdx) doc.layer = map(doc.layer);
  return true;
}

function clampActiveLayer(doc) {
  const frame = doc.frames[doc.frame];
  if (!frame) return;
  const max = frame.layers.length - 1;
  if (doc.layer > max) doc.layer = Math.max(0, max);
  if (doc.layer < 0) doc.layer = 0;
}

function deleteFrameAt(doc, index, skip, token) {
  const frame = doc.frames[index];
  if (!frame || doc.frames.length === 1) return null; // nunca deixa o doc sem frame
  markDeadFrames(doc, index, token, skip);
  remapFrameStrokes(doc, (i) => (i > index ? i - 1 : i), skip);
  doc.frames.splice(index, 1);
  if (doc.frame > index) doc.frame -= 1;
  else if (doc.frame >= doc.frames.length) doc.frame = doc.frames.length - 1;
  clampActiveLayer(doc); // frames podem ter nº de camadas diferente: doc.layer não pode ficar órfão
  return frame;
}

function insertFrameAt(doc, index, frameObj, skip) {
  if (!frameObj) return false;
  const i = Math.max(0, Math.min(index, doc.frames.length));
  remapFrameStrokes(doc, (j) => (j >= i ? j + 1 : j), skip);
  doc.frames.splice(i, 0, frameObj);
  if (doc.frame >= i) doc.frame += 1;
  clampActiveLayer(doc);
  return true;
}

// --- operações públicas (todas entram no histórico como stroke de `kind`) ---

export function addLayer(doc, name) {
  const frame = doc.frames[doc.frame];
  const layer = makeLayer(name ?? `Camada ${frame.layers.length + 1}`, doc.width, doc.height);
  frame.layers.push(layer);
  doc.layer = frame.layers.length - 1;
  pushOp(doc, { kind: 'add', label: 'camada nova', frame: doc.frame, index: doc.layer, layer, opId: ++opSeq });
  touch(doc);
  return layer;
}

export function removeLayer(doc, index = doc.layer) {
  const frame = doc.frames[doc.frame];
  if (frame.layers.length <= 1) return null; // manter ao menos 1 camada: ferramentas precisam de alvo
  const stroke = { kind: 'remove', label: 'camada removida', frame: doc.frame, index, layer: null, opId: ++opSeq };
  const layer = deleteLayerAt(doc, doc.frame, index, stroke, stroke.opId);
  if (!layer) return null;
  stroke.layer = layer;
  pushOp(doc, stroke);
  touch(doc);
  return layer;
}

export function moveLayer(doc, index, to) {
  const frame = doc.frames[doc.frame];
  const target = Math.max(0, Math.min(Math.floor(to), frame.layers.length - 1));
  if (!frame.layers[index] || index === target) return false;
  if (!moveLayerCore(doc, doc.frame, index, target)) return false;
  pushOp(doc, { kind: 'move', label: target > index ? 'camada ↑' : 'camada ↓', frame: doc.frame, from: index, to: target, opId: ++opSeq });
  touch(doc);
  return true;
}

// Seleção da camada ativa: não entra no histórico (é view de edição, não conteúdo).
export function selectLayer(doc, index) {
  const frame = doc.frames[doc.frame];
  if (!frame.layers[index] || index === doc.layer) return false;
  doc.layer = index;
  touch(doc);
  return true;
}

export function setLayerVisible(doc, index = doc.layer, visible) {
  const layer = doc.frames[doc.frame].layers[index];
  if (!layer) return false;
  const next = visible == null ? !layer.visible : Boolean(visible);
  if (next === layer.visible) return false;
  const stroke = { kind: 'prop', label: next ? 'camada visível' : 'camada oculta', frame: doc.frame, layer: index, field: 'visible', before: layer.visible, after: next, opId: ++opSeq };
  layer.visible = next;
  pushOp(doc, stroke);
  touch(doc);
  return true;
}

// Preview durante o arraste do slider: muda a camada sem gerar stroke.
export function setLayerOpacityLive(doc, index, opacity) {
  const layer = doc.frames[doc.frame].layers[index];
  if (!layer) return false;
  layer.opacity = clamp01(opacity);
  touch(doc);
  return true;
}

// Commit no fim do arraste: o `before` é o valor no início do arraste (a UI passa),
// para o undo voltar ao valor original e não ao último preview. O preview já escreveu o
// valor no estado, então a comparação é com a ORIGEM do arraste — se o arraste não mudou
// nada líquido, nada é empilhado.
export function setLayerOpacity(doc, index, opacity, before = null) {
  const layer = doc.frames[doc.frame].layers[index];
  if (!layer) return false;
  const next = clamp01(opacity);
  const origin = before ?? layer.opacity;
  if (next === origin) return false;
  layer.opacity = next;
  const stroke = { kind: 'prop', label: 'opacidade', frame: doc.frame, layer: index, field: 'opacity', before: origin, after: next, opId: ++opSeq };
  pushOp(doc, stroke);
  touch(doc);
  return true;
}

// --- frames ---

// Inserção de um frame novo logo depois de `at`, que passa a ser o ativo (as ferramentas
// precisam de um alvo válido). O stroke guarda a REFERÊNCIA ao frame criado: desfazer
// remove o frame (a ref é o único dono, então o buffer fica coletável), refazer reinsere o
// MESMO objeto com os pixels que foram editados nele.
function insertNewFrame(doc, frameObj, at, label) {
  insertFrameAt(doc, at, frameObj, null);
  doc.frame = at;
  clampActiveLayer(doc);
  pushOp(doc, { kind: 'frame-add', label, frame: at, index: at, frameObj, opId: ++opSeq });
  touch(doc);
  return frameObj;
}

export function addFrame(doc, { name = null, duplicate = false } = {}) {
  const source = doc.frames[doc.frame];
  const frameObj = makeFrame(name ?? `Frame ${doc.frames.length + 1}`, doc.width, doc.height, source, duplicate);
  return insertNewFrame(doc, frameObj, doc.frame + 1, duplicate ? 'frame duplicado' : 'frame novo');
}

// Cópia de um frame existente (pixels copiados, mesma estrutura de camadas), inserido
// depois dele. `duplicate = true` é a única via que copia buffers — é conteúdo do doc.
export function duplicateFrame(doc, index = doc.frame) {
  const source = doc.frames[index];
  if (!source) return null;
  const frameObj = makeFrame(source.name, doc.width, doc.height, source, true);
  return insertNewFrame(doc, frameObj, index + 1, 'frame duplicado');
}

// Seleção do frame ativo: não entra no histórico (estado de edição, como selectLayer), mas
// notifica o render. clampActiveLayer porque frames podem ter nº de camadas diferente — o
// doc.layer não pode apontar para uma camada que não existe no frame ativo.
export function selectFrame(doc, index) {
  const i = Math.max(0, Math.min(Math.floor(index), doc.frames.length - 1));
  if (!doc.frames[i] || i === doc.frame) return false;
  doc.frame = i;
  clampActiveLayer(doc);
  touch(doc);
  return true;
}

export function removeFrame(doc, index = doc.frame) {
  const stroke = { kind: 'frame-remove', label: 'frame removido', frame: index, frameObj: null, opId: ++opSeq };
  const frame = deleteFrameAt(doc, index, stroke, stroke.opId);
  if (!frame) return null;
  stroke.frameObj = frame;
  pushOp(doc, stroke);
  touch(doc);
  return frame;
}

// --- undo/redo: dispatch por kind ---

function applyDiff(doc, stroke, field) {
  const p = doc.frames[stroke.frame]?.layers[stroke.layer]?.pixels;
  if (!p) return false;
  const bytes = stroke[field];
  for (let k = 0; k < stroke.index.length; k++) {
    const i = stroke.index[k];
    if (i + 4 > p.length) continue; // buffer menor que o diff (doc redimensionado)
    p[i] = bytes[k * 4];
    p[i + 1] = bytes[k * 4 + 1];
    p[i + 2] = bytes[k * 4 + 2];
    p[i + 3] = bytes[k * 4 + 3];
  }
  return true;
}

// `undoing` = true desfaz (vai para o estado anterior), false refaz.
// Strokes "mortos" só andam na pilha sem alterar nada (a pilha continua andando).
function applyStroke(doc, stroke, undoing) {
  if (stroke.dead) return true;
  switch (stroke.kind) {
    case 'add':
      // desfazer = remover a camada criada; refazer = reinserir o MESMO objeto
      if (undoing) deleteLayerAt(doc, stroke.frame, stroke.index, stroke, stroke.opId);
      else {
        insertLayerAt(doc, stroke.frame, stroke.index, stroke.layer, stroke);
        reviveStrokes(doc, stroke.opId);
      }
      return true;
    case 'remove':
      // desfazer = reinserir o objeto guardado (buffer intacto); refazer = remover de novo
      if (undoing) {
        insertLayerAt(doc, stroke.frame, stroke.index, stroke.layer, stroke);
        reviveStrokes(doc, stroke.opId);
      } else deleteLayerAt(doc, stroke.frame, stroke.index, stroke, stroke.opId);
      return true;
    case 'move':
      return moveLayerCore(doc, stroke.frame, undoing ? stroke.to : stroke.from, undoing ? stroke.from : stroke.to, stroke);
    case 'prop': {
      const layer = doc.frames[stroke.frame]?.layers[stroke.layer];
      if (!layer) return true; // camada não existe mais → nada a fazer
      layer[stroke.field] = undoing ? stroke.before : stroke.after;
      return true;
    }
    case 'frame-add':
      // desfazer = remover o frame criado; refazer = reinserir o MESMO objeto (pixels intactos)
      if (undoing) deleteFrameAt(doc, stroke.index, stroke, stroke.opId);
      else {
        insertFrameAt(doc, stroke.index, stroke.frameObj, stroke);
        doc.frame = stroke.index; // o frame recriado volta como o ativo
        clampActiveLayer(doc);
        reviveStrokes(doc, stroke.opId);
      }
      return true;
    case 'frame-remove':
      if (undoing) {
        insertFrameAt(doc, stroke.frame, stroke.frameObj, stroke);
        reviveStrokes(doc, stroke.opId);
      } else deleteFrameAt(doc, stroke.frame, stroke, stroke.opId);
      return true;
    default: // pixel
      applyDiff(doc, stroke, undoing ? 'before' : 'after');
      return true;
  }
}

export function undo(doc) {
  const stroke = doc.history.pop();
  if (!stroke) return false;
  applyStroke(doc, stroke, true);
  pushCapped(doc.future, stroke, doc.historyLimit);
  touch(doc);
  return true;
}

export function redo(doc) {
  const stroke = doc.future.pop(); // o último que foi desfeito é o próximo a refazer
  if (!stroke) return false;
  applyStroke(doc, stroke, false);
  pushCapped(doc.history, stroke, doc.historyLimit);
  touch(doc);
  return true;
}

// Salto para um ponto da pilha: `back` undo's e `fwd` redo's, um de cada vez. Usar
// contagens (não profundidade) porque com o limite N o histórico não cresce além de N.
export function jumpTo(doc, { back = 0, fwd = 0 } = {}) {
  for (let k = Math.max(0, Math.floor(back)); k > 0; k--) if (!undo(doc)) break;
  for (let k = Math.max(0, Math.floor(fwd)); k > 0; k--) if (!redo(doc)) break;
  return doc.history.length;
}

// Novo limite N: entradas além de N caem do histórico e do futuro (mais antigas primeiro).
export function setHistoryLimit(doc, limit) {
  doc.historyLimit = normalizeLimit(limit);
  while (doc.history.length > doc.historyLimit) releaseStroke(doc.history.shift());
  while (doc.future.length > doc.historyLimit) releaseStroke(doc.future.shift());
  touch(doc);
  return doc.historyLimit;
}

// Texto para a UI: kinds estruturais resumem a operação; pixel resume n px do diff.
export function strokeSummary(doc, stroke) {
  if (stroke.dead) return `${stroke.label} · morta`;
  const frameName = doc.frames[stroke.frame]?.name ?? `frame ${stroke.frame}`;
  switch (stroke.kind) {
    case 'add':
    case 'remove':
      return `${stroke.label} · ${frameName} · ${stroke.layer?.name ?? 'camada'}`;
    case 'move':
      return `${stroke.label} · ${frameName} · ${doc.frames[stroke.frame]?.layers[stroke.to]?.name ?? 'camada'}`;
    case 'prop': {
      const name = doc.frames[stroke.frame]?.layers[stroke.layer]?.name ?? `camada ${stroke.layer}`;
      const value = stroke.field === 'opacity' ? ` · ${Math.round(stroke.after * 100)}%` : '';
      return `${stroke.label} · ${frameName}/${name}${value}`;
    }
    case 'frame-add':
    case 'frame-remove':
      return `${stroke.label} · ${stroke.frameObj?.name ?? `frame ${stroke.frame}`} · ${stroke.frameObj?.layers.length ?? 0} camadas`;
    default: {
      const layerName = doc.frames[stroke.frame]?.layers[stroke.layer]?.name ?? `camada ${stroke.layer}`;
      return `${stroke.label} · ${frameName}/${layerName} · ${stroke.index.length} px`;
    }
  }
}
