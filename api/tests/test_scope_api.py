"""加工范围（单眼处方）：scope 解析、所选眼校验与返回、复核范围及旧契约兼容。"""
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.transpose import PrescriptionError, transpose_prescription, verify_entry

client = TestClient(app)

MINUS = "minus"
PLUS = "plus"


def eye(s="1.00", c="2.00", a=30, **extra):
    e = {"S": s, "C": c, "A": a}
    e.update(extra)
    return e


def rx_right(right=None, target=MINUS, **kw):
    # 仅右眼加工：右眼为正柱镜（转置为 +3.00/-2.00/120）
    return {
        "target": target,
        "scope": "right",
        "right": right if right is not None else eye(),
        **kw,
    }


def rx_left(left=None, target=MINUS, **kw):
    # 仅左眼加工：左眼为负柱镜（原样返回）
    return {
        "target": target,
        "scope": "left",
        "left": left if left is not None else eye("-1.25", "-0.50", 85),
        **kw,
    }


def post_transpose(payload):
    return client.post("/api/v1/transpose", json=payload)


def post_verify(prescription, entry):
    return client.post(
        "/api/v1/verify-entry", json={"prescription": prescription, "entry": entry}
    )


class TestScopeTranspose:
    def test_right_only_returns_only_right(self):
        r = post_transpose(rx_right())
        assert r.status_code == 200
        body = r.json()
        # 仅返回所选眼结果，并回传加工范围
        assert set(body.keys()) == {"target", "scope", "right"}
        assert body["scope"] == "right"
        assert body["right"]["input"] == {"S": "+1.00", "C": "+2.00", "A": 30}
        assert body["right"]["output"] == {"S": "+3.00", "C": "-2.00", "A": 120}
        assert body["right"]["changed"] is True
        assert body["right"]["check"]["equivalent"] is True

    def test_left_only_returns_only_left(self):
        r = post_transpose(rx_left())
        assert r.status_code == 200
        body = r.json()
        assert set(body.keys()) == {"target", "scope", "left"}
        assert body["scope"] == "left"
        assert body["left"]["output"] == {"S": "-1.25", "C": "-0.50", "A": 85}
        assert body["left"]["changed"] is False

    def test_other_eye_absent_not_required(self):
        # 单眼范围：另一眼整个缺失也不阻断生成
        assert post_transpose(rx_right()).status_code == 200
        assert post_transpose(rx_left()).status_code == 200

    @pytest.mark.parametrize("other", ["garbage", 5, {"S": "1e0"}, {"S": ""}, None])
    def test_other_eye_data_ignored(self, other):
        # 另一眼即使携带非法或空白数据也不参与校验
        r = post_transpose(rx_right(left=other))
        assert r.status_code == 200
        assert "left" not in r.json()
        r = post_transpose(rx_left(right=other))
        assert r.status_code == 200
        assert "right" not in r.json()

    def test_no_scope_returns_original_structure(self):
        # 未传加工范围的旧请求：按双眼契约解析并返回原结构（无 scope 字段）
        r = post_transpose(
            {"target": MINUS, "right": eye(), "left": eye("-1.25", "-0.50", 85)}
        )
        assert r.status_code == 200
        body = r.json()
        assert set(body.keys()) == {"target", "right", "left"}
        assert "scope" not in body

    def test_explicit_both_behaves_like_legacy(self):
        payload = {
            "target": MINUS,
            "scope": "both",
            "right": eye(),
            "left": eye("-1.25", "-0.50", 85),
        }
        r = post_transpose(payload)
        assert r.status_code == 200
        assert set(r.json().keys()) == {"target", "right", "left"}
        # 显式双眼同样两眼必填
        assert post_transpose({"target": MINUS, "scope": "both", "right": eye()}).status_code == 422

    @pytest.mark.parametrize("scope", ["Right", "RIGHT", "both ", "", None, 0, ["right"]])
    def test_invalid_scope_rejected(self, scope):
        payload = rx_right()
        payload["scope"] = scope
        r = post_transpose(payload)
        assert r.status_code == 422
        assert any("scope" in m for m in r.json()["detail"])

    def test_single_eye_uses_same_integer_rules(self):
        # 同一套校验：科学计数法、轴位联动、转置后 S' 超界在单眼范围照常拒绝
        r = post_transpose(rx_right(right=eye("1e0", "0.00", 0)))
        assert r.status_code == 422
        assert any("右眼.S" in m and "科学计数法" in m for m in r.json()["detail"])

        r = post_transpose(rx_left(left=eye("-1.25", "0.00", 90)))
        assert r.status_code == 422
        assert any("左眼.A" in m and "必须为 0" in m for m in r.json()["detail"])

        r = post_transpose(rx_right(right=eye("20.00", "0.25", 45)))
        assert r.status_code == 422
        assert "S'=+20.25" in str(r.json()["detail"])

    def test_single_eye_quarter_arithmetic_exact(self):
        r = post_transpose(rx_right(right=eye("0.25", "0.25", 10)))
        assert r.status_code == 200
        assert r.json()["right"]["output"] == {"S": "+0.50", "C": "-0.25", "A": 100}

    def test_single_eye_prism_carried_unchanged(self):
        r = post_transpose(rx_right(right=eye(P="2.00", B="外")))
        assert r.status_code == 200
        assert r.json()["right"]["prism"] == {"P": "+2.00", "B": "外"}

    def test_single_eye_prism_rules_apply(self):
        r = post_transpose(rx_left(left=eye("-1.25", "-0.50", 85, P="0.00", B="上")))
        assert r.status_code == 422
        assert any("左眼.B" in m for m in r.json()["detail"])

    def test_invalid_selected_eye_rejects_whole_order(self):
        r = post_transpose(rx_left(left=eye("1.13", "0.00", 0)))
        assert r.status_code == 422
        body = r.json()
        assert "right" not in body and "left" not in body and "scope" not in body
        assert any("左眼.S" in m for m in body["detail"])

    def test_missing_selected_eye_rejected(self):
        r = post_transpose({"target": MINUS, "scope": "right"})
        assert r.status_code == 422
        assert any("右眼" in m for m in r.json()["detail"])

    def test_plus_target_single_eye(self):
        r = post_transpose(rx_left(target=PLUS, left=eye("-3.00", "-1.50", 170)))
        assert r.status_code == 200
        assert r.json()["left"]["output"] == {"S": "-4.50", "C": "+1.50", "A": 80}

    def test_pure_function_matches_http(self):
        assert transpose_prescription(rx_right()) == post_transpose(rx_right()).json()
        assert transpose_prescription(rx_left()) == post_transpose(rx_left()).json()

    def test_invalid_scope_raises(self):
        with pytest.raises(PrescriptionError):
            transpose_prescription({"target": MINUS, "scope": "right-ish", "right": eye()})


class TestScopeVerifyEntry:
    """复核只针对当前加工范围重算与比较，差异沿用现有眼别与字段契约。"""

    def test_right_scope_match(self):
        # 右眼吻合即整单吻合：结论来自当前加工范围（仅右眼）
        r = post_verify(rx_right(), {"right": eye("+3.00", "-2.00", 120)})
        assert r.status_code == 200
        assert r.json() == {"match": True, "differences": []}

    def test_right_scope_ignores_left_entry(self):
        # 加工范围外的左眼即使携带非法数据也不参与复核
        r = post_verify(
            rx_right(),
            {"right": eye("+3.00", "-2.00", 120), "left": {"S": "1e0"}},
        )
        assert r.status_code == 200
        assert r.json() == {"match": True, "differences": []}

    def test_left_scope_field_mismatch(self):
        # 左眼字段不符：差异以现有眼别与字段契约报告，结论来自仅左眼范围
        r = post_verify(rx_left(), {"left": eye("-1.50", "-0.50", 85)})
        assert r.status_code == 200
        assert r.json() == {
            "match": False,
            "differences": [
                {"eye": "left", "field": "S", "expected": "-1.25", "entered": "-1.50"}
            ],
        }

    def test_left_scope_ignores_right_entry(self):
        r = post_verify(
            rx_left(),
            {"left": eye("-1.25", "-0.50", 85), "right": "garbage"},
        )
        assert r.status_code == 200
        assert r.json() == {"match": True, "differences": []}

    def test_right_scope_axis_mismatch_reported_as_integers(self):
        r = post_verify(rx_right(), {"right": eye("+3.00", "-2.00", 102)})
        assert r.json()["differences"] == [
            {"eye": "right", "field": "A", "expected": 120, "entered": 102}
        ]

    def test_single_eye_prism_compared(self):
        prescription = rx_right(right=eye(P="2.00", B="外"))
        r = post_verify(
            prescription, {"right": eye("+3.00", "-2.00", 120, P="2.00", B="内")}
        )
        assert r.status_code == 200
        assert r.json()["differences"] == [
            {"eye": "right", "field": "B", "expected": "外", "entered": "内"}
        ]

    def test_missing_selected_entry_eye_rejected(self):
        r = post_verify(rx_right(), {})
        assert r.status_code == 422
        assert any("复核录入.右眼" in m for m in r.json()["detail"])

    def test_invalid_selected_entry_rejected(self):
        r = post_verify(rx_left(), {"left": eye("5e-1", "-0.50", 85)})
        assert r.status_code == 422
        body = r.json()
        assert "match" not in body and "differences" not in body
        assert any("复核录入.左眼.S" in m for m in body["detail"])

    def test_invalid_single_eye_prescription_rejected(self):
        r = post_verify(rx_right(right=eye("1.13", "0.00", 0)),
                        {"right": eye("+3.00", "-2.00", 120)})
        assert r.status_code == 422
        assert any("右眼.S" in m for m in r.json()["detail"])

    def test_legacy_request_without_scope_still_needs_both_entries(self):
        # 未传加工范围的旧处方：复核仍按双眼契约要求两眼录入
        prescription = {"target": MINUS, "right": eye(), "left": eye("-1.25", "-0.50", 85)}
        r = post_verify(prescription, {"right": eye("+3.00", "-2.00", 120)})
        assert r.status_code == 422
        assert any("复核录入.左眼" in m for m in r.json()["detail"])

    def test_pure_function_matches_http(self):
        payload = {
            "prescription": rx_right(),
            "entry": {"right": eye("+3.00", "-2.00", 120)},
        }
        assert verify_entry(payload) == post_verify(
            payload["prescription"], payload["entry"]
        ).json()

    def test_invalid_single_eye_entry_raises(self):
        with pytest.raises(PrescriptionError):
            verify_entry(
                {
                    "prescription": rx_left(),
                    "entry": {"left": eye("abc", "-0.50", 85)},
                }
            )
