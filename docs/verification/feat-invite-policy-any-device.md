# feat/invite-policy-any-device

Quem pode convidar de uma comunidade, pelo criador, em qualquer aparelho da conta. Sem mudança de protocolo: a dobra já conta o `group-invites` do criador escrito em qualquer escritor de comunidade vivo do diário dele enquanto a raiz tem autoridade (`docs/protocol.md` §10). Só o nó do navegador exigia a raiz.

## O que mudou

- `packages/web-member/lib/member-ops.js`, `communityInvitePolicy`: para o criador, o reparo continua pelo escritor de reparo e o aparelho que guarda a raiz continua escrevendo nela. Num aparelho sem a raiz, com a raiz ainda com autoridade, o registro vai pelo escritor de comunidade vivo deste aparelho quando a dobra lhe dá autoridade; sem ele, `'sem permissão na comunidade'`. Registro e demais checagens iguais.
- `apps/app/src/groups.js`: `invitePolicyHere(info, owner)`; `DEVICE_ROOT_TEXT` deixa de citar Quem pode convidar.
- `apps/app/src/screens/ComunidadeInfo.js`: a linha Quem pode convidar usa `invitePolicyHere`.
- `docs/rpc.md` 5.72 (`community.invitePolicy`): onde o criador escreve.
- `docs/app.md` ("Em outro aparelho da conta"): Quem pode convidar sai da lista do que só aparece no aparelho que criou a comunidade, e o aviso citado passa a ser o novo.

## Testes

`packages/web-member/test/invite-policy-devices.test.js` (novo):

- `the creator's second device sets the invite policy on its own CW after it joins`: antes do `community.join` o segundo aparelho recebe `'sem permissão na comunidade'` e não cria escritor; depois, o registro vai no escritor dele com `group: null`, o aparelho 1 lê `memberInvite` ligado e depois desligado, e o comprimento da raiz no aparelho 1 não muda.
- `device 1 holding the root still writes the invite policy on the root`
- `a member is still refused and an admin still writes on its own CW`

`apps/app/test/groups.test.js`: `invitePolicyHere` (criador no segundo aparelho com `authorityHere: true` é `true`; sem autoridade, ou nó antigo sem o campo, segue a regra da raiz; administrador precisa de autoridade aqui) e o novo texto de `DEVICE_ROOT_TEXT`.

## Falha sem a correção

Com `member-ops.js` da `main`, o primeiro teste novo para no `community.invitePolicy` do segundo aparelho depois do join, com `'sem permissão na comunidade'` vindo de `communityRootWriter`. Restaurada a correção, passa (3/3 testes, 18/18 asserções).

## Comandos

```sh
npx standard packages/web-member/lib/member-ops.js packages/web-member/test/invite-policy-devices.test.js apps/app/src/groups.js apps/app/src/screens/ComunidadeInfo.js apps/app/test/groups.test.js
node packages/web-member/test/invite-policy-devices.test.js   # 3/3, 18/18
node apps/app/test/groups.test.js                             # 43/43, 634/634
node packages/web-member/test/community-devices.test.js       # 10/10, 47/47
node packages/web-member/test/community-ops.test.js           # 80/80, 628/628
node apps/app/test/group-flow.test.js
node apps/app/test/chatActions.test.js
```

## Não rodado

- Conferência no aparelho (Android, iOS, web) com duas instalações da mesma conta.
- A suíte inteira roda na CI do GitHub.
