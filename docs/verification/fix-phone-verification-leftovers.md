# fix/phone-verification-leftovers

Fecha a #534 (sobras da verificação de celular, serviço `account` e app).

## O que mudou

- `apps/cli/lib/account/start-nonces.js` (novo): códigos de início sem estado para `/account/phone/start` e `/account/age/start`. O código traz a própria validade (10 min) e um HMAC sob um segredo do processo, preso à rota e à chave do membro. Só os códigos já usados ficam numa tabela, que recusa (`expirado`) quando enche em vez de apagar o mais antigo. O tamanho dela vem do balde global (`spentCapacity`: taxa x 10 min + rajada, nunca abaixo de 16384). Um relógio que volta não revive um código usado.
- `apps/cli/lib/account/phone-routes.js`: as tabelas dos limites por membro e por número, dos envios pendentes e do intervalo entre envios têm tamanho `4 x VARANDA_PHONE_DAILY_LIMIT` e nunca apagam uma entrada valendo. Cheias, o envio recusa com `limite-telefone` antes de chamar o Didit e o registro mostra `tabela-cheia`. O envio pendente, que guarda o número, sai da memória quando o código vence: por um temporizador próprio e também no próximo início.
- `apps/cli/lib/account/phone-store.js`, `moderation-store.js` e `server.js`: um membro desbloqueado que depois exclui a conta não tem o número preso de novo pelas denúncias do bloqueio desfeito (decisão do dono, 2026-11-17). O `phone.json` passa à versão 2, com o mapa `cleared`: a varredura anota quando viu o membro sem bloqueio depois das denúncias. Uma denúncia decidida como bloquear depois da exclusão continua prendendo o número. `held` conta qualquer mudança do membro que ainda espera o operador, inclusive o bloqueio da própria exclusão: nenhum membro é liberado enquanto ela espera (nem depois de uma exclusão que falhou no meio, nem com um desbloqueio pendente ao lado do bloqueio que ele desfaz, que pode ser cancelado). Uma denúncia decidida no mesmo milissegundo da marca conta como posterior. Se a varredura falhar durante Excluir conta, a exclusão de um membro bloqueado ou com denúncias de bloqueio espera (`indisponivel`).
- App, Ajustes > "Trocar o celular" (`phone.js`, `usePhoneGate.js`, `Telefone.js`, `Ajustes.js`, `App.js`): o resultado vem da data da confirmação antes e depois. Um envio que o serviço responde com `verificado` diz "Esse já é o seu celular." (nenhum código enviado). Uma data nova diz "Celular atualizado.". Depois de uma conferência sem resposta clara que ainda mostra a data antiga, a tela continua aberta para confirmar o código. Nos outros casos aparece "Não deu para saber se o número mudou.". A linha só aparece numa conta hospedada, com passkey, destravada e com o passo do celular liberado (`phoneChangeShown`).
- Documentos: `docs/protocol.md` (código de início, recusa com as tabelas cheias, `phone.json` v2), `docs/design.md` (limites aceitos pelo dono, a nova regra das denúncias) e o `README.md` (limites, `tabela-cheia`, backup antes de atualizar, ordem judicial).

## Testes

- `apps/cli/test/start-nonces.test.js` (novo, 7 testes): uso único preso ao membro; vencido, malformado ou adulterado é recusado; um código do celular não vale na idade nem depois de reiniciar; a tabela cheia recusa e libera espaço quando vence; o relógio que volta; opções inválidas; o tamanho que cresce com o balde.
- `apps/cli/test/account-phone-burn.test.js` (novo, 9 testes, lojas reais e a lista assinada como no `mod apply`): desbloqueado antes de excluir não volta a prender; excluir com o bloqueio em vigor mantém; bloqueio decidido e ainda não publicado na exclusão prende quando publica; denúncia decidida depois da exclusão prende, mesmo com uma varredura antes da publicação; denúncia decidida enquanto uma exclusão que falhou espera prende; desbloqueio publicado sem varredura antes de excluir é liberado pela varredura da própria exclusão; desbloqueio de um bloqueio já pego pelo operador, cancelado antes da publicação, não libera nada; denúncia nova depois do desbloqueio prende de novo; desbloqueio pendente não solta nada.
- `apps/cli/test/account-phone.test.js`: inundação de inícios não apaga o código de um membro; tabela cheia recusa sem apagar janela valendo; envios pendentes cheios recusam antes do Didit; tamanho das tabelas a partir do teto diário; Excluir conta espera com a varredura falhando para membro bloqueado ou com denúncias antigas, e só para eles; um código vencido sai da memória no próximo início.
- `apps/cli/test/account-age.test.js`: inundação de inícios da idade.
- `apps/cli/test/phone-store.test.js`: o mapa `cleared` (5 testes, incluindo ler um arquivo da versão 1 e gravar na 2).
- `apps/cli/test/moderation-store.test.js`: `held` (o bloqueio pendente da exclusão conta, e um desbloqueio pendente ao lado do bloqueio pego pelo operador também) e `blockReportsAfter` (a denúncia decidida no instante `since` conta).
- `apps/app/test/phone.test.js`: `phoneChange`, `phoneChangeOutcome`, `phoneChangeShown`, e Ajustes e Telefone usando essas regras.
- `apps/app/test/usePhoneGate.test.js`: `proofDate` (inclusive um `markVerified` sem prova que mantém a data lida) e `knownDate`.

## Falha sem a correção

Cada correção foi revertida com o teste mantido, rodada e restaurada:

- Códigos de início, tabelas de limite, `cleared` e `held`: os testes novos de cada área falham com o código da `main` (feito por área, numa cópia temporária de `apps/cli`).
- Denúncia depois da exclusão (`cleared` em `server.js`): `account-phone-burn.test.js` dá 5/6 testes e 49/52 asserções; com a correção, 6/6 e 52/52.
- `held` sem o bloqueio pendente da exclusão: `account-phone-burn.test.js` dá 7/8 e 66/69, `moderation-store.test.js` 77/78 e 613/615; com `>` no lugar de `>=` também, `moderation-store.test.js` dá 76/78. Com a correção, 8/8 e 69/69, 78/78 e 615/615.
- `held` que olha só o resultado das mudanças pendentes (sem contar um desbloqueio ao lado do bloqueio pego pelo operador): `account-phone-burn.test.js` dá 8/9 e 74/77, `moderation-store.test.js` 78/79 e 618/619; com a correção, 9/9 e 77/77, 79/79 e 619/619.
- Sem o `prune()` no início: `account-phone.test.js` dá 38/39 e 438/439; com a correção, 39/39 e 439/439. O temporizador de 10 minutos não tem teste (o relógio dos testes é falso e o temporizador usa o real).
- Exclusão com a varredura falhando e denúncias antigas: `account-phone.test.js` dá 37/38 testes e 433/435 asserções; com a correção, 38/38 e 435/435 (antes do teste do código vencido).
- Envio respondido com `verificado` sempre como "Esse já é o seu celular.": `phone.test.js` dá 21/22; com a correção, 22/22.
- `markVerified` sem prova mantendo a data: a asserção nova de `usePhoneGate.test.js` falha sem o `keep`.

## Comandos

```sh
npx standard <arquivos tocados>
node apps/cli/test/start-nonces.test.js
node apps/cli/test/account-phone-burn.test.js
node apps/cli/test/account-phone.test.js
node apps/cli/test/account-age.test.js
node apps/cli/test/phone-store.test.js
node apps/cli/test/moderation-store.test.js
node apps/app/test/phone.test.js
node apps/app/test/usePhoneGate.test.js
node apps/app/test/phoneEntry.test.js
```

## Aparelhos

- Android (emulador `varanda-api36`, build de debug) e simulador iOS (iPhone 17 Pro), com o JS desta branch servido pelo Metro (porta 8103, `--clear`): os dois abrem na tela de boas-vindas, sem erro. O fluxo de celular com conta não é alcançável aqui: o build de debug não entra com passkey de produção e o iOS depende do domínio associado (`docs/development.md`). Os passos com conta foram para a #224.
- Web, no laboratório hospedado (`node apps/cli/scripts/hosted-lab.js --port 8080 --expo http://127.0.0.1:8103`, DHT local, celular de mentira com o código 123456), em Chrome sem janela com autenticador virtual (ctap2, PRF):
  - cadastro com o passo do celular: envio e código funcionam;
  - Ajustes mostra "Trocar o celular" para a conta vinculada e destravada;
  - o mesmo número volta para a lista com "Esse já é o seu celular.", sem tela de código;
  - um número novo com o código 123456 volta com "Celular atualizado.".

  A conferência do mesmo número rodou antes da última mudança em `phoneChangeOutcome`, que só faz todo envio respondido com `verificado` dizer o mesmo texto. Ela está coberta por `phone.test.js`.

## O que ficou de fora

- "Trocar o celular" no app nativo com conta, no APK de preview e no TestFlight (passos na #224).
- Os formulários de privacidade das lojas (App Store e Google Play) com o número de celular, antes de definir `VARANDA_PHONE_KEY` em produção (na #224).
- Limites aceitos pelo dono, por escrito em `docs/design.md`: o número fica só na memória do serviço, sem cifra, por até 10 minutos entre o envio e a conferência; e, sem resposta da política e sem o atestado `phone-since`, o passo fica desligado naquela abertura.
- Com um limite de envios pendentes menor que o normal (opção só de teste), `room()` pode deixar passar uma entrada a mais quando um pendente vence durante a chamada ao Didit. No tamanho real (`4 x` o teto diário) isso não acontece.
