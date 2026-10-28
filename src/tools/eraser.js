// src/tools/eraser.js — ferramenta borracha: apaga pixels (alfa 0) com um pincel
// quadrado/redondo. Escreve via beginStroke/paintPixel/endStroke, então o undo guarda
// só os pixels apagados (diff), nunca a imagem inteira.
import { beginStroke, paintPixel, endStroke } from '../state.js';
import { line } from '../pencil.js'; // Bresenham: traço contínuo entre eventos de pointer
import { createWindow } from '../windows.js';

const CLEAR = [0, 0, 0, 0];
const MAX_SIZE = 8;

function brushOffsets(size, shape) {
  const n = Math.max(1, Math.min(MAX_SIZE, Math.floor(size) || 1));
  const lo = -Math.floor((n - 1) / 2);
  const hi = lo + n - 1;
  const center = n % 2 === 0 ? 0.5 : 0; // pincel par fica centrado entre 4 pixels
  const radius = n / 2 - 0.25;
  const offs = [];
  for (let dy = lo; dy <= hi; dy++) {
    for (let dx = lo; dx <= hi; dx++) {
      if (shape === 'circle') {
        const ox = dx - center;
        const oy = dy - center;
        if (ox * ox + oy * oy > radius * radius) continue;
      }
      offs.push([dx, dy]);
    }
  }
  return offs;
}

export function createEraser(doc, { size = 1, shape = 'square' } = {}) {
  let stroke = null;
  let last = null;
  let offsets = brushOffsets(size, shape);

  const tool = {
    id: 'eraser',
    cursor: 'crosshair',
    size,
    shape,

    setSize(n) {
      size = Math.max(1, Math.min(MAX_SIZE, Math.floor(n) || 1));
      tool.size = size;
      offsets = brushOffsets(size, shape);
    },

    setShape(next) {
      shape = next === 'circle' ? 'circle' : 'square';
      tool.shape = shape;
      offsets = brushOffsets(size, shape);
    },

    eraseAt(x, y) {
      for (const [dx, dy] of offsets) paintPixel(stroke, x + dx, y + dy, CLEAR);
    },

    onDown(point) {
      stroke = beginStroke(doc, 'borracha');
      last = point;
      tool.eraseAt(point.x, point.y);
      return true; // pede redraw ao canvas (preview ao vivo)
    },

    onMove(point) {
      if (!stroke || !last) return false;
      if (point.x === last.x && point.y === last.y) return false;
      for (const p of line(last.x, last.y, point.x, point.y)) tool.eraseAt(p.x, p.y);
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
  return tool;
}

// Janela de opções (nível 1): tamanho do pincel e formato. As opções são propriedades
// vivas da tool — a janela escreve direto, sem estado no doc.
export function createEraserWindow(eraser, { x = 12, y = 100, getPos, onOpen, onClose } = {}) {
  function build(body, win) {
    const note = document.createElement('p');
    note.className = 'window-note';
    note.textContent = 'Apaga pixels (alfa 0) na camada atual.';

    const sizeInput = document.createElement('input');
    sizeInput.type = 'range';
    sizeInput.min = '1';
    sizeInput.max = String(MAX_SIZE);
    sizeInput.step = '1';
    sizeInput.value = String(eraser.size);
    sizeInput.setAttribute('aria-label', 'Tamanho do pincel');
    const sizeVal = document.createElement('span');
    sizeVal.className = 'tl-val';
    sizeVal.textContent = `${eraser.size} px`;
    const sizeLabel = document.createElement('span');
    sizeLabel.className = 'field-label';
    sizeLabel.textContent = 'Tamanho';
    const sizeRow = document.createElement('label');
    sizeRow.className = 'tl-row';
    sizeRow.append(sizeLabel, sizeInput, sizeVal);
    sizeInput.addEventListener(
      'input',
      () => {
        eraser.setSize(Number(sizeInput.value));
        sizeVal.textContent = `${eraser.size} px`;
      },
      { signal: win.signal }
    );

    const square = document.createElement('input');
    square.type = 'radio';
    square.name = 'eraser-shape';
    square.value = 'square';
    square.checked = eraser.shape === 'square';
    const circle = document.createElement('input');
    circle.type = 'radio';
    circle.name = 'eraser-shape';
    circle.value = 'circle';
    circle.checked = eraser.shape === 'circle';

    const shapeRow = document.createElement('label');
    shapeRow.className = 'option-row';
    shapeRow.append(square, document.createTextNode('Quadrado'));
    const shapeRow2 = document.createElement('label');
    shapeRow2.className = 'option-row';
    shapeRow2.append(circle, document.createTextNode('Redondo'));

    function setShape() {
      eraser.setShape(square.checked ? 'square' : 'circle');
    }
    for (const radio of [square, circle]) {
      radio.addEventListener('change', setShape, { signal: win.signal });
    }

    body.append(note, sizeRow, shapeRow, shapeRow2);
  }

  return createWindow({ title: 'Borracha', x, y, getPos, onBody: build, onOpen, onClose });
}
