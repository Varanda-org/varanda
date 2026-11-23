# Tela Sobre o Varanda (#50)

Branch `feat/app-sobre`. Cobre a parte "Tela Sobre com licença e canal do encarregado" da #50. Não fecha a issue: a versão aprovada dos textos (#44) e o aceite das lojas (#46) seguem abertos.

## O que mudou

- `src/about.js`: o conteúdo da tela, em módulo puro. Versão (as mesmas linhas do rodapé de Ajustes), licença com o endereço do código e o canal do encarregado.
- `src/screens/Sobre.js`: a tela. Os endereços ficam como texto selecionável, não como link, como em Termos.
- `src/screens/Ajustes.js`: o item "Sobre o Varanda" no grupo Privacidade e segurança, depois de "Termos e privacidade", e a tela montada como as outras subtelas.
- O encarregado segue o texto de `src/legal.js`: ainda não nomeado, e até a nomeação os pedidos vão para `contato@varanda.app`. Quando a #57 nomear a pessoa, é só trocar `aboutSections`.

## Como verificar

A partir da raiz:

- `node apps/app/test/sobre.test.js`
- `node apps/app/test/composePolish.test.js`
- `npm test -w apps/app`
- `npm run lint`

Caminhada, no celular primeiro (Android e iOS) e depois na web:

- [ ] Ajustes, Privacidade e segurança: "Sobre o Varanda" aparece depois de "Termos e privacidade" e abre a tela.
- [ ] A tela mostra Versão (app e, quando conhecido, servidor), Licença e Encarregado de dados, e o botão de voltar leva à lista.
- [ ] Sem conexão a tela abre igual: nada é buscado.
- [ ] Os endereços podem ser selecionados e copiados.

## Fora desta mudança

- Nome do encarregado e canal próprio: dependem da #57.
- Texto aprovado dos Termos e da Política (#44) e aceite das lojas (#46).
