import { ChangeEvent, FormEvent, useState } from "react";
import { EyePayload, transposePrescription } from "./api";
import { EyeResult, RejectionError, TransposeResponse } from "./types";

const EMPTY_EYE: EyePayload = { S: "", C: "", A: "" };

export default function App() {
  const [target, setTarget] = useState<"minus" | "plus">("minus");
  const [right, setRight] = useState<EyePayload>({ ...EMPTY_EYE });
  const [left, setLeft] = useState<EyePayload>({ ...EMPTY_EYE });
  const [result, setResult] = useState<TransposeResponse | null>(null);
  const [rejection, setRejection] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    try {
      const rx = await transposePrescription({ target, right, left });
      setResult(rx);
      setRejection(null);
    } catch (err) {
      // 任一眼不合规 → 整单拒绝：清空全部残留加工值，只展示拒绝原因
      setResult(null);
      setRejection(
        err instanceof RejectionError
          ? err.reasons
          : [err instanceof Error ? err.message : String(err)],
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>眼镜处方柱镜记法核对</h1>
      <p className="hint">
        球镜 S / 柱镜 C 接受 -20.00 至 +20.00、步长 0.25 的十进制定点数；C
        非零时轴位 A 取 1–180 的整数，C 为零时 A 必须为 0。
        任一眼不合规将整单拒绝，不输出任何加工参数。
      </p>

      <form onSubmit={onSubmit}>
        <div className="target-row">
          <label htmlFor="target">目标记法</label>
          <select
            id="target"
            value={target}
            onChange={(e) => setTarget(e.target.value as "minus" | "plus")}
          >
            <option value="minus">负柱镜记法</option>
            <option value="plus">正柱镜记法</option>
          </select>
        </div>

        <div className="eyes">
          <EyeFieldset legend="右眼（OD）" side="右眼" prefix="right" value={right} onChange={setRight} />
          <EyeFieldset legend="左眼（OS）" side="左眼" prefix="left" value={left} onChange={setLeft} />
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
}) {
  const { legend, side, prefix, value, onChange } = props;
  const bind =
    (key: keyof EyePayload) => (e: ChangeEvent<HTMLInputElement>) =>
      onChange({ ...value, [key]: e.target.value });

  return (
    <fieldset>
      <legend>{legend}</legend>
      <div className="field">
        <label htmlFor={`${prefix}-s`}>{side} S（球镜）</label>
        <input
          id={`${prefix}-s`}
          inputMode="decimal"
          placeholder="+1.25"
          value={value.S}
          onChange={bind("S")}
        />
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-c`}>{side} C（柱镜）</label>
        <input
          id={`${prefix}-c`}
          inputMode="decimal"
          placeholder="-0.75"
          value={value.C}
          onChange={bind("C")}
        />
      </div>
      <div className="field">
        <label htmlFor={`${prefix}-a`}>{side} A（轴位）</label>
        <input
          id={`${prefix}-a`}
          inputMode="numeric"
          placeholder="1–180，C 为 0 时填 0"
          value={value.A}
          onChange={bind("A")}
        />
      </div>
    </fieldset>
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
