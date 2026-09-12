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
