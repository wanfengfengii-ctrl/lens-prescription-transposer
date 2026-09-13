import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function fillEye(
  page: Page,
  side: "右眼" | "左眼",
  s: string,
  c: string,
  a: string,
) {
  await page.getByLabel(`${side} S（球镜）`).fill(s);
  await page.getByLabel(`${side} C（柱镜）`).fill(c);
  await page.getByLabel(`${side} A（轴位）`).fill(a);
}

async function fillEntry(
  page: Page,
  side: "复核右眼" | "复核左眼",
  s: string,
  c: string,
  a: string,
) {
  await page.getByLabel(`${side} S 球镜`).fill(s);
  await page.getByLabel(`${side} C 柱镜`).fill(c);
  await page.getByLabel(`${side} A 轴位`).fill(a);
}

test.describe("加工范围（单眼处方，真实后端联调）", () => {
  test("仅右眼生成：只填右眼，磨片单与复核区只含右眼", async ({ page }) => {
    await page.goto("/");
    // 默认双眼
    await expect(page.getByLabel("加工范围")).toHaveValue("both");

    await page.getByLabel("加工范围").selectOption("right");
    // 左眼字段组不再展示，操作员只填写右眼
    await expect(page.getByLabel("左眼 S（球镜）")).toHaveCount(0);
    await page.getByLabel("目标记法").selectOption("minus");
    await fillEye(page, "右眼", "1.00", "2.00", "30");
    await page.getByRole("button", { name: "核对并转置" }).click();

    // 磨片单只含右眼，并标明加工范围
    const order = page.getByTestId("grinding-order");
    await expect(order).toContainText("加工范围：仅右眼（OD）");
    await expect(order).toContainText("OD（右眼） S +3.00 C -2.00 A 120");
    await expect(order).not.toContainText("OS（左眼）");
    await expect(page.getByLabel("左眼（OS）核对结果")).toHaveCount(0);

    // 复核区只针对右眼：录入吻合后给出单眼结论
    await expect(page.getByLabel("右眼录入复核")).toBeVisible();
    await expect(page.getByLabel("复核左眼 S 球镜")).toHaveCount(0);
    await fillEntry(page, "复核右眼", "+3.00", "-2.00", "120");
    await page.getByRole("button", { name: "复核录入" }).click();
    await expect(
      page.getByText("右眼录入全部吻合，可继续加工 ✓"),
    ).toBeVisible();
  });

  test("单眼生成进入复核后切回双眼：必须补齐两眼才能重新提交", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByLabel("目标记法").selectOption("minus");
    await page.getByLabel("加工范围").selectOption("right");
    await fillEye(page, "右眼", "1.00", "2.00", "30");
    await page.getByRole("button", { name: "核对并转置" }).click();
    await expect(page.getByTestId("grinding-order")).toContainText(
      "OD（右眼） S +3.00 C -2.00 A 120",
    );

    // 进入复核并完成一次右眼吻合复核
    await fillEntry(page, "复核右眼", "+3.00", "-2.00", "120");
    await page.getByRole("button", { name: "复核录入" }).click();
    await expect(
      page.getByText("右眼录入全部吻合，可继续加工 ✓"),
    ).toBeVisible();

    // 切回双眼：单眼的加工值与复核结论立即清空，左眼输入等待填写
    await page.getByLabel("加工范围").selectOption("both");
    await expect(page.getByTestId("grinding-order")).toHaveCount(0);
    await expect(
      page.getByText("右眼录入全部吻合，可继续加工 ✓"),
    ).toHaveCount(0);
    await expect(page.getByLabel("左眼 S（球镜）")).toHaveValue("");
    // 右眼输入仍然适用而保留
    await expect(page.getByLabel("右眼 S（球镜）")).toHaveValue("1.00");

    // 只带右眼直接提交 → 整单拒绝：必须补齐左眼
    await page.getByRole("button", { name: "核对并转置" }).click();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("处方被拒绝");
    await expect(alert).toContainText("左眼");
    await expect(page.getByTestId("grinding-order")).toHaveCount(0);

    // 补齐左眼后重新提交：恢复双眼契约，生成双眼磨片参数
    await fillEye(page, "左眼", "-1.25", "-0.50", "85");
    await page.getByRole("button", { name: "核对并转置" }).click();
    const order = page.getByTestId("grinding-order");
    await expect(order).toContainText("OD（右眼） S +3.00 C -2.00 A 120");
    await expect(order).toContainText("OS（左眼） S -1.25 C -0.50 A 85");
    await expect(order).not.toContainText("加工范围：仅");
    await expect(page.getByLabel("双眼录入复核")).toBeVisible();
  });

  test("仅左眼字段不符：差异按现有眼别与字段契约标注在左眼", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByLabel("目标记法").selectOption("minus");
    await page.getByLabel("加工范围").selectOption("left");
    await expect(page.getByLabel("右眼 S（球镜）")).toHaveCount(0);
    await fillEye(page, "左眼", "-1.25", "-0.50", "85");
    await page.getByRole("button", { name: "核对并转置" }).click();
    await expect(page.getByTestId("grinding-order")).toContainText(
      "OS（左眼） S -1.25 C -0.50 A 85",
    );

    // 左眼 S 录成 -1.50（期望 -1.25）：差异标在左眼 S 字段旁
    await fillEntry(page, "复核左眼", "-1.50", "-0.50", "85");
    await page.getByRole("button", { name: "复核录入" }).click();
    await expect(page.getByText("复核不吻合：共 1 处差异")).toBeVisible();
    await expect(page.getByTestId("diff-left-S")).toHaveText(
      "不吻合：期望 -1.25，录入 -1.50",
    );
    await expect(page.getByTestId("diff-left-C")).toHaveCount(0);
    await expect(page.getByTestId("diff-right-S")).toHaveCount(0);
  });
});
