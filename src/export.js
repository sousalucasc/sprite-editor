// src/export.js — exportar PNG (frame atual), spritesheet (todos os frames) e GIF animado,
// e salvar/abrir o projeto como JSON local. Composição sempre via view.composeInto: é a
// mesma fórmula de blend do render, então o export não diverge do que está na tela.
// Regra do AGENTS.md: listeners do corpo usam `win.signal`; o input de arquivo vive numa
// AbortController própria (as funções funcionam com a janela fechada) e é abortado no destroy.
import { createWindow } from './windows.js';
import { onChange, importDoc } from './state.js';
import { toJSON, parseDocJSON } from './serialize.js';
import { encodeGif, MAX_GIF_SCALE } from './gif.js';

const SCALE_MIN = 1;

const baseName = (doc) => `aseclone-${doc.width}x${doc.height}`;

export function createExportWindow(doc, view, playback, { x = 12, y = 100, onOpen, onClose } = {}) {
  let scale = 1;
  let readout = null; // só existe enquanto a janela está aberta
  const life = new AbortController(); // input de arquivo + timers de object URL
  const timers = [];

  function setStatus(text) {
    if (readout) readout.textContent = text;
  }

  function revokeLater(url) {
    // o download já foi disparado; liberar no próximo tick não corta o blob em trânsito
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      const k = timers.indexOf(timer);
      if (k !== -1) timers.splice(k, 1);
    }, 1500);
    timers.push(timer);
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    revokeLater(url);
    setStatus(`salvo ${filename} · ${(blob.size / 1024).toFixed(1)} KB`);
  }

  function composeBuffer(frameIndex) {
    const buffer = new Uint8ClampedArray(doc.width * doc.height * 4);
    view.composeInto(buffer, frameIndex);
    return buffer;
  }

  function canvasOf(buffer, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(buffer, width, height), 0, 0);
    return canvas;
  }

  // Ampliação nearest neighbour: pixel art não deve ficar borrada pelo smoothing.
  function scaleCanvas(canvas, s) {
    if (s <= 1) return canvas;
    const big = document.createElement('canvas');
    big.width = canvas.width * s;
    big.height = canvas.height * s;
    const ctx = big.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, 0, 0, big.width, big.height);
    return big;
  }

  function pngBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('toBlob não devolveu blob'));
      }, 'image/png');
    });
  }

  async function run(label, fn) {
    try {
      await fn();
    } catch (error) {
      setStatus(`${label}: ${error.message}`);
    }
  }

  const suffix = () => (scale > 1 ? `@${scale}x` : '');

  function exportPNG() {
    return run('PNG', async () => {
      const canvas = scaleCanvas(canvasOf(composeBuffer(doc.frame), doc.width, doc.height), scale);
      download(await pngBlob(canvas), `${baseName(doc)}-frame${doc.frame + 1}${suffix()}.png`);
    });
  }

  function exportSheet() {
    return run('spritesheet', async () => {
      const cellW = doc.width * scale;
      const cellH = doc.height * scale;
      const canvas = document.createElement('canvas');
      canvas.width = cellW * doc.frames.length;
      canvas.height = cellH;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      for (let i = 0; i < doc.frames.length; i++) {
        ctx.drawImage(scaleCanvas(canvasOf(composeBuffer(i), doc.width, doc.height), scale), i * cellW, 0);
      }
      download(await pngBlob(canvas), `${baseName(doc)}-sheet-${doc.frames.length}f${suffix()}.png`);
    });
  }

  function exportGIF() {
    return run('GIF', async () => {
      const images = doc.frames.map((_, i) => composeBuffer(i));
      const fps = playback.fps();
      const bytes = encodeGif(images, { width: doc.width, height: doc.height, scale, delayMs: 1000 / fps });
      download(new Blob([bytes], { type: 'image/gif' }), `${baseName(doc)}-${doc.frames.length}f-${fps}fps${suffix()}.gif`);
    });
  }

  function saveJSON() {
    return run('JSON', async () => {
      download(new Blob([toJSON(doc)], { type: 'application/json' }), `${baseName(doc)}.json`);
    });
  }

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.hidden = true;
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = ''; // permite abrir o mesmo arquivo duas vezes
    if (!file) return;
    if (view.isDrawing()) {
      setStatus('não dá pra abrir o projeto com um traço em andamento');
      return;
    }
    try {
      const parsed = parseDocJSON(await file.text());
      playback.stop(); // o playback troca doc.frame no rAF: parar antes de substituir os frames
      importDoc(doc, parsed);
      view.fit(); // tamanho novo: reenquadra o zoom do doc importado
      setStatus(`aberto ${file.name} · ${doc.frames.length} frame(s) · ${doc.width}×${doc.height}`);
    } catch (error) {
      setStatus(`JSON inválido: ${error.message}`);
    }
  }, { signal: life.signal });

  function openJSON() {
    fileInput.click();
  }

  function setScale(next) {
    scale = Number.isFinite(next) ? Math.max(SCALE_MIN, Math.min(MAX_GIF_SCALE, Math.floor(next))) : 1;
  }

  function build(body, win) {
    readout = document.createElement('p');
    readout.className = 'window-note';

    const actions = document.createElement('div');
    actions.className = 'tl-controls';
    const pngBtn = document.createElement('button');
    pngBtn.textContent = 'PNG';
    pngBtn.title = 'Exportar o frame atual como PNG (alfa preservado)';
    const sheetBtn = document.createElement('button');
    sheetBtn.textContent = 'Sheet';
    sheetBtn.title = 'Spritesheet PNG: todos os frames lado a lado';
    const gifBtn = document.createElement('button');
    gifBtn.textContent = 'GIF';
    gifBtn.title = 'GIF animado no ritmo do playback (transparência de 1 bit)';
    const jsonBtn = document.createElement('button');
    jsonBtn.textContent = 'Salvar';
    jsonBtn.title = 'Salvar o projeto como JSON (Ctrl+S)';
    const openBtn = document.createElement('button');
    openBtn.textContent = 'Abrir';
    openBtn.title = 'Abrir um projeto JSON (Ctrl+O)';
    actions.append(pngBtn, sheetBtn, gifBtn, jsonBtn, openBtn);

    const scaleInput = document.createElement('input');
    scaleInput.type = 'range';
    scaleInput.min = String(SCALE_MIN);
    scaleInput.max = String(MAX_GIF_SCALE);
    scaleInput.step = '1';
    scaleInput.value = String(scale);
    scaleInput.title = 'Escala de exportação (nearest neighbour)';
    const scaleVal = document.createElement('span');
    scaleVal.className = 'tl-val';
    const scaleRow = document.createElement('label');
    scaleRow.className = 'option-row';
    scaleRow.append(scaleInput, scaleVal);
    scaleInput.addEventListener('input', () => {
      setScale(Number(scaleInput.value));
      scaleVal.textContent = `${scale}x`;
      render(); // a nota mostra a escala e o estado do botão GIF
    }, { signal: win.signal });

    const sep = document.createElement('div');
    sep.className = 'window-sep';

    body.append(readout, actions, scaleRow, sep, fileInput);

    pngBtn.addEventListener('click', exportPNG, { signal: win.signal });
    sheetBtn.addEventListener('click', exportSheet, { signal: win.signal });
    gifBtn.addEventListener('click', exportGIF, { signal: win.signal });
    jsonBtn.addEventListener('click', saveJSON, { signal: win.signal });
    openBtn.addEventListener('click', openJSON, { signal: win.signal });

    function render() {
      const fps = playback.fps();
      const hint = doc.frames.length < 2 ? ' · GIF precisa de 2+ frames' : '';
      readout.textContent =
        `${doc.width}×${doc.height} · ${doc.frames.length} frame(s) · frame ativo ${doc.frame + 1} · ` +
        `GIF a ${fps} fps · escala ${scale}x${hint}`;
      if (document.activeElement !== scaleInput) scaleInput.value = String(scale);
      scaleVal.textContent = `${scale}x`;
      gifBtn.disabled = doc.frames.length < 2;
    }

    const unsubscribe = onChange(doc, render);
    win.signal.addEventListener('abort', () => {
      unsubscribe();
      readout = null; // o corpo foi destruído: setStatus vira no-op
    });
    render();
  }

  const win = createWindow({ title: 'Exportar', x, y, onBody: build, onOpen, onClose });

  return {
    win,
    exportPNG,
    exportSheet,
    exportGIF,
    saveJSON,
    openJSON,
    setScale,
    destroy() {
      win.destroy();
      life.abort();
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
      fileInput.remove();
    },
  };
}
