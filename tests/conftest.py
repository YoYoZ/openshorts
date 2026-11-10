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
