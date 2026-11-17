# Nomes em Páginas (branch fix/paginas-nomes)

Parte da #352. Só o app muda (`apps/app`). Não muda formato, RPC nem Termos.

Causa comum: `profile.read` responde `missing` para quem o nó não guarda (a Página e os administradores de outra pessoa), e só um `diary.peek` verificado (`learnVerified`) sobrevive a essa resposta. Um nome vindo de seed (`learnMany`) some no próximo `profile.read`, e as telas de Páginas não pediam o peek para essas chaves.

- **Pessoas em Ajustes da página.** `PaginaAjustes.js` nomeia a Página, o dono, os administradores e quem recebeu uma oferta com o mesmo peek verificado da lista de Conversas (`useRowPeeks`, `apps/app/src/useRowPeeks.js`, que usa `rowPeek.js` e `peerProfile.js`). As chaves vêm de `peopleKeys` (`pageRoster.js`).
- **Confirmar remoção.** A pergunta cita nome e @nome (`whoLabel`, `who.js`): "Remover Caio Membro (@caio) da administração da página?".
- **Nome que não some.** `names.js` não deixa um `profile.read` sem nome, sem bio e sem foto tirar o que um peek verificado já disse (`fillFromPeek` e `settleProfile`, `namesCache.js`): nome, bio, foto e @nome voltam juntos, e só nesse caso. Uma resposta com qualquer um desses campos é o perfil mais novo e seus vazios valem (foto ou bio removidas, @nome revogado). Paginas passa a guardar o peek como verificado, não como seed, e `NovaPagina.js` guarda o nome, o @nome e a bio exatamente como foram enviados.
- **Salvar e trocar @nome.** Depois de salvar nome, bio ou foto, ou de trocar o @nome, `PaginaAjustes.js` troca o peek guardado pelo que o serviço aceitou (`keptProfile`), para um `profile.read` `missing` não trazer o nome ou o @nome antigos de volta.
- **Pedidos de mensagem da Página.** `Mensagens.js` nomeia quem enviou o pedido com o mesmo peek.
- **Encerrar página.** O primeiro aviso cita o @nome porque o @nome agora fica conhecido (`closeWarning` não mudou).
- **Linha de Páginas sem nome na primeira abertura.** O peek de `Paginas.js` parava quando outra resposta de `profile.read` chegava (`profileOf` muda e o efeito roda de novo), e a nova rodada pulava a chave que ainda estava sendo perguntada; a linha da chave antiga de uma página que mudou de chave ficava "página" até reabrir a tela (visto na caminhada web). Agora só sair da tela para o peek; `learnVerified` já descarta a resposta de outra identidade (`peekScope`).

Como verificar, a partir da raiz:

- `node apps/app/test/namesCache.test.js`: "fillFromPeek keeps a verified peek only for an answer with nothing at all" falha sem `fillFromPeek` (inclui o caso `{ name: 'Novo', bio: null, avatar: null }`); "settleProfile keeps the peek only while it filled the answer" e "names.js settles a profile.read answer through settleProfile" falham sem `settleProfile` em `names.js`; "keptProfile is what a save or a rename leaves as the verified entry" falha sem `keptProfile`; "the Páginas screens name people through verified peeks, not seeds" falha sem `learnVerified` em Páginas e Nova página, sem `useRowPeeks` com a janela inteira e as duas chamadas de `learnVerified` (salvar e trocar @nome) em Ajustes e sem `useRowPeeks` na lista de pedidos.
- `node apps/app/test/namesCache.test.js`, também: "a Páginas row peek survives a names answer that re-runs the effect" falha com a limpeza antiga (`alive = false` a cada nova rodada).
- `node apps/app/test/who.test.js`: "whoLabel names a person with the name and the @nome..." falha sem `whoLabel`.
- `node apps/app/test/pageRoster.test.js`: "peopleKeys lists the page, the roster and an offer target, each once" falha sem `peopleKeys`.
- `npm run lint`, `npm test -- --affected=origin/main` e `npm run demo`.

Caminhada na web, no laboratório hospedado (`apps/cli/scripts/hosted-lab.js`, navegador sem tela, com W1 e W3 juntos):

- [x] Ajustes da página no aparelho do dono e no de um administrador: cada linha mostra nome e @nome ("Ana Dona @ana_dona · Dono", "Davi Membro @davi_membro · Administrador"), a do dono também no aparelho do administrador.
- [x] Remover um administrador: "Remover Davi Membro (@davi_membro) da administração da página?"; depois da remoção o @nome da página e o nome no topo continuam.
- [x] Conversas da página, Pedidos de mensagem: "Caio Membro @caio_membro", não "Pessoa".
- [x] Páginas: a linha encerrada da chave antiga ficava sem nome na primeira abertura (corrigido acima). Depois da correção, na primeira abertura depois de recarregar, os três aparelhos nomeiam todas as linhas, a chave antiga também.
- [x] Criar uma página: Páginas já mostra "Feira do Davi @feira_davi" e Ajustes mostra "Agora: @feira_davi", sem reabrir.
- [x] Aceitar o convite de administração: o convite e, depois de Aceitar, a linha em "Páginas que você administra" mostram "Feira do Davi @feira_davi".
- [x] Encerrar página: o primeiro aviso diz "Encerrar @feira_davi?".

Android e iOS: os mesmos passos ficam com o Rodrigo, no APK de preview do EAS (o build de debug não entra com passkey).

Limites:

- A lista de pedidos pede só as 10 primeiras chaves (como a lista de Conversas); Ajustes pede todas as pessoas da lista (no máximo 19). Cada chave é perguntada uma vez enquanto a tela está aberta: o controle de peeks recomeça a cada abertura, e uma chave com peek guardado não é perguntada de novo. No nó core (sem peek) a linha continua sem nome.
- A tela de Conversas mantém a cópia própria do mesmo controle; juntá-la ao `useRowPeeks` fica para outro PR.
- Um peek guardado volta enquanto o `profile.read` responde vazio ou `missing`. Um @nome revogado só some quando uma tela esquece o peek (`forgetVerified`): a conversa e a lista de Conversas fazem isso ao abrir, Ajustes e Páginas não.
