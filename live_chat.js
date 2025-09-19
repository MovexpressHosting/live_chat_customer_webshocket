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
    const rooms = Array.from(socket.rooms);
    if (!rooms.includes(chatId)) {
      socket.join(chatId);
      activeUsers.set(socket.id, { chatId, userType, userId });
      console.log(`Socket ${socket.id} (${userType}) joined chat ${chatId}`);
      const onlineUsers = Array.from(activeUsers.values()).filter(
        (user) => user.userType === "user"
      );
      io.emit("onlineUsers", onlineUsers);
    } else {
      console.log(`Socket ${socket.id} is already in chat ${chatId}`);
    }
  });
  socket.on("sendMessage", (message) => {
    console.log("Emitting message to room", message.chatId, "with ID", message.id);
    io.to(message.chatId).emit("receiveMessage", message);
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
