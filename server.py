"""WordDeck 後端:上傳單字清單(文字/CSV/圖片/PDF/手寫)→ Gemini 辨識整理成單字對照。

安全模型:每個 /api 端點先驗證 Supabase 使用者 JWT,再擋每人每日額度,才呼叫 Gemini。
資料本身全部存在 Supabase(前端直連),這個後端不碰使用者資料,只做 AI 轉換。
"""

import os
import io
import json

import httpx
import jwt
from fastapi import FastAPI, Depends, HTTPException, Header, UploadFile, File, Form
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from google import genai
from google.genai import types

HERE = os.path.dirname(os.path.abspath(__file__))


def _load_dotenv():
    path = os.path.join(HERE, ".env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


_load_dotenv()

app = FastAPI()


@app.middleware("http")
async def no_store_static(request, call_next):
    """開發時對前端資源一律 no-store,改了程式碼重整就即時生效,不會被瀏覽器快取卡住。"""
    resp = await call_next(request)
    path = request.url.path
    if path == "/" or path.startswith("/static"):
        resp.headers["Cache-Control"] = "no-store, max-age=0"
    return resp


MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"]

JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET", "")
DEV_ALLOW_NO_AUTH = os.environ.get("DEV_ALLOW_NO_AUTH", "").lower() in ("1", "true", "yes")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
# Projects on the new API-key system sign tokens with asymmetric keys; verify
# those via the public JWKS endpoint. Legacy projects use an HS256 shared secret.
_JWKS_URL = f"{SUPABASE_URL}/auth/v1/.well-known/jwks.json" if SUPABASE_URL else ""
_jwk_client = jwt.PyJWKClient(_JWKS_URL) if _JWKS_URL else None
DAILY_EXTRACT_LIMIT = int(os.environ.get("DAILY_EXTRACT_LIMIT", "50"))
MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_MB", "15")) * 1024 * 1024
MAX_PDF_PAGES = int(os.environ.get("MAX_PDF_PAGES", "20"))

ALLOWED_IMAGE_MIME = {"image/png", "image/jpeg", "image/jpg", "image/webp"}


def gemini_keys():
    """所有可用的 Gemini 金鑰(多帳號額度接力)。"""
    raw = []
    multi = os.environ.get("GEMINI_API_KEYS")
    if multi:
        raw += multi.split(",")
    for name in ("GEMINI_API_KEY", "GEMINI_API_KEY_2", "GEMINI_API_KEY_3", "GOOGLE_API_KEY"):
        if os.environ.get(name):
            raw.append(os.environ[name])
    seen, out = set(), []
    for k in (k.strip() for k in raw):
        if k and k not in seen:
            seen.add(k)
            out.append(k)
    return out


def gemini_clients():
    keys = gemini_keys()
    if not keys:
        raise HTTPException(status_code=503, detail="伺服器未設定 Gemini 金鑰")
    return [genai.Client(api_key=k) for k in keys]


def generate_json(clients, *, system, contents, schema, max_retries=6):
    """呼叫 Gemini 要 JSON。限速(429)換金鑰,過載(503)換備援模型並退避。"""
    import time
    if not clients:
        raise HTTPException(status_code=503, detail="沒有可用的 Gemini 金鑰")
    config = types.GenerateContentConfig(
        system_instruction=system,
        response_mime_type="application/json",
        response_schema=schema,
        max_output_tokens=8192,
        thinking_config=types.ThinkingConfig(thinking_budget=0),
    )
    last_err = None
    ki = mi = 0
    for attempt in range(max_retries):
        try:
            resp = clients[ki % len(clients)].models.generate_content(
                model=MODELS[mi % len(MODELS)], contents=contents, config=config)
            if resp.parsed is None:
                # 安全過濾 / 空回應 → 當作可重試一次,否則報錯
                raise ValueError("Gemini 回傳空結果(可能被安全過濾)")
            return resp.parsed
        except Exception as e:
            last_err = e
            msg = str(e)
            if "429" in msg or "RESOURCE_EXHAUSTED" in msg:
                ki += 1
                if ki % len(clients) == 0:
                    mi += 1
                    time.sleep(min(2 ** attempt, 8) + 0.5)
                continue
            if "503" in msg or "UNAVAILABLE" in msg:
                mi += 1
                time.sleep(min(2 ** attempt, 8) + 0.5)
                continue
            raise
    raise last_err


# ---------------- Auth ----------------
class AuthCtx(BaseModel):
    uid: str
    token: str


def require_user(authorization: str = Header(default="")) -> AuthCtx:
    """驗證 Supabase access token。支援 HS256(舊制,需 SUPABASE_JWT_SECRET)與非對稱簽章
    (新制,用專案的 JWKS 公鑰,只需 SUPABASE_URL)。回傳使用者 id 與原始 token(供轉發額度 RPC)。"""
    if DEV_ALLOW_NO_AUTH:
        return AuthCtx(uid="dev-user", token="")

    token = ""
    if authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="需要登入")

    try:
        alg = jwt.get_unverified_header(token).get("alg", "HS256")
        if alg == "HS256":
            if not JWT_SECRET:
                raise HTTPException(status_code=500, detail="此 token 用 HS256,請設定 SUPABASE_JWT_SECRET")
            payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"], audience="authenticated")
        else:
            if not _jwk_client:
                raise HTTPException(status_code=500, detail="需要 SUPABASE_URL 才能驗證此 token")
            key = _jwk_client.get_signing_key_from_jwt(token).key
            payload = jwt.decode(token, key, algorithms=["RS256", "ES256", "EdDSA"], audience="authenticated")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="登入憑證無效或已過期")

    uid = payload.get("sub")
    if not uid:
        raise HTTPException(status_code=401, detail="登入憑證缺少使用者")
    return AuthCtx(uid=uid, token=token)


def consume_quota(ctx: AuthCtx):
    """呼叫 Supabase RPC 扣一次額度;超過就 429。**Fail closed**:額度系統沒配好或連不上
    時,寧可擋下請求(回 503),也不讓合法 token 無限打付費 Gemini。本機開發用
    DEV_ALLOW_NO_AUTH 明確略過。"""
    if DEV_ALLOW_NO_AUTH:
        return  # 本機開發:整條 auth 已略過,額度也一併略過
    if not SUPABASE_URL or not SUPABASE_ANON_KEY or not ctx.token:
        raise HTTPException(status_code=503, detail="額度系統未設定(SUPABASE_URL / ANON_KEY)")
    try:
        r = httpx.post(
            f"{SUPABASE_URL}/rest/v1/rpc/wd_consume_extract_quota",
            headers={
                "apikey": SUPABASE_ANON_KEY,
                "Authorization": f"Bearer {ctx.token}",
                "Content-Type": "application/json",
            },
            json={"p_limit": DAILY_EXTRACT_LIMIT},
            timeout=10,
        )
    except httpx.HTTPError:
        raise HTTPException(status_code=503, detail="額度系統暫時無法使用,稍後再試")
    if r.status_code == 200:
        return
    if "quota exceeded" in (r.text or ""):
        raise HTTPException(status_code=429, detail=f"今天的辨識次數已用完(上限 {DAILY_EXTRACT_LIMIT} 次),明天再來。")
    raise HTTPException(status_code=503, detail="額度系統回應異常,稍後再試")  # fail closed


# ---------------- Schemas ----------------
class ExtractItem(BaseModel):
    english: str
    chinese: str
    ai_filled: bool   # AI 自己補的中文(原文沒有)→ true
    pos: str          # 詞性,不確定就空字串
    example: str      # 例句,沒有就空字串


class ExtractedDeck(BaseModel):
    items: list[ExtractItem]


class DistractorSet(BaseModel):
    i: int
    distractors: list[str]


class SmartDistractors(BaseModel):
    items: list[DistractorSet]


EXTRACT_SYSTEM = (
    "你是英文單字清單整理助手。從輸入(文字、表格、或圖片/PDF,可能含手寫)中抽出所有英文單字或片語,"
    "以及對應的繁體中文意思。規則:"
    "1) 去除重複;修正明顯拼字錯誤。"
    "2) 原文若已經有中文翻譯,直接用它,ai_filled=false。"
    "3) 原文沒有中文的,補上最常用的繁體中文解釋,並把 ai_filled 設為 true。"
    "4) pos 填詞性(n./v./adj. 等),不確定就空字串;example 填一個簡短例句,沒有就空字串。"
    "5) 只輸出真正的英文單字/片語,忽略頁碼、標題、日期等雜訊。"
)


def _extract_from_parts(clients, parts) -> list[dict]:
    parsed = generate_json(clients, system=EXTRACT_SYSTEM, contents=parts, schema=ExtractedDeck)
    return [it.model_dump() for it in parsed.items]


def _dedupe(items: list[dict]) -> list[dict]:
    seen, out = set(), []
    for it in items:
        key = (it["english"].strip().lower(), it["chinese"].strip().lower())
        if it["english"].strip() and key not in seen:
            seen.add(key)
            out.append(it)
    return out


@app.post("/api/extract")
async def api_extract(
    ctx: AuthCtx = Depends(require_user),
    text: str = Form(default=""),
    file: UploadFile = File(default=None),
):
    consume_quota(ctx)
    clients = gemini_clients()

    # ---- 檔案(圖片 / PDF)----
    if file is not None:
        data = await file.read()
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail=f"檔案太大(上限 {MAX_UPLOAD_BYTES // (1024*1024)}MB)")
        mime = (file.content_type or "").lower()

        if mime in ALLOWED_IMAGE_MIME:
            part = types.Part.from_bytes(data=data, mime_type="image/jpeg" if mime == "image/jpg" else mime)
            items = _extract_from_parts(clients, [part])
        elif mime == "application/pdf":
            try:
                import pypdfium2 as pdfium
                pdf = pdfium.PdfDocument(data)
                pages = len(pdf)
            except Exception:
                raise HTTPException(status_code=422, detail="PDF 讀取失敗,檔案可能損壞")
            if pages > MAX_PDF_PAGES:
                raise HTTPException(status_code=413, detail=f"PDF 頁數太多({pages} 頁,上限 {MAX_PDF_PAGES} 頁),請拆開再上傳")
            part = types.Part.from_bytes(data=data, mime_type="application/pdf")
            items = _extract_from_parts(clients, [part])
        else:
            raise HTTPException(status_code=415, detail="只支援 PNG/JPG/WEBP 圖片或 PDF")

    # ---- 純文字 / CSV ----
    elif text.strip():
        lines = [l for l in text.splitlines() if l.strip()]
        items = []
        # 太長就分批,避免輸出被截斷;之後合併去重
        CHUNK = 150
        for i in range(0, len(lines), CHUNK):
            chunk = "\n".join(lines[i:i + CHUNK])
            items += _extract_from_parts(clients, [chunk])
    else:
        raise HTTPException(status_code=400, detail="請提供文字或上傳檔案")

    items = _dedupe(items)
    if not items:
        raise HTTPException(status_code=422, detail="找不到任何英文單字,換一份清楚一點的清單或照片試試")
    return {"items": items}


@app.post("/api/smart-distractors")
def api_smart_distractors(ctx: AuthCtx = Depends(require_user), payload: dict = None):
    """給每個題目產生 3 個似是而非的誘答選項(單字太少或想要更難時才用)。
    payload: { answers: [str], lang: 'zh'|'en' }  answers 是每題的正確答案。"""
    consume_quota(ctx)
    answers = (payload or {}).get("answers") or []
    lang = (payload or {}).get("lang", "zh")
    if not answers:
        raise HTTPException(status_code=400, detail="缺少 answers")
    clients = gemini_clients()
    target = "繁體中文" if lang == "zh" else "英文"
    system = (
        f"你是英文出題老師。下面每一個是選擇題的正確答案({target})。"
        f"為每一題產生 3 個{target}誘答選項:語意相近或容易混淆、但明確錯誤,長度風格與正確答案相似,不可與正確答案相同。"
    )
    listing = "\n".join(f"{idx}. {a}" for idx, a in enumerate(answers))
    parsed = generate_json(clients, system=system, contents=listing, schema=SmartDistractors)
    return {"items": [d.model_dump() for d in parsed.items]}


@app.get("/api/health")
def health():
    return {"ok": True}  # no config details — this endpoint is unauthenticated


# ---------------- Static frontend ----------------
app.mount("/static", StaticFiles(directory=os.path.join(HERE, "static")), name="static")


@app.get("/")
def index():
    return FileResponse(os.path.join(HERE, "index.html"))
