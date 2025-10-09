const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const os = require('os');
const mysql = require('mysql2/promise');

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
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
const users = {}; // { socketId: { type: 'user'|'admin', name: string, customerId?: string } }

// Create tables if not exists
async function initializeDatabase() {
  const connection = await pool.getConnection();
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS customer_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        message_id VARCHAR(50) NOT NULL,
        sender_id VARCHAR(50) NOT NULL,
        receiver_id VARCHAR(50),
        chat_id VARCHAR(50) NOT NULL,
        text TEXT NOT NULL,
        timestamp DATETIME NOT NULL,
        sender_type ENUM('user', 'support', 'admin') NOT NULL,
        INDEX (sender_id),
        INDEX (receiver_id),
        INDEX (chat_id),
        INDEX (timestamp)
      )
    `);
    await connection.query(`
      CREATE TABLE IF NOT EXISTS customer_media_uploads (
        id INT AUTO_INCREMENT PRIMARY KEY,
        message_id VARCHAR(50) NOT NULL,
        chat_id VARCHAR(50) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        file_url VARCHAR(255) NOT NULL,
        media_type ENUM('image', 'video', 'gif', 'file') NOT NULL,
        upload_time DATETIME NOT NULL,
        file_size INT,
        mime_type VARCHAR(100),
        INDEX (message_id),
        INDEX (chat_id)
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
    };
    console.log(`User registered as ${userType}:`, socket.id, users[socket.id].name);
    socket.join(userType);
    if (userType === 'admin') {
      adminOnline = true;
      io.emit('adminStatus', true);
    }
    const onlineUsers = Object.entries(users).map(([id, user]) => ({
      id,
      name: user.name,
      type: user.type,
      customerId: user.customerId,
    }));
    io.emit('onlineUsers', onlineUsers);
  });

  // Join a specific chat room
  socket.on('joinChat', ({ chatId, userType, userId }) => {
    socket.join(chatId);
    users[socket.id] = {
      type: userType,
      name: userType === 'admin' ? 'Admin' : `Customer-${chatId}`,
      customerId: userType === 'user' ? chatId : undefined,
    };
    console.log(`User ${socket.id} joined chat ${chatId} as ${userType}`);
    const onlineUsers = Object.entries(users).map(([id, user]) => ({
      id,
      name: user.name,
      type: user.type,
      customerId: user.customerId,
    }));
    io.emit('onlineUsers', onlineUsers);
  });

  // Handle sending messages
  socket.on('sendMessage', async (message) => {
    console.log('Message received:', message);
    const { id, senderId, receiverId, chatId, text, media, sender_type } = message;
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
        'INSERT INTO customer_messages (message_id, sender_id, receiver_id, chat_id, text, timestamp, sender_type) VALUES (?, ?, ?, ?, ?, ?, ?)',
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
          const [existingMedia] = await connection.query(
            'SELECT id FROM customer_media_uploads WHERE message_id = ? AND file_url = ?',
            [messageWithTimestamp.message_id, item.file_url]
          );
          if (existingMedia.length === 0) {
            await connection.query(
              'INSERT INTO customer_media_uploads (message_id, chat_id, file_name, file_url, media_type, upload_time, file_size, mime_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
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
            console.log('Inserted new media record:', item.file_name);
          } else {
            console.log('Media already exists, skipping insert:', item.file_name);
          }
        }
      }
    } catch (error) {
      console.error('Error saving message or media:', error);
    } finally {
      if (connection) connection.release();
    }

    // Route message to the correct chat room
    if (chatId) {
      io.to(chatId).emit('receiveMessage', message);
    } else if (receiverId) {
      io.to(receiverId).emit('receiveMessage', message);
    } else {
      io.emit('receiveMessage', message);
    }
  });

  // Handle disconnection
  socket.on('disconnect', (reason) => {
    console.log('Client disconnected:', socket.id, 'Reason:', reason);
    const disconnectedUser = users[socket.id];
    if (disconnectedUser?.type === 'admin') {
      adminOnline = false;
      io.emit('adminStatus', false);
      console.log('Admin went offline');
    }
    delete users[socket.id];
    const onlineUsers = Object.entries(users).map(([id, user]) => ({
      id,
      name: user.name,
      type: user.type,
      customerId: user.customerId,
    }));
    io.emit('onlineUsers', onlineUsers);
    console.log(`User disconnected. Remaining users:`, Object.keys(users).length);
  });
});

// API endpoint to fetch old messages with associated media
app.get('/api/messages/:chatId', async (req, res) => {
  try {
    const [messageRows] = await pool.query(
      `SELECT *,
       CASE
         WHEN sender_id = 'admin' THEN 'support'
         ELSE 'user'
       END as sender,
       sender_type
       FROM customer_messages
       WHERE chat_id = ?
       ORDER BY timestamp ASC`,
      [req.params.chatId]
    );
    const messagesWithMedia = await Promise.all(messageRows.map(async (message) => {
      const [mediaRows] = await pool.query(
        'SELECT * FROM customer_media_uploads WHERE message_id = ?',
        [message.message_id]
      );
      return {
        ...message,
        media: mediaRows
      };
    }));
    res.json(messagesWithMedia);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
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
});
