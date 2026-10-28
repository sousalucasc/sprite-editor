// src/timeline.js — timeline de frames + playback da animação + onion skin (controles).
// Frames: novo, duplicar, remover, selecionar — tudo pela API de src/state.js, então cada
// operação entra no undo e o buffer do frame removido fica coletável quando o stroke
// estrutural morre (limite N ou futuro invalidado).
// Playback vive FORA do estado: não muta pixels, só move doc.frame. O controller é criado
// em main.js e emprestado para a janela; fechar a janela para o playback (cancela o rAF) e
// destroy() limpa as assinaturas — nada de loop/timer órfão.
import { createWindow } from './windows.js';
import { onChange, addFrame, duplicateFrame, removeFrame, selectFrame } from './state.js';

export const DEFAULT_FPS = 12;
const MIN_FPS = 1;
const MAX_FPS = 60;
const MAX_WAIT_MS = 500; // pausa do rAF (aba oculta): não acumula espera indefinida

const clampInt = (v, min, max) =>
  Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : min;

export function normalizeFps(v) {
  return clampInt(v, MIN_FPS, MAX_FPS);
}

export function createPlayback(doc, { fps = DEFAULT_FPS } = {}) {
  let rate = normalizeFps(fps);
  let raf = 0;
  let acc = 0;
  let last = 0;
  const listeners = new Set();

  function notify() {
    const state = { playing: raf !== 0, fps: rate };
    for (const fn of listeners) {
      try {
        fn(state);
      } catch (error) {
        console.error('aseclone: listener de playback falhou', error);
      }
    }
  }

  // O rAF é mais rápido que o FPS, então o passo é disparado por acumulador de tempo:
  // um passo por 1000/fps ms, no ritmo escolhido, independentemente da taxa do rAF.
  function tick(now) {
    raf = requestAnimationFrame(tick);
    acc += Math.min(now - last, MAX_WAIT_MS);
    last = now;
    const step = 1000 / rate;
    while (acc >= step) {
      acc -= step;
      const n = doc.frames.length;
      if (n < 2) {
        stop(); // um frame não anima
        return;
      }
      selectFrame(doc, (doc.frame + 1) % n); // animação cíclica
    }
  }

  function start() {
    if (raf) return false;
    if (doc.frames.length < 2) return false;
    acc = 0;
    last = performance.now();
    raf = requestAnimationFrame(tick);
    notify();
    return true;
  }

  function stop() {
    if (!raf) return false;
    cancelAnimationFrame(raf);
    raf = 0;
    acc = 0;
    notify();
    return true;
  }

  function toggle() {
    return raf ? stop() : start();
  }

  function setFps(next) {
    const v = normalizeFps(next);
    if (v === rate) return false;
    rate = v;
    if (raf) {
      acc = 0;
      last = performance.now(); // troca o ritmo sem disparar os passos acumulados de uma vez
    }
    notify();
    return true;
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return {
    fps: () => rate,
    setFps,
    start,
    stop,
    toggle,
    isPlaying: () => raf !== 0,
    subscribe,
    destroy() {
      stop();
      listeners.clear();
    },
  };
}

// A janela é só a UI: o estado do playback está no controller, o do onion está no render
// (view), então fechar/reabrir a janela não perde nada essencial.
export function createTimelineWindow(doc, playback, view, { x = 12, y = window.innerHeight - 240, getPos, onOpen, onClose } = {}) {
  function build(body, win) {
    const note = document.createElement('p');
    note.className = 'window-note';

    const controls = document.createElement('div');
    controls.className = 'tl-actions';

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = 'Novo frame';
    addBtn.title = 'Novo frame vazio (herda as camadas do frame ativo)';

    const dupBtn = document.createElement('button');
    dupBtn.type = 'button';
    dupBtn.textContent = 'Duplicar';
    dupBtn.title = 'Duplicar o frame ativo (copia os pixels)';

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'tl-play';
    playBtn.textContent = '▶';
    playBtn.setAttribute('aria-pressed', 'false');
    playBtn.title = 'Playback da animação (A)';
    playBtn.setAttribute('aria-label', 'Tocar a animação');

    const fpsInput = document.createElement('input');
    fpsInput.type = 'range';
    fpsInput.min = String(MIN_FPS);
    fpsInput.max = String(MAX_FPS);
    fpsInput.step = '1';
    fpsInput.className = 'tl-range';
    fpsInput.title = 'FPS do playback';
    const fpsVal = document.createElement('span');
    fpsVal.className = 'tl-val';

    const fpsLabel = document.createElement('span');
    fpsLabel.className = 'field-label';
    fpsLabel.textContent = 'FPS';
    const fpsRow = document.createElement('label');
    fpsRow.className = 'tl-row';
    fpsRow.append(fpsLabel, fpsInput, fpsVal);

    controls.append(addBtn, dupBtn, playBtn);

    // Onion skin: os vizinhos do frame ativo, tingidos (anterior quente, próximo frio).
    const onionToggle = document.createElement('label');
    onionToggle.className = 'tl-toggle';
    const onionCheck = document.createElement('input');
    onionCheck.type = 'checkbox';
    onionCheck.title = 'Onion skin (frames vizinhos)';
    const onionLabel = document.createElement('span');
    onionLabel.textContent = 'Onion skin';
    onionToggle.append(onionCheck, onionLabel);

    const onionBox = document.createElement('div');
    onionBox.className = 'tl-onion';
    const ghostCount = document.createElement('input');
    ghostCount.type = 'range';
    ghostCount.min = '1';
    ghostCount.max = '3';
    ghostCount.step = '1';
    ghostCount.className = 'tl-range';
    ghostCount.title = 'Frames fantasma (anterior e próximo)';
    const ghostVal = document.createElement('span');
    ghostVal.className = 'tl-val';
    const ghostRow = document.createElement('label');
    ghostRow.className = 'tl-row';
    const ghostLabel = document.createElement('span');
    ghostLabel.className = 'field-label';
    ghostLabel.textContent = 'Fantasmas';
    ghostRow.append(ghostLabel, ghostCount, ghostVal);

    const ghostOpacity = document.createElement('input');
    ghostOpacity.type = 'range';
    ghostOpacity.min = '0';
    ghostOpacity.max = '1';
    ghostOpacity.step = '0.05';
    ghostOpacity.className = 'tl-range';
    ghostOpacity.title = 'Opacidade do ghost';
    const ghostOpacityVal = document.createElement('span');
    ghostOpacityVal.className = 'tl-val';
    const opacityRow = document.createElement('label');
    opacityRow.className = 'tl-row';
    const opacityLabel = document.createElement('span');
    opacityLabel.className = 'field-label';
    opacityLabel.textContent = 'Opacidade';
    opacityRow.append(opacityLabel, ghostOpacity, ghostOpacityVal);

    onionBox.append(ghostRow, opacityRow);

    const list = document.createElement('div');
    list.className = 'frame-list';

    body.append(note, controls, fpsRow, onionToggle, onionBox, list);

    function applyOnion() {
      view.setOnion({
        enabled: onionCheck.checked,
        count: Number(ghostCount.value),
        opacity: Number(ghostOpacity.value),
      });
    }

    function syncOnion() {
      const on = onionCheck.checked;
      onionBox.classList.toggle('is-off', !on);
      ghostCount.disabled = !on;
      ghostOpacity.disabled = !on;
      applyOnion();
    }

    addBtn.addEventListener('click', () => addFrame(doc), { signal: win.signal });
    dupBtn.addEventListener('click', () => duplicateFrame(doc), { signal: win.signal });
    playBtn.addEventListener('click', () => playback.toggle(), { signal: win.signal });
    fpsInput.addEventListener(
      'input',
      () => playback.setFps(Number(fpsInput.value)),
      { signal: win.signal }
    );
    for (const el of [ghostCount, ghostOpacity]) {
      el.addEventListener(
        'input',
        () => {
          applyOnion();
          ghostVal.textContent = String(view.onion().count);
          ghostOpacityVal.textContent = `${Math.round(view.onion().opacity * 100)}%`;
        },
        { signal: win.signal }
      );
    }
    onionCheck.addEventListener('change', syncOnion, { signal: win.signal });

    let rows = [];
    let count = -1; // nº de frames; muda só quando a lista precisa ser reconstruída
    let lastFrames = null; // identidade do array: um import troca os frames todos (as linhas antigas ficam órfãs)
    let rowLife = new AbortController(); // listeners das linhas; abortado a cada rebuild
    win.signal.addEventListener('abort', () => rowLife.abort());

    function makeRow(frame) {
      const row = document.createElement('div');
      row.className = 'frame-row';
      row.frame = frame;
      row.addEventListener(
        'click',
        (ev) => {
          if (ev.target.closest('button, input')) return; // o botão × faz a própria op
          const i = doc.frames.indexOf(row.frame);
          if (i !== -1) selectFrame(doc, i);
        },
        { signal: rowLife.signal }
      );

      const num = document.createElement('span');
      num.className = 'frame-idx';

      const name = document.createElement('span');
      name.className = 'frame-name';
      name.textContent = frame.name;

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'frame-del';
      del.textContent = '×';
      del.title = 'Remover frame';
      del.setAttribute('aria-label', 'Remover frame');
      del.addEventListener(
        'click',
        () => {
          const i = doc.frames.indexOf(row.frame);
          if (i !== -1) removeFrame(doc, i);
        },
        { signal: rowLife.signal }
      );

      row.append(num, name, del);
      row.num = num;
      row.del = del;
      return row;
    }

    function render() {
      const n = doc.frames.length;
      if (n !== count || lastFrames !== doc.frames) {
        count = n;
        lastFrames = doc.frames;
        rowLife.abort(); // libera os listeners das linhas antigas antes de recriar
        rowLife = new AbortController();
        rows = doc.frames.map((frame) => makeRow(frame));
      }
      list.textContent = '';
      for (const row of rows) {
        const i = doc.frames.indexOf(row.frame);
        if (i === -1) continue; // frame sumiu via undo antes deste render
        row.num.textContent = String(i + 1);
        row.classList.toggle('active', i === doc.frame);
        row.del.disabled = n <= 1; // o doc nunca fica sem frame
        list.append(row);
      }

      // o playback toca a cada passo: o readout é lido aqui, sem sobrescrever o arraste
      if (document.activeElement !== fpsInput) fpsInput.value = String(playback.fps());
      fpsVal.textContent = `${playback.fps()} fps`;
      const onionState = view.onion();
      if (document.activeElement !== onionCheck) onionCheck.checked = onionState.enabled;
      if (document.activeElement !== ghostCount) ghostCount.value = String(onionState.count);
      if (document.activeElement !== ghostOpacity) ghostOpacity.value = String(onionState.opacity);
      ghostVal.textContent = String(onionState.count);
      ghostOpacityVal.textContent = `${Math.round(onionState.opacity * 100)}%`;
      onionBox.classList.toggle('is-off', !onionState.enabled);
      ghostCount.disabled = !onionState.enabled;
      ghostOpacity.disabled = !onionState.enabled;

      playBtn.textContent = playback.isPlaying() ? '■' : '▶';
      playBtn.setAttribute('aria-pressed', String(playback.isPlaying()));
      playBtn.setAttribute('aria-label', playback.isPlaying() ? 'Parar a animação' : 'Tocar a animação');
      playBtn.title = playback.isPlaying() ? 'Parar playback (A)' : 'Playback da animação (A)';
      playBtn.disabled = n < 2; // um frame não anima
      note.textContent = `${n} frame${n > 1 ? 's' : ''} · ${doc.width}×${doc.height}`;
    }

    const unsubscribeDoc = onChange(doc, render);
    const unsubscribePlay = playback.subscribe(render);
    win.signal.addEventListener('abort', () => {
      unsubscribeDoc();
      unsubscribePlay();
      playback.stop(); // fechar a janela não deixa rAF rodando no doc
    });
    render();
  }

  const win = createWindow({ title: 'Frames', x, y, getPos, onBody: build, onOpen, onClose });
  win.el.classList.add('window--timeline');
  return win;
}
