# Chip de 32 pt

O `Chip` (`apps/app/src/ui/Chip.js`) é a pílula dos chips de filtro. As respostas do evento, os atalhos de data e hora e a escolha de quem publica passam a usar a mesma peça. A entrada está em `apps/site/artwork/app-design.md`.

A face tem 32 pt: 12 pt nas laterais, 6 pt acima e abaixo, fio de 1 pt e cantos de pílula. O alvo de toque em volta tem 44 pt. Solto, o fundo é o cartão, o fio é a cor do fio e o rótulo é tinta (15 pt, peso 600). Escolhido, o fundo e o fio ficam em tinta e o rótulo na cor do fundo. Pressionado, a opacidade é 0,6. Desabilitado, a opacidade é 0,45.

Dois papéis. Botão (`button`), o padrão: o leitor de tela ouve selecionado e, na web, `aria-pressed`. Opção (`radio`): o leitor ouve marcado e, na web, `aria-checked`; a barra de espaço aciona o toque uma vez, mesmo com a tecla segurada. O ícone, quando há, é Feather de 16 pt, por `ui/Icon.js`. Ícone e rótulo ficam centrados na face, então uma largura mínima do chamador (as respostas do evento) não os empurra para a esquerda.

Quatro lugares:

- `FilterChips`: a fileira de filtro, no papel de botão. A fileira continua com 16 pt nas laterais, 8 pt acima e abaixo e 8 pt entre os chips. Uma contagem maior que zero entra depois do rótulo.
- `EventCard`: Vou e Talvez, no papel de botão, com o ícone `ok` na escolhida e pelo menos 96 pt de largura.
- `DateTimeField`: os atalhos de data e hora em Começa e Termina (Hoje, Amanhã, Sábado, Domingo, 09:00, 12:00, 19:00 e 20:00), no papel de botão.
- `Publicar`: Publicar como, no papel de opção dentro do grupo, entre Você e cada Página. Cada chip tem no máximo 200 pt, então um nome de Página longo (até 80 caracteres) termina em reticências dentro da folha.

Só números e medidas do kit de referência. Nenhum arquivo, imagem ou ícone dele entrou no repositório.

## Testes

- [x] `npm run lint` passou.
- [x] Os 24 arquivos de teste que a mudança alcança passaram, cada um com `node`, entre eles chip (quatro testes do componente: alvo de 44 pt e face de 32 pt, escolhido em tinta com ícone de 16 pt, papel de opção com a barra de espaço uma vez, desabilitado a 0,45), hapticsUse, a11yCompose, composePolish, eventosScreen, momentosScreen, pageChoice, pageVote, feiraScreen e themeUsage.
- [x] Regressão: sem o limite de 200 pt em Publicar como, a11yCompose falha (3 de 4).
- [x] `npm run demo` terminou com "DEMO OK".
- [ ] A suíte inteira roda na CI do GitHub, no Node 20 e no 24.

## O que não foi conferido no aparelho

Nada foi aberto no aparelho nem no navegador.

- [ ] Chip solto e escolhido, no claro e no escuro: face de 32 pt, alvo de 44 pt, escolhido com fundo e fio em tinta e rótulo na cor do fundo.
- [ ] Chips de filtro soltos e escolhidos, inclusive numa fileira que precisa rolar, com uma contagem depois do rótulo.
- [ ] Respostas do evento, Vou e Talvez, com o ícone de confirmação só na escolhida, e o toque para tirar a resposta.
- [ ] Atalhos de data e hora em Começa e Termina, no editor de evento, no claro e no escuro.
- [ ] Publicar como: Você e uma Página, um só escolhido, o leitor de tela anunciando o grupo e o estado marcado, e a barra de espaço na web.
- [ ] Publicar como com uma Página de nome longo: o chip para em 200 pt e o nome termina em reticências.
- [ ] Chip desabilitado, a 0,45, nas respostas de um evento que já passou e em Publicar como enquanto o envio segura a folha.
- [ ] Android (build de debug), simulador iOS, web e PWA.
- [ ] Texto grande e larguras de 320 px e 1280 px.
