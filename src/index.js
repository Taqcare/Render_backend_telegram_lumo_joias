require('dotenv').config();
const express = require('express');
const { TelegramClient } = require('telegram');
const { NewMessage } = require('telegram/events');
const { StringSession } = require('telegram/sessions');

const app = express();
app.use(express.json());

// Configuration
const API_ID = parseInt(process.env.TELEGRAM_API_ID);
const API_HASH = process.env.TELEGRAM_API_HASH;
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PORT = process.env.PORT || 3000;

// Store session string for reconnection
let sessionString = '';
let client = null;
let isConnected = false;

// Helper: Convert BigInt to String safely
function bigIntToString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object' && value !== null) {
    // Handle BigInt objects
    if (value.value !== undefined && typeof value.value === 'bigint') {
      return value.value.toString();
    }
  }
  return String(value);
}

// Helper: Extract chat ID from peer
function extractChatId(peerId) {
  if (!peerId) return null;
  
  // Handle different peer types
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

// Send data to Supabase Edge Function
async function syncToSupabase(data) {
  try {
    console.log('Syncing to Supabase:', JSON.stringify(data, null, 2));
    
    const response = await fetch(`${SUPABASE_URL}/functions/v1/telegram-mtproto-sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
      },
      body: JSON.stringify(data)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Supabase sync error:', response.status, errorText);
      return false;
    }
    
    const result = await response.json();
    console.log('Supabase sync success:', result);
    return true;
  } catch (error) {
    console.error('Failed to sync to Supabase:', error.message);
    return false;
  }
}

// Initialize Telegram client
async function initializeTelegramClient() {
  try {
    console.log('Initializing Telegram MTProto client...');
    console.log('API_ID:', API_ID);
    console.log('BOT_TOKEN exists:', !!BOT_TOKEN);
    
    // Create client with empty session (bot doesn't need persistent session)
    client = new TelegramClient(
      new StringSession(sessionString),
      API_ID,
      API_HASH,
      {
        connectionRetries: 5,
        retryDelay: 1000,
        autoReconnect: true,
        useWSS: false // Use TCP, not WebSocket
      }
    );
    
    // Start client with bot token (NOT phone number!)
    await client.start({
      botAuthToken: BOT_TOKEN
    });
    
    console.log('✅ Connected to Telegram MTProto as bot!');
    console.log('Session string:', client.session.save());
    sessionString = client.session.save();
    isConnected = true;
    
    // Get bot info
    const me = await client.getMe();
    console.log('Bot info:', {
      id: bigIntToString(me.id),
      username: me.username,
      firstName: me.firstName
    });
    
    // Set up message handler
    setupMessageHandler();
    
    return true;
  } catch (error) {
    console.error('Failed to initialize Telegram client:', error);
    isConnected = false;
    return false;
  }
}

// Handle incoming messages
function setupMessageHandler() {
  client.addEventHandler(async (event) => {
    try {
      const message = event.message;
      
      if (!message) {
        console.log('Event without message:', event);
        return;
      }
      
      // Extract chat ID (CRITICAL: Convert BigInt to String!)
      const chatId = extractChatId(message.peerId);
      if (!chatId) {
        console.log('Could not extract chat ID from message');
        return;
      }
      
      // Check if this is an outgoing message (bot's own message)
      const isOutgoing = message.out === true;
      
      // Extract sender info
      const senderInfo = extractSenderInfo(message);
      
      // Build message data object
      const messageData = {
        // IMPORTANT: All IDs as strings, not BigInt!
        chatId: chatId,
        messageId: bigIntToString(message.id),
        text: message.text || message.message || '',
        isOutgoing: isOutgoing,
        date: message.date ? new Date(message.date * 1000).toISOString() : new Date().toISOString(),
        sender: {
          firstName: senderInfo.firstName,
          lastName: senderInfo.lastName,
          username: senderInfo.username,
          isBot: senderInfo.isBot
        },
        // Bot token for identifying which bot this is from
        botToken: BOT_TOKEN.split(':')[0] // Only send bot ID, not full token
      };
      
      console.log(`📨 ${isOutgoing ? 'OUTGOING' : 'INCOMING'} message in chat ${chatId}:`, messageData.text?.substring(0, 50));
      
      // Sync to Supabase
      await syncToSupabase({
        type: 'message',
        data: messageData
      });
      
    } catch (error) {
      console.error('Error handling message:', error);
    }
  }, new NewMessage({}));
  
  console.log('✅ Message handler set up successfully');
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connected: isConnected,
    timestamp: new Date().toISOString()
  });
});

// Manual reconnect endpoint
app.post('/reconnect', async (req, res) => {
  try {
    if (client) {
      await client.disconnect();
    }
    const success = await initializeTelegramClient();
    res.json({ success, message: success ? 'Reconnected' : 'Failed to reconnect' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Send message endpoint (optional - for testing)
app.post('/send', async (req, res) => {
  try {
    const { chatId, text } = req.body;
    
    if (!isConnected || !client) {
      return res.status(503).json({ success: false, error: 'Not connected to Telegram' });
    }
    
    // Send message via MTProto
    const result = await client.sendMessage(chatId, { message: text });
    
    res.json({
      success: true,
      messageId: bigIntToString(result.id)
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start server and connect to Telegram
async function start() {
  try {
    // Start Express server
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
    
    // Connect to Telegram
    await initializeTelegramClient();
    
    // Keep process alive
    process.on('SIGINT', async () => {
      console.log('Shutting down...');
      if (client) {
        await client.disconnect();
      }
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      console.log('Received SIGTERM, shutting down...');
      if (client) {
        await client.disconnect();
      }
      process.exit(0);
    });
    
  } catch (error) {
    console.error('Failed to start:', error);
    process.exit(1);
  }
}

start();
