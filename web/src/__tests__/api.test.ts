import { afterEach, describe, expect, it, vi } from "vitest";
import { transposePrescription, verifyEntry } from "../api";
import { RejectionError, TransposeResponse, VerifyEntryResponse } from "../types";

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const OK_BODY: TransposeResponse = {
  target: "minus",
  right: {
    input: { S: "+1.00", C: "+2.00", A: 30 },
    output: { S: "+3.00", C: "-2.00", A: 120 },
    changed: true,
    check: {
      originalAxisDirection: { degrees: 30, original: "+1.00", transposed: "+1.00" },
      perpendicularDirection: { degrees: 120, original: "+3.00", transposed: "+3.00" },
      equivalent: true,
    },
  },
  left: {
    input: { S: "-1.25", C: "-0.50", A: 85 },
    output: { S: "-1.25", C: "-0.50", A: 85 },
    changed: false,
    check: {
      originalAxisDirection: { degrees: 85, original: "-1.25", transposed: "-1.25" },
      perpendicularDirection: { degrees: 175, original: "-1.75", transposed: "-1.75" },
      equivalent: true,
    },
  },
};

const REQUEST = {
  target: "minus" as const,
  right: { S: "1.00", C: "2.00", A: "30" },
  left: { S: "-1.25", C: "-0.50", A: "85" },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("transposePrescription", () => {
  it("成功时返回后端 JSON，并按约定发起单次 POST", async () => {
    const fetchMock = vi.fn(async () => fakeResponse(200, OK_BODY));
    vi.stubGlobal("fetch", fetchMock);

    const res = await transposePrescription(REQUEST);

    expect(res).toEqual(OK_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/transpose");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual(REQUEST);
  });

  it("422 且 detail 为字符串数组时抛出 RejectionError 并保留全部原因", async () => {
    const reasons = ["右眼.S: 必须是 0.25 的整数倍", "左眼.A: C 为零时 A 必须为 0"];
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse(422, { detail: reasons })));

    const err = await transposePrescription(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RejectionError);
    expect((err as RejectionError).reasons).toEqual(reasons);
  });

  it("422 且 detail 结构异常时仍抛出 RejectionError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => fakeResponse(422, { detail: [{ loc: ["body"], msg: "bad" }] })),
    );
    const err = await transposePrescription(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RejectionError);
    expect((err as RejectionError).reasons).toHaveLength(1);
  });

  it("非 422 的错误状态码抛出带状态码的 Error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse(500, {})));
    await expect(transposePrescription(REQUEST)).rejects.toThrow("500");
  });

  it("网络不可达时抛出连接错误", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(transposePrescription(REQUEST)).rejects.toThrow("无法连接核对服务");
  });

  it("单眼处方：原样携带 scope 且只发所选眼", async () => {
    const singleEyeResponse = {
      target: "minus",
      scope: "right",
      right: OK_BODY.right,
    };
    const fetchMock = vi.fn(async () => fakeResponse(200, singleEyeResponse));
    vi.stubGlobal("fetch", fetchMock);

    const req = {
      target: "minus" as const,
      scope: "right" as const,
      right: { S: "1.00", C: "2.00", A: "30" },
    };
    const res = await transposePrescription(req);

    expect(res).toEqual(singleEyeResponse);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toEqual(req);
    expect(body).not.toHaveProperty("left");
  });
});

describe("verifyEntry", () => {
  const VERIFY_REQUEST = {
    prescription: REQUEST,
    entry: {
      right: { S: "+3.00", C: "-2.00", A: "120" },
      left: { S: "-1.25", C: "-0.50", A: "85" },
    },
  };

  const MATCH_BODY: VerifyEntryResponse = { match: true, differences: [] };

  it("成功时返回比对结论，并携带原转置请求与录入值", async () => {
    const fetchMock = vi.fn(async () => fakeResponse(200, MATCH_BODY));
    vi.stubGlobal("fetch", fetchMock);

    const res = await verifyEntry(VERIFY_REQUEST);

    expect(res).toEqual(MATCH_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/verify-entry");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(VERIFY_REQUEST);
  });

  it("不吻合时返回逐字段差异", async () => {
    const body: VerifyEntryResponse = {
      match: false,
      differences: [
        { eye: "right", field: "S", expected: "+3.00", entered: "+3.25" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse(200, body)));

    const res = await verifyEntry(VERIFY_REQUEST);
    expect(res.match).toBe(false);
    expect(res.differences).toHaveLength(1);
    expect(res.differences[0]).toEqual({
      eye: "right",
      field: "S",
      expected: "+3.00",
      entered: "+3.25",
    });
  });

  it("录入不合法 → 422 抛出 RejectionError 并保留原因", async () => {
    const reasons = ["复核录入.右眼.S: 必须是十进制定点数（不接受科学计数法），收到 '1e0'"];
    vi.stubGlobal("fetch", vi.fn(async () => fakeResponse(422, { detail: reasons })));

    const err = await verifyEntry(VERIFY_REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RejectionError);
    expect((err as RejectionError).reasons).toEqual(reasons);
  });

  it("网络不可达时抛出连接错误", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(verifyEntry(VERIFY_REQUEST)).rejects.toThrow("无法连接核对服务");
  });

  it("单眼复核：录入值只携带当前加工范围内的眼别", async () => {
    const fetchMock = vi.fn(async () => fakeResponse(200, MATCH_BODY));
    vi.stubGlobal("fetch", fetchMock);

    const singleEyeVerify = {
      prescription: {
        target: "minus" as const,
        scope: "left" as const,
        left: { S: "-1.25", C: "-0.50", A: "85" },
      },
      entry: { left: { S: "-1.25", C: "-0.50", A: "85" } },
    };
    const res = await verifyEntry(singleEyeVerify);

    expect(res).toEqual(MATCH_BODY);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toEqual(singleEyeVerify);
    expect(body.prescription).not.toHaveProperty("right");
    expect(body.entry).not.toHaveProperty("right");
  });
});
