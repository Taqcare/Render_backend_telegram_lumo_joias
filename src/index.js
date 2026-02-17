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
const http = require('http');
const https = require('https');

const app = express();
// Only parse JSON for non-multipart requests (multipart is parsed manually)
app.use((req, res, next) => {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('multipart/form-data')) {
    next(); // Skip JSON parsing for multipart
  } else {
    express.json({ limit: '50mb' })(req, res, next);
  }
});

// ============= CONFIGURATION =============
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

// ============= RETRY & QUEUE CONFIGURATION =============
const RETRY_CONFIG = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2
};

const QUEUE_CONFIG = {
  maxConcurrent: 3,        // Max concurrent sync requests
  batchDelayMs: 100,       // Delay between batch items
  maxQueueSize: 1000       // Max items in queue before dropping oldest
};

// Keep-alive agents for better connection reuse
const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30000 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000 });

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

// ============= MESSAGE QUEUE SYSTEM =============
class MessageQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.activeRequests = 0;
    this.stats = {
      processed: 0,
      failed: 0,
      retried: 0,
      dropped: 0
    };
  }

  enqueue(item) {
    // Drop oldest items if queue is too large
    if (this.queue.length >= QUEUE_CONFIG.maxQueueSize) {
      const dropped = this.queue.shift();
      this.stats.dropped++;
      console.warn(`⚠️ Fila cheia, descartando mensagem antiga de [${dropped.botName}]`);
    }
    
    this.queue.push({
      ...item,
      enqueuedAt: Date.now(),
      retryCount: 0
    });
    
    this.processQueue();
  }

  async processQueue() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0 && this.activeRequests < QUEUE_CONFIG.maxConcurrent) {
      const item = this.queue.shift();
      this.activeRequests++;
      
      // Process item without awaiting to allow concurrency
      this.processItem(item)
        .catch(err => console.error('Queue processing error:', err))
        .finally(() => {
          this.activeRequests--;
          // Continue processing if there are more items
          if (this.queue.length > 0) {
            setTimeout(() => this.processQueue(), QUEUE_CONFIG.batchDelayMs);
          }
        });
    }

    this.processing = false;
  }

  async processItem(item) {
    try {
      const success = await syncViaBackendFunctionWithRetry(
        item.botName,
        item.botTokenPrefix,
        item.payload,
        item.retryCount
      );
      
      if (success) {
        this.stats.processed++;
        const mediaInfo = item.payload.fileUniqueId ? ` (mídia: ${item.payload.fileUniqueId})` : '';
        console.log(`✅ [${item.botName}] Mensagem sincronizada${mediaInfo}`);
      } else {
        this.stats.failed++;
      }
    } catch (error) {
      console.error(`❌ [${item.botName}] Erro fatal ao processar:`, error.message);
      this.stats.failed++;
    }
  }

  getStats() {
    return {
      ...this.stats,
      queueSize: this.queue.length,
      activeRequests: this.activeRequests
    };
  }
}

const messageQueue = new MessageQueue();

// ============= UTILITY FUNCTIONS =============

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

// Helper: Calculate exponential backoff delay
function calculateBackoffDelay(retryCount) {
  const delay = Math.min(
    RETRY_CONFIG.baseDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, retryCount),
    RETRY_CONFIG.maxDelayMs
  );
  // Add jitter (±25%)
  const jitter = delay * (0.75 + Math.random() * 0.5);
  return Math.floor(jitter);
}

// Helper: Sleep with promise
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============= PROFILE PHOTO =============

// Helper: Download user profile photo (returns base64)
async function getProfilePhotoUrl(client, userPeer, botName) {
  try {
    // Check if client is connected before attempting operation
    if (!client.connected) {
      console.log(`📷 [${botName}] Cliente desconectado, pulando foto de perfil`);
      return null;
    }
    
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
    // Don't log connection-related errors as they're expected during reconnection
    if (!error.message?.includes('disconnected') && !error.message?.includes('Not connected')) {
      console.log(`📷 [${botName}] Não foi possível obter foto de perfil: ${error.message}`);
    }
    return null;
  }
}

// ============= FETCH WITH RETRY =============

// Enhanced fetch with retry and backoff
async function fetchWithRetry(url, options, retryCount = 0) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout
  
  try {
    const fetchOptions = {
      ...options,
      signal: controller.signal,
      // Use keep-alive agent
      agent: url.startsWith('https') ? httpsAgent : httpAgent
    };
    
    const response = await fetch(url, fetchOptions);
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    
    // Check if we should retry
    const isRetryable = 
      error.name === 'AbortError' ||
      error.code === 'ECONNRESET' ||
      error.code === 'ECONNREFUSED' ||
      error.code === 'ETIMEDOUT' ||
      error.message?.includes('fetch failed') ||
      error.message?.includes('network');
    
    if (isRetryable && retryCount < RETRY_CONFIG.maxRetries) {
      const delay = calculateBackoffDelay(retryCount);
      console.log(`🔄 Retry ${retryCount + 1}/${RETRY_CONFIG.maxRetries} em ${delay}ms para ${url.split('/').pop()}`);
      await sleep(delay);
      return fetchWithRetry(url, options, retryCount + 1);
    }
    
    throw error;
  }
}

// ============= SYNC FUNCTIONS =============

// Sync message via backend function with retry
async function syncViaBackendFunctionWithRetry(botName, botTokenPrefix, payload, initialRetryCount = 0) {
  const url = `${SUPABASE_URL}/functions/v1/telegram-mtproto-sync`;
  let retryCount = initialRetryCount;

  while (retryCount <= RETRY_CONFIG.maxRetries) {
    try {
      const response = await fetchWithRetry(url, {
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
        
        // Don't retry on 4xx errors (client errors)
        if (response.status >= 400 && response.status < 500) {
          console.error(`❌ [${botName}] Erro cliente (${response.status}):`, errorText);
          return false;
        }
        
        // Retry on 5xx errors
        if (retryCount < RETRY_CONFIG.maxRetries) {
          const delay = calculateBackoffDelay(retryCount);
          console.warn(`⚠️ [${botName}] Erro ${response.status}, retry em ${delay}ms...`);
          messageQueue.stats.retried++;
          await sleep(delay);
          retryCount++;
          continue;
        }
        
        console.error(`❌ [${botName}] Falha após ${RETRY_CONFIG.maxRetries} tentativas:`, errorText);
        return false;
      }

      const okText = await response.text().catch(() => '');
      if (okText) {
        console.log(`✅ [${botName}] Sync OK (${response.status}) | resp: ${okText.slice(0, 100)}`);
      }
      return true;
      
    } catch (error) {
      if (retryCount >= RETRY_CONFIG.maxRetries) {
        console.error(`❌ [${botName}] Erro fatal após retries:`, error.message);
        return false;
      }
      
      const delay = calculateBackoffDelay(retryCount);
      console.warn(`⚠️ [${botName}] Erro de rede, retry ${retryCount + 1} em ${delay}ms:`, error.message);
      messageQueue.stats.retried++;
      await sleep(delay);
      retryCount++;
    }
  }
  
  return false;
}

// Legacy sync function (direct call without queue)
async function syncViaBackendFunction(botName, botTokenPrefix, payload) {
  return syncViaBackendFunctionWithRetry(botName, botTokenPrefix, payload, 0);
}

// ============= MEDIA HANDLING =============

// Helper: Upload media to storage via edge function (with deduplication)
async function uploadMediaToStorage(base64Data, mimeType, fileUniqueId, fileId, botId, mediaType, botName) {
  const url = `${SUPABASE_URL}/functions/v1/upload-telegram-media`;
  
  try {
    const response = await fetchWithRetry(url, {
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
      return { 
        fileUniqueId: fileUniqueId, 
        publicUrl: result.publicUrl 
      };
    }
    
    return null;
  } catch (error) {
    console.error(`❌ [${botName}] Erro ao fazer upload de mídia:`, error.message);
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

// Helper: Download message media with connection check
async function downloadMessageMedia(client, message, botName, botId) {
  try {
    // Check if client is connected
    if (!client.connected) {
      console.log(`📎 [${botName}] Cliente desconectado, pulando download de mídia`);
      return null;
    }
    
    const mediaInfo = getMediaInfo(message);
    
    if (!mediaInfo) return null;
    
    // Log what we're processing
    const mediaDesc = mediaInfo.subType 
      ? `${mediaInfo.type}/${mediaInfo.subType}` 
      : mediaInfo.type;
    console.log(`📎 [${botName}] Processando mídia: ${mediaDesc} (${mediaInfo.mimeType})`);
    
    // Handle animated stickers (TGS) - skip for now
    if (mediaInfo.type === 'sticker' && mediaInfo.subType === 'animated') {
      console.log(`⏭️ [${botName}] Sticker animado (TGS) ignorado`);
      return null;
    }
    
    // Download media with timeout and connection check
    let buffer = null;
    try {
      // Check connection again right before download
      if (!client.connected) {
        console.log(`📎 [${botName}] Cliente desconectou antes do download`);
        return null;
      }
      
      buffer = await Promise.race([
        client.downloadMedia(mediaInfo.mediaObject),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Download timeout')), 60000)
        )
      ]);
    } catch (downloadError) {
      // Don't log connection errors as they're expected
      if (!downloadError.message?.includes('disconnected') && 
          !downloadError.message?.includes('Not connected')) {
        console.error(`📎 [${botName}] Erro no download:`, downloadError?.message);
      } else {
        console.log(`📎 [${botName}] Download cancelado: cliente desconectado`);
      }
      return null;
    }

    if (!buffer || buffer.length === 0) {
      console.warn(`📎 [${botName}] Buffer vazio após download`);
      return null;
    }
    
    // Convert buffer if needed
    if (typeof buffer === 'string') {
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

    // Ensure buffer is proper Buffer before base64 encoding
    const properBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const base64 = properBuffer.toString('base64');
    
    if (!base64 || base64.length === 0) {
      console.error(`📎 [${botName}] Falha ao converter buffer para base64`);
      return null;
    }
    
    console.log(`📎 [${botName}] Mídia baixada: ${Math.round(properBuffer.length / 1024)}KB (${mimeType}) [ID: ${fileUniqueId}]`);
    
    // Upload to storage with deduplication
    const result = await uploadMediaToStorage(base64, mimeType, fileUniqueId, fileId, botId, storageMediaType, botName);
    
    if (!result) {
      console.warn(`⚠️ [${botName}] Upload falhou, mídia não será salva`);
      return null;
    }
    
    return result;
  } catch (error) {
    // Don't log connection errors
    if (!error.message?.includes('disconnected') && !error.message?.includes('Not connected')) {
      console.error(`📎 [${botName}] Erro ao baixar mídia:`, error?.message || error);
    }
    return null;
  }
}

// ============= MESSAGE HANDLER =============

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

        // Use cache if available (1 hour)
        if (cachedPhoto?.url && (Date.now() - cachedPhoto.timestamp) < 3600000) {
          profilePhotoUrl = cachedPhoto.url;
        } else {
          // Fetch new photo
          const clientInfo = telegramClients.get(botId);
          if (clientInfo && clientInfo.client.connected) {
            const userPeer = message._sender || message.sender || message.senderId || chatId;
            profilePhotoUrl = await getProfilePhotoUrl(clientInfo.client, userPeer, botName);

            if (profilePhotoUrl) {
              photoCache.set(cacheKey, { url: profilePhotoUrl, timestamp: Date.now() });
            } else {
              photoCache.delete(cacheKey);
            }
          }
        }
      }

      // Download message media if present
      let mediaResult = null;
      if (hasMedia) {
        const clientInfo = telegramClients.get(botId);
        if (clientInfo && clientInfo.client.connected) {
          mediaResult = await downloadMessageMedia(clientInfo.client, message, botName, botId);
        }
      }

      // Extract inline keyboard buttons if present
      let replyMarkup = null;
      const rmCandidate = message.replyMarkup ?? null;

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

      // Build payload
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
        fileUniqueId: mediaResult?.fileUniqueId || null,
        replyMarkup,
      };

      // Enqueue message for processing (with retry/backoff)
      messageQueue.enqueue({
        botName,
        botTokenPrefix,
        payload
      });
      
    } catch (error) {
      // Don't log expected connection errors
      if (!error.message?.includes('TIMEOUT') && 
          !error.message?.includes('disconnected') &&
          !error.message?.includes('Not connected')) {
        console.error(`[${botName}] Erro ao processar mensagem:`, error);
      }
    }
  };
}

// ============= BOT CONNECTION MANAGEMENT =============

// Connect a specific bot with enhanced reconnection handling
async function connectBot(bot) {
  const { id: botId, nome: botName, api_token: botToken } = bot;

  if (!botToken) {
    console.log(`⚠️ [${botName}] Sem token configurado, pulando...`);
    return false;
  }

  // Check if already connected
  if (telegramClients.has(botId)) {
    const existing = telegramClients.get(botId);
    if (existing.client.connected) {
      console.log(`ℹ️ [${botName}] Já conectado`);
      return true;
    }
    // Client exists but disconnected, remove and reconnect
    console.log(`🔄 [${botName}] Reconectando cliente desconectado...`);
    await disconnectBot(botId);
  }

  try {
    console.log(`🔄 [${botName}] Conectando...`);

    const client = new TelegramClient(
      new StringSession(''),
      API_ID,
      API_HASH,
      {
        connectionRetries: 10,
        retryDelay: 2000,
        autoReconnect: true,
        // Additional options for stability
        requestRetries: 5,
        timeout: 30
      }
    );

    // Add connection error handler
    client.setLogLevel('warn'); // Reduce verbose logging

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
      botToken: botToken,
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
      telegramClients.delete(botId);
    }
  }
}

// Periodic health check and reconnection
async function healthCheckAndReconnect() {
  for (const [botId, clientInfo] of telegramClients) {
    if (!clientInfo.client.connected) {
      console.log(`🔄 [${clientInfo.botName}] Detectado desconectado, tentando reconectar...`);
      
      // Try to reconnect using stored token
      try {
        await clientInfo.client.connect();
        console.log(`✅ [${clientInfo.botName}] Reconectado com sucesso`);
      } catch (error) {
        console.error(`❌ [${clientInfo.botName}] Falha ao reconectar:`, error.message);
        
        // If reconnect fails, try full reconnection
        if (clientInfo.botToken) {
          telegramClients.delete(botId);
          await connectBot({
            id: botId,
            nome: clientInfo.botName,
            api_token: clientInfo.botToken
          });
        }
      }
    }
  }
}

// Start periodic health check (every 30 seconds)
setInterval(healthCheckAndReconnect, 30000);

// ============= LOAD BOTS =============

// Load and connect all bots via Edge Function
async function loadAndConnectBots() {
  console.log('📋 Carregando bots via Edge Function...');

  try {
    const response = await fetchWithRetry(`${SUPABASE_URL}/functions/v1/telegram-bots-list`, {
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

    // Connect each bot with small delay between to avoid rate limiting
    let connectedCount = 0;
    for (const bot of bots) {
      const success = await connectBot(bot);
      if (success) connectedCount++;
      // Small delay between bot connections
      await sleep(500);
    }

    console.log(`\n🚀 ${connectedCount}/${bots.length} bots conectados via MTProto`);

  } catch (error) {
    console.error('Erro ao carregar bots:', error.message);
  }
}

// ============= HTTP ENDPOINTS =============

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connectedBots: telegramClients.size,
    queue: messageQueue.getStats(),
    bots: Array.from(telegramClients.entries()).map(([id, info]) => ({
      id,
      name: info.botName,
      username: info.botUsername,
      connected: info.client.connected,
      connectedAt: info.connectedAt
    })),
    timestamp: new Date().toISOString()
  });
});

// Queue stats endpoint
app.get('/queue-stats', (req, res) => {
  res.json(messageQueue.getStats());
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

// Health check all bots (for automated monitoring)
app.get('/health-check-bots', async (req, res) => {
  const syncSecret = req.headers['x-sync-secret'];
  
  if (syncSecret !== TELEGRAM_SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('🏥 Health check de todos os bots iniciado...');
  const results = [];

  for (const [botId, clientInfo] of telegramClients) {
    const result = {
      botId,
      botName: clientInfo.botName,
      platform: 'apex', // Will be enriched by the Edge Function
      status: 'healthy',
      error: null
    };

    try {
      // Check if client is connected
      if (!clientInfo.client.connected) {
        console.log(`🔄 [${clientInfo.botName}] Desconectado, tentando reconectar...`);
        
        // Try to reconnect before marking as problematic
        try {
          await clientInfo.client.connect();
          console.log(`✅ [${clientInfo.botName}] Reconectado com sucesso`);
        } catch (reconnectError) {
          const errorMsg = reconnectError.message || String(reconnectError);
          
          if (errorMsg.includes('USER_DEACTIVATED') || errorMsg.includes('USER_DEACTIVATED_BAN')) {
            result.status = 'banned';
            result.error = errorMsg;
            console.log(`🚫 [${clientInfo.botName}] Bot BANIDO: ${errorMsg}`);
          } else if (errorMsg.includes('AUTH_KEY_UNREGISTERED') || errorMsg.includes('SESSION_REVOKED')) {
            result.status = 'auth_error';
            result.error = errorMsg;
            console.log(`🔑 [${clientInfo.botName}] Erro de autenticação: ${errorMsg}`);
          } else {
            result.status = 'disconnected';
            result.error = errorMsg;
            console.log(`🔌 [${clientInfo.botName}] Desconectado: ${errorMsg}`);
          }
          
          results.push(result);
          continue;
        }
      }

      // Client is connected, verify with getMe()
      try {
        const me = await Promise.race([
          clientInfo.client.getMe(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('getMe timeout')), 15000)
          )
        ]);
        
        result.status = 'healthy';
        console.log(`✅ [${clientInfo.botName}] Saudável (@${me.username})`);
      } catch (getMeError) {
        const errorMsg = getMeError.message || String(getMeError);
        
        if (errorMsg.includes('USER_DEACTIVATED') || errorMsg.includes('USER_DEACTIVATED_BAN')) {
          result.status = 'banned';
          result.error = errorMsg;
          console.log(`🚫 [${clientInfo.botName}] Bot BANIDO: ${errorMsg}`);
        } else if (errorMsg.includes('AUTH_KEY_UNREGISTERED') || errorMsg.includes('SESSION_REVOKED')) {
          result.status = 'auth_error';
          result.error = errorMsg;
          console.log(`🔑 [${clientInfo.botName}] Erro de autenticação: ${errorMsg}`);
        } else if (errorMsg.includes('timeout')) {
          result.status = 'unreachable';
          result.error = 'Bot não respondeu ao getMe() em 15s';
          console.log(`⏱️ [${clientInfo.botName}] Timeout no getMe()`);
        } else {
          result.status = 'disconnected';
          result.error = errorMsg;
          console.log(`🔌 [${clientInfo.botName}] Erro: ${errorMsg}`);
        }
      }
    } catch (error) {
      result.status = 'unreachable';
      result.error = error.message || 'Erro desconhecido';
      console.log(`❓ [${clientInfo.botName}] Erro inesperado: ${error.message}`);
    }

    results.push(result);
  }

  console.log(`🏥 Health check concluído: ${results.length} bots verificados`);
  console.log(`   ✅ Saudáveis: ${results.filter(r => r.status === 'healthy').length}`);
  console.log(`   ⚠️ Problemáticos: ${results.filter(r => r.status !== 'healthy').length}`);

  res.json({
    results,
    totalConnected: telegramClients.size,
    timestamp: new Date().toISOString()
  });
});

// Status of a specific bot
app.get('/status/:botId', (req, res) => {
  const { botId } = req.params;
  const clientInfo = telegramClients.get(botId);

  if (clientInfo) {
    res.json({
      connected: clientInfo.client.connected,
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
  const { chatId, message, parseMode } = req.body;

  const clientInfo = telegramClients.get(botId);

  if (!clientInfo) {
    return res.status(404).json({ error: 'Bot não conectado' });
  }

  if (!clientInfo.client.connected) {
    return res.status(503).json({ error: 'Bot desconectado temporariamente' });
  }

  try {
    const result = await clientInfo.client.sendMessage(chatId, {
      message,
      parseMode: parseMode || 'html'
    });

    res.json({
      success: true,
      messageId: bigIntToString(result.id)
    });
  } catch (error) {
    console.error(`[${clientInfo.botName}] Erro ao enviar mensagem:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Get user status endpoint
app.post('/user-status/:botId', async (req, res) => {
  const { botId } = req.params;
  const { chatId } = req.body;

  const clientInfo = telegramClients.get(botId);

  if (!clientInfo) {
    return res.status(404).json({ error: 'Bot não conectado' });
  }

  if (!clientInfo.client.connected) {
    return res.status(503).json({ error: 'Bot desconectado temporariamente' });
  }

  try {
    const user = await clientInfo.client.getEntity(chatId);
    
    let status = 'unknown';
    let wasOnline = null;

    if (user.status) {
      const statusClassName = user.status.className;
      
      if (statusClassName === 'UserStatusOnline') {
        status = 'online';
      } else if (statusClassName === 'UserStatusOffline') {
        status = 'offline';
        wasOnline = user.status.wasOnline 
          ? new Date(user.status.wasOnline * 1000).toISOString()
          : null;
      } else if (statusClassName === 'UserStatusRecently') {
        status = 'recently';
      } else if (statusClassName === 'UserStatusLastWeek') {
        status = 'last_week';
      } else if (statusClassName === 'UserStatusLastMonth') {
        status = 'last_month';
      }
    }

    res.json({
      success: true,
      status,
      wasOnline,
      firstName: user.firstName || null,
      lastName: user.lastName || null,
      username: user.username || null
    });
  } catch (error) {
    console.error(`[${clientInfo.botName}] Erro ao buscar status:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// Send file/audio via a specific bot (MTProto)
// Supports both JSON (fileBase64) and multipart form-data (file upload)
// No external dependencies (multer removed) - uses native multipart parsing

// Native multipart parser (no multer needed)
function parseMultipart(buf, boundary) {
  const parts = [];
  const boundaryBuf = Buffer.from('--' + boundary);
  let start = 0;

  while (true) {
    const idx = buf.indexOf(boundaryBuf, start);
    if (idx === -1) break;

    if (start > 0) {
      // Extract part between previous boundary and this one (minus trailing \r\n)
      let partEnd = idx - 2; // skip \r\n before boundary
      if (partEnd < start) partEnd = idx;
      const partBuf = buf.slice(start, partEnd);

      // Split headers from body (double CRLF)
      const headerEnd = partBuf.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        const headerStr = partBuf.slice(0, headerEnd).toString('utf-8');
        const body = partBuf.slice(headerEnd + 4);

        const headers = {};
        headerStr.split('\r\n').forEach(line => {
          const colonIdx = line.indexOf(':');
          if (colonIdx > 0) {
            headers[line.slice(0, colonIdx).trim().toLowerCase()] = line.slice(colonIdx + 1).trim();
          }
        });

        const cd = headers['content-disposition'] || '';
        const nameMatch = cd.match(/name="([^"]+)"/);
        const fileNameMatch = cd.match(/filename="([^"]+)"/);
        const contentType = headers['content-type'] || null;

        parts.push({
          name: nameMatch ? nameMatch[1] : null,
          filename: fileNameMatch ? fileNameMatch[1] : null,
          contentType,
          data: body,
        });
      }
    }

    start = idx + boundaryBuf.length;
    // Skip \r\n or -- after boundary
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break; // --
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
  }

  return parts;
}

app.post('/send-file/:botId', async (req, res) => {
  const { botId } = req.params;

  let chatId, buffer, mimeType, fileName, caption, voice;

  const contentType = req.headers['content-type'] || '';

  if (contentType.includes('multipart/form-data')) {
    // Parse multipart manually (no multer)
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) {
      return res.status(400).json({ error: 'Missing multipart boundary' });
    }

    // Collect raw body
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks);

    const parts = parseMultipart(rawBody, boundaryMatch[1].trim());
    const fields = {};
    let fileData = null;

    for (const part of parts) {
      if (part.filename) {
        fileData = part;
      } else if (part.name) {
        fields[part.name] = part.data.toString('utf-8');
      }
    }

    if (fileData) {
      chatId = fields.chatId || fields.chat_id;
      buffer = fileData.data;
      mimeType = fileData.contentType || 'audio/ogg';
      fileName = fileData.filename || 'voice.ogg';
      caption = fields.caption || '';
      voice = fields.voice === 'true' || fields.voice === true || fileName.endsWith('.ogg');
      console.log(`📥 Recebido arquivo multipart: ${fileName} (${mimeType}, ${Math.round(buffer.length / 1024)}KB)`);
    } else {
      // No file in multipart, treat fields as JSON-like
      chatId = fields.chatId || fields.chat_id;
      const fileBase64 = fields.fileBase64;
      mimeType = fields.mimeType || 'audio/ogg';
      fileName = fields.fileName || 'voice.ogg';
      caption = fields.caption || '';
      voice = fields.voice === 'true';

      if (!fileBase64) {
        return res.status(400).json({ error: 'Envie o arquivo via multipart ou JSON (fileBase64)' });
      }

      let cleanBase64 = fileBase64;
      if (cleanBase64.startsWith('data:')) {
        const match = cleanBase64.match(/^data:[^;]+;base64,(.+)$/s);
        if (match) cleanBase64 = match[1];
      }
      cleanBase64 = cleanBase64.replace(/[\s\r\n]+/g, '');
      buffer = Buffer.from(cleanBase64, 'base64');
    }
  } else {
    // JSON body with base64
    const body = req.body;
    chatId = body.chatId || body.chat_id;
    const fileBase64 = body.fileBase64;
    mimeType = body.mimeType || 'audio/ogg';
    fileName = body.fileName || 'voice.ogg';
    caption = body.caption || '';
    voice = body.voice === true;

    if (!fileBase64) {
      return res.status(400).json({ error: 'Envie o arquivo via multipart ou JSON (fileBase64)' });
    }

    let cleanBase64 = fileBase64;
    if (cleanBase64.startsWith('data:')) {
      const match = cleanBase64.match(/^data:[^;]+;base64,(.+)$/s);
      if (match) cleanBase64 = match[1];
    }
    cleanBase64 = cleanBase64.replace(/[\s\r\n]+/g, '');
    buffer = Buffer.from(cleanBase64, 'base64');
  }

  const clientInfo = telegramClients.get(botId);

  if (!clientInfo) {
    return res.status(404).json({ error: 'Bot não conectado' });
  }

  if (!clientInfo.client.connected) {
    return res.status(503).json({ error: 'Bot desconectado temporariamente' });
  }

  if (!chatId || !buffer) {
    return res.status(400).json({ error: 'chatId e arquivo são obrigatórios' });
  }

  try {
    console.log(`📤 [${clientInfo.botName}] Enviando ${voice ? 'voice' : 'file'}: ${Math.round(buffer.length / 1024)}KB (${mimeType}) para chat ${chatId}`);

    const result = await clientInfo.client.sendFile(chatId, {
      file: buffer,
      caption: caption || '',
      voiceNote: voice === true,
      fileName: voice ? 'voice.ogg' : (fileName || 'audio.mp3'),
      mimeType: voice ? 'audio/ogg' : (mimeType || 'audio/ogg'),
      attributes: voice ? [
        new Api.DocumentAttributeAudio({
          voice: true,
          duration: 0,
          title: undefined,
          performer: undefined,
        })
      ] : undefined,
    });

    console.log(`✅ [${clientInfo.botName}] Arquivo enviado, messageId: ${bigIntToString(result.id)}`);

    res.json({
      success: true,
      messageId: bigIntToString(result.id)
    });
  } catch (error) {
    console.error(`[${clientInfo.botName}] Erro ao enviar arquivo:`, error);
    res.status(500).json({ error: error.message });
  }
});

// ============= START SERVER =============

app.listen(PORT, async () => {
  console.log(`\n🌐 Servidor MTProto rodando na porta ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   Queue stats: http://localhost:${PORT}/queue-stats`);
  console.log('');
  
  // Load and connect bots on startup
  await loadAndConnectBots();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('⚠️ Recebido SIGTERM, desconectando bots...');
  
  for (const [botId] of telegramClients) {
    await disconnectBot(botId);
  }
  
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('⚠️ Recebido SIGINT, desconectando bots...');
  
  for (const [botId] of telegramClients) {
    await disconnectBot(botId);
  }
  
  process.exit(0);
});
