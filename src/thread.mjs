// 会话关系只依据 Message-ID / References / In-Reply-To 构造；
// 主题从不参与归并，缺少被引用邮件时挂到待补齐占位节点而不是提升为根。
// 关系由当前全部记录即时计算，被引用的邮件在后续归档到达时自动补齐进位。

export function buildThreads(records) {
  const byMessageId = new Map();
  const unidentified = [];
  for (const record of records) {
    const messageId = typeof record.messageId === 'string' && record.messageId ? record.messageId : null;
    if (!messageId) {
      unidentified.push({id: record.id, revision: record.revision, subject: record.subject ?? null});
      continue;
    }
    if (!byMessageId.has(messageId)) byMessageId.set(messageId, []);
    byMessageId.get(messageId).push(record);
  }

  const known = new Set(byMessageId.keys());
  const nodes = new Map();
  const pendingReferrers = new Map();

  for (const [messageId, variants] of byMessageId) {
    const references = [];
    const inReplyTo = [];
    for (const variant of variants) {
      for (const ref of variant.references || []) if (!references.includes(ref)) references.push(ref);
      for (const ref of variant.inReplyTo || []) if (!inReplyTo.includes(ref)) inReplyTo.push(ref);
    }
    // 直接父邮件：References 末位；没有 References 时取 In-Reply-To 首个。
    const parent = references.length ? references[references.length - 1] : (inReplyTo[0] ?? null);
    for (const ref of [...references, ...inReplyTo]) {
      if (known.has(ref)) continue;
      if (!pendingReferrers.has(ref)) pendingReferrers.set(ref, new Set());
      pendingReferrers.get(ref).add(messageId);
    }
    nodes.set(messageId, {
      messageId,
      references,
      inReplyTo,
      parent,
      children: [],
      records: variants.map(variant => ({id: variant.id, revision: variant.revision})),
      subjects: [...new Set(variants.map(variant => variant.subject).filter(subject => subject != null))]
    });
  }

  // 被引用但尚未到达的编号：占位节点，等待后续归档补齐。
  const pending = new Map();
  for (const [messageId, referrers] of pendingReferrers) {
    pending.set(messageId, {messageId, pending: true, referencedBy: [...referrers].sort(), children: []});
  }

  const roots = [];
  for (const node of nodes.values()) {
    if (!node.parent) { roots.push(node.messageId); continue; }
    if (known.has(node.parent)) nodes.get(node.parent).children.push(node.messageId);
    else pending.get(node.parent).children.push(node.messageId);
  }

  // 从根与占位节点出发标记可达节点，剩余节点只可能处在引用环中。
  const reachable = new Set();
  const stack = [...roots, ...[...pending.values()].filter(node => node.children.length).map(node => node.messageId)];
  while (stack.length) {
    const id = stack.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    const node = nodes.get(id) || pending.get(id);
    for (const child of node ? node.children : []) stack.push(child);
  }
  const cycles = [];
  const visited = new Set(reachable);
  for (const messageId of nodes.keys()) {
    if (visited.has(messageId)) continue;
    const path = [];
    let current = messageId;
    while (current) {
      if (visited.has(current)) break;
      const index = path.indexOf(current);
      if (index !== -1) { cycles.push(path.slice(index)); break; }
      path.push(current);
      current = nodes.get(current)?.parent ?? null;
    }
    for (const id of path) visited.add(id);
  }

  return {
    roots,
    nodes: [...nodes.values()],
    pending: [...pending.values()],
    unidentified,
    cycles
  };
}
