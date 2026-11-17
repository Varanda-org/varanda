# "Publicar como" lido no iOS (#153)

Branch `fix/publicar-como-voiceover`. Corrige um efeito do #736: o texto visível "Publicar como" ficou escondido do leitor de tela, e o nome do grupo foi para um `accessibilityLabel` no `View`. No iOS, um `View` sem `accessible` normalmente não tem o rótulo lido, então o VoiceOver ouvia só as opções ("Você" e as Páginas), sem saber para que serviam.

## O que mudou

- `apps/app/src/screens/Publicar.js`: o texto "Publicar como" volta a ser lido e dá nome ao grupo. O `View` com papel `radiogroup` aponta para ele com `aria-labelledby`, pelo `nativeID` que `useId` gera (um por compositor). O react-native-web transforma os dois em `aria-labelledby` e `id`, o Android usa `accessibilityLabelledBy`, e o iOS lê o próprio texto.
- `apps/app/test/a11yCompose.test.js`: confere o `useId`, o `aria-labelledby` do grupo e o texto sem `aria-hidden`. A asserção do texto falha sem a correção.

## Como verificar

A partir da raiz:

- `node apps/app/test/a11yCompose.test.js`
- `npm run lint`

Caminhada numa conta que administra uma Página (versão hospedada), ainda não feita:

- [ ] iOS com VoiceOver: em Publicar, o leitor diz "Publicar como" antes de "Você" e das Páginas.
- [ ] Android com TalkBack: o grupo é anunciado com o nome "Publicar como".
- [ ] Navegador com leitor de tela: o grupo de opções tem o nome "Publicar como".
