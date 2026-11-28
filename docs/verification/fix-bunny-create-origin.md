# Origem na criação da zona do Bunny

Branch `fix/bunny-create-origin`. O primeiro `apply` real parou na criação da zona: o Bunny respondeu 400 `pullzone.origin_url_required`. Agora a criação manda `OriginUrl: https://origin.invalid` (domínio reservado pela RFC 6761, nunca resolve), e a origem real continua entrando só depois das três regras.

## Conferido

- [x] `node apps/cli/test/bunny.test.js` (20 testes, 603 asserções; antes, 19 testes e 569 asserções). O Bunny simulado agora recusa, como o real, uma criação sem origem, com o mesmo 400 `pullzone.origin_url_required`. O teste do `apply` confere que a criação manda o nome e `https://origin.invalid`, e que o host termina em `.invalid`. Um teste novo para uma execução que para logo depois da criação (falha na primeira regra): a zona fica só com a origem que nunca resolve e sem regras, e um segundo `apply` termina tudo, com a origem real e as três regras.
- [x] Sem a correção (criação só com o nome), o arquivo falha: o `apply` para no 400 `pullzone.origin_url_required`. Com a correção, passa.
- [x] `node apps/cli/test/bunny-precheck.test.js` (29 testes, 353 asserções), que importa o script.
- [x] `npm run lint`.
- [x] `npm run demo` (DEMO OK).
- A suíte inteira roda na CI do GitHub.

## Não conferido

- Se o Bunny real aceita `https://origin.invalid` como origem na criação. O próximo `apply` do mantenedor mostra; se o Bunny recusar, a execução para na criação, sem nada criado.
- Se o Bunny guarda, na criação, um cabeçalho Host de origem tirado de `origin.invalid` e o mantém depois que a origem real entra. Nesse caso a mídia não carrega pelo Bunny (falha fechada, nada fica exposto), e o `verify` do script não percebe; confira o cabeçalho Host da origem no painel da zona.
