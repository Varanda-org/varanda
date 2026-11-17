# Calçada viva (branch feat/calcada-viva)

## O que mudou

- A calçada (pedras) e a faixa preta da onda deixam de deslizar na abertura do app (splash), na pré-abertura da web e na landing do site.
- A calçada próxima passa a mostrar pessoas, desenhadas por `apps/app/src/ui/splashStreet.js`, que é a fonte única:
  - dois passantes indo para a direita;
  - um passante e uma pessoa passeando com o cachorro indo para a esquerda;
  - um grupo de três conversando (uma delas levanta o braço);
  - duas crianças pulando e passando uma bola.
- Redução de movimento mostra uma imagem fixa, o primeiro quadro da cena: os grupos parados e um passante de cada lado ficam visíveis.
- O botão "pausar o movimento" da landing do site congela as pessoas no quadro atual.
- Os geradores das partes geradas (`apps/app` e `apps/site`) foram atualizados e o site tem teste de que os passantes não causam rolagem horizontal (`.gente` com `position: absolute` e `overflow: hidden`).

## Como verificar

### Verificações automáticas

- [x] Testes direcionados dos arquivos alterados (o mesmo conjunto que a CI roda para eles), um arquivo por vez.
- [x] Geradores em modo `--check`: as partes geradas batem com as fontes.
- [ ] `npm run lint` na raiz.
- [ ] `npm test -- --affected=origin/main` na raiz, como a CI.
- [ ] `npm run demo` na raiz.
- [x] Tamanho de `apps/app/public/index.html` contra o novo teto de 56000 bytes. Valor medido: 55493 bytes.
- [x] Tamanho da página da landing (`index.html` + `styles.css`) contra o limite de 46000 bytes. Valor medido: 43406 bytes.

### Verificações visuais (Chromium)

- [x] Sobreposição da pré-abertura da web (overlay) em 390 px, modo claro e escuro.
- [x] Sobreposição da pré-abertura da web (overlay) em 1280 px, modo claro (o escuro em 1280 px não foi conferido).
- [x] Landing do site em 360 px e 390 px (o site só tem modo claro).
- [x] Landing do site em 1280 px.
- [x] Abertura do app na web (export de produção) em 390 px, modo escuro, no Chromium: pedras paradas, pessoas andando.
- [x] Redução de movimento na sobreposição: sem animação.
- [x] Redução de movimento na landing do site: sem animação.
- [x] Botão "pausar o movimento" da landing: as pessoas param no quadro atual.

### Conferências ainda não feitas

- [ ] Redução de movimento no app nativo (Android e iOS).
- [ ] Botão "pausar o movimento" fora do Chromium.
- [ ] Modo escuro no app nativo.
- [ ] Telas de 320 px e 390 px no app nativo.
- [ ] Desktop 1280 px na web e no PWA (o app nativo é de celular).
- [ ] Escala de altura da cena nos passos 900, 500, 400 e 320.
- [ ] Safari (não conferido).

## Conferir no app (pessoas)

Ordem: Android (build de debug), simulador iOS, depois web e PWA.

- [ ] Splash do Android: calçada com pessoas se movendo, sem deslizar as pedras.
- [ ] Splash do simulador iOS: calçada com pessoas se movendo.
- [ ] Redução de movimento no Android e no iOS: cena fixa no primeiro quadro, sem animação.
- [ ] Web e PWA: abertura com pessoas, em celular (390 px) e em 320 px.
- [ ] Landing do site: botão de pausa congela o movimento e o botão volta a animar.

## Não verificado / limites conhecidos

- Na landing pausada, a cena congela o quadro atual: um passante pode ficar no meio da travessia. Com redução de movimento a cena para sempre no primeiro quadro; em telas de 320 px e 390 px um passante de cada lado fica fora da vista, e na landing abaixo de 400 px o grupo conversando também fica escondido.
- Na landing do site, o grupo que conversa fica escondido abaixo de 400 px de largura.
- Em cenas mais largas que 1440 unidades, os passantes andam um pouco mais rápido, na proporção da largura.
- O splash nativo do iOS e do Android não foi conferido em aparelhos: as caixas acima ficam desmarcadas por isso.
- Safari não foi conferido.
