"""FastAPI 入口：处方柱镜记法转置核对 API。"""
from __future__ import annotations

from typing import Any

from fastapi import Body, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .transpose import PrescriptionError, transpose_prescription

app = FastAPI(title="眼镜处方柱镜记法转置核对 API", version="1.0.0")

# 页面经同源反向代理访问 API，此处放开 CORS 仅供本地直连调试。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/v1/transpose")
def transpose(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    """单次提交双眼 S/C/A 与目标记法；任一眼不合规即整单 422。"""
    try:
        return transpose_prescription(payload)
    except PrescriptionError as exc:
        raise HTTPException(status_code=422, detail=exc.errors) from exc
