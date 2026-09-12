import { afterEach, describe, expect, it, vi } from "vitest";
import { transposePrescription } from "../api";
import { RejectionError, TransposeResponse } from "../types";

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
});
