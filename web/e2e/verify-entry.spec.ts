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

/** 走完主流程：右眼 +1.00/+2.00/30 → +3.00/-2.00/120，左眼原样返回 */
async function transposeDefault(page: Page) {
  await page.goto("/");
  await page.getByLabel("目标记法").selectOption("minus");
  await fillEye(page, "右眼", "1.00", "2.00", "30");
  await fillEye(page, "左眼", "-1.25", "-0.50", "85");
  await page.getByRole("button", { name: "核对并转置" }).click();
  await expect(page.getByTestId("grinding-order")).toContainText(
    "OD（右眼） S +3.00 C -2.00 A 120",
  );
}

test.describe("双眼录入复核（真实后端联调）", () => {
  test("复核输入区仅在成功生成磨片参数后展示", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByLabel("双眼录入复核")).toHaveCount(0);

    await transposeDefault(page);
    await expect(page.getByLabel("双眼录入复核")).toBeVisible();
  });

  test("完全吻合：给出可继续加工的明确提示", async ({ page }) => {
    await transposeDefault(page);
    await fillEntry(page, "复核右眼", "+3.00", "-2.00", "120");
    await fillEntry(page, "复核左眼", "-1.25", "-0.50", "85");
    await page.getByRole("button", { name: "复核录入" }).click();

    await expect(
      page.getByText("双眼录入全部吻合，可继续加工 ✓"),
    ).toBeVisible();
    await expect(page.getByText("复核不吻合")).toHaveCount(0);
  });

  test("单眼单字段不符：差异标在对应字段旁", async ({ page }) => {
    await transposeDefault(page);
    // 右眼 S 录成 +3.25（期望 +3.00），其余均正确
    await fillEntry(page, "复核右眼", "+3.25", "-2.00", "120");
    await fillEntry(page, "复核左眼", "-1.25", "-0.50", "85");
    await page.getByRole("button", { name: "复核录入" }).click();

    await expect(page.getByText("复核不吻合：共 1 处差异")).toBeVisible();
    await expect(page.getByTestId("diff-right-S")).toHaveText(
      "不吻合：期望 +3.00，录入 +3.25",
    );
    // 其它字段无标注
    await expect(page.getByTestId("diff-right-C")).toHaveCount(0);
    await expect(page.getByTestId("diff-right-A")).toHaveCount(0);
    await expect(page.getByTestId("diff-left-S")).toHaveCount(0);
  });

  test("左右眼抄串：两眼均报差异", async ({ page }) => {
    await transposeDefault(page);
    await fillEntry(page, "复核右眼", "-1.25", "-0.50", "85");
    await fillEntry(page, "复核左眼", "+3.00", "-2.00", "120");
    await page.getByRole("button", { name: "复核录入" }).click();

    await expect(page.getByText("复核不吻合：共 6 处差异")).toBeVisible();
    await expect(page.getByTestId("diff-right-S")).toContainText("期望 +3.00");
    await expect(page.getByTestId("diff-left-S")).toContainText("期望 -1.25");
  });

  test("非法录入：整次 422，磨片参数保留且显示具体原因", async ({ page }) => {
    await transposeDefault(page);

    // 先做一次完全吻合的复核，留下结论
    await fillEntry(page, "复核右眼", "+3.00", "-2.00", "120");
    await fillEntry(page, "复核左眼", "-1.25", "-0.50", "85");
    await page.getByRole("button", { name: "复核录入" }).click();
    await expect(
      page.getByText("双眼录入全部吻合，可继续加工 ✓"),
    ).toBeVisible();

    // 改成科学计数法录入 → 整次复核 422
    await page.getByLabel("复核右眼 S 球镜").fill("1e0");
    await page.getByRole("button", { name: "复核录入" }).click();

    const alert = page.getByRole("alert");
    await expect(alert).toContainText("复核录入被拒绝");
    await expect(alert).toContainText("科学计数法");

    // 过期结论被移除，已生成的磨片参数仍然保留
    await expect(
      page.getByText("双眼录入全部吻合，可继续加工 ✓"),
    ).toHaveCount(0);
    await expect(page.getByTestId("grinding-order")).toContainText(
      "OD（右眼） S +3.00 C -2.00 A 120",
    );
    await expect(page.getByLabel("核对结果", { exact: true })).toBeVisible();
  });

  test("修改原处方或目标记法后立即清除旧复核结论", async ({ page }) => {
    await transposeDefault(page);
    await fillEntry(page, "复核右眼", "+3.00", "-2.00", "120");
    await fillEntry(page, "复核左眼", "-1.25", "-0.50", "85");
    await page.getByRole("button", { name: "复核录入" }).click();
    await expect(
      page.getByText("双眼录入全部吻合，可继续加工 ✓"),
    ).toBeVisible();

    // 改动原处方 → 结论立即消失（磨片参数仍在，需重新转置）
    await page.getByLabel("右眼 S（球镜）").fill("2.00");
    await expect(
      page.getByText("双眼录入全部吻合，可继续加工 ✓"),
    ).toHaveCount(0);

    // 重新复核吻合后，切换目标记法 → 结论同样立即消失
    await page.getByLabel("右眼 S（球镜）").fill("1.00");
    await page.getByRole("button", { name: "复核录入" }).click();
    await expect(
      page.getByText("双眼录入全部吻合，可继续加工 ✓"),
    ).toBeVisible();
    await page.getByLabel("目标记法").selectOption("plus");
    await expect(
      page.getByText("双眼录入全部吻合，可继续加工 ✓"),
    ).toHaveCount(0);
  });

  test("吻合后改动设备录入值：结论立即作废，回到未复核", async ({ page }) => {
    await transposeDefault(page);
    await fillEntry(page, "复核右眼", "+3.00", "-2.00", "120");
    await fillEntry(page, "复核左眼", "-1.25", "-0.50", "85");
    await page.getByRole("button", { name: "复核录入" }).click();
    await expect(
      page.getByText("双眼录入全部吻合，可继续加工 ✓"),
    ).toBeVisible();

    // 修改右眼设备球镜 → 全部吻合的宣告必须立即消失，且不变成“不吻合”
    await page.getByLabel("复核右眼 S 球镜").fill("+3.25");
    await expect(
      page.getByText("双眼录入全部吻合，可继续加工 ✓"),
    ).toHaveCount(0);
    await expect(page.getByText("复核不吻合")).toHaveCount(0);
    await expect(page.getByTestId("diff-right-S")).toHaveCount(0);

    // 磨片参数不受影响
    await expect(page.getByTestId("grinding-order")).toContainText(
      "OD（右眼） S +3.00 C -2.00 A 120",
    );
  });

  test("重新生成另一张合法参数后：复核录入清空，不复用旧处方的设备值", async ({
    page,
  }) => {
    await transposeDefault(page);
    await fillEntry(page, "复核右眼", "+3.00", "-2.00", "120");
    await fillEntry(page, "复核左眼", "-1.25", "-0.50", "85");
    await page.getByRole("button", { name: "复核录入" }).click();
    await expect(
      page.getByText("双眼录入全部吻合，可继续加工 ✓"),
    ).toBeVisible();

    // 换另一张合法处方并重新生成参数（右眼已符合负柱镜记法，原样返回）
    await fillEye(page, "右眼", "0.50", "-0.75", "60");
    await page.getByRole("button", { name: "核对并转置" }).click();
    await expect(page.getByTestId("grinding-order")).toContainText(
      "OD（右眼） S +0.50 C -0.75 A 60",
    );

    // 新复核区：双眼设备录入全部清空，等待重新填写；旧吻合结论不沿用
    for (const label of [
      "复核右眼 S 球镜",
      "复核右眼 C 柱镜",
      "复核右眼 A 轴位",
      "复核左眼 S 球镜",
      "复核左眼 C 柱镜",
      "复核左眼 A 轴位",
    ]) {
      await expect(page.getByLabel(label)).toHaveValue("");
    }
    await expect(
      page.getByText("双眼录入全部吻合，可继续加工 ✓"),
    ).toHaveCount(0);
  });

  test("复核响应在途时修改原处方球镜：旧响应到达后不得回填过期结论", async ({
    page,
  }) => {
    let releaseVerify: () => void = () => {};
    await page.route("**/api/v1/verify-entry", async (route) => {
      await new Promise<void>((resolve) => {
        releaseVerify = resolve;
      });
      await route.continue();
    });

    await transposeDefault(page);
    await fillEntry(page, "复核右眼", "+3.00", "-2.00", "120");
    await fillEntry(page, "复核左眼", "-1.25", "-0.50", "85");
    const verifyRequest = page.waitForRequest("**/api/v1/verify-entry");
    await page.getByRole("button", { name: "复核录入" }).click();
    await verifyRequest;
    await expect(page.getByRole("button", { name: "复核中…" })).toBeVisible();

    // 响应尚未返回时修改当前原处方球镜
    await page.getByLabel("右眼 S（球镜）").fill("2.00");
    await expect(
      page.getByText("双眼录入全部吻合，可继续加工 ✓"),
    ).toHaveCount(0);

    // 放行旧响应：修改前处方的吻合结论必须被丢弃
    const verifyResponse = page.waitForResponse("**/api/v1/verify-entry");
    releaseVerify();
    await verifyResponse;
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByText("双眼录入全部吻合，可继续加工 ✓"),
    ).toHaveCount(0);
    await expect(page.getByText("复核不吻合")).toHaveCount(0);
    await expect(page.getByTestId("diff-right-S")).toHaveCount(0);
  });

  test("转置响应在途时修改右眼柱镜：旧响应不得展示过期磨片参数或开放复核", async ({
    page,
  }) => {
    let releaseTranspose: () => void = () => {};
    await page.route("**/api/v1/transpose", async (route) => {
      await new Promise<void>((resolve) => {
        releaseTranspose = resolve;
      });
      await route.continue();
    });

    await page.goto("/");
    await page.getByLabel("目标记法").selectOption("minus");
    await fillEye(page, "右眼", "1.00", "2.00", "30");
    await fillEye(page, "左眼", "-1.25", "-0.50", "85");
    const transposeRequest = page.waitForRequest("**/api/v1/transpose");
    await page.getByRole("button", { name: "核对并转置" }).click();
    await transposeRequest;

    // 转置响应尚未返回时修改右眼柱镜
    await page.getByLabel("右眼 C（柱镜）").fill("1.75");
    await expect(page.getByTestId("grinding-order")).toHaveCount(0);
    await expect(page.getByLabel("双眼录入复核")).toHaveCount(0);

    // 放行旧响应：修改前处方的磨片参数与复核区必须被丢弃
    const transposeResponse = page.waitForResponse("**/api/v1/transpose");
    releaseTranspose();
    await transposeResponse;
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("grinding-order")).toHaveCount(0);
    await expect(page.getByLabel("双眼录入复核")).toHaveCount(0);
    await expect(page.getByText("+3.00")).toHaveCount(0);
  });
});
