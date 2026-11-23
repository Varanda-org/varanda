# Leitor de tela nas fotos do feed (#455)

Branch `fix/a11y-fotos-feed`. Fecha a #455 no código. A conferência com VoiceOver e TalkBack num aparelho não foi feita e fica na caminhada abaixo.

## O que mudou

- `ui/PostRow.js`: o bloco do corpo (autor, texto, data) é um único elemento acessível e escondia tudo dentro dele. As fotos ficavam lá, então nenhuma foto do feed era alcançável. Agora qualquer mídia sai desse bloco, como já acontecia com o vídeo: `mediaOut` substitui `videoOut` e vale para foto e vídeo.
- Com mídia, a legenda comum passa a ser uma cópia escondida do leitor abaixo da mídia (`textUnder`), igual ao vídeo. O corpo continua falando a legenda no próprio rótulo, então ela é lida uma vez.
- O `MediaGrid` já rotulava cada foto "foto N de M" e abria a tela cheia; nada mudou nele.
- A ordem visual não muda: mídia antes da legenda. A mídia tem um só pai nos dois ramos da legenda, então expandir a legenda não remonta o carrossel.

## Como verificar

A partir da raiz:

- `node apps/app/test/postLayout.test.js`
- `node apps/app/test/postOverflow.test.js`
- `npm test -w apps/app`
- `npm run lint`

Os testes novos falham sem a correção (`postLayout.test.js`: 13 de 17 passam sem a mudança em `PostRow.js`, 17 de 17 com ela).

Caminhada, a fazer com TalkBack (Android) e VoiceOver (iOS) no celular, e depois no navegador:

- [ ] Publicação com uma foto: o leitor lê o autor, o texto e a data, depois "foto 1 de 1" como botão, depois as ações.
- [ ] Publicação com várias fotos: o carrossel deixa passar de "foto 1 de N" à seguinte, e tocar abre a tela cheia.
- [ ] Duplo toque no texto continua curtindo, e tocar na legenda continua abrindo a conversa.
- [ ] Publicação só com texto, só com vídeo e com citação leem como antes.

## Fora desta mudança

- Descrição alternativa escrita pela pessoa que publica (não existe no registro).
- Mosaico de citações (`QuoteCard`): segue como está.
