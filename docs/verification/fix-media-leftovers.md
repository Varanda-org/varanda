# Sobras do núcleo de mídia (branch fix/media-leftovers)

Parte da #129. Muda `packages/core/lib/seeder.js` (`mediaRead`), `packages/web-member/lib/session.js` e `member-ops.js` (rotação do núcleo de mídia), `docs/protocol.md` e `docs/rpc.md`. Nenhum formato de registro, mensagem ou método do RPC muda. Nada muda nos Termos.

- **Leitura única.** `mediaRead` confere que o intervalo é local com um `has(start, end)`, lê só o último bloco para somar o `Content-Length` (`(blocos - 1) x 32768 + último`) e reusa esse bloco no fluxo. Um bloco antes do último com outro tamanho encerra o fluxo com erro, e a rota destrói a resposta.
- **Rotação.** Um item que não cabe no núcleo do aparelho (`MEDIA_FULL`) faz a sessão sortear um nonce novo, gravá-lo em `mediaDevice`, derivar o par novo do PRF que ela já guarda (a mesma derivação do desbloqueio), declarar o núcleo novo e gravar o item nele. Só quando o diário, já em dia com o semeador (a mesma checagem de antes de publicar), declarou menos de 4 núcleos distintos, para nenhum núcleo declarado sair dos 4 mais recentes. No worklet Bare, sem HKDF no WebCrypto, a derivação usa o HKDF injetado na sessão. Sem o PRF, ou com 4 núcleos declarados, a resposta continua `espaço de fotos deste aparelho esgotado`.
- **Cache de `/media`.** Mantido `public, max-age=31536000, immutable`, com o motivo registrado em `docs/protocol.md` (os bytes de um intervalo são assinados e não mudam; um bloqueio faz toda busca nova responder 404 `no-store`). O operador não deve pôr CDN ou cache compartilhado na frente de `/media/*`.

Como verificar, a partir da raiz:

- `node packages/core/test/seeder-media.test.js`: "each block read once" falha no código da `main` (cada bloco era lido duas vezes) e passa com a mudança.
- `node packages/web-member/test/session-media.test.js`: o teste da rotação falha na `main` com `espaço de fotos deste aparelho esgotado` e passa com a mudança; o teste sem HKDF no WebCrypto falha se a rotação não passa o HKDF injetado; o teste com o portão de escrita recusando falha se a rotação não espera o diário ficar em dia (o nonce mudaria); o teste com 4 núcleos declarados confere que não há rotação; o teste antigo sem PRF continua com uma só tentativa. `media-ops.test.js` confere o novo campo `room`.
- `node apps/cli/test/seed-ws.test.js`: o teste novo confere o cabeçalho de um ano e o 404 `no-store` da mesma URL depois que o semeador a recusa.
- Também rodaram, um arquivo por vez: `seeder-delete`, `seeder-feira` e `seeder-post-public` de `packages/core/test/`; `seed-ws-link`, `seeder-post-http`, `seeder-feira-http`, `account-pages`, `gif-routes`, `hosted-lab`, `pages-writer`, `caddyfile` e `deploy` de `apps/cli/test/`; `session-hkdf`, `e2e-media`, `e2e-delete`, `e2e-delete-purge`, `private-ops`, `delete`, `delete-purge`, `lease`, `post-share`, `resume`, `sync-media`, `charter-devices`, `community-ops`, `group-ops`, `groups-e2e` e `listing-write` de `packages/web-member/test/`; `identityInstall`, `identityRecoveryNative`, `devices` e `webnodeHandle` de `apps/app/test/`.
- `npm run lint` e `npm run demo`; a suíte inteira roda na CI do GitHub.

Limites (continuam na #129):

- Bytes enviados para uma publicação que depois falhou continuam no núcleo, públicos e sem referência. O limite é a cota do núcleo; não há coleta, porque um `delete` só limpa intervalos de mídia junto com a publicação que apaga. Recolhê-los pede uma lápide nova no protocolo, decisão dos mantenedores.
- A rotação gasta uma das 4 declarações do diário: depois de 4 núcleos, o aparelho volta a recusar fotos.
- Sem conferência em aparelho: a mudança é do nó (`packages/web-member`, o mesmo no navegador e no worklet nativo) e do semeador, sem tela nova; encher 256 MiB num celular não foi feito.
