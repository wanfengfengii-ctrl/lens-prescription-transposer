import { RejectionError, TargetNotation, TransposeResponse, VerifyEntryResponse } from "./types";

export interface EyePayload {
  S: string;
  C: string;
  A: string;
  /** 可选棱镜度数（0.00–10.00，步长 0.25）；未展开棱镜录入时不携带 */
  P?: string;
  /** 可选棱镜基底方向（上/下/内/外）；零度棱镜不接受方向 */
  B?: string;
}

export interface TransposeRequest {
  /** 目标记法：plus 正柱镜 / minus 负柱镜 / keep 保持原记法（不转换符号） */
  target: TargetNotation;
  /** 加工范围：仅单眼时携带（right/left）；双眼为默认值，不携带以保持旧契约 */
  scope?: "right" | "left";
  /** 双眼处方含两眼；单眼处方仅携带所选眼，另一眼不随请求发出 */
  right?: EyePayload;
  left?: EyePayload;
}

export interface VerifyEntryRequest {
  /** 生成当前磨片参数的那次原转置请求 */
  prescription: TransposeRequest;
  /** 操作员抄入设备后再次录入的 S/C/A（仅当前加工范围内的眼别） */
  entry: { right?: EyePayload; left?: EyePayload };
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
 * 提交处方与目标记法（默认双眼；单眼处方携带 scope 且只发所选眼）。
 * 页面不做任何换算，全部结果由后端返回并原样展示。
 */
export async function transposePrescription(
  req: TransposeRequest,
): Promise<TransposeResponse> {
  return postJson<TransposeResponse>("/api/v1/transpose", req);
}

/**
 * 设备录入复核：携带原转置请求与操作员录入值（仅当前加工范围内的眼别），
 * 由后端重算期望值并逐字段比较，页面只展示比对结论。
 */
export async function verifyEntry(
  req: VerifyEntryRequest,
): Promise<VerifyEntryResponse> {
  return postJson<VerifyEntryResponse>("/api/v1/verify-entry", req);
}
