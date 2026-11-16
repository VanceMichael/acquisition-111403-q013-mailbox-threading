# 来源资料约定

项目邮件资料归档器。当前读取单封已整理邮件；合作方提供mboxrd文本归档和发布清单，不连接任何真实邮箱。

## 交互与身份

GET /message返回单封对象。GET /archives列出archiveId/version/url/complete。GET /mbox/:id为mboxrd文本，From 空格起始行为分隔行，正文中被转义的 >From 行应去掉一层 >，不能按正文中的From子串分割；头部允许折行，Message-ID只是声明身份，不是正文摘要。References有顺序，In-Reply-To可以多个；缺失ID允许保留档案内位置身份但不能凭主题归并。complete=false可能尾部未写完。 mbox响应提供按实际字节SHA256生成的ETag及Range: bytes=start-end；If-Range不匹配时返回完整当前版本，不保证旧版本仍在线。

## 外部变化

正常资料在 `fixtures/source.mjs`。同一来源可能处于这些外部阶段：conflict、partial。集成测试通过来源实例的`setPhase`切换外部状态，这不是线上业务接口。阶段内同一URL的响应可以改变，其余URL保留正常资料；来源的请求轨迹在实例的`requests`中可查，控制方法不对网络开放。未知地址返回404，非法请求返回非成功状态。

## 已有收件边界

`src/reader.mjs`收取/message提供的已整理资料；`src/ingest.mjs`按/archives清单采集mboxrd归档：流式解析分隔行、头部折行与`>From`转义，完整归档收到末尾，`complete=false`的归档最后一封留待补齐。归档按资料标识和内容摘要区分版本，原文按响应字节摘要独立存储，打开归档时逐份校验。有Message-ID的邮件以编号为身份，缺失编号的保留档案内位置身份；同一编号的不同正文全部保留。会话关系只依据Message-ID/References/In-Reply-To构造，被引用而未到达的编号保持待补齐状态。格式异常的邮件连同原文留在异常区，不中断后续采集。来源文件、接收记录和对外查询不共享内存对象。未声明的协议能力不作推断；格式子集以本页和实际来源为准。
