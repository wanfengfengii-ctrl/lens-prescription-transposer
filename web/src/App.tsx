import { ChangeEvent, FormEvent, Fragment, useRef, useState } from "react";
import {
  EyePayload,
  TransposeRequest,
  transposePrescription,
  verifyEntry,
} from "./api";
import {
  EntryDifference,
  EyeResult,
  RejectionError,
  TransposeResponse,
  VerifyEntryResponse,
} from "./types";

const EMPTY_EYE: EyePayload = { S: "", C: "", A: "" };

export default function App() {
  const [target, setTarget] = useState<"minus" | "plus">("minus");
  const [right, setRight] = useState<EyePayload>({ ...EMPTY_EYE });
  const [left, setLeft] = useState<EyePayload>({ ...EMPTY_EYE });
  const [result, setResult] = useState<TransposeResponse | null>(null);
  const [rejection, setRejection] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  // 生成当前磨片参数的那次转置请求（复核时原样携带）
  const [lastRequest, setLastRequest] = useState<TransposeRequest | null>(null);
  const [entryRight, setEntryRight] = useState<EyePayload>({ ...EMPTY_EYE });
  const [entryLeft, setEntryLeft] = useState<EyePayload>({ ...EMPTY_EYE });
  const [verify, setVerify] = useState<VerifyEntryResponse | null>(null);
  const [verifyRejection, setVerifyRejection] = useState<string[] | null>(null);
  const [verifyBusy, setVerifyBusy] = useState(false);

  // 请求代号：每发起一次请求便 +1，决定由哪次请求结束 busy
  const transposeSubmitId = useRef(0);
  const verifySubmitId = useRef(0);
  // 语境代号：请求所依据的输入一旦变更便 +1，回填时代号不符的过期响应一律丢弃
  const transposeCtx = useRef(0);
  const verifyCtx = useRef(0);

  // 原处方 / 目标记法变更：在途转置与在途复核同时失去语境，旧复核结论立即作废
  function invalidatePrescriptionContext() {
    transposeCtx.current += 1;
    verifyCtx.current += 1;
    setVerify(null);
    setVerifyRejection(null);
  }
  // 重新生成磨片参数：复核语境整体作废，双眼设备录入清空等待重新填写
  function resetVerifyContext() {
    verifyCtx.current += 1;
    setEntryRight({ ...EMPTY_EYE });
    setEntryLeft({ ...EMPTY_EYE });
    setVerify(null);
    setVerifyRejection(null);
  }
  // 复核区设备录入值被改动 → 旧比对结论不再对应当前录入，立即回到未复核
  function invalidateEntryContext() {
    verifyCtx.current += 1;
    setVerify(null);
    setVerifyRejection(null);
  }

  const onTargetChange = (t: "minus" | "plus") => {
    setTarget(t);
    invalidatePrescriptionContext();
  };
  const onRightChange = (v: EyePayload) => {
    setRight(v);
    invalidatePrescriptionContext();
  };
  const onLeftChange = (v: EyePayload) => {
    setLeft(v);
    invalidatePrescriptionContext();
  };
  const onEntryRightChange = (v: EyePayload) => {
    setEntryRight(v);
    invalidateEntryContext();
  };
  const onEntryLeftChange = (v: EyePayload) => {
    setEntryLeft(v);
    invalidateEntryContext();
  };

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // 本次提交成为最新一代：在途的旧转置响应、旧复核语境全部作废
    const submitId = ++transposeSubmitId.current;
    const ctxId = ++transposeCtx.current;
    setBusy(true);
    resetVerifyContext();
    try {
      const req: TransposeRequest = {
        target,
        right: { ...right },
        left: { ...left },
      };
      const rx = await transposePrescription(req);
      // 响应在途期间表单又被改动、或已发起更新的提交 → 丢弃过期磨片参数
      if (ctxId !== transposeCtx.current) return;
      setResult(rx);
      setLastRequest(req);
      setRejection(null);
    } catch (err) {
      if (ctxId !== transposeCtx.current) return;
      // 任一眼不合规 → 整单拒绝：清空全部残留加工值，只展示拒绝原因
      setResult(null);
      setLastRequest(null);
      setRejection(
        err instanceof RejectionError
          ? err.reasons
          : [err instanceof Error ? err.message : String(err)],
      );
    } finally {
      // 仅最新一次提交负责结束 busy；表单改动作废响应时由本次提交收尾
      if (submitId === transposeSubmitId.current) setBusy(false);
    }
  }

  async function onVerifySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!lastRequest) return;
    const submitId = ++verifySubmitId.current;
    const ctxId = ++verifyCtx.current;
    setVerifyBusy(true);
    try {
      const res = await verifyEntry({
        prescription: lastRequest,
        entry: { right: entryRight, left: entryLeft },
      });
      // 在途期间原处方/设备录入已改动、参数已重新生成 → 丢弃过期结论
      if (ctxId !== verifyCtx.current) return;
      setVerify(res);
      setVerifyRejection(null);
    } catch (err) {
      if (ctxId !== verifyCtx.current) return;
      // 录入不合法 → 整次复核 422：保留已生成的磨片参数，
      // 移除过期复核结论，只显示本次拒绝原因
      setVerify(null);
      setVerifyRejection(
        err instanceof RejectionError
          ? err.reasons
          : [err instanceof Error ? err.message : String(err)],
      );
    } finally {
      if (submitId === verifySubmitId.current) setVerifyBusy(false);
    }
  }

  return (
    <main>
      <h1>眼镜处方柱镜记法核对</h1>
      <p className="hint">
        球镜 S / 柱镜 C 接受 -20.00 至 +20.00、步长 0.25 的十进制定点数（1e0
        等科学计数法不予接受）；C 非零时轴位 A 取 1–180 的整数，C 为零时 A 必须为 0。
        任一眼不合规将整单拒绝，不输出任何加工参数。
      </p>

      <form onSubmit={onSubmit}>
        <div className="target-row">
          <label htmlFor="target">目标记法</label>
          <select
            id="target"
            value={target}
            onChange={(e) => onTargetChange(e.target.value as "minus" | "plus")}
          >
            <option value="minus">负柱镜记法</option>
            <option value="plus">正柱镜记法</option>
          </select>
        </div>

        <div className="eyes">
          <EyeFieldset legend="右眼（OD）" side="右眼" prefix="right" value={right} onChange={onRightChange} />
          <EyeFieldset legend="左眼（OS）" side="左眼" prefix="left" value={left} onChange={onLeftChange} />
        </div>

        <button type="submit" disabled={busy}>
          {busy ? "核对中…" : "核对并转置"}
        </button>
      </form>

      {rejection && (
        <section role="alert" className="rejection" aria-label="处方被拒绝">
          <h2>处方被拒绝</h2>
          <p>未生成任何加工参数，请修正后重新提交：</p>
          <ul>
            {rejection.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
        </section>
      )}

      {result && (
        <Fragment>
          <section aria-label="核对结果" className="result">
            <h2>
              核对结果（{result.target === "minus" ? "负柱镜记法" : "正柱镜记法"}）
            </h2>
            <div className="eyes">
              <EyeResultCard title="右眼（OD）" eye={result.right} />
              <EyeResultCard title="左眼（OS）" eye={result.left} />
            </div>
            <GrindingOrder result={result} />
          </section>

          <VerifyEntrySection
            right={entryRight}
            left={entryLeft}
            onRightChange={onEntryRightChange}
            onLeftChange={onEntryLeftChange}
            onSubmit={onVerifySubmit}
            busy={verifyBusy}
            verify={verify}
            rejection={verifyRejection}
          />
        </Fragment>
      )}
    </main>
  );
}

function EyeFieldset(props: {
  legend: string;
  side: string;
  prefix: string;
  value: EyePayload;
  onChange: (v: EyePayload) => void;
  /** 复核场景：该眼的逐字段差异，非空时标在对应字段旁 */
  differences?: EntryDifference[];
  eyeKey?: "right" | "left";
  /** 自定义字段标签（复核区使用，避免与主表单标签互为子串） */
  fieldLabels?: { S: string; C: string; A: string };
}) {
  const { legend, side, prefix, value, onChange, differences, eyeKey, fieldLabels } =
    props;
  const bind =
    (key: keyof EyePayload) => (e: ChangeEvent<HTMLInputElement>) =>
      onChange({ ...value, [key]: e.target.value });
  const diffOf = (key: keyof EyePayload) =>
    eyeKey && differences
      ? differences.find((d) => d.eye === eyeKey && d.field === key)
      : undefined;

  const field = (
    key: keyof EyePayload,
    label: string,
    placeholder: string,
    inputMode: "decimal" | "numeric",
  ) => {
    const diff = diffOf(key);
    const id = `${prefix}-${key.toLowerCase()}`;
    return (
      <Fragment key={key}>
        <div className="field">
          <label htmlFor={id}>{label}</label>
          <input
            id={id}
            inputMode={inputMode}
            placeholder={placeholder}
            value={value[key]}
            onChange={bind(key)}
            aria-invalid={diff ? true : undefined}
            aria-describedby={diff ? `${id}-diff` : undefined}
          />
        </div>
        {diff && (
          <p
            className="diff"
            id={`${id}-diff`}
            data-testid={`diff-${eyeKey}-${key}`}
          >
            不吻合：期望 {diff.expected}，录入 {diff.entered}
          </p>
        )}
      </Fragment>
    );
  };

  return (
    <fieldset>
      <legend>{legend}</legend>
      {field("S", fieldLabels?.S ?? `${side} S（球镜）`, "+1.25", "decimal")}
      {field("C", fieldLabels?.C ?? `${side} C（柱镜）`, "-0.75", "decimal")}
      {field("A", fieldLabels?.A ?? `${side} A（轴位）`, "1–180，C 为 0 时填 0", "numeric")}
    </fieldset>
  );
}

/** 双眼录入复核：仅在成功生成磨片参数后展示 */
function VerifyEntrySection(props: {
  right: EyePayload;
  left: EyePayload;
  onRightChange: (v: EyePayload) => void;
  onLeftChange: (v: EyePayload) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  busy: boolean;
  verify: VerifyEntryResponse | null;
  rejection: string[] | null;
}) {
  const { right, left, onRightChange, onLeftChange, onSubmit, busy, verify, rejection } =
    props;
  return (
    <section aria-label="双眼录入复核" className="verify">
      <h2>双眼录入复核</h2>
      <p className="hint">
        磨片参数抄入设备后，请将设备中的双眼 S / C / A 再次录入并提交复核，
        确认没有串眼或改错数值。
      </p>
      <form onSubmit={onSubmit}>
        <div className="eyes">
          <EyeFieldset
            legend="右眼（OD）录入"
            side="复核右眼"
            prefix="verify-right"
            value={right}
            onChange={onRightChange}
            eyeKey="right"
            differences={verify?.differences ?? []}
            fieldLabels={{ S: "复核右眼 S 球镜", C: "复核右眼 C 柱镜", A: "复核右眼 A 轴位" }}
          />
          <EyeFieldset
            legend="左眼（OS）录入"
            side="复核左眼"
            prefix="verify-left"
            value={left}
            onChange={onLeftChange}
            eyeKey="left"
            differences={verify?.differences ?? []}
            fieldLabels={{ S: "复核左眼 S 球镜", C: "复核左眼 C 柱镜", A: "复核左眼 A 轴位" }}
          />
        </div>
        <button type="submit" disabled={busy}>
          {busy ? "复核中…" : "复核录入"}
        </button>
      </form>

      {rejection && (
        <section role="alert" className="rejection" aria-label="复核录入被拒绝">
          <h3>复核录入被拒绝</h3>
          <p>已生成的磨片参数仍然有效，请修正录入后重新复核：</p>
          <ul>
            {rejection.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
        </section>
      )}

      {verify?.match && (
        <p className="pass verify-status" role="status">
          双眼录入全部吻合，可继续加工 ✓
        </p>
      )}
      {verify && !verify.match && (
        <p className="fail verify-status" role="status">
          复核不吻合：共 {verify.differences.length} 处差异，请核对上方标注字段
        </p>
      )}
    </section>
  );
}

function EyeResultCard({ title, eye }: { title: string; eye: EyeResult }) {
  return (
    <section className="eye-card" aria-label={`${title}核对结果`}>
      <h3>{title}</h3>
      <table aria-label={`${title}原值与转置值`}>
        <thead>
          <tr>
            <th scope="col"></th>
            <th scope="col">S 球镜</th>
            <th scope="col">C 柱镜</th>
            <th scope="col">A 轴位</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">原值</th>
            <td>{eye.input.S}</td>
            <td>{eye.input.C}</td>
            <td>{eye.input.A}</td>
          </tr>
          <tr>
            <th scope="row">转置值</th>
            <td>{eye.output.S}</td>
            <td>{eye.output.C}</td>
            <td>{eye.output.A}</td>
          </tr>
        </tbody>
      </table>
      {!eye.changed && <p className="unchanged">已符合目标记法，无需转置</p>}

      <table aria-label={`${title}等价校核`}>
        <caption>等价校核：同一物理方向上的功率必须相等</caption>
        <thead>
          <tr>
            <th scope="col">物理方向</th>
            <th scope="col">原处方功率</th>
            <th scope="col">转置后功率</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>原轴方向 {eye.check.originalAxisDirection.degrees}°</td>
            <td>{eye.check.originalAxisDirection.original}</td>
            <td>{eye.check.originalAxisDirection.transposed}</td>
          </tr>
          <tr>
            <td>垂直方向 {eye.check.perpendicularDirection.degrees}°</td>
            <td>{eye.check.perpendicularDirection.original}</td>
            <td>{eye.check.perpendicularDirection.transposed}</td>
          </tr>
        </tbody>
      </table>
      <p className={eye.check.equivalent ? "pass" : "fail"}>
        等价校核：{eye.check.equivalent ? "通过 ✓" : "不通过 ✗"}
      </p>
    </section>
  );
}

function GrindingOrder({ result }: { result: TransposeResponse }) {
  const [copied, setCopied] = useState(false);
  const text = [
    `目标记法：${result.target === "minus" ? "负柱镜" : "正柱镜"}`,
    `OD（右眼） S ${result.right.output.S} C ${result.right.output.C} A ${result.right.output.A}`,
    `OS（左眼） S ${result.left.output.S} C ${result.left.output.C} A ${result.left.output.A}`,
  ].join("\n");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section aria-label="磨片单参数" className="grinding-order">
      <h3>磨片单参数（双眼唯一结果，可抄入磨片单）</h3>
      <pre data-testid="grinding-order">{text}</pre>
      <button type="button" onClick={copy}>
        {copied ? "已复制" : "复制加工参数"}
      </button>
    </section>
  );
}
