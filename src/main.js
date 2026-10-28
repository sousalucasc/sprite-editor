// src/main.js — liga estado, canvas e ferramentas. UI mínima.
import { createDoc, undo, redo, onChange, strokeSummary } from './state.js';
import { createRenderer } from './canvas.js';
import { createPencil } from './pencil.js';
import { createFloatingToolbar } from './toolbar.js';
import { createLayout } from './layout.js';
import { createHistoryWindow } from './history.js';
import { createLayersWindow } from './layers.js';
import { createTimelineWindow, createPlayback, DEFAULT_FPS } from './timeline.js';
import { createExportWindow } from './export.js';
import { createColorStore, createColorWindow } from './tools/color.js';
import { createEraser, createEraserWindow } from './tools/eraser.js';
import { createBucket, createBucketWindow } from './tools/bucket.js';
import { createDropper, createDropperWindow } from './tools/dropper.js';

const doc = createDoc({ width: 32, height: 32 });
const ui = {
  toolbar: document.querySelector('.toolbar'),
  stage: document.querySelector('#stage'),
  pencil: document.querySelector('#tool-pencil'),
  eraser: document.querySelector('#tool-eraser'),
  bucket: document.querySelector('#tool-bucket'),
  dropper: document.querySelector('#tool-dropper'),
  winColor: document.querySelector('#win-color'),
  winHistory: document.querySelector('#win-history'),
  winLayers: document.querySelector('#win-layers'),
  winTimeline: document.querySelector('#win-timeline'),
  winExport: document.querySelector('#win-export'),
  play: document.querySelector('#play'),
  fps: document.querySelector('#fps'),
  undo: document.querySelector('#undo'),
  redo: document.querySelector('#redo'),
  hist: document.querySelector('#hist'),
  zoom: document.querySelector('#zoom'),
  frame: document.querySelector('#frame'),
};

function updateZoom(v) {
  const pct = Math.round((v.scale * 100) / (window.devicePixelRatio || 1));
  ui.zoom.textContent = `${pct}%`;
  ui.zoom.title = `Zoom ${pct}%`;
}

// `layout` nasce depois do renderer (o layout precisa do rect do sprite), então o fit
// inicial roda sem obstáculos e é refeito quando os painéis abrem (ver `onChange`).
let layout = null;

const view = createRenderer(ui.stage, doc, {
  onChangeView: updateZoom,
  fitObstacles: () => layout?.obstacles() ?? [],
});

// Layout de spawn: o retângulo do sprite na tela (view está em device px → divide pelo
// dpr) é obstáculo, junto com a toolbar e os painéis abertos. Cada painel tem um lado
// preferido; o layout empilha nas faixas livres sem sobrepor nada (src/layout.js).
// `onChange` reajusta o fit: painel que abre/fecha/muda de altura libera ou toma espaço,
// e o sprite cresce até o maior retângulo livre (sem nunca ficar sob a UI).
layout = createLayout({
  toolbarEl: ui.toolbar,
  spriteRect: () => {
    const dpr = window.devicePixelRatio || 1;
    const { tx, ty, scale } = view.view;
    return { x: tx / dpr, y: ty / dpr, width: doc.width * scale / dpr, height: doc.height * scale / dpr };
  },
  onChange: () => view.refit(),
});
const spawnSide = (side) => (el) => layout.spawn(el, side);

// Cor compartilhada: lápis aplica via subscribe; balde lê rgba() no clique; conta-gotas
// escreve no store (se a opção estiver ligada) e o lápis recebe pelo mesmo subscribe.
const color = createColorStore({ hex: '#ffffff', alpha: 1 });
const pencil = createPencil(doc);
const eraser = createEraser(doc);
const bucket = createBucket(doc, color);
const dropper = createDropper(doc, color);
color.subscribe(() => pencil.setColor(color.rgba()));

view.setTool(pencil);

const toolbar = createFloatingToolbar(ui.toolbar);

// Painel do histórico: lista os strokes (diffs) e permite saltar para qualquer ponto.
const history = createHistoryWindow(doc, {
  getPos: spawnSide('right'),
  onOpen: () => ui.winHistory.setAttribute('aria-pressed', 'true'),
  onClose: () => ui.winHistory.setAttribute('aria-pressed', 'false'),
});
history.open();

ui.winHistory.addEventListener('click', () => {
  if (history.isOpen()) history.close();
  else history.open();
});

// Painel de camadas: criar/remover/reordenar/ocultar/opacidade; as ops entram no
// histórico como strokes estruturais (undo integrado via src/state.js).
const layers = createLayersWindow(doc, {
  getPos: spawnSide('right'),
  onOpen: () => ui.winLayers.setAttribute('aria-pressed', 'true'),
  onClose: () => ui.winLayers.setAttribute('aria-pressed', 'false'),
});
layers.open();

ui.winLayers.addEventListener('click', () => {
  if (layers.isOpen()) layers.close();
  else layers.open();
});

// Playback da animação: controller fora do estado (não muta pixels, só move doc.frame).
// A janela da timeline empresta os controles; a toolbar se assina no controller para o
// botão e o readout de FPS ficarem sincronizados com o painel.
const playback = createPlayback(doc, { fps: DEFAULT_FPS });

const timeline = createTimelineWindow(doc, playback, view, {
  getPos: spawnSide('bottom'),
  onOpen: () => ui.winTimeline.setAttribute('aria-pressed', 'true'),
  onClose: () => ui.winTimeline.setAttribute('aria-pressed', 'false'),
});
timeline.open();

ui.winTimeline.addEventListener('click', () => {
  if (timeline.isOpen()) timeline.close();
  else timeline.open();
});

const stopPlaybackSubscription = playback.subscribe((state) => {
  ui.play.setAttribute('aria-pressed', String(state.playing));
  ui.play.title = state.playing ? 'Parar playback (A)' : 'Playback da animação (A)';
  ui.fps.textContent = `${state.fps} fps`;
  ui.fps.title = `Playback a ${state.fps} fps`;
});
ui.play.addEventListener('click', () => playback.toggle());

// Exportar: PNG do frame atual, spritesheet de todos os frames, GIF animado no ritmo do
// playback, e save/load do projeto em JSON. O save/load funciona com a janela fechada
// (Ctrl+S / Ctrl+O), por isso as funções são expostas pelo módulo, não só pela UI.
const exporter = createExportWindow(doc, view, playback, {
  getPos: spawnSide('right'),
  onOpen: () => ui.winExport.setAttribute('aria-pressed', 'true'),
  onClose: () => ui.winExport.setAttribute('aria-pressed', 'false'),
});

ui.winExport.addEventListener('click', () => {
  if (exporter.win.isOpen()) exporter.win.close();
  else exporter.win.open();
});

// Pintar com o playback rodando trocaria o frame sob o traço: parar antes do pointerdown
// chegar na ferramenta (fase de captura no document, antes do listener do canvas).
document.addEventListener(
  'pointerdown',
  (ev) => {
    if (ev.target === ui.stage) playback.stop();
  },
  { capture: true }
);

// Janelas de opções das ferramentas (nível 1, sistema do passo 1.5/2): só a janela da
// ferramenta ativa fica aberta; todas têm lado preferido à esquerda (abaixo da toolbar,
// empilhadas pelo layout — abrem uma por vez, então nunca se sobrepõem).
const tools = { pencil, eraser, bucket, dropper };
const toolButtons = { pencil: ui.pencil, eraser: ui.eraser, bucket: ui.bucket, dropper: ui.dropper };
const optionWindows = {
  pencil: null, // lápis não tem janela própria: usa a cor do seletor
  eraser: createEraserWindow(eraser, { getPos: spawnSide('left') }),
  bucket: createBucketWindow(bucket, { getPos: spawnSide('left') }),
  dropper: createDropperWindow(dropper, { getPos: spawnSide('left') }),
};

const colorWin = createColorWindow(color, {
  getPos: spawnSide('right'),
  onOpen: () => ui.winColor.setAttribute('aria-pressed', 'true'),
  onClose: () => ui.winColor.setAttribute('aria-pressed', 'false'),
});

let activeTool = 'pencil';

function selectTool(id) {
  activeTool = id;
  view.setTool(tools[id]);
  for (const [t, btn] of Object.entries(toolButtons)) btn.setAttribute('aria-pressed', String(t === id));
  for (const [t, win] of Object.entries(optionWindows)) {
    if (!win) continue;
    if (t === id) win.open();
    else win.close(); // trocar de ferramenta fecha as janelas das outras
  }
}

function toggleTool(id) {
  if (activeTool !== id) {
    selectTool(id);
    return;
  }
  const win = optionWindows[id];
  if (!win) return;
  if (win.isOpen()) win.close();
  else win.open();
}

for (const [id, btn] of Object.entries(toolButtons)) {
  btn.addEventListener('click', () => toggleTool(id));
}

ui.winColor.addEventListener('click', () => {
  if (colorWin.isOpen()) colorWin.close();
  else colorWin.open();
});

// Undo/redo durante um traço ativo corromperia o diff (o `before` do stroke ficaria
// de um estado que o undo já mudou). Enquanto o botão está pressionado, ignoramos.
function undoBlocked() {
  return view.isDrawing();
}

ui.undo.addEventListener('click', () => { if (!undoBlocked()) undo(doc); });
ui.redo.addEventListener('click', () => { if (!undoBlocked()) redo(doc); });

const stopDocSubscription = onChange(doc, () => {
  const nextUndo = doc.history.at(-1);
  const nextRedo = doc.future.at(-1); // o último que foi desfeito é o próximo a refazer
  ui.undo.disabled = !nextUndo;
  ui.redo.disabled = !nextRedo;
  ui.undo.title = nextUndo ? `Desfazer: ${strokeSummary(doc, nextUndo)}` : 'Ctrl+Z';
  ui.redo.title = nextRedo ? `Refazer: ${strokeSummary(doc, nextRedo)}` : 'Ctrl+Shift+Z';
  ui.hist.textContent = `${doc.history.length}/${doc.historyLimit}`;
  ui.hist.title = `Histórico: ${doc.history.length} de ${doc.historyLimit} strokes`;
  ui.frame.textContent = `${doc.frames.length} frame${doc.frames.length > 1 ? 's' : ''} · ` +
    `${doc.frame + 1}/${doc.frames.length} · ${doc.width}×${doc.height}`;
  ui.frame.title = `Frame ${doc.frame + 1} de ${doc.frames.length} · ${doc.width}×${doc.height}`;
});

window.addEventListener('keydown', (ev) => {
  if (ev.target instanceof HTMLInputElement) return;
  const key = ev.key.toLowerCase();
  if ((ev.ctrlKey || ev.metaKey) && key === 'z') {
    ev.preventDefault();
    if (undoBlocked()) return;
    if (ev.shiftKey) redo(doc);
    else undo(doc);
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && key === 'y') {
    ev.preventDefault();
    if (undoBlocked()) return;
    redo(doc);
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && key === 'h') {
    ev.preventDefault();
    if (history.isOpen()) history.close();
    else history.open();
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && key === 's') {
    ev.preventDefault(); // sem isso o navegador abre o diálogo "salvar página"
    exporter.saveJSON();
    return;
  }
  if ((ev.ctrlKey || ev.metaKey) && key === 'o') {
    ev.preventDefault();
    exporter.openJSON();
    return;
  }
  if (ev.ctrlKey || ev.metaKey) return; // as ferramentas só com tecla limpa
  if (key === 'p') toggleTool('pencil');
  else if (key === 'e') toggleTool('eraser');
  else if (key === 'b') toggleTool('bucket');
  else if (key === 'i') toggleTool('dropper');
  else if (key === 'c') {
    if (colorWin.isOpen()) colorWin.close();
    else colorWin.open();
  }
  else if (key === 'l') {
    if (layers.isOpen()) layers.close();
    else layers.open();
  }
  else if (key === 't') {
    if (timeline.isOpen()) timeline.close();
    else timeline.open();
  }
  else if (key === 'x') {
    if (exporter.win.isOpen()) exporter.win.close();
    else exporter.win.open();
  }
  else if (key === 'a') {
    playback.toggle();
  }
});

window.addEventListener('pagehide', () => {
  view.destroy();
  toolbar.destroy();
  layout.destroy();
  history.destroy();
  layers.destroy();
  timeline.destroy(); // fecha a janela → abort da signal → playback.stop()
  playback.destroy(); // garante rAF cancelado e assinaturas removidas
  exporter.destroy(); // libera timers de object URL e o input de arquivo
  for (const win of Object.values(optionWindows)) win?.destroy();
  colorWin.destroy();
  stopDocSubscription();
  stopPlaybackSubscription();
});

ui.undo.disabled = true;
ui.redo.disabled = true;
ui.hist.textContent = `0/${doc.historyLimit}`;
ui.hist.title = `Histórico: 0 de ${doc.historyLimit} strokes`;
updateZoom(view.view);
ui.frame.textContent = `1 frame · 1/1 · ${doc.width}×${doc.height}`;
ui.frame.title = `Frame 1 de 1 · ${doc.width}×${doc.height}`;
ui.fps.textContent = `${playback.fps()} fps`;
ui.fps.title = `Playback a ${playback.fps()} fps`;
ui.play.title = 'Playback da animação (A)';
