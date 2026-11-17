# fix/paginas-conversas-antigas

Parte de #352. Só `apps/app` e documentação.

## O que mudou

- Depois que uma Página muda da chave K1 para K2, agir como a Página (K2) mostrava uma caixa vazia: as conversas de K1 ficavam nos aparelhos que guardavam os segredos de K1. Decisão do Rodrigo em 16/11/2026: "mostrar as conversas antigas só para leitura".
- `apps/app/src/pageOldKeys.js`: `oldPageKeys` segue a cadeia verificada pelo nó (`page.read`, `movedFrom.from`, até 4 chaves, sem repetir, para na primeira leitura que falha); `heldOldKeys` mantém as chaves que este aparelho lê e que têm conversa; `oldThreadClient` encaminha só `dm.list`, `dm.thread` e `dm.seen` com `page: K1`, puxa com `dm.pull {}` e recusa todo o resto sem chamar o nó.
- `apps/app/src/screens/Conversas.js`, `src/conversas.js`: uma linha fixa "Conversas da chave antiga" por chave com conversa, só como Página.
- `apps/app/src/screens/Mensagens.js`, `Mensagem.js`, `App.js`, `src/nav.js`: a lista e a conversa da chave antiga são telas próprias (`params.oldPage`), sem campo de escrita, sem responder, reagir, encaminhar, denunciar nem ofertas; fotos e miniaturas leem a loja da chave antiga.
- `docs/protocol.md` seção 12: uma frase sobre a leitura.

## Revisão

- Uma entrada com `oldPage` válido é sempre a leitura da chave antiga, mesmo se a pessoa trocar de identidade depois (sem Avaliar, sem escrita); a lista antiga também não depende de agir como Página.
- As leituras da chave antiga só começam depois da primeira exibição da aba; a cadeia `movedFrom` (quando não vazia) fica em cache por Página e só `heldOldKeys` repete a cada `dmVersion`.
- A lista antiga tem texto vazio próprio, não mostra "Escreva a primeira." nem as saudações, e uma falha só na leitura de pedidos mantém a caixa de entrada.

## Como verificar

- `node apps/app/test/pageOldKeys.test.js`, `nav.test.js`, `conversasList.test.js`, `conversas.test.js`, `dm.test.js`, `linkPreview.test.js`, `platformGate.test.js`, `vitrine.test.js`, `chatMedia.test.js` e `npm run lint`. `pageOldKeys` tem 5 testes e 44 asserções; `nav` 28/526, `conversasList` 24/131, `conversas` 42/247, `dm` 62/584.
- Cada teste novo falha sem a sua correção (recusa de métodos, guarda de repetição, validação de `oldPage`, dedupe da pilha, composer e reações da conversa antiga).

## Passo a passo em aparelho (não feito)

- [ ] Android primeiro, depois iOS, depois web: mover uma Página que tem conversas para outra chave.
- [ ] Agindo como a Página, a linha "Conversas da chave antiga" aparece, abre a lista e cada conversa.
- [ ] A conversa antiga não tem campo de escrita nem ações de escrita, e as fotos abrem.
- [ ] Um aparelho que nunca guardou a chave antiga não mostra a linha.

## Limites

- Um aparelho que nunca guardou K1 não mostra nada.
- Quem ainda escreve para K1 cai lá, só para leitura, e é respondido pela chave nova (K2).
- A lista da chave antiga só pagina pelo cursor da caixa de entrada; pedidos além da primeira página não carregam.
