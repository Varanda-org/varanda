# Grupos criados em qualquer aparelho de quem criou a comunidade (nó e app)

Branch `feat/community-create-any-device-write`. Este PR traz quem escreve: o nó do navegador grava o `group-create` no escritor da comunidade (CW) deste aparelho quando ele não guarda a raiz, e o app libera Novo grupo nesse aparelho. Os leitores e os semeadores vieram no PR anterior (`docs/verification/feat-community-create-any-device-read.md`).

## Ordem de implantação

Os semeadores e os leitores do PR anterior antes deste app.

## Comportamento

- `group.create` grava na raiz quando este aparelho guarda o nonce dela e a raiz ainda tem poderes; senão, no CW vivo deste aparelho, quando a dobra o conta no conjunto da carta. O cabeçalho do grupo novo continua citando o CW vivo deste aparelho em `member`.
- Um aparelho de quem criou cujo escritor a dobra ainda não conta (antes do `community.join` deste aparelho, ou antes de a dobra contar o CW dele) recebe `este aparelho ainda não pode criar grupos nesta comunidade; aguarde a sincronização` e nada é gravado; antes, recebia `crie pelo aparelho que criou a comunidade`. Quem criou e não é membro da comunidade recebe `sem permissão na comunidade`, como antes. Administradores e membros recebem `só quem criou a comunidade cria grupos`. Depois de uma saída confirmada de quem criou, nenhum aparelho cria (`sem permissão na comunidade`).
- O nó do núcleo (`packages/core/lib/member.js`) não muda: lá o diário é por aparelho, e a recusa antiga continua. O app traduz os dois textos.
- App: `newGroupGate` confere o fim da autoridade antes do aparelho e segue `charterHere`; sem esse campo (nó antigo), mantém a regra de `rootHere`. `repair` não libera Novo grupo. `showNewGroup` segue a mesma regra.

## O que foi rodado

Cada arquivo sozinho, com `node <arquivo>` a partir do workspace:

- `packages/web-member/test/community-create-devices.test.js` (novo): 4/4 testes, 30 asserções. Com o `member-ops.js` anterior (carregado por um gancho de `require`, sem mexer no repositório), o primeiro caso falha na recusa antiga `crie pelo aparelho que criou a comunidade`.
- `packages/web-member/test/community-devices.test.js` 10/10, `charter-devices.test.js` 17/17, `devices-e2e.test.js` 1/1, `devices-auto-e2e.test.js` 1/1: os casos que esperavam a recusa num segundo aparelho que já participa agora criam o grupo no CW desse aparelho, e o aparelho 1 o lista.
- `packages/web-member/test/community-ops.test.js` 80/80: o caso de um CW que a dobra não conta continua recusando, com o texto novo, e agora confere que nada foi gravado.
- `packages/web-member/test/group-ops.test.js` 68/68, `community-sync-cw-create.test.js` 3/3.
- `apps/app/test/newGroup.test.js`: 17/17 testes, 79 asserções; com o `newGroup.js` anterior, 15/17 (74/79).
- `apps/app/test/groups.test.js`: 43/43 testes, 658 asserções; com o `showNewGroup` anterior, 42/43 (656/658).
- `apps/app/test/vitrine.test.js` 69/69 e `group-flow.test.js` 95/95. A vitrine não muda: o `createGroup` dela não confere o aparelho.
- `npx standard` nos arquivos alterados: sem erros.
- Pouso local: `npm run lint`, os arquivos de teste que a pilha alcança (104 do núcleo, 106 do nó do navegador, 48 da CLI, 41 do app, 2 do rpc), sem falha, e `npm run demo` (DEMO OK).

## Limite conhecido

`device.disconnect` nunca marca uma raiz (`docs/rpc.md` 5.154). Um grupo criado num segundo aparelho tem a raiz nele: se esse aparelho se perde e é desconectado, ele continua mudando a carta desse grupo até uma saída de quem criou encerrar os poderes da raiz. Já valia para grupos sem comunidade.

## Fora daqui

A suíte inteira roda na CI do GitHub. A conferência com dois aparelhos da mesma passkey no Android debug, no simulador iOS e na web NÃO foi feita nesta execução: o build de debug não entra com uma passkey de produção (`docs/development.md`).
