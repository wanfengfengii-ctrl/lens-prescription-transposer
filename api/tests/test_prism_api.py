"""棱镜补偿：可选度数 P 与基底方向 B 的校验、原样携带与复核比对。"""
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.transpose import PrescriptionError, transpose_prescription, verify_entry

client = TestClient(app)

MINUS = "minus"
PLUS = "plus"


def eye(s="1.00", c="2.00", a=30, p=None, b=None):
    e = {"S": s, "C": c, "A": a}
    if p is not None:
        e["P"] = p
    if b is not None:
        e["B"] = b
    return e


def rx(target=MINUS, right=None, left=None):
    return {
        "target": target,
        # 默认右眼为正柱镜（会被转置），左眼为负柱镜（原样返回）
        "right": right if right is not None else eye(),
        "left": left if left is not None else eye("-1.25", "-0.50", 85),
    }


def post_transpose(payload):
    return client.post("/api/v1/transpose", json=payload)


def post_verify(prescription, entry):
    return client.post(
        "/api/v1/verify-entry", json={"prescription": prescription, "entry": entry}
    )


class TestPrismTranspose:
    def test_prism_carried_through_unchanged(self):
        r = post_transpose(rx(right=eye(p="2.00", b="外")))
        assert r.status_code == 200
        right = r.json()["right"]
        # 球柱镜照常转置，棱镜原样返回、不参与换算
        assert right["output"] == {"S": "+3.00", "C": "-2.00", "A": 120}
        assert right["prism"] == {"P": "+2.00", "B": "外"}
        # 未携带棱镜的左眼省略棱镜字段
        assert "prism" not in r.json()["left"]

    def test_prism_on_both_eyes(self):
        r = post_transpose(
            rx(right=eye(p="2.00", b="外"), left=eye("-1.25", "-0.50", 85, p="0.50", b="上"))
        )
        assert r.status_code == 200
        assert r.json()["right"]["prism"] == {"P": "+2.00", "B": "外"}
        assert r.json()["left"]["prism"] == {"P": "+0.50", "B": "上"}

    @pytest.mark.parametrize("base", ["上", "下", "内", "外"])
    def test_all_base_directions_accepted(self, base):
        r = post_transpose(rx(right=eye(p="1.00", b=base)))
        assert r.status_code == 200
        assert r.json()["right"]["prism"]["B"] == base

    def test_zero_prism_without_direction_ok(self):
        r = post_transpose(rx(right=eye(p="0.00")))
        assert r.status_code == 200
        assert r.json()["right"]["prism"] == {"P": "0.00"}

    def test_prism_normalized_to_two_decimals(self):
        r = post_transpose(rx(right=eye(p="2", b="内")))
        assert r.json()["right"]["prism"]["P"] == "+2.00"

    def test_no_prism_omits_prism_fields(self):
        # 未填写棱镜的旧请求：按原契约成功，响应省略棱镜字段
        r = post_transpose(rx())
        assert r.status_code == 200
        body = r.json()
        assert "prism" not in body["right"] and "prism" not in body["left"]

    def test_prism_does_not_affect_transposition(self):
        plain = post_transpose(rx()).json()
        with_prism = post_transpose(
            rx(right=eye(p="3.25", b="下"), left=eye("-1.25", "-0.50", 85, p="1.00", b="内"))
        ).json()
        for side in ("right", "left"):
            assert with_prism[side]["input"] == plain[side]["input"]
            assert with_prism[side]["output"] == plain[side]["output"]
            assert with_prism[side]["changed"] == plain[side]["changed"]
            assert with_prism[side]["check"] == plain[side]["check"]

    def test_blank_prism_fields_treated_as_absent(self):
        # 展开但未填写的棱镜（空字符串 / null）视为未携带
        e = eye()
        e["P"] = ""
        e["B"] = None
        r = post_transpose(rx(right=e))
        assert r.status_code == 200
        assert "prism" not in r.json()["right"]


class TestPrismValidation:
    @pytest.mark.parametrize(
        "p,b",
        [("0.00", None), ("0.25", "外"), ("5.50", "内"), ("10.00", "上"), (2, "下"), (1.5, "外")],
    )
    def test_power_in_range_accepted(self, p, b):
        assert post_transpose(rx(right=eye(p=p, b=b))).status_code == 200

    @pytest.mark.parametrize("p", ["10.25", "-0.25", "20.00", "-1.00"])
    def test_power_out_of_range_rejected(self, p):
        r = post_transpose(rx(right=eye(p=p, b="外")))
        assert r.status_code == 422
        assert any("右眼.P" in m and "0.00 至 +10.00" in m for m in r.json()["detail"])

    @pytest.mark.parametrize("p", ["1.13", "0.3", "0.01"])
    def test_power_non_quarter_step_rejected(self, p):
        r = post_transpose(rx(right=eye(p=p, b="外")))
        assert r.status_code == 422
        assert any("0.25 的整数倍" in m for m in r.json()["detail"])

    @pytest.mark.parametrize("p", ["1e0", "5e-1", "2.5e-2", "abc", True, [1]])
    def test_power_non_decimal_rejected(self, p):
        r = post_transpose(rx(right=eye(p=p, b="外")))
        assert r.status_code == 422
        assert any("右眼.P" in m for m in r.json()["detail"])

    @pytest.mark.parametrize("b", ["左", "右", "内内", "up", "", 5, True])
    def test_invalid_base_rejected(self, b):
        r = post_transpose(rx(right=eye(p="1.00", b=b)))
        if b == "":
            # 空白方向视为未提供 → 非零棱镜缺少方向
            assert r.status_code == 422
            assert any("非零棱镜" in m for m in r.json()["detail"])
        else:
            assert r.status_code == 422
            assert any("右眼.B" in m for m in r.json()["detail"])

    def test_nonzero_prism_requires_base(self):
        r = post_transpose(rx(right=eye(p="2.00")))
        assert r.status_code == 422
        assert any("非零棱镜必须指定基底方向" in m for m in r.json()["detail"])

    def test_zero_prism_rejects_base(self):
        r = post_transpose(rx(right=eye(p="0.00", b="外")))
        assert r.status_code == 422
        assert any("棱镜为零时不接受基底方向" in m for m in r.json()["detail"])

    def test_base_without_power_rejected(self):
        r = post_transpose(rx(right=eye(b="外")))
        assert r.status_code == 422
        assert any("同时提供棱镜度数" in m for m in r.json()["detail"])

    def test_invalid_prism_rejects_whole_prescription(self):
        r = post_transpose(rx(left=eye("-1.25", "-0.50", 85, p="0.00", b="上")))
        assert r.status_code == 422
        body = r.json()
        assert "right" not in body and "left" not in body
        assert any("左眼.B" in m for m in body["detail"])

    def test_prism_error_and_sphere_error_reported_together(self):
        r = post_transpose(rx(right=eye(s="1.13", p="0.00", b="外")))
        detail = r.json()["detail"]
        assert any("右眼.S" in m for m in detail)
        assert any("右眼.B" in m for m in detail)


class TestPrismVerifyEntry:
    """复核时逐眼比较棱镜度数与方向，差异进入现有 differences 契约。"""

    PRISM_RX = rx(
        right=eye(p="2.00", b="外"),
        left=eye("-1.25", "-0.50", 85, p="0.50", b="上"),
    )
    PRISM_ENTRY = {
        "right": eye("+3.00", "-2.00", 120, p="2.00", b="外"),
        "left": eye("-1.25", "-0.50", 85, p="0.50", b="上"),
    }

    def verify(self, entry, prescription=None):
        return post_verify(prescription if prescription is not None else self.PRISM_RX, entry)

    def test_matching_prism_full_match(self):
        r = self.verify(self.PRISM_ENTRY)
        assert r.status_code == 200
        assert r.json() == {"match": True, "differences": []}

    def test_power_mismatch_reported(self):
        entry = {
            "right": eye("+3.00", "-2.00", 120, p="1.75", b="外"),
            "left": eye("-1.25", "-0.50", 85, p="0.50", b="上"),
        }
        r = self.verify(entry)
        assert r.status_code == 200
        assert r.json()["differences"] == [
            {"eye": "right", "field": "P", "expected": "+2.00", "entered": "+1.75"}
        ]

    def test_base_mismatch_reported(self):
        entry = {
            "right": eye("+3.00", "-2.00", 120, p="2.00", b="内"),
            "left": eye("-1.25", "-0.50", 85, p="0.50", b="上"),
        }
        r = self.verify(entry)
        assert r.status_code == 200
        body = r.json()
        assert body["match"] is False
        assert body["differences"] == [
            {"eye": "right", "field": "B", "expected": "外", "entered": "内"}
        ]

    def test_missing_entry_prism_reported_on_both_fields(self):
        entry = {
            "right": eye("+3.00", "-2.00", 120),
            "left": eye("-1.25", "-0.50", 85, p="0.50", b="上"),
        }
        r = self.verify(entry)
        assert r.json()["differences"] == [
            {"eye": "right", "field": "P", "expected": "+2.00", "entered": "0.00"},
            {"eye": "right", "field": "B", "expected": "外", "entered": "无"},
        ]

    def test_unexpected_entry_prism_reported(self):
        # 原处方无棱镜，录入却带棱镜 → 同样报差异
        r = post_verify(rx(), {"right": eye("+3.00", "-2.00", 120, p="1.00", b="外"),
                               "left": eye("-1.25", "-0.50", 85)})
        assert r.json()["differences"] == [
            {"eye": "right", "field": "P", "expected": "0.00", "entered": "+1.00"},
            {"eye": "right", "field": "B", "expected": "无", "entered": "外"},
        ]

    def test_explicit_zero_prism_matches_absent(self):
        # 显式零度与未携带光学等价：无差异
        r = post_verify(rx(), {"right": eye("+3.00", "-2.00", 120, p="0.00"),
                               "left": eye("-1.25", "-0.50", 85)})
        assert r.json() == {"match": True, "differences": []}

    def test_prism_difference_ordered_after_axis(self):
        entry = {
            "right": eye("+3.25", "-2.00", 100, p="1.75", b="内"),
            "left": eye("-1.25", "-0.50", 85, p="0.50", b="上"),
        }
        r = self.verify(entry)
        assert [d["field"] for d in r.json()["differences"]] == ["S", "A", "P", "B"]

    def test_invalid_entry_prism_combination_rejected(self):
        # 零度带方向：整次复核 422，不返回任何比对结果
        entry = {
            "right": eye("+3.00", "-2.00", 120, p="0.00", b="外"),
            "left": eye("-1.25", "-0.50", 85, p="0.50", b="上"),
        }
        r = self.verify(entry)
        assert r.status_code == 422
        body = r.json()
        assert "match" not in body and "differences" not in body
        assert any("复核录入.右眼.B" in m for m in body["detail"])
        assert any("不接受基底方向" in m for m in body["detail"])

    def test_entry_prism_out_of_range_rejected(self):
        entry = {
            "right": eye("+3.00", "-2.00", 120, p="10.25", b="外"),
            "left": eye("-1.25", "-0.50", 85, p="0.50", b="上"),
        }
        r = self.verify(entry)
        assert r.status_code == 422
        assert any("复核录入.右眼.P" in m for m in r.json()["detail"])

    def test_invalid_prescription_prism_rejected(self):
        r = self.verify(self.PRISM_ENTRY, prescription=rx(right=eye(p="0.00", b="外")))
        assert r.status_code == 422
        assert any("右眼.B" in m for m in r.json()["detail"])

    def test_old_style_request_without_prism_still_matches(self):
        r = post_verify(rx(), {"right": eye("+3.00", "-2.00", 120),
                               "left": eye("-1.25", "-0.50", 85)})
        assert r.status_code == 200
        assert r.json() == {"match": True, "differences": []}


class TestPrismPureFunction:
    def test_transpose_matches_http(self):
        payload = rx(right=eye(p="2.00", b="外"))
        assert transpose_prescription(payload) == post_transpose(payload).json()

    def test_verify_matches_http(self):
        payload = {
            "prescription": rx(right=eye(p="2.00", b="外")),
            "entry": {
                "right": eye("+3.00", "-2.00", 120, p="2.00", b="外"),
                "left": eye("-1.25", "-0.50", 85),
            },
        }
        assert verify_entry(payload) == post_verify(
            payload["prescription"], payload["entry"]
        ).json()

    def test_invalid_prism_raises(self):
        with pytest.raises(PrescriptionError):
            transpose_prescription(rx(right=eye(p="0.00", b="外")))
