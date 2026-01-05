// Only load dotenv if .env file exists (for local development)
try {
  require('dotenv').config();
} catch (e) {
  // Running in production without .env file
}

const express = require('express');
const { TelegramClient, Api } = require('telegram');
const { NewMessage } = require('telegram/events');
const { StringSession } = require('telegram/sessions');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// Configuration - log what we have for debugging
console.log('🔧 Verificando variáveis de ambiente...');
console.log('   SUPABASE_URL:', process.env.SUPABASE_URL ? '✓ definido' : '✗ NÃO definido');
console.log('   SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? '✓ definido' : '✗ NÃO definido');
console.log('   SUPABASE_SERVICE_KEY:', process.env.SUPABASE_SERVICE_KEY ? '✓ definido' : '✗ NÃO definido');
console.log('   SUPABASE_ANON_KEY:', process.env.SUPABASE_ANON_KEY ? '✓ definido' : '✗ NÃO definido');
console.log('   TELEGRAM_API_ID:', process.env.TELEGRAM_API_ID ? '✓ definido' : '✗ NÃO definido');
console.log('   TELEGRAM_API_HASH:', process.env.TELEGRAM_API_HASH ? '✓ definido' : '✗ NÃO definido');
console.log('   TELEGRAM_SYNC_SECRET:', process.env.TELEGRAM_SYNC_SECRET ? '✓ definido' : '✗ NÃO definido');

const API_ID = parseInt(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const TELEGRAM_SYNC_SECRET = process.env.TELEGRAM_SYNC_SECRET;
const PORT = process.env.PORT || 3000;

function getJwtRole(jwt) {
  try {
    const payload = jwt?.split?.('.')?.[1];
    if (!payload) return null;
    const json = Buffer.from(payload, 'base64').toString('utf8');
    return JSON.parse(json)?.role ?? null;
  } catch {
    return null;
  }
}

console.log('   SUPABASE_KEY_ROLE:', getJwtRole(SUPABASE_SERVICE_ROLE_KEY) || '(não identificado)');

// Validate required env for calling backend functions
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ SUPABASE_URL e SUPABASE_ANON_KEY são obrigatórios!');
  console.error('   (A anon key é usada apenas para chamar as funções do backend.)');
  console.error('   Variáveis recebidas:');
  console.error('   - SUPABASE_URL:', SUPABASE_URL || '(vazio)');
  console.error('   - SUPABASE_ANON_KEY:', SUPABASE_ANON_KEY ? '(valor presente)' : '(vazio)');
  process.exit(1);
}

// Optional admin client (only needed for /connect/:botId)
const supabaseAdmin = SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

if (!supabaseAdmin) {
  console.warn('⚠️ SUPABASE_SERVICE_ROLE_KEY não definido: /connect/:botId ficará indisponível.');
}

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
      isBot: false,
      photo: null
    };
  }
  
  return {
    firstName: sender.firstName || null,
    lastName: sender.lastName || null,
    username: sender.username || null,
    isBot: sender.bot || false,
    photo: sender.photo || null
  };
}

// Helper: Download user profile photo and return base64 data URL
async function getProfilePhotoUrl(client, userPeer, botName) {
  try {
    const entity = (typeof userPeer === 'object' && userPeer !== null)
      ? userPeer
      : await client.getEntity(userPeer);

    const result = await client.invoke(
      new Api.photos.GetUserPhotos({
        userId: entity,
        offset: 0,
        maxId: 0,
        limit: 1,
      })
    );

    const photos = result?.photos ?? [];
    if (!Array.isArray(photos) || photos.length === 0) return null;

    const photo = photos[0];
    const sizes = photo?.sizes || [];
    const smallSize =
      sizes.find((s) => s.type === 'a' || s.type === 's' || s.type === 'm') || sizes[0];

    if (!smallSize) return null;

    const buffer = await client.downloadMedia(photo, { thumb: smallSize });
    if (!buffer) return null;

    const base64 = Buffer.from(buffer).toString('base64');
    return `data:image/jpeg;base64,${base64}`;
  } catch (error) {
    // Silently fail - not all users have profile photos or we may not have permission
    console.log(`📷 [${botName}] Não foi possível obter foto de perfil: ${error.message}`);
    return null;
  }
}


// Sync message via backend function (avoids RLS issues on direct table writes)
async function syncViaBackendFunction(botName, botTokenPrefix, payload) {
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/telegram-mtproto-sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        'x-sync-secret': TELEGRAM_SYNC_SECRET,
      },
      body: JSON.stringify({
        type: 'message',
        data: {
          ...payload,
          botToken: botTokenPrefix,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ [${botName}] Falha ao sincronizar (telegram-mtproto-sync):`, response.status, errorText);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`❌ [${botName}] Erro ao chamar telegram-mtproto-sync:`, error);
    return false;
  }
}

// Helper: Download message media (photo/doc) and return base64 data URL
async function downloadMessageMedia(client, message, botName) {
  try {
    const photo = message.photo || message.media?.photo;
    const document = message.document || message.media?.document;
    const hasAnyMedia = !!(photo || document || message.media);

    if (!hasAnyMedia) return null;

    let buffer = null;
    let mimeType = 'image/jpeg';

    // Prefer explicit photo/document objects when available
    if (photo) {
      buffer = await client.downloadMedia(photo);
      mimeType = 'image/jpeg';
    } else if (document) {
      buffer = await client.downloadMedia(document);
      mimeType = document.mimeType || document.mime_type || 'application/octet-stream';
    } else {
      // Fallback: let GramJS infer from the message wrapper
      buffer = await client.downloadMedia(message);
      mimeType = 'image/jpeg';
    }

    if (!buffer) return null;

    const base64 = Buffer.from(buffer).toString('base64');
    console.log(`📎 [${botName}] Mídia baixada: ${Math.round(buffer.length / 1024)}KB (${mimeType})`);
    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    console.error(`📎 [${botName}] Erro ao baixar mídia:`, error?.message || error);
    return null;
  }
}


// Create message handler for a specific bot
function createMessageHandler(botId, botName, botTokenPrefix) {
  // Cache to avoid fetching photo too frequently
  const photoCache = new Map();
  
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

      // Check if message has media
      const hasMedia = !!(message.media || message.photo || message.document);
      
      // Log message
      const previewText = (message.text || message.message || '').substring(0, 50) || '[sem texto]';
      const mediaIndicator = hasMedia ? ' 📷' : '';
      console.log(
        `📨 [${botName}] ${direction.toUpperCase()}${mediaIndicator} | Chat: ${chatId} | ${senderInfo.firstName || 'Unknown'}: ${previewText}`
      );

      const sentAt = message.date
        ? new Date(message.date * 1000).toISOString()
        : new Date().toISOString();

      // Try to get profile photo for incoming messages (with caching)
      let profilePhotoUrl = null;
      if (!isOutgoing && !senderInfo.isBot) {
        const cacheKey = chatId;
        const cachedPhoto = photoCache.get(cacheKey);

        // Use cache if we have a non-null photo fetched in the last hour
        if (cachedPhoto?.url && (Date.now() - cachedPhoto.timestamp) < 3600000) {
          profilePhotoUrl = cachedPhoto.url;
        } else {
          // Fetch new photo
          const clientInfo = telegramClients.get(botId);
          if (clientInfo) {
            const userPeer = message._sender || message.sender || message.senderId || chatId;
            profilePhotoUrl = await getProfilePhotoUrl(clientInfo.client, userPeer, botName);

            // Only cache when we actually got an URL (avoid caching null for 1h)
            if (profilePhotoUrl) {
              photoCache.set(cacheKey, { url: profilePhotoUrl, timestamp: Date.now() });
            } else {
              photoCache.delete(cacheKey);
            }
          }
        }
      }

      // Download message media if present
      let mediaUrl = null;
      if (hasMedia) {
        const clientInfo = telegramClients.get(botId);
        if (clientInfo) {
          mediaUrl = await downloadMessageMedia(clientInfo.client, message, botName);
        }
      }

      const payload = {
        chatId: String(chatId),
        messageId: String(bigIntToString(message.id)),
        text: message.text || message.message || '',
        isOutgoing,
        date: sentAt,
        sender: {
          firstName: senderInfo.firstName,
          lastName: senderInfo.lastName,
          username: senderInfo.username,
          isBot: senderInfo.isBot,
        },
        profilePhotoUrl,
        mediaUrl,
      };

      // Sync via backend function
      const success = await syncViaBackendFunction(botName, botTokenPrefix, payload);
      if (success) {
        console.log(`✅ [${botName}] Mensagem sincronizada${mediaUrl ? ' (com mídia)' : ''}`);
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

    const botTokenPrefix = String(botToken).split(':')[0];

    // Add message handler
    client.addEventHandler(
      createMessageHandler(botId, botName, botTokenPrefix),
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
        'apikey': SUPABASE_ANON_KEY,
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

  if (!supabaseAdmin) {
    return res.status(503).json({
      error: 'SUPABASE_SERVICE_ROLE_KEY não configurado no servidor',
    });
  }

  const { data: bot, error } = await supabaseAdmin
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
