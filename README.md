# 🎨 UI/UX AI Evaluator & Asset Extractor (Figma Plugin)

An intelligent Figma plugin powered by Google Gemini 1.5 Flash that evaluates UI/UX drafts against brand guidelines and extracts high-quality AI prompts for specific design assets.

## 🛠️ System Architecture
1. **Frontend (Figma Plugin):** Captures the design frame and sends it as a Base64 payload.
2. **Backend (Node.js/Express):** Acts as a secure middleware, managing CORS, handling API Keys securely via `.env`, and formatting the request.
3. **AI Core (Gemini 1.5 Flash):** Processes the image and user intent using a highly strict Prompt Engineering architecture, returning a clean, zero-hallucination JSON response.

## 👥 Team & Responsibilities
* **Mina:** Project Management & AI Prompt Engineering (System Architecture, JSON Structuring, Reverse Prompting logic).
* **Hawraa:** Backend Development (Node.js Server, Gemini API Integration, Security).
* **Worood:** Frontend Development (Figma Plugin API, UI Implementation, Dynamic Rendering).
* **Huda:** UI/UX Design (Plugin Wireframing, Prototyping, Visual Identity).