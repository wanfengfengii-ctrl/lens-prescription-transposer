"""眼镜处方柱镜记法转置的核心领域逻辑。

内部统一使用“四分之一屈光度”的整数运算：
1.00 D == 4 个单位，合法范围 [-80, 80] 对应 [-20.00, +20.00] D，
步长 0.25 D 恰好是 1 个单位，杜绝浮点误差。

转置公式（C 非零且符号与目标记法不符时）：
    S' = S + C
    C' = -C
    A' = A + 90，若 A' > 180 则 A' -= 180
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any
import re

MIN_Q = -80  # -20.00 D，四分之一屈光度整数
MAX_Q = 80   # +20.00 D

TARGET_PLUS = "plus"
TARGET_MINUS = "minus"
VALID_TARGETS = (TARGET_PLUS, TARGET_MINUS)

# 十进制定点数字面量：可带符号与小数点，拒绝 1e0 等科学计数法及其它写法
_FIXED_POINT_RE = re.compile(r"^[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$")
# 整数轴位字面量：仅十进制整数
_INTEGER_RE = re.compile(r"^[+-]?[0-9]+$")


class PrescriptionError(ValueError):
    """整张处方被拒绝（对应 HTTP 422）。errors 为人类可读的原因列表。"""

    def __init__(self, errors: list[str]):
        self.errors = list(errors)
        super().__init__("; ".join(self.errors))


def fmt(q: int) -> str:
    """把四分之一屈光度整数格式化为固定两位小数，如 +6.25 / -0.50 / 0.00。"""
    if q > 0:
        sign = "+"
    elif q < 0:
        sign = "-"
    else:
        sign = ""
    a = abs(q)
    return f"{sign}{a // 4}.{(a % 4) * 25:02d}"


def _parse_quarters(value: Any, field: str, errors: list[str]) -> int | None:
    """把 JSON 值解析为四分之一屈光度整数；失败时记录错误并返回 None。"""
    if value is None or isinstance(value, bool):
        errors.append(f"{field}: 必须是 -20.00 至 +20.00、步长 0.25 的十进制定点数")
        return None
    if isinstance(value, str):
        text = value.strip()
    elif isinstance(value, (int, float)):
        text = str(value)
    else:
        errors.append(f"{field}: 必须是十进制定点数，收到 {value!r}")
        return None
    # 记法闸门：只接受定点数写法，1e0 / 5e-1 等科学计数法一律拒绝
    if not _FIXED_POINT_RE.fullmatch(text):
        errors.append(f"{field}: 必须是十进制定点数（不接受科学计数法），收到 {value!r}")
        return None
    q = Decimal(text) * 4
    if q != q.to_integral_value():
        errors.append(f"{field}: 必须是 0.25 的整数倍，收到 {value!r}")
        return None
    qi = int(q)
    if not (MIN_Q <= qi <= MAX_Q):
        errors.append(f"{field}: 超出 -20.00 至 +20.00 范围，收到 {value!r}")
        return None
    return qi


def _parse_axis(value: Any, field: str, errors: list[str]) -> int | None:
    """把 JSON 值解析为整数轴位；失败时记录错误并返回 None。"""
    if value is None or isinstance(value, bool):
        errors.append(f"{field}: 必须是整数")
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if value.is_integer():
            return int(value)
        errors.append(f"{field}: 必须是整数，收到 {value!r}")
        return None
    if isinstance(value, str):
        text = value.strip()
        if _INTEGER_RE.fullmatch(text):
            return int(text)
        errors.append(f"{field}: 必须是整数，收到 {value!r}")
        return None
    errors.append(f"{field}: 必须是整数，收到 {value!r}")
    return None


@dataclass(frozen=True)
class EyeInput:
    """单眼已校验输入，全部为四分之一屈光度整数 / 整数轴位。"""

    s_q: int
    c_q: int
    axis: int


def validate_eye(raw: Any, label: str) -> EyeInput:
    """校验单眼。任何不合规都抛 PrescriptionError（整单随之 422）。"""
    if not isinstance(raw, dict):
        raise PrescriptionError([f"{label}: 必须是包含 S、C、A 的对象"])

    errors: list[str] = []
    for key in ("S", "C", "A"):
        if key not in raw:
            errors.append(f"{label}.{key}: 缺少必填字段")

    s_q = _parse_quarters(raw["S"], f"{label}.S", errors) if "S" in raw else None
    c_q = _parse_quarters(raw["C"], f"{label}.C", errors) if "C" in raw else None
    axis = _parse_axis(raw["A"], f"{label}.A", errors) if "A" in raw else None

    if c_q is not None and axis is not None:
        if c_q == 0 and axis != 0:
            errors.append(f"{label}.A: C 为零时 A 必须为 0，收到 {axis}")
        elif c_q != 0 and not (1 <= axis <= 180):
            errors.append(f"{label}.A: C 非零时 A 必须是 1 至 180 的整数，收到 {axis}")

    if errors:
        raise PrescriptionError(errors)
    assert s_q is not None and c_q is not None and axis is not None
    return EyeInput(s_q=s_q, c_q=c_q, axis=axis)


@dataclass(frozen=True)
class EyeTransposition:
    """单眼转置结果（四分之一屈光度整数）。"""

    source: EyeInput
    out_s_q: int
    out_c_q: int
    out_axis: int
    changed: bool


def transpose_eye(eye: EyeInput, target: str) -> EyeTransposition:
    """单眼转置。C 为零或已符合目标符号时原样返回；S' 超界则拒绝。"""
    s_q, c_q, axis = eye.s_q, eye.c_q, eye.axis
    if c_q == 0:
        return EyeTransposition(eye, s_q, c_q, axis, changed=False)
    if (target == TARGET_PLUS and c_q > 0) or (target == TARGET_MINUS and c_q < 0):
        return EyeTransposition(eye, s_q, c_q, axis, changed=False)

    out_s = s_q + c_q
    out_c = -c_q
    if not (MIN_Q <= out_s <= MAX_Q):
        raise PrescriptionError(
            [f"转置后 S'={fmt(out_s)} 超出 -20.00 至 +20.00 范围，拒绝输出"]
        )
    out_axis = axis + 90
    if out_axis > 180:
        out_axis -= 180
    return EyeTransposition(eye, out_s, out_c, out_axis, changed=True)


def _eye_payload(t: EyeTransposition) -> dict[str, Any]:
    """生成单眼响应：原值、转置值、两个物理方向功率的等价校核。"""
    src = t.source
    # 原处方：原轴方向功率为 S，垂直方向功率为 S + C
    along_src = src.s_q
    perp_src = src.s_q + src.c_q
    # 输出处方在这两个物理方向上的功率，取决于输出轴是否旋转了 90°
    if t.changed:
        # 已转置：新轴 = 原垂直方向（功率 S'），新轴的垂直方向 = 原轴方向（功率 S' + C'）
        out_at_src_axis = t.out_s_q + t.out_c_q
        out_at_src_perp = t.out_s_q
    else:
        # 原样返回：轴不变，原轴方向功率 S'，垂直方向功率 S' + C'
        out_at_src_axis = t.out_s_q
        out_at_src_perp = t.out_s_q + t.out_c_q

    perp_deg = src.axis + 90
    if perp_deg > 180:
        perp_deg -= 180

    return {
        "input": {"S": fmt(src.s_q), "C": fmt(src.c_q), "A": src.axis},
        "output": {"S": fmt(t.out_s_q), "C": fmt(t.out_c_q), "A": t.out_axis},
        "changed": t.changed,
        "check": {
            "originalAxisDirection": {
                "degrees": src.axis,
                "original": fmt(along_src),
                "transposed": fmt(out_at_src_axis),
            },
            "perpendicularDirection": {
                "degrees": perp_deg,
                "original": fmt(perp_src),
                "transposed": fmt(out_at_src_perp),
            },
            "equivalent": along_src == out_at_src_axis and perp_src == out_at_src_perp,
        },
    }


def transpose_prescription(raw: Any) -> dict[str, Any]:
    """整张处方转置。

    任一眼不合规（含转置后 S' 超界）即抛 PrescriptionError，
    由 API 层映射为 422，且不输出任何一眼的结果。
    """
    if not isinstance(raw, dict):
        raise PrescriptionError(["请求体必须是包含 target、right、left 的对象"])

    target = raw.get("target")
    if target not in VALID_TARGETS:
        raise PrescriptionError([f"target: 必须是 'plus' 或 'minus'，收到 {target!r}"])

    errors: list[str] = []
    eyes: dict[str, EyeInput] = {}
    for key, label in (("right", "右眼"), ("left", "左眼")):
        try:
            eyes[key] = validate_eye(raw.get(key), label)
        except PrescriptionError as exc:
            errors.extend(exc.errors)
    if errors:
        raise PrescriptionError(errors)

    results: dict[str, EyeTransposition] = {}
    for key, label in (("right", "右眼"), ("left", "左眼")):
        try:
            results[key] = transpose_eye(eyes[key], target)
        except PrescriptionError as exc:
            errors.extend(f"{label}: {msg}" for msg in exc.errors)
    if errors:
        raise PrescriptionError(errors)

    return {
        "target": target,
        "right": _eye_payload(results["right"]),
        "left": _eye_payload(results["left"]),
    }
