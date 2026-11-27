### Corrigido

- Na versão web, Sair, Recomeçar, esquecer a configuração ou entrar com outra conta esvaziam as listas de pessoas bloqueadas e silenciadas que o navegador guardava para silenciar os avisos push (PR `fix/push-lists-sair`). Uma lista lida antes disso, ou sem conta aberta, não chega mais depois; bloquear o app mantém as listas. Conferência em `docs/verification/fix-push-lists-sair.md`.
