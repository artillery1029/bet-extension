# 模拟协议快照

`simulation-replay-request.json`是自包含的模拟DTO合同样例，使用三条NOT头寸检验精度、幂等、来源标记和持久化。它不是平台原始回执、当前订单簿、已成交记录或独立审计过的ScanResult；`contract:` ID不能用于平台寻址。数值仅为本地协议回放，零费不代表任何账户真实费率。

浏览器测试读取此文件，为本次独立测试生成幂等键，保留`sourceMode:replay`和原始报价时间。测试不导入采集项目/看板代码，也不请求行情或交易平台。跨项目真实联调只使用HTTP `host/protocol.ts`中定义的DTO。
