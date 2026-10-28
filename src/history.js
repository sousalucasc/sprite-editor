// src/history.js — UI do histórico: janela flutuante mostrando a pilha de strokes
// (só diffs), salto para qualquer ponto dela, e o limite de N entradas.
// Regra do AGENTS.md: os listeners criados no corpo usam `win.signal`; o unsubscribe
// do `onChange` é ligado ao abort para não deixar assinatura viva ao fechar.
import { createWindow } from './windows.js';
import { onChange, jumpTo, setHistoryLimit, strokeSummary } from './state.js';

// Bytes de diff guardados nas duas pilhas: prova de que nunca há cópia da imagem inteira.
// Só strokes de pixel têm `index`; os estruturais (add/remove/move/prop/frame-remove) não
// carregam pixels, então são contados como 0.
function diffPixels(doc) {
  let n = 0;
  for (const s of doc.history) n += s.index?.length ?? 0;
  for (const s of doc.future) n += s.index?.length ?? 0;
  return n;
}

// `steps` é negativo para desfazer (n traços) e positivo para refazer.
function item(steps, text, className) {
  const li = document.createElement('li');
  li.className = className;
  const btn = document.createElement('button');
  btn.textContent = text;
  btn.title = steps === 0 ? 'Estado atual' : `${steps < 0 ? 'Desfazer' : 'Refazer'} ${Math.abs(steps)} traço(s)`;
  btn.dataset.steps = String(steps);
  li.append(btn);
  return li;
}

export function createHistoryWindow(doc, { x = window.innerWidth - 280, y = 150, onOpen, onClose } = {}) {
  function build(body, win) {
    const note = document.createElement('p');
    note.className = 'window-note';

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '512';
    input.step = '1';
    input.value = String(doc.historyLimit);
    input.title = 'Limite de strokes no histórico';
    const caption = document.createElement('span');
    caption.textContent = 'strokes no histórico';
    const limit = document.createElement('label');
    limit.className = 'history-limit';
    limit.append(input, caption);
    // Commita no `change` (blur/Enter), não no `input`: digitar "12" passa por "1",
    // e aplicar o valor parcial podava o histórico de forma irreversível.
    input.addEventListener('change', () => {
      const n = Number(input.value);
      if (Number.isFinite(n) && n >= 1) setHistoryLimit(doc, n);
      input.value = String(doc.historyLimit);
    }, { signal: win.signal });

    const list = document.createElement('ol');
    list.className = 'history-list';

    body.append(note, limit, list);

    let signature = ''; // pilha + limite + tamanho do doc; o playback não muda nada disso
    function render() {
      // O playback troca só doc.frame a cada passo. Reconstruir a lista a cada passo seria
      // O(N) de DOM por frame; a pilha só muda com strokes, limite ou tamanho do doc.
      const sig = `${doc.history.length}|${doc.future.length}|${doc.historyLimit}|${doc.width}|${doc.height}`;
      if (sig === signature) return;
      signature = sig;

      note.textContent =
        `${doc.history.length}/${doc.historyLimit} strokes · ` +
        `${diffPixels(doc)} px em diffs · imagem inteira = ${doc.width * doc.height} px`;

      list.textContent = '';
      // histórico: o mais novo primeiro (é o próximo a ser desfeito); o mais novo é o
      // estado atual, então steps = 0
      for (let i = doc.history.length - 1; i >= 0; i--) {
        list.append(item(i - (doc.history.length - 1), strokeSummary(doc, doc.history[i]), 'history-item'));
      }
      const at = document.createElement('li');
      at.className = 'history-current';
      at.textContent = 'estado atual';
      list.append(at);
      // futuro: o próximo a ser refazido é o último elemento da pilha
      for (let j = doc.future.length - 1; j >= 0; j--) {
        list.append(item(doc.future.length - j, strokeSummary(doc, doc.future[j]), 'history-item undone'));
      }
      // não sobrescreve o campo enquanto o usuário digita o limite
      if (document.activeElement !== input) input.value = String(doc.historyLimit);
    }

    list.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button');
      if (!btn) return;
      const steps = Number(btn.dataset.steps);
      jumpTo(doc, steps < 0 ? { back: -steps } : { fwd: steps });
    });

    const unsubscribe = onChange(doc, render);
    win.signal.addEventListener('abort', unsubscribe); // remove a assinatura do doc ao fechar
    render();
  }

  return createWindow({ title: 'Histórico', x, y, onBody: build, onOpen, onClose });
}
