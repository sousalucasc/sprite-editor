// src/toolbar.js — barra de ferramentas: sempre visível, fixa no centro do topo
// (posicionada pelo CSS: left 50% + translateX(-50%)). Não é arrastável — a barra é
// sempre o mesmo lugar e o layout de spawn (src/layout.js) a trata como obstáculo;
// só os painéis movem (arraste pelo cabeçalho em windows.js).
export function createFloatingToolbar() {
  return {
    destroy() {},
  };
}
