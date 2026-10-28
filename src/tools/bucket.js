// src/tools/bucket.js — balde: flood fill (BFS) na camada atual do frame atual.
// Cada pixel preenchido passa por paintPixel, então o undo guarda só os pixels
// mudados pelo balde. O BFS usa `seen` por pixel: a comparação é feita no pop com
// o valor original do pixel, porque paintPixel muta o mesmo buffer que o BFS lê.
import { beginStroke, paintPixel, endStroke } from '../state.js';
import { createWindow } from '../windows.js';

export function createBucket(doc, colorStore, { tolerance = 0, alphaSensitive = true } = {}) {
  let stroke = null;
  let lastPixels = 0;
  const listeners = new Set();

  const tool = {
    id: 'bucket',
    cursor: 'crosshair',
    tolerance, // 0..255: distância máxima por canal até a cor clicada
    alphaSensitive, // false = ignorar o canal alfa na comparação

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    onDown(point) {
      const { width, height } = doc;
      if (point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) return false;

      stroke = beginStroke(doc, 'balde');
      const p = stroke.pixels;
      const start = (point.y * width + point.x) * 4;
      const target = [p[start], p[start + 1], p[start + 2], p[start + 3]];
      const fill = colorStore.rgba();
      const tol = tool.tolerance;

      const matches = (i) => {
        for (let c = 0; c < 4; c++) {
          if (c === 3 && !tool.alphaSensitive) continue;
          if (Math.abs(p[i + c] - target[c]) > tol) return false;
        }
        return true;
      };

      const seen = new Uint8Array(width * height);
      const queue = [point.y * width + point.x];
      seen[queue[0]] = 1;

      while (queue.length) {
        const idx = queue.pop();
        if (!matches(idx * 4)) continue; // já pintado ou cor fora da tolerância
        paintPixel(stroke, idx % width, (idx / width) | 0, fill);
        const x = idx % width;
        const y = (idx / width) | 0;
        if (x > 0 && !seen[idx - 1]) { seen[idx - 1] = 1; queue.push(idx - 1); }
        if (x < width - 1 && !seen[idx + 1]) { seen[idx + 1] = 1; queue.push(idx + 1); }
        if (y > 0 && !seen[idx - width]) { seen[idx - width] = 1; queue.push(idx - width); }
        if (y < height - 1 && !seen[idx + width]) { seen[idx + width] = 1; queue.push(idx + width); }
      }
      return true; // pede redraw ao canvas (preview ao vivo do fill)
    },

    onMove() {
      // balde preenche só no clique; arrastar não preenche de novo para não acumular strokes
      return false;
    },

    onUp() {
      if (!stroke) return;
      endStroke(doc, stroke);
      lastPixels = stroke.writes.size;
      stroke = null;
      for (const fn of listeners) fn(lastPixels);
    },
  };
  return tool;
}

// Janela de opções (nível 1): tolerância por canal e se o alfa entra na comparação.
export function createBucketWindow(bucket, { x = 12, y = 100, onOpen, onClose } = {}) {
  function build(body, win) {
    const note = document.createElement('p');
    note.className = 'window-note';
    note.textContent = 'Preenche a área conectada na camada atual com a cor atual.';

    const tolInput = document.createElement('input');
    tolInput.type = 'range';
    tolInput.min = '0';
    tolInput.max = '255';
    tolInput.step = '1';
    tolInput.value = String(bucket.tolerance);
    const tolVal = document.createElement('span');
    tolVal.textContent = String(bucket.tolerance);
    const tolRow = document.createElement('label');
    tolRow.className = 'option-row';
    tolRow.append(tolInput, tolVal);
    tolInput.addEventListener(
      'input',
      () => {
        bucket.tolerance = Number(tolInput.value);
        tolVal.textContent = String(bucket.tolerance);
      },
      { signal: win.signal }
    );

    const alphaCheck = document.createElement('input');
    alphaCheck.type = 'checkbox';
    alphaCheck.checked = bucket.alphaSensitive;
    const alphaRow = document.createElement('label');
    alphaRow.className = 'option-row';
    alphaRow.append(alphaCheck, document.createTextNode('Considerar alfa'));
    alphaCheck.addEventListener('change', () => { bucket.alphaSensitive = alphaCheck.checked; }, { signal: win.signal });

    const last = document.createElement('p');
    last.className = 'window-note';
    last.textContent = 'Último balde: —';

    const unsubscribe = bucket.subscribe((n) => { last.textContent = `Último balde: ${n} px` });
    win.signal.addEventListener('abort', unsubscribe); // remove a assinatura ao fechar

    body.append(note, tolRow, alphaRow, last);
  }

  return createWindow({ title: 'Balde', x, y, onBody: build, onOpen, onClose });
}
