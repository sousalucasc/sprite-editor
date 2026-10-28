// src/toolbar.js — barra flutuante de ferramentas: sempre visível, arrastável pelo fundo.
// Botões/inputs não iniciam arraste (reject) para não interferir nos clicks.
import { createDraggable, place } from './windows.js';

export function createFloatingToolbar(el) {
  const life = new AbortController();
  window.addEventListener(
    'resize',
    () => {
      const rect = el.getBoundingClientRect();
      place(el, rect.left, rect.top);
    },
    { signal: life.signal }
  );
  const drag = createDraggable(el, el, { reject: (t) => t.closest('button, input') });

  return {
    destroy() {
      drag.destroy();
      life.abort();
    },
  };
}
