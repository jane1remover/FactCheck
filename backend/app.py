from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from transformers import AutoTokenizer, AutoModelForSequenceClassification
import torch
import os

app = FastAPI(title="FactCheck ML API", version="1.0.0")

# Allow requests from browser extension
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Chrome extensions use chrome-extension:// origin
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Load model once at startup ──────────────────────────────────────────────
MODEL_PATH = os.getenv("MODEL_PATH", "./factcheck-model")

print(f"[FactCheck] Loading model from: {MODEL_PATH}")
try:
    tokenizer = AutoTokenizer.from_pretrained(MODEL_PATH)
    model = AutoModelForSequenceClassification.from_pretrained(MODEL_PATH)
    model.eval()
    print("[FactCheck] ✅ Model loaded successfully")
except Exception as e:
    print(f"[FactCheck] ❌ Failed to load model: {e}")
    raise RuntimeError(f"Model not found at {MODEL_PATH}. Check MODEL_PATH env var.")

LABELS = ["False", "Mixed", "True"]
CONFIDENCE_THRESHOLD = 0.50  # below this → "Uncertain"


class PredictRequest(BaseModel):
    text: str


class PredictResponse(BaseModel):
    prediction: str          # "True" | "False" | "Mixed" | "Uncertain"
    confidence: float        # 0.0 – 1.0
    probabilities: dict      # {"False": x, "Mixed": y, "True": z}
    source: str              # always "AI Model"


@app.get("/")
def root():
    return {"status": "ok", "message": "FactCheck ML API is running"}


@app.get("/health")
def health():
    return {"status": "healthy", "model_loaded": True}


@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest):
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text field cannot be empty")
    if len(text) > 2000:
        text = text[:2000]  # Truncate very long inputs

    try:
        # BUG 8 FIX: 64 tokens silently truncated most claims. 128 is a safe minimum for RoBERTa.
        inputs = tokenizer(
            text,
            return_tensors="pt",
            truncation=True,
            max_length=128,
            padding=True
        )

        with torch.no_grad():
            outputs = model(**inputs)

        probs = torch.softmax(outputs.logits, dim=1)[0]
        pred_idx = torch.argmax(probs).item()
        confidence = probs[pred_idx].item()

        probabilities = {LABELS[i]: round(probs[i].item(), 4) for i in range(len(LABELS))}
        prediction = LABELS[pred_idx] if confidence >= CONFIDENCE_THRESHOLD else "Uncertain"

        return PredictResponse(
            prediction=prediction,
            confidence=round(confidence, 4),
            probabilities=probabilities,
            source="AI Model"
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Prediction failed: {str(e)}")
