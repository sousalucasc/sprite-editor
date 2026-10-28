// src/tools/color.js — cor compartilhada (hex + alfa) e a janela flutuante de seleção.
// O store não conhece canvas nem DOM de ferramenta; as ferramentas leem `rgba()` e se
// assinam com `subscribe`. A janela re-renderiza via subscribe e o unsubscribe é ligado
// ao `win.signal` (regra do AGENTS.md), igual ao painel do histórico.
import { createWindow } from '../windows.js';

const RE_HEX = /^#[0-9a-f]{6}$/i;

export const DEFAULT_PRESETS = [
  '#ffffff', '#cfcfcf', '#8f8f8f', '#454545', '#1b1b1b',
  '#ff5252', '#ff8f3b', '#ffd166', '#6dcb7f', '#3b8cff', '#8f6bff', '#e86fb0',
];

const clamp01 = (v) => Math.max(0, Math.min(1, v));

export function createColorStore({ hex = '#ffffff', alpha = 1 } = {}) {
  const listeners = new Set();
  const store = {
    hex: RE_HEX.test(hex) ? hex.toLowerCase() : '#ffffff',
    alpha: clamp01(alpha),

    rgba() {
      const n = Number.parseInt(store.hex.slice(1), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, Math.round(store.alpha * 255)];
    },

    set({ hex: nextHex, alpha: nextAlpha } = {}) {
      let changed = false;
      if (nextHex != null && RE_HEX.test(nextHex)) {
        const h = nextHex.toLowerCase();
        if (h !== store.hex) { store.hex = h; changed = true; }
      }
      if (nextAlpha != null && Number.isFinite(nextAlpha)) {
        const a = clamp01(nextAlpha);
        if (a !== store.alpha) { store.alpha = a; changed = true; }
      }
      if (changed) for (const fn of listeners) fn(store);
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return store;
}

export function createColorWindow(store, { x = window.innerWidth - 280, y = 470, onOpen, onClose, presets = DEFAULT_PRESETS } = {}) {
  function build(body, win) {
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = store.hex;
    colorInput.title = 'Cor';
    colorInput.addEventListener('input', () => store.set({ hex: colorInput.value }), { signal: win.signal });

    const hexField = document.createElement('input');
    hexField.type = 'text';
    hexField.className = 'hex-field';
    hexField.value = store.hex;
    hexField.maxLength = 7;
    hexField.spellcheck = false;
    hexField.title = 'Hex (#rrggbb)';
    hexField.addEventListener('input', () => {
      if (RE_HEX.test(hexField.value)) store.set({ hex: hexField.value });
    }, { signal: win.signal });

    const alphaRange = document.createElement('input');
    alphaRange.type = 'range';
    alphaRange.min = '0';
    alphaRange.max = '1';
    alphaRange.step = '0.01';
    alphaRange.value = String(store.alpha);
    const alphaVal = document.createElement('span');
    const alphaRow = document.createElement('label');
    alphaRow.className = 'option-row';
    alphaRow.append(alphaRange, alphaVal);
    alphaRange.addEventListener('input', () => store.set({ alpha: Number(alphaRange.value) }), { signal: win.signal });

    const swatches = document.createElement('div');
    swatches.className = 'swatches';
    for (const hex of presets) {
      const btn = document.createElement('button');
      btn.title = hex;
      btn.dataset.hex = hex;
      btn.style.background = hex;
      btn.addEventListener('click', () => store.set({ hex: btn.dataset.hex }), { signal: win.signal });
      swatches.append(btn);
    }

    const chip = document.createElement('span');
    chip.className = 'chip';
    const code = document.createElement('span');
    const preview = document.createElement('div');
    preview.className = 'swatch-preview';
    preview.append(chip, code);

    body.append(colorInput, hexField, alphaRow, swatches, preview);

    function render() {
      const [r, g, b] = store.rgba();
      colorInput.value = store.hex;
      // não sobrescreve os campos enquanto o usuário digita/arrasta (padrão do histórico)
      if (document.activeElement !== hexField) hexField.value = store.hex;
      if (document.activeElement !== alphaRange) alphaRange.value = String(store.alpha);
      alphaVal.textContent = `${Math.round(store.alpha * 100)}%`;
      chip.style.background = `rgba(${r}, ${g}, ${b}, ${store.alpha})`;
      code.textContent = `${store.hex} · alfa ${Math.round(store.alpha * 100)}%`;
    }

    const unsubscribe = store.subscribe(render);
    win.signal.addEventListener('abort', unsubscribe); // remove a assinatura ao fechar
    render();
  }

  return createWindow({ title: 'Cor', x, y, onBody: build, onOpen, onClose });
}
