# Chave das passkeys adicionadas (branch feat/extra-passkey-keys)

Parte da #444, itens 1, 9 e 10. Antes, o serviço de conta guardava só a chave pública da passkey do cadastro, então Excluir conta confirmado com uma passkey adicionada em Ajustes › Passkeys e recuperação, ou criada com o código de recuperação, ficava agendado por 7 dias.

## O que muda

- Serviço de conta: `passkeys.json` versão 2 (cada chave com `lookupId` e `entryAt`, null na passkey do cadastro), até `MAX_KEYS` = 5 chaves. Enquanto nenhuma chave tem `lookupId`, o arquivo é gravado na versão 1, no formato exato da versão anterior. `POST /account/passkey/add` aceita `assertion` (asserção nova, sobre o mesmo nonce, de uma passkey cuja chave o serviço já tem, conferida como numa exclusão) e `lookupId` (a entrada `'passkey'` viva do membro em `recovery.json`). A chave é guardada com a data da entrada (`entryAt`, o `createdAt` dela) e só vale enquanto essa mesma entrada está viva: uma entrada posta de novo no mesmo `lookupId` não a faz valer. A passkey que confirmou precisa continuar guardada no momento da gravação. Remover a entrada apaga a chave ligada a ela. Excluir conta aceita qualquer chave guardada.
- `POST /account/passkey/start` só responde `{ nonce, passkeys, username }` com `list: true`; sem ele continua respondendo exatamente `{ nonce }`, que é o que os apps já instalados leem. `list` diferente de ausente ou `true` é `pedido-invalido`.
- App (`apps/app/src/extraPasskeyKey.js`, `src/account.js`, `src/screens/Passkeys.js`): depois do put da entrada, a tela pede `start` com `list: true`, e, se a passkey que abriu a sessão está na lista, pede a ela a asserção ("Confirme com a passkey deste aparelho para que a passkey nova também confirme a exclusão da conta.") e manda o `add`. Resultado guardado: "A passkey nova também confirma a exclusão da conta."; senão: "A passkey nova já abre a conta. Uma exclusão confirmada só com ela fica agendada por 7 dias.". Uma confirmação que precisa de toque novo (Safari) ou que falhou de forma passageira oferece o botão "Confirmar com a passkey deste aparelho", com um nonce novo. Em "Trocar", a passkey antiga confirma antes de o aparelho se ligar à nova. Acima de "Adicionar passkey", o aviso do item 10. O app nunca repete o `add` sozinho.
- Nó do navegador (`packages/web-member/web/node.js`): `identity.status()` tem `credentialId`; o resultado de `addPasskey` (e do `complete()` dele) traz `attestationObject`, nunca o de uma recuperação por código. App nativo (`src/identity.native.js`): o mesmo resultado, só em memória (depois de reiniciar o app, uma passkey pendente fica sem a chave). `docs/rpc.md` seção 11.
- Termos e Política na versão 81. `docs/protocol.md` ("Account deletion" e `passkeys.json`), README, `docs/design.md` e `docs/app.md` atualizados.

## Comandos e resultados

Da raiz, um arquivo por vez, Node 24.22.1:

- `node apps/cli/test/account-passkey.test.js`: 13 testes, 167 asserções. Novos: "passkey start: the list only on request, so older apps keep reading exactly { nonce }", "extra passkey: another member's stored passkey never vouches" "extra passkey: a key whose entry is gone neither vouches, nor is listed, nor deletes at once" e "extra passkey: an entry put again at the same lookupId does not bring back the key of the removed one".
- `node apps/cli/test/account-delete.test.js` 16/165, `account-recovery.test.js` 18/270 ("removing a passkey entry with no usable passkey store still removes the entry"), `account-recovery-e2e.test.js` 2/100, `passkey-store.test.js` 10/85 (`entryAt` lido e gravado, e recusado sem `lookupId` ou ausente com ele; novo: "only sign-up keys write version 1, the previous build's exact shape; a linked key writes version 2"), `webauthn.test.js` 9/58, `recovery-store.test.js` 39/390: todos passam.
- `node apps/app/test/extraPasskeyKey.test.js`: 7 testes, 69 asserções (arquivo novo).
- `node apps/app/test/account.test.js`: 78/1309. Novo: "passkeyStart with list and passkeyAdd with an assertion".
- `node apps/app/test/passkeysScreen.test.js`: 27/284, dois testes novos.
- `node apps/app/test/identityRecoveryNative.test.js`: 37/203. Novo: "add: the creation's attestation object rides on the add result, direct and after concluir". `identityInstall.test.js` 50/300, `platformGate.test.js` 6/787, `passkeyEnrol.test.js` 5/37.
- `npm test -w packages/web-member` (`web-node-recovery.test.js` 18/270, com as asserções novas de `credentialId` e `attestationObject`) e `npm test -w packages/rpc`.
- Termos: `apps/app/test/legal.test.js` 56/1862 (novo: "legal: version 81 describes the keys of added passkeys, the recovery floor and the passkey lookup"), `terms-version.test.js` 1/2, `apps/site/test/legal.test.js` 7/115, `packages/core/test/terms.test.js` 8/126.
- `apps/cli/test/changelog.test.js` 9/42, `readme-help.test.js` 1/2.
- `npm run lint`: sem apontamentos.

## Falha sem a correção

Conferido em 17/11/2026, com o código restaurado depois:

- `start` respondendo a lista sempre: `account-passkey.test.js` 9/10, 128/139.
- `passkeyStart` sem mandar `list`: `account.test.js` 77/78, 1305/1306.
- `extraPasskeyKey.js` sem a regra "passkey da sessão fora da lista: pula": 5/6, 59/61.
- `node.js` anterior: `web-node-recovery.test.js` 16/18, 266/270.
- `identity.native.js` anterior: `identityRecoveryNative.test.js` 36/37, 201/203.
- `Passkeys.js` anterior: `passkeysScreen.test.js` 25/27, 262/279.
- `legal.js` da versão 80: `legal.test.js` 53/56, 1850/1861.
- `afterCreate` sem o objeto de atestado: `extraPasskeyKey.test.js` 6/7, 64/66; `passkeysScreen.test.js` 26/27, 279/280.
- Texto de Privacidade sem a ressalva da chave guardada: `legal.test.js` 54/56, 1860/1862.
- `toJson` sempre na versão 2: `passkey-store.test.js` 9/10, 72/75.
- `onCheck` sem confirmar antes de ligar: `passkeysScreen.test.js` 26/27, 281/283.
- HTTP 429 lido como recusa: `extraPasskeyKey.test.js` 6/7, 67/69; `call()` sem `err.status`: `account.test.js` 77/78, 1307/1309; início que falha sem oferecer o botão: `passkeysScreen.test.js` 26/27, 283/284.
- Chave extra que vale sem a entrada viva: `account-passkey.test.js` 11/12, 150/156. Remoção da entrada que depende de `passkeys.json`: `account-recovery.test.js` 17/18, 264/270.
- Chave extra conferida só pelo `lookupId`, sem a data da entrada: `account-passkey.test.js` 12/13, 161/167. `passkey-store.js` sem `entryAt`: `passkey-store.test.js` falha nos testes 1 e 3 (9 asserções) e para no 3.

## Conferência manual

Web, 17/11/2026, no laboratório hospedado (`apps/cli/scripts/hosted-lab.js`) com Chrome 157 sem janela e autenticadores virtuais (um do aparelho, outro USB para a passkey nova), contas de teste do laboratório:

- [x] Termos 81: o aceite do cadastro mostra "Versão 81, de 17/11/2026"; em Ajustes, "Você aceitou a versão 81", a Política com a frase da consulta pela chave pública e a ressalva da chave guardada, os Termos de Uso com a passkey adicionada com confirmação. Nenhum "Versão 80".
- [x] Adicionar passkey: o aviso do item 10 fica logo acima do botão; depois da criação, o app pede a passkey da sessão (sem PRF, com verificação do usuário) e mostra "A passkey nova também confirma a exclusão da conta."; `passkey/start` com `list: true` responde a lista e o `add` com `assertion` e `lookupId` responde `{ added: true }`; `delete/start` passa a listar as duas chaves.
- [x] Num aparelho novo, entrar com a passkey adicionada abre a conta; Excluir conta mostra a exclusão na hora ("Excluir conta", não "Agendar exclusão"), confirma com a passkey adicionada e o serviço responde `{ deleted: "pendente" }`; outro aparelho novo com a passkey do cadastro vê "Esta conta foi excluída".
- [x] Confirmação cancelada: o texto da espera e o botão "Confirmar com a passkey deste aparelho", sem `add`; tocar no botão guarda a chave com o nonce já buscado.
- [x] Remover a entrada da passkey adicionada: `delete/start` volta a listar só a chave do cadastro.
- [x] Trocar passkey: a passkey antiga confirma antes de o aparelho se ligar à nova, o `add` responde `{ added: true }`, e Sair seguido de Entrar pede a passkey nova.
- [ ] Safari (segunda cerimônia encadeada): não conferido.
- [ ] PWA instalado: não conferido.
- [ ] Android e iOS: não dá no laboratório local (o app nativo exige https e o rp.id não pode ser um IP). Os passos estão na #224: adicionar com a conta criada no build, cancelar e tocar no botão, entrar com a passkey nova em outro aparelho e excluir uma conta de teste na hora, Trocar, Termos 81 em Ajustes; no iOS, conferir se a criação devolve o objeto de atestado (sem ele, a tela mostra o texto da espera sem pedir a confirmação).

No laboratório, com o autenticador USB presente, um pedido da passkey do aparelho sem `transports` era recusado pelo próprio Chrome; o roteiro acrescentou `transports: ['internal']` a esse pedido, no lugar de escolher "este aparelho" na janela do navegador. Nada mais nos pedidos do app foi mudado.

## Limites

- Uma chave cuja entrada sumiu (uma remoção que chega entre a conferência da entrada e a gravação do `add`, uma remoção com `passkeys.json` inutilizável, ou uma feita por uma versão anterior do serviço) fica no arquivo, sem valer para nada, mesmo se uma entrada for posta de novo no mesmo `lookupId`, até o próximo `add` com `MAX_KEYS` chaves, que a tira (nunca a que confirmou), ou até a exclusão da conta. Uma chave extra só vale enquanto a entrada `'passkey'` dela está viva no `recovery.json`; com o `recovery.json` inutilizável, nenhuma chave extra vale e a exclusão confirmada só com ela espera os 7 dias.
- A mesma passkey posta de novo no mesmo `lookupId` depois de uma remoção que deixou a chave para trás não volta a confirmar na hora: o `add` da mesma credencial responde `{ added: false }` e a chave antiga continua sem valer até o próximo `add` com `MAX_KEYS` chaves tirá-la. A exclusão confirmada só com ela espera os 7 dias.
- Se a resposta do `add` se perde, a tela mostra o texto da espera; a chave pode ter sido guardada. Confirmar de novo (botão, ou adicionar de novo) resolve: a mesma credencial responde `{ added: false }`.
- O botão "Confirmar com a passkey deste aparelho" fica com o nonce de quando apareceu: depois de 10 minutos o serviço responde `expirado` e a tela volta a oferecer o botão com um nonce novo.
- Voltar a uma versão anterior do serviço depois que `passkeys.json` virou versão 2 (só quando a chave de uma passkey adicionada foi guardada) deixa Excluir conta e o envio da chave em 503 até a versão nova voltar.
- Contra um serviço anterior a esta versão, o app não recebe a lista e não pede a confirmação: a passkey nova fica sem chave, como antes.
- Uma passkey criada com o código de recuperação não registra chave: a sessão que a criou não foi aberta por uma passkey com chave guardada.
- No app nativo, o objeto de atestado de uma criação pendente fica só na memória: depois de reiniciar o app, "concluir" liga a passkey sem guardar a chave.
- Entrar com a passkey nova numa versão antiga do app abre uma conta vazia (a versão antiga não conhece a marca); sem versão mínima, a tela de adicionar avisa.
