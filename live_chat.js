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

// Track connected users
const customers = new Map(); // customerId -> socketId
const admins = new Map(); // socketId -> adminData (multiple admins support)
let isAdminOnline = false;

// Initialize database tables
async function initializeDatabase() {
  const connection = await pool.getConnection();
  try {
    // Customer messages table with admin_name field
    await connection.query(`
      CREATE TABLE IF NOT EXISTS customer_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        message_id VARCHAR(100) NOT NULL,
        customer_id VARCHAR(100) NOT NULL,
        customer_name VARCHAR(255) NOT NULL,
        admin_name VARCHAR(255) DEFAULT NULL,
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
        chat_terminated BOOLEAN DEFAULT false,
        who_terminated ENUM('customer', 'support') DEFAULT NULL,
        last_activity DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX (customer_id),
        INDEX (is_online),
        INDEX (chat_terminated)
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

// Socket.IO connection
io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  // Customer registration with chat termination check
  socket.on('registerCustomer', async (data) => {
    const { customerId, customerName, socketId } = data;
    
    try {
      const connection = await pool.getConnection();
      
      // Check if chat is terminated
      const [sessionRows] = await connection.query(
        'SELECT chat_terminated FROM customer_sessions WHERE customer_id = ?',
        [customerId]
      );
      
      // If chat is terminated, don't allow registration and notify customer
      if (sessionRows.length > 0 && sessionRows[0].chat_terminated) {
        socket.emit('chatTerminated', {
          terminated: true,
          message: 'This chat session has been terminated. Please start a new chat.'
        });
        connection.release();
        return;
      }
      
      customers.set(customerId, socket.id);
      await connection.query(`
        INSERT INTO customer_sessions (customer_id, customer_name, socket_id, is_online, last_activity)
        VALUES (?, ?, ?, true, NOW())
        ON DUPLICATE KEY UPDATE
        socket_id = VALUES(socket_id),
        is_online = VALUES(is_online),
        last_activity = VALUES(last_activity)
      `, [customerId, customerName, socket.id]);
      connection.release();

      // Notify all admins about new customer
      broadcastToAdmins('customerStatus', {
        customerId,
        customerName,
        isOnline: true
      });

      // Notify customer about admin status
      const adminList = Array.from(admins.values());
      if (adminList.length > 0) {
        const firstAdmin = adminList[0]; // Or implement logic to choose which admin to show
        socket.emit('adminStatus', {
          isOnline: true,
          adminName: firstAdmin.adminName || "Support"
        });
      } else {
        socket.emit('adminStatus', {
          isOnline: false,
          adminName: "Support"
        });
      }

      broadcastCustomerList();
    } catch (error) {
      console.error('Error registering customer:', error);
    }
  });

  // Admin registration (multiple admins support)
  socket.on('registerAdmin', (data) => {
    const adminData = {
      socketId: socket.id,
      adminName: data?.adminName || "Support",
      ...data
    };
    
    admins.set(socket.id, adminData);
    isAdminOnline = admins.size > 0;
    
    console.log('Admin registered:', socket.id, 'Name:', adminData.adminName);
    
    // Notify all customers that an admin is online
    customers.forEach((socketId, customerId) => {
      io.to(socketId).emit('adminStatus', {
        isOnline: true,
        adminName: adminData.adminName
      });
    });
    
    broadcastCustomerList();
  });

  // Customer sends message
  socket.on('sendCustomerMessage', async (message) => {
    console.log('Customer message received:', message);
    const { id, text, customerId, senderName, media } = message;
    
    try {
      const connection = await pool.getConnection();
      
      // Check if chat is terminated before allowing message
      const [sessionRows] = await connection.query(
        'SELECT chat_terminated FROM customer_sessions WHERE customer_id = ?',
        [customerId]
      );
      
      if (sessionRows.length > 0 && sessionRows[0].chat_terminated) {
        socket.emit('chatTerminated', {
          terminated: true,
          message: 'This chat session has been terminated. You cannot send messages.'
        });
        connection.release();
        return;
      }
      
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

      // Forward message to all admins
      broadcastToAdmins('receiveCustomerMessage', {
        ...message,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error saving customer message:', error);
    }
  });

  // Admin sends message
  socket.on('sendAdminMessage', async (message) => {
    console.log('Admin message received:', message);
    const { id, text, customerId, senderName, media } = message;
    
    // Get the admin data who sent the message
    const adminData = admins.get(socket.id);
    const adminNameToUse = senderName || (adminData ? adminData.adminName : "Support");
    
    try {
      const connection = await pool.getConnection();
      
      // Save message with admin name
      await connection.query(`
        INSERT INTO customer_messages (message_id, customer_id, customer_name, admin_name, text, sender_type, timestamp)
        VALUES (?, ?, ?, ?, 'support', NOW())
      `, [id, customerId, adminNameToUse, adminNameToUse, text]);

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

      // Forward message to customer with admin name
      const customerSocketId = customers.get(customerId);
      if (customerSocketId) {
        io.to(customerSocketId).emit('receiveMessage', {
          ...message,
          timestamp: new Date().toISOString(),
          senderName: adminNameToUse
        });
      }
    } catch (error) {
      console.error('Error saving admin message:', error);
    }
  });

  // Customer terminates chat
  socket.on('terminateChat', async (data) => {
    const { customerId } = data;
    console.log('Customer terminating chat:', customerId);
    
    try {
      const connection = await pool.getConnection();
      await connection.query(`
        UPDATE customer_sessions 
        SET chat_terminated = true, who_terminated = 'customer' 
        WHERE customer_id = ?
      `, [customerId]);
      connection.release();

      // Remove customer from active connections
      customers.delete(customerId);

      // Notify customer that chat is terminated
      socket.emit('chatTerminated', {
        terminated: true,
        message: 'Chat terminated successfully. Starting new chat session...'
      });

      // Notify all admins
      broadcastToAdmins('chatTerminatedByCustomer', {
        customerId,
        message: 'Customer has terminated the chat session'
      });
      
      // Update customer list for admins
      broadcastCustomerList();

    } catch (error) {
      console.error('Error terminating chat:', error);
      socket.emit('terminateChatError', {
        error: 'Failed to terminate chat'
      });
    }
  });

  // Admin terminates chat
  socket.on('adminTerminateChat', async (data) => {
    const { customerId } = data;
    console.log('Admin terminating chat for customer:', customerId);
    
    try {
      const connection = await pool.getConnection();
      await connection.query(`
        UPDATE customer_sessions 
        SET chat_terminated = true, who_terminated = 'support' 
        WHERE customer_id = ?
      `, [customerId]);
      connection.release();

      // Notify customer
      const customerSocketId = customers.get(customerId);
      if (customerSocketId) {
        io.to(customerSocketId).emit('chatTerminated', {
          terminated: true,
          message: 'Support has terminated this chat session. Please start a new chat if you need further assistance.'
        });
        
        // Remove customer from active connections
        customers.delete(customerId);
      }

      // Notify admin
      socket.emit('chatTerminationSuccess', {
        customerId,
        message: 'Chat terminated successfully'
      });

      // Update customer list
      broadcastCustomerList();

    } catch (error) {
      console.error('Error terminating chat:', error);
      socket.emit('terminateChatError', {
        error: 'Failed to terminate chat'
      });
    }
  });

  // Handle disconnection
  socket.on('disconnect', async () => {
    console.log('Client disconnected:', socket.id);
    
    // Check if it was an admin
    if (admins.has(socket.id)) {
      admins.delete(socket.id);
      isAdminOnline = admins.size > 0;
      console.log('Admin disconnected:', socket.id);
      
      if (!isAdminOnline) {
        // Notify all customers that all admins are offline
        customers.forEach((socketId, customerId) => {
          io.to(socketId).emit('adminStatus', {
            isOnline: false,
            adminName: "Support"
          });
        });
      }
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
          
          // Notify all admins about customer going offline
          broadcastToAdmins('customerStatus', {
            customerId,
            isOnline: false
          });
        } catch (error) {
          console.error('Error updating customer status:', error);
        }
        break;
      }
    }
    broadcastCustomerList();
  });
});

// Helper function to broadcast to all admins
function broadcastToAdmins(event, data) {
  admins.forEach((adminData, socketId) => {
    io.to(socketId).emit(event, data);
  });
}

// Broadcast customer list to all admins
async function broadcastCustomerList() {
  if (admins.size === 0) return;
  
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query(`
      SELECT
        cs.customer_id as id,
        cs.customer_name as name,
        cs.is_online as isOnline,
        cs.chat_terminated as chatTerminated,
        cs.who_terminated as whoTerminated,
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
    
    // Send to all admins
    broadcastToAdmins('customerList', rows);
  } catch (error) {
    console.error('Error fetching customer list:', error);
  }
}

// API endpoint to get customer messages with admin names
app.get('/api/customer-messages/:customerId', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [messages] = await connection.query(`
      SELECT
        cm.id,
        cm.message_id,
        cm.customer_id,
        CASE 
          WHEN cm.sender_type = 'customer' THEN cm.customer_name 
          ELSE COALESCE(cm.admin_name, 'Support')
        END as senderName,
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

// API endpoint to check if chat is terminated
app.get('/api/check-chat-terminated/:customerId', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query(
      'SELECT chat_terminated, who_terminated FROM customer_sessions WHERE customer_id = ?',
      [req.params.customerId]
    );
    connection.release();

    if (rows.length > 0) {
      res.json({
        terminated: rows[0].chat_terminated,
        whoTerminated: rows[0].who_terminated
      });
    } else {
      res.json({ terminated: false });
    }
  } catch (error) {
    console.error('Error checking chat termination:', error);
    res.status(500).json({ error: 'Failed to check chat status', details: error.message });
  }
});

// API endpoint to terminate chat (for external calls)
app.post('/api/terminate-chat', async (req, res) => {
  try {
    const { customerId } = req.body;
    
    if (!customerId) {
      return res.status(400).json({ success: false, message: 'Customer ID is required' });
    }

    const connection = await pool.getConnection();
    const result = await connection.query(`
      UPDATE customer_sessions 
      SET chat_terminated = true, who_terminated = 'customer' 
      WHERE customer_id = ?
    `, [customerId]);
    connection.release();

    // Notify admins if online
    broadcastToAdmins('chatTerminatedByCustomer', {
      customerId,
      message: 'Customer has terminated the chat session'
    });
    
    broadcastCustomerList();

    res.json({ success: true, message: 'Chat terminated successfully' });
  } catch (error) {
    console.error('Error terminating chat:', error);
    res.status(500).json({ success: false, message: 'Failed to terminate chat', details: error.message });
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
        cs.chat_terminated as chatTerminated,
        cs.who_terminated as whoTerminated,
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
