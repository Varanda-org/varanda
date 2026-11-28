# Fotos na tela sobrevivem à chegada da lista de seguidos (branch fix/keep-only-shown-photos)

Refs #980 (limite conhecido em `docs/verification/feat-reopen-complete-copies.md`).

Causa: quando a lista de seguidos chega, A Rua chama `localCaches.keepOnlyAuthors`, que apaga os arquivos guardados de quem deixou de ser seguido. O gancho em `apps/app/src/media/keptLoad.js` limpava inteiros os caches de URLs em memória do `MediaView` e do `Avatar`. Isso revogava os `blob:` na web e apagava os arquivos transitórios no aparelho, inclusive os das fotos já na tela. Uma foto grande de publicação não recarrega depois de um erro de imagem, então ficava em branco.

Mudança:

- `keep.native.js`: `keepOnlyKeptAuthors` devolve os URIs dos arquivos que tentou apagar, inclusive um cuja remoção não conseguiu confirmar (`[]` quando não recebe uma lista, `null` se falhar no meio).
- `media/cache.js`: `restartLoads()` faz com as cargas o que `clear()` faz (uma carga em andamento não é guardada e roda de novo, a pré-busca é cancelada), sem soltar as entradas guardadas.
- `keptLoad.js`: o keep-only esquece só as entradas que apontam para esses arquivos e, se houver algum, reinicia as cargas. Um cache que não consegue esquecer uma entrada por vez é limpo inteiro. A loja da web responde com uma promessa e não entrega URI de arquivo, então nada é solto. Sem resposta (`null`, `undefined`, exceção), vale a limpeza inteira de antes. Limpar tudo e bloquear alguém continuam limpando tudo.

Testes (cada novo falha sem a correção, conferido em `origin/main`):

- `apps/app/test/mediaKeptLoad.test.js`: keep-only que apagou um arquivo solta só ele; keep-only sem arquivo apagado não toca em nada nem repete carga; resposta em promessa (web) não toca em nada; carga que leu o arquivo apagado não é guardada e roda de novo.
- `apps/app/test/mediaCache.test.js`: `restartLoads` mantém as URLs guardadas, repete a carga em andamento e cancela a pré-busca.
- `apps/app/test/mediaKeep.test.js`: `keepOnlyKeptAuthors` devolve exatamente os URIs apagados, e também o de um arquivo cuja remoção não conseguiu confirmar.
- `apps/app/test/peekKeepWeb.test.js`: com a loja real da web, o keep-only não limpa o cache em memória.

Falta, e é manual (Android, iOS e PWA):

1. Seguir alguém com fotos, abrir A Rua e esperar as fotos guardarem.
2. Fechar o app, desligar a internet e reabrir: as fotos e avatares aparecem da cópia.
3. Religar a internet com A Rua aberta e olhar as fotos e avatares de quem aparece citado (pessoas não seguidas) enquanto a lista de seguidos chega: nenhuma fica em branco.
4. Deixar de seguir alguém com fotos guardadas, fechar, reabrir e esperar a lista chegar: as fotos das outras pessoas continuam na tela.
5. Rolar para longe e voltar: as fotos continuam.
