# 🔍 FactCheck AI – Browser Extension + ML Backend

Real-time fact-checking using Google FactCheck API (primary) + RoBERTa ML model (fallback).

---

## 📁 Project Structure

```
factcheck-extension/
├── backend/
│   ├── app.py               ← FastAPI server
│   ├── requirements.txt
│   ├── start_backend.sh     ← One-click launcher
│   └── factcheck-model/     ← ⬅ PUT YOUR MODEL HERE
│       ├── config.json
│       ├── pytorch_model.bin (or model.safetensors)
│       └── tokenizer files…
└── extension/
    ├── manifest.json
    ├── background.js        ← Pipeline logic
    ├── popup.html / popup.js
    ├── content.js
    └── icons/               ← ⬅ Add icon PNGs here
```

---

## 🚀 Setup (3 steps)

### Step 1 — Place your trained model

Copy your downloaded `factcheck-model` folder into `backend/`:

```
backend/factcheck-model/
```

### Step 2 — Start the ML backend

```bash
cd backend
chmod +x start_backend.sh
./start_backend.sh
```

Server starts at **http://localhost:8000**  
Test it: http://localhost:8000/health

### Step 3 — Load the Chrome extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder

---

## 🔑 Add your Google API Key

Open `extension/background.js` and replace line 8:

```js
const GOOGLE_API_KEY = "YOUR_GOOGLE_FACTCHECK_API_KEY";
```

Get a free key at: https://developers.google.com/fact-check/tools/api/reference/rest

---

## 🎯 How to Use

| Method | How |
|--------|-----|
| **Popup** | Click extension icon → type/paste claim → press CHECK CLAIM |
| **Right-click** | Select text on any page → right-click → "FactCheck this" |
| **Screenshot** | Click extension icon → Upload Image → OCR extracts text automatically |

---

## 🏗️ Pipeline

```
User Input
    ↓
Google FactCheck API   ← fast, high accuracy for known claims
    ↓ (not found)
RoBERTa ML Model       ← handles new/unseen claims
    ↓
Display verdict in popup
```

---

## 📡 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Health check |
| `/health` | GET | Status + model info |
| `/predict` | POST | Run ML prediction |

**Example request:**
```bash
curl -X POST http://localhost:8000/predict \
  -H "Content-Type: application/json" \
  -d '{"text": "The earth is flat"}'
```

**Example response:**
```json
{
  "prediction": "False",
  "confidence": 0.81,
  "probabilities": {"False": 0.81, "Mixed": 0.12, "True": 0.07},
  "source": "AI Model"
}
```

---

## 🖼️ Icons

Add PNG icons to `extension/icons/`:
- `icon16.png` (16×16)
- `icon48.png` (48×48)  
- `icon128.png` (128×128)

Quick option — generate placeholders with Python:
```python
from PIL import Image, ImageDraw
for size in [16, 48, 128]:
    img = Image.new("RGBA", (size, size), (91, 91, 255, 255))
    img.save(f"extension/icons/icon{size}.png")
```

---

## ⚙️ Custom Model Path

If your model is stored elsewhere:
```bash
./start_backend.sh /path/to/your/factcheck-model
# or
MODEL_PATH=/path/to/model uvicorn app:app --port 8000
```
