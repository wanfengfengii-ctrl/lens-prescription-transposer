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

test.describe("处方柱镜记法核对页（真实后端联调）", () => {
  test("双眼正柱镜转负柱镜：展示原值、转置值、等价校核与磨片单", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByLabel("目标记法").selectOption("minus");
    await fillEye(page, "右眼", "1.00", "2.00", "30");
    await fillEye(page, "左眼", "-0.50", "1.25", "175");
    await page.getByRole("button", { name: "核对并转置" }).click();

    // 右眼：S'=S+C=+3.00，C'=-2.00，A'=30+90=120
    const rightCard = page.getByLabel("右眼（OD）核对结果");
    await expect(rightCard).toContainText("+3.00");
    await expect(rightCard).toContainText("-2.00");
    await expect(rightCard).toContainText("120");

    // 左眼：S'=+0.75，C'=-1.25，A'=175+90-180=85
    const leftCard = page.getByLabel("左眼（OS）核对结果");
    await expect(leftCard).toContainText("+0.75");
    await expect(leftCard).toContainText("-1.25");
    await expect(leftCard).toContainText("85");

    // 等价校核：两个物理方向功率分别相等
    await expect(page.getByText("等价校核：通过 ✓")).toHaveCount(2);
    await expect(page.getByLabel("右眼（OD）等价校核")).toContainText(
      "原轴方向 30°",
    );
    await expect(page.getByLabel("右眼（OD）等价校核")).toContainText(
      "垂直方向 120°",
    );

    // 磨片单：双眼唯一加工参数
    const order = page.getByTestId("grinding-order");
    await expect(order).toContainText("目标记法：负柱镜");
    await expect(order).toContainText("OD（右眼） S +3.00 C -2.00 A 120");
    await expect(order).toContainText("OS（左眼） S +0.75 C -1.25 A 85");
  });

  test("已符合目标记法与零柱镜：原样返回并提示无需转置", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("目标记法").selectOption("minus");
    await fillEye(page, "右眼", "-2.00", "-0.75", "60");
    await fillEye(page, "左眼", "0.00", "0.00", "0");
    await page.getByRole("button", { name: "核对并转置" }).click();

    await expect(page.getByText("已符合目标记法，无需转置")).toHaveCount(2);
    const order = page.getByTestId("grinding-order");
    await expect(order).toContainText("OD（右眼） S -2.00 C -0.75 A 60");
    await expect(order).toContainText("OS（左眼） S 0.00 C 0.00 A 0");
  });

  test("负柱镜转正柱镜：轴位跨 180 正确回绕", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("目标记法").selectOption("plus");
    await fillEye(page, "右眼", "-3.00", "-1.50", "170");
    await fillEye(page, "左眼", "1.00", "-0.25", "90");
    await page.getByRole("button", { name: "核对并转置" }).click();

    // 右眼：S'=-4.50，C'=+1.50，A'=170+90-180=80
    const rightCard = page.getByLabel("右眼（OD）核对结果");
    await expect(rightCard).toContainText("-4.50");
    await expect(rightCard).toContainText("+1.50");
    await expect(rightCard).toContainText("80");
    // 左眼：S'=+0.75，C'=+0.25，A'=90+90=180
    const leftCard = page.getByLabel("左眼（OS）核对结果");
    await expect(leftCard).toContainText("+0.75");
    await expect(leftCard).toContainText("+0.25");
    await expect(leftCard).toContainText("180");
  });

  test("任一眼不合规：整单 422，显示拒绝且无残留加工值", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("目标记法").selectOption("minus");
    await fillEye(page, "右眼", "1.00", "2.00", "30");
    // 左眼 C 为 0 但 A 非 0 → 违规
    await fillEye(page, "左眼", "0.50", "0.00", "90");
    await page.getByRole("button", { name: "核对并转置" }).click();

    const alert = page.getByRole("alert");
    await expect(alert).toContainText("处方被拒绝");
    await expect(alert).toContainText("C 为零时 A 必须为 0");
    await expect(page.getByTestId("grinding-order")).toHaveCount(0);
    await expect(page.getByLabel("核对结果")).toHaveCount(0);
  });

  test("转置后 S' 超界：整单拒绝", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("目标记法").selectOption("minus");
    await fillEye(page, "右眼", "20.00", "0.25", "10");
    await fillEye(page, "左眼", "1.00", "-0.50", "45");
    await page.getByRole("button", { name: "核对并转置" }).click();

    const alert = page.getByRole("alert");
    await expect(alert).toContainText("处方被拒绝");
    await expect(alert).toContainText("S'=+20.25");
    await expect(page.getByTestId("grinding-order")).toHaveCount(0);
  });

  test("先成功后失败：旧加工值被清除", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("目标记法").selectOption("minus");
    await fillEye(page, "右眼", "1.00", "2.00", "30");
    await fillEye(page, "左眼", "-0.50", "1.25", "175");
    await page.getByRole("button", { name: "核对并转置" }).click();
    await expect(page.getByTestId("grinding-order")).toContainText("+3.00");

    // 改坏左眼后重新提交 → 拒绝，旧结果必须消失
    await page.getByLabel("左眼 C（柱镜）").fill("0.00");
    await page.getByLabel("左眼 A（轴位）").fill("90");
    await page.getByRole("button", { name: "核对并转置" }).click();

    await expect(page.getByRole("alert")).toContainText("处方被拒绝");
    await expect(page.getByTestId("grinding-order")).toHaveCount(0);
    await expect(page.getByText("+3.00")).toHaveCount(0);
  });
});
