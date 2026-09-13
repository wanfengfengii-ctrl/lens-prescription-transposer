"""FastAPI 入口：处方柱镜记法转置核对 API。"""
from __future__ import annotations

import json
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from .transpose import (
    JsonFloatLiteral,
    PrescriptionError,
    transpose_prescription,
    verify_entry,
)

app = FastAPI(title="眼镜处方柱镜记法转置核对 API", version="1.0.0")

# 页面经同源反向代理访问 API，此处放开 CORS 仅供本地直连调试。
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _parse_body(raw: bytes) -> Any:
    """解析请求体 JSON，浮点字面量保留源文写法。

    默认的 json.loads 会把 1e0、5e-1 等科学计数法解析为 float，str() 后
    归一化回定点写法（1.0、0.5），使定点数记法闸门漏检；parse_float 经
    JsonFloatLiteral 保留原写法后，由领域层按既定格式规则整单拒绝。
    """
    try:
        return json.loads(raw, parse_float=JsonFloatLiteral)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=422, detail="请求体不是合法 JSON") from exc


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/v1/transpose")
async def transpose(request: Request) -> dict[str, Any]:
    """单次提交双眼 S/C/A 与目标记法；任一眼不合规即整单 422。"""
    try:
        return transpose_prescription(_parse_body(await request.body()))
    except PrescriptionError as exc:
        raise HTTPException(status_code=422, detail=exc.errors) from exc


@app.post("/api/v1/verify-entry")
async def verify(request: Request) -> dict[str, Any]:
    """双眼录入复核：携带原转置请求与录入值，逐字段比对。

    原处方或录入值不合规即整次 422；全部合法时返回整单是否吻合
    以及每处差异的眼别、字段、期望值与录入值。
    """
    try:
        return verify_entry(_parse_body(await request.body()))
    except PrescriptionError as exc:
        raise HTTPException(status_code=422, detail=exc.errors) from exc
