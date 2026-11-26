# Reabertura da Espiadinha com a página guardada

Este PR sai em sequência com `feat/private-cache`, sem lançamento intermediário. Os Termos 112 cobrem os dois.

## Testes locais

O comando `npm run lint` passou com `XDG_CACHE_HOME` apontado para um diretório temporário gravável.

Passaram os testes direcionados de cópia da página, armazenamento de fotos e integração com os caches de mídia.

- `node apps/app/test/espiadinhaSnapshot.test.js`
- `node apps/app/test/peek.test.js`
- `node apps/app/test/peekSnapshot.test.js`
- `node apps/app/test/peekPhotoStore.test.js`
- `node apps/app/test/peekPhotosWeb.test.js`
- `node apps/app/test/peekKeep.test.js`
- `node apps/app/test/peekKeepWeb.test.js`
- `node apps/app/test/mediaKeep.test.js`
- `node apps/app/test/mediaKeptLoad.test.js`
- `node apps/app/test/localCaches.test.js`
- `node apps/app/test/legal.test.js`
- `node apps/site/test/legal.test.js`
- `node packages/core/test/terms.test.js`

## Roteiro de verificação manual

No Android, no iOS, na web e no PWA instalado, use a Espiadinha com a conta pessoal em uma instalação hospedada e com publicações com fotos de quem você não segue.

1. Abra a Espiadinha, espere a lista e as fotos carregarem, feche o app e reabra. Confirme que a cópia fica oculta até `block.list` responder, e que então a página e as fotos guardadas aparecem enquanto a página atual é buscada. Com o app fechado, peça a uma dessas pessoas que publique. Reabra, confirme que a lista guardada continua na tela com a pílula "ver novidades" e toque nela para ver a lista atualizada.
2. Bloqueie alguém que tenha uma linha com foto na cópia. Confirme que as linhas e as fotos correspondentes somem da tela e do armazenamento e não voltam ao reabrir.
3. Com a cópia preenchida, saia da conta. No cache do app nativo, confirme que `varanda-screen-espiadinha.json` e suas variantes `.bak` e `.tmp` sumiram e que não sobraram arquivos de fotos em `varanda-media-keep/peekAvatars` nem em `varanda-media-keep/peekPosts`. Na web e no PWA instalado, confirme que a chave `varanda-screen-espiadinha` saiu do `localStorage` e que os armazenamentos do banco IndexedDB `varanda-peek-photos` estão vazios. Entre novamente, preencha a cópia e repita a verificação depois de trancar a sessão.
4. Na web, abra o painel Rede com o cache do navegador habilitado e carregue fotos da Espiadinha que ainda não estejam no IndexedDB. Confirme que as requisições das fotos usam `cache: 'no-store'` e que o painel não mostra respostas de cache HTTP. O modo `no-store` é uma opção de `fetch`; se o painel não mostrar essa opção, inspecione a chamada na origem indicada pelo painel.

Verificação manual pendente.
