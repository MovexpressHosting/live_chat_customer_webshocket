const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const os = require('os');
const mysql = require('mysql2/promise');

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// MySQL Configuration
const dbConfig = {
  host: "srv657.hstgr.io",
  user: "u442108067_mydb",
  password: "mOhe6ln0iP>",
  database: "u442108067_mydb",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

// Create MySQL connection pool
const pool = mysql.createPool(dbConfig);

// Track online status and users
let adminOnline = false;
const users = {}; // { socketId: { type: 'user'|'admin', name: string, customerId?: string, chatId?: string } }

// Create tables if not exists
async function initializeDatabase() {
  const connection = await pool.getConnection();
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS customer_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        message_id VARCHAR(100) NOT NULL UNIQUE,
        sender_id VARCHAR(50) NOT NULL,
        receiver_id VARCHAR(50),
        chat_id VARCHAR(50) NOT NULL,
        text TEXT NOT NULL,
        timestamp DATETIME NOT NULL,
        sender_type ENUM('user', 'support', 'admin') NOT NULL,
        INDEX (sender_id),
        INDEX (receiver_id),
        INDEX (chat_id),
        INDEX (timestamp),
        INDEX (message_id)
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS customer_media_uploads (
        id INT AUTO_INCREMENT PRIMARY KEY,
        message_id VARCHAR(100) NOT NULL,
        chat_id VARCHAR(50) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        file_url VARCHAR(255) NOT NULL,
        media_type ENUM('image', 'video', 'gif', 'file') NOT NULL,
        upload_time DATETIME NOT NULL,
        file_size INT,
        mime_type VARCHAR(100),
        INDEX (message_id),
        INDEX (chat_id),
        FOREIGN KEY (message_id) REFERENCES customer_messages(message_id) ON DELETE CASCADE
      )
    `);
    console.log("Customer database initialized");
  } catch (error) {
    console.error("Customer database initialization error:", error);
  } finally {
    connection.release();
  }
}

initializeDatabase();

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Register user (customer or admin)
  socket.on('register', (userType, userName, customerId) => {
    users[socket.id] = {
      type: userType,
      name: userName || `User-${socket.id.slice(0, 4)}`,
      customerId,
      socketId: socket.id
    };
    console.log(`User registered as ${userType}:`, socket.id, users[socket.id].name);
    
    socket.join(userType);
    if (userType === 'admin') {
      adminOnline = true;
      io.emit('adminStatus', true);
      console.log('Admin came online');
    }
    
    updateOnlineUsers();
  });

  // Join a specific chat room
  socket.on('joinChat', ({ chatId, userType, userId }) => {
    socket.join(chatId);
    users[socket.id] = {
      type: userType,
      name: userType === 'admin' ? 'Admin' : `Customer-${chatId}`,
      customerId: userType === 'user' ? chatId : undefined,
      chatId: chatId,
      socketId: socket.id
    };
    console.log(`User ${socket.id} joined chat ${chatId} as ${userType}`);
    
    updateOnlineUsers();
  });

  // Handle sending messages
  socket.on('sendMessage', async (message) => {
    console.log('Message received:', {
      id: message.id,
      chatId: message.chatId,
      sender_type: message.sender_type,
      text: message.text?.substring(0, 50) + (message.text?.length > 50 ? '...' : ''),
      hasMedia: message.media?.length > 0
    });

    const { id, senderId, receiverId, chatId, text, media, sender_type } = message;
    
    if (!chatId) {
      console.error('No chatId provided in message:', message);
      return;
    }

    const messageWithTimestamp = {
      message_id: id,
      sender_id: senderId,
      receiver_id: receiverId,
      chat_id: chatId,
      text: text || '',
      timestamp: new Date().toISOString(),
      sender_type: sender_type,
    };

    let connection;
    try {
      connection = await pool.getConnection();

      // Insert into customer_messages table
      await connection.query(
        'INSERT IGNORE INTO customer_messages (message_id, sender_id, receiver_id, chat_id, text, timestamp, sender_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          messageWithTimestamp.message_id,
          messageWithTimestamp.sender_id,
          messageWithTimestamp.receiver_id,
          messageWithTimestamp.chat_id,
          messageWithTimestamp.text,
          messageWithTimestamp.timestamp,
          messageWithTimestamp.sender_type,
        ]
      );

      // If media is present, insert into customer_media_uploads
      if (media && media.length > 0) {
        for (const item of media) {
          await connection.query(
            'INSERT IGNORE INTO customer_media_uploads (message_id, chat_id, file_name, file_url, media_type, upload_time, file_size, mime_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [
              messageWithTimestamp.message_id,
              messageWithTimestamp.chat_id,
              item.file_name,
              item.file_url,
              item.media_type,
              messageWithTimestamp.timestamp,
              item.file_size,
              item.mime_type,
            ]
          );
          console.log('Media record processed:', item.file_name);
        }
      }
    } catch (error) {
      console.error('Error saving message or media:', error);
    } finally {
      if (connection) connection.release();
    }

    // Route message to the correct chat room with acknowledgment
    try {
      if (chatId) {
        // Emit to all sockets in the chat room
        io.to(chatId).emit('receiveMessage', {
          ...message,
          timestamp: messageWithTimestamp.timestamp,
          _delivered: true
        });
        console.log(`Message ${id} delivered to chat ${chatId}`);
      } else if (receiverId) {
        io.to(receiverId).emit('receiveMessage', {
          ...message,
          timestamp: messageWithTimestamp.timestamp,
          _delivered: true
        });
        console.log(`Message ${id} delivered to receiver ${receiverId}`);
      } else {
        io.emit('receiveMessage', {
          ...message,
          timestamp: messageWithTimestamp.timestamp,
          _delivered: true
        });
        console.log(`Message ${id} broadcast to all`);
      }
    } catch (emitError) {
      console.error('Error emitting message:', emitError);
    }
  });

  // Handle message delivery confirmation
  socket.on('messageDelivered', (messageId) => {
    console.log(`Message ${messageId} confirmed delivered`);
  });

  // Handle typing indicators
  socket.on('typing', ({ chatId, isTyping }) => {
    socket.to(chatId).emit('typing', { userId: socket.id, isTyping });
  });

  // Handle disconnection
  socket.on('disconnect', (reason) => {
    console.log('Client disconnected:', socket.id, 'Reason:', reason);
    const disconnectedUser = users[socket.id];
    
    if (disconnectedUser) {
      if (disconnectedUser.type === 'admin') {
        adminOnline = false;
        io.emit('adminStatus', false);
        console.log('Admin went offline');
      }
      delete users[socket.id];
    }
    
    updateOnlineUsers();
    console.log(`User disconnected. Remaining users:`, Object.keys(users).length);
  });

  // Handle connection errors
  socket.on('connect_error', (error) => {
    console.error('Socket connection error:', error);
  });
});

// Update online users and emit to all clients
function updateOnlineUsers() {
  const onlineUsers = Object.values(users).map(user => ({
    id: user.customerId || user.socketId,
    name: user.name,
    type: user.type,
    customerId: user.customerId,
    chatId: user.chatId
  }));
  
  io.emit('onlineUsers', onlineUsers);
  console.log('Online users updated:', onlineUsers.length);
}

// API endpoint to fetch old messages with associated media
app.get('/api/messages/:chatId', async (req, res) => {
  const { chatId } = req.params;
  
  try {
    console.log(`Fetching messages for chat: ${chatId}`);
    
    const [messageRows] = await pool.query(
      `SELECT 
        cm.*,
        CASE
          WHEN cm.sender_type = 'admin' OR cm.sender_type = 'support' THEN 'support'
          ELSE 'user'
        END as sender
       FROM customer_messages cm
       WHERE cm.chat_id = ?
       ORDER BY cm.timestamp ASC`,
      [chatId]
    );
    
    const messagesWithMedia = await Promise.all(
      messageRows.map(async (message) => {
        const [mediaRows] = await pool.query(
          'SELECT * FROM customer_media_uploads WHERE message_id = ?',
          [message.message_id]
        );
        return {
          ...message,
          media: mediaRows
        };
      })
    );
    
    console.log(`Found ${messagesWithMedia.length} messages for chat ${chatId}`);
    res.json(messagesWithMedia);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    onlineUsers: Object.keys(users).length,
    adminOnline: adminOnline
  });
});

// Helper function to get local IP address
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    const iface = interfaces[devName];
    for (let i = 0; i < iface.length; i++) {
      const alias = iface[i];
      if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return '0.0.0.0';
}

// Start server
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  const localIp = getLocalIpAddress();
  console.log(`Customer Socket.IO server running at:`);
  console.log(`- Local:   http://localhost:${PORT}`);
  console.log(`- Network: http://${localIp}:${PORT}`);
  console.log(`- Health:  http://localhost:${PORT}/health`);
});
