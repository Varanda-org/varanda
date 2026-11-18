# Apagar momentos da Página sem segui-la (branch feat/page-moments-delete)

## O que mudou

- `apps/cli/lib/account/pages-routes.js`: a leitura assinada `status` da Página passa a responder `moments`, os momentos da própria Página que não foram apagados, vivos ou com mais de 24 horas, do mais novo ao mais antigo, no máximo 20 (`MAX_STATUS_MOMENTS`), cada um exatamente `{ seq, at, text }`, sem mídia nem música. A leitura continua só para o dono e os administradores (`needHeld`).
- `apps/app/src/pageMoment.js`: `pageMomentsOf(status, pageKey, now)` separa os momentos vivos dos anteriores com a mesma regra de 24 horas dos anéis (`expiresIn`) e descarta o que vier malformado.
- `apps/app/src/screens/Momentos.js`, `screens/Diario.js`: agindo como Página, o perfil mostra `PageMoments` no lugar dos momentos da pessoa, com **Apagar** em cada um pela ação `delete` da Página (`ConfirmMomentDelete` com `page`). Uma leitura que falha mostra o erro e **Tentar de novo**, que só lê de novo. O caminho da pessoa não muda; agindo como Página, a lista da Página substitui a da pessoa no Diário.
- `docs/protocol.md`, `docs/rpc.md`, `docs/app.md`: o campo `moments` do `status` e a lista no perfil da Página.

Sem mudança no texto legal: a lista mostra a quem administra a Página o que já está no diário público dela.

## Como verificar

Testes automáticos, a partir da raiz, cada arquivo sozinho:

```sh
node apps/cli/test/pages-moment.test.js
node apps/cli/test/account-pages.test.js
node apps/cli/test/pages-choice.test.js
node apps/app/test/pageMoment.test.js
node apps/app/test/momentosScreen.test.js
node apps/app/test/diarioSnapshot.test.js
```

## Conferir no app (pessoas)

Ordem: Android (build de debug), simulador iOS, depois web e PWA.

- [ ] Com uma conta que administra uma Página e não a segue, agir como a Página e abrir o perfil: o momento recente aparece na lista, com Apagar. Pendente.
- [ ] Apagar esse momento: some da lista e dos anéis de quem segue a Página. Pendente.
- [ ] Um momento com mais de 24 horas aparece entre os anteriores e pode ser apagado. Pendente.
- [ ] Voltar a agir como pessoa: o perfil mostra os momentos da pessoa, como antes. Pendente.

## Não verificado / limites conhecidos

- O caso do administrador (não o dono) não tem teste automático próprio: precisaria do convite e do aceite. A leitura `status` já é a mesma para dono e administradores (`needHeld`).
- Só os 20 momentos mais novos da Página aparecem. Um mais antigo que esses continua no diário até a Página ser encerrada.
