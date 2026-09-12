import { RejectionError, TransposeResponse } from "./types";

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

/**
 * 单次提交双眼处方与目标记法。
 * 页面不做任何换算，全部结果由后端返回并原样展示。
 */
export async function transposePrescription(
  req: TransposeRequest,
): Promise<TransposeResponse> {
  let res: Response;
  try {
    res = await fetch("/api/v1/transpose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
  } catch {
    throw new Error("无法连接核对服务，请稍后重试");
  }

  if (res.status === 422) {
    const body: unknown = await res.json().catch(() => null);
    const detail =
      body && typeof body === "object"
        ? (body as { detail?: unknown }).detail
        : undefined;
    const reasons = Array.isArray(detail)
      ? detail.map((d) => (typeof d === "string" ? d : JSON.stringify(d)))
      : ["处方不合规，已被拒绝"];
    throw new RejectionError(reasons);
  }
  if (!res.ok) {
    throw new Error(`核对服务异常（HTTP ${res.status}）`);
  }
  return (await res.json()) as TransposeResponse;
}
