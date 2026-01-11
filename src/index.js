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

// Helper: Download user profile photo (returns base64 - kept in database for simplicity)
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
    console.log(`📷 [${botName}] Não foi possível obter foto de perfil: ${error.message}`);
    return null;
  }
}


// Sync message via backend function (avoids RLS issues on direct table writes)
async function syncViaBackendFunction(botName, botTokenPrefix, payload) {
  const url = `${SUPABASE_URL}/functions/v1/telegram-mtproto-sync`;

  try {
    const response = await fetch(url, {
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

    // Verbose diagnostics (safe to log URL + status; never log keys)
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ [${botName}] Falha ao sincronizar (telegram-mtproto-sync):`, response.status, errorText);
      console.error(`   URL: ${url}`);
      return false;
    }

    const okText = await response.text().catch(() => '');
    if (okText) {
      console.log(`✅ [${botName}] Sync OK (${response.status}) -> ${url} | resp: ${okText.slice(0, 200)}`);
    } else {
      console.log(`✅ [${botName}] Sync OK (${response.status}) -> ${url}`);
    }

    return true;
  } catch (error) {
    console.error(`❌ [${botName}] Erro ao chamar telegram-mtproto-sync:`, error);
    console.error(`   URL: ${url}`);
    return false;
  }
}

// Helper: Upload media to storage via edge function (with deduplication)
// Returns { fileUniqueId, publicUrl } or null
async function uploadMediaToStorage(base64Data, mimeType, fileUniqueId, fileId, botId, mediaType, botName) {
  const url = `${SUPABASE_URL}/functions/v1/upload-telegram-media`;
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'x-sync-secret': TELEGRAM_SYNC_SECRET,
      },
      body: JSON.stringify({
        base64Data,
        mimeType,
        fileUniqueId,
        fileId,
        botId,
        mediaType,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ [${botName}] Falha ao fazer upload de mídia:`, response.status, errorText);
      return null;
    }

    const result = await response.json();
    
    if (result.success) {
      if (result.cached) {
        console.log(`📦 [${botName}] Mídia encontrada no cache: ${fileUniqueId}`);
      } else {
        console.log(`☁️ [${botName}] Mídia enviada para storage: ${result.storagePath}`);
      }
      // Return both fileUniqueId and publicUrl for reference
      return { 
        fileUniqueId: fileUniqueId, 
        publicUrl: result.publicUrl 
      };
    }
    
    return null;
  } catch (error) {
    console.error(`❌ [${botName}] Erro ao fazer upload de mídia:`, error);
    return null;
  }
}

// Helper: Determine media type and info from message
function getMediaInfo(message) {
  const media = message.media;
  const photo = message.photo || media?.photo;
  const document = message.document || media?.document;
  
  // Check for sticker first (it's a special type of document)
  if (media?.className === 'MessageMediaDocument' || document) {
    const doc = document || media?.document;
    if (doc) {
      const attrs = doc.attributes || [];
      
      // Check if it's a sticker
      const stickerAttr = attrs.find(a => 
        a.className === 'DocumentAttributeSticker' || 
        a.stickerset !== undefined
      );
      
      if (stickerAttr) {
        const isAnimated = (doc.mimeType === 'application/x-tgsticker');
        const isVideo = (doc.mimeType === 'video/webm');
        
        return {
          type: 'sticker',
          subType: isAnimated ? 'animated' : (isVideo ? 'video' : 'static'),
          mimeType: doc.mimeType || 'image/webp',
          id: doc.id,
          accessHash: doc.accessHash,
          emoji: stickerAttr.alt || null,
          mediaObject: doc
        };
      }
      
      // Check for GIF/animation
      const animatedAttr = attrs.find(a => a.className === 'DocumentAttributeAnimated');
      if (animatedAttr || doc.mimeType === 'video/mp4' && attrs.some(a => a.className === 'DocumentAttributeVideo' && a.nosound)) {
        return {
          type: 'animation',
          subType: 'gif',
          mimeType: doc.mimeType || 'video/mp4',
          id: doc.id,
          accessHash: doc.accessHash,
          mediaObject: doc
        };
      }
      
      // Regular document/video/audio
      const mimeType = doc.mimeType || 'application/octet-stream';
      let type = 'document';
      if (mimeType.startsWith('video/')) type = 'video';
      else if (mimeType.startsWith('audio/')) type = 'audio';
      else if (mimeType.startsWith('image/')) type = 'photo';
      
      return {
        type,
        subType: null,
        mimeType,
        id: doc.id,
        accessHash: doc.accessHash,
        mediaObject: doc
      };
    }
  }
  
  // Regular photo
  if (photo) {
    return {
      type: 'photo',
      subType: null,
      mimeType: 'image/jpeg',
      id: photo.id,
      accessHash: photo.accessHash,
      mediaObject: photo
    };
  }
  
  // Fallback for other media types
  if (media) {
    return {
      type: 'unknown',
      subType: media.className || null,
      mimeType: 'application/octet-stream',
      id: null,
      accessHash: null,
      mediaObject: message
    };
  }
  
  return null;
}

// Helper: Download message media (photo/doc/sticker/animation) and upload to storage (with deduplication)
// Returns { fileUniqueId, publicUrl } or null
async function downloadMessageMedia(client, message, botName, botId) {
  try {
    const mediaInfo = getMediaInfo(message);
    
    if (!mediaInfo) return null;
    
    // Log what we're processing
    const mediaDesc = mediaInfo.subType 
      ? `${mediaInfo.type}/${mediaInfo.subType}` 
      : mediaInfo.type;
    console.log(`📎 [${botName}] Processando mídia: ${mediaDesc} (${mediaInfo.mimeType})`);
    
    // Handle animated stickers (TGS) - skip for now as they're complex Lottie files
    if (mediaInfo.type === 'sticker' && mediaInfo.subType === 'animated') {
      console.log(`⏭️ [${botName}] Sticker animado (TGS) ignorado - formato Lottie não suportado`);
      return null;
    }
    
    // Download media
    let buffer = null;
    try {
      buffer = await client.downloadMedia(mediaInfo.mediaObject);
    } catch (downloadError) {
      console.error(`📎 [${botName}] Erro no download:`, downloadError?.message);
      return null;
    }

    if (!buffer || buffer.length === 0) {
      console.warn(`📎 [${botName}] Buffer vazio após download`);
      return null;
    }
    
    // Validate buffer is actually binary data
    if (typeof buffer === 'string') {
      console.warn(`📎 [${botName}] Buffer retornado como string, convertendo...`);
      buffer = Buffer.from(buffer, 'binary');
    }
    
    // Generate fileUniqueId
    let fileUniqueId = mediaInfo.id ? bigIntToString(mediaInfo.id) : null;
    let fileId = mediaInfo.accessHash ? bigIntToString(mediaInfo.accessHash) : null;
    
    // Fallback fileUniqueId if needed
    if (!fileUniqueId) {
      const crypto = require('crypto');
      const hash = crypto.createHash('md5').update(buffer).digest('hex').substring(0, 16);
      fileUniqueId = `gen_${hash}`;
      console.log(`📎 [${botName}] Gerado fileUniqueId de fallback: ${fileUniqueId}`);
    }

    // Determine the correct extension based on media type
    let mimeType = mediaInfo.mimeType;
    let storageMediaType = mediaInfo.type;
    
    // Normalize sticker types for storage
    if (mediaInfo.type === 'sticker') {
      if (mediaInfo.subType === 'video') {
        mimeType = 'video/webm';
        storageMediaType = 'sticker';
      } else {
        mimeType = 'image/webp';
        storageMediaType = 'sticker';
      }
    } else if (mediaInfo.type === 'animation') {
      mimeType = 'video/mp4';
      storageMediaType = 'animation';
    }

    // Ensure buffer is a proper Buffer before base64 encoding
    const properBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const base64 = properBuffer.toString('base64');
    
    // Validate base64 output
    if (!base64 || base64.length === 0) {
      console.error(`📎 [${botName}] Falha ao converter buffer para base64`);
      return null;
    }
    
    // Don't include data URI prefix - send raw base64
    // The edge function will handle adding the prefix if needed
    const base64Data = base64;
    
    console.log(`📎 [${botName}] Mídia baixada: ${Math.round(properBuffer.length / 1024)}KB (${mimeType}) [ID: ${fileUniqueId}]`);
    
    // Upload to storage with deduplication - returns { fileUniqueId, publicUrl }
    const result = await uploadMediaToStorage(base64Data, mimeType, fileUniqueId, fileId, botId, storageMediaType, botName);
    
    if (!result) {
      console.warn(`⚠️ [${botName}] Upload falhou, mídia não será salva`);
      return null;
    }
    
    return result;
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

      // Download message media if present - returns { fileUniqueId, publicUrl } or null
      let mediaResult = null;
      if (hasMedia) {
        const clientInfo = telegramClients.get(botId);
        if (clientInfo) {
          mediaResult = await downloadMessageMedia(clientInfo.client, message, botName, botId);
        }
      }

      // Extract inline keyboard buttons if present
      let replyMarkup = null;
      const rmCandidate = message.replyMarkup ?? null;

      // Extract buttons (ReplyInlineMarkup -> rows -> buttons)
      if (rmCandidate?.rows && Array.isArray(rmCandidate.rows)) {
        replyMarkup = {
          rows: rmCandidate.rows.map((row) => ({
            buttons: (row?.buttons || []).map((button) => ({
              text: button?.text || '',
              url: button?.url || null,
              callbackData: button?.data
                ? typeof button.data === 'string'
                  ? button.data
                  : Buffer.isBuffer(button.data)
                    ? button.data.toString('utf-8')
                    : String(button.data)
                : null,
            })),
          })),
        };

        console.log(
          `🔘 [${botName}] Mensagem com ${replyMarkup.rows.reduce((acc, r) => acc + r.buttons.length, 0)} botões inline`
        );
      }

      // Build payload with fileUniqueId instead of mediaUrl
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
        fileUniqueId: mediaResult?.fileUniqueId || null, // Send fileUniqueId instead of mediaUrl
        replyMarkup,
      };

      // Sync via backend function
      const success = await syncViaBackendFunction(botName, botTokenPrefix, payload);
      if (success) {
        console.log(`✅ [${botName}] Mensagem sincronizada${mediaResult ? ' (com mídia: ' + mediaResult.fileUniqueId + ')' : ''}`);
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

// Reload all bots (called by Lovable when a new token is added)
app.post('/reload-bots', async (req, res) => {
  const syncSecret = req.headers['x-sync-secret'];
  
  if (syncSecret !== TELEGRAM_SYNC_SECRET) {
    console.log('⚠️ Tentativa de reload sem autenticação válida');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { action, botId } = req.body || {};
  console.log(`🔄 Reload request - Action: ${action || 'full_reload'}, Bot ID: ${botId || 'all'}`);
  
  // Disconnect all existing bots
  console.log('🔌 Desconectando bots existentes...');
  for (const [id] of telegramClients) {
    await disconnectBot(id);
  }

  // Reconnect all bots (fetches fresh list from database)
  await loadAndConnectBots();

  res.json({
    success: true,
    message: 'Bots reloaded successfully',
    connectedBots: telegramClients.size,
    action,
    botId
  });
});

// Legacy reload endpoint (keep for backwards compatibility)
app.post('/reload', async (req, res) => {
  console.log('🔄 Recarregando bots (legacy endpoint)...');
  
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

// Edit message via a specific bot
app.post('/edit/:botId', async (req, res) => {
  const { botId } = req.params;
  const { chatId, messageId, text } = req.body;

  const clientInfo = telegramClients.get(botId);
  
  if (!clientInfo) {
    return res.status(404).json({ error: 'Bot não conectado' });
  }

  try {
    await clientInfo.client.invoke(
      new Api.messages.EditMessage({
        peer: chatId,
        id: parseInt(messageId),
        message: text,
      })
    );
    
    console.log(`✏️ [${clientInfo.botName}] Mensagem ${messageId} editada no chat ${chatId}`);
    res.json({
      success: true,
      messageId,
      chatId
    });
  } catch (error) {
    console.error(`Erro ao editar mensagem [${clientInfo.botName}]:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Delete message via a specific bot
app.post('/delete/:botId', async (req, res) => {
  const { botId } = req.params;
  const { chatId, messageId } = req.body;

  const clientInfo = telegramClients.get(botId);
  
  if (!clientInfo) {
    return res.status(404).json({ error: 'Bot não conectado' });
  }

  try {
    await clientInfo.client.invoke(
      new Api.messages.DeleteMessages({
        id: [parseInt(messageId)],
        revoke: true, // Delete for both sides
      })
    );
    
    console.log(`🗑️ [${clientInfo.botName}] Mensagem ${messageId} deletada do chat ${chatId}`);
    res.json({
      success: true,
      messageId,
      chatId
    });
  } catch (error) {
    console.error(`Erro ao deletar mensagem [${clientInfo.botName}]:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Delete multiple messages via a specific bot
app.post('/delete-messages/:botId', async (req, res) => {
  const { botId } = req.params;
  const { chatId, messageIds } = req.body;

  const clientInfo = telegramClients.get(botId);
  
  if (!clientInfo) {
    return res.status(404).json({ error: 'Bot não conectado' });
  }

  try {
    const ids = messageIds.map(id => parseInt(id));
    
    await clientInfo.client.invoke(
      new Api.messages.DeleteMessages({
        id: ids,
        revoke: true, // Delete for both sides
      })
    );
    
    console.log(`🗑️ [${clientInfo.botName}] ${ids.length} mensagens deletadas do chat ${chatId}`);
    res.json({
      success: true,
      deletedCount: ids.length,
      chatId
    });
  } catch (error) {
    console.error(`Erro ao deletar mensagens [${clientInfo.botName}]:`, error);
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
