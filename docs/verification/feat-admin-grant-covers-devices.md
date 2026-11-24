# Cargo de administrador nos aparelhos da conta

Executado com Node 24.22.1, cada arquivo sozinho, a partir da raiz. A suíte completa roda na CI do GitHub.

## Testes novos

- `node packages/core/test/group-admin-cover.test.js` (13/13 testes, 65 asserções). Uma concessão cobre os outros aparelhos da mesma geração a partir do primeiro registro de cada um depois dela. Não cobre o que veio antes, um aparelho de geração posterior, um aparelho que o diário cortou nem um aparelho depois de um rebaixamento. Em grupo privado, o aparelho coberto recebe a chave e modera nas duas passagens. A época que ele distribuiu continua legível depois da saída e do rebaixamento. A cobertura vale como a de um aparelho listado: reações e votos (públicos e selados), publicações anteriores depois que o CW se aposenta, admissão do CW em C e a troca de chave exigida pela saída de C.
- `node packages/core/test/group-notice-admin-cover.test.js` (9/9 testes, 56 asserções): o aviso de grupo segue a mesma regra. Dois casos são de comunidade com aprovação: um falha no aviso anterior a esta mudança (o mesmo erro na regra do PR3, pela cobertura de admissão do #350) e o outro falha sem a segunda rodada de correções.
- `node packages/web-member/test/admin-devices.test.js` (3/3 testes, 53 asserções): no nó do navegador, o segundo aparelho da mesma passkey modera a comunidade e seus grupos sem nova concessão. Um registro anterior à cobertura fica sem efeito. Um banimento em grupo privado troca a chave, e o membro banido não lê a mensagem nova.
- `node apps/app/test/groups.test.js` (43/43 testes, 657 asserções): o texto do aviso de cargo indisponível neste aparelho.

## Regressões

- Os testes de `group-admin-cover` falham com a correção revertida em `packages/core/lib/group.js` (cada correção revertida sozinha derruba o seu teste), e voltam a passar com a correção restaurada.
- `admin-devices` falha com a dobra do PR3 (`f37af8562`) com `sem permissão na comunidade`.

## Fixações reescritas para a regra nova

Cada uma mantém um lado negativo (registro anterior, geração posterior ou rebaixamento):

- `packages/core/test/group.test.js`: três testes.
- `packages/core/test/group-private.test.js`: dois testes.
- `packages/core/test/community-fold.test.js`: "admins from root grants with CW cuts" e "authorityWriters: a grant covers the CWs it lists and the unlisted ones of its generation, a demotion at the CW length ends it".
- `packages/core/test/community-member.test.js`: "a grant listing only another device covers this one after it, until a demotion".
- `packages/core/test/group-standalone.test.js`: "admin layers: a grant covers listed writers and the other devices of its generation, a demotion with a cut ends it".
- `packages/core/test/group-standalone-private.test.js`: "banned, departed, demoted, cut, retired and wrong-rejoin writers are not entitled; a covered device is until a demotion".
- `packages/core/test/group-notice.test.js`: em "an admit in C that lists none of the diary's CWs leaves it out", `allowed(X)` passa a ser UNKNOWN em vez de false.
- `packages/web-member/test/community-ops.test.js`: "a community admin bans in a group through its CW; the grant covers its new CW until a demotion" e "a grant listing only another device's CW covers this device's CW too, until a demotion".

## Execuções

| Arquivo | Testes | Asserções |
|---|---|---|
| packages/core: group-admin-cover | 13/13 | 65 |
| group | 166/166 | 1427 |
| group-private | 140/140 | 1067 |
| community-fold | 131/131 | 1213 |
| community-member | 27/27 | 288 |
| community-member-leave-3 | 9/9 | 62 |
| group-standalone | 26/26 | 192 |
| group-standalone-private | 11/11 | 99 |
| group-charter-devices | 35/35 | 193 |
| group-charter-private | 13/13 | 47 |
| record-type-filter | 5/5 | 4987 |
| sync-groups-3 | 26/26 | 144 |
| group-notice | 63/63 | 944 |
| group-notice-admin-cover | 9/9 | 56 |
| packages/web-member: community-ops | 80/80 | 630 |
| admin-devices | 3/3 | 53 |
| apps/app: groups | 43/43 | 657 |

`npx standard` passou nos arquivos alterados.

`packages/core/test/seeder-group-trending.test.js`, teste 1, falhou uma vez em 9 execuções sozinho, no HEAD e na execução direcionada: `settled()` espera `groups.length > 0` antes de todos os escritores serem lidos. É anterior a esta mudança e não é afetado por ela.

## Ordem de implantação

Atualizar primeiro os semeadores e os leitores deste PR. Só depois distribuir o build do app que usa o cargo nos outros aparelhos. Leitores antigos ignoram a cobertura até serem atualizados.
