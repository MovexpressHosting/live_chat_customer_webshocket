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

const dbConfig = {
  host: "srv657.hstgr.io",
  user: "u442108067_MoveExpress",
  password: "@1ItH~?ztgV",
  database: "u442108067_MoveExpress",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

async function initializeDatabase() {
  const connection = await pool.getConnection();
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS customer_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        message_id VARCHAR(100) NOT NULL,
        customer_id VARCHAR(100) NOT NULL,
        customer_name VARCHAR(255) NOT NULL,
        text TEXT NOT NULL,
        sender_type ENUM('customer', 'support') NOT NULL,
        admin_name VARCHAR(255) DEFAULT NULL,
        timestamp DATETIME NOT NULL,
        INDEX (customer_id),
        INDEX (timestamp),
        INDEX (message_id)
      )
    `);

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

    await connection.query(`
      CREATE TABLE IF NOT EXISTS customer_sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        customer_id VARCHAR(100) NOT NULL UNIQUE,
        customer_name VARCHAR(255) NOT NULL,
        socket_id VARCHAR(100),
        is_online BOOLEAN DEFAULT false,
        chat_terminated BOOLEAN DEFAULT false,
        who_terminated ENUM('customer', 'support') DEFAULT NULL,
        assigned_admin VARCHAR(255) DEFAULT NULL,
        assigned_admin_socket_id VARCHAR(100) DEFAULT NULL,
        last_activity DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX (customer_id),
        INDEX (is_online),
        INDEX (chat_terminated),
        INDEX (assigned_admin)
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

const customers = new Map();
const adminSockets = new Map();
let adminName = "Support";

// Track active admin assignments per customer
const activeAdminAssignments = new Map(); // customerId -> { adminName, adminSocketId }

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  socket.on('registerCustomer', async (data) => {
    const { customerId, customerName, socketId } = data;
    
    try {
      const connection = await pool.getConnection();
      
      const [sessionRows] = await connection.query(
        'SELECT chat_terminated, assigned_admin FROM customer_sessions WHERE customer_id = ?',
        [customerId]
      );
      
      if (sessionRows.length > 0 && sessionRows[0].chat_terminated) {
        socket.emit('chatTerminated', {
          terminated: true,
          message: 'This chat session has been terminated. Please start a new chat.'
        });
        connection.release();
        return;
      }
      
      customers.set(customerId, socket.id);
      
      // Get current assigned admin if exists
      const assignedAdmin = sessionRows.length > 0 ? sessionRows[0].assigned_admin : null;
      
      await connection.query(`
        INSERT INTO customer_sessions (customer_id, customer_name, socket_id, is_online, last_activity, assigned_admin)
        VALUES (?, ?, ?, true, NOW(), ?)
        ON DUPLICATE KEY UPDATE
        socket_id = VALUES(socket_id),
        is_online = VALUES(is_online),
        last_activity = VALUES(last_activity)
      `, [customerId, customerName, socket.id, assignedAdmin]);
      connection.release();

      // Notify admins about the customer
      adminSockets.forEach((adminData, adminSocketId) => {
        io.to(adminSocketId).emit('customerStatus', {
          customerId,
          customerName,
          isOnline: true,
          assignedAdmin: assignedAdmin
        });
      });

      // Send admin status and assignment info to customer
      socket.emit('adminStatus', {
        isOnline: adminSockets.size > 0,
        adminName: adminName,
        assignedAdmin: assignedAdmin
      });

      broadcastCustomerList();
    } catch (error) {
      console.error('Error registering customer:', error);
    }
  });

  socket.on('registerAdmin', (data) => {
    const adminData = {
      adminName: data?.adminName || "Support",
      socketId: socket.id
    };
    adminSockets.set(socket.id, adminData);
    adminName = data?.adminName || "Support";
    console.log('Admin registered:', socket.id, adminData.adminName, 'Total admins:', adminSockets.size);
    
    customers.forEach((socketId, customerId) => {
      io.to(socketId).emit('adminStatus', {
        isOnline: true,
        adminName: adminName
      });
    });
    
    broadcastCustomerList();
  });

  socket.on('adminOnline', (data) => {
    if (adminSockets.has(socket.id)) {
      const adminData = adminSockets.get(socket.id);
      adminData.adminName = data?.adminName || adminData.adminName;
      adminSockets.set(socket.id, adminData);
    }
    
    adminName = data?.adminName || adminName;
    console.log('Admin online status update:', adminSockets.size, 'admins online');
    
    customers.forEach((socketId, customerId) => {
      io.to(socketId).emit('adminStatus', {
        isOnline: adminSockets.size > 0,
        adminName: adminName
      });
    });
  });

  // Handle admin claiming a chat
  socket.on('claimChat', async (data) => {
    const { customerId, adminName: claimingAdminName } = data;
    const adminSocketId = socket.id;
    
    console.log(`Admin ${claimingAdminName} (${adminSocketId}) attempting to claim chat for ${customerId}`);
    
    try {
      // Check if chat is already assigned to another admin
      const connection = await pool.getConnection();
      const [sessionRows] = await connection.query(
        'SELECT assigned_admin, assigned_admin_socket_id FROM customer_sessions WHERE customer_id = ?',
        [customerId]
      );
      
      const currentAssignedAdmin = sessionRows.length > 0 ? sessionRows[0].assigned_admin : null;
      const currentAssignedSocketId = sessionRows.length > 0 ? sessionRows[0].assigned_admin_socket_id : null;
      
      // Check if the current assigned admin is still connected
      let isCurrentAdminActive = false;
      if (currentAssignedSocketId && adminSockets.has(currentAssignedSocketId)) {
        isCurrentAdminActive = true;
      }
      
      // If chat is already assigned to an active admin, prevent claiming
      if (currentAssignedAdmin && isCurrentAdminActive && currentAssignedSocketId !== adminSocketId) {
        socket.emit('chatClaimFailed', {
          customerId,
          message: `This chat is currently being handled by ${currentAssignedAdmin}. Please wait for them to release the chat.`,
          assignedAdmin: currentAssignedAdmin
        });
        connection.release();
        return;
      }
      
      // Update the assigned admin in database
      await connection.query(`
        UPDATE customer_sessions 
        SET assigned_admin = ?, assigned_admin_socket_id = ?
        WHERE customer_id = ?
      `, [claimingAdminName, adminSocketId, customerId]);
      
      connection.release();
      
      // Store in memory
      activeAdminAssignments.set(customerId, {
        adminName: claimingAdminName,
        adminSocketId: adminSocketId,
        adminSocket: socket
      });
      
      // Notify the customer about the assigned admin
      const customerSocketId = customers.get(customerId);
      if (customerSocketId) {
        io.to(customerSocketId).emit('adminAssigned', {
          adminName: claimingAdminName,
          canSendMessages: true
        });
      }
      
      // Notify the admin that they successfully claimed the chat
      socket.emit('chatClaimed', {
        customerId,
        success: true,
        message: `You are now handling chat with ${customerId}`
      });
      
      // Broadcast updated customer list to all admins
      broadcastCustomerList();
      
      console.log(`Admin ${claimingAdminName} successfully claimed chat for ${customerId}`);
      
    } catch (error) {
      console.error('Error claiming chat:', error);
      socket.emit('chatClaimFailed', {
        customerId,
        message: 'Failed to claim chat. Please try again.'
      });
    }
  });
  
  // Handle admin releasing a chat
  socket.on('releaseChat', async (data) => {
    const { customerId, adminName: releasingAdminName } = data;
    const adminSocketId = socket.id;
    
    console.log(`Admin ${releasingAdminName} (${adminSocketId}) releasing chat for ${customerId}`);
    
    try {
      // Check if this admin is the assigned one
      const connection = await pool.getConnection();
      const [sessionRows] = await connection.query(
        'SELECT assigned_admin, assigned_admin_socket_id FROM customer_sessions WHERE customer_id = ?',
        [customerId]
      );
      
      const currentAssignedAdmin = sessionRows.length > 0 ? sessionRows[0].assigned_admin : null;
      const currentAssignedSocketId = sessionRows.length > 0 ? sessionRows[0].assigned_admin_socket_id : null;
      
      // Only allow release if this admin is the assigned one
      if (currentAssignedAdmin === releasingAdminName && currentAssignedSocketId === adminSocketId) {
        await connection.query(`
          UPDATE customer_sessions 
          SET assigned_admin = NULL, assigned_admin_socket_id = NULL
          WHERE customer_id = ?
        `, [customerId]);
        
        // Remove from memory
        activeAdminAssignments.delete(customerId);
        
        // Notify the customer that no admin is assigned
        const customerSocketId = customers.get(customerId);
        if (customerSocketId) {
          io.to(customerSocketId).emit('adminAssigned', {
            adminName: null,
            canSendMessages: false
          });
        }
        
        socket.emit('chatReleased', {
          customerId,
          success: true,
          message: `You have released the chat with ${customerId}`
        });
        
        // Broadcast updated customer list to all admins
        broadcastCustomerList();
        
        console.log(`Admin ${releasingAdminName} released chat for ${customerId}`);
      } else {
        socket.emit('chatReleaseFailed', {
          customerId,
          message: 'You are not the assigned admin for this chat'
        });
      }
      
      connection.release();
      
    } catch (error) {
      console.error('Error releasing chat:', error);
      socket.emit('chatReleaseFailed', {
        customerId,
        message: 'Failed to release chat. Please try again.'
      });
    }
  });

  socket.on('sendCustomerMessage', async (message) => {
    console.log('Customer message received:', message);
    const { id, text, customerId, senderName, media } = message;
    
    try {
      const connection = await pool.getConnection();
      
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

      if (media && media.length > 0) {
        for (const item of media) {
          await connection.query(`
            INSERT INTO customer_media_uploads (message_id, customer_id, file_name, file_url, media_type, upload_time, file_size, mime_type)
            VALUES (?, ?, ?, ?, ?, NOW(), ?, ?)
          `, [id, customerId, item.file_name, item.file_url, item.media_type, item.file_size, item.mime_type]);
        }
      }
      connection.release();

      // Send to all admins
      adminSockets.forEach((adminData, adminSocketId) => {
        io.to(adminSocketId).emit('receiveCustomerMessage', {
          ...message,
          timestamp: new Date().toISOString()
        });
      });
    } catch (error) {
      console.error('Error saving customer message:', error);
    }
  });

  socket.on('sendAdminMessage', async (message) => {
    console.log('Admin message received:', message);
    const { id, text, customerId, media } = message;
    
    try {
      const connection = await pool.getConnection();
      
      // Get the admin who is sending this message
      const adminData = adminSockets.get(socket.id);
      const currentAdminName = adminData?.adminName || "Support";
      
      // Verify that this admin is assigned to this chat
      const [sessionRows] = await connection.query(
        'SELECT assigned_admin FROM customer_sessions WHERE customer_id = ?',
        [customerId]
      );
      
      const assignedAdmin = sessionRows.length > 0 ? sessionRows[0].assigned_admin : null;
      
      // Only allow message if this admin is assigned to the chat
      if (assignedAdmin && assignedAdmin !== currentAdminName) {
        socket.emit('messageSendFailed', {
          message: `You cannot send messages to this chat. It is currently handled by ${assignedAdmin}.`
        });
        connection.release();
        return;
      }
      
      await connection.query(`
        INSERT INTO customer_messages (message_id, customer_id, customer_name, text, sender_type, admin_name, timestamp)
        VALUES (?, ?, ?, ?, 'support', ?, NOW())
      `, [id, customerId, currentAdminName, text, currentAdminName]);

      if (media && media.length > 0) {
        for (const item of media) {
          await connection.query(`
            INSERT INTO customer_media_uploads (message_id, customer_id, file_name, file_url, media_type, upload_time, file_size, mime_type)
            VALUES (?, ?, ?, ?, ?, NOW(), ?, ?)
          `, [id, customerId, item.file_name, item.file_url, item.media_type, item.file_size, item.mime_type]);
        }
      }
      connection.release();

      const customerSocketId = customers.get(customerId);
      if (customerSocketId) {
        io.to(customerSocketId).emit('receiveMessage', {
          ...message,
          timestamp: new Date().toISOString(),
          senderName: currentAdminName
        });
      }
    } catch (error) {
      console.error('Error saving admin message:', error);
    }
  });

  socket.on('terminateChat', async (data) => {
    const { customerId } = data;
    console.log('Customer terminating chat:', customerId);
    
    try {
      const connection = await pool.getConnection();
      await connection.query(`
        UPDATE customer_sessions 
        SET chat_terminated = true, who_terminated = 'customer', assigned_admin = NULL, assigned_admin_socket_id = NULL
        WHERE customer_id = ?
      `, [customerId]);
      connection.release();

      customers.delete(customerId);
      activeAdminAssignments.delete(customerId);

      socket.emit('chatTerminated', {
        terminated: true,
        message: 'Chat terminated successfully. Starting new chat session...'
      });

      adminSockets.forEach((adminData, adminSocketId) => {
        io.to(adminSocketId).emit('chatTerminatedByCustomer', {
          customerId,
          message: 'Customer has terminated the chat session'
        });
      });
      
      broadcastCustomerList();

    } catch (error) {
      console.error('Error terminating chat:', error);
      socket.emit('terminateChatError', {
        error: 'Failed to terminate chat'
      });
    }
  });

  socket.on('adminTerminateChat', async (data) => {
    const { customerId } = data;
    console.log('Admin terminating chat for customer:', customerId);
    
    try {
      const connection = await pool.getConnection();
      await connection.query(`
        UPDATE customer_sessions 
        SET chat_terminated = true, who_terminated = 'support', assigned_admin = NULL, assigned_admin_socket_id = NULL
        WHERE customer_id = ?
      `, [customerId]);
      connection.release();

      const customerSocketId = customers.get(customerId);
      if (customerSocketId) {
        io.to(customerSocketId).emit('chatTerminated', {
          terminated: true,
          message: 'Support has terminated this chat session. Please start a new chat if you need further assistance.'
        });
        
        customers.delete(customerId);
        activeAdminAssignments.delete(customerId);
      }

      socket.emit('chatTerminationSuccess', {
        customerId,
        message: 'Chat terminated successfully'
      });

      broadcastCustomerList();

    } catch (error) {
      console.error('Error terminating chat:', error);
      socket.emit('terminateChatError', {
        error: 'Failed to terminate chat'
      });
    }
  });

  socket.on('disconnect', async () => {
    console.log('Client disconnected:', socket.id);
    
    // Check if this is an admin disconnecting
    if (adminSockets.has(socket.id)) {
      const adminData = adminSockets.get(socket.id);
      const disconnectingAdminName = adminData.adminName;
      adminSockets.delete(socket.id);
      console.log('Admin disconnected:', disconnectingAdminName, 'Remaining admins:', adminSockets.size);
      
      // Release all chats that this admin was handling
      try {
        const connection = await pool.getConnection();
        await connection.query(`
          UPDATE customer_sessions 
          SET assigned_admin = NULL, assigned_admin_socket_id = NULL
          WHERE assigned_admin_socket_id = ?
        `, [socket.id]);
        connection.release();
        
        // Notify affected customers
        for (const [customerId, assignment] of activeAdminAssignments.entries()) {
          if (assignment.adminSocketId === socket.id) {
            activeAdminAssignments.delete(customerId);
            const customerSocketId = customers.get(customerId);
            if (customerSocketId) {
              io.to(customerSocketId).emit('adminAssigned', {
                adminName: null,
                canSendMessages: false
              });
            }
          }
        }
        
        broadcastCustomerList();
      } catch (error) {
        console.error('Error releasing admin chats:', error);
      }
      
      customers.forEach((socketId, customerId) => {
        io.to(socketId).emit('adminStatus', {
          isOnline: adminSockets.size > 0,
          adminName: adminName
        });
      });
      
      return;
    }

    // Handle customer disconnection
    for (const [customerId, socketId] of customers.entries()) {
      if (socketId === socket.id) {
        customers.delete(customerId);
        // Don't remove assignment, keep it for when customer comes back
        try {
          const connection = await pool.getConnection();
          await connection.query(
            'UPDATE customer_sessions SET is_online = false WHERE customer_id = ?',
            [customerId]
          );
          connection.release();
          adminSockets.forEach((adminData, adminSocketId) => {
            io.to(adminSocketId).emit('customerStatus', {
              customerId,
              isOnline: false,
              assignedAdmin: activeAdminAssignments.get(customerId)?.adminName || null
            });
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

async function broadcastCustomerList() {
  if (adminSockets.size === 0) return;
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
        cs.assigned_admin as assignedAdmin,
        cs.assigned_admin_socket_id as assignedAdminSocketId,
        (SELECT COUNT(*) FROM customer_messages cm
         WHERE cm.customer_id = cs.customer_id
         AND cm.sender_type = 'customer'
         AND cm.timestamp > COALESCE((SELECT MAX(timestamp) FROM customer_messages
                                    WHERE customer_id = cs.customer_id AND sender_type = 'support'), '2000-01-01')
        ) as unreadCount
      FROM customer_sessions cs
      WHERE cs.chat_terminated = false
      ORDER BY cs.last_activity DESC
    `);
    connection.release();
    adminSockets.forEach((adminData, adminSocketId) => {
      io.to(adminSocketId).emit('customerList', rows);
    });
  } catch (error) {
    console.error('Error fetching customer list:', error);
  }
}

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
        cm.admin_name,
        cm.timestamp
      FROM customer_messages cm
      WHERE cm.customer_id = ?
      ORDER BY cm.timestamp ASC
    `, [req.params.customerId]);

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

app.get('/api/check-chat-assignment/:customerId', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    const [rows] = await connection.query(
      'SELECT assigned_admin, assigned_admin_socket_id FROM customer_sessions WHERE customer_id = ?',
      [req.params.customerId]
    );
    connection.release();

    if (rows.length > 0) {
      res.json({
        assignedAdmin: rows[0].assigned_admin,
        assignedAdminSocketId: rows[0].assigned_admin_socket_id
      });
    } else {
      res.json({ assignedAdmin: null, assignedAdminSocketId: null });
    }
  } catch (error) {
    console.error('Error checking chat assignment:', error);
    res.status(500).json({ error: 'Failed to check chat assignment', details: error.message });
  }
});

app.post('/api/terminate-chat', async (req, res) => {
  try {
    const { customerId } = req.body;
    
    if (!customerId) {
      return res.status(400).json({ success: false, message: 'Customer ID is required' });
    }

    const connection = await pool.getConnection();
    const result = await connection.query(`
      UPDATE customer_sessions 
      SET chat_terminated = true, who_terminated = 'customer', assigned_admin = NULL, assigned_admin_socket_id = NULL 
      WHERE customer_id = ?
    `, [customerId]);
    connection.release();

    adminSockets.forEach((adminData, adminSocketId) => {
      io.to(adminSocketId).emit('chatTerminatedByCustomer', {
        customerId,
        message: 'Customer has terminated the chat session'
      });
    });
    broadcastCustomerList();

    res.json({ success: true, message: 'Chat terminated successfully' });
  } catch (error) {
    console.error('Error terminating chat:', error);
    res.status(500).json({ success: false, message: 'Failed to terminate chat', details: error.message });
  }
});

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
        cs.assigned_admin as assignedAdmin,
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
      WHERE cs.chat_terminated = false
      ORDER BY cs.last_activity DESC
    `);
    connection.release();
    res.json(customers);
  } catch (error) {
    console.error('Error fetching customers:', error);
    res.status(500).json({ error: 'Failed to fetch customers', details: error.message });
  }
});

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
