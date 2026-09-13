# 眼镜处方柱镜记法核对（Rx Transposition）

加工中心收到的眼镜处方可能是**正柱镜**或**负柱镜**记法，而磨片设备只接受操作员指定的一种。
本项目提供核对页与 API：单次提交双眼的球镜 S、柱镜 C、轴位 A 与目标记法，
后端以**四分之一屈光度整数运算**完成校验与转置，页面真实展示后端返回的
原值、转置值与等价校核，最终双眼要么共同形成可抄入磨片单的唯一参数，要么共同显示拒绝。

部分处方除球柱镜和轴位外还带**棱镜补偿**：每眼可选携带棱镜度数 P 与基底方向 B，
棱镜不参与球柱镜换算，在转置结果中原样返回并随磨片参数一起抄入设备，
避免操作员转抄时遗漏这项加工参数。

加工中心偶尔收到**仅配单眼**的处方：处方对象可携带加工范围 `scope`
（`both` 双眼，默认 / `right` 仅右眼 / `left` 仅左眼），操作员选择单眼后
只填写该眼的球柱镜、轴位及可选棱镜，接口按同一套整数规则校验并仅返回所选眼结果，
不再迫使操作员伪造另一眼数据。

加工中心还会接到**无需统一柱镜符号、只需整理为设备录入单**的处方：
目标记法除 `minus`（负柱镜）、`plus`（正柱镜）外还可选 `keep`（保持原记法）。
选择该项后各参与眼别的输出均保持输入数值与轴位（`changed` 恒为 `false`），
等价校核仍由整数域结果生成；页面与复制内容都会明确标示本次未做符号转换，
避免被误认成统一记法结果。

磨片参数抄入设备后，页面还提供一次**录入复核**：操作员把设备中当前加工范围内的
S/C/A（含棱镜时连同 P/B）再次录入，后端复用同一套校验与整数转置逻辑重算期望值
并逐字段比较，防止手工录入串眼或改错数值。

## 业务规则

- S、C：只接受 `-20.00` 至 `+20.00`、步长 `0.25` 的十进制定点数（`1e0`、`5e-1` 等科学计数法写法一律拒绝，即使其数值落在合法范围内）。
- A：C 非零时必须是 `1` 至 `180` 的整数；C 为零时 A 必须为 `0`。
- P（可选棱镜度数）：`0.00` 至 `10.00`、步长 `0.25` 的十进制定点数。
- B（可选基底方向）：P 非零时必须是 `上`、`下`、`内`、`外` 之一；P 为零时不接受方向；只给方向不给度数同样拒绝。
- 棱镜按眼可选：未填写棱镜的旧请求按原契约成功，响应省略棱镜字段；棱镜不参与球柱镜换算，在转置结果中原样返回。
- 加工范围 `scope`（可选）：`both`（默认，双眼）、`right`（仅右眼）、`left`（仅左眼）。
  单眼范围只校验并返回所选眼，另一眼缺失、空白或携带任意数据均不参与；
  未传 `scope` 的旧请求按双眼契约解析并返回原结构（响应不含 `scope` 字段）。
- 任一眼不合规 → 整张处方返回 **422**，不输出另一眼结果。
- 目标记法：`minus` 统一为负柱镜、`plus` 统一为正柱镜、`keep` 保持原记法。
  C 为零或已符合目标符号 → 原样返回；`keep` 时无论柱镜正负一律原样返回
  （`changed` 为 `false`，不做转置，故不存在转置后 S' 超界）；否则：
  `S' = S + C`，`C' = -C`，`A' = A + 90`（`A' > 180` 时减 180）。
  所得 `S'` 超出 `±20.00` 同样整单拒绝。
- 等价校核：原轴方向功率为 `S`、垂直方向为 `S + C`；
  转置后对应两个物理方向的功率必须分别相等（`S' + C' = S`、`S' = S + C`）。
- 结果固定显示两位小数（如 `+3.00`、`-0.50`、`0.00`）。

## 快速启动（Docker Compose）

```bash
docker compose up --build
# 核对页: http://localhost:8080   API: http://localhost:8000/api/docs
```

覆盖宿主端口：

```bash
WEB_PORT=9000 API_PORT=9001 docker compose up --build
# 或复制 .env.example 为 .env 后修改
```

## 一次性验收（verify 服务）

```bash
docker compose --profile verify up --build --exit-code-from verify verify
```

verify 依次执行：服务连通性检查 → `pytest`（转置公式与边界）→
`Vitest`（前端单元/组件）→ `Playwright`（真实浏览器 + 真实后端联调），
全部通过后退出码为 0，否则非零。

## 本地开发

```bash
# 后端（Python 3.11+）
cd api
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
uvicorn app.main:app --reload          # http://localhost:8000
pytest -v                              # 后端测试

# 前端（Node 20+）
cd web
npm ci
npm run dev                            # http://localhost:5173（/api 代理到 8000）
npm test                               # Vitest
npx playwright install chromium        # 首次运行 e2e 前
npm run e2e                            # Playwright（自动构建并 preview，需后端已启动）
```

## API 契约

`POST /api/v1/transpose`

```json
{
  "target": "minus",
  "right": { "S": "1.00", "C": "2.00", "A": 30, "P": "2.00", "B": "外" },
  "left":  { "S": "-1.25", "C": "-0.50", "A": 85 }
}
```

`200 OK`（S/C/P 为固定两位小数字符串；check 为两个物理方向的等价校核；
携带棱镜的眼别原样返回 `prism`，未携带则省略该字段）：

```json
{
  "target": "minus",
  "right": {
    "input":  { "S": "+1.00", "C": "+2.00", "A": 30 },
    "output": { "S": "+3.00", "C": "-2.00", "A": 120 },
    "changed": true,
    "prism": { "P": "+2.00", "B": "外" },
    "check": {
      "originalAxisDirection":  { "degrees": 30,  "original": "+1.00", "transposed": "+1.00" },
      "perpendicularDirection": { "degrees": 120, "original": "+3.00", "transposed": "+3.00" },
      "equivalent": true
    }
  },
  "left": { "...": "..." }
}
```

`422 Unprocessable Entity`（任一眼不合规，整单拒绝，无任何一眼的结果）：

```json
{ "detail": ["左眼.A: C 为零时 A 必须为 0，收到 90"] }
```

单眼处方：请求携带 `scope` 且只提交所选眼（另一眼不随请求发出）：

```json
{
  "target": "minus",
  "scope": "right",
  "right": { "S": "1.00", "C": "2.00", "A": 30 }
}
```

`200 OK`（仅返回所选眼结果，并回传 `scope` 标明本次加工范围）：

```json
{
  "target": "minus",
  "scope": "right",
  "right": {
    "input":  { "S": "+1.00", "C": "+2.00", "A": 30 },
    "output": { "S": "+3.00", "C": "-2.00", "A": 120 },
    "changed": true,
    "check": { "...": "..." }
  }
}
```

保持原记法（`target` 为 `keep`）：参与眼别无论正、负柱镜都原样返回，
`changed` 恒为 `false`，`check` 仍照常给出两个物理方向的等价校核；
混合正、负柱镜的双眼处方也各自保持原记法：

请求：

```json
{
  "target": "keep",
  "right": { "S": "1.00", "C": "2.00", "A": 30 },
  "left":  { "S": "-1.25", "C": "-0.50", "A": 85 }
}
```

```json
{
  "target": "keep",
  "right": {
    "input":  { "S": "+1.00", "C": "+2.00", "A": 30 },
    "output": { "S": "+1.00", "C": "+2.00", "A": 30 },
    "changed": false,
    "check": {
      "originalAxisDirection":  { "degrees": 30,  "original": "+1.00", "transposed": "+1.00" },
      "perpendicularDirection": { "degrees": 120, "original": "+3.00", "transposed": "+3.00" },
      "equivalent": true
    }
  },
  "left": {
    "input":  { "S": "-1.25", "C": "-0.50", "A": 85 },
    "output": { "S": "-1.25", "C": "-0.50", "A": 85 },
    "changed": false,
    "check": { "...": "..." }
  }
}
```

`keep` 复用同一套定点数、轴位联动与棱镜组合校验：非法处方仍整单 **422**；
`scope`、`prism` 字段规则与 `plus`/`minus` 完全一致。未携带 `keep`
目标值的既有正、负记法请求响应保持不变。

`POST /api/v1/verify-entry`（录入复核：携带原转置请求与操作员录入值）

```json
{
  "prescription": {
    "target": "minus",
    "right": { "S": "1.00", "C": "2.00", "A": 30, "P": "2.00", "B": "外" },
    "left":  { "S": "-1.25", "C": "-0.50", "A": 85 }
  },
  "entry": {
    "right": { "S": "+3.00", "C": "-2.00", "A": 120, "P": "2.00", "B": "内" },
    "left":  { "S": "-1.25", "C": "-0.50", "A": 85 }
  }
}
```

`200 OK`（`match` 为整单是否吻合；`differences` 列出每处差异的眼别、字段、期望值与录入值，
除 S、C、A 外还逐眼比较棱镜度数 P 与基底方向 B）：

```json
{
  "match": false,
  "differences": [
    { "eye": "right", "field": "B", "expected": "外", "entered": "内" }
  ]
}
```

- 复核复用与转置相同的校验与整数转置逻辑重算期望值，比较在四分之一屈光度整数域完成。
  `keep` 处方的期望值即原处方逐字段数值与轴位（含棱镜），原样录入才会吻合。
- 复核范围跟随原处方的加工范围：单眼处方只重算并比较所选眼，另一眼不参与；
  差异沿用现有眼别与字段契约（`eye` / `field` / `expected` / `entered`）。
- 原转置请求或录入值任一项不合规 → 整次复核 **422**（如 `复核录入.右眼.S: 必须是十进制定点数…`），不返回任何比对结果。
- 页面上复核输入区仅在成功生成磨片参数后展示；修改原处方立即作废旧复核结论；
  复核 422 时已生成的磨片参数保留，仅移除过期结论并显示原因。
- 切换目标记法（含选入/选离“保持原记法”）会清空旧加工结果与复核结论，
  进行中的旧响应返回后不能回填到新选择；`keep` 结果在标题、结果卡横幅与
  复制内容中均明确标示“保持原记法（未做符号转换）”。
- 页面加工范围默认双眼；切换加工范围会清空不再适用的输入、已生成的加工值与复核结论，
  进行中的旧请求返回后不能恢复这些内容。
- 页面默认不展开棱镜输入；展开后修改任一棱镜值同样立即作废旧复核结论。

## 目录结构

```
api/            FastAPI 后端（app/transpose.py 为纯整数运算的领域核心）
  tests/        pytest：公式、边界、原子性、等价校核
web/            React + Vite 前端（页面只展示后端结果，不做换算）
  src/__tests__/  Vitest：API 客户端与组件行为
  e2e/            Playwright：浏览器联调
verify/         一次性验收服务（pytest + Vitest + Playwright）
docker-compose.yml
```
