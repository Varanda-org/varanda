# feat/page-admin-deleted-flag

Parte de #31. Quando um administrador (não o dono) da página de outra pessoa exclui a conta, o serviço de conta já apaga os convites, a oferta de transferência e as chaves pendentes dele (PR #739). Esta é a parte do app. Decisão da manutenção: o dono vê que a conta foi excluída e continua removendo o administrador com "Remover"; nada é removido sozinho.

## O que mudou

- `apps/app/src/pageRoster.js`: `deletedAdmins(rows, answers)`, puro. Recebe as linhas de `rosterRows` e as respostas de `/account/status` por chave e devolve o conjunto das chaves de administrador cuja resposta traz `deleted` igual a `'pendente'` ou `'concluida'`. O dono nunca entra (quem é dono precisa encerrar ou transferir a página antes de excluir a conta). Chave sem resposta, resposta sem `deleted`, com outro valor, `null`, chave fora da lista ou chave herdada do protótipo: sem marca.
- `apps/app/src/screens/PaginaAjustes.js`: depois de cada `page.read` de quem é dono ou administrador (só esses veem a lista nesta tela), `askAccounts` chama `accountStatus` (o cliente que `account.js` já tem) para cada administrador da lista (no máximo `MAX_ADMINS`, 16), com `pagesOrigin(node)`, como as outras chamadas da tela ao serviço de conta. Cada chave é perguntada uma vez por tela enquanto a resposta fica (um `Set` em ref); recarregar a lista depois de uma ação só pergunta por chaves novas. Uma pergunta que falhou (tempo esgotado, 429) sai do `Set` e volta a ser feita só quando a tela recarrega a lista ("Tentar de novo" ou a leitura depois de uma ação). Sem polling e sem temporizador. A tela só carrega quando `pagesOn` diz que o serviço de conta é alcançável (hospedado ou a origem configurada de um nó core), nunca por `Platform.OS`. Na Vitrine, `accountStatus` recusa antes de sair da página. Uma falha é engolida: sem marca, sem texto de erro, e "Remover" continua igual.
- A linha do administrador em Pessoas mostra "Administrador" como antes e, abaixo, a linha fixa "Conta excluída" (`PersonRow`, prop `note`, texto do app, não de um par, sem `numberOfLines`, para quebrar em vez de cortar com fonte grande numa tela estreita). Todos que veem a lista (dono e administradores) veem a marca; só o dono tem "Remover", como antes. O nome continua passando por `whoOf` e `displayText`. Com o @nome apagado pelo serviço e o perfil talvez ilegível, a linha mostra o nome que ainda se consegue ler ou "sem nome", com "Administrador" e "Conta excluída" embaixo.
- Termos e Privacidade (`apps/app/src/legal.js`): nenhuma frase trata do que o dono vê quando um administrador exclui a conta, e a tela só lê uma rota pública já usada pelo app sobre chaves que já estão na lista pública da página. `LEGAL_VERSION` não muda.

## Testes

- `apps/app/test/pageRoster.test.js`, "deletedAdmins flags only admins whose status answer names a deletion": 11 asserções. Antes 9 testes e 38 asserções, agora 10 e 49. Revertido (`pageRoster.js` da `main`): o teste novo falha com `TypeError: deletedAdmins is not a function`.
- `apps/app/test/pageCallers.test.js`, "PaginaAjustes: the deleted-account flag stays informational": 6 asserções sobre o código da tela. `askAccounts(value)` é chamado de um só lugar, depois de `page.read` e só atrás de `value.isOwner === true || value.isAdmin === true`; `note=` só recebe `ACCOUNT_DELETED` ou `''`; a condição de "Remover" continua `isOwner && rosterKnown && r.role === 'admin'`. Antes 5 testes e 16 asserções, agora 6 e 22. Conferido com seis mutações da tela, uma de cada vez, e a tela restaurada depois (idêntica, `cmp`): sem a checagem de dono ou administrador (1 asserção falha); sem a chamada (3 falham); `note` com `role` no lugar de `''` (1); `note={ACCOUNT_DELETED}` sempre (1); "Remover" sem `isOwner` (1); "Remover" escondido para quem excluiu a conta (1).

## Comandos

```sh
npx standard apps/app/src/pageRoster.js apps/app/src/screens/PaginaAjustes.js apps/app/test/pageRoster.test.js apps/app/test/pageCallers.test.js
node apps/app/test/pageRoster.test.js      # 10/10, 49/49
node apps/app/test/pageCallers.test.js     # 6/6, 22/22
node apps/app/test/platformGate.test.js    # 6/6, 787/787
node apps/app/test/pages.test.js           # 84/84, 736/736
node apps/app/test/namesCache.test.js      # 20/20, 129/129
node apps/app/test/wordCheck.test.js       # 22/22, 821/821
node apps/app/test/mediaKeptLoad.test.js   # 20/20, 120/120
node apps/app/test/groupScreen.test.js     # 15/15, 113/113
```

Os quatro últimos leem o código de `PaginaAjustes.js` e continuam passando.

## Conferências em aparelho que ficam devendo

Precisam de uma conta entrada, dona de uma página com um administrador que excluiu a conta (um segundo membro, administrador aceito, que pede Excluir conta). Não foram feitas.

- Build de debug do Android (emulador ou aparelho): abrir Páginas > a página > Ajustes da página. Em Pessoas, a linha do administrador mostra "Administrador" e "Conta excluída" embaixo, sem cortar; "Remover" aparece para o dono e remove como antes (assina a lista e a troca de chave). Um administrador comum que ainda está na lista vê a marca e não vê "Remover".
- Simulador iOS: o mesmo.
- Web hospedada e PWA: o mesmo. Com o serviço de conta fora do ar (ou a rede do navegador bloqueando `/account/status`), a lista aparece sem marca, sem erro na tela, e "Remover" funciona.
- Nó core com origem de conta configurada: a pergunta vai para a origem do próprio nó (`pagesOrigin`).
