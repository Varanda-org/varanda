# Textos de Descobrir, Comunidades, Diário e fórum

- As listas de Descobrir e **Assuntos do momento** mostram um botão de ajuda ao lado do título. A folha de ajuda recebe a regra de ordenação original e os avisos sobre listas incompletas continuam visíveis.
- Em **Comunidades**, a busca mantém o campo e os avisos de estado. A folha de criação mostra “Até 32 grupos, já com o grupo Geral.”. A lista vazia orienta a criar, buscar ou abrir um convite.
- A caixa **Seus grupos públicos** no Diário exibe “Qualquer pessoa vê isto no seu perfil.”.
- O fórum vazio mostra “Abra o primeiro tópico deste grupo.”. O campo de criação tem o rótulo **Tópico** e mantém “Primeira linha é o título”.

## Conferência local

- Os arquivos de teste da mudança passaram em execuções separadas com `node`. Os testes de regressão de Descobrir, Assuntos do momento, Diário e Comunidades falharam com os componentes anteriores e passaram após a correção. `node apps/app/test/help.test.js` também passou, com 15 testes.
- O Standard passou nos arquivos JavaScript alterados.
- Pendente: a conferência visual em Android, iOS, web e PWA.
