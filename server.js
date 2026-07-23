// ============================================================
//  server.js
//  سيرفر Node.js/Express لمشروع DesignMate AI
//  المهام المنفذة هنا:
//   1) استلام صور Figma (Uint8Array) وتحويلها إلى Base64
//   2) ضبط CORS والـ Headers للسماح لإضافة Figma بالاتصال
//   3) نظام Retry/Timeout عند الاتصال بخدمة الذكاء الاصطناعي
//   4) Session Cache مؤقت (بالذاكرة) باستخدام UUID لكل مستخدم
// ============================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch'); // للاتصال بخدمة Gemini API

// الرابط اللي زودتيني به مباشرة (يتضمن مفتاح الـ API بداخله)
const apiKey = process.env.GEMINI_API_KEY;
const GEMINI_URL =
`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

// System Instruction الثابتة اللي تحدد سلوك النموذج (نفس اللي حددتها ورود لهجة الـ AI Engine)
const SYSTEM_INSTRUCTION = "You are an elite UI/UX Art Director and an Expert AI Prompt Engineer. You will receive Image(s) and a User Message. Analyze the user's message to determine their intent: 'evaluation' OR 'asset_extraction'. CRITICAL RULES: You MUST respond ONLY with a valid JSON object. All feedback MUST be in the exact same language used by the user. LANGUAGE RULE 2: The generated image prompt ('extracted_prompt') MUST ALWAYS be written in highly detailed ENGLISH. PROMPT STRUCTURE RULE: You MUST always position the exact name of the object/asset first, followed directly by its detailed description. JSON SCHEMA EXPECTED: { 'intent': 'evaluation' | 'asset_extraction', 'is_valid_ui': boolean, 'global_message': 'String', 'evaluation_data': { 'confidence_score': number, 'is_matching_brand': boolean, 'errors': [ { 'category': 'Typography | Spacing | Color | Alignment', 'issue': 'String', 'suggestion': 'String' } ] }, 'asset_data': { 'extracted_prompt': 'String (ENGLISH ONLY)', 'target_tool': 'String' } }";

const app = express();
const PORT = 3000;

// ------------------------------------------------------------
// 1) إعدادات CORS والـ Headers
// ------------------------------------------------------------
// إضافات Figma تُرسل الطلبات من بيئة خاصة (null origin أحياناً)
// لذلك نسمح بأي origin هنا، ونحدد الطرق والـ headers المسموحة
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

// نحتاج نسمح باستقبال JSON كبير الحجم لأن الصور Base64 تكبر حجمها ~33%
app.use(express.json({ limit: '15mb' }));

// ------------------------------------------------------------
// 4) Session Cache (بالذاكرة) - يخزن صورة "الهوية البصرية"
// ------------------------------------------------------------
// كل مستخدم له UUID خاص. أول مرة يرفع صورة الهوية، نحفظها هنا
// وبعدها ما يحتاج يرفعها مع كل سؤال جديد.
const sessionCache = new Map();
// شكل كل عنصر: sessionCache.set(userId, { brandKitBase64, createdAt })

// مدة صلاحية الجلسة (مثلاً ساعة واحدة) حتى لا تمتلئ الذاكرة بجلسات قديمة
const SESSION_TTL_MS = 60 * 60 * 1000; // ساعة

function cleanupOldSessions() {
    const now = Date.now();
    for (const [userId, data] of sessionCache.entries()) {
        if (now - data.createdAt > SESSION_TTL_MS) {
            sessionCache.delete(userId);
        }
    }
}
setInterval(cleanupOldSessions, 10 * 60 * 1000); // تنظيف كل 10 دقائق

// ------------------------------------------------------------
// Endpoint: إنشاء جلسة جديدة وحفظ صورة الهوية البصرية
// ------------------------------------------------------------
// الإضافة ترسل صورة الهوية مرة واحدة في البداية
app.post('/session/init', (req, res) => {
    const { imageBase64 } = req.body;

    if (!imageBase64) {
        return res.status(400).json({ error: 'imageBase64 مطلوب' });
    }

    const userId = uuidv4(); // نولّد معرف فريد لهذا المستخدم/الجلسة
    sessionCache.set(userId, {
        brandKitBase64: imageBase64,
        createdAt: Date.now(),
    });

    res.json({ userId, message: 'تم حفظ صورة الهوية البصرية في الجلسة' });
});

// ------------------------------------------------------------
// 2) استلام Buffer (Uint8Array) من Figma وتحويله Base64
// ------------------------------------------------------------
// Figma ترسل بيانات الصورة كمصفوفة بايتات (Array of numbers)
// وليس كنص Base64 جاهز، لذلك نحوّلها هنا يدوياً
function bufferArrayToBase64(byteArray) {
    // byteArray وصل من الإضافة كـ Array عادي (JSON لا يدعم Uint8Array مباشرة)
    const buffer = Buffer.from(byteArray);
    return buffer.toString('base64');
}

// ------------------------------------------------------------
// 3) دالة Retry/Timeout عند الاتصال بخدمة الذكاء الاصطناعي
// ------------------------------------------------------------
// تبني جسم الطلب (Request Body) بالضبط بالشكل اللي يتوقعه Gemini
// userMessage: رسالة المستخدم النصية
// images: مصفوفة صور Base64 (مثلاً: [برند كت، مسودة]) — كل وحدة { mimeType, data }
function buildGeminiPayload(userMessage, images) {
    const imageParts = images.map((img) => ({
        inline_data: {
            mime_type: img.mimeType,
            data: img.data, // Base64 بدون هيدر data:image/...;base64,
        },
    }));

    return {
        system_instruction: {
            parts: [{ text: SYSTEM_INSTRUCTION }],
        },
        contents: [
            {
                parts: [{ text: userMessage }, ...imageParts],
            },
        ],
        generationConfig: {
            response_mime_type: 'application/json',
        },
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

            // النص الراجع من Gemini هو نفسه كود الـ JSON المطلوب (كنص)، فنحوله لكائن حقيقي
            const rawText = data.candidates[0].content.parts[0].text;
            return JSON.parse(rawText); // هذا الكائن هو اللي يترسل لورود (الواجهة الأمامية)
        } catch (err) {
            clearTimeout(timeoutId);
            lastError = err;
            console.warn(`محاولة ${attempt} فشلت: ${err.message}`);

            if (attempt < retries) {
                await new Promise((r) => setTimeout(r, attempt * 1000));
            }
        }
    }

    throw lastError;
}

// ------------------------------------------------------------
// Endpoint الرئيسي: استلام لقطة "مسودة العمل" وتحليلها
// ------------------------------------------------------------
app.post('/analyze', async (req, res) => {
    const { userId, userMessage, imageBytes, mimeType } = req.body;
    // imageBytes: مصفوفة أرقام (Uint8Array محولة لـ Array عبر JSON من الإضافة) - هذي لقطة المسودة
    // userMessage: النص اللي كاتبه المستخدم (مثلاً: "قيمي التصميم" أو "استخرجي هذا العنصر")
    // mimeType: نوع الصورة، افتراضياً image/jpeg أو image/png

    if (!userId || !imageBytes || !userMessage) {
        return res.status(400).json({ error: 'userId و userMessage و imageBytes مطلوبين' });
    }

    const session = sessionCache.get(userId);
    if (!session) {
        return res.status(404).json({
            error: 'لا توجد جلسة لهذا المستخدم. يجب رفع صورة الهوية أولاً عبر /session/init',
        });
    }

    // نحول لقطة المسودة الجديدة إلى Base64
    const draftBase64 = bufferArrayToBase64(imageBytes);
    const finalMimeType = mimeType || 'image/jpeg';

    // نرسل الصورتين لـ Gemini: صورة الهوية البصرية (من الذاكرة) + لقطة المسودة الجديدة
    const images = [
        { mimeType: finalMimeType, data: session.brandKitBase64 },
        { mimeType: finalMimeType, data: draftBase64 },
    ];

    try {
        const result = await callAIServiceWithRetry(userMessage, images, { retries: 3, timeoutMs: 15000 });
        res.json(result); // هذا الكائن يترسل للواجهة الأمامية (ورود) بنفس الشكل المتفق عليه
    } catch (err) {
        console.error('فشل الاتصال بـ Gemini بعد 3 محاولات:', err.message);
        res.status(504).json({
            error: 'تعذر الوصول لخدمة التحليل حالياً، حاول مرة أخرى بعد قليل.',
        });
    }
});

// ------------------------------------------------------------
// Endpoint اختبار بسيط للتأكد أن السيرفر يعمل
// ------------------------------------------------------------
app.get('/', (req, res) => {
    res.send('السيرفر يعمل بنجاح!');
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});