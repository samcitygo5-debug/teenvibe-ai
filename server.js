
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "20kb" }));

// ======================================
// CONFIGURATION
// ======================================

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = "openai/gpt-oss-20b";

const WHAPI_API_TOKEN = process.env.WHAPI_API_TOKEN;
const WHAPI_WEBHOOK_SECRET = process.env.WHAPI_WEBHOOK_SECRET;

const WHAPI_API_URL = "https://gate.whapi.cloud";

// ======================================
// STORAGE
// ======================================

const groups = {};
const conversations = {};
const processedMessages = new Set();

// ======================================
// ACTIVITIES
// ======================================

const activities = {
  fun: [
    "Describe your personality using 3 emojis 😂",
    "If you could visit any country, where would you go?",
    "What unusual talent would you like to learn?",
    "Invent a new holiday and name it!",
    "If your life were a movie, what would its title be?"
  ],

  truth: [
    "What's the funniest thing that happened to you recently?",
    "What's a skill you wish you had?",
    "What's one thing people misunderstand about you?",
    "What's your favourite childhood memory?"
  ],

  wyr: [
    "Would you rather explore space or the deep ocean?",
    "Would you rather speak every language or play every instrument?",
    "Would you rather travel into the past or the future?",
    "Would you rather have unlimited books or unlimited games?"
  ],

  joke: [
    "Why did the computer go to the doctor? It had a virus! 😂",
    "Why was the maths book sad? It had too many problems!",
    "Why did the phone wear glasses? It lost its contacts!"
  ],

  riddle: [
    "What has keys but cannot open locks? Answer: A piano.",
    "What gets wetter as it dries? Answer: A towel.",
    "What has a face and two hands but no arms? Answer: A clock."
  ],

  challenge: [
    "Describe your favourite movie without saying its name.",
    "Create a funny group slogan in 10 words or less.",
    "Name five animals in ten seconds.",
    "Tell a story using exactly five words."
  ]
};

// ======================================
// GENERAL FUNCTIONS
// ======================================

function getGroup(id) {
  if (!groups[id]) {
    groups[id] = {
      players: {},
      gamesPlayed: 0
    };
  }

  return groups[id];
}

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

// ======================================
// GROQ AI
// ======================================

async function generateGroqReply(chatId, sender, message) {
  if (!GROQ_API_KEY) {
    throw new Error("Groq API key is missing.");
  }

  if (!conversations[chatId]) {
    conversations[chatId] = [];
  }

  const history = conversations[chatId];

  const systemInstruction = `
You are TeenVibe AI, a friendly AI entertainment
companion for a teen community.

PERSONALITY:
- Funny, lively, witty and welcoming.
- Use natural conversational language.
- Understand harmless teen slang.
- Encourage friendship, creativity and learning.
- Suggest fun games and group activities.
- Respect everyone.

SAFETY:
- Keep conversations age-appropriate.
- Never encourage dangerous challenges.
- Never request private or sensitive information.
- Avoid explicit or sexual content.
- Be respectful and supportive.

Keep replies conversational and reasonably short.
`;

  const userContent = `${sender}: ${message}`;

  const messages = [
    {
      role: "system",
      content: systemInstruction
    },
    ...history,
    {
      role: "user",
      content: userContent
    }
  ];

  let response;
  let data;
  let requestError;

  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      response = await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${GROQ_API_KEY}`
          },

          body: JSON.stringify({
            model: GROQ_MODEL,
            messages,
            max_completion_tokens: 500,
            temperature: 0.7
          }),

          signal: AbortSignal.timeout(30000)
        }
      );

      data = await response.json().catch(() => ({}));

      if (response.ok) break;

      const retryable = [
        408, 429, 500, 502, 503, 504
      ].includes(response.status);

      if (!retryable || attempt === maxRetries) break;

    } catch (error) {
      requestError = error;

      if (attempt === maxRetries) break;
    }

    const delay =
      1000 * (2 ** attempt) + Math.random() * 500;

    await new Promise(resolve => setTimeout(resolve, delay));
  }

  if (!response || !response.ok) {
    throw new Error(
      data?.error?.message ||
      requestError?.message ||
      "Groq request failed."
    );
  }

  const reply =
    data.choices?.[0]?.message?.content?.trim();

  if (!reply) {
    throw new Error("Groq returned an empty response.");
  }

  history.push(
    {
      role: "user",
      content: userContent
    },
    {
      role: "assistant",
      content: reply
    }
  );

  if (history.length > 12) {
    history.splice(0, history.length - 12);
  }

  return reply;
}

// ======================================
// WHATSAPP MESSAGE SENDER
// ======================================

async function sendWhatsAppMessage(chatId, message) {
  if (!WHAPI_API_TOKEN) {
    throw new Error("Whapi token is missing.");
  }

  const response = await fetch(
    `${WHAPI_API_URL}/messages/text`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${WHAPI_API_TOKEN}`
      },

      body: JSON.stringify({
        to: chatId,
        body: message
      }),

      signal: AbortSignal.timeout(20000)
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.error?.message || "WhatsApp sending failed."
    );
  }

  return data;
}

// ======================================
// WHATSAPP MESSAGE HANDLER
// ======================================

async function handleWhatsAppMessage(message) {
  if (!message || message.from_me === true) {
    console.log("WHAPI: Own message ignored.");
    return;
  }

  if (message.type !== "text") {
    console.log("WHAPI: Non-text message ignored.");
    return;
  }

  const chatId = message.chat_id;
  const incomingText = message.text?.body?.trim();

  if (!chatId || !incomingText) {
    console.log("WHAPI: Missing chat ID or text.");
    return;
  }

  if (incomingText.length > 2000) {
    console.log("WHAPI: Message too long.");
    return;
  }

  const isGroup = chatId.endsWith("@g.us");

  const sender =
    message.from_name ||
    message.from ||
    "Friend";

  const isCommand = incomingText.startsWith("/");

  const isMentioned =
    /@?TeenVibe/i.test(incomingText);

  console.log("WHAPI: Incoming text recognised.", {
    isGroup,
    isCommand,
    isMentioned
  });

  // GROUPS ONLY RESPOND TO MENTIONS OR COMMANDS
  if (isGroup && !isCommand && !isMentioned) {
    console.log("WHAPI: Group message not addressed to bot.");
    return;
  }

  let responseText = "";

  // ====================================
  // COMMANDS
  // ====================================

  if (isCommand) {
    const parts = incomingText.split(/\s+/);
    const command = parts[0].toLowerCase();

    const commandType = command.replace("/", "");

    if (activities[commandType]) {
      responseText = pick(activities[commandType]);
    }

    else if (commandType === "help") {
      responseText =
        "🎉 *TEENVIBE AI COMMANDS*\n\n" +
        "/fun - Fun activity\n" +
        "/truth - Truth question\n" +
        "/wyr - Would you rather\n" +
        "/joke - Get a joke\n" +
        "/riddle - Solve a riddle\n" +
        "/challenge - Group challenge\n" +
        "/score - View leaderboard\n" +
        "/chat - Talk with TeenVibe\n" +
        "/help - Show commands";
    }

    else if (commandType === "score") {
      const group = getGroup(chatId);

      const leaderboard = Object.entries(group.players)
        .sort((a, b) => b[1] - a[1]);

      responseText = leaderboard.length
        ? "🏆 *TEENVIBE LEADERBOARD*\n\n" +
          leaderboard.map(
            ([name, points], index) =>
              `${index + 1}. ${name}: ${points} points`
          ).join("\n")
        : "No scores yet! Start playing to earn points. 🎮";
    }

    else if (commandType === "chat") {
      const prompt = parts.slice(1).join(" ").trim();

      if (prompt) {
        responseText = await generateGroqReply(
          chatId,
          sender,
          prompt
        );
      } else {
        responseText = "Tell me what's on your mind! 😎";
      }
    }

    else {
      responseText =
        "I don't recognise that command. Type /help to see available commands.";
    }
  }

  // ====================================
  // NORMAL AI CONVERSATION
  // ====================================

  else {
    const cleanMessage = incomingText
      .replace(/@?TeenVibe/gi, "")
      .trim();

    if (!cleanMessage) {
      responseText = "Hey! What's happening? 😎";
    } else {
      responseText = await generateGroqReply(
        chatId,
        sender,
        cleanMessage
      );
    }
  }

  // ====================================
  // SEND RESPONSE
  // ====================================

  if (responseText) {
    await sendWhatsAppMessage(chatId, responseText);

    console.log("WHAPI: Reply sent successfully.", {
      isGroup
    });
  }
}

// ======================================
// WHAPI WEBHOOK
// ======================================

app.post("/whapi/webhook/:secret", (req, res) => {

  console.log("WHAPI WEBHOOK REQUEST RECEIVED.");

  if (!WHAPI_WEBHOOK_SECRET) {
    console.error("WHAPI: Webhook secret is missing.");
    return res.sendStatus(503);
  }

  if (req.params.secret !== WHAPI_WEBHOOK_SECRET) {
    console.error("WHAPI: Webhook secret verification failed.");
    return res.sendStatus(401);
  }

  const messages = req.body?.messages;

  console.log("WHAPI WEBHOOK AUTHENTICATED:", {
    event: req.body?.event || "unknown",
    hasMessages: Array.isArray(messages),
    messageCount: Array.isArray(messages)
      ? messages.length
      : 0
  });

  // Respond to Whapi immediately.
  res.sendStatus(200);

  if (!Array.isArray(messages)) {
    console.log("WHAPI: No messages array in this event.");
    return;
  }

  for (const message of messages) {
    const messageId = message?.id;

    if (messageId && processedMessages.has(messageId)) {
      console.log("WHAPI: Duplicate message ignored.");
      continue;
    }

    if (messageId) {
      processedMessages.add(messageId);

      if (processedMessages.size > 5000) {
        const oldest =
          processedMessages.values().next().value;

        processedMessages.delete(oldest);
      }
    }

    handleWhatsAppMessage(message).catch(error => {
      console.error(
        "WHAPI PROCESSING ERROR:",
        error.message
      );
    });
  }
});

// ======================================
// HOME
// ======================================

app.get("/", (req, res) => {
  res.json({
    bot: "TeenVibe AI",
    version: "5.1",
    status: "online",
    ai: GROQ_API_KEY ? "configured" : "missing_api_key",
    provider: "Groq",
    model: GROQ_MODEL,
    whatsapp: WHAPI_API_TOKEN ? "configured" : "missing_token",
    webhook: WHAPI_WEBHOOK_SECRET ? "configured" : "missing_secret",
    message: "TeenVibe AI is ready!"
  });
});

// ======================================
// HELP API
// ======================================

app.get("/help", (req, res) => {
  res.json({
    bot: "TeenVibe AI",
    commands: [
      "/fun",
      "/truth",
      "/wyr",
      "/joke",
      "/riddle",
      "/challenge",
      "/score",
      "/chat",
      "/help"
    ]
  });
});

// ======================================
// ACTIVITIES API
// ======================================

app.get("/activity/:type", (req, res) => {
  const type = req.params.type.toLowerCase();
  const list = activities[type];

  if (!list) {
    return res.status(404).json({
      error: "Activity not available",
      available: Object.keys(activities)
    });
  }

  res.json({
    bot: "TeenVibe AI",
    type,
    activity: pick(list)
  });
});

// ======================================
// ADD SCORE API
// ======================================

app.post("/score", (req, res) => {
  const { groupId, player, points } = req.body;

  if (
    typeof groupId !== "string" ||
    typeof player !== "string" ||
    typeof points !== "number" ||
    !groupId.trim() ||
    !player.trim() ||
    !Number.isFinite(points) ||
    points < 0 ||
    points > 100
  ) {
    return res.status(400).json({
      error: "Provide a groupId, player and valid points (0–100)."
    });
  }

  const group = getGroup(groupId.trim());
  const name = player.trim().slice(0, 40);

  group.players[name] =
    (group.players[name] || 0) + points;

  res.json({
    success: true,
    player: name,
    totalPoints: group.players[name]
  });
});

// ======================================
// LEADERBOARD API
// ======================================

app.get("/score/:groupId", (req, res) => {
  const group = getGroup(req.params.groupId);

  const leaderboard = Object.entries(group.players)
    .map(([player, points]) => ({
      player,
      points
    }))
    .sort((a, b) => b.points - a.points);

  res.json({
    leaderboard,
    gamesPlayed: group.gamesPlayed
  });
});

// ======================================
// GROQ CHAT API
// ======================================

app.post("/chat", async (req, res) => {
  try {
    const { message, groupId, player } = req.body;

    if (
      typeof message !== "string" ||
      !message.trim() ||
      message.length > 2000
    ) {
      return res.status(400).json({
        error: "Provide a message between 1 and 2000 characters."
      });
    }

    const chatId =
      typeof groupId === "string" && groupId.trim()
        ? groupId.trim().slice(0, 80)
        : "default";

    const sender =
      typeof player === "string" && player.trim()
        ? player.trim().slice(0, 40)
        : "A group member";

    const reply = await generateGroqReply(
      chatId,
      sender,
      message.trim()
    );

    res.json({
      bot: "TeenVibe AI",
      provider: "Groq",
      player: sender,
      reply
    });

  } catch (error) {
    console.error("Chat error:", error.message);

    res.status(502).json({
      error: "Something went wrong while processing your message."
    });
  }
});

// ======================================
// 404
// ======================================

app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint not found"
  });
});

// ======================================
// START SERVER
// ======================================

app.listen(PORT, () => {
  console.log(`TeenVibe AI running on port ${PORT}`);
});
