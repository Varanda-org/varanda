# Origem de mídia no app web dos servidores por imagem

Branch `fix/pull-shell-media-origin`. Num servidor em modo pull, o `update.sh` copia o app web da imagem web assinada sem mudar nada, e a imagem é construída pelo `release.yml` sem `VARANDA_MEDIA_ORIGIN`. O `finish-web.js` gravava então uma origem vazia no `sw.js`, e o CSP do app guardado (o que o service worker serve sem rede, numa navegação que falha ou depois de `NAV_TIMEOUT_MS`) não tinha o CDN em `connect-src`. O CSP do Caddy (`@comMidia`) e o modo push (`build-web.sh`) já estavam certos.

## Desenho

- **Refazer na instalação, não no build.** A imagem web vale para toda instalação e o `release.json` a fixa por digest; uma imagem por origem não cabe nesse modelo, e o `sw.js` não pode ler a origem em tempo de execução sem mudar o que o service worker confia. O `update.sh` (`aplicar_origem_midia`) roda o mesmo `finish-web.js` numa cópia do app da imagem, com a origem do `varanda.env`: sai exatamente o que um build com a origem produziria, então a origem continua fazendo parte da versão (o nome do cache, a marca `varanda-release` e a cópia `varanda-node-<versão>.js` mudam juntos).
- **As assinaturas não mudam.** O `finish-web.js` e o modelo `sw.js` passam a ir na imagem do semeador (`deploy/seeder/Dockerfile`, `.dockerignore`), em `/app/apps/app/scripts`, de root. Quem roda é a imagem do semeador da mesma versão, já conferida pelo cosign antes de qualquer cópia, num contêiner `--network none --read-only --cap-drop ALL --security-opt no-new-privileges` que só vê a cópia de trabalho (`$state/www-midia`). A imagem web e o `release.json` não mudam.
- **O `servido_igual sw.js` continua valendo.** A troca é no `www` da versão, antes do compose e da sonda; a sonda compara o que o Caddy serve com esse `www`. A ordem é a do `mesclar_www`: a cópia nova do nó, o `sw.js`, o `index.html`, e só então sai a cópia antiga.
- **Onde roda:** ao preparar uma versão (`preparar_www`, logo depois de copiar a imagem e antes das associações e do `version.json`) e no `reconfigure` (e no `apply` em dia depois de uma intervenção, `subir_instalada`), antes de `gravar_associacoes`. O `.well-known` fica fora da cópia de trabalho, como no build, assim como as cópias `.midia` que uma troca interrompida tenha deixado, e o `version.json` não entra na conta da versão.
- **Nada a fazer quando já está certo:** se a linha `const MEDIA_ORIGIN = "<origem>"` do `sw.js` já é a do `varanda.env` (o caso comum, sem CDN), nenhum contêiner roda. Sem origem, a mesma conta devolve os bytes da imagem.
- **Seguem como estão, com uma linha no registro:** um `sw.js` sem `MEDIA_ORIGIN` (app anterior ao CDN) e uma imagem do semeador sem o `finish-web.js` (`test -f` sai com 1). Qualquer outra falha (docker, o render, o resultado sem a origem certa, sem a marca de versão ou sem a cópia do nó, link ou arquivo especial) faz o `apply` não seguir ("nada mudou") e o `reconfigure` sair com 1, sem compose up.

## Conferido

- `apps/cli/test/update.test.js`, com `docker` simulado: o render do teste chama o `finish-web.js` real na cópia montada.
  - `apply` no perfil full com a origem: `sw.js`, `index.html` e a cópia do nó em `releases/<commit>/www` são byte a byte os de um build com a origem, com outra versão; o `version.json` é o gravado por root; os dois `docker run` (o `test -f` e o `node`) têm exatamente as opções travadas, a imagem do semeador da versão e só a montagem da cópia; o render vem antes de qualquer `up`; a cópia de trabalho some. Um render que falha faz o `apply` falhar sem `up` e sem mudar `state/atual`.
  - `reconfigure` liga a origem (bytes de um build com ela, `.well-known` preservado em `www` e fora do precache, uma cópia `.midia` que uma troca interrompida deixou fora da versão e substituída), não roda nada de novo com a mesma origem, e desliga (bytes e versão da imagem de volta), sem rodar nada de novo depois.
  - App anterior ao CDN: segue como está, com a linha no registro e sem contêiner. Imagem sem o `finish-web.js`: só o `test -f` roda e o app fica como está. `docker` com erro (125) e render que falha: `reconfigure` sai com 1, sem `up`, com o app intacto e sem cópia de trabalho.
  - Sem a correção (o `update.sh` da `main`), os três testes novos falham (24 asserções); com ela, passam.
- `apps/app/test/sw.test.js`: rodar o `finishWeb` de novo, com a origem, num app já terminado sem ela (com `version.json`) dá a versão e os bytes de um build com a origem e deixa só a cópia nova do nó; rodar de novo sem a origem devolve a versão e os bytes de antes.
- `apps/cli/test/seeder-image.test.js`: com só os arquivos que o `.dockerignore` admite, o `finish-web.js` carrega, o modelo `sw.js` resolve, nada além do próprio `finish-web.js` é carregado, e outro script de `apps/app/scripts` fica de fora. Sem as duas linhas novas do `.dockerignore`, o teste falha.
- `apps/cli/test/release-bundle.test.js`: o `.dockerignore` admite exatamente os arquivos de antes mais os dois, e o `COPY` deles vai para `/app/apps/app/scripts`, antes do `USER node`.
- `bash -n deploy/seeder/update.sh`, `npm run lint`, os arquivos de teste acima e `npm run demo` (com a saída "DEMO OK"). A suíte inteira roda na CI do PR.

## Não conferido

- Nenhuma imagem real foi construída nem rodada (`docker` simulado em todos os testes): que o `node` da imagem do semeador roda o `finish-web.js` com `--read-only`, `--cap-drop ALL` e `--user 0:0` gravando na montagem, como o `secrets open` já faz, fica para a primeira versão publicada.
- O `update.sh` que prepara uma versão é o da versão instalada: a primeira versão que traz a correção é instalada sem a origem no app, e a grava só no próximo `update.sh reconfigure` (ou com a versão seguinte).
- Uma volta (`rollback` ou a volta automática) sobe o `www` da versão anterior como ele foi preparado, com a origem do ambiente de então, sem refazer.
- Uma origem que o `update.sh` aceita e o `finish-web.js` recusa (uma porta acima de 65535) faz o render falhar e a versão não seguir, com a mensagem genérica do render no registro.
