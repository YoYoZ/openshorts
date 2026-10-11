# Starts OpenShorts natively on Windows (no Docker): backend on :8000, dashboard on :5175.
$root = $PSScriptRoot

Start-Process powershell -WorkingDirectory $root -ArgumentList '-NoExit', '-Command',
    "`$Host.UI.RawUI.WindowTitle = 'OpenShorts backend'; .\.venv\Scripts\python.exe -m uvicorn app:app --host 127.0.0.1 --port 8000"

Start-Process powershell -WorkingDirectory "$root\dashboard" -ArgumentList '-NoExit', '-Command',
    "`$Host.UI.RawUI.WindowTitle = 'OpenShorts dashboard'; `$env:VITE_PROXY_TARGET = 'http://localhost:8000'; npm run dev -- --host 127.0.0.1 --port 5175"

Start-Sleep -Seconds 6
Start-Process 'http://localhost:5175'
