# Cabeçalhos de perfil

O cabeçalho de perfil (`ProfileHeader`), a barra que fica presa no alto ao rolar (`ProfileBar`) e o esqueleto de carga do perfil (`States`) passam às medidas do kit. Valem para o Diário e para Membro, que também mostra as Páginas. As medidas estão em `apps/site/artwork/app-design.md`.

- Os botões da faixa passam de círculos de 34 pt para 44 pt, o alvo mínimo de toque: voltar, em Membro e na barra presa, e ajuda, Ajustes e Avisos, no Diário. No Diário eles ficam a 24 pt da borda direita, com 8 pt entre um e outro.
- O ícone branco desses botões e o título da barra presa usam `colors.onMedia`, e não mais `#ffffff` escrito à mão.
- O avatar tem 64 pt em qualquer largura. Antes, tinha 88 pt no celular e 72 pt a partir de 640 pt. Ele sobe 32 pt para dentro da faixa, metade da sua altura.
- O cabeçalho, a barra presa e o esqueleto têm 24 pt de recuo lateral, e as contagens têm 24 pt entre elas. Assim, o botão de voltar e os do Diário não pulam quando a barra prende, e o esqueleto tem o mesmo desenho do perfil carregado.
- Em Membro, a barra presa espera os 44 pt do botão de voltar (`controlsBottom` passa de 42 para 52 pt abaixo da área segura).
- A faixa continua com 96 pt além da área segura.

Onde entra: no Diário, no perfil de outra pessoa e no de uma Página, inclusive enquanto carregam.

Só números e medidas do kit de referência. Nenhum arquivo, imagem ou ícone dele entrou no repositório.

## Testes

- [x] `npm run lint` passou.
- [x] Os 21 arquivos de teste que a mudança alcança passaram, cada um com `node`, entre eles profilePolish, uiKit e os de Diário e Membro.
- [x] Regressão: com o esqueleto e a barra presa ainda a 16 pt, profilePolish falha (77 de 79 asserções).
- [x] `npm run demo` terminou com "DEMO OK".
- [ ] A suíte inteira roda na CI do GitHub, no Node 20 e no 24.

## O que não foi conferido no aparelho

Nada foi aberto no aparelho nem no navegador. Conferir primeiro no Android (build de debug) e no simulador iOS, depois na web e no PWA, a 320 pt, a 390 pt e a 1280 px, no claro e no escuro.

- [ ] No próprio Diário: os três círculos de 44 pt na faixa (ajuda, Ajustes e Avisos, quando há) inteiros, sem encostar uns nos outros, e cada um responde ao toque. Também com uma faixa de tema escolhido, em que os círculos tomam a cor do tema.
- [ ] Rolar o Diário até a barra prender: os botões ficam no mesmo lugar, e o título cabe ao lado deles com o texto grande.
- [ ] No perfil de outra pessoa e no de uma Página: o círculo de voltar na faixa e na barra presa, o avatar de 64 pt com anel, e os links das contagens com 24 pt entre eles.
- [ ] Abrir um perfil devagar (rede lenta): o esqueleto tem o avatar, as linhas e as contagens no mesmo lugar do perfil carregado, sem salto.
