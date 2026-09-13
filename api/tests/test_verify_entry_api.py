"""双眼录入复核：吻合判定、逐字段差异、非法录入整次 422 的测试。"""
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.transpose import PrescriptionError, verify_entry

client = TestClient(app)

MINUS = "minus"
PLUS = "plus"


def eye(s="1.00", c="2.00", a=30):
    return {"S": s, "C": c, "A": a}


def rx(target=MINUS, right=None, left=None):
    return {
        "target": target,
        # 默认右眼正柱镜（转置为 +3.00/-2.00/120），左眼负柱镜（原样返回）
        "right": right if right is not None else eye(),
        "left": left if left is not None else eye("-1.25", "-0.50", 85),
    }


def entry(right=None, left=None):
    return {
        "right": right if right is not None else eye("+3.00", "-2.00", 120),
        "left": left if left is not None else eye("-1.25", "-0.50", 85),
    }


def post(payload):
    return client.post("/api/v1/verify-entry", json=payload)


def verify(payload=None):
    return post({"prescription": rx(), "entry": payload if payload is not None else entry()})


class TestFullMatch:
    def test_all_fields_match(self):
        r = verify()
        assert r.status_code == 200
        body = r.json()
        assert body == {"match": True, "differences": []}

    def test_equivalent_literals_match(self):
        # 同一数值的不同合法写法（前导零、加号、空白）不影响整数比较
        r = verify(entry(right=eye("3", "-2", "120"), left=eye(" -1.25 ", "-.5", 85)))
        assert r.status_code == 200
        assert r.json() == {"match": True, "differences": []}

    def test_zero_cylinder_match(self):
        r = post(
            {
                "prescription": rx(right=eye("2.50", "0.00", 0), left=eye("0.00", "0.00", 0)),
                "entry": entry(right=eye("2.50", "0.00", 0), left=eye("0.00", "0.00", 0)),
            }
        )
        assert r.status_code == 200
        assert r.json()["match"] is True

    def test_plus_target_match(self):
        r = post(
            {
                "prescription": rx(
                    target=PLUS,
                    right=eye("-3.00", "-1.50", 170),
                    left=eye("0.00", "0.00", 0),
                ),
                "entry": entry(right=eye("-4.50", "1.50", 80), left=eye("0.00", "0.00", 0)),
            }
        )
        assert r.status_code == 200
        assert r.json()["match"] is True


class TestDifferences:
    def test_single_eye_single_field_mismatch(self):
        # 右眼 S 录入 +3.25，期望 +3.00：仅一处差异
        r = verify(entry(right=eye("+3.25", "-2.00", 120)))
        assert r.status_code == 200
        body = r.json()
        assert body["match"] is False
        assert body["differences"] == [
            {"eye": "right", "field": "S", "expected": "+3.00", "entered": "+3.25"}
        ]

    def test_axis_mismatch_reported_as_integers(self):
        r = verify(entry(left=eye("-1.25", "-0.50", 58)))
        assert r.status_code == 200
        assert r.json()["differences"] == [
            {"eye": "left", "field": "A", "expected": 85, "entered": 58}
        ]

    def test_swapped_eyes_reported_on_both(self):
        # 左右眼抄串：两眼所有非零字段均报差异
        r = verify(
            entry(
                right=eye("-1.25", "-0.50", 85),
                left=eye("+3.00", "-2.00", 120),
            )
        )
        assert r.status_code == 200
        body = r.json()
        assert body["match"] is False
        eyes = {d["eye"] for d in body["differences"]}
        assert eyes == {"right", "left"}

    def test_multiple_fields_ordered_right_then_left(self):
        r = verify(
            entry(
                right=eye("+3.25", "-2.25", 100),
                left=eye("-1.50", "-0.50", 85),
            )
        )
        assert r.status_code == 200
        assert r.json()["differences"] == [
            {"eye": "right", "field": "S", "expected": "+3.00", "entered": "+3.25"},
            {"eye": "right", "field": "C", "expected": "-2.00", "entered": "-2.25"},
            {"eye": "right", "field": "A", "expected": 120, "entered": 100},
            {"eye": "left", "field": "S", "expected": "-1.25", "entered": "-1.50"},
        ]

    def test_entered_values_normalized_in_report(self):
        # 录入 "3.25"（无加号）与期望比较时，报告中统一为固定两位小数
        r = verify(entry(right=eye("3.5", "-2.00", 120)))
        assert r.json()["differences"][0]["entered"] == "+3.50"


class TestEntryValidation:
    """录入值不合法 → 整次复核 422，不返回任何比对结果。"""

    @pytest.mark.parametrize("v", ["1e0", "5e-1", "2.5e-2", "abc", "", None, True])
    def test_malformed_sphere_rejected(self, v):
        r = verify(entry(right=eye(v, "-2.00", 120)))
        assert r.status_code == 422
        body = r.json()
        assert "match" not in body and "differences" not in body
        assert any("复核录入.右眼.S" in m for m in body["detail"])

    @pytest.mark.parametrize("literal", ["3e0", "1e0", "5e-1", "2.5e-2"])
    def test_json_number_scientific_notation_rejected(self, literal):
        # 录入值以 JSON 数字字面量写成科学计数法：数值即使与期望吻合也整次 422
        r = client.post(
            "/api/v1/verify-entry",
            content=(
                '{"prescription": {"target": "minus", '
                '"right": {"S": "1.00", "C": "2.00", "A": 30}, '
                '"left": {"S": "-1.25", "C": "-0.50", "A": 85}}, '
                f'"entry": {{"right": {{"S": {literal}, "C": "-2.00", "A": 120}}, '
                '"left": {"S": "-1.25", "C": "-0.50", "A": 85}}}'
            ).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        assert r.status_code == 422
        body = r.json()
        assert "match" not in body and "differences" not in body
        assert any("复核录入.右眼.S" in m and "科学计数法" in m for m in body["detail"])

    def test_non_quarter_step_rejected(self):
        r = verify(entry(right=eye("+3.13", "-2.00", 120)))
        assert r.status_code == 422
        assert any("0.25 的整数倍" in m for m in r.json()["detail"])

    def test_out_of_range_rejected(self):
        r = verify(entry(left=eye("-20.25", "-0.50", 85)))
        assert r.status_code == 422
        assert any("复核录入.左眼.S" in m for m in r.json()["detail"])

    def test_axis_rules_apply_to_entry(self):
        # C 非零但 A 为 0：录入本身不构成合法处方
        r = verify(entry(right=eye("+3.00", "-2.00", 0)))
        assert r.status_code == 422
        assert any("复核录入.右眼.A" in m for m in r.json()["detail"])

    def test_both_eyes_invalid_reports_both(self):
        r = verify(entry(right=eye("x", "-2.00", 120), left=eye("-1.25", "y", 85)))
        detail = r.json()["detail"]
        assert any("复核录入.右眼" in m for m in detail)
        assert any("复核录入.左眼" in m for m in detail)

    def test_missing_entry_eye_rejected(self):
        r = post({"prescription": rx(), "entry": {"right": eye("+3.00", "-2.00", 120)}})
        assert r.status_code == 422
        assert any("复核录入.左眼" in m for m in r.json()["detail"])


class TestPrescriptionValidation:
    """复核携带的原转置请求同样走整单校验，不合规即 422。"""

    def test_invalid_prescription_rejected(self):
        r = post({"prescription": rx(left=eye("1.13", "0.00", 0)), "entry": entry()})
        assert r.status_code == 422
        assert any("左眼" in m for m in r.json()["detail"])

    def test_bad_target_rejected(self):
        r = post({"prescription": rx(target="Minus"), "entry": entry()})
        assert r.status_code == 422

    def test_transposed_overflow_rejected(self):
        r = post({"prescription": rx(right=eye("20.00", "0.25", 45)), "entry": entry()})
        assert r.status_code == 422
        assert "S'=+20.25" in str(r.json()["detail"])


class TestRequestStructure:
    def test_missing_prescription_rejected(self):
        r = post({"entry": entry()})
        assert r.status_code == 422
        assert any("prescription" in m for m in r.json()["detail"])

    def test_missing_entry_rejected(self):
        r = post({"prescription": rx()})
        assert r.status_code == 422
        assert any("entry" in m for m in r.json()["detail"])

    def test_non_object_body_rejected(self):
        assert client.post("/api/v1/verify-entry", json=[1, 2, 3]).status_code == 422

    def test_non_object_entry_rejected(self):
        r = post({"prescription": rx(), "entry": 5})
        assert r.status_code == 422

    def test_invalid_json_rejected(self):
        r = client.post(
            "/api/v1/verify-entry",
            content=b"{not json",
            headers={"Content-Type": "application/json"},
        )
        assert r.status_code == 422


class TestPureFunction:
    def test_matches_http(self):
        payload = {"prescription": rx(), "entry": entry()}
        assert verify_entry(payload) == post(payload).json()

    def test_invalid_entry_raises(self):
        with pytest.raises(PrescriptionError):
            verify_entry({"prescription": rx(), "entry": entry(right=eye("1e0", "-2.00", 120))})
