// src/layout.js — layout de spawn dos painéis flutuantes.
// Regra da tarefa: o spawn default nunca aparece em cima da área de desenho e nunca
// sobrepõe outro painel. Cada painel tem um lado preferido (right/left/bottom/top);
// o layout procura uma faixa livre no lado preferido e encosta o painel na borda do
// viewport, empilhando os seguintes (com GAP) e evitando o retângulo do sprite na tela,
// a toolbar e os painéis já abertos. Se o lado preferido está cheio ou é estreito demais,
// tenta os outros lados (right → bottom → left → top). O arraste manual é livre
// (windows.js só clampa ao viewport): depois que o usuário move, o layout não reposiciona
// o painel no resize — só os não movidos.
// Obstáculos: sprite ∩ viewport (view de src/canvas.js), toolbar e painéis registrados.

import { place as placeClamped } from './windows.js';

const MARGIN = 8;
const GAP = 8;
const MAX_STEPS = 24; // guarda da varredura: cada obstáculo avança o cursor, nunca loopa
const FALLBACK_ORDER = ['right', 'bottom', 'left', 'top'];

const overlap = (a, b) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

export function createLayout({ spriteRect, toolbarEl = null, onChange = null } = {}) {
  // el -> { side }: painéis registrados pelo spawn (via getPos no open da janela).
  // Um el por painel, criado uma vez por createXWindow — reabrir só re-registra o lado.
  const placed = new Map();
  const life = new AbortController();
  let reflowing = false; // durante o relayout, só painéis anteriores são obstáculos
  let reflowRaf = 0;
  // O conteúdo dos painéis muda (nova camada, novo stroke, import): a altura cresce
  // DEPOIS do spawn. Sem observador, os painéis da coluna se sobrepunham. O observer
  // re-empilha só os painéis não movidos; o rAF junta os vários avisos num relayout.
  const observer = new ResizeObserver(() => scheduleRelayout());
  let notifyRaf = 0;

  function scheduleRelayout() {
    if (reflowRaf) return;
    reflowRaf = requestAnimationFrame(() => {
      reflowRaf = 0;
      relayout();
    });
  }

  // A UI mudou de posição/tamanho: avisa quem depende do espaço livre (o fit do canvas).
  // Em rAF para medir depois que o navegador aplicou o left/top do painel recém-aberto.
  function scheduleNotify() {
    if (notifyRaf) return;
    notifyRaf = requestAnimationFrame(() => {
      notifyRaf = 0;
      onChange?.();
    });
  }

  // Retângulos da UI que o fit() do canvas não pode cobrir: toolbar + painéis visíveis.
  function uiRects() {
    const out = [];
    if (toolbarEl && !toolbarEl.hidden) out.push(rectOf(toolbarEl));
    for (const [el] of placed) {
      if (!el.hidden) out.push(rectOf(el));
    }
    return out;
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  // A área de desenho na tela, recortada ao viewport: fora dele não há pixels desenhados.
  function spriteBlock() {
    const s = spriteRect?.();
    if (!s || s.width <= 0 || s.height <= 0) return null;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const x0 = clamp(s.x, 0, W);
    const x1 = clamp(s.x + s.width, 0, W);
    const y0 = clamp(s.y, 0, H);
    const y1 = clamp(s.y + s.height, 0, H);
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  function obstacles(el) {
    const obs = [];
    const sp = spriteBlock();
    if (sp) obs.push(sp);
    if (toolbarEl && !toolbarEl.hidden) obs.push(rectOf(toolbarEl));
    // No relayout, um painel só desvia dos painéis que vêm ANTES dele na ordem de
    // abertura; os seguintes serão posicionados depois e desviam dele. Sem isso, um
    // painel maior empurrava o primeiro para baixo do último e a coluna invertia.
    const order = reflowing ? [...placed.keys()] : null;
    const limit = order ? order.indexOf(el) : -1;
    let index = -1;
    for (const [other] of placed) {
      index += 1;
      if (other === el || other.hidden) continue; // painel fechado não é obstáculo
      if (order && index > limit) continue; // ainda vai ser reposicionado neste relayout
      obs.push(rectOf(other));
    }
    return obs;
  }

  // Faixa vertical (direita/esquerda): o painel encosta na borda do viewport e a
  // varredura empilha no y. Antes ele ficava colado no sprite, o que deixava cada painel
  // numa coluna diferente; encostar na borda alinha a coluna inteira (dock).
  function fitVertical(el, side, obs) {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const x = side === 'right' ? W - w - MARGIN : MARGIN;
    if (x < MARGIN || x + w > W - MARGIN) return null; // faixa estreita
    let y = MARGIN;
    for (let i = 0; i < MAX_STEPS; i++) {
      const rect = { x, y, width: w, height: h };
      let bottom = -1;
      for (const o of obs) {
        if (overlap(rect, o)) bottom = Math.max(bottom, o.y + o.height);
      }
      if (bottom === -1) return { x, y };
      y = bottom + GAP;
      if (y + h > H - MARGIN) return null; // não cabe empilhado nesta faixa
    }
    return null;
  }

  // Faixa horizontal (cima/baixo): o painel encosta na borda e a varredura anda no x,
  // empilhando painéis da esquerda para a direita.
  function fitHorizontal(el, side, obs) {
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const y = side === 'bottom' ? H - h - MARGIN : MARGIN;
    if (y < MARGIN || y + h > H - MARGIN) return null; // faixa estreita
    let x = MARGIN;
    for (let i = 0; i < MAX_STEPS; i++) {
      const rect = { x, y, width: w, height: h };
      let right = -1;
      for (const o of obs) {
        if (overlap(rect, o)) right = Math.max(right, o.x + o.width);
      }
      if (right === -1) return { x, y };
      x = right + GAP;
      if (x + w > W - MARGIN) return null; // não cabe nesta faixa
    }
    return null;
  }

  function fit(el, side, obs) {
    return side === 'right' || side === 'left' ? fitVertical(el, side, obs) : fitHorizontal(el, side, obs);
  }

  // Posição de spawn de um painel aberto: lado preferido primeiro, depois os demais.
  // Sem faixa livre (sprite/panels ocupam tudo) é o caso degenerado: volta ao canto do
  // lado preferido, clampado ao viewport — pode encostar no sprite, mas nunca sai da tela.
  function spawn(el, side = 'right') {
    const entry = placed.get(el);
    if (entry) entry.side = side;
    else {
      placed.set(el, { side });
      observer.observe(el); // altura muda com o conteúdo: re-empilha sem sobrepor
    }

    const obs = obstacles(el);
    for (const s of [side, ...FALLBACK_ORDER.filter((f) => f !== side)]) {
      const pos = fit(el, s, obs);
      if (pos) {
        scheduleNotify();
        return pos;
      }
    }
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const corners = {
      right: { x: W - w - MARGIN, y: MARGIN },
      left: { x: MARGIN, y: MARGIN },
      bottom: { x: MARGIN, y: H - h - MARGIN },
      top: { x: MARGIN, y: MARGIN },
    };
    scheduleNotify();
    return corners[side] ?? corners.right;
  }

  // Resize: painéis que nunca foram movidos voltam para as faixas livres (na ordem de
  // spawn, empilhando sobre os que já foram reposicionados); os movidos ficam onde o
  // usuário deixou — o listener de resize de windows.js só clampa ao viewport.
  function relayout() {
    reflowing = true;
    try {
      for (const [el, entry] of placed) {
        if (el.hidden || el.dataset.moved) continue;
        const pos = spawn(el, entry.side);
        placeClamped(el, pos.x, pos.y);
      }
    } finally {
      reflowing = false;
    }
    scheduleNotify();
  }

  window.addEventListener('resize', relayout, { signal: life.signal });

  return {
    spawn,
    relayout,
    obstacles: uiRects,
    destroy() {
      if (reflowRaf) cancelAnimationFrame(reflowRaf);
      if (notifyRaf) cancelAnimationFrame(notifyRaf);
      reflowRaf = 0;
      notifyRaf = 0;
      observer.disconnect();
      life.abort();
      placed.clear();
    },
  };
}
