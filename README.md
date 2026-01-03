# Telegram MTProto Server

Este servidor Node.js usa gramjs para conectar ao Telegram via MTProto como bot, recebendo mensagens em paralelo ao webhook existente.

## Pré-requisitos

1. **API ID e API Hash do Telegram**
   - Acesse https://my.telegram.org/apps
   - Crie um aplicativo (se não tiver)
   - Copie o `api_id` e `api_hash`

2. **Bot Token**
   - Pegue do @BotFather no Telegram

3. **Supabase Service Role Key**
   - Acesse o painel do Supabase → Settings → API
   - Copie a `service_role` key (NÃO a anon key!)

## Configuração

1. Clone/copie os arquivos para seu servidor

2. Instale as dependências:
   ```bash
   npm install
   ```

3. Configure o `.env`:
   ```bash
   cp .env.example .env
   # Edite o .env com suas credenciais
   ```

4. Inicie o servidor:
   ```bash
   npm start
   ```

## Deploy (Render/Railway/Fly.io)

### Render

1. Crie um novo Web Service
2. Conecte ao repositório ou faça upload dos arquivos
3. Configure as variáveis de ambiente:
   - `TELEGRAM_API_ID`
   - `TELEGRAM_API_HASH`
   - `BOT_TOKEN`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`
4. Start command: `npm start`

### Railway

1. Crie um novo projeto
2. Deploy from GitHub ou upload
3. Configure as variáveis em Settings → Variables
4. Railway detecta automaticamente o package.json

### Fly.io

1. Instale o CLI: `curl -L https://fly.io/install.sh | sh`
2. Login: `fly auth login`
3. Deploy: `fly launch`
4. Configure secrets:
   ```bash
   fly secrets set TELEGRAM_API_ID=xxx
   fly secrets set TELEGRAM_API_HASH=xxx
   fly secrets set BOT_TOKEN=xxx
   fly secrets set SUPABASE_URL=xxx
   fly secrets set SUPABASE_SERVICE_KEY=xxx
   ```

## Endpoints

- `GET /health` - Status do servidor
- `POST /reconnect` - Reconectar ao Telegram
- `POST /send` - Enviar mensagem (body: { chatId, text })

## Como funciona

1. O servidor conecta ao Telegram via MTProto usando o Bot Token
2. Recebe TODAS as mensagens em paralelo ao webhook HTTP
3. Sincroniza as mensagens com o Supabase via Edge Function
4. Inclui mensagens de saída (out: true) - respostas do bot

## Importante

- **NÃO desabilita o webhook** - funciona em paralelo
- **Converte BigInt para String** - evita erros no JSON
- **Processa mensagens de saída** - inclui respostas do bot
- **Reconexão automática** - se desconectar, reconecta
