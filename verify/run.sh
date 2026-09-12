#!/usr/bin/env bash
# 一次性验收：依次运行 pytest（公式/边界）、Vitest（前端单元/组件）、
# Playwright（真实浏览器 + 真实后端联调）。任一失败即非零退出。
set -euo pipefail

echo "=== [0/3] 服务连通性 ==="
/venv/bin/python - <<'PY'
import os
import urllib.request

for name, url in (
    ("api", os.environ["API_URL"] + "/api/health"),
    ("web", os.environ["WEB_URL"] + "/"),
):
    with urllib.request.urlopen(url, timeout=15) as resp:
        assert resp.status == 200, (name, url, resp.status)
    print(f"OK {name}: {url}")
PY

echo "=== [1/3] pytest：转置公式与边界 ==="
cd /verify/api
/venv/bin/python -m pytest tests -v

echo "=== [2/3] Vitest：前端单元与组件 ==="
cd /verify/web
npx vitest run

echo "=== [3/3] Playwright：浏览器联调（${WEB_URL}） ==="
cd /verify/web
npx playwright test

echo "全部验收通过"
