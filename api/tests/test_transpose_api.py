"""转置公式、输入边界、整单原子性与等价校核的测试。"""
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.transpose import PrescriptionError, fmt, transpose_prescription

client = TestClient(app)

MINUS = "minus"
PLUS = "plus"


def eye(s="1.00", c="2.00", a=30):
    return {"S": s, "C": c, "A": a}


def rx(target=MINUS, right=None, left=None):
    return {
        "target": target,
        # 默认右眼为正柱镜（会被转置），左眼为负柱镜（原样返回）
        "right": right if right is not None else eye(),
        "left": left if left is not None else eye("-1.25", "-0.50", 85),
    }


def post(payload):
    return client.post("/api/v1/transpose", json=payload)


class TestFmt:
    @pytest.mark.parametrize(
        "q,expected",
        [
            (0, "0.00"),
            (4, "+1.00"),
            (-4, "-1.00"),
            (1, "+0.25"),
            (-1, "-0.25"),
            (2, "+0.50"),
            (-2, "-0.50"),
            (3, "+0.75"),
            (6, "+1.50"),
            (80, "+20.00"),
            (-80, "-20.00"),
            (-63, "-15.75"),
        ],
    )
    def test_quarters_to_fixed_two_decimals(self, q, expected):
        assert fmt(q) == expected


class TestTransposeFormula:
    def test_plus_to_minus(self):
        r = post(rx())
        assert r.status_code == 200
        right = r.json()["right"]
        assert right["output"] == {"S": "+3.00", "C": "-2.00", "A": 120}
        assert right["changed"] is True

    def test_minus_to_plus(self):
        r = post(rx(target=PLUS, right=eye("-3.00", "-1.50", 170), left=eye("0.00", "0.00", 0)))
        assert r.status_code == 200
        assert r.json()["right"]["output"] == {"S": "-4.50", "C": "+1.50", "A": 80}

    @pytest.mark.parametrize(
        "axis,expected",
        [(1, 91), (30, 120), (90, 180), (91, 1), (150, 60), (180, 90)],
    )
    def test_axis_rotates_90_and_wraps(self, axis, expected):
        r = post(rx(right=eye("0.00", "1.00", axis)))
        assert r.status_code == 200
        assert r.json()["right"]["output"]["A"] == expected

    def test_pure_function_matches_http(self):
        assert transpose_prescription(rx()) == post(rx()).json()


class TestPassthrough:
    def test_zero_cylinder_returned_as_is(self):
        r = post(rx(right=eye("2.50", "0.00", 0)))
        right = r.json()["right"]
        assert right["output"] == {"S": "+2.50", "C": "0.00", "A": 0}
        assert right["changed"] is False

    def test_already_minus_kept_for_minus_target(self):
        r = post(rx(right=eye("-1.25", "-0.50", 85)))
        right = r.json()["right"]
        assert right["input"] == right["output"] == {"S": "-1.25", "C": "-0.50", "A": 85}
        assert right["changed"] is False

    def test_already_plus_kept_for_plus_target(self):
        r = post(rx(target=PLUS, right=eye("1.00", "0.75", 10), left=eye("0.00", "0.00", 0)))
        right = r.json()["right"]
        assert right["output"] == {"S": "+1.00", "C": "+0.75", "A": 10}
        assert right["changed"] is False


class TestBoundaries:
    @pytest.mark.parametrize("s", ["-20.00", "+20.00", "19.75", "-19.75", "0.00"])
    def test_sphere_range_edges_accepted(self, s):
        assert post(rx(right=eye(s, "0.00", 0))).status_code == 200

    @pytest.mark.parametrize("v", ["20.25", "-20.25", "100", "-100", "-0.01"])
    def test_out_of_range_rejected(self, v):
        assert post(rx(right=eye(v, "0.00", 0))).status_code == 422

    def test_transposed_sphere_at_upper_edge_ok(self):
        r = post(rx(right=eye("19.75", "0.25", 45)))
        assert r.status_code == 200
        assert r.json()["right"]["output"]["S"] == "+20.00"

    def test_transposed_sphere_overflow_rejected(self):
        r = post(rx(right=eye("20.00", "0.25", 45)))
        assert r.status_code == 422
        assert "S'=+20.25" in str(r.json()["detail"])

    def test_transposed_sphere_at_lower_edge_ok(self):
        r = post(rx(target=PLUS, right=eye("-19.75", "-0.25", 45), left=eye("0.00", "0.00", 0)))
        assert r.status_code == 200
        assert r.json()["right"]["output"]["S"] == "-20.00"

    def test_transposed_sphere_underflow_rejected(self):
        r = post(rx(target=PLUS, right=eye("-20.00", "-0.25", 45), left=eye("0.00", "0.00", 0)))
        assert r.status_code == 422
        assert "S'=-20.25" in str(r.json()["detail"])


class TestStepAndFormat:
    @pytest.mark.parametrize("v", ["1.13", "0.3", "0.01", "1.255", "-2.675", "0.1"])
    def test_non_quarter_step_rejected(self, v):
        assert post(rx(right=eye(v, "0.00", 0))).status_code == 422

    @pytest.mark.parametrize("v", ["1.25", "-0.75", "0.5", "2", 1.5, -2, "+3.5", " 4.00 "])
    def test_quarter_step_accepted(self, v):
        assert post(rx(right=eye(v, "0.00", 0))).status_code == 200

    @pytest.mark.parametrize("v", ["abc", "", "1e2", "nan", "inf", None, True, [1], {"x": 1}])
    def test_non_decimal_rejected(self, v):
        assert post(rx(right=eye(v, "0.00", 0))).status_code == 422

    def test_output_always_two_decimals(self):
        r = post(rx(right=eye("2", "0.00", 0)))
        assert r.json()["right"]["output"]["S"] == "+2.00"

    def test_quarter_integer_arithmetic_exact(self):
        # 0.25 + 0.25 必须精确等于 0.50（整数运算，无浮点误差）
        r = post(rx(right=eye("0.25", "0.25", 10)))
        assert r.json()["right"]["output"] == {"S": "+0.50", "C": "-0.25", "A": 100}


class TestAxisRules:
    @pytest.mark.parametrize("a", [1, 45, 90, 180, "180", 90.0])
    def test_axis_valid_when_cylinder_nonzero(self, a):
        assert post(rx(right=eye("1.00", "1.00", a))).status_code == 200

    @pytest.mark.parametrize("a", [0, 181, -1, 360, 90.5, "abc", "", None, True])
    def test_axis_invalid_when_cylinder_nonzero(self, a):
        assert post(rx(right=eye("1.00", "1.00", a))).status_code == 422

    def test_axis_must_be_zero_when_cylinder_zero(self):
        assert post(rx(right=eye("1.00", "0.00", 0))).status_code == 200
        r = post(rx(right=eye("1.00", "0.00", 90)))
        assert r.status_code == 422
        assert "必须为 0" in str(r.json()["detail"])

    def test_axis_one_and_180_are_inclusive_bounds(self):
        assert post(rx(right=eye("1.00", "1.00", 1))).status_code == 200
        assert post(rx(right=eye("1.00", "1.00", 180))).status_code == 200


class TestAtomicity:
    def test_invalid_left_rejects_whole_prescription(self):
        r = post(rx(left=eye("1.13", "0.00", 0)))
        assert r.status_code == 422
        body = r.json()
        assert "right" not in body and "left" not in body
        assert any("左眼" in m for m in body["detail"])

    def test_invalid_right_rejects_whole_prescription(self):
        r = post(rx(right=eye("1.00", "1.00", 0)))
        assert r.status_code == 422
        assert "left" not in r.json()

    def test_both_eyes_invalid_reports_both(self):
        r = post(rx(right=eye("1.13", "0.00", 0), left=eye("1.00", "1.00", 0)))
        detail = r.json()["detail"]
        assert any("右眼" in m for m in detail)
        assert any("左眼" in m for m in detail)

    def test_overflow_in_one_eye_hides_the_other(self):
        r = post(rx(right=eye("20.00", "0.25", 45), left=eye("1.00", "-0.50", 90)))
        assert r.status_code == 422
        assert "left" not in r.json() and "right" not in r.json()


class TestRequestStructure:
    def test_missing_eye_rejected(self):
        assert post({"target": "minus", "right": eye()}).status_code == 422

    def test_missing_field_rejected(self):
        e = eye()
        del e["S"]
        r = post(rx(right=e))
        assert r.status_code == 422
        assert any("缺少必填字段" in m for m in r.json()["detail"])

    @pytest.mark.parametrize("target", ["Minus", "PLUS", "", None, 0])
    def test_bad_target_rejected(self, target):
        assert post(rx(target=target)).status_code == 422

    def test_non_object_eye_rejected(self):
        assert post({"target": "minus", "right": 5, "left": eye()}).status_code == 422

    def test_non_object_body_rejected(self):
        assert client.post("/api/v1/transpose", json=[1, 2, 3]).status_code == 422

    def test_invalid_json_rejected(self):
        r = client.post(
            "/api/v1/transpose",
            content=b"{not json",
            headers={"Content-Type": "application/json"},
        )
        assert r.status_code == 422

    def test_health(self):
        assert client.get("/api/health").json() == {"status": "ok"}


class TestEquivalenceCheck:
    def test_check_powers_match_after_transposition(self):
        r = post(rx())
        chk = r.json()["right"]["check"]
        # 原轴方向 30°：原处方 S=+1.00，转置后 S'+C'=+1.00
        assert chk["originalAxisDirection"] == {
            "degrees": 30,
            "original": "+1.00",
            "transposed": "+1.00",
        }
        # 垂直方向 120°：原处方 S+C=+3.00，转置后 S'=+3.00
        assert chk["perpendicularDirection"] == {
            "degrees": 120,
            "original": "+3.00",
            "transposed": "+3.00",
        }
        assert chk["equivalent"] is True

    def test_check_for_unchanged_eye(self):
        r = post(rx())
        chk = r.json()["left"]["check"]
        assert chk["originalAxisDirection"] == {
            "degrees": 85,
            "original": "-1.25",
            "transposed": "-1.25",
        }
        assert chk["perpendicularDirection"] == {
            "degrees": 175,
            "original": "-1.75",
            "transposed": "-1.75",
        }
        assert chk["equivalent"] is True

    @pytest.mark.parametrize(
        "s,c,a",
        [
            ("0.25", "0.25", 10),
            ("-5.50", "2.75", 179),
            ("3.00", "-3.00", 5),
            ("-20.00", "0.25", 180),
            ("20.00", "-0.25", 1),
        ],
    )
    def test_equivalence_holds_for_both_targets(self, s, c, a):
        for target in (MINUS, PLUS):
            res = transpose_prescription(
                {"target": target, "right": eye(s, c, a), "left": eye("0.00", "0.00", 0)}
            )
            chk = res["right"]["check"]
            assert chk["equivalent"] is True
            assert (
                chk["originalAxisDirection"]["original"]
                == chk["originalAxisDirection"]["transposed"]
            )
            assert (
                chk["perpendicularDirection"]["original"]
                == chk["perpendicularDirection"]["transposed"]
            )

    def test_invalid_prescription_raises(self):
        with pytest.raises(PrescriptionError):
            transpose_prescription(
                {"target": "minus", "right": eye("1.13", "0.00", 0), "left": eye()}
            )
