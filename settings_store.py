"""AutoShortsCut settings: one JSON file the dashboard's Settings page edits.

Holds the provider API keys, the clip-picking model chain (tried in order,
each with an optional spending budget), transcription, clip, subtitle, hook,
YouTube and download defaults. ``child_env`` turns it into the environment
every job process gets; ``spend`` keeps what each chain entry has cost so far
this period so budgets can be enforced.

Keys never leave the server in full: ``public()`` masks them.
"""
import copy
import json
import os
import threading
import time
import uuid

_HERE = os.path.dirname(os.path.abspath(__file__))
SETTINGS_PATH = os.environ.get("LOCAL_SETTINGS_PATH") or os.path.join(_HERE, "local_settings.json")
SPEND_PATH = os.environ.get("LLM_SPEND_PATH") or os.path.join(
    os.path.dirname(SETTINGS_PATH), "llm_spend.json")
_lock = threading.RLock()

# Every provider speaks the OpenAI chat-completions API at this base URL.
PROVIDERS = {
    "anthropic": {"label": "Anthropic (Claude)", "base_url": "https://api.anthropic.com/v1",
                  "key_url": "https://console.anthropic.com/settings/keys"},
    "gemini": {"label": "Google Gemini", "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
               "key_url": "https://aistudio.google.com/app/apikey"},
    "groq": {"label": "Groq", "base_url": "https://api.groq.com/openai/v1",
             "key_url": "https://console.groq.com/keys"},
    "openai": {"label": "OpenAI", "base_url": "https://api.openai.com/v1",
               "key_url": "https://platform.openai.com/api-keys"},
    "openrouter": {"label": "OpenRouter", "base_url": "https://openrouter.ai/api/v1",
                   "key_url": "https://openrouter.ai/keys"},
    "custom": {"label": "Custom / local (Ollama, LM Studio)", "base_url": "http://localhost:11434/v1",
               "key_url": None},
}

# USD per million tokens, known models only; anything else is entered by hand.
KNOWN_PRICES = {
    "claude-sonnet-5-5": (2.00, 10.00),
    "claude-sonnet-5": (2.00, 10.00),
    "claude-opus-5-5": (4.00, 20.00),
    "claude-haiku-5-5": (0.10, 0.50),
}

DEFAULTS = {
    "version": 1,
    "providers": {name: {"key": "", **({"base_url": p["base_url"]} if name == "custom" else {})}
                  for name, p in PROVIDERS.items()},
    "llm_chain": [],
    "transcription": {
        "mode": "auto",                  # auto (groq, then local) | groq | whisper
        "groq_model": "whisper-large-v3",
        "local_model": "large-v3",
        "language": "",                  # "" = detect
        "glossary": "",                  # names/terms, one per line or comma separated
    },
    "clips": {"min_seconds": 15, "max_seconds": 60, "count_min": None, "count_max": None},
    "subtitle_defaults": {
        "style": "karaoke", "position": "bottom", "font_name": "Montserrat ExtraBold",
        "font_size": 44, "font_color": "#FFFFFF", "highlight_color": "#FFE500",
        "border_color": "#000000", "border_width": 4, "effect": "pop",
        "base_opacity": 1.0, "uppercase": True, "max_chars": 16, "max_duration": 1.4,
    },
    "hook_defaults": {"style": "pill", "font": "montserrat", "scale": 1.0,
                      "position": "auto", "duration_seconds": 5},
    "youtube": {
        "privacy": "private", "category": "28", "tags": "",
        "description_template": "{description}\n\nПовне відео: {source_url}\n\n#Shorts",
        "default_time": "18:00", "timezone": "Europe/Kyiv", "cadence": "daily",
    },
    "download": {"youtube_cookies": ""},
}


def _merge(base, extra):
    out = copy.deepcopy(base)
    for k, v in (extra or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def _seed_from_env(data):
    """First run: bring the .env setup over so nothing stops working."""
    env = os.environ
    base = (env.get("LLM_BASE_URL") or "").rstrip("/")
    key = env.get("LLM_API_KEY") or ""
    provider = next((n for n, p in PROVIDERS.items() if p["base_url"] == base), "custom" if base else None)
    if provider and key and not data["providers"][provider]["key"]:
        data["providers"][provider]["key"] = key
        if provider == "custom":
            data["providers"]["custom"]["base_url"] = base
    if env.get("GROQ_API_KEY") and not data["providers"]["groq"]["key"]:
        data["providers"]["groq"]["key"] = env["GROQ_API_KEY"]
    if env.get("GEMINI_API_KEY") and not data["providers"]["gemini"]["key"]:
        data["providers"]["gemini"]["key"] = env["GEMINI_API_KEY"]
    if not data["llm_chain"] and provider:
        model = env.get("LLM_MODEL") or "claude-sonnet-5-5"
        p_in, p_out = KNOWN_PRICES.get(model, (0.0, 0.0))
        data["llm_chain"] = [new_chain_entry(provider, model, price_in=p_in, price_out=p_out)]
    if env.get("TRANSCRIBE_BACKEND") in ("auto", "groq", "whisper"):
        data["transcription"]["mode"] = env["TRANSCRIBE_BACKEND"]
    if env.get("WHISPER_MODEL"):
        data["transcription"]["local_model"] = env["WHISPER_MODEL"]
    return data


def new_chain_entry(provider, model, budget_usd=0.0, period="month", price_in=0.0, price_out=0.0):
    return {"id": uuid.uuid4().hex[:8], "provider": provider, "model": model, "enabled": True,
            "budget_usd": budget_usd, "period": period, "price_in": price_in, "price_out": price_out}


def load():
    with _lock:
        try:
            with open(SETTINGS_PATH, encoding="utf-8") as f:
                stored = json.load(f)
        except (OSError, ValueError):
            stored = {}
        data = _merge(DEFAULTS, stored)
        # Older settings files (transcribe_backend / hook_defaults only).
        if stored.get("transcribe_backend") in ("auto", "groq", "whisper") and "transcription" not in stored:
            data["transcription"]["mode"] = stored["transcribe_backend"]
        data.pop("transcribe_backend", None)
        if "providers" not in stored:
            data = _seed_from_env(data)
            _write(data)
        return data


def _write(data):
    os.makedirs(os.path.dirname(SETTINGS_PATH) or ".", exist_ok=True)
    tmp = SETTINGS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, SETTINGS_PATH)


def save_section(section, value):
    """Replace one section. Provider keys sent as "" keep the stored key;
    send null to clear one."""
    data = load()
    if section not in DEFAULTS:
        raise KeyError(section)
    if section == "providers":
        for name, incoming in (value or {}).items():
            if name not in PROVIDERS:
                continue
            cur = data["providers"].setdefault(name, {"key": ""})
            if "key" in incoming:
                if incoming["key"] is None:
                    cur["key"] = ""
                elif str(incoming["key"]).strip() and "…" not in str(incoming["key"]):
                    cur["key"] = str(incoming["key"]).strip()
            if name == "custom" and incoming.get("base_url"):
                cur["base_url"] = str(incoming["base_url"]).strip().rstrip("/")
    elif section == "llm_chain":
        chain = []
        for e in value or []:
            if e.get("provider") not in PROVIDERS or not str(e.get("model") or "").strip():
                continue
            chain.append({
                "id": str(e.get("id") or uuid.uuid4().hex[:8])[:16],
                "provider": e["provider"], "model": str(e["model"]).strip(),
                "enabled": bool(e.get("enabled", True)),
                "budget_usd": max(0.0, float(e.get("budget_usd") or 0)),
                "period": e.get("period") if e.get("period") in ("day", "month", "total") else "month",
                "price_in": max(0.0, float(e.get("price_in") or 0)),
                "price_out": max(0.0, float(e.get("price_out") or 0)),
            })
        data["llm_chain"] = chain
    else:
        data[section] = _merge(DEFAULTS[section], value or {}) if isinstance(DEFAULTS[section], dict) else value
    with _lock:
        _write(data)
    return data


def _mask(key):
    key = key or ""
    return "" if not key else (key[:6] + "…" + key[-4:] if len(key) > 14 else "…" + key[-2:])


def public():
    """Settings for the dashboard: keys masked, spend for the current periods."""
    data = load()
    out = copy.deepcopy(data)
    for name, p in out["providers"].items():
        p["has_key"] = bool(p.get("key"))
        p["key"] = _mask(p.get("key"))
        p["label"] = PROVIDERS[name]["label"]
        p["key_url"] = PROVIDERS[name]["key_url"]
        p.setdefault("base_url", PROVIDERS[name]["base_url"])
    ledger = read_spend()
    for e in out["llm_chain"]:
        e["spent_usd"] = round(ledger.get(period_key(e["period"]), {}).get(e["id"], 0.0), 4)
    out["known_prices"] = KNOWN_PRICES
    return out


def provider_endpoint(name, data=None):
    data = data or load()
    p = data["providers"].get(name) or {}
    base = p.get("base_url") if name == "custom" else PROVIDERS[name]["base_url"]
    return base.rstrip("/"), p.get("key", "")


# ---- spending ledger -------------------------------------------------------

def period_key(period):
    if period == "day":
        return time.strftime("%Y-%m-%d")
    if period == "total":
        return "total"
    return time.strftime("%Y-%m")


def read_spend():
    try:
        with open(SPEND_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def add_spend(entry_id, period, usd):
    """Add ``usd`` to an entry's running total for its current period."""
    if not usd:
        return
    with _lock:
        ledger = read_spend()
        bucket = ledger.setdefault(period_key(period), {})
        bucket[entry_id] = round(bucket.get(entry_id, 0.0) + float(usd), 6)
        os.makedirs(os.path.dirname(SPEND_PATH) or ".", exist_ok=True)
        with open(SPEND_PATH, "w", encoding="utf-8") as f:
            json.dump(ledger, f, indent=2)


# ---- what a job process gets -------------------------------------------------

def child_env(env):
    """Apply the settings to a job's environment (in place) and return it."""
    data = load()
    chain = []
    for e in data["llm_chain"]:
        if not e.get("enabled"):
            continue
        base, key = provider_endpoint(e["provider"], data)
        if not key and e["provider"] != "custom":
            continue
        chain.append({**e, "base_url": base, "key": key})
    if chain:
        env["LLM_CHAIN_JSON"] = json.dumps(chain)
        env["LLM_SPEND_PATH"] = SPEND_PATH
    t = data["transcription"]
    env["TRANSCRIBE_BACKEND"] = t["mode"]
    if data["providers"]["groq"].get("key"):
        env["GROQ_API_KEY"] = data["providers"]["groq"]["key"]
    env["GROQ_WHISPER_MODEL"] = t["groq_model"]
    env["WHISPER_MODEL"] = t["local_model"]
    if t.get("language"):
        env["TRANSCRIBE_LANGUAGE"] = t["language"]
    if t.get("glossary", "").strip():
        env["TRANSCRIBE_GLOSSARY"] = t["glossary"]
    c = data["clips"]
    env["CLIP_MIN_SECONDS"] = str(c["min_seconds"])
    env["CLIP_MAX_SECONDS"] = str(c["max_seconds"])
    if c.get("count_min"):
        env["CLIP_TARGET_MIN"] = str(c["count_min"])
    if c.get("count_max"):
        env["CLIP_TARGET_MAX"] = str(c["count_max"])
    env["AUTO_CAPTION_STYLE_JSON"] = json.dumps(data["subtitle_defaults"])
    h = data["hook_defaults"]
    for key, var in (("style", "AUTO_HOOK_STYLE"), ("font", "AUTO_HOOK_FONT"),
                     ("scale", "AUTO_HOOK_SCALE"), ("position", "AUTO_HOOK_POSITION"),
                     ("duration_seconds", "AUTO_HOOK_SECONDS")):
        if h.get(key) not in (None, ""):
            env[var] = str(h[key])
    if data["download"].get("youtube_cookies", "").strip():
        env["YOUTUBE_COOKIES"] = data["download"]["youtube_cookies"]
    return env
