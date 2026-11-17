### Alterado

- Enquetes, eventos e votos da Página (PR `feat/page-polls-events`): agindo como uma Página, publicar aceita uma enquete ou um evento, como a publicação de uma pessoa, e a Página vota na enquete e confirma presença no evento com a nova ação `choice`. As opções da enquete e o título e o local do evento passam pela lista de termos. O estado da Página traz `picked`, os votos dela desde a última retirada, contados como quem lê conta. Encerrar a Página apaga os votos. Termos e Política versão 80, com novo aceite. Verificação em `docs/verification/feat-page-polls-events.md`.
