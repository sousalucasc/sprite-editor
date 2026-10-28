// src/canvas.js — render + view. Lê o doc para desenhar e nunca muta pixels.
// Zoom/pan pertencem à view, não ao documento.
import { onChange } from './state.js';

const BG = '#1b1b1b';
const CHECK_A = '#2d2d2d';
const CHECK_B = '#3a3a3a';
const GRID_COLOR = 'rgba(255,255,255,0.08)';
const BORDER_COLOR = 'rgba(255,255,255,0.28)';
const MIN_SCALE = 0.25;
const MAX_SCALE = 64;
const GRID_MIN_SCALE = 6; // grade só aparece quando 1 px do doc tem >= 6 px na tela
const CHECK_SIZE = 8;

// Onion skin: frames vizinhos desenhados por cima do frame ativo, tingidos. A animação é
// cíclica, então o "anterior/próximo" wraps. Fade por vizinho: 1º full, 2º/3º mais fracos.
const ONION_MAX_FRAMES = 3;
const ONION_FADE = [1, 0.5, 0.25];
const TINT_PREV = 'rgba(255,84,96,0.55)';
const TINT_NEXT = 'rgba(96,255,164,0.55)';

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

export function createRenderer(canvas, doc, { onChangeView } = {}) {
  const ctx = canvas.getContext('2d');
  const view = { scale: 6, tx: 0, ty: 0 }; // tx/ty em pixels de tela (device px)
  const off = document.createElement('canvas');
  const offCtx = off.getContext('2d');

  let composite = null;
  let checker = null;
  let tool = null;
  let dirty = false;
  let raf = 0;
  let fitted = false;
  let space = false;
  let pan = null; // último ponto da pan drag, em device px
  let drawing = false; // botão esquerdo pressionado sobre o canvas (traço em andamento)
  let frameBuffer = null; // buffer do frame atual, recriado só quando o doc muda de tamanho
  let onion = { enabled: false, count: 1, opacity: 0.35 }; // estado do render, não do doc
  let ghost = null; // canvas offscreen dos frames fantasma; buffers reusados, soltos no destroy
  let ghostCtx = null;
  let ghostBuffer = null;
  let ghostImage = null;
  const listeners = [];

  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    listeners.push({ target, type, fn, opts });
  }

  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    if (!fitted) {
      fit();
      fitted = true;
    }
    requestRender();
  }

  function fit() {
    const pad = 24 * (window.devicePixelRatio || 1);
    const s = Math.min((canvas.width - pad * 2) / doc.width, (canvas.height - pad * 2) / doc.height);
    view.scale = clamp(Math.floor(s) || 1, MIN_SCALE, MAX_SCALE);
    view.tx = (canvas.width - doc.width * view.scale) / 2;
    view.ty = (canvas.height - doc.height * view.scale) / 2;
    notifyView();
  }

  function requestRender() {
    dirty = true;
    if (!raf) raf = requestAnimationFrame(renderFrame);
  }

  function renderFrame() {
    raf = 0;
    if (!dirty) return;
    dirty = false;
    draw();
  }

  function screenPoint(ev) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left) * (canvas.width / rect.width),
      y: (ev.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  function docPoint(ev) {
    const s = screenPoint(ev);
    return {
      x: Math.floor((s.x - view.tx) / view.scale),
      y: Math.floor((s.y - view.ty) / view.scale),
    };
  }

  function zoomAt(ev) {
    const s = screenPoint(ev);
    const next = clamp(view.scale * Math.exp(-ev.deltaY * 0.0015), MIN_SCALE, MAX_SCALE);
    const k = next / view.scale;
    view.tx = s.x - (s.x - view.tx) * k;
    view.ty = s.y - (s.y - view.ty) * k;
    view.scale = next;
    requestRender();
    notifyView();
  }

  function notifyView() {
    onChangeView?.(view);
  }

  function cursor() {
    canvas.style.cursor = pan ? 'grabbing' : space ? 'grab' : tool?.cursor ?? 'default';
  }

  function pointerDown(ev) {
    if (ev.button === 1 || space) {
      pan = screenPoint(ev);
      cursor();
      ev.preventDefault();
      return;
    }
    if (ev.button !== 0 || !tool) return;
    if (ev.isTrusted) canvas.setPointerCapture(ev.pointerId);
    drawing = true;
    // O tool devolve true quando mudou pixels; o estado só avisa no endStroke, então
    // sem isto o traço só apareceria ao soltar o mouse (sem preview ao vivo).
    if (tool.onDown(docPoint(ev), ev)) requestRender();
  }

  function pointerMove(ev) {
    if (pan) {
      const s = screenPoint(ev);
      view.tx += s.x - pan.x;
      view.ty += s.y - pan.y;
      pan = s;
      requestRender();
      return;
    }
    if (!tool) return;
    if (tool.onMove(docPoint(ev), ev)) requestRender();
  }

  function pointerUp(ev) {
    drawing = false;
    if (pan) {
      pan = null;
      cursor();
    }
    if (tool) tool.onUp?.(ev);
    if (canvas.hasPointerCapture?.(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
  }

  function wheel(ev) {
    ev.preventDefault();
    zoomAt(ev);
  }

  function keyDown(ev) {
    if (ev.code !== 'Space' || ev.repeat) return;
    if (ev.target instanceof HTMLInputElement) return;
    space = true;
    cursor();
    ev.preventDefault();
  }

  function keyUp(ev) {
    if (ev.code !== 'Space') return;
    space = false;
    cursor();
  }

  on(canvas, 'pointerdown', pointerDown);
  on(canvas, 'pointermove', pointerMove);
  on(canvas, 'pointerup', pointerUp);
  on(canvas, 'pointercancel', pointerUp);
  on(canvas, 'wheel', wheel, { passive: false });
  on(window, 'keydown', keyDown);
  on(window, 'keyup', keyUp);
  on(window, 'resize', resize);
  const unsubscribeDoc = onChange(doc, requestRender);

  function makeChecker() {
    const p = document.createElement('canvas');
    p.width = CHECK_SIZE * 2;
    p.height = CHECK_SIZE * 2;
    const c = p.getContext('2d');
    c.fillStyle = CHECK_A;
    c.fillRect(0, 0, CHECK_SIZE * 2, CHECK_SIZE * 2);
    c.fillStyle = CHECK_B;
    c.fillRect(0, 0, CHECK_SIZE, CHECK_SIZE);
    c.fillRect(CHECK_SIZE, CHECK_SIZE, CHECK_SIZE, CHECK_SIZE);
    return ctx.createPattern(p, 'repeat');
  }

  // Compõe as camadas visíveis de um frame no buffer dado (mesma ordem e mesmo blend que
  // o frame ativo). Um único caminho de blend para o render e para o ghost.
  function composeInto(buffer, frameIndex) {
    const frame = doc.frames[frameIndex];
    if (!frame) return false;
    buffer.fill(0);

    for (const layer of frame.layers) {
      if (!layer.visible) continue;
      const op = layer.opacity ?? 1; // camadas antigas do JSON importado podem não ter opacity
      if (op === 0) continue;
      const src = layer.pixels;
      for (let i = 0; i < buffer.length; i += 4) {
        const sa = (src[i + 3] / 255) * op;
        if (sa === 0) continue;
        const da = buffer[i + 3] / 255;
        const a = sa + da * (1 - sa);
        if (a <= 0) continue;
        for (let c = 0; c < 3; c++) {
          buffer[i + c] = (src[i + c] * sa + buffer[i + c] * da * (1 - sa)) / a;
        }
        buffer[i + 3] = a * 255;
      }
    }
    return true;
  }

  function composeFrame() {
    const { width, height } = doc;
    if (!frameBuffer || frameBuffer.length !== width * height * 4) {
      frameBuffer = new Uint8ClampedArray(width * height * 4);
      composite = new ImageData(frameBuffer, width, height);
      off.width = width;
      off.height = height;
    }
    composeInto(frameBuffer, doc.frame);
    offCtx.putImageData(composite, 0, 0);
  }

  function ensureGhost() {
    const { width, height } = doc;
    if (!ghost) {
      ghost = document.createElement('canvas');
      ghostCtx = ghost.getContext('2d');
    }
    if (!ghostBuffer || ghostBuffer.length !== width * height * 4) {
      ghostBuffer = new Uint8ClampedArray(width * height * 4);
      ghostImage = new ImageData(ghostBuffer, width, height);
      ghost.width = width;
      ghost.height = height;
    }
  }

  // Ghost de um frame vizinho: compõe no buffer reusado, tinge só onde o ghost tem alfa
  // (source-atop preserva a forma e parte da luminância) e é desenhado com alpha.
  function drawGhost(offset, tint, alpha, dx, dy, dw, dh) {
    const n = doc.frames.length;
    if (n < 2 || alpha <= 0) return;
    const idx = (doc.frame + offset + n * ONION_MAX_FRAMES) % n; // animação é cíclica
    if (idx === doc.frame || !composeInto(ghostBuffer, idx)) return;
    ghostCtx.putImageData(ghostImage, 0, 0);
    ghostCtx.globalCompositeOperation = 'source-atop';
    ghostCtx.fillStyle = tint;
    ghostCtx.fillRect(0, 0, doc.width, doc.height);
    ghostCtx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = alpha;
    ctx.drawImage(ghost, dx, dy, dw, dh);
    ctx.globalAlpha = 1;
  }

  function drawGrid(dx, dy, dw, dh) {
    const x0 = clamp(Math.floor(-view.tx / view.scale), 0, doc.width - 1);
    const x1 = clamp(Math.ceil((canvas.width - view.tx) / view.scale), 1, doc.width - 1);
    const y0 = clamp(Math.floor(-view.ty / view.scale), 0, doc.height - 1);
    const y1 = clamp(Math.ceil((canvas.height - view.ty) / view.scale), 1, doc.height - 1);

    ctx.beginPath();
    for (let x = x0 + 1; x <= x1; x++) {
      const px = Math.round(dx + x * view.scale) + 0.5;
      ctx.moveTo(px, dy);
      ctx.lineTo(px, dy + dh);
    }
    for (let y = y0 + 1; y <= y1; y++) {
      const py = Math.round(dy + y * view.scale) + 0.5;
      ctx.moveTo(dx, py);
      ctx.lineTo(dx + dw, py);
    }
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function draw() {
    const cw = canvas.width;
    const ch = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, cw, ch);

    const dx = Math.round(view.tx);
    const dy = Math.round(view.ty);
    const dw = Math.round(doc.width * view.scale);
    const dh = Math.round(doc.height * view.scale);

    if (dw > 0 && dh > 0 && dx < cw && dy < ch && dx + dw > 0 && dy + dh > 0) {
      checker ??= makeChecker();
      ctx.fillStyle = checker;
      ctx.fillRect(dx, dy, dw, dh);

      composeFrame();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(off, dx, dy, dw, dh);

      if (onion.enabled && onion.opacity > 0) {
        ensureGhost();
        for (let k = 1; k <= onion.count; k++) {
          const fade = ONION_FADE[k - 1] ?? 0.25;
          drawGhost(-k, TINT_PREV, onion.opacity * fade, dx, dy, dw, dh);
          drawGhost(k, TINT_NEXT, onion.opacity * fade, dx, dy, dw, dh);
        }
      }

      if (view.scale >= GRID_MIN_SCALE) drawGrid(dx, dy, dw, dh);

      ctx.strokeStyle = BORDER_COLOR;
      ctx.lineWidth = 1;
      ctx.strokeRect(dx + 0.5, dy + 0.5, dw - 1, dh - 1);
    }
  }

  resize();
  cursor();

  return {
    view,
    fit,
    requestRender,
    isDrawing: () => drawing,
    onion: () => onion,
    // Composição de um frame num buffer (mesma ordem e mesmo blend do render): é o único
    // caminho de blend, usado pelo export (PNG/GIF/sheet) para não duplicar a fórmula.
    composeInto,
    setOnion(next = {}) {
      onion = {
        enabled: Boolean(next.enabled ?? onion.enabled),
        count: Number.isFinite(next.count) ? clamp(Math.floor(next.count), 1, ONION_MAX_FRAMES) : onion.count,
        opacity: Number.isFinite(next.opacity) ? clamp(next.opacity, 0, 1) : onion.opacity,
      };
      requestRender();
    },
    setTool(next) {
      tool?.onUp?.();
      drawing = false;
      tool = next;
      cursor();
    },
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      drawing = false;
      unsubscribeDoc();
      observer.disconnect();
      for (const { target, type, fn, opts } of listeners) target.removeEventListener(type, fn, opts);
      listeners.length = 0;
      tool = null;
      checker = null;
      composite = null;
      frameBuffer = null;
      ghost = null;
      ghostCtx = null;
      ghostBuffer = null;
      ghostImage = null;
    },
  };
}
