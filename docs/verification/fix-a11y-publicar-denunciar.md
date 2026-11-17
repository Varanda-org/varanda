# Leitor de tela em Publicar, Denunciar e no painel de emojis (#153)

Branch `fix/a11y-publicar-denunciar`. Fecha parte da #153: rótulos, papéis e estado selecionado. O que exige leitor de tela num aparelho não foi conferido e segue aberto na issue.

## O que mudou

- `ui/Pill.js` aceita `selected` e o anuncia em `accessibilityState`. Sem a prop, nada muda.
- `screens/Denunciar.js`: "esta publicação" e "a conta toda" deixavam o estado num `View` em volta do botão, que o leitor não lê. Agora o próprio botão carrega `selected`.
- `screens/Publicar.js`: o grupo "Publicar como" ganha o nome, e cada opção ganha `aria-checked` (a web descarta `accessibilityState`).
- `ui/EmojiPicker.js`: a fileira de grupos vira `tablist`, cada aba ganha `aria-selected`, e "Nenhum emoji encontrado" é uma região viva educada.

## Como verificar

A partir da raiz:

- `node apps/app/test/a11yCompose.test.js`
- `node apps/app/test/report.test.js`
- `node apps/app/test/composePolish.test.js`
- `npm run lint`

Caminhada, a fazer com TalkBack (Android) e VoiceOver (iOS), e depois no navegador:

- [ ] Denunciar uma publicação: ao focar "esta publicação" e "a conta toda", o leitor diz qual está selecionada e a seleção muda ao tocar.
- [ ] Publicar como uma Página: o grupo é lido como "Publicar como" e a opção marcada é anunciada.
- [ ] Painel de emojis: as abas são lidas como abas e a atual como selecionada; buscar um texto sem resultado anuncia "Nenhum emoji encontrado".

## Fora desta mudança

- Teste com VoiceOver e TalkBack, e com fonte ampliada (critérios de aceite da #153).
- Foco ao abrir e ao fechar a folha: o `Modal` do React Native cuida disso, sem alteração aqui.
- Alvo de toque de 32 pt das abas de emoji, fora do mínimo de 44 pt: exige mudar o desenho do painel.
