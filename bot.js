const pino = require("pino");
const fs = require("fs");
const { default: makeWASocket, useMultiFileAuthState, Browsers, delay, DisconnectReason } = require("@whiskeysockets/baileys");
const { PausedChats } = require("./database");
const config = require("./config");
const plugins = require("./plugins");
const { serialize, Greetings } = require("./index");
const { Image, Message, Sticker, Video, AllMessage } = require("./Messages");
const { loadMessage, saveMessage, saveChat, getName } = require("./database/StoreDb");

const logger = pino({
  "level": "silent"
});

const connect = async () => {
  const startSocket = async () => {
    try {
      let sessionPath = __dirname + "/session/creds.json";
      
      // Ensure session directory and creds.json exist
      if (!fs.existsSync(__dirname + "/session")) {
        fs.mkdirSync(__dirname + "/session");
      }

      if (!fs.existsSync(sessionPath)) {
        // Write SESSION_ID from config to creds.json
        await fs.writeFileSync(sessionPath, JSON.stringify({ session: config.SESSION_ID }));
      }

      // Use multi-file auth state from session directory
      const { state: authState, saveCreds } = await useMultiFileAuthState(__dirname + "/session/");

      let sock = makeWASocket({
        "version": [2, 3065, 13],  // Update version based on current requirements
        "auth": authState,
        "printQRInTerminal": true,
        "logger": logger,
        "browser": Browsers.macOS("Desktop"),
        "downloadHistory": false,
        "syncFullHistory": false,
        "markOnlineOnConnect": false,
        "emitOwnEvents": true,
        "getMessage": async (key) => (loadMessage(key.id) || {}).message || { "conversation": null }
      });

      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "connecting") {
          console.log("ℹ Connecting to WhatsApp... Please Wait.");
        }
        if (connection === "open") {
          console.log("✅ Login to WhatsApp Successful!");
          const version = require("./package.json").version;
          const commandCount = plugins.commands.length;
          const mode = config.WORK_TYPE;
          const welcomeMessage = `
          *╭═══════════════ ⪩*
          *╰╮╰┈➤* *☬ QUEEN ALYA ☬*
          *╭═══════════════ ⪩*
          *┃ Version:* ${version}
          *┃ Plugins:* ${commandCount}
          *┃ MODE:* ${mode}
          *┃ PREFIX:* ${config.HANDLERS}
          *┃ MODS:* ${config.SUDO}
          *╰════════════════ ⪨*
          `;
          sock.sendMessage(sock.user.id, { "text": welcomeMessage });
        }
        if (connection === "close") {
          if (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut) {
            await delay(300);
            startSocket();
            console.log("Reconnecting...");
          } else {
            console.log("Connection closed. Device logged out.");
            await delay(3000);
            process.exit(0);
          }
        }
      });

      sock.ev.on("creds.update", saveCreds);
      sock.ev.on("group-participants.update", async (update) => Greetings(update, sock));
      sock.ev.on("chats.update", async (chats) => {
        chats.forEach(async (chat) => await saveChat(chat));
      });
      sock.ev.on("messages.upsert", async (messageUpdate) => {
        if (messageUpdate.type !== "notify") return;

        let messageData = await serialize(JSON.parse(JSON.stringify(messageUpdate.messages[0])), sock);
        await saveMessage(messageUpdate.messages[0], messageData.sender);

        if (config.AUTO_READ) {
          await sock.readMessages(messageData.key);
        }
        if (config.AUTO_STATUS_READ && messageData.from === "status@broadcast") {
          await sock.readMessages(messageData.key);
        }

        const messageBody = messageData.body;
        if (!messageData) return;

        const resumeRegex = new RegExp(config.HANDLERS + "( ?resume)", "is");
        const isResume = resumeRegex.test(messageBody);
        const chatId = messageData.from;

        try {
          const pausedChats = await PausedChats.getPausedChats();
          if (pausedChats.some(paused => paused.chatId === chatId && !isResume)) return;
        } catch (error) {
          console.error(error);
        }

        if (config.LOGS) {
          let senderName = await getName(messageData.sender);
          console.log(`At: ${messageData.from.endsWith("@g.us") ? (await sock.groupMetadata(messageData.from)).subject : messageData.from}\nFrom: ${senderName}\nMessage: ${messageBody ? messageBody : messageData.type}`);
        }

        plugins.commands.map(async (cmd) => {
          if (cmd.fromMe && !messageData.sudo) return;
          messageData.prefix = new RegExp(config.HANDLERS).test(messageBody) ? messageBody[0].toLowerCase() : "!";
          let parsedMessage;

          switch (true) {
            case cmd.pattern && cmd.pattern.test(messageBody):
              try {
                parsedMessage = messageBody.replace(new RegExp(cmd.pattern, "i"), '').trim();
              } catch {
                parsedMessage = false;
              }
              let commandMessage = new Message(sock, messageData);
              cmd["function"](commandMessage, parsedMessage, messageData, sock);
              break;
            case messageBody && cmd.on === "text":
              let textMessage = new Message(sock, messageData);
              cmd["function"](textMessage, messageBody, messageData, sock, messageUpdate);
              break;
            case cmd.on === "image" && messageData.type === "imageMessage":
              let imageMessage = new Image(sock, messageData);
              cmd["function"](imageMessage, messageBody, messageData, sock, messageUpdate);
              break;
            case cmd.on === "sticker" && messageData.type === "stickerMessage":
              let stickerMessage = new Sticker(sock, messageData);
              cmd["function"](stickerMessage, messageData, sock, messageUpdate);
              break;
            case cmd.on === "video" && messageData.type === "videoMessage":
              let videoMessage = new Video(sock, messageData);
              cmd["function"](videoMessage, messageData, sock, messageUpdate);
              break;
            case cmd.on === "delete" && messageData.type === "protocolMessage":
              let deletedMessage = new Message(sock, messageData);
              deletedMessage.messageId = messageData.message.protocolMessage.key.id;
              cmd["function"](deletedMessage, messageData, sock, messageUpdate);
              break;
            case cmd.on === "message":
              let anyMessage = new AllMessage(sock, messageData);
              cmd["function"](anyMessage, messageData, sock, messageUpdate);
              break;
            default:
              break;
          }
        });
      });

      process.on("uncaughtException", async (err) => {
        await sock.sendMessage(sock.user.id, { "text": err.message });
        console.log(err);
      });

      return sock;
    } catch (error) {
      console.log(error);
    }
    return;
  };

  try {
    await startSocket();
  } catch (error) {
    console.error("Connection error:", error);
  }
};

module.exports = connect;