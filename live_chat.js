const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const activeUsers = new Map();

io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  socket.on("joinChat", ({ chatId, userType, userId }) => {
    socket.join(chatId);
    activeUsers.set(socket.id, { chatId, userType, userId, socketId: socket.id });
    console.log(`Socket ${socket.id} (${userType}) joined chat ${chatId}`);

    const onlineUsers = Array.from(activeUsers.values()).filter(
      (user) => user.userType === "user"
    );
    io.emit("onlineUsers", onlineUsers);
  });

  socket.on("sendMessage", (message) => {
    console.log("Received message:", message);
    
    if (message.sender_type === "support" || message.sender === "support") {
      // Admin message - send to the specific customer
      const targetChatId = message.chatId || message.driverId;
      if (targetChatId) {
        console.log(`Broadcasting admin message to chat room: ${targetChatId}`);
        io.to(targetChatId).emit("receiveMessage", message);
        
        // Also send to all admins in the same chat
        const adminsInChat = Array.from(activeUsers.values()).filter(
          (user) => user.userType === "admin" && user.chatId === targetChatId
        );
        adminsInChat.forEach(admin => {
          io.to(admin.socketId).emit("receiveMessage", message);
        });
      }
    } else {
      // Customer/User message - send to the specific chat room and all admins
      console.log(`Broadcasting user message to chat room: ${message.chatId}`);
      io.to(message.chatId).emit("receiveMessage", message);
      
      // Send to all admins
      const admins = Array.from(activeUsers.values()).filter(
        (user) => user.userType === "admin"
      );
      admins.forEach(admin => {
        io.to(admin.socketId).emit("receiveMessage", message);
      });
    }
  });

  socket.on("disconnect", () => {
    const user = activeUsers.get(socket.id);
    if (user) {
      console.log(`Socket ${socket.id} (${user.userType}) left chat ${user.chatId}`);
      activeUsers.delete(socket.id);
      const onlineUsers = Array.from(activeUsers.values()).filter(
        (user) => user.userType === "user"
      );
      io.emit("onlineUsers", onlineUsers);
    }
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});
