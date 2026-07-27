require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');

const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error('❌ CRITICAL ERROR: GEMINI_API_KEY is missing from environment variables. The server will not be able to reach the Gemini API.');
}

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

const SYSTEM_INSTRUCTION = "You are an elite UI/UX Art Director and an Expert AI Prompt Engineer. You will receive Image(s) and a User Message. Analyze the user's message to determine their intent: 'evaluation' OR 'asset_extraction'. CRITICAL RULES: You MUST respond ONLY with a valid JSON object. All feedback MUST be in the exact same language used by the user. LANGUAGE RULE 2: The generated image prompt ('extracted_prompt') MUST ALWAYS be written in highly detailed ENGLISH. PROMPT STRUCTURE RULE: You MUST always position the exact name of the object/asset first, followed directly by its detailed description. JSON SCHEMA EXPECTED: { 'intent': 'evaluation' | 'asset_extraction', 'is_valid_ui': boolean, 'global_message': 'String', 'evaluation_data': { 'confidence_score': number, 'is_matching_brand': boolean, 'errors': [ { 'category': 'Typography | Spacing | Color | Alignment', 'issue': 'String', 'suggestion': 'String' } ] }, 'asset_data': { 'extracted_prompt': 'String (ENGLISH ONLY)', 'target_tool': 'String' } }";

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- CORS ----------
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ---------- Payload limits ----------
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// ---------- Session cache ----------
const sessionCache = new Map();
const SESSION_TTL_MS = 60 * 60 * 1000;

function cleanupOldSessions() {
  const now = Date.now();
  for (const [userId, data] of sessionCache.entries()) {
    if (now - data.createdAt > SESSION_TTL_MS) {
      sessionCache.delete(userId);
    }
  }
}
setInterval(cleanupOldSessions, 10 * 60 * 1000);

// ---------- /session/init ----------
app.post('/session/init', (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: 'imageBase64 is required' });
    }
    const userId = uuidv4();
    sessionCache.set(userId, { brandKitBase64: imageBase64, createdAt: Date.now() });
    res.json({ userId, message: 'Brand kit image saved to session' });
  } catch (err) {
    console.error('Error in /session/init:', err.message);
    res.status(500).json({ error: 'Internal server error while initializing session.' });
  }
});

function bufferArrayToBase64(byteArray) {
  const buffer = Buffer.from(byteArray);
  return buffer.toString('base64');
}

function buildGeminiPayload(userMessage, images) {
  const imageParts = images.map((img) => ({
    inline_data: { mime_type: img.mimeType, data: img.data },
  }));
  return {
    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ parts: [{ text: userMessage }, ...imageParts] }],
    generationConfig: { response_mime_type: 'application/json' },
  };
}

async function callAIServiceWithRetry(userMessage, images, { retries = 3, timeoutMs = 15000 } = {}) {
  const payload = buildGeminiPayload(userMessage, images);
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API responded with status ${response.status}: ${errText}`);
      }
      const data = await response.json();
      const rawText = data.candidates[0].content.parts[0].text;
      return JSON.parse(rawText);
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err;
      console.warn(`Attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, attempt * 1000));
      }
    }
  }
  throw lastError;
}

// ---------- /analyze ----------
app.post('/analyze', async (req, res) => {
  try {
    const { userId, userMessage, imageBytes, mimeType } = req.body;
    if (!userId || !imageBytes || !userMessage) {
      return res.status(400).json({ error: 'userId, userMessage and imageBytes are required' });
    }
    if (!apiKey) {
      return res.status(503).json({ error: 'Server misconfiguration: GEMINI_API_KEY is not set.' });
    }
    const session = sessionCache.get(userId);
    if (!session) {
      return res.status(404).json({
        error: 'No session found for this user. Upload the brand kit image first via /session/init',
      });
    }
    const draftBase64 = bufferArrayToBase64(imageBytes);
    const finalMimeType = mimeType || 'image/jpeg';
    const images = [
      { mimeType: finalMimeType, data: session.brandKitBase64 },
      { mimeType: finalMimeType, data: draftBase64 },
    ];
    const result = await callAIServiceWithRetry(userMessage, images, { retries: 3, timeoutMs: 15000 });
    res.json(result);
  } catch (err) {
    console.error('Error in /analyze:', err.message);
    res.status(504).json({
      error: 'Could not reach the analysis service right now, please try again shortly.',
    });
  }
});

app.get('/', (req, res) => {
  res.send('Server is running successfully!');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});