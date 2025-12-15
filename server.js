const express = require("express");
const cors = require("cors");
const axios = require("axios");
require("dotenv").config();
const Redis = require("ioredis");

const app = express();
const PORT = process.env.PORT || 10000;

// 1. 中间件配置
app.use(cors());
app.use(express.json());

// 2. Redis 连接配置
// 即使连接失败，也不会让整个服务器崩溃，而是降级为无缓存模式
let redis;
if (process.env.REDIS_URL) {
    redis = new Redis(process.env.REDIS_URL);
    redis.on("error", (err) => console.error("Redis Error:", err));
    redis.on("connect", () => console.log("✅ Connected to Redis!"));
} else {
    console.warn("⚠️ No REDIS_URL found, running without cache.");
}

// 3. API Key 轮询管理
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

// 4. 核心 AI 调用函数（含自动降级逻辑：3.0 -> 2.5）
async function callGemini(fullText, triggerWord, userContext) {
    const apiKey = getNextKey();
    if (!apiKey) return [];

    // 构建 Prompt
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

    // 通用请求函数
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
        // 清洗 Markdown 标记 (```json ... ```)
        return JSON.parse(rawText.replace(/```json/g, '').replace(/```/g, '').trim());
    };

    // 🚀 双重保险逻辑
    try {
        // 优先级 1: 尝试 Gemini 3 Pro Preview
        return await sendRequest('gemini-3-pro-preview');

    } catch (err1) {
        const status = err1.response ? err1.response.status : 'Unknown';
        console.warn(`⚠️ Gemini 3 failed (Status: ${status}). Switching to Gemini 2.5...`);

        try {
            // 优先级 2: 降级尝试 Gemini 2.5 Pro
            return await sendRequest('gemini-2.5-pro');

        } catch (err2) {
            // 如果都失败了
            console.error("❌ All AI models failed. Please check API Permissions.");
            return []; // 返回空数组防止前端报错
        }
    }
}

// 5. 路由：自动补全 (Get Completion)
app.post("/api/complete", async (req, res) => {
    const { text, cursor, context } = req.body;
    
    // 简单的分词逻辑，找到光标前的最后一个词
    const textBeforeCursor = text.slice(0, cursor);
    const words = textBeforeCursor.trim().split(/[\s,，.。]+/);
    const lastWord = words[words.length - 1];

    if (!lastWord) return res.json({ suggestions: [] });

    const cacheKey = `autofill:${lastWord.toLowerCase()}`;

    try {
        // A. 查缓存 (Redis)
        if (redis) {
            const cachedResult = await redis.get(cacheKey);
            if (cachedResult) {
                console.log(`[Cache] Hit for "${lastWord}"`);
                return res.json({ suggestions: JSON.parse(cachedResult) });
            }
        }

        // B. 缓存未命中，调用 AI
        console.log(`[AI] Fetching for "${lastWord}"...`);
        const suggestions = await callGemini(textBeforeCursor, lastWord, context);

        // C. 存入缓存 (过期时间 1 小时)
        if (redis && suggestions.length > 0) {
            await redis.setex(cacheKey, 3600, JSON.stringify(suggestions));
        }

        res.json({ suggestions });

    } catch (error) {
        console.error("Server Error:", error.message);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

// 6. 路由：新词入库 (Feedback Loop)
app.post("/api/feedback", async (req, res) => {
    const { word, category } = req.body;
    if (!word || !redis) return res.status(400).json({ error: "Invalid request" });

    try {
        // 将新词永久存入 Redis
        const key = `dict:${word}`;
        await redis.set(key, JSON.stringify({ word, category, addedAt: new Date() }));
        console.log(`[Feedback] Learned new word: ${word}`);
        
        // 清除相关缓存，确保下次能搜到
        const cacheKey = `autofill:${word.toLowerCase()}`;
        await redis.del(cacheKey);

        res.json({ success: true, message: `Learned: ${word}` });
    } catch (error) {
        res.status(500).json({ error: "Redis Write Failed" });
    }
});

// 7. 健康检查
app.get("/", (req, res) => {
    res.send("Fashion AI Backend is Running! 🚀 (Model: 3.0 -> 2.5)");
});

// 启动服务
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});