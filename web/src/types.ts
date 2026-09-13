export interface EyeValues {
  S: string;
  C: string;
  A: number;
}

/** 柱镜目标记法：统一为正柱镜 / 统一为负柱镜 / 保持原记法（不转换符号） */
export type TargetNotation = "plus" | "minus" | "keep";

/** 加工范围：双眼（默认）或仅单眼 */
export type ProcessingScope = "both" | "right" | "left";

/** 棱镜基底方向 */
export type PrismBase = "上" | "下" | "内" | "外";

/** 棱镜补偿：原样携带，不参与球柱镜换算；未提供时整个字段省略 */
export interface PrismValues {
  /** 棱镜度数，固定两位小数字符串（0.00 至 +10.00） */
  P: string;
  /** 基底方向；零度棱镜无方向，该字段省略 */
  B?: PrismBase;
}

export interface DirectionCheck {
  degrees: number;
  original: string;
  transposed: string;
}

export interface EyeResult {
  input: EyeValues;
  output: EyeValues;
  changed: boolean;
  prism?: PrismValues;
  check: {
    originalAxisDirection: DirectionCheck;
    perpendicularDirection: DirectionCheck;
    equivalent: boolean;
  };
}

export interface TransposeResponse {
  target: TargetNotation;
  /** 单眼加工时回传的加工范围；双眼请求（旧契约）省略该字段 */
  scope?: "right" | "left";
  /** 双眼结果含两眼；单眼结果仅含所选眼 */
  right?: EyeResult;
  left?: EyeResult;
}

/** 单处录入差异：眼别、字段、期望值与录入值（S/C/P 为两位小数字符串，A 为整数，B 为方向或“无”） */
export interface EntryDifference {
  eye: "right" | "left";
  field: "S" | "C" | "A" | "P" | "B";
  expected: string | number;
  entered: string | number;
}

/** 双眼录入复核结果：整单是否吻合 + 全部差异 */
export interface VerifyEntryResponse {
  match: boolean;
  differences: EntryDifference[];
}

/** 整单被拒绝（HTTP 422）：reasons 为后端返回的全部原因 */
export class RejectionError extends Error {
  constructor(public readonly reasons: string[]) {
    super(reasons.join("；"));
    this.name = "RejectionError";
  }
}
