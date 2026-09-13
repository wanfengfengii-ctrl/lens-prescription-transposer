"""眼镜处方柱镜记法转置的核心领域逻辑。

内部统一使用“四分之一屈光度”的整数运算：
1.00 D == 4 个单位，合法范围 [-80, 80] 对应 [-20.00, +20.00] D，
步长 0.25 D 恰好是 1 个单位，杜绝浮点误差。

转置公式（C 非零且符号与目标记法不符时）：
    S' = S + C
    C' = -C
    A' = A + 90，若 A' > 180 则 A' -= 180

每眼可选携带棱镜补偿（P 度数 + B 基底方向）：度数 0.00 至 10.00、
步长 0.25；非零时必须指定基底方向（上/下/内/外），零值不接受方向。
棱镜不参与球柱镜换算，在转置结果中原样返回；未提供棱镜的旧请求
仍按原契约处理，响应省略棱镜字段。

处方可带加工范围 scope：both（默认，双眼）、right（仅右眼）、left（仅左眼）。
加工中心偶尔收到仅配单眼的处方，选择单眼后只校验并返回所选眼，
另一眼缺失或空白均不参与；未传 scope 的旧请求仍按双眼契约解析，
响应维持原结构（不含 scope 字段）。
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any
import re

MIN_Q = -80  # -20.00 D，四分之一屈光度整数
MAX_Q = 80   # +20.00 D

PRISM_MIN_Q = 0   # 0.00 Δ，棱镜度数下限
PRISM_MAX_Q = 40  # +10.00 Δ，棱镜度数上限
PRISM_BASES = ("上", "下", "内", "外")

TARGET_PLUS = "plus"
TARGET_MINUS = "minus"
VALID_TARGETS = (TARGET_PLUS, TARGET_MINUS)

# 加工范围：双眼（默认）或仅单眼
SCOPE_BOTH = "both"
SCOPE_RIGHT = "right"
SCOPE_LEFT = "left"
VALID_SCOPES = (SCOPE_BOTH, SCOPE_RIGHT, SCOPE_LEFT)

# 各加工范围参与校验、转置与输出的眼别（眼别键, 中文标签）
_SCOPE_EYES: dict[str, tuple[tuple[str, str], ...]] = {
    SCOPE_BOTH: (("right", "右眼"), ("left", "左眼")),
    SCOPE_RIGHT: (("right", "右眼"),),
    SCOPE_LEFT: (("left", "左眼"),),
}

# 十进制定点数字面量：可带符号与小数点，拒绝 1e0 等科学计数法及其它写法
_FIXED_POINT_RE = re.compile(r"^[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$")
# 整数轴位字面量：仅十进制整数
_INTEGER_RE = re.compile(r"^[+-]?[0-9]+$")


class JsonFloatLiteral:
    """HTTP 层 JSON 浮点数字面量的原样写法（json.loads 的 parse_float 钩子返回）。

    默认的 json.loads 会把 1e0、5e-1 等科学计数法字面量解析为 float，
    str() 后又归一化回定点写法（1.0、0.5），使记法闸门漏检。本类型保留
    源文写法（如 '1e0'），由定点数闸门按既定格式规则拒绝；定点写法
    （1.5、90.0）则正常参与数值校验。
    """

    __slots__ = ("literal",)

    def __init__(self, literal: str) -> None:
        self.literal = literal

    def __repr__(self) -> str:
        # 错误消息中与字符串输入一致地展示原写法（如 收到 '1e0'）
        return repr(self.literal)


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


def _parse_quarters(
    value: Any,
    field: str,
    errors: list[str],
    min_q: int = MIN_Q,
    max_q: int = MAX_Q,
) -> int | None:
    """把 JSON 值解析为四分之一屈光度整数；失败时记录错误并返回 None。"""
    range_text = f"{fmt(min_q)} 至 {fmt(max_q)}"
    if value is None or isinstance(value, bool):
        errors.append(f"{field}: 必须是 {range_text}、步长 0.25 的十进制定点数")
        return None
    if isinstance(value, JsonFloatLiteral):
        # JSON 浮点字面量：保留源文写法，科学计数法在下方记法闸门被拒绝
        text = value.literal
    elif isinstance(value, str):
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
    if not (min_q <= qi <= max_q):
        errors.append(f"{field}: 超出 {range_text} 范围，收到 {value!r}")
        return None
    return qi


def _parse_axis(value: Any, field: str, errors: list[str]) -> int | None:
    """把 JSON 值解析为整数轴位；失败时记录错误并返回 None。"""
    if value is None or isinstance(value, bool):
        errors.append(f"{field}: 必须是整数")
        return None
    if isinstance(value, JsonFloatLiteral):
        # JSON 浮点字面量：定点写法的整数（90.0）接受，科学计数法（9e1）拒绝
        text = value.literal
        if _FIXED_POINT_RE.fullmatch(text):
            decimal_value = Decimal(text)
            if decimal_value == decimal_value.to_integral_value():
                return int(decimal_value)
        errors.append(f"{field}: 必须是整数，收到 {value!r}")
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


def _is_blank(value: Any) -> bool:
    """可选字段的“未提供”：null 或空白字符串（键缺失由调用方另行判断）。"""
    return value is None or (isinstance(value, str) and value.strip() == "")


@dataclass(frozen=True)
class EyeInput:
    """单眼已校验输入，全部为四分之一屈光度整数 / 整数轴位。

    prism_q 为 None 表示该眼未携带棱镜；prism_q == 0 为显式零度棱镜
    （无基底方向）；prism_q > 0 时 prism_base 必为上/下/内/外之一。
    """

    s_q: int
    c_q: int
    axis: int
    prism_q: int | None = None
    prism_base: str | None = None


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

    # 可选棱镜补偿：P 度数（0.00–10.00，步长 0.25）+ B 基底方向（上/下/内/外）
    prism_q: int | None = None
    prism_base: str | None = None
    p_given = "P" in raw and not _is_blank(raw["P"])
    b_given = "B" in raw and not _is_blank(raw["B"])
    if p_given:
        prism_q = _parse_quarters(
            raw["P"], f"{label}.P", errors, PRISM_MIN_Q, PRISM_MAX_Q
        )
    if b_given:
        base = raw["B"]
        if isinstance(base, str) and base.strip() in PRISM_BASES:
            prism_base = base.strip()
        else:
            errors.append(
                f"{label}.B: 基底方向必须是 上、下、内、外 之一，收到 {base!r}"
            )
    if prism_q is not None:
        if prism_q == 0 and prism_base is not None:
            errors.append(
                f"{label}.B: 棱镜为零时不接受基底方向，收到 {prism_base!r}"
            )
        elif prism_q != 0 and not b_given:
            errors.append(f"{label}.B: 非零棱镜必须指定基底方向（上、下、内、外）")
    if prism_base is not None and not p_given:
        errors.append(f"{label}.P: 指定基底方向时必须同时提供棱镜度数")

    if errors:
        raise PrescriptionError(errors)
    assert s_q is not None and c_q is not None and axis is not None
    return EyeInput(
        s_q=s_q, c_q=c_q, axis=axis, prism_q=prism_q, prism_base=prism_base
    )


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
    """生成单眼响应：原值、转置值、两个物理方向功率的等价校核。

    棱镜不参与球柱镜换算，携带时在结果中原样返回；未携带则省略该字段。
    """
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

    payload: dict[str, Any] = {
        "input": {"S": fmt(src.s_q), "C": fmt(src.c_q), "A": src.axis},
        "output": {"S": fmt(t.out_s_q), "C": fmt(t.out_c_q), "A": t.out_axis},
        "changed": t.changed,
    }
    if src.prism_q is not None:
        prism: dict[str, Any] = {"P": fmt(src.prism_q)}
        if src.prism_base is not None:
            prism["B"] = src.prism_base
        payload["prism"] = prism
    payload["check"] = {
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
    }
    return payload


def _validate_and_transpose(raw: Any) -> tuple[str, str, dict[str, EyeTransposition]]:
    """校验处方并完成加工范围内各眼的转置，返回 (目标记法, 加工范围, 各眼结果)。

    加工范围 scope 可选：both（默认，双眼）、right（仅右眼）、left（仅左眼）。
    未传 scope 的旧请求按双眼契约解析；单眼范围只校验所选眼，另一眼
    缺失、空白或携带任意数据均不参与。范围内任一眼不合规（含转置后
    S' 超界）即抛 PrescriptionError，由 API 层映射为 422，
    且不输出任何一眼的结果。
    """
    if not isinstance(raw, dict):
        raise PrescriptionError(["请求体必须是包含 target、right、left 的对象"])

    target = raw.get("target")
    if target not in VALID_TARGETS:
        raise PrescriptionError([f"target: 必须是 'plus' 或 'minus'，收到 {target!r}"])

    scope = raw.get("scope", SCOPE_BOTH)
    if scope not in VALID_SCOPES:
        raise PrescriptionError(
            [f"scope: 必须是 'both'、'right' 或 'left'，收到 {scope!r}"]
        )

    eyes_in_scope = _SCOPE_EYES[scope]
    errors: list[str] = []
    eyes: dict[str, EyeInput] = {}
    for key, label in eyes_in_scope:
        try:
            eyes[key] = validate_eye(raw.get(key), label)
        except PrescriptionError as exc:
            errors.extend(exc.errors)
    if errors:
        raise PrescriptionError(errors)

    results: dict[str, EyeTransposition] = {}
    for key, label in eyes_in_scope:
        try:
            results[key] = transpose_eye(eyes[key], target)
        except PrescriptionError as exc:
            errors.extend(f"{label}: {msg}" for msg in exc.errors)
    if errors:
        raise PrescriptionError(errors)

    return target, scope, results


def transpose_prescription(raw: Any) -> dict[str, Any]:
    """整张处方转置（校验与原子性见 _validate_and_transpose）。

    双眼请求返回原结构（target + right + left）；单眼请求仅返回
    所选眼结果，并回传 scope 标明本次加工范围。
    """
    target, scope, results = _validate_and_transpose(raw)
    payload: dict[str, Any] = {"target": target}
    if scope != SCOPE_BOTH:
        payload["scope"] = scope
    for key in ("right", "left"):
        if key in results:
            payload[key] = _eye_payload(results[key])
    return payload


def verify_entry(raw: Any) -> dict[str, Any]:
    """设备录入复核：操作员把磨片参数抄入设备后再次录入，逐字段比对。

    请求体：{"prescription": 原转置请求, "entry": {"right": {...}, "left": {...}}}。
    复核范围跟随原处方的加工范围：单眼处方只重算并比较所选眼，另一眼
    缺失或携带任意数据均不参与。复用现有校验与整数转置逻辑重算期望值；
    原处方或录入值不合规任一项即整次复核 422。全部合法时逐字段比较
    （四分之一屈光度整数比较，无浮点误差），除 S、C、A 外还逐眼比较
    可选的棱镜度数 P 与基底方向 B（棱镜不参与转置，期望值即原处方值），
    返回整单是否吻合及每处差异的眼别、字段、期望值与录入值。
    """
    if not isinstance(raw, dict):
        raise PrescriptionError(["请求体必须是包含 prescription、entry 的对象"])
    if "prescription" not in raw:
        raise PrescriptionError(["prescription: 缺少必填字段（原转置请求）"])
    if "entry" not in raw:
        raise PrescriptionError(["entry: 缺少必填字段（双眼录入值）"])

    # 原处方不合规 → 整次复核拒绝（与 /api/v1/transpose 同一套校验）
    _, _, results = _validate_and_transpose(raw["prescription"])

    entry = raw["entry"]
    if not isinstance(entry, dict):
        raise PrescriptionError(["entry: 必须是包含 right、left 的对象"])

    labels = {"right": "复核录入.右眼", "left": "复核录入.左眼"}
    errors: list[str] = []
    entered: dict[str, EyeInput] = {}
    for key in ("right", "left"):
        if key not in results:
            continue  # 不在加工范围内的眼别不参与复核
        try:
            entered[key] = validate_eye(entry.get(key), labels[key])
        except PrescriptionError as exc:
            errors.extend(exc.errors)
    if errors:
        raise PrescriptionError(errors)

    differences: list[dict[str, Any]] = []
    for key in ("right", "left"):
        if key not in results:
            continue  # 只比较加工范围内的眼别
        expected = results[key]
        got = entered[key]
        for field, exp_q, got_q in (
            ("S", expected.out_s_q, got.s_q),
            ("C", expected.out_c_q, got.c_q),
        ):
            if got_q != exp_q:
                differences.append(
                    {
                        "eye": key,
                        "field": field,
                        "expected": fmt(exp_q),
                        "entered": fmt(got_q),
                    }
                )
        if got.axis != expected.out_axis:
            differences.append(
                {
                    "eye": key,
                    "field": "A",
                    "expected": expected.out_axis,
                    "entered": got.axis,
                }
            )
        # 棱镜不参与转置，期望值即原处方值；未携带按零度无方向归一后比较
        src = expected.source
        exp_prism_q = src.prism_q if src.prism_q is not None else 0
        got_prism_q = got.prism_q if got.prism_q is not None else 0
        if got_prism_q != exp_prism_q:
            differences.append(
                {
                    "eye": key,
                    "field": "P",
                    "expected": fmt(exp_prism_q),
                    "entered": fmt(got_prism_q),
                }
            )
        if got.prism_base != src.prism_base:
            differences.append(
                {
                    "eye": key,
                    "field": "B",
                    "expected": src.prism_base if src.prism_base is not None else "无",
                    "entered": got.prism_base if got.prism_base is not None else "无",
                }
            )

    return {"match": not differences, "differences": differences}
