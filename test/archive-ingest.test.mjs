import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startSource} from '../provider/server.mjs';
import {routes} from '../fixtures/source.mjs';
import {createClient} from '../src/source.mjs';
import {openArchive} from '../src/archive.mjs';
import {ingestArchives} from '../src/ingest.mjs';
import {buildThreads} from '../src/thread.mjs';
import {parseMbox, analyzeMessage, bodyText} from '../src/mbox.mjs';
import {startIntake} from '../src/app.mjs';

const mboxA = routes.find(route => route.path === '/mbox/a').body;
const mboxB = routes.find(route => route.path === '/mbox/b').body;

async function environment(run) {
  const directory = await mkdtemp(join(tmpdir(), 'ingest-test-'));
  const source = await startSource();
  try {
    await run({directory, source});
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
}

async function ingest(directory, source) {
  const archive = await openArchive(directory);
  const client = createClient(source.origin);
  const result = await ingestArchives(client, archive);
  return {archive, result};
}

const byMessageId = (records, messageId) => records.filter(record => record.messageId === messageId);

test('流式解析不依赖整块读入，逐字节输入也能识别边界', async () => {
  async function* trickle() {
    for (const byte of Buffer.from(mboxA)) yield Buffer.from([byte]);
  }
  const messages = [];
  for await (const message of parseMbox(trickle())) messages.push(message);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].tail, false);
  assert.equal(messages[1].tail, true);
  assert.equal(messages[1].start, messages[0].end);
  assert.equal(messages[0].separator, 'From author@local Sat Nov 14 08:00:00 2026');
});

test('分隔线之前的异常内容单独登记，不影响后续消息', async () => {
  const text = '来历不明的残片\nFrom a@local Sat Nov 14 08:00:00 2026\nMessage-ID: <x@local>\n\n正文\n';
  const items = [];
  for await (const item of parseMbox([Buffer.from(text)])) items.push(item);
  assert.equal(items[0].type, 'junk');
  assert.equal(items[1].type, 'message');
  assert.equal(analyzeMessage(items[1]).messageId, '<x@local>');
});

test('头部续行保留来源原文，正文转义只去掉一层', () => environment(async ({directory, source}) => {
  const {archive} = await ingest(directory, source);
  const records = archive.records();
  const [m2] = byMessageId(records, '<m2@local>');
  assert.equal(m2.messageIdRaw, '<m2@local>');
  assert.equal(m2.referencesRaw, '<m0@local>\n <m1@local>');
  assert.deepEqual(m2.references, ['<m0@local>', '<m1@local>']);
  assert.ok(m2.bodyText.includes('From 一段被引用的正文'));
  assert.ok(!m2.bodyText.includes('>From 一段被引用的正文'));
  const [m4] = byMessageId(records, '<m4@local>');
  assert.ok(m4.bodyText.includes('>From 双层转义只去一层'));
  assert.ok(!m4.bodyText.includes('>>From'));
}));

test('In-Reply-To 的多个编号按来源顺序保留', () => environment(async ({directory, source}) => {
  const {archive} = await ingest(directory, source);
  const [m5] = byMessageId(archive.records(), '<m5@local>');
  assert.equal(m5.inReplyToRaw, '<m4@local> <m0@local>');
  assert.deepEqual(m5.inReplyTo, ['<m4@local>', '<m0@local>']);
}));

test('回复先于被回复邮件到达也能归位，缺失引用形成待补齐占位而非根邮件', () => environment(async ({directory, source}) => {
  const {archive} = await ingest(directory, source);
  const threads = buildThreads(archive.records());
  const node = id => threads.nodes.find(item => item.messageId === id);
  assert.deepEqual(threads.roots, ['<m1@local>']);
  assert.deepEqual(node('<m1@local>').children, ['<m2@local>']);
  assert.deepEqual(node('<m4@local>').children, ['<m5@local>']);
  assert.equal(node('<m4@local>').parent, '<m0@local>');
  const [pending] = threads.pending;
  assert.equal(pending.messageId, '<m0@local>');
  assert.deepEqual(pending.referencedBy, ['<m2@local>', '<m4@local>', '<m5@local>']);
  assert.deepEqual(pending.children, ['<m4@local>']);
  assert.deepEqual(threads.cycles, []);
}));

test('缺失编号的邮件保留档案内位置身份，主题相同也不归并', () => environment(async ({directory, source}) => {
  const {archive} = await ingest(directory, source);
  const records = archive.records();
  const positional = records.filter(record => record.id.startsWith('pos:b:'));
  assert.equal(positional.length, 1);
  assert.equal(positional[0].subject, '参数讨论');
  assert.equal(positional[0].messageId, null);
  const threads = buildThreads(records);
  assert.equal(threads.unidentified.length, 1);
  assert.equal(threads.unidentified[0].subject, '参数讨论');
  // 同主题的 <m1@local> 节点只汇总声明了该编号的外壳，不吞并位置邮件。
  const m1 = threads.nodes.find(node => node.messageId === '<m1@local>');
  assert.equal(m1.records.length, 2);
  assert.ok(m1.records.every(record => record.id === 'mid:<m1@local>'));
}));

test('相同Message-ID遇到不同正文或不同外壳都保留', () => environment(async ({directory, source}) => {
  const {archive} = await ingest(directory, source);
  const variants = byMessageId(archive.records(), '<m1@local>');
  assert.equal(variants.length, 2);
  const bodies = variants.map(record => record.bodyText);
  assert.ok(bodies.includes('请核对参数\n'));
  assert.ok(bodies.includes('请核对参数\nFrom 另一客户端保留的引用行\n'));
  source.setPhase('conflict');
  const again = await openArchive(directory);
  await ingestArchives(createClient(source.origin), again);
  const after = byMessageId(again.records(), '<m1@local>');
  assert.equal(after.length, 3);
  assert.ok(after.some(record => record.bodyText === '内容与原封不同\n'));
  assert.ok(after.some(record => record.bodyText === '请核对参数\n'));
}));

test('异常邮件留在异常区可单独检查，后面的讨论照常采集', () => environment(async ({directory, source}) => {
  const {archive, result} = await ingest(directory, source);
  const quarantine = archive.quarantine();
  assert.equal(quarantine.length, 1);
  assert.match(quarantine[0].reason, /头部/);
  assert.equal(quarantine[0].archiveId, 'b');
  const raw = await archive.quarantineRaw(quarantine[0].hash);
  assert.ok(raw.toString('utf8').includes('这不是合法头部'));
  // 异常邮件之后的消息仍然入库。
  const later = archive.records().filter(record => record.archiveId === 'b' && record.offset > quarantine[0].offset);
  assert.ok(later.some(record => record.messageId === '<m1@local>'));
  assert.equal(result.archives.find(item => item.archiveId === 'b').status, '完成');
}));

test('归档未写完时最后一封留待补齐，追加后身份保持稳定', () => environment(async ({directory, source}) => {
  source.setPhase('partial');
  const first = await ingest(directory, source);
  assert.equal(byMessageId(first.archive.records(), '<m3@local>').length, 0);
  assert.equal(first.archive.quarantine().length, 0);
  const state = first.archive.archives().a;
  assert.equal(state.complete, false);
  // 采集位置停在未写完邮件的分隔行处，等归档完整后从这里继续。
  const boundary = await first.archive.rawSlice(state.receipt, state.consumedOffset, 17);
  assert.equal(boundary.toString('utf8'), 'From writer@local');
  // 同一版本重复采集不产生新记录。
  const second = await ingest(directory, source);
  assert.equal(second.result.archives.find(item => item.archiveId === 'a').status, '跳过');
  assert.equal(second.archive.records().length, first.archive.records().length);
  // 归档转为完整版本后，已有邮件的身份与内容保持不变，新列出的归档正常入库。
  source.setPhase('normal');
  const third = await ingest(directory, source);
  const before = first.archive.records().map(record => record.id + '@' + record.revision);
  const after = third.archive.records().map(record => record.id + '@' + record.revision);
  assert.ok(before.every(identity => after.includes(identity)));
  const [m1After] = byMessageId(third.archive.records(), '<m1@local>');
  assert.equal(m1After.bodyText, '请核对参数\n');
  assert.ok(byMessageId(third.archive.records(), '<m4@local>').length > 0);
}));

test('重启后身份稳定，重复采集不重复建档', () => environment(async ({directory, source}) => {
  const first = await ingest(directory, source);
  const before = first.archive.records();
  const reopened = await openArchive(directory);
  const again = await ingestArchives(createClient(source.origin), reopened);
  assert.ok(again.archives.every(item => item.status === '跳过'));
  assert.deepEqual(reopened.records(), before);
  assert.deepEqual(reopened.archives(), first.archive.archives());
}));

test('HTTP归档采集与查询形成闭环', () => environment(async ({directory, source}) => {
  const intake = await startIntake({origin: source.origin, directory});
  try {
    const ingestResponse = await fetch(intake.origin + '/ingest', {method: 'POST'});
    assert.equal(ingestResponse.status, 200);
    const outcome = await ingestResponse.json();
    assert.ok(outcome.archives.every(item => item.status === '完成'));
    const threads = await (await fetch(intake.origin + '/threads')).json();
    assert.ok(threads.pending.some(item => item.messageId === '<m0@local>'));
    const quarantine = await (await fetch(intake.origin + '/quarantine')).json();
    assert.equal(quarantine.length, 1);
    const states = await (await fetch(intake.origin + '/archives')).json();
    assert.equal(states.a.status, '完成');
    assert.equal(states.b.status, '完成');
    const records = await (await fetch(intake.origin + '/records')).json();
    const m2 = records.find(record => record.messageId === '<m2@local>');
    const slice = await fetch(`${intake.origin}/raw/${m2.receipt}?offset=${m2.offset}&length=${m2.length}`);
    assert.equal(slice.status, 200);
    assert.ok((await slice.text()).startsWith('From author@local Sat Nov 14 08:00:00 2026'));
  } finally {
    await intake.close();
  }
}));

test('归档原文按ETag摘要留存为凭据', () => environment(async ({directory, source}) => {
  const {archive} = await ingest(directory, source);
  const receipts = archive.exchanges();
  const crypto = await import('node:crypto');
  const hashA = crypto.createHash('sha256').update(Buffer.from(mboxA)).digest('hex');
  const hashB = crypto.createHash('sha256').update(Buffer.from(mboxB)).digest('hex');
  assert.ok(receipts.some(receipt => receipt.hash === hashA));
  assert.ok(receipts.some(receipt => receipt.hash === hashB));
  const slice = await archive.rawSlice(hashB, 0, 5);
  assert.equal(slice.toString('utf8'), 'From ');
}));
