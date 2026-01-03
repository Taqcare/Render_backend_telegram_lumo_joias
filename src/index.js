// Only load dotenv if .env file exists (for local development)
try {
  require('dotenv').config();
} catch (e) {
  // Running in production without .env file
}

const express = require('express');
const { TelegramClient } = require('telegram');
const { NewMessage } = require('telegram/events');
const { StringSession } = require('telegram/sessions');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// Configuration - log what we have for debugging
console.log('🔧 Verificando variáveis de ambiente...');
console.log('   SUPABASE_URL:', process.env.SUPABASE_URL ? '✓ definido' : '✗ NÃO definido');
console.log('   SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY ? '✓ definido' : '✗ NÃO definido');
console.log('   TELEGRAM_API_ID:', process.env.TELEGRAM_API_ID ? '✓ definido' : '✗ NÃO definido');
console.log('   TELEGRAM_API_HASH:', process.env.TELEGRAM_API_HASH ? '✓ definido' : '✗ NÃO definido');
console.log('   TELEGRAM_SYNC_SECRET:', process.env.TELEGRAM_SYNC_SECRET ? '✓ definido' : '✗ NÃO definido');

const API_ID = parseInt(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const TELEGRAM_SYNC_SECRET = process.env.TELEGRAM_SYNC_SECRET;
const PORT = process.env.PORT || 3000;

// Validate before creating Supabase client
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ SUPABASE_URL e SUPABASE_ANON_KEY são obrigatórios!');
  console.error('   Verifique as variáveis de ambiente no Render.');
  console.error('   Variáveis recebidas:');
  console.error('   - SUPABASE_URL:', SUPABASE_URL || '(vazio)');
  console.error('   - SUPABASE_ANON_KEY:', SUPABASE_ANON_KEY ? '(valor presente)' : '(vazio)');
  process.exit(1);
}

// Supabase client (for sync operations)
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Map of Telegram clients (one per bot)
const telegramClients = new Map();

// Helper: Convert BigInt to String safely
function bigIntToString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object' && value !== null) {
    if (value.value !== undefined && typeof value.value === 'bigint') {
      return value.value.toString();
    }
  }
  return String(value);
}

// Helper: Extract chat ID from peer
function extractChatId(peerId) {
  if (!peerId) return null;
  if (peerId.userId) return bigIntToString(peerId.userId);
  if (peerId.chatId) return bigIntToString(peerId.chatId);
  if (peerId.channelId) return bigIntToString(peerId.channelId);
  return null;
}

// Helper: Extract sender info
function extractSenderInfo(message) {
  const sender = message._sender || message.sender;
  
  if (!sender) {
    return {
      firstName: null,
      lastName: null,
      username: null,
      isBot: false
    };
  }
  
  return {
    firstName: sender.firstName || null,
    lastName: sender.lastName || null,
    username: sender.username || null,
    isBot: sender.bot || false
  };
}

// Sync to Supabase directly
async function syncToSupabase(botId, chatData, messageData) {
  try {
    // Upsert chat
    const { error: chatError } = await supabase
      .from('telegram_chats')
      .upsert({
        bot_id: botId,
        chat_id: chatData.chat_id,
        username: chatData.username,
        first_name: chatData.first_name,
        last_name: chatData.last_name,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'bot_id,chat_id'
      });

    if (chatError) {
      console.error(`[Bot ${botId}] Erro ao salvar chat:`, chatError);
      return false;
    }

    // Get saved chat ID
    const { data: savedChat } = await supabase
      .from('telegram_chats')
      .select('id')
      .eq('bot_id', botId)
      .eq('chat_id', chatData.chat_id)
      .single();

    if (savedChat) {
      // Insert message
      const { error: msgError } = await supabase
        .from('telegram_messages')
        .upsert({
          telegram_chat_id: savedChat.id,
          telegram_message_id: messageData.message_id,
          text: messageData.text,
          direction: messageData.direction,
          sent_at: messageData.sent_at
        }, {
          onConflict: 'telegram_chat_id,telegram_message_id'
        });

      if (msgError) {
        console.error(`[Bot ${botId}] Erro ao salvar mensagem:`, msgError);
        return false;
      }

      return true;
    }

    return false;
  } catch (error) {
    console.error(`[Bot ${botId}] Erro na sincronização:`, error);
    return false;
  }
}

// Create message handler for a specific bot
function createMessageHandler(botId, botName) {
  return async (event) => {
    try {
      const message = event.message;
      if (!message) return;

      // Extract chat ID
      const chatId = extractChatId(message.peerId);
      if (!chatId) return;

      // Check if outgoing (bot's own message)
      const isOutgoing = message.out === true;
      const direction = isOutgoing ? 'outgoing' : 'incoming';

      // Extract sender info
      const senderInfo = extractSenderInfo(message);

      // Log message
      console.log(`📨 [${botName}] ${direction.toUpperCase()} | Chat: ${chatId} | ${senderInfo.firstName || 'Unknown'}: ${message.text?.substring(0, 50) || '[sem texto]'}`);

      // Prepare data
      const chatData = {
        chat_id: parseInt(chatId),
        username: senderInfo.username,
        first_name: senderInfo.firstName,
        last_name: senderInfo.lastName
      };

      const messageData = {
        message_id: parseInt(bigIntToString(message.id)),
        text: message.text || message.message || '',
        direction: direction,
        sent_at: message.date ? new Date(message.date * 1000).toISOString() : new Date().toISOString()
      };

      // Sync to Supabase
      const success = await syncToSupabase(botId, chatData, messageData);
      if (success) {
        console.log(`✅ [${botName}] Mensagem sincronizada`);
      }

    } catch (error) {
      console.error(`[${botName}] Erro ao processar mensagem:`, error);
    }
  };
}

// Connect a specific bot
async function connectBot(bot) {
  const { id: botId, nome: botName, api_token: botToken } = bot;

  if (!botToken) {
    console.log(`⚠️ [${botName}] Sem token configurado, pulando...`);
    return false;
  }

  // Check if already connected
  if (telegramClients.has(botId)) {
    console.log(`ℹ️ [${botName}] Já conectado`);
    return true;
  }

  try {
    console.log(`🔄 [${botName}] Conectando...`);

    const client = new TelegramClient(
      new StringSession(''),
      API_ID,
      API_HASH,
      {
        connectionRetries: 5,
        retryDelay: 1000,
        autoReconnect: true
      }
    );

    await client.start({
      botAuthToken: botToken,
    });

    // Get bot info
    const me = await client.getMe();
    console.log(`✅ [${botName}] Conectado como @${me.username}`);

    // Add message handler
    client.addEventHandler(
      createMessageHandler(botId, botName),
      new NewMessage({})
    );

    // Store client
    telegramClients.set(botId, { 
      client, 
      botName, 
      botUsername: me.username,
      connectedAt: new Date().toISOString()
    });

    return true;

  } catch (error) {
    console.error(`❌ [${botName}] Erro ao conectar:`, error.message);
    return false;
  }
}

// Disconnect a bot
async function disconnectBot(botId) {
  const clientInfo = telegramClients.get(botId);
  if (clientInfo) {
    try {
      await clientInfo.client.disconnect();
      telegramClients.delete(botId);
      console.log(`🔌 [${clientInfo.botName}] Desconectado`);
    } catch (error) {
      console.error(`Erro ao desconectar bot ${botId}:`, error);
    }
  }
}

// Load and connect all bots via Edge Function
async function loadAndConnectBots() {
  console.log('📋 Carregando bots via Edge Function...');

  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/telegram-bots-list`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-sync-secret': TELEGRAM_SYNC_SECRET
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Erro ao buscar bots:', response.status, errorText);
      return;
    }

    const { bots } = await response.json();
    console.log(`📊 Encontrados ${bots.length} bots ativos com token`);

  // Connect each bot
  let connectedCount = 0;
  for (const bot of bots) {
    const success = await connectBot(bot);
    if (success) connectedCount++;
  }

    console.log(`\n🚀 ${connectedCount}/${bots.length} bots conectados via MTProto`);

  } catch (error) {
    console.error('Erro ao carregar bots:', error.message);
  }
}

// === HTTP Endpoints ===

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connectedBots: telegramClients.size,
    bots: Array.from(telegramClients.entries()).map(([id, info]) => ({
      id,
      name: info.botName,
      username: info.botUsername,
      connectedAt: info.connectedAt
    })),
    timestamp: new Date().toISOString()
  });
});

// Reload all bots
app.post('/reload', async (req, res) => {
  console.log('🔄 Recarregando bots...');
  
  // Disconnect all
  for (const [botId] of telegramClients) {
    await disconnectBot(botId);
  }

  // Reconnect
  await loadAndConnectBots();

  res.json({
    status: 'reloaded',
    connectedBots: telegramClients.size
  });
});

// Connect a specific bot
app.post('/connect/:botId', async (req, res) => {
  const { botId } = req.params;

  const { data: bot, error } = await supabase
    .from('bots_black')
    .select('id, nome, api_token, ativo')
    .eq('id', botId)
    .single();

  if (error || !bot) {
    return res.status(404).json({ error: 'Bot não encontrado' });
  }

  const success = await connectBot(bot);
  res.json({ success, botId, botName: bot.nome });
});

// Disconnect a specific bot
app.post('/disconnect/:botId', async (req, res) => {
  const { botId } = req.params;
  await disconnectBot(botId);
  res.json({ success: true, botId });
});

// Status of a specific bot
app.get('/status/:botId', (req, res) => {
  const { botId } = req.params;
  const clientInfo = telegramClients.get(botId);

  if (clientInfo) {
    res.json({
      connected: true,
      botId,
      botName: clientInfo.botName,
      botUsername: clientInfo.botUsername,
      connectedAt: clientInfo.connectedAt
    });
  } else {
    res.json({
      connected: false,
      botId
    });
  }
});

// Send message via a specific bot
app.post('/send/:botId', async (req, res) => {
  const { botId } = req.params;
  const { chatId, text } = req.body;

  const clientInfo = telegramClients.get(botId);
  
  if (!clientInfo) {
    return res.status(404).json({ error: 'Bot não conectado' });
  }

  try {
    const result = await clientInfo.client.sendMessage(chatId, { message: text });
    res.json({
      success: true,
      messageId: bigIntToString(result.id)
    });
  } catch (error) {
    console.error(`Erro ao enviar mensagem [${clientInfo.botName}]:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Start server and connect bots
async function start() {
  try {
    // Validate Telegram config
    if (!API_ID || !API_HASH) {
      console.error('❌ TELEGRAM_API_ID e TELEGRAM_API_HASH são obrigatórios!');
      console.error('   Obtenha em: https://my.telegram.org/apps');
      process.exit(1);
    }

    if (!TELEGRAM_SYNC_SECRET) {
      console.error('❌ TELEGRAM_SYNC_SECRET é obrigatório!');
      process.exit(1);
    }

    // Start Express server
    app.listen(PORT, () => {
      console.log(`🌐 Servidor HTTP rodando na porta ${PORT}`);
    });

    // Connect bots
    await loadAndConnectBots();

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n🛑 Encerrando...');
      for (const [botId] of telegramClients) {
        await disconnectBot(botId);
      }
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\n🛑 Recebido SIGTERM, encerrando...');
      for (const [botId] of telegramClients) {
        await disconnectBot(botId);
      }
      process.exit(0);
    });

  } catch (error) {
    console.error('Falha ao iniciar:', error);
    process.exit(1);
  }
}

start();
