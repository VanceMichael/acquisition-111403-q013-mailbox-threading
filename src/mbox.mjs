// mboxrd 流式解析：只把 "From " 起始行当作分隔行，正文中的 >From 去掉一层 >，
// 不按正文里的 From 子串切分。逐行产出，整份归档不需要常驻内存。

const FIELD_LINE = /^[!-9;-~]+:/;
const CONTINUATION = /^[ \t]/;
// mboxrd 转义：行首一个或多个 > 后紧跟 From(空格或行尾)。还原时只去掉一层 >。
const QUOTED_FROM = /^>(?=>*From(?: |$))/;
const ID_TOKEN = /<([^<>\s][^<>]*)>/g;
// 单封邮件在内存中的上限；超过后只跟踪边界，不再累积内容。
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
export const MAX_BODY_TEXT = 64 * 1024;

function makeLine(raw, start) {
  let content = raw;
  let eol = false;
  if (content.length && content[content.length - 1] === 0x0a) {
    content = content.subarray(0, content.length - 1);
    eol = true;
  }
  if (content.length && content[content.length - 1] === 0x0d) {
    content = content.subarray(0, content.length - 1);
  }
  return {raw, start, end: start + raw.length, eol, text: content.toString('utf8')};
}

// 把字节流切成行，保留每行的绝对字节偏移（base 为流起始处在文件中的偏移）。
// 行字节从流块中拷出：行对象若持有流块视图，会把整个流块拖进老年代，
// 主 GC 惰性触发时死对象会按归档大小堆积；拷出后流块在年轻代即被回收。
export async function* iterLines(stream, base = 0) {
  let buffer = Buffer.alloc(0);
  let position = base;
  for await (const chunk of stream) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    let start = 0;
    for (;;) {
      const newline = buffer.indexOf(0x0a, start);
      if (newline === -1) break;
      const raw = Buffer.from(buffer.subarray(start, newline + 1));
      yield makeLine(raw, position);
      position += raw.length;
      start = newline + 1;
    }
    buffer = buffer.subarray(start);
  }
  if (buffer.length) yield makeLine(Buffer.from(buffer), position);
}

// 产出消息对象：{type:'message', separator, separatorLine, head, body, terminator, start, end, contentEnd, tail, oversize}
// 以及分隔线之前的异常内容：{type:'junk', lines, start, end, tail}
// 分隔行之前的单个空行是消息终止符，不属于正文，也不计入消息内容切片（contentEnd），
// 这样同一封邮件在归档追加前后保持相同的内容身份；terminator 保留该行以便定位。
// tail=true 表示文件末尾的最后一封；调用方在归档未写完（complete=false）时应跳过它。
export async function* parseMbox(stream, {base = 0} = {}) {
  let current = null;
  let junk = null;
  let endOfFile = base;
  for await (const line of iterLines(stream, base)) {
    endOfFile = line.end;
    if (line.text.startsWith('From ')) {
      if (current) {
        // 终止符：分隔行之前恰好一个空行归消息结构，其余空行仍是正文。
        if (!current.oversize && current.body.length && current.body[current.body.length - 1].text === '') {
          current.terminator = current.body.pop();
        }
        current.end = line.start;
        current.contentEnd = current.terminator ? current.terminator.start : line.start;
        yield {...current, tail: false};
      } else if (junk && junk.lines.some(item => item.text.length)) {
        junk.end = line.start;
        yield {...junk, tail: false};
      }
      current = {
        type: 'message', separator: line.text, separatorLine: line,
        start: line.start, head: [], body: [], blankLine: null, terminator: null, inBody: false,
        bytes: line.raw.length, oversize: false
      };
      junk = null;
      continue;
    }
    if (!current) {
      if (!junk) junk = {type: 'junk', start: line.start, lines: []};
      junk.lines.push(line);
      continue;
    }
    current.bytes += line.raw.length;
    if (current.bytes > MAX_MESSAGE_BYTES) {
      // 超出单封处理上限：丢弃已累积内容，只继续跟踪到下一分隔行。
      current.oversize = true;
      current.head = [];
      current.body = [];
      current.blankLine = null;
      current.inBody = true;
      continue;
    }
    if (current.inBody) current.body.push(line);
    else if (line.text.length === 0) { current.blankLine = line; current.inBody = true; }
    else current.head.push(line);
  }
  if (current) {
    current.end = endOfFile;
    current.contentEnd = endOfFile;
    yield {...current, tail: true};
  } else if (junk && junk.lines.some(item => item.text.length)) {
    junk.end = endOfFile;
    yield {...junk, tail: true};
  }
}

// 校验并展开头部。保留 Message-ID/References/In-Reply-To 等字段的来源原文
// （折行结构原样保留，换行统一为 \n），另给出展开后的取值用于提取编号。
export function analyzeMessage(message) {
  const headers = [];
  for (const line of message.head) {
    const text = line.text;
    if (CONTINUATION.test(text)) {
      if (!headers.length) return {ok: false, reason: '头部续行没有所属字段'};
      headers[headers.length - 1].raw += '\n' + text;
      continue;
    }
    if (!FIELD_LINE.test(text)) return {ok: false, reason: '头部行无法识别: ' + text.slice(0, 40)};
    const colon = text.indexOf(':');
    headers.push({name: text.slice(0, colon).toLowerCase(), raw: text.slice(colon + 1).replace(/^ /, '')});
  }
  if (!headers.length) return {ok: false, reason: '缺少头部字段'};
  const find = name => headers.find(header => header.name === name);
  const unfold = header => (header ? header.raw.replace(/\n(?=[ \t])/g, '') : null);
  const messageIdHeader = find('message-id');
  const referencesHeader = find('references');
  const inReplyToHeader = find('in-reply-to');
  const subjectHeader = find('subject');
  const fromHeader = find('from');
  const dateHeader = find('date');
  const messageIds = messageIdHeader ? extractIds(unfold(messageIdHeader)) : [];
  return {
    ok: true,
    messageId: messageIds.length ? messageIds[0] : null,
    messageIds,
    messageIdRaw: messageIdHeader ? messageIdHeader.raw : null,
    references: referencesHeader ? extractIds(unfold(referencesHeader)) : [],
    referencesRaw: referencesHeader ? referencesHeader.raw : null,
    inReplyTo: inReplyToHeader ? extractIds(unfold(inReplyToHeader)) : [],
    inReplyToRaw: inReplyToHeader ? inReplyToHeader.raw : null,
    subject: subjectHeader ? unfold(subjectHeader) : null,
    from: fromHeader ? unfold(fromHeader) : null,
    date: dateHeader ? unfold(dateHeader) : null
  };
}

// 按出现顺序提取 <...> 编号并去重；References 的顺序、In-Reply-To 的多个编号都保留。
export function extractIds(value) {
  const ids = [];
  for (const match of value.matchAll(ID_TOKEN)) {
    const token = '<' + match[1].trim() + '>';
    if (!ids.includes(token)) ids.push(token);
  }
  return ids;
}

export function unescapeBodyLine(text) {
  return text.replace(QUOTED_FROM, '');
}

export function bodyText(message) {
  let text = '';
  for (const line of message.body) text += unescapeBodyLine(line.text) + (line.eol ? '\n' : '');
  if (text.length > MAX_BODY_TEXT) return {text: text.slice(0, MAX_BODY_TEXT), truncated: true};
  return {text, truncated: false};
}

// 异常邮件的原始字节：分隔行起、到消息内容结束（不含终止符）的完整切片。
export function rawBytes(message) {
  const parts = [message.separatorLine.raw];
  for (const line of message.head) parts.push(line.raw);
  if (message.blankLine) parts.push(message.blankLine.raw);
  for (const line of message.body) parts.push(line.raw);
  return Buffer.concat(parts);
}
