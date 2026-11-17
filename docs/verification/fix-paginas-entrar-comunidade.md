# Sobras de Páginas: entrar na comunidade pelo grupo (branch fix/paginas-entrar-comunidade)

Parte da #352. Só o app muda (`apps/app`). Não muda serviço, formato nem RPC: o serviço já recusa com `fora-da-comunidade` (`docs/protocol.md`, "Comunidades como página"); o app é que não tinha texto nem caminho para isso.

- **Texto da recusa.** `TEXTS` em `apps/app/src/pages.js` ganha `fora-da-comunidade` ("A página ainda não está na comunidade deste grupo"). Antes caía em "Serviço indisponível".
- **Botão "Entrar na comunidade" como Página.** `pageCommunityToEnter` (`apps/app/src/groups.js`) devolve a comunidade a abrir quando a entrada da Página no grupo foi recusada com `fora-da-comunidade` de forma definitiva (não incerta) e a chave da comunidade é conhecida. `Grupo.js` guarda o erro da última entrada da Página e mostra o botão no painel da Página; ele abre a comunidade (`onOpenCommunity`), onde "Entrar como a página" assina `community-join` e entra na comunidade e no Geral. A chave vem da mesma busca no índice que a pessoa já usa (`communityKey`), então não há chamada nova. Não há redirecionamento automático como o da pessoa: o nó só conhece o papel da pessoa na comunidade, não o da Página, e a recusa do serviço é o sinal certo.
- **Título do grupo.** `groupNameText` (`groups.js`) deixa de dizer "grupo privado" para uma Página fora de um grupo público: sem informações do grupo no nó, só a leitura verificada do nó (`pageVis`) pode dizer privado; a resposta do serviço continua sem decidir a visibilidade. A regra da pessoa não muda.

Como verificar, a partir da raiz:

- `node apps/app/test/pages.test.js`: "pageError has plain words for a join refused because the page is outside the community" falha sem a entrada em `TEXTS` (o texto vira "Serviço indisponível").
- `node apps/app/test/groupScreen.test.js`: "pageCommunityToEnter offers the community only for a definite fora-da-comunidade refusal" falha sem `pageCommunityToEnter` filtrar pelo código (devolve a comunidade para qualquer erro). "groupNameText: a page outside a public group does not call it private" falha sem o caso da Página (devolve "grupo privado"). "Grupo wires the page community path and the neutral name" falha se a tela não usar as duas funções.
- `npm run lint`, `npm test -- --affected=origin/main` e `npm run demo`.

Caminhada no aparelho (Android primeiro, depois iOS, depois web), ainda não feita:

- [ ] Agindo como uma Página, abrir o grupo público (Geral) de uma comunidade em que a Página não está: o título não diz "grupo privado".
- [ ] Tocar em "Entrar como a página" no grupo: aparece "A página ainda não está na comunidade deste grupo" e o botão "Entrar na comunidade".
- [ ] Tocar em "Entrar na comunidade": abre a comunidade; "Entrar como a página" coloca a Página nela.
- [ ] Voltar ao grupo Geral: a Página já é membra e publica como a Página.
- [ ] Num grupo privado da mesma comunidade: pedir para entrar como a Página, o criador admite, e a Página publica.
