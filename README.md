# Robô de preços — Minha Fazenda Cacau

Este repositório guarda um robô que roda sozinho no GitHub, de segunda a sexta, às **10h e às 16h** (horário de Brasília). Ele busca o preço do cacau e grava tudo no arquivo `dados/precos.json`, que o aplicativo lê.

| O quê | Fonte |
|---|---|
| Preço do dia na Bahia, convencional e certificado (R$/@) | Mercado do Cacau, publicado pelo Notícias Agrícolas |
| Contrato de Nova York (US$/t) | Notícias Agrícolas |
| Dólar comercial | AwesomeAPI |
| Histórico mensal de 5 anos (R$/@) | Conab — preço recebido pelo produtor na Bahia (atualiza 1x por semana) |

O robô não precisa de servidor nem de cartão de crédito: roda nos minutos gratuitos do GitHub Actions.

## Como ligar (uma vez só, uns 10 minutos)

1. Crie uma conta gratuita em **github.com**.
2. Clique em **New repository**. Nome: `minha-fazenda-cacau-precos`. Marque **Public**. Clique em **Create repository**.
3. Na página do repositório vazio, clique em **uploading an existing file**. Arraste **todo o conteúdo desta pasta** (inclusive a pasta `.github`). Clique em **Commit changes**.
   - Se o navegador não mostrar a pasta `.github` (pastas que começam com ponto ficam ocultas), use o link **creating a new file**, digite o nome `.github/workflows/precos.yml` e cole o conteúdo do arquivo `precos.yml`.
4. Vá em **Settings → Actions → General**. Em **Workflow permissions**, marque **Read and write permissions** e salve.
5. Vá em **Actions**, escolha **Preços do cacau** e clique em **Run workflow**. Em um minuto aparece o primeiro arquivo de preços.
6. Ainda em **Actions**, abra a execução que acabou de rodar e clique no passo **Coletar preços**. Devem aparecer três linhas: `Diário:`, `Dólar:` e `Conab:`. Se alguma disser `falhou`, copie o texto e mande para quem montou o robô: é sinal de que o site da fonte mudou o formato.
7. No aplicativo: **Mercado → Ligar o robô de preços**, digite seu nome de usuário do GitHub.

O endereço que o aplicativo lê fica assim:

```
https://raw.githubusercontent.com/SEU-USUARIO/minha-fazenda-cacau-precos/main/dados/precos.json
```

## Se o preço parar de atualizar

Abra **Actions** e veja a última execução. O passo **Coletar preços** mostra o que foi lido. Se o site mudou o formato da tabela, o robô não grava preço errado: ele mantém o último preço bom e marca o erro em `status` dentro do `precos.json`.

O GitHub pausa robôs agendados quando o repositório fica 60 dias sem nenhuma mudança. Como o robô grava o preço a cada dia útil, isso não deve acontecer; se acontecer, abra **Actions**, escolha **Preços do cacau** e clique em **Enable workflow**.

## Observação sobre as fontes

O robô consulta cada página só duas vezes por dia útil. Para uso comercial do aplicativo (venda para outros produtores), vale formalizar com o Mercado do Cacau / Notícias Agrícolas o uso das cotações. A série da Conab é dado público.
