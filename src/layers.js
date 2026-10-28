// src/layers.js — painel flutuante de camadas: criar, remover, reordenar, ocultar,
// opacidade e camada ativa. Minimalista: uma linha por camada (topo da lista = camada
// do topo da composição). Toda operação passa pela API de src/state.js, que entra no
// histórico como stroke de `kind` (undo integrado).
// Regra do AGENTS.md: listeners do corpo usam `win.signal`; o unsubscribe do `onChange`
// é ligado ao abort para não deixar assinatura viva ao fechar.
import { createWindow } from './windows.js';
import { onChange, addLayer, removeLayer, moveLayer, selectLayer, setLayerVisible, setLayerOpacity, setLayerOpacityLive } from './state.js';

export function createLayersWindow(doc, { x = window.innerWidth - 560, y = 150, getPos, onOpen, onClose } = {}) {
  function build(body, win) {
    const note = document.createElement('p');
    note.className = 'window-note';

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'add-btn';
    addBtn.textContent = 'Nova camada';
    addBtn.title = 'Criar camada acima da do topo';
    addBtn.addEventListener('click', () => addLayer(doc), { signal: win.signal });

    const list = document.createElement('div');
    list.className = 'layer-list';

    body.append(note, list, addBtn);

    let rows = [];
    let signature = ''; // frame + nº de camadas; muda só quando a lista precisa ser reconstruída
    let lastFrames = null; // identidade do array de frames: um import troca todas as camadas (linhas órfãs)
    let rowLife = new AbortController(); // listeners das linhas; abortado a cada rebuild
    win.signal.addEventListener('abort', () => rowLife.abort());

    // Índice atual da linha: busca o objeto no frame, não o dataset (rows sobrevivem à
    // reordenação; o dataset é reescrito a cada render).
    function indexOf(row) {
      return doc.frames[doc.frame].layers.indexOf(row.layer);
    }

    function makeRow(layer) {
      const row = document.createElement('div');
      row.className = 'layer-row';
      row.layer = layer;
      row.addEventListener('click', (ev) => {
        if (ev.target.closest('button, input')) return; // botões/slider fazem a própria op
        const i = indexOf(row);
        if (i !== -1) selectLayer(doc, i);
      }, { signal: rowLife.signal });

      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'layer-eye';
      eye.title = 'Mostrar/ocultar camada';
      eye.addEventListener('click', () => {
        const i = indexOf(row);
        if (i !== -1) setLayerVisible(doc, i, !row.layer.visible);
      }, { signal: rowLife.signal });

      const name = document.createElement('span');
      name.className = 'layer-name';
      name.textContent = layer.name;

      const op = document.createElement('input');
      op.type = 'range';
      op.min = '0';
      op.max = '1';
      op.step = '0.01';
      op.className = 'layer-opacity';
      op.title = 'Opacidade da camada';
      let dragBefore = null; // valor no início do arraste, para o undo voltar ao original
      op.addEventListener('input', () => {
        const i = indexOf(row);
        if (i === -1) return;
        if (dragBefore === null) dragBefore = row.layer.opacity;
        setLayerOpacityLive(doc, i, Number(op.value)); // preview sem stroke
      }, { signal: rowLife.signal });
      op.addEventListener('change', () => {
        const i = indexOf(row);
        if (i === -1) return;
        setLayerOpacity(doc, i, Number(op.value), dragBefore ?? row.layer.opacity); // commit no fim
        dragBefore = null;
      }, { signal: rowLife.signal });

      const pct = document.createElement('span');
      pct.className = 'layer-pct';

      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'layer-up';
      up.textContent = '↑';
      up.title = 'Subir camada';
      up.setAttribute('aria-label', 'Subir camada');
      up.addEventListener('click', () => {
        const i = indexOf(row);
        if (i !== -1) moveLayer(doc, i, i + 1);
      }, { signal: rowLife.signal });

      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'layer-down';
      down.textContent = '↓';
      down.title = 'Descer camada';
      down.setAttribute('aria-label', 'Descer camada');
      down.addEventListener('click', () => {
        const i = indexOf(row);
        if (i !== -1) moveLayer(doc, i, i - 1);
      }, { signal: rowLife.signal });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'layer-del';
      del.textContent = '×';
      del.title = 'Remover camada';
      del.setAttribute('aria-label', 'Remover camada');
      del.addEventListener('click', () => {
        const i = indexOf(row);
        if (i !== -1) removeLayer(doc, i);
      }, { signal: rowLife.signal });

      row.append(eye, name, op, pct, up, down, del);
      row.eye = eye;
      row.op = op;
      row.pct = pct;
      row.up = up;
      row.down = down;
      row.del = del;
      return row;
    }

    function render() {
      const frame = doc.frames[doc.frame];
      const sig = `${doc.frame}|${frame.layers.length}`;
      if (sig !== signature || lastFrames !== doc.frames) {
        signature = sig;
        lastFrames = doc.frames;
        rowLife.abort(); // libera os listeners das linhas antigas imediatamente
        rowLife = new AbortController();
        list.textContent = ''; // rebuild só quando o nº de camadas ou o frame muda
        rows = frame.layers.map((layer) => makeRow(layer));
      }
      // ordem visual: camada do topo da composição (última no array) aparece primeiro;
      // reordenar é só re-anexar as linhas na ordem atual (listeners sobrevivem, vivem
      // em win.signal). rows fica na ordem de criação, por isso o índice atual é buscado.
      const byIndex = [];
      rows.forEach((row) => {
        const idx = frame.layers.indexOf(row.layer);
        if (idx !== -1) byIndex[idx] = row; // camada sumiu via undo antes deste render
        row.classList.toggle('active', idx === doc.layer);
        row.eye.setAttribute('aria-pressed', String(row.layer.visible));
        row.eye.setAttribute('aria-label', row.layer.visible ? 'Ocultar camada' : 'Mostrar camada');
        row.eye.title = row.layer.visible ? 'Ocultar camada' : 'Mostrar camada';
        if (document.activeElement !== row.op) row.op.value = String(row.layer.opacity);
        row.pct.textContent = `${Math.round(row.layer.opacity * 100)}%`;
        row.up.disabled = idx === frame.layers.length - 1;
        row.down.disabled = idx === 0;
        row.del.disabled = frame.layers.length <= 1;
      });
      list.textContent = '';
      for (let i = byIndex.length - 1; i >= 0; i--) if (byIndex[i]) list.append(byIndex[i]);
      note.textContent = `Frame ${doc.frame + 1} · ${frame.layers.length} camada${frame.layers.length > 1 ? 's' : ''} · ativa: ${frame.layers[doc.layer]?.name ?? '—'}`;
    }

    const unsubscribe = onChange(doc, render);
    win.signal.addEventListener('abort', unsubscribe); // remove a assinatura do doc ao fechar
    render();
  }

  return createWindow({ title: 'Camadas', x, y, getPos, onBody: build, onOpen, onClose });
}
