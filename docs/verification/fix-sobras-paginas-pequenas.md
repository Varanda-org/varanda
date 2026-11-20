# Sobras de Páginas: marca de página na Busca global (branch fix/sobras-paginas-pequenas)

Um item da #352 ("Do #334: a Busca global não repassa as marcas de página de um resultado para `names.learnMany`"). Não muda protocolo, semeador nem RPC. A marca continua sendo só uma dica do semeador: o Membro confere com `page.read`.

- `doFollowHit` (`apps/app/src/screens/BuscaGlobal.js`) passa `page`, `closed` e `moved` do resultado a `names.learnMany`, junto com nome e @nome. Um semeador antigo não manda a marca: os três campos ficam `undefined` e o cache mantém o que já sabia (`pageHintFields` só aceita booleanos).

Como verificar, a partir da raiz:

- `node apps/app/test/buscaGlobal.test.js` (27 testes; antes 26). O teste novo "following a search row hands the seeder's page marks to the names cache" falha sem a mudança.
- `npm run lint` e `npm test -w apps/app`.

Caminhada, a fazer no celular (build de debug do Android e simulador iOS) e depois na web e no PWA:

- [ ] Buscar o nome de uma Página, seguir pelo resultado e abrir a Página: já aparece como Página, sem piscar como perfil comum.
- [ ] Seguir uma pessoa comum pelo mesmo caminho: sem marca de página.

Limites:

- Nenhuma caixa acima foi marcada nesta documentação; só os testes automatizados rodaram.
- Os outros itens da #352 seguem abertos: este PR não a fecha.
