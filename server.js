
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "20kb" }));

// GROQ CONFIGURATION
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = "openai/gpt-oss-20b";

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

const groups = {};
const conversations = {};

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

// HOME
app.get("/", (req, res) => {
  res.json({
    bot: "TeenVibe AI",
    version: "4.0",
    status: "online",
    ai: GROQ_API_KEY ? "configured" : "missing_api_key",
    provider: "Groq",
    model: GROQ_MODEL,
    message: "TeenVibe AI is ready!"
  });
});

// HELP
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
      "/quiz",
      "/team",
      "/score",
      "/chat",
      "/help"
    ]
  });
});

// ACTIVITIES
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

// ADD SCORE
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

// LEADERBOARD
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

// GROQ AI CHAT
app.post("/chat", async (req, res) => {
  try {
    if (!GROQ_API_KEY) {
      return res.status(503).json({
        error: "Groq API key is not configured."
      });
    }

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

    if (!conversations[chatId]) {
      conversations[chatId] = [];
    }

    const history = conversations[chatId];

    const systemInstruction = `
You are TeenVibe AI, a friendly AI entertainment companion
for a teen community.

Your personality:
- Funny, lively, witty and welcoming.
- Use natural conversational language.
- Understand harmless teen slang.
- Encourage friendship, creativity and learning.
- Suggest fun games and group activities.
- Respect everyone in the group.
- Make conversations engaging and interactive.

Safety:
- Keep conversations age-appropriate.
- Never encourage dangerous challenges.
- Never request private or sensitive information.
- Avoid explicit or sexual content.
- Be respectful and supportive.

Keep replies conversational and reasonably short.
`;

    const messages = [
      {
        role: "system",
        content: systemInstruction
      },
      ...history,
      {
        role: "user",
        content: `${sender}: ${message.trim()}`
      }
    ];

    // AUTOMATIC GROQ RETRIES
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

        // Read response body once
        data = await response.json().catch(() => ({}));

        if (response.ok) {
          break;
        }

        const retryable = [
          408, 429, 500, 502, 503, 504
        ].includes(response.status);

        if (!retryable || attempt === maxRetries) {
          break;
        }

      } catch (error) {
        requestError = error;

        if (attempt === maxRetries) {
          break;
        }
      }

      const delay =
        1000 * (2 ** attempt) + Math.random() * 500;

      await new Promise(resolve =>
        setTimeout(resolve, delay)
      );
    }

    // CHECK GROQ RESPONSE
    if (!response || !response.ok) {
      const errorMessage =
        data?.error?.message ||
        requestError?.message ||
        "No response received";

      console.error("Groq API error:", errorMessage);

      return res.status(502).json({
        error: "Groq could not process the message.",
        details: errorMessage
      });
    }

    const reply =
      data.choices?.[0]?.message?.content?.trim();

    if (!reply) {
      return res.status(502).json({
        error: "Groq returned an empty response."
      });
    }

    // SAVE CONVERSATION HISTORY
    history.push(
      {
        role: "user",
        content: `${sender}: ${message.trim()}`
      },
      {
        role: "assistant",
        content: reply
      }
    );

    if (history.length > 12) {
      history.splice(0, history.length - 12);
    }

    res.json({
      bot: "TeenVibe AI",
      provider: "Groq",
      player: sender,
      reply
    });

  } catch (error) {
    console.error("Chat error:", error.message);

    res.status(500).json({
      error: "Something went wrong while processing your message."
    });
  }
});

// 404
app.use((req, res) => {
  res.status(404).json({
    error: "Endpoint not found"
  });
});

// START SERVER
app.listen(PORT, () => {
  console.log(`TeenVibe AI running on port ${PORT}`);
});
