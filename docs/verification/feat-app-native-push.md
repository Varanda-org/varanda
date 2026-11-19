# Cliente push nativo (branch feat/app-native-push)

## O que muda

- T30 substitui os stubs do cliente e do hook nativos; usa o módulo `../modules/push-device` pelo contrato compartilhado com T28/T29, sem alterar seus arquivos. A capacidade vem de `transport()` e de `/account/push/device/info`, sem `Platform.OS`.
- `account.js` acrescenta info, start, finish e check para dispositivos, com respostas de chaves exatas. Finish desconhecido é `uncertain`, como no helper web; a interface nativa também conserva uma recusa do finish como pendente e incerta, sem repetir.
- O nó assina `pushDevice.sign`; o cliente nunca preenche membro ou associação no RPC. O serviço recebe os campos do contrato de PR6. Nenhum formato normativo foi alterado.
- O registro `{ transport, token, key }` fica por membro no `expo-secure-store`, com `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; a entrada `.pending` retém os dados de uma tentativa não confirmada e exige ação manual. Uma rotação mantém os 16 bytes aleatórios da chave.
- Uma renovação por desbloqueio e uma por token novo, sem renovar só por abrir Ajustes. Falha de check não é remoção. Bloquear ou trocar de identidade invalida o resultado antigo e encerra sua escuta.
- O hook conserva os oito exports e o formato da web. Transporte desligado ou módulo ausente conserva `NONE`; a permissão só é solicitada ao ligar. Os textos de erro vêm de `push-state.js`.
- `captureLaunch()` conserva a interface síncrona de `App.js`; a leitura assíncrona do módulo chega por `listenLaunch()`. DM, Página DM e os dois tipos de grupo usam os mesmos destinos da web, sem identidade no intent.

## Testes automatizados

Preencher a tabela na aterrissagem, com o conjunto integrado de T28, T29 e T30:

| Arquivo ou comando | Testes | Asserções / resultado |
|---|---|---|
| `apps/app/test/pushDevice.test.js` | a preencher | a preencher |
| `apps/app/test/use-push-native.test.js` | a preencher | a preencher |
| `apps/app/test/platformGate.test.js` | a preencher | a preencher |
| `apps/app/test/account.test.js` | a preencher | a preencher |
| `npm run lint` | a preencher | a preencher |
| `npm test -- --affected=origin/main` | a preencher | a preencher |
| `npm run demo` | a preencher | a preencher |

Rodada isolada de T30 em Node 26.12.1: `pushDevice.test.js` passou com 5 testes e 90 asserções; `use-push-native.test.js`, 14 e 116; `platformGate.test.js`, 6 e 837; `account.test.js`, 91 e 1420. `npx --no-install standard` nos seis arquivos JS de T30 passou após corrigir a formatação de objetos apontada na primeira execução. Node avisou `MODULE_TYPELESS_PACKAGE_JSON` ao importar ESM, sem impedir os testes. Todos os serviços, permissões, tokens e respostas de push dos testes são fakes; nenhuma rede externa foi usada. `npm run lint` e `git diff --check` também passaram.

Prova de regressão: retirando temporariamente a preservação da chave na rotação, `use-push-native.test.js` falhou no caso `onToken rotates in place with the same key and duplicate events never renew` (13/14 testes e 114/116 asserções). Restaurada a correção, passou com 14/14 testes e 116/116 asserções.

`npm run demo` e a repetição isolada `node apps/cli/scripts/demo.js` falharam, ambos com saída 1, antes de montar a DHT local: `DEMO FALHOU: erro inesperado`, `Error: operation not permitted`, em `UDXSocket.bind`. Este ambiente recusou a abertura do socket local; não houve tentativa de usar a DHT pública.

Cobertura: validadores confrontados com o contrato do serviço, aleatoriedade injetada, estados e limite de renovação; indisponibilidade de transporte; ordem de permissão, token, start, sign, finish e persistência; APNs e FCM; rotação com a mesma chave; finish recusado; check sem resposta; lock durante a permissão; separação por membro; retomada de pendência no SecureStore; limpeza só após off assinado; intents de abertura e toque com o app aberto; respostas HTTP malformadas e ausência de reenvio.

## No aparelho

| Ambiente | Executado em T30 | Conferência devida |
|---|---|---|
| Simulador iOS | nenhum teste | Abrir Ajustes, negar e conceder permissão, ligar/desligar, bloquear/desbloquear, tocar avisos simulados dos quatro tipos. |
| Emulador Android | nenhum teste | Build de debug com e sem Firebase; permissão no Android 13+ e canais; ligar/desligar e destinos dos quatro tipos. |
| iOS com APNs real | não | Chaves do operador e build assinado; entrega em segundo plano, app encerrado e primeiro plano; rotação e remoção. |
| Android com FCM real | não | Chaves do operador e build assinado com Firebase; entrega em segundo plano, app encerrado e primeiro plano; rotação e remoção. |

Nos dois aparelhos, conferir Sair e Recomeçar durante uma ativação, mudança de token com a identidade bloqueada, alternância entre membros e persistência da pendência após encerrar o app. A entrega real fica devida: fakes não demonstram recebimento do provedor nem a configuração do build.

## O que não foi conferido

- Nenhum build nativo, simulador, emulador ou aparelho foi executado nesta rodada. T28/T29 são integrados separadamente.
- A suíte completa e a seleção de workspaces afetados não rodaram nesta rodada de T30; a demo foi tentada, com a falha de socket descrita acima. A tabela integrada continua pendente para aterrissagem. Não houve instalação de dependências, commit, push ou PR.

## Limites conhecidos

- O transporte depende tanto da configuração no build quanto das credenciais do operador. Sem ambos, a linha não aparece. O registro exige identidade desbloqueada, vínculo e termos aceitos conforme PR6.
- O sistema pode negar a permissão, atrasar ou perder avisos. O token pode não chegar no prazo do módulo. Não há garantia de entrega nem repetição automática de finish.
- Um finish sem confirmação pode ter alterado o serviço. A interface conserva a pendência como desligada e incerta; isso não garante que o serviço parou de enviar. Sair tenta off enquanto a identidade ainda pode assinar; uma falha conserva a pendência local.
- Somente DM, Página DM e grupos entram no push nativo. Avisos sociais, convites e fechamento remoto por `seen-sync` não fazem parte desta mudança.
- Os destinos não identificam a conversa ou o grupo, só abrem a área correspondente depois do desbloqueio. O módulo não mostra um aviso recebido em primeiro plano.
