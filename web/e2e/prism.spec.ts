import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

async function fillEye(
  page: Page,
  side: "右眼" | "左眼",
  s: string,
  c: string,
  a: string,
) {
  await page.getByLabel(`${side} S（球镜）`, { exact: true }).fill(s);
  await page.getByLabel(`${side} C（柱镜）`, { exact: true }).fill(c);
  await page.getByLabel(`${side} A（轴位）`, { exact: true }).fill(a);
}

async function fillEntry(
  page: Page,
  side: "复核右眼" | "复核左眼",
  s: string,
  c: string,
  a: string,
) {
  await page.getByLabel(`${side} S 球镜`, { exact: true }).fill(s);
  await page.getByLabel(`${side} C 柱镜`, { exact: true }).fill(c);
  await page.getByLabel(`${side} A 轴位`, { exact: true }).fill(a);
}

/** 按 legend 精确匹配眼别字段组（主表单“右眼（OD）”/复核区“右眼（OD）录入”等） */
function fieldset(page: Page, legend: string): Locator {
  return page
    .locator("fieldset")
    .filter({ has: page.getByText(legend, { exact: true }) });
}

/** 展开棱镜录入并填写度数与基底方向 */
async function fillPrism(
  page: Page,
  legend: string,
  pLabel: string,
  bLabel: string,
  p: string,
  b: string,
) {
  await fieldset(page, legend)
    .getByRole("button", { name: "添加棱镜补偿" })
    .click();
  await page.getByLabel(pLabel, { exact: true }).fill(p);
  await page.getByLabel(bLabel, { exact: true }).selectOption(b);
}

/** 带棱镜双眼的主流程：右眼 +1.00/+2.00/30 P2.00外，左眼 -1.25/-0.50/85 P0.50上 */
async function transposeWithPrism(page: Page) {
  await page.goto("/");
  await page.getByLabel("目标记法").selectOption("minus");
  await fillEye(page, "右眼", "1.00", "2.00", "30");
  await fillPrism(page, "右眼（OD）", "右眼 P（棱镜）", "右眼 B（基底）", "2.00", "外");
  await fillEye(page, "左眼", "-1.25", "-0.50", "85");
  await fillPrism(page, "左眼（OS）", "左眼 P（棱镜）", "左眼 B（基底）", "0.50", "上");
  await page.getByRole("button", { name: "核对并转置" }).click();
  await expect(page.getByTestId("grinding-order")).toContainText(
    "OD（右眼） S +3.00 C -2.00 A 120 P +2.00 外",
  );
}

/** 与磨片参数一致的复核录入（含双眼棱镜） */
async function fillMatchingEntry(page: Page) {
  await fillEntry(page, "复核右眼", "+3.00", "-2.00", "120");
  await fillPrism(
    page,
    "右眼（OD）录入",
    "复核右眼 P 棱镜",
    "复核右眼 B 基底",
    "2.00",
    "外",
  );
  await fillEntry(page, "复核左眼", "-1.25", "-0.50", "85");
  await fillPrism(
    page,
    "左眼（OS）录入",
    "复核左眼 P 棱镜",
    "复核左眼 B 基底",
    "0.50",
    "上",
  );
}

test.describe("棱镜补偿（真实后端联调）", () => {
  test("无棱镜处方：默认不展开棱镜输入，正常转置", async ({ page }) => {
    await page.goto("/");
    // 默认只有展开开关，没有棱镜输入框
    await expect(page.getByLabel("右眼 P（棱镜）")).toHaveCount(0);
    await expect(page.getByLabel("左眼 P（棱镜）")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "添加棱镜补偿" }),
    ).toHaveCount(2);

    await page.getByLabel("目标记法").selectOption("minus");
    await fillEye(page, "右眼", "1.00", "2.00", "30");
    await fillEye(page, "左眼", "-1.25", "-0.50", "85");
    await page.getByRole("button", { name: "核对并转置" }).click();

    // 无棱镜：磨片单维持原有形态，结果卡不出现棱镜行
    const order = page.getByTestId("grinding-order");
    await expect(order).toContainText("OD（右眼） S +3.00 C -2.00 A 120");
    await expect(order).toContainText("OS（左眼） S -1.25 C -0.50 A 85");
    await expect(order).not.toContainText("P +");
    await expect(page.getByText(/棱镜补偿：P/)).toHaveCount(0);
  });

  test("带棱镜双眼：生成磨片参数并完成吻合复核", async ({ page }) => {
    await transposeWithPrism(page);

    // 结果卡原样展示棱镜，磨片单逐行携带
    await expect(page.getByLabel("右眼（OD）核对结果")).toContainText(
      "棱镜补偿：P +2.00，基底 外",
    );
    await expect(page.getByLabel("左眼（OS）核对结果")).toContainText(
      "棱镜补偿：P +0.50，基底 上",
    );
    const order = page.getByTestId("grinding-order");
    await expect(order).toContainText("OS（左眼） S -1.25 C -0.50 A 85 P +0.50 上");

    // 复核区默认同样收起棱镜输入
    await expect(page.getByLabel("复核右眼 P 棱镜")).toHaveCount(0);

    await fillMatchingEntry(page);
    await page.getByRole("button", { name: "复核录入" }).click();
    await expect(
      page.getByText("双眼录入全部吻合，可继续加工 ✓"),
    ).toBeVisible();
  });

  test("复核改错一个基底方向：对应眼别旁标明期望值和录入值", async ({
    page,
  }) => {
    await transposeWithPrism(page);

    // 右眼基底录成“内”（期望“外”），其余均正确
    await fillEntry(page, "复核右眼", "+3.00", "-2.00", "120");
    await fillPrism(
      page,
      "右眼（OD）录入",
      "复核右眼 P 棱镜",
      "复核右眼 B 基底",
      "2.00",
      "内",
    );
    await fillEntry(page, "复核左眼", "-1.25", "-0.50", "85");
    await fillPrism(
      page,
      "左眼（OS）录入",
      "复核左眼 P 棱镜",
      "复核左眼 B 基底",
      "0.50",
      "上",
    );
    await page.getByRole("button", { name: "复核录入" }).click();

    await expect(page.getByText("复核不吻合：共 1 处差异")).toBeVisible();
    await expect(page.getByTestId("diff-right-B")).toHaveText(
      "不吻合：期望 外，录入 内",
    );
    // 其它字段无标注
    await expect(page.getByTestId("diff-right-P")).toHaveCount(0);
    await expect(page.getByTestId("diff-left-B")).toHaveCount(0);
  });

  test("零度带方向的非法组合：整次复核被拒绝，先前加工参数仍留在页面", async ({
    page,
  }) => {
    await transposeWithPrism(page);

    // 先做一次完全吻合的复核，留下结论
    await fillMatchingEntry(page);
    await page.getByRole("button", { name: "复核录入" }).click();
    await expect(
      page.getByText("双眼录入全部吻合，可继续加工 ✓"),
    ).toBeVisible();

    // 改成零度带方向的非法组合（P 0.00 仍选基底“外”）再次复核
    await page.getByLabel("复核右眼 P 棱镜", { exact: true }).fill("0.00");
    await page.getByRole("button", { name: "复核录入" }).click();

    const alert = page.getByRole("alert");
    await expect(alert).toContainText("复核录入被拒绝");
    await expect(alert).toContainText("棱镜为零时不接受基底方向");

    // 过期结论被移除，先前生成的磨片参数（含棱镜）仍留在页面
    await expect(
      page.getByText("双眼录入全部吻合，可继续加工 ✓"),
    ).toHaveCount(0);
    await expect(page.getByTestId("grinding-order")).toContainText(
      "OD（右眼） S +3.00 C -2.00 A 120 P +2.00 外",
    );
    await expect(page.getByLabel("核对结果", { exact: true })).toBeVisible();
  });

  test("复核吻合后修改棱镜值：结论立即作废，回到未复核", async ({ page }) => {
    await transposeWithPrism(page);
    await fillMatchingEntry(page);
    await page.getByRole("button", { name: "复核录入" }).click();
    await expect(
      page.getByText("双眼录入全部吻合，可继续加工 ✓"),
    ).toBeVisible();

    // 修改复核棱镜度数 → 全部吻合的宣告立即消失，且不变成“不吻合”
    await page.getByLabel("复核右眼 P 棱镜", { exact: true }).fill("1.75");
    await expect(
      page.getByText("双眼录入全部吻合，可继续加工 ✓"),
    ).toHaveCount(0);
    await expect(page.getByText("复核不吻合")).toHaveCount(0);

    // 磨片参数不受影响
    await expect(page.getByTestId("grinding-order")).toContainText(
      "OD（右眼） S +3.00 C -2.00 A 120 P +2.00 外",
    );
  });
});
