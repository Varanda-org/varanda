# feat/media-alt-text

Parte de #80: descrição de fotos e vídeos para leitores de tela. Ficam de fora o download só no Wi-Fi (depende de #48), as listas de hash (dependem de #79), descrições em conversas e grupos, e editar a descrição depois de publicar.

## O que mudou

- Formato (`docs/protocol.md`, seção 2 e seção 18): registro companheiro `post-alt` `{ type, seq, alt, at }`, no bloco P+1 (ou P+2, logo depois de um `post-thumbs`), com uma descrição por item de `media` (`null` onde não há), de 1 a 140 caracteres (`MAX_ALT`), uma linha só e sem surrogate solto. No vídeo, o escritor manda `[null, descrição]`. Leitor antigo recusa o tipo desconhecido como bloco isolado e segue lendo a publicação (V3).
- Regra de leitura: vale o `post-alt` vivo e válido de menor bloco entre P+1 e P+2 que nomeia P, e só se a lista tiver o tamanho de `media`. Nunca esconde nem reordena a publicação.
- RPC (`docs/rpc.md`): `alt` em `post.create`, `post.reply` e `post.quote` e nas ops de Página; `alt: true` em `feed.read`, `peek.read` e `diary.peek`. A lista de descrições cabe antes das miniaturas no limite de `MAX_MESSAGE` (`fitAlt`).
- Apagar a publicação apaga o `post-alt` no mesmo append (tombstone simples, sem faixas de mídia); as varreduras de órfãos e o fechamento da Página também o levam.
- Semeador: `postPublic` devolve `alt`, e a página `/p/` o usa como `alt` de cada `<img>` (com `cleanCut` e `esc`; sem descrição, continua `Foto N` ou `Capa do vídeo`).
- App: no Publicar, uma linha "Descrição para leitores de tela" com o (i) (`HELP.descricaoMidia`) e um campo por foto (ou um para o vídeo). As leituras que pedem `thumbs: true` pedem também `alt: true`, e a descrição chega ao `accessibilityLabel` da foto no feed, no carrossel, na foto ampliada, nas citações e no vídeo, sempre por `apps/app/src/mediaAlt.js` (`displayText`, corte em 140). Nenhuma legenda visível foi acrescentada.

## Testes

- `packages/core/test/records.test.js`, `compat.test.js` e `post-alt.test.js`: ida e volta do formato, limite de 140, recusas (`post-alt-invalid`, `alt-invalid`, `malformed`), leitor antigo (fixture com o tipo desconhecido) e a regra P+1/P+2.
- `packages/core/test/feed.test.js`, `peek.test.js`, `delete-session.test.js`; `packages/rpc/test/methods.test.js` e `sizes.test.js` (resposta cheia com descrições e miniaturas dentro de `MAX_MESSAGE`).
- `packages/web-member/test/session-media.test.js`, `delete.test.js`, `peek.test.js`, `diary-peek.test.js`.
- `apps/cli/test/pages-writer.test.js`, `pages-media.test.js`, `post-page.test.js`, `seeder-post-http.test.js`; `packages/core/test/seeder-post-public.test.js`.
- `apps/app/test/mediaAlt.test.js` (rótulo em módulo puro, corte, entrada limpa), `feedSnapshot`, `peekSnapshot`, `thread`, `topics`, `carousel`, `feedRender`, `peekKeep` e os testes do Publicar (`videoCompose`, `postShareCompose`, `musicDraft`).

## Comandos

```sh
npm run lint
node packages/core/test/post-alt.test.js
node apps/app/test/mediaAlt.test.js
npm run demo   # DEMO OK
```

Localmente rodaram o lint, os arquivos de teste alterados e os que importam módulos alterados, e a demo. A suíte inteira roda na CI do PR.

## Não conferido

- Leitor de tela de verdade (TalkBack, VoiceOver, leitor do navegador) e o campo no Publicar com o teclado aberto no emulador Android e no simulador iOS: não rodados nesta sessão.
- O build nativo grava publicações com mídia só pela versão web, como antes; o nó do core recusa `media` e, portanto, `alt`.
