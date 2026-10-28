// src/pencil.js — ferramenta lápis. Escreve pixels no doc através de strokes;
// a view (canvas.js) só chama onDown/onMove/onUp e entrega coords de doc já em inteiro.
import { beginStroke, paintPixel, endStroke } from './state.js';

// Bresenham: garante linha contínua entre o último pixel e o novo, sem buracos
// quando o ponteiro se move mais de 1 px por evento.
export function line(x0, y0, x1, y1) {
  const points = [];
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  for (;;) {
    points.push({ x: x0, y: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = err * 2;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
  return points;
}

export function createPencil(doc, { color = '#ffffff' } = {}) {
  let rgba = hexToRgba(color);
  let stroke = null;
  let last = null;

  return {
    id: 'pencil',
    cursor: 'crosshair',

    setColor(color) {
      // aceita hex ('#rrggbb') ou rgba direto (o color store usa alfa, hexToRgba não)
      rgba = Array.isArray(color) ? color.slice() : hexToRgba(color);
    },

    onDown(point) {
      stroke = beginStroke(doc, 'pencil');
      last = point;
      paintPixel(stroke, point.x, point.y, rgba);
      return true; // pede redraw ao canvas (preview ao vivo)
    },

    onMove(point) {
      if (!stroke || !last) return false;
      if (point.x === last.x && point.y === last.y) return false;
      for (const p of line(last.x, last.y, point.x, point.y)) paintPixel(stroke, p.x, p.y, rgba);
      last = point;
      return true;
    },

    onUp() {
      if (!stroke) return;
      endStroke(doc, stroke);
      stroke = null;
      last = null;
    },
  };
}

function hexToRgba(hex) {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}
