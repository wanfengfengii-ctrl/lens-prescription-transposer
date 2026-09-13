"""保持原记法（target='keep'）：不统一柱镜符号，各眼数值与轴位原样输出。

加工中心只需把处方整理为设备录入单时，操作员无需再做正/负柱镜转置：
- 各参与眼别输出保持输入数值与轴位，changed 恒为 False；
- 仍复用现有定点数、轴位联动与棱镜组合校验，非法处方整单 422；
- 等价校核仍由四分之一屈光度整数域结果生成；
- 设备录入复核按原处方重建期望值并逐字段比较；
- 未传新目标值的既有 plus/minus 请求响应完全不变。
"""
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.transpose import (
    JsonFloatLiteral,
    PrescriptionError,
    transpose_prescription,
    verify_entry,
)

client = TestClient(app)

MINUS = "minus"
PLUS = "plus"
KEEP = "keep"


def eye(s="1.00", c="2.00", a=30, **extra):
    e = {"S": s, "C": c, "A": a}
    e.update(extra)
    return e


# 混合正负柱镜的双眼处方：右眼正柱镜、左眼负柱镜
MIXED = {
    "right": eye("1.00", "2.00", 30),
    "left": eye("-1.25", "-0.50", 85),
}


def post_transpose(payload):
    return client.post("/api/v1/transpose", json=payload)


def post_verify(prescription, entry):
    return client.post(
        "/api/v1/verify-entry", json={"prescription": prescription, "entry": entry}
    )


class TestKeepPassthrough:
    def test_mixed_sign_cylinders_both_eyes_kept_as_is(self):
        # 验收核心：混合正负柱镜的双眼处方原样生成，不做任何符号转换
        r = post_transpose({"target": KEEP, **MIXED})
        assert r.status_code == 200
        body = r.json()
        assert body["target"] == "keep"
        # 右眼（正柱镜）：输入输出逐字段相同，changed 为 False
        assert body["right"]["input"] == {"S": "+1.00", "C": "+2.00", "A": 30}
        assert body["right"]["output"] == {"S": "+1.00", "C": "+2.00", "A": 30}
        assert body["right"]["changed"] is False
        # 左眼（负柱镜）同样原样返回
        assert body["left"]["input"] == {"S": "-1.25", "C": "-0.50", "A": 85}
        assert body["left"]["output"] == {"S": "-1.25", "C": "-0.50", "A": 85}
        assert body["left"]["changed"] is False

    def test_keep_differs_from_unified_minus_and_plus(self):
        # 与统一记法对照：minus 会转置右眼，keep 不会；响应结构仍一致
        minus = post_transpose({"target": MINUS, **MIXED}).json()
        kept = post_transpose({"target": KEEP, **MIXED}).json()
        assert minus["right"]["output"] == {"S": "+3.00", "C": "-2.00", "A": 120}
        assert kept["right"]["output"] == {"S": "+1.00", "C": "+2.00", "A": 30}
        # 左眼本就是负柱镜：两种目标下取值一致，但 keep 仍是原样语义
        assert kept["left"]["output"] == minus["left"]["output"]

        plus = post_transpose(
            {
                "target": PLUS,
                "right": eye("-3.00", "-1.50", 170),
                "left": eye("1.00", "0.75", 10),
            }
        ).json()
        kept_plus = post_transpose(
            {
                "target": KEEP,
                "right": eye("-3.00", "-1.50", 170),
                "left": eye("1.00", "0.75", 10),
            }
        ).json()
        assert plus["right"]["output"] == {"S": "-4.50", "C": "+1.50", "A": 80}
        assert kept_plus["right"]["output"] == {"S": "-3.00", "C": "-1.50", "A": 170}

    def test_equivalence_check_still_generated_from_integer_domain(self):
        # 等价校核照常由整数域结果生成：原轴/垂直两方向功率分别相等
        body = post_transpose({"target": KEEP, **MIXED}).json()
        for side, s, c, a in (
            ("right", "+1.00", "+2.00", 30),
            ("left", "-1.25", "-0.50", 85),
        ):
            chk = body[side]["check"]
            assert chk["equivalent"] is True
            assert chk["originalAxisDirection"] == {
                "degrees": a,
                "original": s,
                "transposed": s,
            }
            perp = chk["perpendicularDirection"]
            assert perp["original"] == perp["transposed"]
            assert perp["degrees"] == (a + 90 if a <= 90 else a - 90)

    def test_zero_cylinder_kept(self):
        r = post_transpose(
            {"target": KEEP, "right": eye("2.50", "0.00", 0), "left": eye("0.00", "0.00", 0)}
        )
        assert r.status_code == 200
        right = r.json()["right"]
        assert right["output"] == {"S": "+2.50", "C": "0.00", "A": 0}
        assert right["changed"] is False

    def test_no_transposition_overflow_under_keep(self):
        # 统一为负柱镜时 S'=+20.25 会超界整单拒绝；keep 不转置，原样合法输出
        overflow_for_minus = {"right": eye("20.00", "0.25", 45), "left": eye("0.00", "0.00", 0)}
        assert post_transpose({"target": MINUS, **overflow_for_minus}).status_code == 422
        r = post_transpose({"target": KEEP, **overflow_for_minus})
        assert r.status_code == 200
        assert r.json()["right"]["output"] == {"S": "+20.00", "C": "+0.25", "A": 45}

    def test_prism_carried_unchanged(self):
        # 棱镜仍随参与眼别原样返回，不参与球柱镜换算
        r = post_transpose(
            {
                "target": KEEP,
                "right": eye("1.00", "2.00", 30, P="2.00", B="外"),
                "left": eye("-1.25", "-0.50", 85),
            }
        )
        assert r.status_code == 200
        assert r.json()["right"]["prism"] == {"P": "+2.00", "B": "外"}
        assert "prism" not in r.json()["left"]


class TestKeepSingleEye:
    def test_single_eye_with_prism_kept(self):
        # 单眼含棱镜处方：只返回所选眼并回传 scope，数值/轴位/棱镜全部原样
        r = post_transpose(
            {
                "target": KEEP,
                "scope": "right",
                "right": eye("-3.00", "-1.50", 170, P="1.50", B="内"),
            }
        )
        assert r.status_code == 200
        body = r.json()
        assert set(body.keys()) == {"target", "scope", "right"}
        assert body["scope"] == "right"
        assert body["right"]["input"] == {"S": "-3.00", "C": "-1.50", "A": 170}
        assert body["right"]["output"] == {"S": "-3.00", "C": "-1.50", "A": 170}
        assert body["right"]["changed"] is False
        assert body["right"]["prism"] == {"P": "+1.50", "B": "内"}
        assert body["right"]["check"]["equivalent"] is True

    def test_single_eye_other_eye_data_ignored(self):
        r = post_transpose(
            {
                "target": KEEP,
                "scope": "left",
                "left": eye("-1.25", "-0.50", 85),
                "right": {"S": "1e0"},
            }
        )
        assert r.status_code == 200
        assert set(r.json().keys()) == {"target", "scope", "left"}


class TestKeepValidation:
    """keep 复用现有定点数与组合校验：非法处方仍整张拒绝。"""

    def test_non_quarter_step_rejected(self):
        r = post_transpose({"target": KEEP, **{**MIXED, "right": eye("1.13", "0.00", 0)}})
        assert r.status_code == 422
        assert any("右眼.S" in m for m in r.json()["detail"])

    def test_axis_linkage_rejected(self):
        # C 为零但 A 非 0：keep 不做转置不代表放松组合校验
        r = post_transpose(
            {"target": KEEP, **{**MIXED, "left": eye("-1.25", "0.00", 90)}}
        )
        assert r.status_code == 422
        assert any("左眼.A" in m and "必须为 0" in m for m in r.json()["detail"])

    def test_scientific_notation_rejected(self):
        r = post_transpose(
            {"target": KEEP, **{**MIXED, "right": eye("1e0", "2.00", 30)}}
        )
        assert r.status_code == 422
        assert any("科学计数法" in m for m in r.json()["detail"])
        # 整单拒绝：不带出任何一眼结果
        assert "right" not in r.json() and "left" not in r.json()

    def test_prism_combination_rejected(self):
        # 零度棱镜携带基底方向：非法组合照旧整单拒绝
        r = post_transpose(
            {
                "target": KEEP,
                "right": eye("1.00", "2.00", 30, P="0.00", B="上"),
                "left": eye("-1.25", "-0.50", 85),
            }
        )
        assert r.status_code == 422
        assert any("右眼.B" in m for m in r.json()["detail"])

    def test_invalid_eye_hides_the_other(self):
        r = post_transpose(
            {
                "target": KEEP,
                "right": eye("1.00", "2.00", 30),
                "left": eye("x", "-0.50", 85),
            }
        )
        assert r.status_code == 422
        body = r.json()
        assert "right" not in body and "left" not in body

    @pytest.mark.parametrize("target", ["Keep", "KEEP", "kept", "", None, 0])
    def test_bad_target_still_rejected(self, target):
        r = post_transpose({"target": target, **MIXED})
        assert r.status_code == 422
        assert any("target" in m for m in r.json()["detail"])

    def test_json_number_scientific_notation_rejected(self):
        # JSON 数字字面量科学计数法：keep 下同样过记法闸门，整单 422
        r = client.post(
            "/api/v1/transpose",
            content=(
                '{"target": "keep", '
                '"right": {"S": 1e0, "C": "2.00", "A": 30}, '
                '"left": {"S": "-1.25", "C": "-0.50", "A": 85}}'
            ).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        assert r.status_code == 422
        assert any("右眼.S" in m and "科学计数法" in m for m in r.json()["detail"])


class TestKeepVerifyEntry:
    """设备录入复核：按原处方重建 keep 期望值（即输入值）并逐字段比较。"""

    def test_mixed_sign_entry_matches_when_reentered_as_is(self):
        # 混合正负柱镜：设备按原样录入即双眼全部吻合
        r = post_verify(
            {"target": KEEP, **MIXED},
            {
                "right": eye("+1.00", "+2.00", 30),
                "left": eye("-1.25", "-0.50", 85),
            },
        )
        assert r.status_code == 200
        assert r.json() == {"match": True, "differences": []}

    def test_single_eye_with_prism_matching_recheck(self):
        # 验收：单眼含棱镜处方完成生成与吻合复核
        prescription = {
            "target": KEEP,
            "scope": "right",
            "right": eye("1.00", "2.00", 30, P="2.00", B="外"),
        }
        r = post_verify(
            prescription,
            {"right": eye("+1.00", "+2.00", 30, P="2.00", B="外")},
        )
        assert r.status_code == 200
        assert r.json() == {"match": True, "differences": []}

    def test_wrong_device_cylinder_reports_field_difference(self):
        # 验收：改错设备柱镜 → 返回该眼 C 字段差异（期望值即原处方柱镜）
        r = post_verify(
            {"target": KEEP, "scope": "left", "left": eye("-1.25", "-0.50", 85)},
            {"left": eye("-1.25", "-0.75", 85)},
        )
        assert r.status_code == 200
        assert r.json() == {
            "match": False,
            "differences": [
                {"eye": "left", "field": "C", "expected": "-0.50", "entered": "-0.75"}
            ],
        }

    def test_transposed_entry_reports_all_optical_fields(self):
        # 设备里被误录成转置后的值：S/C/A 三处差异都要报出
        r = post_verify(
            {"target": KEEP, "right": eye("1.00", "2.00", 30), "left": eye("0.00", "0.00", 0)},
            {
                "right": eye("+3.00", "-2.00", 120),
                "left": eye("0.00", "0.00", 0),
            },
        )
        assert r.status_code == 200
        fields = [(d["eye"], d["field"]) for d in r.json()["differences"]]
        assert fields == [("right", "S"), ("right", "C"), ("right", "A")]

    def test_invalid_entry_rejected_but_prescription_rebuildable(self):
        # 复核录入非法 → 整次 422，不返回比对结果
        r = post_verify(
            {"target": KEEP, **MIXED},
            {"right": eye("1e0", "2.00", 30), "left": eye("-1.25", "-0.50", 85)},
        )
        assert r.status_code == 422
        body = r.json()
        assert "match" not in body and "differences" not in body
        assert any("复核录入.右眼.S" in m for m in body["detail"])

    def test_invalid_keep_prescription_rejected(self):
        r = post_verify(
            {"target": KEEP, "right": eye("1.13", "0.00", 0), "left": eye("0.00", "0.00", 0)},
            {
                "right": eye("1.13", "0.00", 0),
                "left": eye("0.00", "0.00", 0),
            },
        )
        assert r.status_code == 422
        assert any("右眼.S" in m for m in r.json()["detail"])


class TestLegacyTargetsUnchanged:
    """未传新目标值的既有正、负记法请求：响应与引入 keep 前完全一致。"""

    def test_minus_response_unchanged_snapshot(self):
        r = post_transpose({"target": MINUS, **MIXED})
        assert r.status_code == 200
        assert r.json() == {
            "target": "minus",
            "right": {
                "input": {"S": "+1.00", "C": "+2.00", "A": 30},
                "output": {"S": "+3.00", "C": "-2.00", "A": 120},
                "changed": True,
                "check": {
                    "originalAxisDirection": {
                        "degrees": 30,
                        "original": "+1.00",
                        "transposed": "+1.00",
                    },
                    "perpendicularDirection": {
                        "degrees": 120,
                        "original": "+3.00",
                        "transposed": "+3.00",
                    },
                    "equivalent": True,
                },
            },
            "left": {
                "input": {"S": "-1.25", "C": "-0.50", "A": 85},
                "output": {"S": "-1.25", "C": "-0.50", "A": 85},
                "changed": False,
                "check": {
                    "originalAxisDirection": {
                        "degrees": 85,
                        "original": "-1.25",
                        "transposed": "-1.25",
                    },
                    "perpendicularDirection": {
                        "degrees": 175,
                        "original": "-1.75",
                        "transposed": "-1.75",
                    },
                    "equivalent": True,
                },
            },
        }

    def test_plus_single_eye_response_unchanged_snapshot(self):
        r = post_transpose(
            {"target": PLUS, "scope": "right", "right": eye("-3.00", "-1.50", 170)}
        )
        assert r.status_code == 200
        assert r.json() == {
            "target": "plus",
            "scope": "right",
            "right": {
                "input": {"S": "-3.00", "C": "-1.50", "A": 170},
                "output": {"S": "-4.50", "C": "+1.50", "A": 80},
                "changed": True,
                "check": {
                    "originalAxisDirection": {
                        "degrees": 170,
                        "original": "-3.00",
                        "transposed": "-3.00",
                    },
                    "perpendicularDirection": {
                        "degrees": 80,
                        "original": "-4.50",
                        "transposed": "-4.50",
                    },
                    "equivalent": True,
                },
            },
        }


class TestKeepPureFunction:
    def test_matches_http(self):
        payload = {"target": KEEP, **MIXED}
        assert transpose_prescription(payload) == post_transpose(payload).json()

    def test_verify_matches_http(self):
        payload = {
            "prescription": {"target": KEEP, **MIXED},
            "entry": {
                "right": eye("+1.00", "+2.00", 30),
                "left": eye("-1.25", "-0.50", 85),
            },
        }
        assert verify_entry(payload) == post_verify(
            payload["prescription"], payload["entry"]
        ).json()

    def test_invalid_keep_raises(self):
        with pytest.raises(PrescriptionError):
            transpose_prescription(
                {"target": KEEP, "right": eye("1e0", "0.00", 0), "left": eye("0.00", "0.00", 0)}
            )

    def test_json_float_literal_fixed_point_kept(self):
        # 定点写法的 JSON 数字字面量在 keep 下原样通过
        res = transpose_prescription(
            {
                "target": KEEP,
                "right": {"S": JsonFloatLiteral("1.5"), "C": JsonFloatLiteral("0.5"), "A": 30},
                "left": eye("0.00", "0.00", 0),
            }
        )
        assert res["right"]["output"] == {"S": "+1.50", "C": "+0.50", "A": 30}
