# Sinal silencioso de leitura nos aparelhos

## O que muda

Os alertas nativos levam o horário `g` em que entraram na fila. Com `VARANDA_SEEN_SIGNAL=1` e aceite dos Termos 102 ou mais novos, o serviço pode enviar `seen-sync` aos aparelhos nativos, no mesmo agrupamento de 20 segundos e sob o mesmo teto por pessoa e por hora do sinal web. O sinal leva identificadores próprios de cada aparelho e um horário limite, sem texto de mensagem, remetente ou nome de grupo. Só fecha avisos correspondentes com horário conhecido que não passe desse limite. Abrir o app também fecha avisos já lidos, pelo identificador. Os Termos e a Política explicam que a Apple ou o Google fica sabendo que o sinal chegou e quando, num horário que acompanha a leitura em outro aparelho.

## Testes automatizados

Preenchido na aterrissagem.

## No aparelho

Conferências ainda devidas:

- No simulador iOS, preparar arquivos de payload para um alerta com `aps.alert`, `k`, `t` e `g` numérico e para um sinal silencioso `{"aps":{"content-available":1},"k":"seen-sync","c":["abcdefghijklmnop"],"a":1000}`. Usar a mesma tag no alerta e `g: 1000`. Enviar com `xcrun simctl push booted <bundle-id> <arquivo.json>`, primeiro o alerta, depois o sinal, e conferir o fechamento com o app em segundo plano. Repetir com `g: 1001`, sem `g`, com outra tag e com sinal inválido: os avisos devem ficar. Conferir também o recebimento em primeiro plano e o fechamento ao abrir o app.
- No emulador Android, conferir o alerta com `data.g` e `android.notification.event_time`, o sinal só com dados, o fechamento por tag e horário, a preservação de aviso mais novo, a rejeição de sinal inválido e o fechamento ao abrir o app. Conferir o atraso possível no modo Doze.
- Com as chaves do operador e builds adequados, conferir APNs e FCM reais, os cabeçalhos e a prioridade do sinal, o aceite mínimo 102, o sinal desligado, o agrupamento e o teto compartilhado com a web, nenhum envio com lista vazia e a remoção só do registro exato quando o provedor informa token inválido. Não guardar chaves nem tokens nos arquivos de payload ou no registro da verificação.
- No iOS real, forçar o fechamento do app, ler em outro aparelho e conferir que o sinal em segundo plano não fecha o aviso; reabrir o app e conferir o fechamento. A injeção pelo simulador não comprova a entrega pelo APNs.

## O que não foi conferido

Não foram conferidos nesta tarefa o simulador iOS, o emulador Android, aparelhos reais, a entrega APNs/FCM nem o caso de fechamento forçado. A implementação do serviço e do app pertence às tarefas T31 e T32; esta tarefa registra o contrato e atualiza os textos legais. Lint, suíte completa e demo não foram executados nesta tarefa de documentação; ficam para a integração.

## Limites conhecidos

O iOS não entrega sinais em segundo plano depois que a pessoa força o fechamento do app e pode atrasá-los ou descartá-los por baixa prioridade ou economia de energia. O Android pode atrasar mensagens de prioridade normal em Doze. Um aviso pode ficar até a pessoa abrir o app ou removê-lo; não há reenvio. A Apple ou o Google vê que o sinal chegou ao aparelho e quando, o que permite relacionar esse horário com a leitura em outro aparelho mesmo sem receber o conteúdo. As limitações já documentadas das marcações de Página e de grupos continuam valendo.
