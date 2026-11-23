# feat/charter-any-device-write

Quem criou a comunidade ou o grupo muda nome, foto, descrição, entrada e administradores em qualquer aparelho da conta que já participa. O nó do navegador escolhe o escritor e expõe `charterHere`; o aplicativo abre os ajustes quando esse campo é verdadeiro. Novo grupo continua no aparelho que criou.

## O que mudou

### Nó do navegador (`packages/web-member`)

- `lib/member-ops.js`: `group.meta`, `group.admin`, `group.image` e `group.about` escrevem na raiz quando este aparelho a tem e a dobra ainda a conta como escritor do estatuto; senão, no escritor vivo do próprio aparelho, quando a dobra o conta e o lista em `charterWriters`; senão, `'sem permissão no grupo'`. Num grupo privado, o registro é selado com o escritor escolhido.
- Na comunidade, `community.meta`, `community.about`, `community.image` e `community.admin` escrevem na raiz enquanto `rootAuthority` vale e este aparelho a tem; senão, no CW vivo contado e listado em `charterWriters`, com as formas de CW (`communityMetaCw`, `communityAboutCw`, `communityImageCw`, `communityGrant`, `communityDemote`). O reparo de quem volta à comunidade não mudou. `everGranted` também lê a nomeação feita pelo CW de quem criou.
- `seen` de um registro fora da raiz segue o contrato de escrita do protocolo, lido de `charterTop` da dobra: o vencedor do campo quando está noutro escritor do criador que não é a raiz; quando o vencedor está no próprio escritor, o que esse vencedor cita, se for um registro desses (num grupo privado, o envelope próprio é aberto com qualquer chave de época entregue a esse escritor); senão, o último registro da raiz que a dobra guarda. Na raiz, `seen` continua `last`.
- `at` de todo registro do estatuto fica depois de cada marca `group-cut` da própria conta naquele grupo.
- Com a raiz do grupo cortada, a demoção pelo CW agora recusa um CW que a dobra da comunidade não conta (acima do limite), em vez de responder `ok` sem efeito.
- `group.info` ganha `charterHere` e `rootAuthority`; `community.info` ganha `charterHere`. O resultado pendente responde `false`.
- `docs/rpc.md`: 5.42, 5.47, 5.49, 5.59, 5.60, 5.69, 5.171, 5.172, 5.174 e 5.175.

### Aplicativo (`apps/app`)

- `src/groups.js`: `charterHere` devolve o booleano ou `null` quando o campo falta. `rootAdminHere` segue esse booleano e, se falta, a regra da raiz. O reparo continua à parte. `deviceStaffNote`, para quem criou sem estatuto neste aparelho, devolve `root` num nó antigo, `ended` quando `rootAuthority` é falso e `wait` no resto. `join` e `staff` não mudam. Novo grupo não muda.
- `src/groupEdit.js`: `editState` devolve `edit` com `charterHere` verdadeiro, `other-device` só quando o campo falta e a raiz não está aqui, `ended` quando o campo é falso e a raiz não tem autoridade, e `wait` no outro caso falso. Quem não criou continua em `none`.
- `src/groupImage.js`: no grupo, `canEdit` exige `charterHere` verdadeiro, ou `rootHere` quando o campo falta. Na comunidade, reparo ou `charterHere` verdadeiro, ou raiz com autoridade quando o campo falta.
- `src/screens/ComunidadeInfo.js`: as notas `root`, `wait` e `ended`, fora do bloco de cargo e de participar.
- `src/screens/GrupoAjustes.js`: as notas `other-device`, `wait` e `ended`.
- `src/vitrine/request.js`: `group.info` ganha `charterHere` (`g.creator === data.own`) e `rootAuthority` (`true`). `community.info` ganha `charterHere` (`c.creator === data.own`).
- `test/group-flow.test.js` não mudou. O cenário da foto não manda `charterHere`, e sem o campo a foto continua na regra da raiz.

## Testes

### Nó do navegador (`packages/web-member/test/charter-devices.test.js`, 17 testes, 120 asserções)

- Comunidade: o segundo aparelho de quem criou, depois de entrar, muda nome, descrição, foto, nomeia e tira um administrador e muda a entrada pelo próprio CW; o aparelho 1 vê cada mudança e o comprimento da sua raiz não muda. `charterHere` é falso antes de entrar e verdadeiro nos dois aparelhos depois.
- O segundo aparelho de um administrador que não criou continua recusado, com `charterHere` falso.
- Grupo sem comunidade, grupo de comunidade e grupo privado: o mesmo, no escritor do próprio aparelho; no grupo privado, também nomear e tirar um administrador. `group.create` no segundo aparelho continua recusado.
- Uma troca de nome do segundo aparelho resiste a uma publicação de membro que cita uma posição futura, e uma troca posterior na raiz vence.
- Um terceiro aparelho cita no `seen` a troca vencedora do segundo.
- `at` depois de uma marca com data futura: a troca do aparelho vence.
- Grupo privado com dois aparelhos fora da raiz se revezando: a troca mais recente de cada um vence no aparelho 1, inclusive duas seguidas do mesmo.
- Uma troca de um escritor cortado na posição 1 nunca entra no `seen`, e a troca de um aparelho vivo vence.
- O mesmo aparelho troca o nome duas vezes seguidas, e as duas valem; também quando a primeira citava outro aparelho.
- Depois que a saída de quem criou cortou a raiz do grupo, o segundo aparelho tira um administrador pelo CW, e os dois aparelhos veem; renomear é recusado, com `charterHere` e `rootAuthority` falsos.
- Depois que quem criou sai (grupo sem comunidade e comunidade), o segundo aparelho fica com `charterHere` falso e renomear é recusado.
- Grupo privado: a troca reabre o próprio envelope vencedor selado numa época que o guardador de chaves não tem mais, e vence.

Arquivos existentes: os objetos exatos de `community-ops.test.js` e `group-ops.test.js` ganharam os campos novos; o teste de `group.about` sem o nonce da raiz agora espera a escrita no escritor vivo e a recusa só com a raiz cortada.

### Aplicativo

- `{ role: 'creator', rootHere: false, charterHere: true }` dá `editState` `edit`, `canEdit` verdadeiro, `rootAdminHere` verdadeiro e `deviceStaffNote` nulo.
- `charterHere: false` dá `wait`. Com `rootAuthority: false`, dá `ended`.
- Sem `charterHere`, segue o de hoje: `root` e `other-device`.
- Administrador que não criou continua sem renomear e sem trocar a foto.
- Segundo aparelho com escritor e sem autoridade (`writerHere` verdadeiro, `rootHere` falso, `authorityHere` falso, `charterHere` falso) recebe `wait`, não a nota antiga que só citava Novo grupo e Ajustes. Com `rootAuthority` falso, recebe `ended`.

## Falha sem a correção

Cada linha troca `packages/web-member/lib/member-ops.js` pela versão indicada, roda `node packages/web-member/test/charter-devices.test.js` e restaura a correção.

| Versão de `member-ops.js` | Resultado |
|---|---|
| `HEAD` (sem a mudança) | o primeiro teste falha em "false before the join" e "device 2 writes the charter" e o arquivo para em `'sem permissão na comunidade'` |
| `seen` sempre o último da raiz | 7/8 (o terceiro aparelho não cita o segundo) |
| `seen` igual a `last` | 4/8 |
| sem a regra de `at` | 7/8 (a marca futura vence) |
| rodada 1 (escolha recalculada) | 10/12: o grupo privado com dois aparelhos e o escritor cortado falham |
| contrato ao pé da letra (vencedor próprio cita a raiz) | 10/12: duas trocas seguidas falham |
| rodada 2 | 15/16: a troca depois de uma época que o guardador não tem perde |
| atual | 16/16 |

Aplicativo, com os fontes de `HEAD`: `groups.test.js` e `groupEdit.test.js` falham ao importar, `groupImage.test.js` 6/7 e `vitrine.test.js` 58/69.

## Quarta rodada

- `groupCharter`, com a raiz de G cortada: a demoção pelo CW agora também exige `cwDemote` de C. A dobra só conta essa demoção depois da porta de C (`repairC`: a geração do CW depois da porta, que existe quando a raiz de C perdeu os poderes, isto é, `cwDemote`). Antes o nó respondia `ok` e a dobra ignorava o registro; agora responde `'sem permissão: a saída anterior ainda não foi confirmada'` e não grava nada.
- `community.admin` com a raiz sem autoridade: um CW que a dobra de C não conta (acima do limite) agora é recusado com `'sem permissão na comunidade'`. Sem teste: precisaria de um nono aparelho da mesma conta.
- Teste novo em `charter-devices.test.js`: com a marca na raiz de G e a raiz de C ainda com poderes, a demoção é recusada e o CW não cresce; depois que quem criou sai de C pelo aparelho da raiz e volta pelo aparelho 2, a demoção vale nos dois aparelhos. Na versão anterior de `member-ops.js` falham "refused before the gate" e "nothing written" (16/17 testes, 118/120 asserções); com a correção, 17/17 e 120/120.

## Comandos

```sh
node packages/web-member/test/charter-devices.test.js       # 17/17, 120 asserções
node packages/web-member/test/community-ops.test.js         # 80/80
node packages/web-member/test/group-ops.test.js             # 68/68
node packages/web-member/test/group-standalone-ops.test.js  # 25/25
node packages/web-member/test/community-devices.test.js     # 10/10
node packages/rpc/test/methods.test.js                      # 180/180
npx standard packages/web-member/lib/member-ops.js packages/web-member/test/community-ops.test.js packages/web-member/test/group-ops.test.js packages/web-member/test/charter-devices.test.js
npm run demo                                                # DEMO OK
node apps/app/test/groups.test.js       # 43/43
node apps/app/test/groupEdit.test.js    # 13/13
node apps/app/test/groupImage.test.js   # 7/7
node apps/app/test/vitrine.test.js      # 69/69
node apps/app/test/group-flow.test.js   # 95/95
npx standard apps/app/src/groups.js apps/app/src/groupEdit.js apps/app/src/groupImage.js apps/app/src/screens/ComunidadeInfo.js apps/app/src/screens/GrupoAjustes.js apps/app/src/vitrine/request.js apps/app/test/groups.test.js apps/app/test/groupEdit.test.js apps/app/test/groupImage.test.js apps/app/test/vitrine.test.js
```

## Não rodado

- Conferência em dois aparelhos da mesma conta no Android debug, no simulador de iOS e na web.
- A demoção pelo CW de quem criou acima do limite de escritores: o teste precisaria de nove aparelhos.
- Um bloco da raiz que a dobra descarta: o nó só grava na raiz registros que passam na validação, então só uma versão mais nova do app o produziria.
- A suíte inteira. A CI do GitHub roda o restante.
