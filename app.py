#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Flask + GPT (要約 / 翻訳) + Whisper (音声認識) + OpenAI TTS
LINE 風チャット UI 用バックエンド
────────────────────────────────────────────
■ 主なエンドポイント
  GET  /                 … チャット UI
  GET  /whoami           … クライアント IP を返す (履歴キー分離用)
  POST /transcribe_and_summarize
       · text_input      … テキスト入力
       · audio_file      … 音声ファイル (webm/mp3 など)
       · mode            … "summary" | "original"
       · target_lang     … 任意翻訳先
  POST /tts              … 文字列 → mp3
────────────────────────────────────────────
"""

import os
import re
import io
import json
import tempfile
from datetime import datetime
from pathlib import Path

from flask import Flask, render_template, request, jsonify, send_file
from dotenv import load_dotenv
import httpx
from openai import OpenAI

# ───────────────────────────────────────────
# ① ログ設定
# ───────────────────────────────────────────
ROOT     = Path(__file__).resolve().parent
LOG_DIR  = ROOT / "log"
LOG_FILE = LOG_DIR / "app.log"
LOG_DIR.mkdir(exist_ok=True)

def log_event(action: str, info: str = "") -> None:
    """簡易ファイルログ"""
    ts  = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    ip  = request.remote_addr or "unknown"
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"{ts} | IP={ip} | {action} | {info}\n")

# ───────────────────────────────────────────
# ② OpenAI 初期化
# ───────────────────────────────────────────
load_dotenv(ROOT / "openai.env")
API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
if not API_KEY:
    raise RuntimeError("OPENAI_API_KEY が openai.env に設定されていません")

client = OpenAI(
    api_key     = API_KEY,
    http_client = httpx.Client(timeout=httpx.Timeout(60.0))
)

WHISPER_MODEL = "gpt-4o-mini-audio-preview"   # ご利用の Whisper
TTS_MODEL     = "tts-1"                       # ご利用の TTS
GPT_MODEL     = "gpt-4o"                      # ご利用の ChatGPT

# ───────────────────────────────────────────
# ③ PROMPTS（要約モード / 原文モード）
# ───────────────────────────────────────────
SUMMARY_PROMPT = r"""
You are **“Twin-Talk Concierge”** – a real-time summariser & polite translator for customer-service chats.
YOU ARE *NOT* A QUESTION-ANSWERING BOT.

───────── HARD RULES ─────────
1. ❌ Never answer questions, never add facts or opinions.
2. ✅ Compress the user message into ≤2 sentences **without altering meaning**.
3. ✅ If the language is not Japanese, also output a Japanese summary (ja_text); otherwise ja_text = "".
4. If target_lang is provided:
      – If user's language is Japanese → translate Japanese → target_lang.
      – Else → translate user's language → Japanese.
      – Put result into target_text & speak_target.
      – If the result is Japanese, speak_target = "".
5. summarized_text is always in the original language (summarised).
6. speak_original = summarized_text.
7. No markdown, no code blocks. Entire output ≤1000 characters.
8. Output **only** the JSON shown below – same keys & order.
9. Unused fields = "" (never null).

{
  "detected_language": "<ISO-639-1>",
  "original_text":     "<copy of input>",
  "summarized_text":   "<summary>",
  "ja_text":           "<Japanese summary or empty>",
  "target_text":       "<translation or empty>",
  "speak_original":    "<same as summarized_text>",
  "speak_target":      "<same as target_text or empty>"
}
"""

ORIGINAL_PROMPT = r"""
You are **“Twin-Talk Translator”** – a real-time verbatim translator for customer-service chats.
YOU ARE *NOT* A QUESTION-ANSWERING BOT.

───────── HARD RULES ─────────
1. summarized_text must equal the original input verbatim (no summarisation).
2. If language is not Japanese → ja_text = Japanese translation; else ja_text = "".
3. If target_lang is provided:
      – If user's language is Japanese → translate Japanese → target_lang.
      – Else → translate user's language → Japanese.
      – Put result into target_text & speak_target.
      – If result is Japanese, speak_target = "".
4. speak_original = summarized_text.
5. No markdown, no code blocks. ≤1000 chars.
6. Output exactly:
{
  "detected_language": "<ISO-639-1>",
  "original_text":     "<verbatim copy>",
  "summarized_text":   "<same as input>",
  "ja_text":           "<Japanese or empty>",
  "target_text":       "<translation or empty>",
  "speak_original":    "<same as summarized_text>",
  "speak_target":      "<same as target_text or empty>"
}
"""

# ───────────────────────────────────────────
# ④ Flask アプリ
# ───────────────────────────────────────────
app = Flask(
    __name__,
    template_folder = ROOT / "templates",
    static_folder   = ROOT / "static"
)

# ----- 4-1 ホーム (UI) -----
@app.route("/")
def index():
    log_event("VIEW", "/")
    return render_template("index.html")

# ----- 4-2 自分の IP 返却 (履歴キー分離用) -----
@app.route("/whoami")
def whoami():
    return jsonify({"ip": request.remote_addr or "unknown"})

# ----- 4-3 文字起こし + 要約 / 翻訳 -----
@app.route("/transcribe_and_summarize", methods=["POST"])
def transcribe_and_summarize():
    mode        = request.form.get("mode", "summary")
    target_lang = request.form.get("target_lang", "").strip()
    text_input  = request.form.get("text_input", "").strip()
    audio_file  = request.files.get("audio_file")

    # 1) Whisper (音声→テキスト)
    if audio_file and audio_file.filename:
        try:
            buf = io.BytesIO(audio_file.read()); buf.name = audio_file.filename
            user_text = client.audio.transcriptions.create(
                model=WHISPER_MODEL, file=buf, response_format="text"
            ).strip()
        except Exception as e:
            log_event("WHISPER_ERR", str(e))
            return jsonify({"error": f"Whisper error: {e}"}), 500
    else:
        user_text = text_input

    if not user_text:
        return jsonify({"error": "No input"}), 400

    log_event("INPUT", user_text[:60])

    # 2) GPT
    prompt = SUMMARY_PROMPT if mode == "summary" else ORIGINAL_PROMPT
    try:
        resp = client.chat.completions.create(
            model     = GPT_MODEL,
            messages  = [
                {"role":"system","content": prompt},
                {"role":"user","content": json.dumps(
                    {"text": user_text, "target_lang": target_lang},
                    ensure_ascii=False)}
            ],
            temperature = 0
        )
        data = _extract_json(resp.choices[0].message.content)
        return jsonify(data)
    except Exception as e:
        log_event("GPT_ERR", str(e))
        return jsonify({"error": str(e)}), 500

# ----- 4-4 TTS -----
@app.route("/tts", methods=["POST"])
def tts():
    text = (request.json.get("text") or "").strip()
    if not text:           return jsonify({"error":"empty text"}), 400
    if len(text) > 4000:   return jsonify({"error":"too long"}),   400
    try:
        speech = client.audio.speech.create(
            model  = TTS_MODEL,
            voice  = "alloy",
            input  = text,
            format = "mp3"
        )
    except TypeError:      # 古い SDK 互換
        speech = client.audio.speech.create(model=TTS_MODEL, voice="alloy", input=text)

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".mp3")
    tmp.write(speech.read()); tmp.flush(); tmp.seek(0)
    return send_file(tmp.name, mimetype="audio/mpeg")

# --- 共通：GPT JSON 部分抽出 ---
def _extract_json(content: str) -> dict:
    m = re.search(r"\{.*\}", content, re.S)
    if not m: raise ValueError("JSON not found in GPT response")
    return json.loads(m.group(0))

# --- エントリポイント ---
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
