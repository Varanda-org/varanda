# Recados (PR feat/recados)

Este arquivo confere os recados (estilo Orkut) na tela `recados` de uma pessoa, onde o nó é hospedado (web hospedada e app instalado). Use duas contas, A e B, em dois aparelhos ou navegadores, sem seguir uma à outra no começo. Rodada ainda por fazer.

- [ ] Escrever: A abre a tela de recados de B (B tem o padrão, "Quem eu sigo") e tenta deixar um recado; A vê "esta pessoa só recebe recados de quem ela segue" e nada é publicado. B segue A; A escreve um recado de 1 a 400 caracteres e ele aparece na tela de B, do mais novo para o mais antigo, com a data. Texto vazio ou de 401 caracteres não envia.
- [ ] Responder sem seguir de volta: A deixa um recado na página de B (B segue A). A não segue B. B abre a própria página e toca em "Responder" no recado de A: a resposta vai para a página de A e aparece lá. Uma segunda resposta de B ao mesmo recado não aparece na página de A. B escrever na página de A sem responder a um recado de A mostra a recusa.
- [ ] Tirar da minha página: B toca em "Tirar da minha página" num recado de A; ele some da página de B e continua no diário de A (A ainda o vê em "Apagar recado"). Se B tirou a resposta de A, A não ganha uma segunda vaga de resposta enquanto não apagar a primeira.
- [ ] Apagar recado: A apaga o recado que escreveu na página de B; ele some da página de B e A pode responder de novo ao mesmo recado de B.
- [ ] Mudar quem pode escrever: B muda para "Ninguém": a tela de B mostra que não recebe recados, os recados de seguidos somem de todos os leitores e A recebe "esta pessoa não está recebendo recados" ao tentar escrever. B muda para "Todos": A, sem B seguir, escreve e o recado aparece. B volta para "Quem eu sigo": os recados de quem B não segue (menos a resposta única descrita acima) somem, os de quem B segue voltam.
- [ ] Autor bloqueado ou conta própria: ninguém deixa recado na própria página ("não pode deixar recado para si"); uma pessoa bloqueada não aparece na página.
- [ ] Limite e data: mais de 20 recados vivos do mesmo autor na página mostram só os 20 mais novos; um recado com data mais de 24 h à frente do relógio do aparelho não aparece.
- [ ] Rede: abrir a tela pede `GET /index/scraps/<chave de B>` (e as páginas seguintes com o cursor `<ms>.<autor>.<seq>`), seguido de leituras `diary.peek`; a ausência de seguidor pode pedir `GET /index/follow/<B>/<A>`. Sem semeador, a tela mostra "semeador indisponível" e nenhum recado inventado.
- [ ] Denúncia: "Denunciar a conta" no recado de A abre o fluxo de denúncia da conta de A, como nos depoimentos.
- [ ] Os Termos e a Privacidade pedem novo aceite na versão 57; a Privacidade diz que os recados são públicos no diário de quem os escreve e que o semeador vê quais páginas são abertas e os pares de seguir consultados.
