# Odds Extension · 本地模拟

这是一个可单独复制、安装和运行的npm项目，包含Chrome MV3插件及本机模拟宿主。它不依赖其他项目的package、源码、构建产物或node_modules。外部看板只通过HTTP协议向宿主提交模拟意图。

当前交付仅保存`SIMULATED`记录：没有平台下单、钱包签名、自动补单、真实成交或链上确认功能，不自动打开官方网页。宿主不发起外网请求；插件没有内容脚本、平台域名权限、钱包权限或外部消息入口。

独立项目默认端口约定：采集API `7070`、看板服务 `7071`、Vite开发页面 `7072`、本项目模拟宿主 `7073`。插件只连接7073；宿主仅允许7071/7072的精确回环页面Origin及明确配置的插件ID。

## 环境与安装

要求Node.js `>=26.4.0 <27`、npm和Chrome。Node使用内置`node:sqlite`；开发工具及Fastify均锁定版本，安装锁文件位于本项目。

在本目录执行：

```powershell
npm ci
Copy-Item .env.example .env
npm run build
```

配置只读取**本项目根目录**`.env`，即使从别的工作目录启动也不会读取父目录配置。已有进程环境变量优先。首次安装尚无`.env`也可使用默认模拟配置；不要覆盖已有自定义配置。

## 加载插件和启动宿主

1. 在Chrome扩展管理页打开开发者模式，选择“加载已解压的扩展程序”，加载本项目`dist`目录。
2. 将Chrome显示的32位插件ID写入本项目`.env`的`XHH_HOST_EXTENSION_IDS`。宿主只接受明确配置的插件ID。
3. 运行`npm run start:host`，或开发时运行`npm run dev:host`。
4. 将启动终端显示的本次随机配对密钥手动粘贴到插件弹窗，点击“配对本机宿主”。密钥包含凭据，不要截图分享或上传整个终端输出。
5. 刷新查看意图。“创建一条演示模拟”使用标记为DEMO的虚构数据，只检查本地闭环。取消只标记本地模拟取消。

宿主固定绑定`127.0.0.1`，默认端口7073；插件实际URL和CSP也限定7073。每次宿主启动生成新密钥；旧密钥失效，数据库记录保留。密钥只存在插件`chrome.storage.session`，不写同步或永久配置。浏览器重启/插件重载后需重新配对。

默认数据库目录为`LOCALAPPDATA/xhh-bet/host`，可用`XHH_HOST_DATA_DIR`指定。这里沿用旧数据位置以支持迁移后的记录读取。配置、备份、恢复和API细节见[宿主文档](host/README.md)。

## HTTP联调边界

独立看板可使用[本项目协议](host/protocol.ts)，通过`http://127.0.0.1:7073/api/intents`提交`mode:simulation`。开发页面只允许精确Origin `http://127.0.0.1:7072`及`http://localhost:7072`；生产本地看板允许相应7071端口。所有API均需本次Bearer密钥；看板不能读取宿主密钥文件或绕过手动配对。

`sourceMode`表示`live/replay/demo`报价来源，执行仍为simulation。插件展示保存的来源及`sourceObservedAt`原报价时间；缺标记旧记录显示“来源未标记”。本宿主不验证行情、规则、资金、深度或盈利，保存记录不代表执行批准。

插件演示在发送前保存完整正文和稳定幂等键到`chrome.storage.local`。超时或中断后重试原请求；宿主返回原ID。存在未确认请求时禁止覆盖它创建新演示，重新配对也保留待重试请求。

Chrome特权后台fetch可能不带Origin，插件附上`X-Xhh-Extension-Id`。宿主只有在实际Origin缺失且ID已明确配置时才采用它，仍验证随机Bearer密钥；实际网页Origin不能被此声明覆盖。声明头不是浏览器签发的身份凭证。所有显示文本使用DOM `textContent`写入。

## 独立验证

```powershell
npm run typecheck
npm test
npm run build
npm run test:browser
```

`npm test`覆盖并发幂等、同键冲突409、SQLite WAL及重启恢复、取消后重试、严格Origin/Host/Token保护、拒绝live/未知字段/非法来源、精度和回放时间持久化。

浏览器测试自启动随机回环端口的宿主和临时页面，使用本项目[模拟协议快照](fixtures/README.md)，不导入或启动采集项目/看板，也不访问行情与交易平台。它启动独立无头Chrome、临时用户目录和随机CDP，从`DevToolsActivePort`读取地址；验证真实MV3加载、配对、错误凭据拒绝、演示、稳定幂等重试、HTTP回放提交、来源展示及数据库重启恢复。测试仅在临时插件副本调整宿主端口，完成后关闭实例并清理目录，不输出密钥。

Windows默认Chrome路径为`C:\Program Files\Google\Chrome\Application\chrome.exe`。其他位置可通过`XHH_TEST_CHROME`指定。MV3无头测试要求Chrome支持CDP `Extensions.loadUnpacked`及`--enable-unsafe-extension-debugging`；本次验证使用Chrome158。普通插件安装仍遵循manifest的最低版本要求，不代表所有Chrome版本均已验证。

## 看板HTTP集成测试宿主

先执行`npm run build:host`，再将`UI_HOST_TEST_CONFIG`设为一个**尚不存在**的临时JSON绝对路径，并运行`npm run test:host:serve`。工具固定监听7073，端口冲突立即失败；使用自己创建的临时数据库，不读取个人`.env`或真实宿主数据库。它只输出`UI integration host ready`，将`{token,hostUrl,dataDir}`以独占新建方式写入指定文件，供另一个项目通过HTTP读取联调。不要打印该文件或提交到版本库。

测试看板仍使用受信7072/7071 Origin和Bearer密钥。完成后在工具标准输入发送一行`shutdown`，或发送SIGINT/SIGTERM，它关闭宿主并清理自己创建的配置文件、临时数据库；不会删除原先存在的文件。测试父进程也可通过Node IPC发送`shutdown`。Windows强制结束进程无法执行JS清理，应使用标准输入关闭。此工具不生成实时行情，不签名，不下单，也不导入看板代码。

## 尚未交付

采用手动loopback配对，没有Native Messaging安装器、registry修改、系统服务、自动安装或真实执行桥接。正式分发签名、企业安装、升级迁移、备份调度和操作系统账户ACL仍需后续交付。当前宿主本身即使收到实盘请求也会拒绝，不能称为实盘签名或交易就绪。
