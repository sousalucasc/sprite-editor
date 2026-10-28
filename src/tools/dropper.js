// src/tools/dropper.js — conta-gotas: lê a cor de um pixel (camada atual ou composição
// das camadas visíveis) e aplica ao color store. Não escreve pixels, então não gera
// stroke nem entrada no histórico.
import { createWindow } from '../windows.js';

function rgbToHex([r, g, b]) {
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// Mesma composição straight alpha da ordem das camadas que o render faz em canvas.js,
// só que para um único pixel (o dropper não tem acesso ao buffer do render).
function sampleComposite(doc, x, y) {
  const i = (y * doc.width + x) * 4;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (const layer of doc.frames[doc.frame].layers) {
    if (!layer.visible) continue;
    const op = layer.opacity ?? 1; // mesma composição do render em canvas.js, incl. opacidade
    if (op === 0) continue;
    const p = layer.pixels;
    const sa = (p[i + 3] / 255) * op;
    if (sa === 0) continue;
    const da = a / 255;
    const na = sa + da * (1 - sa);
    if (na <= 0) continue;
    r = (p[i] * sa + r * da * (1 - sa)) / na;
    g = (p[i + 1] * sa + g * da * (1 - sa)) / na;
    b = (p[i + 2] * sa + b * da * (1 - sa)) / na;
    a = na * 255;
  }
  return [Math.round(r), Math.round(g), Math.round(b), Math.round(a)];
}

export function createDropper(doc, colorStore, { source = 'composite', applyToStore = true } = {}) {
  const listeners = new Set();

  const tool = {
    id: 'dropper',
    cursor: 'crosshair',
    source, // 'composite' (todas visíveis) ou 'layer' (camada ativa)
    applyToStore, // false = só reporta a cor, não muda a cor de pintura

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    pick(x, y) {
      const { width, height } = doc;
      if (x < 0 || y < 0 || x >= width || y >= height) return null;
      const rgba =
        tool.source === 'layer'
          ? Array.from(doc.frames[doc.frame].layers[doc.layer].pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4))
          : sampleComposite(doc, x, y);
      if (tool.applyToStore) colorStore.set({ hex: rgbToHex(rgba), alpha: rgba[3] / 255 });
      for (const fn of listeners) fn(rgba);
      return rgba;
    },

    onDown(point) {
      tool.pick(point.x, point.y);
      return false; // não muda pixels: o canvas não precisa redesenhar
    },

    onMove(point, ev) {
      // Só colhe enquanto o botão esquerdo está pressionado. Sem esta guarda o hover
      // mudava a cor de pintura a cada pointermove (e re-renderizava o painel de cor).
      if (ev && typeof ev.buttons === 'number' && (ev.buttons & 1) === 0) return false;
      tool.pick(point.x, point.y); // arrastar colhe como um conta-gotas de Aseprite
      return false;
    },

    onUp() {},
  };
  return tool;
}

// Janela de opções (nível 1): fonte da amostra e se a cor vai para o lápis/balde.
export function createDropperWindow(dropper, { x = 12, y = 100, getPos, onOpen, onClose } = {}) {
  function build(body, win) {
    const note = document.createElement('p');
    note.className = 'window-note';
    note.textContent = 'Clique (ou arraste) para colher a cor de um pixel.';

    const composite = document.createElement('input');
    composite.type = 'radio';
    composite.name = 'dropper-source';
    composite.value = 'composite';
    composite.checked = dropper.source === 'composite';
    const layer = document.createElement('input');
    layer.type = 'radio';
    layer.name = 'dropper-source';
    layer.value = 'layer';
    layer.checked = dropper.source === 'layer';

    const compositeRow = document.createElement('label');
    compositeRow.className = 'option-row';
    compositeRow.append(composite, document.createTextNode('Imagem composta (visíveis)'));
    const layerRow = document.createElement('label');
    layerRow.className = 'option-row';
    layerRow.append(layer, document.createTextNode('Camada ativa'));

    const applyCheck = document.createElement('input');
    applyCheck.type = 'checkbox';
    applyCheck.checked = dropper.applyToStore;
    const applyRow = document.createElement('label');
    applyRow.className = 'option-row';
    applyRow.append(applyCheck, document.createTextNode('Aplicar ao lápis/balde'));

    function setSource() {
      dropper.source = composite.checked ? 'composite' : 'layer';
    }
    for (const radio of [composite, layer]) {
      radio.addEventListener('change', setSource, { signal: win.signal });
    }
    applyCheck.addEventListener('change', () => { dropper.applyToStore = applyCheck.checked; }, { signal: win.signal });

    const chip = document.createElement('span');
    chip.className = 'chip';
    const code = document.createElement('span');
    const preview = document.createElement('div');
    preview.className = 'swatch-preview';
    preview.append(chip, code);
    code.textContent = 'colhido: —';

    const unsubscribe = dropper.subscribe((rgba) => {
      const hex = rgbToHex(rgba);
      chip.style.background = `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${rgba[3] / 255})`;
      code.textContent = `colhido: ${hex} · alfa ${Math.round((rgba[3] / 255) * 100)}%`;
    });
    win.signal.addEventListener('abort', unsubscribe); // remove a assinatura ao fechar

    body.append(note, compositeRow, layerRow, applyRow, preview);
  }

  return createWindow({ title: 'Conta-gotas', x, y, getPos, onBody: build, onOpen, onClose });
}
