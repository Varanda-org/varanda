# Lista de certificados do app Android (branch feat/android-cert-list)

Implantação e serviço de conta. Sem mudança de RPC, formato de diário ou Termos.

## O que mudou

- `VARANDA_ANDROID_CERT_SHA256` aceita de 1 a 4 impressões digitais SHA-256, separadas por vírgula sem espaço. Entram o certificado de assinatura do app no Play Console e, enquanto houver conferência com o APK de preview, o do keystore do EAS. A chave pública de depuração nunca entra (`docs/development.md`, "What the local loop cannot do").
- `deploy/seeder/well-known.sh` publica todas no `assetlinks.json`, na ordem dada, com `get_login_creds` e `handle_all_urls`. Um só certificado gera os mesmos bytes de antes. O `apple-app-site-association` continua com `/anuncio/*` e `/publicacao/*`.
- O serviço de conta (`apps/cli/lib/account/webauthn.js` `parseAndroidCerts` e `passkeyOrigins`) aceita uma origem `android:apk-key-hash:` por certificado, na passkey extra e em Excluir conta. `readAndroidCertEnv` usa o mesmo leitor.
- Recusados, sem nunca imprimir o valor: repetição (não há remoção silenciosa), item vazio, espaço dentro, minúscula, forma errada, um quinto valor e a chave pública de depuração do React Native (`apps/app/android/app/debug.keystore`, cuja chave privada é pública), sozinha ou numa lista. A implantação para com o nome da variável; o serviço recusa subir com `VARANDA_ANDROID_CERT_SHA256 inválido`. Vazio continua desligando a entrada pelo app Android.
- Documentação: `README.md`, `deploy/seeder/.env.example`, `deploy/seeder/compose.web.yaml` e `docs/protocol.md` ("Account deletion") falam da lista.

## Limitação conhecida

Qualquer mudança na lista (pôr, trocar ou tirar um certificado) e rodar a implantação de novo sem commit novo só regrava os arquivos de associação (`deploy.sh` e `update.sh` pulam a reconstrução). O serviço de conta calcula as origens uma vez, ao subir, e continua com a lista antiga até o contêiner `account` ser recriado. Reiniciar não basta: o contêiner lê o `.env` só ao ser criado (`compose.web.yaml` passa a variável por interpolação). Numa instalação por checkout, recrie na implantação de um commit novo ou com `docker compose -f deploy/seeder/compose.yaml -f deploy/seeder/compose.web.yaml up -d --force-recreate account`. Numa instalação por versão, `update.sh reconfigure` depois de editar `/etc/varanda/varanda.env` roda `compose up -d --no-build` (sem `--force-recreate`) com o ambiente efetivo novo; o compose recria o serviço cujo ambiente interpolado mudou, então o `account` é recriado, mas isso decorre do comportamento do compose e não foi rodado aqui (sem docker). Confira com `update.sh compose ps` que o `account` subiu há pouco. O `.env.example` e o README avisam. O comportamento já existia na `main`.

A asserção é assinada pela chave da passkey, não pelo certificado do Android: os testes usam uma passkey de teste e mudam só a origem informada.

## Testes

- [x] Uma tabela com os mesmos valores aceitos (vazio, um, dois, quatro) e recusados (cinco, repetição, item vazio, espaço, aspas em cada item, minúscula, forma errada, a chave pública de depuração sozinha e numa lista) passa por `parseAndroidCerts` e por `ler_associacoes` de `well-known.sh` (`apps/cli/test/deploy.test.js`)
- [x] Passkey extra e Excluir conta: a asserção da passkey de teste passa com a origem de cada certificado da lista e é recusada (`passkey-invalida`, `passkey-origem` no registro) com um certificado fora dela (`account-passkey.test.js`, `account-delete.test.js`)
- [x] Prova de regressão, rodada de verdade: com a repetição tirada do leitor JS, falham `webauthn.test.js` (3 testes) e a tabela de `deploy.test.js`; com `well-known.sh` aceitando repetição e cinco valores, falham o teste de implantação e a tabela; com só o primeiro certificado virando origem, falham os testes novos de passkey extra e de exclusão. Sem a recusa da chave pública de depuração no JS, falham 6 asserções em `webauthn.test.js` e 2 na tabela de `deploy.test.js`; sem ela em `well-known.sh`, falham 6 asserções da tabela. Com o código de volta, tudo passa.
- [x] Arquivos de teste alvo, cada um sozinho com `node <arquivo>`: webauthn, deploy, update, account-passkey, account-delete, cli, caddyfile, readme-help, release-bundle e os testes de `apps/site`
- [x] `node apps/site/scripts/render-legal.js --check`
- [x] `bash -n deploy/seeder/well-known.sh`
- [x] `npm run lint`
- [x] `npm run demo` (termina com "DEMO OK")

A suíte completa roda na CI do GitHub do PR (Node 20 e 24).

## O que fica para o mantenedor

Depois do primeiro envio ao Play Console e antes do teste fechado:

- [ ] Pôr em `VARANDA_ANDROID_CERT_SHA256` o SHA-256 do certificado de assinatura do app do Google Play e o do keystore do EAS (upload), separados por vírgula
- [ ] Recriar o contêiner `account` (checkout: `docker compose -f deploy/seeder/compose.yaml -f deploy/seeder/compose.web.yaml up -d --force-recreate account`; instalação por versão: `update.sh reconfigure`), antes das conferências de passkey no build do Play
- [ ] Implantar e conferir que o `assetlinks.json` público lista os dois
- [ ] `adb shell pm get-app-links app.varanda` mostra o domínio verificado
- [ ] Num build instalado pelo Play e num APK do EAS: entrar com a passkey, adicionar uma passkey extra, a volta do navegador, os App Links e Excluir conta na hora
- [ ] A chave pública de depuração fica fora da produção
