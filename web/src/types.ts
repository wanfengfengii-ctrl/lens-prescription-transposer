export interface EyeValues {
  S: string;
  C: string;
  A: number;
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
  check: {
    originalAxisDirection: DirectionCheck;
    perpendicularDirection: DirectionCheck;
    equivalent: boolean;
  };
}

export interface TransposeResponse {
  target: "plus" | "minus";
  right: EyeResult;
  left: EyeResult;
}

/** 单处录入差异：眼别、字段、期望值与录入值（S/C 为两位小数字符串，A 为整数） */
export interface EntryDifference {
  eye: "right" | "left";
  field: "S" | "C" | "A";
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
