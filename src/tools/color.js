// src/tools/color.js — cor compartilhada (hex + alfa) e a janela flutuante de seleção.
// O store não conhece canvas nem DOM de ferramenta; as ferramentas leem `rgba()` e se
// assinam com `subscribe`. A janela re-renderiza via subscribe e o unsubscribe é ligado
// ao `win.signal` (regra do AGENTS.md), igual ao painel do histórico.
import { createWindow } from '../windows.js';

const RE_HEX = /^#[0-9a-f]{6}$/i;

export const DEFAULT_PRESETS = [
  // Paleta do Excalidraw (tema escuro): 1ª linha = traço neutro + cores fortes;
  // 2ª linha = fundos pastel. O grid do painel é 6 colunas, então fecha em 2 linhas.
  '#ffffff', '#e03131', '#2f9e44', '#1971c2', '#f08c00', '#ced4da',
  '#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99', '#ff8787', '#8ce99a',
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

export function createColorWindow(store, { x = window.innerWidth - 280, y = 470, getPos, onOpen, onClose, presets = DEFAULT_PRESETS } = {}) {
  function build(body, win) {
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = store.hex;
    colorInput.title = 'Cor';
    colorInput.setAttribute('aria-label', 'Cor');
    colorInput.addEventListener('input', () => store.set({ hex: colorInput.value }), { signal: win.signal });

    const hexField = document.createElement('input');
    hexField.type = 'text';
    hexField.className = 'hex-field';
    hexField.value = store.hex;
    hexField.maxLength = 7;
    hexField.spellcheck = false;
    hexField.title = 'Hex (#rrggbb)';
    hexField.setAttribute('aria-label', 'Cor em hexadecimal');
    hexField.addEventListener('input', () => {
      if (RE_HEX.test(hexField.value)) store.set({ hex: hexField.value });
    }, { signal: win.signal });

    const colorLabel = document.createElement('span');
    colorLabel.className = 'field-label';
    colorLabel.textContent = 'Cor';
    const colorRow = document.createElement('div');
    colorRow.className = 'option-row';
    colorRow.append(colorLabel, colorInput, hexField);

    const alphaRange = document.createElement('input');
    alphaRange.type = 'range';
    alphaRange.min = '0';
    alphaRange.max = '1';
    alphaRange.step = '0.01';
    alphaRange.value = String(store.alpha);
    alphaRange.setAttribute('aria-label', 'Alfa');
    const alphaVal = document.createElement('span');
    alphaVal.className = 'tl-val';
    const alphaLabel = document.createElement('span');
    alphaLabel.className = 'field-label';
    alphaLabel.textContent = 'Alfa';
    const alphaRow = document.createElement('label');
    alphaRow.className = 'tl-row';
    alphaRow.append(alphaLabel, alphaRange, alphaVal);
    alphaRange.addEventListener('input', () => store.set({ alpha: Number(alphaRange.value) }), { signal: win.signal });

    const swatches = document.createElement('div');
    swatches.className = 'swatches';
    for (const hex of presets) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.title = hex;
      btn.setAttribute('aria-label', `Usar cor ${hex}`);
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

    body.append(colorRow, alphaRow, swatches, preview);

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

  return createWindow({ title: 'Cor', x, y, getPos, onBody: build, onOpen, onClose });
}
