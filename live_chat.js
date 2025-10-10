const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mysql = require('mysql2/promise');

const app = express();
app.use(cors());
app.use(express.json());

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

const pool = mysql.createPool(dbConfig);

// Initialize database tables
async function initializeDatabase() {
  const connection = await pool.getConnection();
  try {
    // Customer messages table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS customer_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        message_id VARCHAR(100) NOT NULL,
        customer_id VARCHAR(100) NOT NULL,
        customer_name VARCHAR(255) NOT NULL,
        text TEXT NOT NULL,
        sender_type ENUM('customer', 'support') NOT NULL,
        timestamp DATETIME NOT NULL,
        INDEX (customer_id),
        INDEX (timestamp),
        INDEX (message_id)
      )
    `);

    // Customer media table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS customer_media_uploads (
        id INT AUTO_INCREMENT PRIMARY KEY,
        message_id VARCHAR(100) NOT NULL,
        customer_id VARCHAR(100) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        file_url VARCHAR(500) NOT NULL,
        media_type ENUM('image', 'video', 'gif', 'file') NOT NULL,
        upload_time DATETIME NOT NULL,
        file_size INT,
        mime_type VARCHAR(100),
        INDEX (message_id),
        INDEX (customer_id)
      )
    `);

    // Customer sessions table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS customer_sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        customer_id VARCHAR(100) NOT NULL UNIQUE,
        customer_name VARCHAR(255) NOT NULL,
        socket_id VARCHAR(100),
        is_online BOOLEAN DEFAULT false,
        last_activity DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX (customer_id),
        INDEX (is_online)
      )
    `);

    console.log("Customer chat database initialized");
  } catch (error) {
    console.error("Database initialization error:", error);
  } finally {
    connection.release();
  }
}

initializeDatabase();

// Track connected users
const customers = new Map(); // customerId -> socketId
let adminSocket = null;
let isAdminOnline = false;

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  // Customer registration
  socket.on('registerCustomer', async (data) => {
    const { customerId, customerName, socketId } = data;
    customers.set(customerId, socket.id);
    try {
      const connection = await pool.getConnection();
      await connection.query(`
        INSERT INTO customer_sessions (customer_id, customer_name, socket_id, is_online, last_activity)
        VALUES (?, ?, ?, true, NOW())
        ON DUPLICATE KEY UPDATE
        socket_id = VALUES(socket_id),
        is_online = VALUES(is_online),
        last_activity = VALUES(last_activity)
      `, [customerId, customerName, socket.id]);
      connection.release();

      // Notify admin about new customer
      if (adminSocket) {
        io.to(adminSocket).emit('customerStatus', {
          customerId,
          customerName,
          isOnline: true
        });
      }

      // Notify customer about admin status
      socket.emit('adminStatus', isAdminOnline);

      broadcastCustomerList();
    } catch (error) {
      console.error('Error registering customer:', error);
    }
  });

  // Admin registration
  socket.on('registerAdmin', () => {
    adminSocket = socket.id;
    isAdminOnline = true;
    console.log('Admin registered:', socket.id);
    
    // Notify all customers that admin is online
    customers.forEach((socketId, customerId) => {
      io.to(socketId).emit('adminStatus', true);
    });
    
    broadcastCustomerList();
  });

  // Admin online status
  socket.on('adminOnline', (data) => {
    isAdminOnline = data.isOnline;
    console.log('Admin online status:', isAdminOnline);
    
    // Notify all customers about admin status
    customers.forEach((socketId, customerId) => {
      io.to(socketId).emit('adminStatus', isAdminOnline);
    });
  });

  // Customer sends message
  socket.on('sendCustomerMessage', async (message) => {
    console.log('Customer message received:', message);
    const { id, text, customerId, senderName, media } = message;
    try {
      const connection = await pool.getConnection();
      await connection.query(`
        INSERT INTO customer_messages (message_id, customer_id, customer_name, text, sender_type, timestamp)
        VALUES (?, ?, ?, ?, 'customer', NOW())
      `, [id, customerId, senderName, text]);

      // Save media if any
      if (media && media.length > 0) {
        for (const item of media) {
          await connection.query(`
            INSERT INTO customer_media_uploads (message_id, customer_id, file_name, file_url, media_type, upload_time, file_size, mime_type)
            VALUES (?, ?, ?, ?, ?, NOW(), ?, ?)
          `, [id, customerId, item.file_name, item.file_url, item.media_type, item.file_size, item.mime_type]);
        }
      }
      connection.release();

      // Forward message to admin
      if (adminSocket) {
        io.to(adminSocket).emit('receiveCustomerMessage', {
          ...message,
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      console.error('Error saving customer message:', error);
    }
  });

  // Admin sends message
  socket.on('sendAdminMessage', async (message) => {
    console.log('Admin message received:', message);
    const { id, text, customerId, media } = message;
    try {
      const connection = await pool.getConnection();
      await connection.query(`
        INSERT INTO customer_messages (message_id, customer_id, customer_name, text, sender_type, timestamp)
        VALUES (?, ?, 'Support', ?, 'support', NOW())
      `, [id, customerId, text]);

      // Save media if any
      if (media && media.length > 0) {
        for (const item of media) {
          await connection.query(`
            INSERT INTO customer_media_uploads (message_id, customer_id, file_name, file_url, media_type, upload_time, file_size, mime_type)
            VALUES (?, ?, ?, ?, ?, NOW(), ?, ?)
          `, [id, customerId, item.file_name, item.file_url, item.media_type, item.file_size, item.mime_type]);
        }
      }
      connection.release();

      // Forward message to customer
      const customerSocketId = customers.get(customerId);
      if (customerSocketId) {
        io.to(customerSocketId).emit('receiveMessage', {
          ...message,
          timestamp: new Date().toISOString()
        });
      }
    } catch (error) {
      console.error('Error saving admin message:', error);
    }
  });

  // Handle disconnection
  socket.on('disconnect', async () => {
    console.log('Client disconnected:', socket.id);
    
    if (socket.id === adminSocket) {
      adminSocket = null;
      isAdminOnline = false;
      console.log('Admin disconnected');
      
      // Notify all customers that admin is offline
      customers.forEach((socketId, customerId) => {
        io.to(socketId).emit('adminStatus', false);
      });
      
      return;
    }

    // Check if it was a customer
    for (const [customerId, socketId] of customers.entries()) {
      if (socketId === socket.id) {
        customers.delete(customerId);
        try {
          const connection = await pool.getConnection();
          await connection.query(
            'UPDATE customer_sessions SET is_online = false WHERE customer_id = ?',
            [customerId]
          );
          connection.release();
          if (adminSocket) {
            io.to(adminSocket).emit('customerStatus', {
              customerId,
              isOnline: false
            });
          }
        } catch (error) {
          console.error('Error updating customer status:', error);
        }
        break;
      }
    }
    broadcastCustomerList();
  });
});

// Broadcast customer list to admin
async function broadcastCustomerList() {
  if (!adminSocket) return;
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query(`
      SELECT
        cs.customer_id as id,
        cs.customer_name as name,
        cs.is_online as isOnline,
        cs.last_activity as lastActivity,
        (SELECT COUNT(*) FROM customer_messages cm
         WHERE cm.customer_id = cs.customer_id
         AND cm.sender_type = 'customer'
         AND cm.timestamp > COALESCE((SELECT MAX(timestamp) FROM customer_messages
                                    WHERE customer_id = cs.customer_id AND sender_type = 'support'), '2000-01-01')
        ) as unreadCount
      FROM customer_sessions cs
      ORDER BY cs.last_activity DESC
    `);
    connection.release();
    io.to(adminSocket).emit('customerList', rows);
  } catch (error) {
    console.error('Error fetching customer list:', error);
  }
}

// API endpoint to get customer messages
app.get('/api/customer-messages/:customerId', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [messages] = await connection.query(`
      SELECT
        cm.id,
        cm.message_id,
        cm.customer_id,
        cm.customer_name,
        cm.text,
        cm.sender_type,
        cm.timestamp
      FROM customer_messages cm
      WHERE cm.customer_id = ?
      ORDER BY cm.timestamp ASC
    `, [req.params.customerId]);

    // Fetch media for each message
    const messagesWithMedia = await Promise.all(messages.map(async (msg) => {
      const [media] = await connection.query(`
        SELECT file_name, file_url, media_type, file_size, mime_type
        FROM customer_media_uploads
        WHERE message_id = ?
      `, [msg.message_id]);
      return {
        ...msg,
        media: media || []
      };
    }));

    connection.release();
    res.json(messagesWithMedia);
  } catch (error) {
    console.error('Error fetching customer messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages', details: error.message });
  }
});

// API endpoint to get all customers with last message
app.get('/api/customers', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [customers] = await connection.query(`
      SELECT
        cs.customer_id as id,
        cs.customer_name as name,
        cs.is_online as isOnline,
        cs.last_activity as lastActivity,
        (SELECT text FROM customer_messages
         WHERE customer_id = cs.customer_id
         ORDER BY timestamp DESC LIMIT 1) as lastMessage,
        (SELECT COUNT(*) FROM customer_messages
         WHERE customer_id = cs.customer_id
         AND sender_type = 'customer'
         AND timestamp > COALESCE((SELECT MAX(timestamp) FROM customer_messages
                                WHERE customer_id = cs.customer_id AND sender_type = 'support'), '2000-01-01')
        ) as unreadCount
      FROM customer_sessions cs
      ORDER BY cs.last_activity DESC
    `);
    connection.release();
    res.json(customers);
  } catch (error) {
    console.error('Error fetching customers:', error);
    res.status(500).json({ error: 'Failed to fetch customers', details: error.message });
  }
});

// Test database connection
app.get('/api/test-db', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT 1');
    connection.release();
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('Database connection test failed:', error);
    res.status(500).json({ error: 'Database connection failed', details: error.message });
  }
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Customer Chat WebSocket server running on port ${PORT}`);
});
