# 合作项目邮件归档的会话引用资料采集

项目邮件资料归档器。除读取单封已整理邮件外，还可采集合作方定期交来的 mboxrd 文本归档，按 Message-ID/References/In-Reply-To 构造可继续补齐的会话关系。不连接任何真实邮箱。

## 运行

使用 Node.js 22，依赖由 package-lock.json 固定。安装后可执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run demo
npm start
```

服务启动本地来源与收件接口，默认端口分别为4011和4010。`POST /collect` 领取当前单份资料；`POST /ingest` 采集发布清单中的全部归档；`GET /records`查看结构化记录，`GET /threads`查看会话关系，`GET /quarantine`查看异常邮件，`GET /archives`查看各归档采集状态，`GET /receipts`查看原文凭据，`GET /raw/<摘要>?offset=&length=`按切片读取归档原文，`GET /health`查看服务状态。`PORT`、`SOURCE_PORT`与`DATA_DIR`可分别设置端口和归档目录。示例领取不会自动遍历其他来源资料。

```sh
docker build -t mailbox-threading .
docker run --rm --network none mailbox-threading npm test
docker run --rm --network none mailbox-threading npm run demo
docker run --rm -p 4010:4010 mailbox-threading
```

## 资料组织

`provider/`是独立本地来源，`fixtures/`记录合成资料和来源阶段。`src/reader.mjs`负责现有单份收件；`src/mbox.mjs`流式解析 mboxrd：只把 `From ` 起始行当作分隔行，正文中的 `>From` 行去掉一层 `>`，头部折行正确归并，分隔行之前的单个空行是消息终止符而非正文；`src/ingest.mjs`按发布清单逐份采集，用 Range+If-Range 续传半截下载，按 ETag 摘要校验后入对象库，逐封解析、分批提交，整份归档（季度可达十几GB）不常驻内存；`src/thread.mjs`由记录即时构造会话关系；`src/source.mjs`限定来源地址并记录响应字节；`src/archive.mjs`保存按摘要校验的原文、资料版本、采集状态和异常邮件。`test/`覆盖现有收件、来源边界、原文完整性、归档采集、会话补齐和服务联通。运行不依赖外网、数据库服务或真实设备。

完整来源约定见 `docs/source-contract.md`。项目只访问本地合成资料，不携带真实身份、密钥或业务数据。

## 采集口径

- 身份：有 Message-ID 的记录以 `mid:<编号>` 为身份；缺失编号的保留 `pos:<归档>:<偏移>` 位置身份。同一编号遇到不同正文或不同外壳时按不同版本全部保留，不丢掉其一；Message-ID 只是声明身份，不是正文摘要。
- 会话：只依据 Message-ID/References/In-Reply-To 构造，主题不参与归并。References 的顺序、In-Reply-To 的多个编号都按来源顺序保留，三个字段的来源原文（含折行）随记录保存。被引用但尚未到达的编号进入 `pending` 占位，引用它的邮件挂到占位之下而不是提升为根；占位邮件在后续归档到达时自动归位。
- 边界：`complete=false` 的归档最后一封留待补齐，采集位置停在它的分隔行处；归档追加或转为完整后从该位置继续，已有邮件的身份与内容不变。重启后重复采集同一版本直接跳过。
- 异常：格式异常的邮件连同原文留在异常区（`quarantine/`）可单独检查，后续消息照常采集；单个归档失败不影响其他归档。

## 快速查看

`npm run demo`启动实际来源和收件服务、执行一次当前收件与归档采集并打印查询结果及凭据，临时归档在退出时清理。正常完成时间小于90秒；需要保留数据时用`npm start`及独立`DATA_DIR`。演示反映当前产品能力，不代表全部来源资料已被接纳。
