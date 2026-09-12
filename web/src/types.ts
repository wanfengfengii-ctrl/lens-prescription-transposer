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

/** 整单被拒绝（HTTP 422）：reasons 为后端返回的全部原因 */
export class RejectionError extends Error {
  constructor(public readonly reasons: string[]) {
    super(reasons.join("；"));
    this.name = "RejectionError";
  }
}
