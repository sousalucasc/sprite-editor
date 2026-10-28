// src/windows.js — sistema de painéis flutuantes: arrastar pelo cabeçalho, abrir/fechar,
// aninhamento até 3 níveis. Só o sistema; as ferramentas (passo 4) abrirão janelas
// via createWindow({ onBody }).
// Regra do AGENTS.md: todo listener criado dentro de open() usa a AbortSignal da sessão
// (win.signal) e é removido quando o painel fecha; ao reabrir, onBody reconstrói o corpo.

export const MAX_LEVEL = 3;

const MARGIN = 8;
const CHILD_GAP = 12;

let zTop = 30; // painéis ficam acima da toolbar (z-index 30 no CSS); o último focado vai para frente

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

// Posição final clampada ao viewport; o elemento precisa estar visível para medir tamanho.
export function place(el, x, y) {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  el.style.left = `${clamp(x, MARGIN, Math.max(MARGIN, window.innerWidth - w - MARGIN))}px`;
  el.style.top = `${clamp(y, MARGIN, Math.max(MARGIN, window.innerHeight - h - MARGIN))}px`;
}

// Arrasta `el` quando o pointerdown cai em `handle`. Os listeners de arraste vivem só
// durante o arraste (um AbortController por arraste, abortado no pointerup/cancel).
export function createDraggable(el, handle, { reject } = {}) {
  const life = new AbortController();
  handle.addEventListener(
    'pointerdown',
    (ev) => {
      if (ev.button !== 0) return;
      if (reject?.(ev.target)) return;
      ev.preventDefault(); // não seleciona texto do cabeçalho/fundo
      if (ev.isTrusted) handle.setPointerCapture(ev.pointerId);
      const rect = el.getBoundingClientRect();
      const ox = ev.clientX - rect.left;
      const oy = ev.clientY - rect.top;
      const drag = new AbortController();
      handle.addEventListener(
        'pointermove',
        (ev) => place(el, ev.clientX - ox, ev.clientY - oy),
        { signal: drag.signal }
      );
      for (const type of ['pointerup', 'pointercancel']) {
        handle.addEventListener(type, () => drag.abort(), { signal: drag.signal });
      }
    },
    { signal: life.signal }
  );
  return { destroy() { life.abort(); } };
}

export function createWindow({ title, x = MARGIN, y = MARGIN, parent = null, onBody, onOpen, onClose } = {}) {
  const level = parent ? parent.level + 1 : 1;
  if (level > MAX_LEVEL) throw new Error(`aninhamento máximo de ${MAX_LEVEL} níveis`);

  const el = document.createElement('div');
  el.className = 'window';
  el.hidden = true;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', title);

  const header = document.createElement('div');
  header.className = 'window-header';
  const label = document.createElement('span');
  label.textContent = title;
  const badge = document.createElement('span');
  badge.className = 'window-level';
  badge.textContent = `${level}/${MAX_LEVEL}`;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'window-close';
  closeBtn.textContent = '×';
  closeBtn.title = 'Fechar';
  closeBtn.setAttribute('aria-label', 'Fechar');
  header.append(label, badge, closeBtn);

  const body = document.createElement('div');
  body.className = 'window-body';
  el.append(header, body);
  document.body.append(el);

  const life = new AbortController();
  const drag = createDraggable(el, header, { reject: (t) => t.closest('button') });
  el.addEventListener('pointerdown', () => {
    el.style.zIndex = String(++zTop);
  }, { signal: life.signal });

  const children = [];
  let session = null; // AbortController da abertura atual; null = fechado

  function open() {
    if (session) return;
    session = new AbortController();
    api.signal = session.signal;
    el.hidden = false;
    el.style.zIndex = String(++zTop);
    window.addEventListener('resize', () => {
      const rect = el.getBoundingClientRect();
      place(el, rect.left, rect.top);
    }, { signal: session.signal });
    closeBtn.addEventListener('click', close, { signal: session.signal });
    body.textContent = '';
    onBody?.(body, api);
    place(el, x, y);
    onOpen?.();
  }

  function close() {
    if (!session) return;
    session.abort(); // remove resize, close-btn e todos os listeners que usaram win.signal
    session = null;
    api.signal = null;
    el.hidden = true;
    // Destrói (não só fecha) os descendentes: fechar o pai não deixa janelas filhas
    // órfãs no DOM. Antes elas ficavam presas em `children` e cada openChild()
    // adicionava mais uma para sempre (vazamento não limitado).
    for (const child of children) child.destroy();
    children.length = 0;
    onClose?.();
  }

  function openChild(opts = {}) {
    if (!session) throw new Error('sub-painel só pode ser aberto com o pai aberto');
    if (level >= MAX_LEVEL) throw new Error(`aninhamento máximo de ${MAX_LEVEL} níveis`);
    const rect = el.getBoundingClientRect();
    const child = createWindow({
      title: opts.title ?? 'Sub-painel',
      x: rect.left + rect.width + CHILD_GAP,
      y: rect.top + CHILD_GAP,
      parent: api,
      onBody: opts.onBody ?? onBody,
    });
    children.push(child);
    child.open();
    return child;
  }

  function destroy() {
    close();
    for (const child of children) child.destroy();
    children.length = 0;
    drag.destroy();
    life.abort(); // remove o pointerdown de foco/z-index
    el.remove();
  }

  const api = {
    el,
    body,
    level,
    signal: null, // válido só enquanto aberto; use `{ signal: win.signal }` nos listeners do corpo
    isOpen: () => session !== null,
    canOpenChild: () => level < MAX_LEVEL,
    open,
    openChild,
    close,
    destroy,
  };
  return api;
}
