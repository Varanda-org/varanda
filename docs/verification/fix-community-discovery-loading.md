# Comunidade aberta pela descoberta sem "Nenhum grupo ainda." no caminho

Branch `fix/community-discovery-loading`. A caminhada no celular e no navegador não foi feita e fica na lista abaixo.

## Causa

Uma comunidade que este aparelho ainda não guarda responde ao `community.info` como pendente, com a lista de grupos vazia (`packages/core/lib/member.js`, `PENDING_COMMUNITY`). A tela `Comunidade` só passa para a visão do índice (convite e grupos) quando a leitura do índice termina; até lá ela caía no corpo de uma comunidade guardada e desenhava a lista vazia como "Nenhum grupo ainda.".

## O que mudou

- `communityRows.js`: `awaitsIndex(info, status)` diz se a resposta é pendente e a leitura do índice ainda não respondeu (`idle` ou `loading`). `idle` conta porque o primeiro desenho depois da resposta vem antes de a leitura começar.
- `screens/Comunidade.js`: um ramo novo, logo depois do esqueleto de `info === null`, mostra as mesmas três linhas de carregamento enquanto `awaitsIndex` for verdadeiro. Nada mais muda: os dois "Nenhum grupo ainda." continuam para um índice que respondeu sem grupos e para uma comunidade guardada sem grupos.
- A garantia vale enquanto o índice está em `idle` ou `loading`. Com a leitura do índice falha, a tela segue como antes (veja "Fora desta mudança").

## Como verificar

A partir da raiz, rodados nesta mudança:

- `node apps/app/test/communityRows.test.js`: 8 testes, 54 asserções, todos passam.
- `node apps/app/test/chatSurfaces.test.js`, `node apps/app/test/group-flow.test.js` e `node apps/app/test/groupScreen.test.js`: passam sem nenhuma edição nesses arquivos.
- `npm run lint`: limpo.
- `npm run demo`: termina com `DEMO OK`.

A suíte completa roda na CI do PR (Node 20 e 24). Conferido que os testes novos falham sem a correção: tirando o ramo novo da tela, o teste de fonte falha; com `awaitsIndex` sempre falso, o teste da função falha.

Caminhada, a fazer no Android e no iOS e depois na web, com uma conta que não participa de uma comunidade pública listada na descoberta:

- [ ] Abrir a comunidade pela descoberta: aparecem as linhas de carregamento, depois o convite (Entrar ou Pedir entrada) e a lista de grupos, sem "Nenhum grupo ainda." no meio.
- [ ] Uma comunidade de que a pessoa participa abre como antes.
- [ ] Uma comunidade guardada sem grupos ainda mostra "Nenhum grupo ainda." com Novo grupo ou Tentar de novo.

## Fora desta mudança

- Com a leitura do índice falha, a comunidade pendente ainda mostra a lista vazia, e o "Tentar de novo" dela chama só `load` (`Comunidade.js`, ramo da comunidade guardada), que não refaz a leitura do índice porque `needIndex` não muda. Fica para outra mudança: a mesma resposta pendente vale para uma criação de comunidade interrompida neste aparelho, em que o índice ainda não conhecer a comunidade é o esperado.
- O título do cabeçalho durante a espera ("Comunidade ainda chegando").
