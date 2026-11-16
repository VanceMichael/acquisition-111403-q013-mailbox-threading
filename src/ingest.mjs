import {createHash, randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {open, rename, stat, unlink} from 'node:fs/promises';
import {analyzeMessage, bodyText, parseMbox, rawBytes} from './mbox.mjs';

// 每批提交的消息数：崩溃后从最近提交位置继续，内存占用与归档大小无关。
const BATCH_SIZE = 2000;

const unquoteEtag = value => {
  if (!value) return null;
  const match = /^"([a-f0-9]{64})"$/.exec(value.trim());
  return match ? match[1] : null;
};

const parseContentRange = value => {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(value || '');
  if (!match) return null;
  return {start: Number(match[1]), end: Number(match[2]), total: match[3] === '*' ? null : Number(match[3])};
};

// 把归档原文流式写入对象库。同一版本的半截下载用 Range+If-Range 续传；
// 内容有变化（ETag 不同）时整份重取。写完校验摘要后原子改名。
async function ensureObject(client, archive, url, etag) {
  if (etag) {
    try { await stat(archive.objectPath(etag)); return {hash: etag, downloaded: 0}; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const partPath = archive.spoolPath((etag || randomUUID()) + '.part');
  let offset = 0;
  try { offset = (await stat(partPath)).size; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (offset && !etag) { await unlink(partPath); offset = 0; }
  const headers = {};
  if (offset) {
    headers.range = `bytes=${offset}-`;
    headers['if-range'] = `"${etag}"`;
  }
  const response = await client.stream(url, {headers});
  let append = false;
  if (response.status === 206) {
    const range = parseContentRange(response.headers.get('content-range'));
    if (!range || range.start !== offset) {
      await response.body?.cancel();
      throw new Error('来源续传位置与本地暂存不一致');
    }
    append = true;
  } else if (response.status === 200) {
    offset = 0;
  } else {
    await response.body?.cancel();
    if (response.status === 416) await unlink(partPath).catch(() => {});
    throw new Error(`归档下载失败: 来源返回 ${response.status}`);
  }
  const hasher = createHash('sha256');
  if (append) {
    // 续传时先对本地已存前缀滚动摘要，再叠加新到的字节。
    for await (const chunk of createReadStream(partPath)) hasher.update(chunk);
  }
  let downloaded = 0;
  const handle = await open(partPath, append ? 'a' : 'w', 0o600);
  try {
    for await (const chunk of response.body) {
      hasher.update(chunk);
      downloaded += chunk.length;
      await handle.write(chunk);
    }
    await handle.sync();
  } finally { await handle.close(); }
  const hash = hasher.digest('hex');
  if (etag && hash !== etag) {
    await unlink(partPath).catch(() => {});
    throw new Error('归档内容摘要与ETag不一致');
  }
  await rename(partPath, archive.objectPath(hash));
  return {hash, downloaded};
}

function toRecord(message, analysis, entry, receipt) {
  const body = bodyText(message);
  const messageId = analysis.messageId;
  return {
    // 有声明编号时以编号为身份；缺失编号时保留档案内位置身份，绝不凭主题归并。
    id: messageId ? 'mid:' + messageId : `pos:${entry.archiveId}:${message.start}`,
    kind: 'mail',
    archiveId: entry.archiveId,
    archiveVersion: entry.version,
    offset: message.start,
    length: message.contentEnd - message.start,
    receipt,
    envelope: message.separator,
    messageId,
    messageIds: analysis.messageIds,
    messageIdRaw: analysis.messageIdRaw,
    references: analysis.references,
    referencesRaw: analysis.referencesRaw,
    inReplyTo: analysis.inReplyTo,
    inReplyToRaw: analysis.inReplyToRaw,
    subject: analysis.subject,
    from: analysis.from,
    date: analysis.date,
    bodyText: body.text,
    bodyTruncated: body.truncated
  };
}

function toQuarantine(message, reason, entry, receipt, withCopy) {
  const item = {
    reason,
    archiveId: entry.archiveId,
    offset: message.start,
    length: (message.contentEnd ?? message.end) - message.start,
    receipt,
    envelope: message.separator ?? null
  };
  if (withCopy) item.bytes = rawBytes(message);
  return item;
}

async function ingestOne(client, archive, entry) {
  if (!entry || typeof entry.archiveId !== 'string' || !entry.archiveId
    || typeof entry.url !== 'string' || !entry.url) {
    throw new Error('归档清单条目无效');
  }
  const complete = entry.complete === true;
  // 探测当前版本：1 字节的 Range 请求换回 ETag 与总长度。
  const probe = await client.stream(entry.url, {headers: {range: 'bytes=0-0'}, timeout: 30000});
  let etag = unquoteEtag(probe.headers.get('etag'));
  let bytes = null;
  const contentType = probe.headers.get('content-type');
  if (probe.status === 206) bytes = parseContentRange(probe.headers.get('content-range'))?.total ?? null;
  else if (probe.status !== 200) {
    await probe.body?.cancel();
    throw new Error(`归档探测失败: 来源返回 ${probe.status}`);
  }
  await probe.body?.cancel();

  const previous = archive.archives()[entry.archiveId];
  const sameContent = Boolean(previous && etag && previous.etag === etag);
  if (sameContent && previous.status === '完成' && previous.complete === complete) {
    if (previous.version !== entry.version) {
      await archive.commitIngestion({archives: {[entry.archiveId]: {version: entry.version}}});
    }
    return {archiveId: entry.archiveId, status: '跳过', reason: '内容未变化'};
  }

  const {hash} = await ensureObject(client, archive, entry.url, etag);
  const startOffset = sameContent ? (previous.consumedOffset || 0) : 0;
  const state = {
    version: entry.version, etag: etag ?? hash, complete, bytes,
    receipt: hash, consumedOffset: startOffset, status: '进行中'
  };
  await archive.commitIngestion({
    archives: {[entry.archiveId]: state},
    exchanges: [{url: entry.url, status: 200, contentType, hash}]
  });

  let records = [];
  let quarantine = [];
  let consumed = startOffset;
  const stats = {messages: 0, quarantined: 0};
  const flush = async final => {
    if (!records.length && !quarantine.length && !final) return;
    const stage = {...state, consumedOffset: consumed};
    if (final) stage.status = '完成';
    await archive.commitIngestion({records, quarantine, archives: {[entry.archiveId]: stage}});
    records = [];
    quarantine = [];
  };

  const stream = createReadStream(archive.objectPath(hash), {start: startOffset});
  for await (const item of parseMbox(stream, {base: startOffset})) {
    // 归档可能还在写入：最后一封（或末尾残片）留到归档完整后再收。
    if (item.tail && !complete) { consumed = item.start; break; }
    consumed = item.end;
    if (item.type === 'junk') {
      quarantine.push(toQuarantine({...item, separator: null, separatorLine: null}, '分隔线之前出现异常内容', entry, hash, false));
      stats.quarantined++;
    } else if (item.oversize) {
      quarantine.push(toQuarantine(item, '消息超过单封处理上限', entry, hash, false));
      stats.quarantined++;
    } else {
      const analysis = analyzeMessage(item);
      if (analysis.ok) {
        records.push(toRecord(item, analysis, entry, hash));
        stats.messages++;
      } else {
        // 异常邮件连同原文留在异常区，后续消息照常采集。
        quarantine.push(toQuarantine(item, analysis.reason, entry, hash, true));
        stats.quarantined++;
      }
    }
    if (records.length + quarantine.length >= BATCH_SIZE) await flush(false);
  }
  await flush(true);
  return {archiveId: entry.archiveId, status: '完成', ...stats, consumedOffset: consumed};
}

export async function ingestArchives(client, archive) {
  const listing = await client('/archives');
  const entries = Array.isArray(listing?.archives) ? listing.archives : null;
  if (!entries) throw new Error('归档清单结构无效');
  const results = [];
  for (const entry of entries) {
    try {
      results.push(await ingestOne(client, archive, entry));
    } catch (error) {
      // 单个归档失败不波及其他归档。
      results.push({archiveId: entry?.archiveId ?? null, status: '失败', error: error.message});
      if (entry && typeof entry.archiveId === 'string' && entry.archiveId) {
        await archive.commitIngestion({archives: {[entry.archiveId]: {status: '失败', error: error.message}}});
      }
    }
  }
  // 清单本身的响应字节作为凭据留存。
  await archive.commitIngestion({exchanges: client.exchanges});
  return {archives: results};
}
