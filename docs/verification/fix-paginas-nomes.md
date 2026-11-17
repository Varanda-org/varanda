# Nomes em Páginas (branch fix/paginas-nomes)

Parte da #352. Só o app muda (`apps/app`). Não muda formato, RPC nem Termos.

Causa comum: `profile.read` responde `missing` para quem o nó não guarda (a Página e os administradores de outra pessoa), e só um `diary.peek` verificado (`learnVerified`) sobrevive a essa resposta. Um nome vindo de seed (`learnMany`) some no próximo `profile.read`, e as telas de Páginas não pediam o peek para essas chaves.

- **Pessoas em Ajustes da página.** `PaginaAjustes.js` nomeia a Página, o dono, os administradores e quem recebeu uma oferta com o mesmo peek verificado da lista de Conversas (`useRowPeeks`, `apps/app/src/useRowPeeks.js`, que usa `rowPeek.js` e `peerProfile.js`). As chaves vêm de `peopleKeys` (`pageRoster.js`).
- **Confirmar remoção.** A pergunta cita nome e @nome (`whoLabel`, `who.js`): "Remover Caio Membro (@caio) da administração da página?".
- **Nome que não some.** `names.js` não deixa um `profile.read` sem nome, sem bio e sem foto tirar o que um peek verificado já disse (`fillFromPeek` e `settleProfile`, `namesCache.js`): nome, bio, foto e @nome voltam juntos, e só nesse caso. Uma resposta com qualquer um desses campos é o perfil mais novo e seus vazios valem (foto ou bio removidas, @nome revogado). Paginas passa a guardar o peek como verificado, não como seed, e `NovaPagina.js` guarda o nome, o @nome e a bio exatamente como foram enviados.
- **Salvar e trocar @nome.** Depois de salvar nome, bio ou foto, ou de trocar o @nome, `PaginaAjustes.js` troca o peek guardado pelo que o serviço aceitou (`keptProfile`), para um `profile.read` `missing` não trazer o nome ou o @nome antigos de volta.
- **Pedidos de mensagem da Página.** `Mensagens.js` nomeia quem enviou o pedido com o mesmo peek.
- **Encerrar página.** O primeiro aviso cita o @nome porque o @nome agora fica conhecido (`closeWarning` não mudou).

Como verificar, a partir da raiz:

- `node apps/app/test/namesCache.test.js`: "fillFromPeek keeps a verified peek only for an answer with nothing at all" falha sem `fillFromPeek` (inclui o caso `{ name: 'Novo', bio: null, avatar: null }`); "settleProfile keeps the peek only while it filled the answer" e "names.js settles a profile.read answer through settleProfile" falham sem `settleProfile` em `names.js`; "keptProfile is what a save or a rename leaves as the verified entry" falha sem `keptProfile`; "the Páginas screens name people through verified peeks, not seeds" falha sem `learnVerified` em Páginas e Nova página, sem `useRowPeeks` com a janela inteira e as duas chamadas de `learnVerified` (salvar e trocar @nome) em Ajustes e sem `useRowPeeks` na lista de pedidos.
- `node apps/app/test/who.test.js`: "whoLabel names a person with the name and the @nome..." falha sem `whoLabel`.
- `node apps/app/test/pageRoster.test.js`: "peopleKeys lists the page, the roster and an offer target, each once" falha sem `peopleKeys`.
- `npm run lint`, `npm test -- --affected=origin/main` e `npm run demo`.

Caminhada no aparelho (Android primeiro, depois iOS, depois web), ainda não feita:

- [ ] Ajustes da página no aparelho do dono, com dois administradores: cada linha mostra nome e @nome, e a linha do dono aparece nomeada no aparelho de um administrador.
- [ ] Remover um administrador: a pergunta cita nome e @nome da pessoa certa; depois da remoção o @nome da página e o nome no topo continuam.
- [ ] Criar uma página: Páginas já mostra o nome (não "página / sua página") e Ajustes mostra o @nome, sem reabrir.
- [ ] Aceitar o convite de administração: a linha em "Páginas que você administra" mantém o nome.
- [ ] Conversas da página, Pedidos de mensagem: quem enviou aparece com o nome que a conversa mostra, não "Pessoa".
- [ ] Encerrar página: o primeiro aviso diz "Encerrar @nome?".

Limites:

- A lista de pedidos pede só as 10 primeiras chaves (como a lista de Conversas); Ajustes pede todas as pessoas da lista (no máximo 19). Cada chave é perguntada uma vez enquanto a tela está aberta: o controle de peeks recomeça a cada abertura, e uma chave com peek guardado não é perguntada de novo. No nó core (sem peek) a linha continua sem nome.
- A tela de Conversas mantém a cópia própria do mesmo controle; juntá-la ao `useRowPeeks` fica para outro PR.
- Um peek guardado volta enquanto o `profile.read` responde vazio ou `missing`. Um @nome revogado só some quando uma tela esquece o peek (`forgetVerified`): a conversa e a lista de Conversas fazem isso ao abrir, Ajustes e Páginas não.
