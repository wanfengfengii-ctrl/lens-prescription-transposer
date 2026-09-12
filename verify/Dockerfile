# 一次性验收镜像：Python（pytest）+ Node（Vitest）+ Playwright 浏览器
FROM mcr.microsoft.com/playwright:v1.49.1-noble

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /verify

# Python 依赖（FastAPI 应用 + pytest）
COPY api/requirements.txt api/requirements-dev.txt /verify/api/
RUN python3 -m venv /venv \
 && /venv/bin/pip install --no-cache-dir \
      -r /verify/api/requirements.txt \
      -r /verify/api/requirements-dev.txt

# Node 依赖（Vitest + Playwright，版本与基础镜像浏览器匹配）
COPY web/package.json web/package-lock.json /verify/web/
RUN cd /verify/web && npm ci --no-audit --no-fund

# 源码与测试
COPY api/ /verify/api/
COPY web/ /verify/web/
COPY verify/run.sh /verify/run.sh
RUN chmod +x /verify/run.sh

ENV API_URL=http://api:8000 \
    WEB_URL=http://web \
    CI=1

CMD ["/verify/run.sh"]
