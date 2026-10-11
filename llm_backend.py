"""Text-only LLM backend for the moment picker: any OpenAI-compatible server.

Two ways to configure it:

* ``LLM_CHAIN_JSON`` (set by settings_store.child_env from the Settings page):
  an ordered list of models, each {provider, model, base_url, key, budget_usd,
  period, price_in, price_out}. Every call tries them in order: an entry whose
  budget for the current period is spent is skipped, and an error (HTTP,
  timeout, bad JSON) falls through to the next one. What each call cost is
  added to the spending ledger (settings_store.add_spend).
* ``LLM_BASE_URL`` / ``LLM_MODEL`` / ``LLM_API_KEY``: one endpoint (Ollama,
  LM Studio, vLLM, llama.cpp, OpenRouter, Anthropic, Groq, Gemini...).

Frames: ``generate_json(..., images=[jpeg bytes])`` sends them as image parts
(the layout picker, hook grounding, burned-subtitle and screen detection all go
through here). A chain entry with ``"vision": false`` is skipped for those
calls; a text-only model that errors on images simply hands over to the next.
With no chain and no endpoint but a GEMINI_API_KEY, calls go to Gemini's SDK.

Structured output: the request first asks for ``json_schema``; a server that
rejects that gets ``json_object``, then no ``response_format`` at all. The
answer is validated with the same pydantic model Gemini's ``response_schema``
uses, so ``main.py`` sees one shape regardless of provider.
"""
from __future__ import annotations

import json
import os
from typing import List, Optional, Tuple, Type

import httpx
from pydantic import BaseModel

DEFAULT_MODEL = "llama3.1:8b"
DEFAULT_TIMEOUT = 600.0  # local models on CPU are slow; a scoring batch can take minutes

# USD per million tokens for single-endpoint mode (the chain carries its own).
_PRICES_PER_MTOK = {
    "claude-sonnet-5-5": (2.00, 10.00),
    "claude-sonnet-5": (2.00, 10.00),
    "claude-opus-5-5": (4.00, 20.00),
    "claude-haiku-5-5": (0.10, 0.50),
}


def _entries(var):
    raw = os.environ.get(var)
    if raw is None and "LLM_CHAIN_JSON" not in os.environ:
        # The API process is not started with the chain in its environment
        # (job processes are): read it from the Settings store directly.
        try:
            import settings_store
            raw = settings_store.child_env({}).get(var)
        except Exception:
            raw = None
    try:
        entries = json.loads(raw or "[]")
        return [e for e in entries if isinstance(e, dict) and e.get("base_url") and e.get("model")]
    except ValueError:
        return []


def chain(tier: str = "hard") -> List[dict]:
    """The models to try, in order. ``hard`` (moments, titles, hooks):
    Settings → hard tasks. ``simple`` (yes/no image checks, filter fixes):
    Settings → simple tasks, then the hard list as the last resort."""
    hard = _entries("LLM_CHAIN_JSON")
    if tier != "simple":
        return hard
    simple = _entries("LLM_CHAIN_SIMPLE_JSON")
    ids = {e.get("id") for e in simple}
    return simple + [e for e in hard if e.get("id") not in ids]


# Models that told us how many images they accept ("supports up to 3 images").
_IMAGE_LIMITS = {}


def _grid_layout(n, limit):
    """(frames per image, columns) to fit ``n`` frames into ``limit`` images."""
    import math
    per = max(1, math.ceil(n / max(1, limit)))
    cols = min(4, per) if per > 2 else per
    return per, cols


def _grid_images(images, limit):
    """Pack frames into at most ``limit`` grid images, in reading order.
    Cells are 512 px wide: free tiers weigh images heavily, not pixels."""
    import cv2
    import numpy as np
    per, cols = _grid_layout(len(images), limit)
    rows = -(-per // cols)
    decoded = [cv2.imdecode(np.frombuffer(b, np.uint8), cv2.IMREAD_COLOR) for b in images]
    decoded = [d for d in decoded if d is not None]
    if not decoded:
        return images[:limit]
    h0, w0 = decoded[0].shape[:2]
    w, h = 512, max(2, int(h0 * 512 / w0))
    out = []
    for i in range(0, len(decoded), per):
        cells = [cv2.resize(d, (w, h)) for d in decoded[i:i + per]]
        cells += [np.zeros_like(cells[0])] * (rows * cols - len(cells))
        grid = np.vstack([np.hstack(cells[r * cols:(r + 1) * cols]) for r in range(rows)])
        ok, buf = cv2.imencode(".jpg", grid, [cv2.IMWRITE_JPEG_QUALITY, 82])
        if ok:
            out.append(buf.tobytes())
    return out[:limit]


def _fit_images(model, prompt, images):
    """Images and prompt adjusted to the model's known image limit."""
    limit = _IMAGE_LIMITS.get(model)
    if not images or not limit or len(images) <= limit:
        return prompt, images
    per, cols = _grid_layout(len(images), limit)
    note = (f"Each image is a grid of {per} frames ({cols} per row) from the video "
            f"({len(images)} frames in total, in time order: left to right, then top to bottom). "
            "Judge each frame on its own; 'image N' or 'frame N' below means the N-th frame, and "
            "positions or fractions refer to that single frame, not to the whole grid. ")
    return note + prompt, _grid_images(images, limit)


def available(tier: str = "hard") -> bool:
    """Any model at all: a chain, one endpoint, or a Gemini key."""
    return bool(chain(tier)) or active() or bool(os.environ.get("GEMINI_API_KEY"))


def _image_parts(images):
    import base64
    return [{"type": "image_url",
             "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(b).decode("ascii")}}
            for b in images or []]


def provider() -> str:
    """``"openai"`` when a compatible endpoint is configured, else ``"gemini"``."""
    if chain():
        return "openai"
    explicit = (os.environ.get("LLM_PROVIDER") or "").strip().lower()
    if explicit in ("openai", "ollama", "local", "openai-compatible"):
        return "openai"
    if explicit == "gemini":
        return "gemini"
    return "openai" if base_url() else "gemini"


def base_url() -> str:
    c = chain()
    if c:
        return " → ".join(f"{e['provider']}:{e['model']}" for e in c)
    return (os.environ.get("LLM_BASE_URL") or "").strip().rstrip("/")


def model_name() -> str:
    c = chain()
    if c:
        return c[0]["model"]
    return (os.environ.get("LLM_MODEL") or "").strip() or DEFAULT_MODEL


def active() -> bool:
    """True when the moment picker should call an OpenAI-compatible server."""
    return bool(chain()) or (provider() == "openai" and bool(base_url()))


def describe() -> Optional[dict]:
    """What ``/api/config`` tells the dashboard, or ``None`` when inactive."""
    if not active():
        return None
    return {"provider": "openai", "model": model_name(), "baseUrl": base_url()}


def _timeout() -> float:
    try:
        return float(os.environ.get("LLM_TIMEOUT") or DEFAULT_TIMEOUT)
    except ValueError:
        return DEFAULT_TIMEOUT


def _client(**kwargs) -> httpx.Client:
    """Factory so tests can swap in ``httpx.MockTransport``."""
    return httpx.Client(timeout=_timeout(), **kwargs)


def _response_formats(schema: Type[BaseModel]):
    name = getattr(schema, "__name__", "response").lower()
    yield {"type": "json_schema",
           "json_schema": {"name": name, "schema": schema.model_json_schema()}}
    yield {"type": "json_object"}
    yield None


def _is_format_rejection(resp: httpx.Response) -> bool:
    if resp.status_code not in (400, 422):
        return False
    body = resp.text.lower()
    return "response_format" in body or "json_schema" in body or "json_object" in body \
        or "format" in body


def _call(base: str, key: str, model: str, prompt: str, schema: Type[BaseModel], images=None):
    """One JSON chat completion against one endpoint. Returns (validated, usage)."""
    import gemini_worker  # local import: keeps this module free of the google SDK

    url = f"{base.rstrip('/')}/chat/completions"
    headers = {"Authorization": f"Bearer {key or 'ollama'}", "Content-Type": "application/json"}
    content = ([{"type": "text", "text": prompt}, *_image_parts(images)] if images else prompt)
    # The schema also goes in the prompt: several OpenAI-compatible endpoints
    # (Anthropic's among them) accept response_format but do not enforce it.
    system = ("You answer with a single JSON object and nothing else: the data itself, not "
              "the schema. It must follow this JSON schema exactly (same field names): "
              + json.dumps(schema.model_json_schema()))
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": content},
    ]
    last_rejection: Optional[str] = None
    with _client() as client:
        for fmt in _response_formats(schema):
            body = {"model": model, "messages": messages, "stream": False}
            # Newer Claude models reject `temperature` on the OpenAI-compatible endpoint.
            if "api.anthropic.com" not in url:
                body["temperature"] = 0.2
            if fmt is not None:
                body["response_format"] = fmt
            resp = client.post(url, json=body, headers=headers)
            if fmt is not None and _is_format_rejection(resp):
                last_rejection = resp.text[:200]
                continue
            if resp.status_code == 429 and resp.headers.get("retry-after"):
                raise RuntimeError(f"LLM server 429 from {url}: try again in "
                                   f"{resp.headers['retry-after']}s ({resp.text[:200]})")
            if resp.status_code >= 400:
                raise RuntimeError(f"LLM server {resp.status_code} from {url}: {resp.text[:300]}")
            data = resp.json()
            break
        else:
            raise RuntimeError(f"LLM server rejected every response_format variant: {last_rejection}")

    choices = data.get("choices") or []
    text = ""
    if choices:
        msg = choices[0].get("message") or {}
        text = msg.get("content") or ""
        if isinstance(text, list):  # some servers return content parts
            text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
    parsed = gemini_worker._parse_json_response_text(text)
    # Validate against the same schema Gemini enforces server-side, so a model
    # that drops a field fails here with a readable error (and, in a chain,
    # hands over to the next model).
    validated = schema.model_validate(parsed).model_dump()
    return validated, data.get("usage") or {}


def _cost(usage: dict, model: str, price_in: float, price_out: float, provider_name: str) -> dict:
    input_tokens = int(usage.get("prompt_tokens") or 0)
    output_tokens = int(usage.get("completion_tokens") or 0)
    input_cost = input_tokens * price_in / 1_000_000
    output_cost = output_tokens * price_out / 1_000_000
    return {
        "input_tokens": input_tokens, "output_tokens": output_tokens, "thinking_tokens": 0,
        "input_cost": input_cost, "output_cost": output_cost,
        "total_cost": input_cost + output_cost, "model": model, "provider": provider_name,
        "price_estimated": False, "local": not (price_in or price_out),
    }


def _gemini_sdk(prompt, schema, images):
    """Fallback when only GEMINI_API_KEY is set (no chain, no endpoint)."""
    from google import genai
    from google.genai import types as gt
    import gemini_worker
    model = os.environ.get("GEMINI_MODEL") or "gemini-3.1-flash-lite"
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    parts = [gt.Part.from_bytes(data=b, mime_type="image/jpeg") for b in images or []]
    response = client.models.generate_content(
        model=model, contents=[*parts, prompt],
        config=gt.GenerateContentConfig(response_mime_type="application/json", response_schema=schema))
    parsed = gemini_worker._parse_json_response_text(response.text or "")
    return schema.model_validate(parsed).model_dump(), gemini_worker._calculate_cost_analysis(response, model)


def _call_adapting(e, label, prompt, schema, images):
    """``_call`` for one chain entry, adapting to what the server says:
    "supports up to N images" -> pack frames into N grids; "request too large"
    (Groq's free tier weighs each image heavily) -> one grid; a 429 with a
    short "try again in Xs" -> wait, since the next model may cost money."""
    import re
    import time as _time
    for _attempt in range(4):
        p, imgs = _fit_images(e["model"], prompt, images)
        try:
            return _call(e["base_url"], e.get("key", ""), e["model"], p, schema, imgs)
        except RuntimeError as exc:
            text = str(exc)
            limit = re.search(r"up to (\d+) images?", text)
            too_large = " 413 " in text or "too large" in text.lower()
            wait = re.search(r" 429 .*?try again in (?:(\d+)m)?([\d.]+)s", text)
            if images and limit and _IMAGE_LIMITS.get(e["model"], 99) > int(limit.group(1)):
                _IMAGE_LIMITS[e["model"]] = max(1, int(limit.group(1)))
            elif images and too_large and _IMAGE_LIMITS.get(e["model"]) != 1:
                _IMAGE_LIMITS[e["model"]] = 1
            elif wait:
                seconds = int(wait.group(1) or 0) * 60 + float(wait.group(2))
                if seconds > float(os.environ.get("LLM_RATE_WAIT_MAX", "75")):
                    raise
                print(f"   ⏳ {label} rate-limited, retrying in {seconds:.0f}s", flush=True)
                _time.sleep(seconds + 0.5)
            else:
                raise
    raise RuntimeError(f"{label}: gave up after adapting the request")


def generate_json(prompt: str, schema: Type[BaseModel], model: Optional[str] = None,
                  images: Optional[List[bytes]] = None, tier: str = "hard") -> Tuple[dict, Optional[dict]]:
    """One chat completion that must come back as JSON matching ``schema``.

    Returns ``(parsed_dict, cost_analysis)`` in the shape
    ``main._run_gemini_stage`` returns. Raises when every configured model
    failed (or, in a chain, was over budget); the retry policy is the caller's.
    """
    entries = chain(tier)
    if not entries and not base_url() and os.environ.get("GEMINI_API_KEY"):
        return _gemini_sdk(prompt, schema, images)
    if not entries:
        model = model or model_name()
        p_in, p_out = _PRICES_PER_MTOK.get(model, (0.0, 0.0))
        try:
            p_in = float(os.environ.get("LLM_PRICE_INPUT") or p_in)
            p_out = float(os.environ.get("LLM_PRICE_OUTPUT") or p_out)
        except ValueError:
            pass
        validated, usage = _call(base_url(), os.environ.get("LLM_API_KEY", ""), model, prompt, schema, images)
        return validated, _cost(usage, model, p_in, p_out, "openai-compatible")

    import settings_store
    ledger = settings_store.read_spend()
    problems = []
    for e in entries:
        label = f"{e['provider']}:{e['model']}"
        budget = float(e.get("budget_usd") or 0)
        spent = ledger.get(settings_store.period_key(e.get("period", "month")), {}).get(e["id"], 0.0)
        if budget > 0 and spent >= budget:
            problems.append(f"{label} over budget (${spent:.2f} of ${budget:.2f})")
            continue
        if images and e.get("vision") is False:
            problems.append(f"{label} cannot see images")
            continue
        try:
            validated, usage = _call_adapting(e, label, prompt, schema, images)
        except Exception as exc:
            problems.append(f"{label}: {str(exc)[:160]}")
            print(f"   ↪️ {label} failed ({str(exc)[:120]}), trying the next model", flush=True)
            continue
        cost = _cost(usage, e["model"], float(e.get("price_in") or 0), float(e.get("price_out") or 0),
                     e["provider"])
        settings_store.add_spend(e["id"], e.get("period", "month"), cost["total_cost"])
        return validated, cost
    raise RuntimeError("No model in the chain could answer: " + "; ".join(problems))
