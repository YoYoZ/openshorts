import os
import sys

# Make the repo root importable so tests can import the app modules directly.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Tests always run the app in self-host (BYOK) mode. app.py freezes
# BILLING_ENABLED at import time and load_dotenv never overrides an existing
# variable, so this must be set here — before any test module imports app — or
# the suite's behavior would depend on the developer's personal .env.
os.environ["BILLING_ENABLED"] = "0"

# The same for the Settings page's file (local_settings.json): a developer's
# own model chain, keys and encoding preset must not leak into the suite, and
# the suite must not write into theirs. settings_store reads the path once,
# at import.
import tempfile  # noqa: E402

_settings_dir = tempfile.mkdtemp(prefix="openshorts-test-settings-")
os.environ["LOCAL_SETTINGS_PATH"] = os.path.join(_settings_dir, "local_settings.json")
os.environ["LLM_SPEND_PATH"] = os.path.join(_settings_dir, "llm_spend.json")

# Never read the developer's .env. app.py / main.py / gemini_worker.py all do
# `from dotenv import load_dotenv; load_dotenv()` at import, which would pull
# LLM_BASE_URL, LLM_MODEL, AUTO_RETRY_LIMIT, TRANSCRIBE_BACKEND, FFMPEG_ENCODER,
# GROQ_API_KEY ... into os.environ and change what the suite exercises. Making
# it a no-op here (conftest runs before any test module imports those) keeps the
# suite identical to a clean checkout without a .env.
try:
    import dotenv  # noqa: E402
    import dotenv.main  # noqa: E402

    def _no_load_dotenv(*_a, **_k):
        return False

    dotenv.load_dotenv = _no_load_dotenv
    dotenv.main.load_dotenv = _no_load_dotenv
except ImportError:  # minimal CI env without python-dotenv
    pass
