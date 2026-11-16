export const seed={
  "messageId": "<m1@local>",
  "subject": "参数讨论",
  "body": "请核对参数"
};
export const seedPath="/message";
export const routes=[
  {
    "path": "/archives",
    "body": {
      "archives": [
        {
          "archiveId": "a",
          "version": 1,
          "url": "/mbox/a",
          "complete": true
        },
        {
          "archiveId": "b",
          "version": 1,
          "url": "/mbox/b",
          "complete": true
        }
      ]
    },
    "method": "GET",
    "status": 200,
    "query": {},
    "headers": {}
  },
  {
    "path": "/mbox/a",
    "body": "From author@local Sat Nov 14 08:00:00 2026\nMessage-ID: <m2@local>\nReferences: <m0@local>\n <m1@local>\nSubject: 回复参数\n\n正文\n>From 一段被引用的正文\n\nFrom author@local Sat Nov 14 08:01:00 2026\nMessage-ID: <m1@local>\nSubject: 参数讨论\n\n请核对参数\n",
    "method": "GET",
    "status": 200,
    "query": {},
    "headers": {}
  },
  {
    "path": "/mbox/b",
    "body": "From bob@local Sat Nov 14 10:00:00 2026\nMessage-ID: <m5@local>\nIn-Reply-To: <m4@local> <m0@local>\nSubject: 部署方案\n\n先回复，被回复的邮件随后才到\n\nFrom carol@local Sat Nov 14 09:30:00 2026\nMessage-ID: <m4@local>\nReferences: <m0@local>\nSubject: 部署方案\n\n被回复的父邮件\n>>From 双层转义只去一层\n\nFrom dave@local Sat Nov 14 11:00:00 2026\nSubject: 参数讨论\n\n没有声明编号的邮件\n\nFrom bad@local Sat Nov 14 12:00:00 2026\n这不是合法头部\nBody: 整封进入异常区\n\nFrom eve@local Sat Nov 14 13:00:00 2026\nMessage-ID: <m1@local>\nSubject: 参数讨论\n\n请核对参数\n>From 另一客户端保留的引用行\n",
    "method": "GET",
    "status": 200,
    "query": {},
    "headers": {}
  }
];
export const phases={
  "conflict": [
    {
      "path": "/mbox/a",
      "body": "From other@local Sat Nov 14 09:00:00 2026\nMessage-ID: <m1@local>\nSubject: 参数讨论\n\n内容与原封不同\n",
      "method": "GET",
      "status": 200,
      "query": {},
      "headers": {}
    }
  ],
  "partial": [
    {
      "path": "/archives",
      "body": {
        "archives": [
          {
            "archiveId": "a",
            "version": 2,
            "url": "/mbox/a",
            "complete": false
          }
        ]
      },
      "method": "GET",
      "status": 200,
      "query": {},
      "headers": {}
    },
    {
      "path": "/mbox/a",
      "body": "From author@local Sat Nov 14 08:00:00 2026\nMessage-ID: <m2@local>\nReferences: <m0@local>\n <m1@local>\nSubject: 回复参数\n\n正文\n>From 一段被引用的正文\n\nFrom author@local Sat Nov 14 08:01:00 2026\nMessage-ID: <m1@local>\nSubject: 参数讨论\n\n请核对参数\n\nFrom writer@local Sat Nov 14 09:00:00 2026\nMessage-ID: <m3",
      "method": "GET",
      "status": 200,
      "query": {},
      "headers": {}
    }
  ]
};
export const portalKind="";
