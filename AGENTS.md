# Projeto: editor de pixel art com animação (só front-end)
Stack: HTML + JS puro, ES modules, sem build, sem dependências.
Estrutura: um módulo por responsabilidade (estado, canvas, ferramentas, janelas, timeline). O estado é separado do render.

Regras:
- Undo guarda só diffs de pixels, nunca cópias inteiras da imagem (12 bytes por pixel alterado).
- Todo listener adicionado deve ser removido ao fechar a janela. Listeners recriados em rebuild (linhas de UI) precisam de um AbortController próprio abortado no rebuild (padrão `rowLife` em `src/layers.js`), não só do `win.signal`.
- `createWindow.close()` destrói os descendentes; não guarde estado essencial só numa janela filha.
- Libere buffers ao remover frames ou camadas.
- Não refatore código fora da tarefa.
- `paintPixel` não notifica. Tools devolvem `true` de `onDown`/`onMove` quando mudam pixels; o canvas chama `requestRender()` com esse retorno (preview ao vivo).
- Não permita undo/redo durante um traço ativo: cheque `view.isDrawing()`.
- Strokes estruturais `add`/`remove` são identificados pelo objeto (`stroke.layer`), nunca pelo índice; `pixel`/`prop`/`move` usam índice e são remapeados.
- `doc.layer` precisa continuar válido para o frame ativo após qualquer mudança de frame.
- Rode `node --test tests/state.test.mjs` antes de considerar um passo concluído. Se mexer em undo/estado, adicione um caso lá.

Ao concluir cada tarefa:
1. Marque o passo como feito no PLANO.md, com uma linha dizendo o que foi implementado e quais arquivos mudaram.
2. Anote no PLANO.md qualquer decisão ou limitação que o próximo passo precise saber.
