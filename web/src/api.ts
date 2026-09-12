import { RejectionError, TransposeResponse, VerifyEntryResponse } from "./types";

export interface EyePayload {
  S: string;
  C: string;
  A: string;
}

export interface TransposeRequest {
  target: "plus" | "minus";
  right: EyePayload;
  left: EyePayload;
}

export interface VerifyEntryRequest {
  /** 生成当前磨片参数的那次原转置请求 */
  prescription: TransposeRequest;
  /** 操作员抄入设备后再次录入的双眼 S/C/A */
  entry: { right: EyePayload; left: EyePayload };
}

/** 共用 POST：422 抛 RejectionError（保留全部原因），其它失败抛 Error */
async function postJson<T>(url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("无法连接核对服务，请稍后重试");
  }

  if (res.status === 422) {
    const payload: unknown = await res.json().catch(() => null);
    const detail =
      payload && typeof payload === "object"
        ? (payload as { detail?: unknown }).detail
        : undefined;
    const reasons = Array.isArray(detail)
      ? detail.map((d) => (typeof d === "string" ? d : JSON.stringify(d)))
      : ["处方不合规，已被拒绝"];
    throw new RejectionError(reasons);
  }
  if (!res.ok) {
    throw new Error(`核对服务异常（HTTP ${res.status}）`);
  }
  return (await res.json()) as T;
}

/**
 * 单次提交双眼处方与目标记法。
 * 页面不做任何换算，全部结果由后端返回并原样展示。
 */
export async function transposePrescription(
  req: TransposeRequest,
): Promise<TransposeResponse> {
  return postJson<TransposeResponse>("/api/v1/transpose", req);
}

/**
 * 双眼录入复核：携带原转置请求与操作员录入值，
 * 由后端重算期望值并逐字段比较，页面只展示比对结论。
 */
export async function verifyEntry(
  req: VerifyEntryRequest,
): Promise<VerifyEntryResponse> {
  return postJson<VerifyEntryResponse>("/api/v1/verify-entry", req);
}
