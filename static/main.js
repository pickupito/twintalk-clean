/* static/main.js ─ 2025-05 強化版
   ① TTS 再生時の途切れ防止
   ② detected_language によるプルダウン自動セット
   ③ 音声入力の長文対応 (continuous=true)
   ④ 二重再生防止ロック (ttsBusy)
   ⑤ 翻訳先言語を拡張 (HTML 側)
------------------------------------------------------------------ */

/* ========== 0. DOM ========== */
const chatWin   = document.getElementById("chat-window");
const textInput = document.getElementById("text-input");
const sendBtn   = document.getElementById("send-btn");
const micBtn    = document.getElementById("mic-btn");
const fileInput = document.getElementById("audio-file");
const targetSel = document.getElementById("target-lang");
const clearBtn  = document.getElementById("clear-btn");
const modeBtn   = document.getElementById("mode-toggle");

/* ========== 1. 状態 ========== */
let LOG_KEY;             // 履歴キー ("TwinTalkChatLog-<IP>")
let mode    = "summary"; // "summary" | "original"
let ttsBusy = false;     // TTS が fetch/再生中かどうかロック

/* ========== 2. 起動時に IP 取得 → LOG_KEY 確定 ========== */
(async () => {
  try {
    const { ip } = await (await fetch("/whoami")).json();
    LOG_KEY = `TwinTalkChatLog-${ip}`;
  } catch {
    LOG_KEY = "TwinTalkChatLog-unknown";
  }
  restoreLog();
  updateModeUI();
  keepFocus();
})();

/* ========== 3. ユーティリティ ========== */
function keepFocus() {
  textInput.focus({ preventScroll: true });
}

function appendLog(entry) {
  const log = JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
  log.push(entry);
  localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(-200)));
}
function restoreLog() {
  const log = JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
  for (const e of log) {
    if (e.role === "user") addUserBubble(e.text, true);
    else                  addAiBubble(e.data, true);
  }
}

/* ========== 4. 吹き出し生成 ========== */
function addUserBubble(text, fromLog = false) {
  const d = document.createElement("div");
  d.className = "bubble user";
  d.textContent = text;
  chatWin.append(d);
  chatWin.scrollTop = chatWin.scrollHeight;
  if (!fromLog) appendLog({ role: "user", text });
}

function addAiBubble(obj, fromLog = false) {
  const d = document.createElement("div");
  d.className = "bubble ai";
  const label = (mode === "original") ? "原文" : "要約";
  let html = `${label}: ${obj.summarized_text}<br>`;

  const trans = obj.target_text || (obj.detected_language !== "ja" ? obj.ja_text : "");
  if (trans) {
    if (obj.speak_target) {
      html += `<div class="translation">訳文: ${trans}
                 <button class="speaker" data-speak="${encodeURIComponent(obj.speak_target)}">
                   <span class="material-icons-outlined">campaign</span>
                 </button></div>`;
    } else {
      html += `<div class="translation">訳文: ${trans}</div>`;
    }
  }
  d.innerHTML = html;
  chatWin.append(d);
  chatWin.scrollTop = chatWin.scrollHeight;

  // ★ 変更②：日本語以外がdetectedされた場合、その言語をプルダウンにセット
  if (!fromLog && obj.detected_language && obj.detected_language !== "ja") {
    targetSel.value = obj.detected_language;
  }

  if (!fromLog) appendLog({ role: "ai", data: obj });
}

/* ========== 5. TTS (二重再生防止 & 再生途切れ防止) ========== */
let currAudio = null;
async function playTTS(txt, btn) {
  if (!txt || ttsBusy) return; // 二重起動防止

  ttsBusy = true;
  toggleSpeakers(true); // 全スピーカーボタン無効化

  try {
    const r = await fetch("/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: txt })
    });
    if (!r.ok) throw new Error("TTS Error");

    const url = URL.createObjectURL(await r.blob());
    currAudio = new Audio(url);
    btn.classList.add("playing");

    // ★ 変更①: load して canplaythrough 待機し、再生途切れを防止
    currAudio.load();
    currAudio.oncanplaythrough = () => {
      currAudio.play();
    };

    currAudio.onended = () => {
      URL.revokeObjectURL(url);
      currAudio = null;
      btn.classList.remove("playing");
      toggleSpeakers(false);
      ttsBusy = false;
    };
  } catch (e) {
    alert(e.message || e);
    toggleSpeakers(false);
    ttsBusy = false;
  }
}

function toggleSpeakers(disabled) {
  document.querySelectorAll(".speaker").forEach(b => {
    b.disabled = disabled;
  });
}

chatWin.onclick = e => {
  const btn = e.target.closest(".speaker");
  if (btn) {
    const txt = decodeURIComponent(btn.dataset.speak || "");
    playTTS(txt, btn);
  }
};

/* ========== 6. メッセージ送信 ========== */
async function sendText(text) {
  if (!text) return;
  addUserBubble(text);

  const fd = new FormData();
  fd.append("text_input", text);
  fd.append("target_lang", targetSel.value);
  fd.append("mode", mode);

  const res  = await fetch("/transcribe_and_summarize", { method: "POST", body: fd });
  const data = await res.json();
  if (data.error) alert(data.error);
  else           addAiBubble(data);
}

sendBtn.onclick = () => {
  const txt = textInput.value.trim();
  textInput.value = "";
  sendText(txt);
  keepFocus();
};

textInput.onkeydown = e => {
  // Enterキー押下で送信
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
};

/* ========== 7. ファイルアップロード ========== */
fileInput.onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;

  const fd = new FormData();
  fd.append("audio_file", f);
  fd.append("target_lang", targetSel.value);
  fd.append("mode", mode);

  const res = await fetch("/transcribe_and_summarize", { method: "POST", body: fd });
  const data = await res.json();
  if (data.error) alert(data.error);
  else           addAiBubble(data);

  fileInput.value = "";
  keepFocus();
};

/* ========== 8. クリア / モード切替 ========== */
clearBtn.onclick = () => {
  if (confirm("チャット履歴をクリアしますか？")) {
    chatWin.innerHTML = "";
    localStorage.removeItem(LOG_KEY);
  }
  keepFocus();
};

modeBtn.onclick = () => {
  mode = (mode === "summary") ? "original" : "summary";
  updateModeUI();
  keepFocus();
};

function updateModeUI() {
  document.body.classList.toggle("original-mode", mode === "original");
}

/* ========== 9. 音声入力 (Web Speech → Whisper fallback) ========== */
const SRSupported  = ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);
const RecSupported = navigator.mediaDevices?.getUserMedia && window.MediaRecorder;

let recognizer = null;
if (SRSupported) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognizer = new SR();
  recognizer.lang = "ja-JP";
  recognizer.interimResults = true;

  // ★ 変更③: 長文対応
  recognizer.continuous = true;

  recognizer.onresult = e => {
    // interimResults=true + continuous=true なので、
    // 全結果を結合すれば長めの文も取り込める
    let fullText = "";
    for (let i = 0; i < e.results.length; i++) {
      fullText += e.results[i][0].transcript;
    }
    textInput.value = fullText.trim();
  };

  recognizer.onend = () => {
    // ボタン表示を通常に戻す
    micBtn.classList.remove("mic-recording");
    // 連続再開するなら:
    // if (micBtn.classList.contains("mic-recording")) {
    //   recognizer.start();
    // }
  };
}

let mediaRec = null;
let recChunks = [];

micBtn.onclick = async () => {
  // Web Speech API 優先
  if (SRSupported) {
    if (micBtn.classList.contains("mic-recording")) {
      // 停止
      recognizer.stop();
      micBtn.classList.remove("mic-recording");
    } else {
      // 開始
      textInput.value = "";
      recognizer.start();
      micBtn.classList.add("mic-recording");
    }
    keepFocus();
    return;
  }

  // Fallback: MediaRecorder + Whisper
  if (RecSupported) {
    if (mediaRec && mediaRec.state === "recording") {
      mediaRec.stop();
      micBtn.classList.remove("mic-recording");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRec = new MediaRecorder(stream, { mimeType: "audio/webm" });
      recChunks = [];
      mediaRec.ondataavailable = e => recChunks.push(e.data);
      mediaRec.onstop = () => {
        const blob = new Blob(recChunks, { type: "audio/webm" });
        sendAudioBlob(blob);
        stream.getTracks().forEach(t => t.stop());
      };
      mediaRec.start();
      micBtn.classList.add("mic-recording");
    } catch (e) {
      alert("マイクが使用できません: " + e.message);
    }
    keepFocus();
  }
};

async function sendAudioBlob(blob) {
  addUserBubble("🎤 音声を送信中…");
  const fd = new FormData();
  fd.append("audio_file", blob, "speech.webm");
  fd.append("target_lang", targetSel.value);
  fd.append("mode", mode);

  const res = await fetch("/transcribe_and_summarize", { method: "POST", body: fd });
  const data = await res.json();
  // チャット末尾の仮メッセージを削除
  chatWin.lastChild.remove();
  if (data.error) alert(data.error);
  else           addAiBubble(data);
}
