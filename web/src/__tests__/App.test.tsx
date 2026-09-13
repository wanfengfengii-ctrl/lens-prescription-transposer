import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";

/** 与后端真实响应结构完全一致的载荷（右眼转置、左眼原样返回） */
const BACKEND_OK = {
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

function fakeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** 可控的在途请求：在测试需要时再让响应到达 */
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("右眼 S（球镜）"), "1.00");
  await user.type(screen.getByLabelText("右眼 C（柱镜）"), "2.00");
  await user.type(screen.getByLabelText("右眼 A（轴位）"), "30");
  await user.type(screen.getByLabelText("左眼 S（球镜）"), "-1.25");
  await user.type(screen.getByLabelText("左眼 C（柱镜）"), "-0.50");
  await user.type(screen.getByLabelText("左眼 A（轴位）"), "85");
  await user.click(screen.getByRole("button", { name: "核对并转置" }));
}

describe("处方核对页", () => {
  it("提交后真实展示后端返回的原值、转置值与等价校核", async () => {
    fetchMock.mockResolvedValue(fakeResponse(200, BACKEND_OK));
    const user = userEvent.setup();
    render(<App />);

    await fillAndSubmit(user);

    // 单次提交：双眼 + 目标记法一起发给后端
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/transpose");
    expect(JSON.parse(String(init.body))).toEqual({
      target: "minus",
      right: { S: "1.00", C: "2.00", A: "30" },
      left: { S: "-1.25", C: "-0.50", A: "85" },
    });

    // 右眼：原值 + 转置值（文本直接来自后端响应）
    const rightCard = await screen.findByLabelText("右眼（OD）核对结果");
    const rightValues = within(rightCard).getByLabelText("右眼（OD）原值与转置值");
    expect(within(rightValues).getByText("+3.00")).toBeInTheDocument();
    expect(within(rightValues).getByText("-2.00")).toBeInTheDocument();
    expect(within(rightValues).getByText("120")).toBeInTheDocument();
    expect(within(rightValues).getByText("+1.00")).toBeInTheDocument();
    expect(within(rightValues).getByText("+2.00")).toBeInTheDocument();
    expect(within(rightValues).getByText("30")).toBeInTheDocument();

    // 右眼等价校核：两个物理方向的功率分别相等
    const rightCheck = within(rightCard).getByLabelText("右眼（OD）等价校核");
    expect(rightCheck).toHaveTextContent("原轴方向 30°");
    expect(rightCheck).toHaveTextContent("垂直方向 120°");
    expect(screen.getAllByText("等价校核：通过 ✓")).toHaveLength(2);

    // 左眼原样返回，提示无需转置
    const leftCard = screen.getByLabelText("左眼（OS）核对结果");
    expect(within(leftCard).getByText("已符合目标记法，无需转置")).toBeInTheDocument();

    // 磨片单：双眼唯一加工参数
    const order = screen.getByTestId("grinding-order");
    expect(order).toHaveTextContent("目标记法：负柱镜");
    expect(order).toHaveTextContent("OD（右眼） S +3.00 C -2.00 A 120");
    expect(order).toHaveTextContent("OS（左眼） S -1.25 C -0.50 A 85");
  });

  it("422 时展示拒绝原因，并清除上一次的全部加工值", async () => {
    fetchMock.mockResolvedValue(fakeResponse(200, BACKEND_OK));
    const user = userEvent.setup();
    render(<App />);
    await fillAndSubmit(user);
    await screen.findByTestId("grinding-order");

    // 第二次提交：左眼 C 为 0 但 A 非 0 → 整单 422
    fetchMock.mockResolvedValueOnce(
      fakeResponse(422, { detail: ["左眼.A: C 为零时 A 必须为 0，收到 90"] }),
    );
    await user.clear(screen.getByLabelText("左眼 C（柱镜）"));
    await user.type(screen.getByLabelText("左眼 C（柱镜）"), "0.00");
    await user.clear(screen.getByLabelText("左眼 A（轴位）"));
    await user.type(screen.getByLabelText("左眼 A（轴位）"), "90");
    await user.click(screen.getByRole("button", { name: "核对并转置" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("处方被拒绝");
    expect(alert).toHaveTextContent("左眼.A: C 为零时 A 必须为 0，收到 90");

    // 没有残留加工值：结果区、磨片单全部消失
    expect(screen.queryByLabelText("核对结果")).not.toBeInTheDocument();
    expect(screen.queryByTestId("grinding-order")).not.toBeInTheDocument();
    expect(screen.queryByText("+3.00")).not.toBeInTheDocument();
  });

  it("首次提交即 422 时只显示拒绝，不出现任何结果", async () => {
    fetchMock.mockResolvedValue(
      fakeResponse(422, { detail: ["右眼.S: 必须是 0.25 的整数倍，收到 '1.13'"] }),
    );
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText("右眼 S（球镜）"), "1.13");
    await user.type(screen.getByLabelText("右眼 C（柱镜）"), "0.00");
    await user.type(screen.getByLabelText("右眼 A（轴位）"), "0");
    await user.type(screen.getByLabelText("左眼 S（球镜）"), "0.00");
    await user.type(screen.getByLabelText("左眼 C（柱镜）"), "0.00");
    await user.type(screen.getByLabelText("左眼 A（轴位）"), "0");
    await user.click(screen.getByRole("button", { name: "核对并转置" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("右眼.S: 必须是 0.25 的整数倍");
    expect(screen.queryByLabelText("核对结果")).not.toBeInTheDocument();
    expect(screen.queryByTestId("grinding-order")).not.toBeInTheDocument();
  });

  it("服务不可达时给出提示且不留结果", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const user = userEvent.setup();
    render(<App />);
    await fillAndSubmit(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("无法连接核对服务");
    expect(screen.queryByLabelText("核对结果")).not.toBeInTheDocument();
  });

  it("切换目标记法后随表单一起提交", async () => {
    fetchMock.mockResolvedValue(fakeResponse(200, { ...BACKEND_OK, target: "plus" }));
    const user = userEvent.setup();
    render(<App />);

    await user.selectOptions(screen.getByLabelText("目标记法"), "plus");
    await fillAndSubmit(user);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).target).toBe("plus");
    expect(await screen.findByLabelText("核对结果")).toHaveTextContent("正柱镜记法");
  });
});

/** 与后端比对响应一致的载荷 */
const VERIFY_MATCH = { match: true, differences: [] };
const VERIFY_MISMATCH_RIGHT_S = {
  match: false,
  differences: [{ eye: "right", field: "S", expected: "+3.00", entered: "+3.25" }],
};

async function fillEntryAndSubmit(
  user: ReturnType<typeof userEvent.setup>,
  values?: { rightS?: string },
) {
  await user.type(screen.getByLabelText("复核右眼 S 球镜"), values?.rightS ?? "+3.00");
  await user.type(screen.getByLabelText("复核右眼 C 柱镜"), "-2.00");
  await user.type(screen.getByLabelText("复核右眼 A 轴位"), "120");
  await user.type(screen.getByLabelText("复核左眼 S 球镜"), "-1.25");
  await user.type(screen.getByLabelText("复核左眼 C 柱镜"), "-0.50");
  await user.type(screen.getByLabelText("复核左眼 A 轴位"), "85");
  await user.click(screen.getByRole("button", { name: "复核录入" }));
}

describe("双眼录入复核", () => {
  it("仅在成功生成磨片参数后展示复核输入区", async () => {
    fetchMock.mockResolvedValue(fakeResponse(200, BACKEND_OK));
    const user = userEvent.setup();
    render(<App />);

    // 未提交前没有复核输入区
    expect(screen.queryByLabelText("双眼录入复核")).not.toBeInTheDocument();

    await fillAndSubmit(user);
    expect(await screen.findByLabelText("双眼录入复核")).toBeInTheDocument();
  });

  it("转置 422 时不展示复核输入区", async () => {
    fetchMock.mockResolvedValue(
      fakeResponse(422, { detail: ["右眼.S: 必须是 0.25 的整数倍，收到 '1.13'"] }),
    );
    const user = userEvent.setup();
    render(<App />);

    await fillAndSubmit(user);
    await screen.findByRole("alert");
    expect(screen.queryByLabelText("双眼录入复核")).not.toBeInTheDocument();
  });

  it("完全吻合：给出可继续加工的明确提示，请求携带原转置请求与录入值", async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(200, BACKEND_OK));
    fetchMock.mockResolvedValueOnce(fakeResponse(200, VERIFY_MATCH));
    const user = userEvent.setup();
    render(<App />);

    await fillAndSubmit(user);
    await screen.findByTestId("grinding-order");
    await fillEntryAndSubmit(user);

    expect(
      await screen.findByText("双眼录入全部吻合，可继续加工 ✓"),
    ).toBeInTheDocument();

    // 复核请求：原转置请求 + 操作员录入的双眼 S/C/A
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/verify-entry");
    expect(JSON.parse(String(init.body))).toEqual({
      prescription: {
        target: "minus",
        right: { S: "1.00", C: "2.00", A: "30" },
        left: { S: "-1.25", C: "-0.50", A: "85" },
      },
      entry: {
        right: { S: "+3.00", C: "-2.00", A: "120" },
        left: { S: "-1.25", C: "-0.50", A: "85" },
      },
    });
  });

  it("复核携带的是生成磨片参数的那次请求，而非事后改动的表单值", async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(200, BACKEND_OK));
    fetchMock.mockResolvedValueOnce(fakeResponse(200, VERIFY_MATCH));
    const user = userEvent.setup();
    render(<App />);

    await fillAndSubmit(user);
    await screen.findByTestId("grinding-order");

    // 转置成功后改动原处方表单（不重新提交），复核仍应携带原请求
    await user.type(screen.getByLabelText("右眼 S（球镜）"), "9");
    await fillEntryAndSubmit(user);

    const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.prescription.right).toEqual({ S: "1.00", C: "2.00", A: "30" });
  });

  it("单眼单字段不符：差异标在对应字段旁", async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(200, BACKEND_OK));
    fetchMock.mockResolvedValueOnce(fakeResponse(200, VERIFY_MISMATCH_RIGHT_S));
    const user = userEvent.setup();
    render(<App />);

    await fillAndSubmit(user);
    await screen.findByTestId("grinding-order");
    await fillEntryAndSubmit(user, { rightS: "+3.25" });

    // 整单结论：不吻合
    expect(
      await screen.findByText("复核不吻合：共 1 处差异，请核对上方标注字段"),
    ).toBeInTheDocument();

    // 差异标在右眼 S 字段旁，其它字段无标注
    const diff = screen.getByTestId("diff-right-S");
    expect(diff).toHaveTextContent("不吻合：期望 +3.00，录入 +3.25");
    expect(screen.getByLabelText("复核右眼 S 球镜")).toHaveAttribute(
      "aria-describedby",
      diff.id,
    );
    expect(screen.queryByTestId("diff-right-C")).not.toBeInTheDocument();
    expect(screen.queryByTestId("diff-right-A")).not.toBeInTheDocument();
    expect(screen.queryByTestId("diff-left-S")).not.toBeInTheDocument();
  });

  it("录入非法 → 整次 422：保留磨片参数、移除过期结论并显示原因", async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(200, BACKEND_OK));
    fetchMock.mockResolvedValueOnce(fakeResponse(200, VERIFY_MATCH));
    const user = userEvent.setup();
    render(<App />);

    // 先做一次完全吻合的复核，留下结论
    await fillAndSubmit(user);
    await screen.findByTestId("grinding-order");
    await fillEntryAndSubmit(user);
    await screen.findByText("双眼录入全部吻合，可继续加工 ✓");

    // 改成非法录入（科学计数法）再次复核 → 整次 422
    fetchMock.mockResolvedValueOnce(
      fakeResponse(422, {
        detail: ["复核录入.右眼.S: 必须是十进制定点数（不接受科学计数法），收到 '1e0'"],
      }),
    );
    await user.clear(screen.getByLabelText("复核右眼 S 球镜"));
    await user.type(screen.getByLabelText("复核右眼 S 球镜"), "1e0");
    await user.click(screen.getByRole("button", { name: "复核录入" }));

    // 显示具体原因
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("复核录入被拒绝");
    expect(alert).toHaveTextContent("不接受科学计数法");

    // 过期结论被移除，磨片参数仍然保留
    expect(screen.queryByText("双眼录入全部吻合，可继续加工 ✓")).not.toBeInTheDocument();
    expect(screen.queryByTestId("diff-right-S")).not.toBeInTheDocument();
    expect(screen.getByTestId("grinding-order")).toHaveTextContent(
      "OD（右眼） S +3.00 C -2.00 A 120",
    );
    expect(screen.getByLabelText("核对结果")).toBeInTheDocument();
  });

  it("修改原处方或目标记法后立即清除旧复核结论", async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(200, BACKEND_OK));
    fetchMock.mockResolvedValueOnce(fakeResponse(200, VERIFY_MISMATCH_RIGHT_S));
    const user = userEvent.setup();
    render(<App />);

    await fillAndSubmit(user);
    await screen.findByTestId("grinding-order");
    await fillEntryAndSubmit(user, { rightS: "+3.25" });
    await screen.findByText("复核不吻合：共 1 处差异，请核对上方标注字段");

    // 改动原处方 → 结论与字段标注立即消失
    await user.type(screen.getByLabelText("左眼 S（球镜）"), "0");
    expect(screen.queryByText(/复核不吻合/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("diff-right-S")).not.toBeInTheDocument();

    // 再次复核吻合后，切换目标记法 → 结论同样立即消失
    fetchMock.mockResolvedValueOnce(fakeResponse(200, VERIFY_MATCH));
    await user.click(screen.getByRole("button", { name: "复核录入" }));
    await screen.findByText("双眼录入全部吻合，可继续加工 ✓");
    await user.selectOptions(screen.getByLabelText("目标记法"), "plus");
    expect(screen.queryByText("双眼录入全部吻合，可继续加工 ✓")).not.toBeInTheDocument();
  });

  it("复核吻合后改动设备录入值：旧结论立即作废，回到未复核", async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(200, BACKEND_OK));
    fetchMock.mockResolvedValueOnce(fakeResponse(200, VERIFY_MATCH));
    const user = userEvent.setup();
    render(<App />);

    await fillAndSubmit(user);
    await screen.findByTestId("grinding-order");
    await fillEntryAndSubmit(user);
    await screen.findByText("双眼录入全部吻合，可继续加工 ✓");

    // 复核吻合后修改右眼设备球镜值 → 全部吻合的结论必须立即消失
    const rightS = screen.getByLabelText("复核右眼 S 球镜");
    await user.clear(rightS);
    await user.type(rightS, "+3.25");
    expect(screen.queryByText("双眼录入全部吻合，可继续加工 ✓")).not.toBeInTheDocument();
    expect(screen.queryByText(/复核不吻合/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("diff-right-S")).not.toBeInTheDocument();
  });

  it("重新生成磨片参数：新复核区清空设备录入，不复用上一张处方的值", async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        fakeResponse(
          200,
          url === "/api/v1/verify-entry" ? VERIFY_MATCH : BACKEND_OK,
        ),
      ),
    );
    const user = userEvent.setup();
    render(<App />);

    await fillAndSubmit(user);
    await screen.findByTestId("grinding-order");
    await fillEntryAndSubmit(user);
    expect(screen.getByLabelText("复核右眼 S 球镜")).toHaveValue("+3.00");

    // 换一张合法处方重新生成参数 → 复核区必须清空，等待重新填写
    await user.clear(screen.getByLabelText("右眼 S（球镜）"));
    await user.type(screen.getByLabelText("右眼 S（球镜）"), "0.50");
    await user.click(screen.getByRole("button", { name: "核对并转置" }));
    await screen.findByTestId("grinding-order");

    expect(screen.getByLabelText("复核右眼 S 球镜")).toHaveValue("");
    expect(screen.getByLabelText("复核右眼 C 柱镜")).toHaveValue("");
    expect(screen.getByLabelText("复核右眼 A 轴位")).toHaveValue("");
    expect(screen.getByLabelText("复核左眼 S 球镜")).toHaveValue("");
    expect(screen.getByLabelText("复核左眼 C 柱镜")).toHaveValue("");
    expect(screen.getByLabelText("复核左眼 A 轴位")).toHaveValue("");
    expect(screen.queryByText("双眼录入全部吻合，可继续加工 ✓")).not.toBeInTheDocument();
  });

  it("复核请求在途时修改原处方球镜：旧响应到达后不得回填过期结论", async () => {
    const pendingVerify = deferred();
    fetchMock.mockResolvedValueOnce(fakeResponse(200, BACKEND_OK));
    fetchMock.mockImplementationOnce((url: string) =>
      url === "/api/v1/verify-entry"
        ? pendingVerify.promise
        : Promise.resolve(fakeResponse(200, BACKEND_OK)),
    );
    const user = userEvent.setup();
    render(<App />);

    await fillAndSubmit(user);
    await screen.findByTestId("grinding-order");
    await fillEntryAndSubmit(user);

    // 复核响应尚未返回：此时修改当前原处方球镜 → 回到未复核
    await user.type(screen.getByLabelText("右眼 S（球镜）"), "9");
    expect(screen.queryByText(/复核不吻合|双眼录入全部吻合/)).not.toBeInTheDocument();

    // 旧响应（修改前处方的吻合结论）到达 → 必须被丢弃
    await pendingVerify.resolve(fakeResponse(200, VERIFY_MATCH));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("双眼录入全部吻合，可继续加工 ✓")).not.toBeInTheDocument();
    expect(screen.queryByTestId("diff-right-S")).not.toBeInTheDocument();
  });

  it("转置请求在途时修改右眼柱镜：旧响应到达后不得展示过期磨片参数或开放复核", async () => {
    const pendingTranspose = deferred();
    fetchMock.mockImplementationOnce((url: string) =>
      url === "/api/v1/transpose"
        ? pendingTranspose.promise
        : Promise.resolve(fakeResponse(200, BACKEND_OK)),
    );
    const user = userEvent.setup();
    render(<App />);

    await fillAndSubmit(user);

    // 转置响应尚未返回：此时修改右眼柱镜
    await user.type(screen.getByLabelText("右眼 C（柱镜）"), "9");
    expect(screen.queryByTestId("grinding-order")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("双眼录入复核")).not.toBeInTheDocument();

    // 旧响应（修改前处方的磨片参数）到达 → 必须被丢弃
    await pendingTranspose.resolve(fakeResponse(200, BACKEND_OK));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("grinding-order")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("双眼录入复核")).not.toBeInTheDocument();
    expect(screen.queryByText("+3.00")).not.toBeInTheDocument();
  });
});
