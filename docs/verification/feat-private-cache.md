# Reabertura de Conversas, grupos e Avisos com a cópia guardada

Este PR sai em sequência com `feat/espiadinha-cache`, sem lançamento intermediário. Os Termos 113, elevados em `feat/espiadinha-cache`, já descrevem estas cópias.

## Testes locais

`npm run lint` passou, `npm run demo` terminou com "DEMO OK" e os 178 arquivos de teste direcionados (os alterados e os que importam um módulo alterado) passaram. A suíte inteira roda na CI do GitHub.

## Roteiro de verificação manual

Use a conta pessoal, com sessão aberta, no Android, no iOS, na web e no PWA instalado.

1. Abra Conversas, uma conversa direta, um grupo e Avisos. Espere cada lista carregar, feche o app e reabra cada tela. Confirme que as linhas de outras pessoas ficam ocultas até `block.list` responder e que, então, a cópia aparece enquanto a página atual é buscada. Na lista, na conversa e no grupo, a resposta do nó substitui ou funde as linhas no lugar, sem pílula. Nos Avisos, as novidades ficam atrás da pílula "ver novidades".
2. Com a cópia na tela e antes de o nó responder, confirme que o ponto de não lidas da aba, os pontos das linhas e os recibos de leitura não mudam, e que a pintura não chama `dm.seen`, `group.seen` nem marca aviso como visto. Numa conversa e num grupo, uma mídia guardada mostra "Carregando mídia" até a linha ao vivo trazer a referência.
3. Com um aviso novo atrás da pílula, confirme que ele continua não visto até a pílula ser pressionada. Só a leitura ao vivo marca o aviso como visto.
4. Com as quatro cópias preenchidas, saia da conta. No cache do app nativo, confirme que sumiram `varanda-screen-conversas.json`, `varanda-screen-mensagens.json`, `varanda-screen-grupoMensagens.json` e `varanda-screen-avisos.json`, inclusive as variantes `.bak` e `.tmp`. Na web e no PWA instalado, confirme que as chaves `varanda-screen-conversas`, `varanda-screen-mensagens`, `varanda-screen-grupoMensagens` e `varanda-screen-avisos` saíram do `localStorage`. Entre de novo, preencha as cópias e repita depois de trancar a sessão. Feche o app com a sessão vencida e abra de novo: os mesmos arquivos e as mesmas chaves continuam ausentes. A primeira leitura de `identity.status()` que falha numa abertura também apaga as cópias (`startWipe.test.js`).
5. No texto guardado de `varanda-screen-mensagens` e de `varanda-screen-grupoMensagens`, procure `key`, `nonce`, `sha256` e `core` nas propriedades e nos campos de mídia. A busca não encontra esses nomes. A mídia guardada é só `{ mime, w, h, ms }`, e o cartão de link fica sem imagem. O que a pessoa escreveu na mensagem fica de fora dessa busca.
6. Com linhas de outra pessoa na cópia, bloqueie essa pessoa em outro aparelho e reabra. As linhas guardadas dela somem (num grupo, pelo diário). Elas não voltam enquanto o bloqueio valer.
7. Com Avisos guardados, abra o app sem internet. Depois de `block.list` responder, a cópia aparece com a linha "Sem conexão. Confira sua internet." acima da lista. Sem cópia, aparece o estado vazio "Sem conexão" de sempre.
8. Use "Apagar conversa" numa conversa com cópia e reabra o app: a conversa não volta. Numa conversa cuja página mais nova é completa (sem página mais antiga no nó), mensagens guardadas que o nó não devolve somem depois da leitura ao vivo.

Verificação manual pendente.
