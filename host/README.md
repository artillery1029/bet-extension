# 本地模拟宿主

本宿主只保存模拟意图和事件，状态 `SIMULATED` 不表示平台接受订单、成交或链上确认。没有钱包、私钥、平台下单、自动补单或官方网页自动操作功能。服务不发起外网请求。

## 启动与配对

要求本独立项目指定的 Node 26（使用内置 `node:sqlite`）。在`odds-extension`目录安装依赖后：

```powershell
npm run dev:host
```

CLI启动时自动读取根目录`.env`（若存在），不输出内容；已有进程环境变量优先。固定绑定 `127.0.0.1`，默认端口7073。启动终端显示一次随机256位配对密钥，手动粘贴到自家客户端或插件；HTTP响应不会返回该密钥，服务禁用请求日志，不将密钥写入数据库。终端内容仍包含配对凭据，请勿分享截图或将整个终端输出当作公共日志上传。每次重启生成新密钥；已保存意图不受影响。

只允许自家页面的精确Origin：`http://127.0.0.1:7072`、`http://localhost:7072`（开发）及相应7071端口（生产本地看板）。插件还需要显式配置它的ID：

```powershell
$env:XHH_HOST_EXTENSION_IDS = '替换为chrome扩展页显示的32位a到p字母ID'
npm run dev:host
```

不接受通配Origin或任意扩展。所有API读写都需要 `Authorization: Bearer <本次密钥>`。网页请求必须携带精确受信Origin；受信Origin的OPTIONS预检无需密钥。Chrome的特权扩展fetch可能省略Origin，所以仅在实际Origin缺失时，允许显式配置的 `X-Xhh-Extension-Id` 声明头配合会话密钥。声明头本身不是身份认证；若实际Origin存在，一律以实际Origin为准，恶意网页不能用声明头覆盖它。无Origin又无允许扩展声明的请求被拒绝。命令行探测建议提供自家dev Origin和Bearer。Host头及连接来源也会校验，防止DNS重绑定访问。

可选配置：`XHH_HOST_PORT`（1–65535）、`XHH_HOST_DATA_DIR`（SQLite目录）。`XHH_HOST_BIND`只有`127.0.0.1`合法，`XHH_HOST_MODE`只有`simulation`合法。插件首版只连接7073；改宿主端口时需同步构建插件，不能输入任意URL。默认数据目录为当前用户 `LOCALAPPDATA/xhh-bet/host`，非Windows回退到用户本地共享目录。

构建后可运行：

```powershell
npm run build:host
npm run start:host
```

## API

请求/响应类型见同目录 `protocol.ts`。

| 路径 | 用途 |
| --- | --- |
| `GET /api/health` | 声明`simulation`、`liveTradingEnabled:false`、SQLite WAL |
| `GET /api/intents?limit=50&offset=0` | 分页记录，limit最大100 |
| `POST /api/intents` | 记录仅模拟意图，首次201，重复同请求200 |
| `GET /api/intents/:id` | 原请求、状态及顺序事件 |
| `POST /api/intents/:id/cancel` | body为`{"mode":"simulation"}`；只标记本地模拟取消 |

POST正文所有估算金额、价格、份额使用十进制字符串（整数最多12位、小数最多48位），保留研究仓位原精度，不转换为浮点执行数量；最多32条头寸、64KiB正文，拒绝未知字段、密钥字段和live模式。模拟意图可来自历史回放或用户提供的数据，**本宿主不会验证其行情、规则等价性、费用、深度或资金**，也不将估算记录称为实盘预检通过。

相同幂等键和相同请求（允许JSON对象属性顺序变化）返回原ID；同键不同请求返回409。重试必须保留原请求、时间和幂等键，不能重新生成时间戳。取消标记也不会被原请求重试覆盖。

可选`sourceMode`仅允许`live`、`replay`、`demo`，表示报价来源；`mode`仍强制为`simulation`。`sourceObservedAt`保留原始报价时间，不替换为提交或扫描时间。旧记录未带来源标记仍可读取；插件显示“来源未标记”，不会默认为实时行情。

## 持久化、恢复与维护

SQLite启用WAL、`synchronous=FULL`、外键和写锁超时。先事务保存`RECORDED`及`INTENT_RECORDED`，再独立事务标记`SIMULATED`；若进程在两个事务之间退出，启动时只补记`SIMULATION_RECOVERED`，不执行任何平台动作。意图和事件没有“清空后恢复执行”例外。

备份前停止宿主并确认进程退出，然后备份整个数据目录；不要只复制运行中的`.sqlite`而漏掉WAL。恢复时先停止服务并保留当前目录副本，再替换为已验证备份并重启。首版数据库schema版本1，未知版本会启动失败，不会静默清空或降级。没有自动清理、迁移、加密或安装系统服务；正式打包升级、操作系统账户ACL和备份调度仍需后续交付。

## 验证

```powershell
npm run test:host
```

测试覆盖并发幂等、冲突409、WAL重启恢复、恢复不重复、取消后幂等、Origin/Host/来源/Token保护、拒绝live与未知字段、正文上限。

当前采用loopback手动密钥配对，**没有实现Native Messaging transport，也不注册Windows registry**。若后续交付Native Messaging，需确定真实extension ID、安装目录、协议帧和用户授权的manifest注册流程；本首版不冒充已安装或已具备实盘签名能力。
