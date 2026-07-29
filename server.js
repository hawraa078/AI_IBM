require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) console.error('❌  GEMINI_API_KEY missing from .env — /analyze will fail.');

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;

const SYSTEM_INSTRUCTION = `
You are DesignMate — Senior Design Director inside Figma.
Expertise: Color Theory, Typography, Spacing Systems, WCAG Accessibility, Design Tokens, Component Architecture, Figma Features (Auto Layout, Variants, Variables, Components).

CAPABILITIES:
- Design audit: contrast, spacing, hierarchy, consistency
- Generate: color palettes, type scales, spacing scales, design tokens (JSON/CSS/Figma Variables)
- Advice: naming conventions, design system governance, component APIs
- Code: Figma plugin snippets, CSS, TypeScript
- Context-aware: references user's saved folders (colors/fonts) by name

PERSONA: Concise, practical, opinionated but flexible. Arabic-first, matches user language.

RESPONSE FORMAT (JSON):
{
  "responseType": "chat" | "audit" | "tokens" | "code",
  "message": "string (markdown, Arabic default)",
  "data": {}
}

CONTEXT INJECTED PER REQUEST:
- userMessage: string
- imageBase64: selected layer PNG (may be absent)
- userFolders: {colors: [...], fonts: [...]} from clientStorage
- brandKitBase64?: optional brand reference image
`;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Session cache
const sessionCache = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessionCache) if (now - v.createdAt > 3_600_000) sessionCache.delete(k);
}, 600_000);

app.post('/session/init', (req, res) => {
  const { imageBase64 } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
  const userId = uuidv4();
  sessionCache.set(userId, { brandKitBase64: imageBase64, createdAt: Date.now() });
  res.json({ userId, message: 'Brand kit saved' });
});

function buildPayload(userMessage, images) {
  return {
    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ parts: [{ text: userMessage }, ...images.map(img => ({ inline_data: { mime_type: img.mimeType, data: img.data } }))] }],
    generationConfig: { temperature: 0.7 },
  };
}

async function callGemini(userMessage, images, retries = 3) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      // node-fetch v2 + Node v24: use a race-based timeout instead of AbortController
      const fetchPromise = fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload(userMessage, images)),
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Gemini request timed out after 45s')), 45_000)
      );
      const res = await Promise.race([fetchPromise, timeoutPromise]);
      if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
      const json = await res.json();
      const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) throw new Error('Empty Gemini response');
      // Strip markdown fences if present: ```json ... ```
      const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      try { return JSON.parse(stripped); } catch { return { responseType: 'chat', message: raw, data: {} }; }
    } catch (err) {
      lastErr = err;
      console.warn(`Attempt ${i} failed: ${err.message}`);
      if (i < retries) await new Promise(r => setTimeout(r, i * 1200));
    }
  }
  throw lastErr;
}

app.post('/analyze', async (req, res) => {
  try {
    const { prompt, image, userId, userFolders } = req.body;
    if (!prompt?.trim()) return res.status(400).json({ error: '`prompt` is required.' });
    if (!apiKey) return res.status(503).json({ error: 'GEMINI_API_KEY not configured on server.' });

    // Build enriched prompt with folder context
    let enrichedPrompt = prompt.trim();
    if (userFolders && (userFolders.colors?.length || userFolders.fonts?.length)) {
      const folderSummary = JSON.stringify(userFolders, null, 2);
      enrichedPrompt += `\n\n[User Saved Folders Context]\n${folderSummary}`;
    }

    const images = [];
    if (image) images.push({ mimeType: 'image/png', data: image });
    // Optionally prepend brand kit image if session exists
    if (userId && sessionCache.has(userId)) {
      images.unshift({ mimeType: 'image/png', data: sessionCache.get(userId).brandKitBase64 });
    }

    const result = await callGemini(enrichedPrompt, images);

    // Normalise: if Gemini returned a plain string, wrap it
    if (typeof result === 'string') {
      return res.json({ responseType: 'chat', message: result, data: {} });
    }
    // If old schema slipped through, normalise to new schema
    if (result.global_message && !result.message) {
      result.message = result.global_message;
      result.responseType = result.responseType || 'chat';
      result.data = result.data || {};
    }
    res.json(result);
  } catch (err) {
    console.error('/analyze error:', err.message);
    res.status(504).json({ error: 'Could not reach the analysis service. Please try again.' });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/', (_, res) => res.send('DesignMate AI backend is running ✅'));

app.listen(PORT, () => console.log(`✅  DesignMate AI server running on http://localhost:${PORT}`));