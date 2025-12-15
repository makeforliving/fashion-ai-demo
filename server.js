const express = require("express");
const cors = require("cors");
const axios = require("axios");
const path = require("path");
require("dotenv").config();
const Redis = require("ioredis");

const app = express();
const PORT = process.env.PORT || 10000;

// 1. 中间件
app.use(cors());
app.use(express.json());
app.use(express.static("public")); // 确保前端网页能显示

// 2. Redis 连接
let redis;
if (process.env.REDIS_URL) {
    redis = new Redis(process.env.REDIS_URL);
    redis.on("error", (err) => console.error("Redis Error:", err));
    redis.on("connect", () => console.log("✅ Connected to Redis!"));
} else {
    console.warn("⚠️ No REDIS_URL found, running without cache.");
}

// 3. API Key 管理
const apiKeys = process.env.GEMINI_API_KEYS
    ? process.env.GEMINI_API_KEYS.split(",")
    : [];
let currentKeyIndex = 0;

function getNextKey() {
    if (apiKeys.length === 0) {
        console.error("❌ No Gemini API Keys found!");
        return null;
    }
    const key = apiKeys[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
    return key.trim();
}

// 4. AI 调用函数
async function callGemini(fullText, triggerWord, userContext) {
    const apiKey = getNextKey();
    if (!apiKey) return [];

    let contextInstruction = "";
    if (userContext && userContext.season) {
        contextInstruction = `Context: The user is designing for ${userContext.season.toUpperCase()}. Prioritize materials/styles suitable for this season.`;
    }

    const prompt = `
        Role: Context-Aware Fashion LSP Engine.
        ${contextInstruction}
        Input Sentence: "${fullText}"
        Focused Trigger Word: "${triggerWord}"
        
        Task: 
        1. Suggest completions for the trigger word.
        2. Treat Pinyin as Chinese.
        3. If the trigger matches a known industry term, suggest it.
        
        Output Format (LSP Standard):
        Return a raw JSON array of objects:
        [{
            "label": "Display Text",
            "insertText": "Text to insert",
            "kind": "Category (材质/造型)",
            "detail": "Short explanation",
            "trigger": "${triggerWord}"
        }]
    `;

    const sendRequest = async (modelId) => {
        console.log(`[AI] Attempting to call model: ${modelId}...`);
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`,
            {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { 
                    responseMimeType: "application/json",
                    temperature: 0.7 
                }
            }
        );
        const rawText = response.data.candidates[0].content.parts[0].text;
        return JSON.parse(rawText.replace(/```json/g, '').replace(/```/g, '').trim());
    };

    try {
        return await sendRequest('gemini-3-pro-preview');
    } catch (err1) {
        console.warn(`⚠️ Gemini 3 failed. Switching to Gemini 2.5...`);
        try {
            return await sendRequest('gemini-2.5-pro');
        } catch (err2) {
            console.error("❌ All AI models failed.");
            return [];
        }
    }
}

// ==========================================
// 🌟 核心修改点：路由名称与前端保持一致
// ==========================================

// 5. 路由：智能补全 (对应前端 /api/suggest)
app.post("/api/suggest", async (req, res) => {  // <--- 修改了这里
    const { text, cursor, context } = req.body;
    const textBeforeCursor = text.slice(0, cursor);
    const words = textBeforeCursor.trim().split(/[\s,，.。]+/);
    const lastWord = words[words.length - 1];

    if (!lastWord) return res.json({ suggestions: [] });

    const cacheKey = `autofill:${lastWord.toLowerCase()}`;

    try {
        if (redis) {
            const cachedResult = await redis.get(cacheKey);
            if (cachedResult) {
                console.log(`[Cache] Hit for "${lastWord}"`);
                return res.json({ suggestions: JSON.parse(cachedResult) });
            }
        }

        console.log(`[AI] Fetching for "${lastWord}"...`);
        const suggestions = await callGemini(textBeforeCursor, lastWord, context);

        if (redis && suggestions.length > 0) {
            await redis.setex(cacheKey, 3600, JSON.stringify(suggestions));
        }

        res.json({ suggestions });

    } catch (error) {
        console.error("Server Error:", error.message);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// 6. 路由：新词入库 (对应前端 /api/validate)
app.post("/api/validate", async (req, res) => { // <--- 修改了这里
    const { word, category } = req.body;
    if (!word || !redis) return res.status(400).json({ error: "Invalid request" });

    try {
        const key = `dict:${word}`;
        await redis.set(key, JSON.stringify({ word, category, addedAt: new Date() }));
        const cacheKey = `autofill:${word.toLowerCase()}`;
        await redis.del(cacheKey);
        res.json({ success: true, message: `Learned: ${word}` });
    } catch (error) {
        res.status(500).json({ error: "Redis Write Failed" });
    }
});

// 7. 首页
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});