import {createHash, randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir, readFile, rename, open, stat} from 'node:fs/promises';
import {join} from 'node:path';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

const HASH_PATTERN = /^[a-f0-9]{64}$/;

// 大对象按流式计算摘要，十几GB的归档不会进入内存。
async function digestFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function replace(path, bytes) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}

export async function openArchive(directory) {
  await mkdir(join(directory, 'objects'), {recursive:true});
  await mkdir(join(directory, 'quarantine'), {recursive:true});
  await mkdir(join(directory, 'spool'), {recursive:true});
  const indexPath = join(directory, 'index.json');
  let index = {version:1, records:[], exchanges:[], archives:{}, quarantine:[]};
  try { index = {...index, ...JSON.parse(await readFile(indexPath, 'utf8'))}; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (index.version !== 1 || !Array.isArray(index.records) || !Array.isArray(index.exchanges)
    || typeof index.archives !== 'object' || index.archives === null || !Array.isArray(index.quarantine)) {
    throw new Error('归档索引结构无效');
  }
  for (const exchange of index.exchanges) {
    if (!HASH_PATTERN.test(exchange.hash)) throw new Error('归档摘要无效');
    if (await digestFile(join(directory, 'objects', exchange.hash)) !== exchange.hash) throw new Error('归档原文校验失败');
  }
  for (const entry of index.quarantine) {
    if (entry.hash === undefined) continue;
    if (!HASH_PATTERN.test(entry.hash)) throw new Error('异常邮件摘要无效');
    if (await digestFile(join(directory, 'quarantine', entry.hash)) !== entry.hash) throw new Error('异常邮件原文校验失败');
  }
  const objectPath = hash => {
    if (!HASH_PATTERN.test(hash)) throw new Error('原文摘要无效');
    return join(directory, 'objects', hash);
  };
  let queue = Promise.resolve();
  // 所有改写索引的操作串行执行，重启后身份保持一致。
  const mutate = operation => {
    const running = queue.then(operation);
    queue = running.catch(() => {});
    return running;
  };
  // 写路径只追加不修改既有条目，浅拷贝容器即可，避免每批提交都深拷贝全量记录。
  const draft = () => ({
    ...index,
    records: [...index.records],
    exchanges: [...index.exchanges],
    archives: {...index.archives},
    quarantine: [...index.quarantine]
  });
  const storeExchanges = async (next, exchanges) => {
    for (const exchange of exchanges) {
      const hash = exchange.hash ?? digest(exchange.bytes);
      if (exchange.bytes !== undefined) await replace(objectPath(hash), exchange.bytes);
      else await stat(objectPath(hash));
      const receiptId = digest(Buffer.from(exchange.url + ':' + exchange.status + ':' + hash));
      if (!next.exchanges.some(existing => existing.receiptId === receiptId)) {
        next.exchanges.push({receiptId, url:exchange.url, status:exchange.status, contentType:exchange.contentType, hash});
      }
    }
  };
  const storeRecords = (next, records) => {
    for (const record of records) {
      if (typeof record.id !== 'string' || !record.id) throw new Error('资料必须有非空标识');
      const revision = digest(Buffer.from(JSON.stringify(record)));
      if (!next.records.some(existing => existing.id === record.id && existing.revision === revision)) {
        next.records.push({...record, revision});
      }
    }
  };
  return {
    records:() => structuredClone(index.records),
    exchanges:() => structuredClone(index.exchanges),
    archives:() => structuredClone(index.archives),
    quarantine:() => structuredClone(index.quarantine),
    objectPath,
    spoolPath(name) {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('暂存文件名无效');
      return join(directory, 'spool', name);
    },
    raw: async hash => {
      const bytes = await readFile(objectPath(hash));
      if (digest(bytes) !== hash) throw new Error('原文校验失败');
      return bytes;
    },
    // 大对象按切片读取，不把整份归档载入内存。
    rawSlice: async (hash, offset = 0, length) => {
      const handle = await open(objectPath(hash));
      try {
        const size = (await handle.stat()).size;
        const start = Math.min(Math.max(0, Number(offset) || 0), size);
        const want = length === undefined || length === null ? size - start : Math.min(Number(length), size - start);
        const buffer = Buffer.alloc(want);
        if (want) await handle.read(buffer, 0, want, start);
        return buffer;
      } finally { await handle.close(); }
    },
    quarantineRaw: async hash => {
      if (!HASH_PATTERN.test(hash)) throw new Error('异常邮件摘要无效');
      return readFile(join(directory, 'quarantine', hash));
    },
    commit(records, exchanges) {
      return mutate(async () => {
        const next = draft();
        await storeExchanges(next, exchanges);
        storeRecords(next, records);
        await replace(indexPath, Buffer.from(JSON.stringify(next, null, 2)));
        index = next;
        return {records:next.records.length, exchanges:next.exchanges.length};
      });
    },
    // 归档采集提交：除资料与凭据外，还推进每个归档的采集位置并登记异常邮件。
    commitIngestion({records = [], exchanges = [], archives = {}, quarantine = []} = {}) {
      return mutate(async () => {
        const next = draft();
        await storeExchanges(next, exchanges);
        storeRecords(next, records);
        for (const [archiveId, state] of Object.entries(archives)) {
          next.archives[archiveId] = {...next.archives[archiveId], ...state};
        }
        for (const entry of quarantine) {
          const stored = {...entry};
          if (entry.bytes !== undefined) {
            stored.hash = digest(entry.bytes);
            await replace(join(directory, 'quarantine', stored.hash), entry.bytes);
          }
          delete stored.bytes;
          const key = digest(Buffer.from([stored.archiveId, stored.offset, stored.reason, stored.receipt, stored.hash].join('|')));
          if (!next.quarantine.some(existing => existing.key === key)) {
            next.quarantine.push({...stored, key});
          }
        }
        await replace(indexPath, Buffer.from(JSON.stringify(next, null, 2)));
        index = next;
        return {records:next.records.length, exchanges:next.exchanges.length, quarantine:next.quarantine.length};
      });
    }
  };
}
