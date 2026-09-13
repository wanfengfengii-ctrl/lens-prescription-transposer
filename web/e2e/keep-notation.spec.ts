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

test.describe("保持原记法（真实后端联调）", () => {
  test("混合正负柱镜双眼处方：原样生成、等价校核通过，原样复核吻合", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByLabel("目标记法").selectOption("keep");
    // 选择后表单旁即标明本次不做符号转换
    await expect(page.getByTestId("keep-hint")).toBeVisible();

    // 右眼为正柱镜、左眼为负柱镜
    await fillEye(page, "右眼", "1.00", "2.00", "30");
    await fillEye(page, "左眼", "-1.25", "-0.50", "85");
    await page.getByRole("button", { name: "核对并转置" }).click();

    // 结果区清楚标示本次未做符号转换
    const result = page.getByLabel("核对结果", { exact: true });
    await expect(result).toContainText("核对结果（保持原记法）");
    await expect(page.getByTestId("keep-banner")).toBeVisible();
    await expect(page.getByTestId("keep-note-right")).toHaveText(
      "保持原记法，未做符号转换",
    );
    await expect(page.getByTestId("keep-note-left")).toHaveText(
      "保持原记法，未做符号转换",
    );
    await expect(page.getByText("已符合目标记法，无需转置")).toHaveCount(0);

    // 右眼正柱镜原样输出，不出现统一负柱镜才有的 +3.00/-2.00/120
    const rightCard = page.getByLabel("右眼（OD）核对结果");
    await expect(rightCard).toContainText("+1.00");
    await expect(rightCard).toContainText("+2.00");
    const order = page.getByTestId("grinding-order");
    await expect(order).toContainText("目标记法：保持原记法（未做符号转换）");
    await expect(order).toContainText("OD（右眼） S +1.00 C +2.00 A 30");
    await expect(order).toContainText("OS（左眼） S -1.25 C -0.50 A 85");
    await expect(order).not.toContainText("C -2.00");

    // 等价校核仍由整数域结果生成：两眼均通过
    await expect(page.getByText("等价校核：通过 ✓")).toHaveCount(2);

    // 原样录入设备 → 双眼吻合
    await fillEntry(page, "复核右眼", "+1.00", "+2.00", "30");
    await fillEntry(page, "复核左眼", "-1.25", "-0.50", "85");
    await page.getByRole("button", { name: "复核录入" }).click();
    await expect(
      page.getByText("双眼录入全部吻合，可继续加工 ✓"),
    ).toBeVisible();
  });

  test("单眼含棱镜处方：原样生成并完成吻合复核", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("加工范围").selectOption("right");
    await page.getByLabel("目标记法").selectOption("keep");
    await fillEye(page, "右眼", "1.00", "2.00", "30");

    // 展开棱镜并填写
    const rightFs = page.getByRole("group", { name: "右眼（OD）" });
    await rightFs.getByRole("button", { name: "添加棱镜补偿 ▸" }).click();
    await page.getByLabel("右眼 P（棱镜）").fill("2.00");
    await page.getByLabel("右眼 B（基底）").selectOption("外");
    await page.getByRole("button", { name: "核对并转置" }).click();

    // 磨片单写明保持原记法，数值、轴位与棱镜全部原样，无左眼
    const order = page.getByTestId("grinding-order");
    await expect(order).toContainText("目标记法：保持原记法（未做符号转换）");
    await expect(order).toContainText("OD（右眼） S +1.00 C +2.00 A 30 P +2.00 外");
    await expect(order).not.toContainText("OS（左眼）");
    await expect(page.getByLabel("左眼（OS）核对结果")).toHaveCount(0);
    const rightCard = page.getByLabel("右眼（OD）核对结果");
    await expect(rightCard).toContainText("棱镜补偿：P +2.00，基底 外");

    // 复核区只针对右眼：按原值（含棱镜）录入 → 吻合
    await expect(page.getByLabel("右眼录入复核")).toBeVisible();
    await fillEntry(page, "复核右眼", "+1.00", "+2.00", "30");
    const entryFs = page.getByRole("group", { name: "右眼（OD）录入" });
    await entryFs.getByRole("button", { name: "添加棱镜补偿 ▸" }).click();
    await page.getByLabel("复核右眼 P 棱镜").fill("2.00");
    await page.getByLabel("复核右眼 B 基底").selectOption("外");
    await page.getByRole("button", { name: "复核录入" }).click();
    await expect(
      page.getByText("右眼录入全部吻合，可继续加工 ✓"),
    ).toBeVisible();
  });

  test("复核改错设备柱镜：返回该眼 C 字段差异", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("目标记法").selectOption("keep");
    await fillEye(page, "右眼", "1.00", "2.00", "30");
    await fillEye(page, "左眼", "-1.25", "-0.50", "85");
    await page.getByRole("button", { name: "核对并转置" }).click();
    await expect(page.getByTestId("grinding-order")).toContainText(
      "OD（右眼） S +1.00 C +2.00 A 30",
    );

    // 右眼柱镜误录为 +2.25（期望原处方 +2.00），其余正确
    await fillEntry(page, "复核右眼", "+1.00", "+2.25", "30");
    await fillEntry(page, "复核左眼", "-1.25", "-0.50", "85");
    await page.getByRole("button", { name: "复核录入" }).click();

    await expect(page.getByText("复核不吻合：共 1 处差异")).toBeVisible();
    await expect(page.getByTestId("diff-right-C")).toHaveText(
      "不吻合：期望 +2.00，录入 +2.25",
    );
    await expect(page.getByTestId("diff-right-S")).toHaveCount(0);
    await expect(page.getByTestId("diff-left-C")).toHaveCount(0);
  });

  test("非法处方仍整单拒绝：不生成加工结果", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("目标记法").selectOption("keep");
    // 右眼球镜科学计数法：keep 不放松定点数记法闸门
    await fillEye(page, "右眼", "1e0", "2.00", "30");
    await fillEye(page, "左眼", "-1.25", "-0.50", "85");
    await page.getByRole("button", { name: "核对并转置" }).click();

    const alert = page.getByRole("alert");
    await expect(alert).toContainText("处方被拒绝");
    await expect(alert).toContainText("科学计数法");
    await expect(page.getByTestId("grinding-order")).toHaveCount(0);
    await expect(page.getByLabel("核对结果")).toHaveCount(0);
    await expect(page.getByLabel("双眼录入复核")).toHaveCount(0);
  });

  test("切换目标记法：旧的保持原记法结果与复核结论立即清空", async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("目标记法").selectOption("keep");
    await fillEye(page, "右眼", "1.00", "2.00", "30");
    await fillEye(page, "左眼", "-1.25", "-0.50", "85");
    await page.getByRole("button", { name: "核对并转置" }).click();
    await expect(page.getByTestId("keep-banner")).toBeVisible();

    // 切到负柱镜：未重新提交前，旧 keep 结果与标示全部消失
    await page.getByLabel("目标记法").selectOption("minus");
    await expect(page.getByTestId("keep-banner")).toHaveCount(0);
    await expect(page.getByTestId("keep-hint")).toHaveCount(0);
    await expect(page.getByTestId("grinding-order")).toHaveCount(0);
    await expect(page.getByLabel("核对结果")).toHaveCount(0);
    await expect(page.getByLabel("双眼录入复核")).toHaveCount(0);

    // 重新提交后按负柱镜统一符号：右眼被转置
    await page.getByRole("button", { name: "核对并转置" }).click();
    const order = page.getByTestId("grinding-order");
    await expect(order).toContainText("目标记法：负柱镜");
    await expect(order).toContainText("OD（右眼） S +3.00 C -2.00 A 120");
    await expect(order).not.toContainText("保持原记法");
  });
});
