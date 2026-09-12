# 眼镜处方柱镜记法核对（Rx Transposition）

加工中心收到的眼镜处方可能是**正柱镜**或**负柱镜**记法，而磨片设备只接受操作员指定的一种。
本项目提供核对页与 API：单次提交双眼的球镜 S、柱镜 C、轴位 A 与目标记法，
后端以**四分之一屈光度整数运算**完成校验与转置，页面真实展示后端返回的
原值、转置值与等价校核，最终双眼要么共同形成可抄入磨片单的唯一参数，要么共同显示拒绝。

磨片参数抄入设备后，页面还提供一次**双眼录入复核**：操作员把设备中的双眼 S/C/A
再次录入，后端复用同一套校验与整数转置逻辑重算期望值并逐字段比较，
防止手工录入串眼或改错数值。

## 业务规则

- S、C：只接受 `-20.00` 至 `+20.00`、步长 `0.25` 的十进制定点数（`1e0`、`5e-1` 等科学计数法写法一律拒绝，即使其数值落在合法范围内）。
- A：C 非零时必须是 `1` 至 `180` 的整数；C 为零时 A 必须为 `0`。
- 任一眼不合规 → 整张处方返回 **422**，不输出另一眼结果。
- C 为零或已符合目标符号 → 原样返回；否则：
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
  "right": { "S": "1.00", "C": "2.00", "A": 30 },
  "left":  { "S": "-1.25", "C": "-0.50", "A": 85 }
}
```

`200 OK`（S/C 为固定两位小数字符串；check 为两个物理方向的等价校核）：

```json
{
  "target": "minus",
  "right": {
    "input":  { "S": "+1.00", "C": "+2.00", "A": 30 },
    "output": { "S": "+3.00", "C": "-2.00", "A": 120 },
    "changed": true,
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

`POST /api/v1/verify-entry`（双眼录入复核：携带原转置请求与操作员录入值）

```json
{
  "prescription": {
    "target": "minus",
    "right": { "S": "1.00", "C": "2.00", "A": 30 },
    "left":  { "S": "-1.25", "C": "-0.50", "A": 85 }
  },
  "entry": {
    "right": { "S": "+3.00", "C": "-2.00", "A": 120 },
    "left":  { "S": "-1.25", "C": "-0.50", "A": 85 }
  }
}
```

`200 OK`（`match` 为整单是否吻合；`differences` 列出每处差异的眼别、字段、期望值与录入值）：

```json
{
  "match": false,
  "differences": [
    { "eye": "right", "field": "S", "expected": "+3.00", "entered": "+3.25" }
  ]
}
```

- 复核复用与转置相同的校验与整数转置逻辑重算期望值，比较在四分之一屈光度整数域完成。
- 原转置请求或录入值任一项不合规 → 整次复核 **422**（如 `复核录入.右眼.S: 必须是十进制定点数…`），不返回任何比对结果。
- 页面上复核输入区仅在成功生成磨片参数后展示；修改原处方或目标记法立即作废旧复核结论；
  复核 422 时已生成的磨片参数保留，仅移除过期结论并显示原因。

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
