# Revisão visual de UI

Este é o ciclo que todo PR com mudança de interface percorre antes de pedir revisão. Ele existe para que a tela seja olhada de verdade, no celular primeiro, e não apenas pelos testes.

## Quando rodar

- Qualquer PR que altere tela, componente, tema, texto visível ou navegação em `apps/app`.
- Antes de marcar no checklist do PR que a interface foi conferida. Se algum passo não rodou, diga qual e por quê.

## Evidências

As capturas ficam fora do git, em uma pasta de evidência do PR (por exemplo, `~/Workspace/evidencias/<branch>/`). No corpo do PR, cite o caminho de cada captura, nunca anexe o arquivo ao repositório.

O script `apps/app/scripts/review-shots.sh` tira a captura da tela ligada:

```sh
bash apps/app/scripts/review-shots.sh android <outdir> <label>
bash apps/app/scripts/review-shots.sh ios <outdir> <label>
```

Ele grava `<outdir>/<label>-<platform>-<n>.png` com `n` sequencial e imprime o caminho. Sem dispositivo ligado, ele para com `Nenhum simulador ou emulador ligado` e código de saída 1.

## Ordem do ciclo

1. **Android** no emulador AVD `varanda-api36`. É a plataforma de referência: o build de debug (`app.varanda.debug`) roda aqui antes de qualquer outra.
2. **iOS** no simulador iPhone 16e.
3. **Chrome** (web e PWA) em 390 px e 1280 px, no tema claro e no escuro.
4. Rodar cada tela também com texto grande e com movimento reduzido, nas plataformas acima, para conferir corte de texto e animações.

Para telas populadas sem conta, suba o Metro com `EXPO_PUBLIC_VARANDA_VITRINE=1`. Assim as telas hospedadas aparecem com dados de exemplo. Para conversas reais entre duas sessões, use o laboratório hospedado (`apps/cli/scripts/hosted-lab.js`) e abra cada sessão no Chrome.

## Checklist de telas

Confira cada tela nas plataformas do ciclo:

- A Rua
- Conversa
- Membro
- Diário
- Conversas e filtros
- Mensagem
- Comunidade
- Grupo
- ComunidadeInfo
- Avisos
- Busca
- Publicar
- Ajustes
- Introdução

## Critério de revisão

Cada tela é comparada com estas qualidades de referência:

- Uma ação principal por tela, com destaque claro.
- Linhas com avatar à esquerda, como nos apps de mensagem.
- Balões com cauda, e horários agrupados por remetente e intervalo.
- Cabeçalhos com ícone, sem texto solto onde um ícone resolve.
- Alvos de toque de pelo menos 44 pt.
- Nenhum texto cortado, sobreposto ou escondido por teclado, entalhe ou barra do sistema.

Para cada tela, escreva uma crítica curta: o que está bom, o que quebra a referência, e qual é a correção proposta.

## Rodadas de correção

1. Critique a tela, corrija o que a crítica apontou, e tire a captura de novo.
2. Repita enquanto cada rodada mudar algo.
3. Pare quando duas rodadas seguidas não mudarem nada. Registre no PR a última rodada e o motivo da parada.

## Limite conhecido: login nativo real

O login nativo real por passkey e por conta ainda depende do domínio associado e dos arquivos de links de aplicativo (asset links) publicados. Até lá, o celular não consegue completar o login de conta real, e isso é um portão separado do ciclo visual. Uma revisão visual aprovada não libera esse fluxo, e o PR deve dizer isso com essas palavras.

## Limites da Vitrine

A Vitrine responde a todos os métodos que o app chama, com dados fixos e sem rede, para mostrar as telas preenchidas. Ela não reproduz cada regra do nó: por exemplo, bloquear uma conversa não esconde as mensagens antigas, seguir de volta não tira o aviso de quem seguiu, e banir alguém da comunidade não reflete nos grupos dela. O índice da Vitrine (conversas, perfis, contagens, busca) responde com os dados fixos: uma publicação feita durante a sessão aparece em A Rua e no Diário, mas não abre como conversa nem soma nas contagens. Para conferir um fluxo de comportamento (bloqueio, moderação, avisos, envio), use o laboratório hospedado com duas pessoas de verdade. A Vitrine serve para conferir aparência e navegação.

## Registro

No corpo do PR, liste as telas revisadas por plataforma, o caminho das capturas, o número de rodadas e o resultado da última rodada. Diga o que não foi conferido.
