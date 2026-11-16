# Sobras de Páginas: custo de uma chave vazada e lápides (branch fix/paginas-chave-vazada)

Parte da #352, os quatro itens "Do #332". Não muda formato de registro, RPC nem Termos. `docs/protocol.md` §12 ("Residual risks") ganhou três linhas sobre o que mudou.

- **CPU com chave vazada.** `packages/core/lib/name-index.js` não confere de novo uma cópia de uma Página já conhecida que não pode mudar a dica: qualquer tipo além de `page-close` e `page-moved`, ou um desses no fim já achado ou depois dele. `packages/core/lib/sync.js` guarda, por diário, as seqs de `page-close` e `page-moved` que falharam na conferência por um motivo que não seja emissor revogado nem uma exceção durante a conferência (no máximo 4096, em memória), e uma passagem seguinte (reescaneamento, bloco atrasado) não as confere de novo. `downloadExceptPages` (`packages/core/lib/deletion.js`) junta uma rajada de downloads ao refresh que já está na fila, em vez de reler todos os alvos a cada bloco.
- **Par desatualizado no nó core.** `pageTargets(core, { remember: true })` grava em `core.setUserData('varanda/page-read', ...)` as seqs de alvo de lápide que já leu como algo que não é `page-*` (uint32, no máximo 4096). Depois de reiniciar, quem segue a Página não pede esses blocos de novo. Só o seguidor do nó core usa `remember`; o semeador continua em memória e relê cada alvo uma vez depois de reiniciar. O tipo de um bloco não muda num log assinado, e uma réplica com fork é apagada, então uma seq lembrada continua valendo.
- **`diary.peek` no navegador.** `readPeek` (`packages/web-member/lib/sync.js`) mostra um bloco `page-*` guardado que uma lápide nomeia, como o fold. Um post apagado continua em `missing`, e nenhum bloco apagado é pedido a um par.
- **`closeCode`.** Não existe mais em `packages/core/lib/page-lifecycle.js` na `origin/main` (f40cf6f6), e todas as exportações do arquivo têm uso. Nada a fazer.

Como verificar, a partir da raiz:

- `node packages/core/test/name-index.test.js`: o teste "page hint: a copy that cannot change the hint is not verified again" falha sem a mudança.
- `node packages/core/test/deletion.test.js`: "downloadExceptPages remember: a page post read once is not fetched again from a stale peer by the next download, after a reopen" e "downloadExceptPages: a burst of downloads joins the refresh already queued instead of re-reading every target per block" falham sem as mudanças (o segundo conta 52 leituras de alvos em vez de 2).
- `node packages/core/test/sync-page-migrate.test.js`: "page migrate: a rewound walk does not check forged page-moved copies again" falha sem a memória.
- `node packages/web-member/test/pages.test.js`: "diary.peek of a followed page shows a held page-* block a tombstone names, a deleted post stays missing" falha sem a mudança.
- `npm run lint`, `npm test -- --affected=origin/main` e `npm run demo`.

Decisões de Rodrigo para a #352 (16/11/2026), que valem para os PRs seguintes:

- Nó core: paridade completa agora. Conversas, comunidades e remoção de admin como Página também no nó core.
- Página que mudou de chave: as conversas da chave antiga aparecem em Mensagens, só para leitura, sob a Página nova.
- Escopo do nó core confirmado no mesmo dia, depois de saber o tamanho (o motor de Conversas do navegador, cerca de 4.800 linhas, levado ao nó core, que hoje não tem Conversas nem para pessoas): construir agora, dentro da #352, depois que a #351 entrar.
- Limite de 2 encerramentos ou mudanças de chave por 24 h: gravado em `pages.json`, sobrevive a um reinício.
- Limites antigos: Encaminhar aparece agindo como Página (por `dm.pageSend`). O CORS do `varanda-serve` (§89) e o chip de Página que depende da dica do semeador (§102) ficam como limites aceitos.

Limites:

- Nada aqui aparece na tela: não há caminhada no aparelho para este PR.
- Os outros itens da #352 seguem abertos: este PR não a fecha.
