# Compositor de Momento igual ao de Publicação (branch feat/post-moment-composer-alike)

Só interface, em `apps/app/src/screens/Publicar.js`. Sem mudança de RPC, formato ou Termos.

## O que mudou

Momento, de cima para baixo:

- Cabeçalho como o da Publicação: avatar de 40 pt, nome em negrito e @nome suave. Agindo como Página, o cabeçalho mostra a Página (avatar, nome e @), porque Momento não tem os chips "Publicar como".
- Sob o nome, a coluna de mídia. Sem mídia: quadro tracejado de 160 x 200 pt "Escolher foto" e a linha suave "Um momento leva uma foto ou um vídeo.", só enquanto vazio e só quando o vídeo está disponível. Com foto: quadro de 160 x 200 pt (`radius.bubble`) com o X "Remover foto" no canto superior direito. Com vídeo: o mesmo quadro (capa, ou esqueleto com ícone de vídeo enquanto não há capa) com o X "Remover vídeo" e a linha de estado embaixo. O adesivo de música fica abaixo.
- Campo da legenda sem contorno, como o da publicação, com o texto "Uma frase sobre o momento (opcional)".
- Linha de ícones como a da Publicação: Vídeo, foto ("Adicionar foto", depois "Trocar foto" com foto escolhida) e Música. À direita, o anel de contagem com a regra da Publicação: número N/200 a partir de 160, quantos faltam a partir de 180 em âmbar, vermelho e negativo acima de 200.
- Depois, as notas ("Fica 24 horas para quem segue você..." ou "Publicando como ..."), as notas de bloqueio, mídia, rascunho e erro, e a linha de **Tentar de novo** / **Descartar** da Página, como antes.

Publicação: só a prévia do vídeo mudou, para o mesmo quadro de 160 x 200 pt com o X "Remover vídeo", alinhado à coluna do texto. A pílula "Remover vídeo" saiu.

Não mudou: regras de publicação, estados desabilitados, notas, manter o campo à vista acima do teclado, o reenvio da Página e o seletor de música só de trecho.

## Testes

- [x] Prova de regressão, rodada de verdade: antes da mudança em `Publicar.js`, as asserções novas falhavam (`composePolish.test.js` 15 ok e 2 falhas, `musicDraft.test.js` 46 ok e 1 falha, `momentosScreen.test.js` parou no teste do adesivo de música ao fatiar o JSX antigo); depois, 17 ok e 0 falhas, 47 e 0, e 178 e 0.
- [x] `npm run lint`, sobre `origin/main` 62496303
- [x] Arquivos de teste alvo, cada um sozinho com `node <arquivo>`: os 42 que leem `Publicar.js`, os docs mudados ou os fragmentos, ou que percorrem a pasta de telas, entre eles composePolish, musicDraft, momentosScreen, fieldGrow, videoCompose, a11yCompose, pageMoment, publicarAnnounce, pollDraftGuard, replySend, replyBar, postShareCompose, linkCardBuild, keyboardLift, uiKit, wordCheck, shareShell, pageChoice, themeUsage, platformGate, composeRing e group-flow
- [x] `npm run demo` (termina com "DEMO OK")

A suíte completa roda na CI do GitHub do PR (Node 20 e 24).

## Conferência visual (web, Vitrine)

- [x] As duas abas (Publicação e Momento) em largura de celular (375 x 812), tema claro
- [x] As duas abas em largura de celular, tema escuro
- [x] Momento com 191 caracteres: anel âmbar com "9"; com mais de seis linhas, a legenda rola dentro do campo, separada do quadro

A Vitrine não tem vídeo nem música e não escolhe foto: o quadro com foto, o vídeo, o cabeçalho de Página e os ícones Vídeo e Música ficam para o aparelho, abaixo.

## O que não foi conferido no aparelho

Android, iOS, web e PWA, tema claro e escuro, largura de celular:

- [ ] As duas abas lado a lado: cabeçalho, início do texto do campo, linha de ferramentas e anel
- [ ] Momento vazio: quadro tracejado e Publicar desligado
- [ ] Escolher, trocar e remover uma foto
- [ ] Vídeo: esqueleto, capa e X nas duas abas
- [ ] Música: ícone, adesivo e comportamento offline
- [ ] 160, 180 e acima de 200 caracteres: anel, número, rótulo para leitor de tela e anúncios
- [ ] Teclado aberto num celular pequeno mantém o quadro de 200 pt, o campo e a linha de ferramentas à vista
- [ ] Fonte no maior tamanho
- [ ] Como Página: o cabeçalho mostra a Página, a nota "Publicando como" e a linha de **Tentar de novo** com a mídia retida
- [ ] VoiceOver e TalkBack em cada botão de ícone
