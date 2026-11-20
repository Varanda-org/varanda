### Adicionado

- Serviço de conta preparado para avisos nativos de Conversas e grupos por APNs (iPhone) e FCM (Android), desligados até o operador configurar as credenciais. A opção de ligar os avisos no app instalado fica para `feat/app-native-push`. Configuração em `docs/development.md` e verificação em `docs/verification/feat-native-push-transport.md`.
- Termos de Uso e Política de Privacidade na versão 101, de 19/11/2026: dados recebidos por Apple e Google e retenção do token, chave aleatória e criação do registro de até quatro aparelhos por pessoa, com remoção ao desligar, invalidar o token ou excluir a conta.

### Segurança

- Avisos nativos só para quem aceitou os Termos 101 ou mais novos, com prova assinada para cadastrar ou remover o aparelho. O provedor recebe a frase fixa ou o nome do grupo público, nunca quem escreveu, o texto da mensagem ou o nome de grupo privado. A tag é própria de cada aparelho; token inválido remove só o registro correspondente, sem reenvio de falhas.
