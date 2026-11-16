# Visitas (PR feat/visitas)

Este arquivo confere o interruptor Visitas e a lista de visitantes, onde o nó é hospedado (web hospedada e app instalado). Use duas contas, A e B, em aparelhos ou navegadores diferentes. Rodada ainda por fazer. Ordem de lançamento: semeadores primeiro (a pista `varanda/visit/1`), depois a web hospedada, depois os apps; um semeador antigo não abre a pista e nenhum aviso sai. Comece pelo Android, depois o iPhone e a web.

- [ ] Modo Vitrine: com `EXPO_PUBLIC_VARANDA_VITRINE=1`, a tela Visitas funciona com dados de exemplo, sem rede, e a folha de consentimento abre com o interruptor desligado.
- [ ] Consentimento: em Ajustes, Visitas abre a folha de consentimento com o interruptor desligado; só ligar de propósito começa a participar, e fechar a folha sem ligar não grava nada.
- [ ] Lista por dia: com A e B ligados, B abre o perfil de A; A vê B na lista de visitantes, agrupada por dia (Hoje, Ontem, depois a data), com precisão de um dia e sem horário.
- [ ] Mútuo: com A desligado, A não vê ninguém, mesmo que B tenha visitado; B desligado na hora da visita nunca aparece para A, nem depois de B ligar.
- [ ] Desligar apaga: desligar o interruptor de A apaga a lista de visitantes do aparelho; ao ligar de novo a lista começa vazia.
- [ ] Registro público: ligar e desligar grava um registro `visits` (`on`, `at`) no diário de A (`diary.peek`), e o semeador devolve `visits` no `/index/profile/<autor>`.
- [ ] Limite diário: depois de 10 visitas enviadas no dia, a tela avisa o limite e nenhuma nova visita sai; a mesma pessoa não é avisada de novo em dias seguidos fora da regra de recência.
- [ ] Mensagens privadas desativadas: sem ativar as mensagens privadas, ligar Visitas em Ajustes mostra "Ative as mensagens privadas para registrar visitas." na folha e o interruptor continua desligado; com o semeador sem a pista (`--no-dm`), nada é enviado.
- [ ] Pista silenciosa: um aviso nunca aparece no repositório das mensagens diretas, não acorda nenhum aparelho (sem push) e um semeador sem a pista não recebe aviso; o nó não usa outro caminho.
- [ ] Núcleo: no `varanda-serve` e no app com configuração manual, a tela não oferece Visitas e os métodos `visits.*` respondem o erro de uso só da web.
- [ ] Claro e escuro, 375x812 e 1280x800, com texto grande: veja o item Visitas de `docs/design-review.md`.
- [ ] Os Termos e a Privacidade estão na versão 62 e pedem novo aceite; o texto diz que Visitas é opcional e desligado por padrão, que é mútuo, que participar é público, que a lista fica só no aparelho com precisão de um dia e é apagada ao desligar, e que os avisos viajam selados por semeadores que não os leem e nunca acordam ninguém.
