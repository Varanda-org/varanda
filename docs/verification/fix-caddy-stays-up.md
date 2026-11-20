# O Caddy fica de pé nas atualizações por imagem (branch fix/caddy-stays-up)

Mudança: o `release.yml` constrói `ghcr.io/varanda-org/varanda-caddy` a partir de `deploy/seeder/Dockerfile.caddy`, com a etiqueta `caddy-<sha256 do Dockerfile.caddy>` e o rótulo `org.varanda.dockerfile-caddy`, só quando esse arquivo muda (senão reaproveita a imagem assinada cujo rótulo confere), assina e confere a assinatura, e passa o digest ao build do semeador (`--build-arg VARANDA_CADDY_IMAGE`), que grava `/app/caddy.json` (`{"v":1,"caddy":"ghcr.io/varanda-org/varanda-caddy@sha256:<64>"}`); o `release.json` não muda de formato. O `update.sh` lê e valida o `caddy.json` da imagem conferida e o anota no estado (`caddy=`). No perfil `full`, com o `caddy.json`, o serviço `web` roda essa imagem e monta `/opt/varanda-release/Caddyfile-<sha256 do conteúdo>` em `/etc/caddy/Caddyfile` e `/opt/varanda-release` em `/srv`, onde o link relativo `web -> <commit>/www` faz `/srv/web` continuar sendo o `root` do `Caddyfile`; a troca sobe `seeder account`, troca o link (link novo e `mv -Tf`) e roda `up -d --no-build web`, que o Compose só recria quando a imagem ou o caminho do `Caddyfile` mudou. A volta faz o mesmo com a versão anterior (o Caddy, o `Caddyfile` e o link dela). Sem `caddy.json`, tudo segue como antes. No `deploy.sh`, `publicar_web` monta o app em `.deploy-www` e `mesclar_www` o põe no `www` arquivo a arquivo (cópia temporária e `mv`, o `sw.js` e o `index.html` por último, depois apaga o que saiu), em vez de apagar o `www` e copiar de novo; a volta usa o mesmo caminho a partir de `www-anterior`.

## Comandos de teste

```sh
node apps/cli/test/update.test.js
node apps/cli/test/release.test.js
node apps/cli/test/release-bundle.test.js
node apps/cli/test/web-image.test.js
node apps/cli/test/caddyfile.test.js
node apps/cli/test/deploy.test.js
node apps/cli/test/changelog.test.js
node apps/cli/test/readme-help.test.js
bash -n deploy/seeder/update.sh deploy/seeder/deploy.sh
```

Os testes novos de `update.test.js` (versão só de código não recria o Caddy; `Caddyfile` novo o recria; digest novo do Caddy o recria; uma falha volta ao Caddy, ao `Caddyfile` e ao link anteriores; sem `caddy.json`, o modo antigo), os de `release.test.js` (o Caddy só é construído para um `Dockerfile.caddy` novo e fica em `caddy.json`; o `Dockerfile` só grava `caddy.json` com uma imagem do Caddy) e o de `deploy.test.js` (`mesclar_www` troca o `www` sem esvaziá-lo) falham com os arquivos de antes desta mudança: cada um foi rodado com a versão anterior do script ou do fluxo no lugar.

## Limites conhecidos

- [ ] Nenhuma VM real exercitada: os testes do `update.sh` rodam com `docker` simulado, e o Compose de verdade não foi exercitado (que ele recria o `web` só quando a imagem ou a origem de uma montagem muda, e não o recria quando nada mudou, é o comportamento documentado, não conferido aqui).
- [ ] Não está verificado que o Caddy segue o link `/srv/web` a cada pedido: o `file_server` resolve o caminho a cada pedido, então ele deve servir a versão nova logo depois da troca, mas isso não foi conferido com um Caddy de verdade. Se ele guardar o caminho resolvido, a versão nova só apareceria na próxima recriação do Caddy.
- [ ] Num servidor que já atualiza por imagem, a primeira versão com `caddy.json` é aplicada pelo `update.sh` antigo, no modo antigo (o Caddy é recriado como sempre); a seguinte, com o `update.sh` novo, recria o Caddy mais uma vez, porque as montagens mudam. Só depois disso ele fica de pé nas versões que só mudam o código.
- [ ] O Caddy passa a enxergar `/opt/varanda-release` inteiro, só leitura: os pacotes das versões, que são públicos. Os segredos ficam em `/var/lib/varanda-update`.
- [ ] Um `update.sh compose up` à mão antes da primeira troca no modo novo pode fazer o Docker criar um diretório no caminho do `Caddyfile`; a troca seguinte o apaga antes de gravar o arquivo.
- [ ] A etiqueta `caddy-<hash>` pode ser movida por quem tem escrita no pacote; o `release.yml` só a reaproveita com a assinatura e o rótulo conferidos.
- [ ] Quem mantém precisa tornar público o pacote `varanda-caddy` depois do primeiro `release` que o publicar; sem isso o servidor não baixa a imagem.
- [ ] No `deploy.sh`, um caminho que muda de tipo (arquivo que vira pasta, ou o contrário) fica um instante ausente durante a troca.
