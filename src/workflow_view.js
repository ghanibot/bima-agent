'use strict';

// ── ANSI color helpers ─────────────────────────────────────────
const C = {
  reset:   s => `\x1b[0m${s}\x1b[0m`,
  bold:    s => `\x1b[1m${s}\x1b[0m`,
  dim:     s => `\x1b[2m${s}\x1b[0m`,
  green:   s => `\x1b[38;5;46m${s}\x1b[0m`,
  blue:    s => `\x1b[38;5;39m${s}\x1b[0m`,
  yellow:  s => `\x1b[38;5;220m${s}\x1b[0m`,
  cyan:    s => `\x1b[38;5;87m${s}\x1b[0m`,
  magenta: s => `\x1b[38;5;213m${s}\x1b[0m`,
  red:     s => `\x1b[38;5;196m${s}\x1b[0m`,
  orange:  s => `\x1b[38;5;214m${s}\x1b[0m`,
  gray:    s => `\x1b[38;5;245m${s}\x1b[0m`,
};

// Node type → color + icon
const NODE_STYLE = {
  'wa.send':        { icon: '📨', color: C.green },
  'wa.send_to':     { icon: '📩', color: C.green },
  'wa.send_media':  { icon: '🖼 ', color: C.green },
  'wa.read_group':  { icon: '📖', color: C.cyan },
  'wa.transcribe':  { icon: '🎙 ', color: C.magenta },
  'wa.vision':      { icon: '👁 ', color: C.magenta },
  'ai.call':        { icon: '🤖', color: C.magenta },
  'http.request':   { icon: '🌐', color: C.blue },
  'shell':          { icon: '💻', color: C.orange },
  'condition':      { icon: '❓', color: C.yellow },
  'loop':           { icon: '🔁', color: C.cyan },
  'repeat':         { icon: '🔂', color: C.cyan },
  'parallel':       { icon: '⚡', color: C.yellow },
  'workflow.run':   { icon: '⛓ ', color: C.magenta },
  'transform':      { icon: '⚙ ', color: C.blue },
  'json.extract':   { icon: '🔍', color: C.blue },
  'delay':          { icon: '⏳', color: C.gray },
  'memory.read':    { icon: '📚', color: C.cyan },
  'memory.write':   { icon: '💾', color: C.cyan },
  'set':            { icon: '📌', color: C.gray },
  'log':            { icon: '📋', color: C.gray },
};

function nodeStyle(type) {
  return NODE_STYLE[type] || { icon: '◆ ', color: C.reset };
}

// Truncate + clean for display
function clip(s, n = 45) {
  if (!s) return '';
  const clean = String(s).replace(/\n/g, '↵').replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean;
}

// One-line config summary per node type
function configSummary(node) {
  const cfg = node.config || {};
  switch (node.type) {
    case 'wa.send':       return cfg.text     ? `"${clip(cfg.text, 40)}"` : '';
    case 'wa.send_to':    return `→ ${cfg.jid?.split('@')[0] || '?'}: "${clip(cfg.text, 30)}"`;
    case 'ai.call':       return cfg.prompt   ? `prompt: "${clip(cfg.prompt, 35)}"` : '';
    case 'http.request':  return `${cfg.method || 'GET'} ${clip(cfg.url, 35)}${cfg.extract ? ` → ${cfg.extract}` : ''}`;
    case 'shell':         return `$ ${clip(cfg.cmd, 40)}`;
    case 'condition':     return cfg.expr     ? clip(cfg.expr, 40) : '';
    case 'loop':          return `items: ${clip(cfg.items,20)} var: ${cfg.itemVar||'item'} body→${cfg.body}`;
    case 'repeat':        return `${cfg.times}x body→${cfg.body}`;
    case 'parallel':      return `branches: [${(cfg.branches||[]).join(', ')}]`;
    case 'workflow.run':  return `→ workflow: ${cfg.workflowId}`;
    case 'transform':     return cfg.expr     ? clip(cfg.expr, 40) : '';
    case 'json.extract':  return cfg.path     ? `path: ${cfg.path}` : '';
    case 'delay':         return `${cfg.seconds || 1}s`;
    case 'memory.read':   return `last ${cfg.turns || 5} turns`;
    case 'memory.write':  return cfg.content  ? `"${clip(cfg.content, 35)}"` : '';
    case 'set':           return `${cfg.key} = ${clip(String(cfg.value||''), 30)}`;
    case 'log':           return cfg.text     ? `"${clip(cfg.text, 40)}"` : '';
    case 'wa.read_group': return `last ${cfg.limit||10} msgs${cfg.jid ? ` from ${cfg.jid.split('@')[0]}` : ''}`;
    case 'wa.transcribe': return `source: ${cfg.source || 'trigger'}`;
    case 'wa.vision':     return `source: ${cfg.source || 'trigger'}${cfg.question ? ` Q:"${clip(cfg.question, 25)}"` : ''}`;
    case 'wa.send_media': return `${cfg.type || '?'} ${clip(cfg.source, 30)}${cfg.caption ? ` cap:"${clip(cfg.caption, 20)}"` : ''}`;
    default: return '';
  }
}

// ── Recursive DAG renderer ────────────────────────────────────
function renderNode(wf, nodeId, indent, isLast, visited, lines, depthLimit = 40) {
  if (!nodeId)          { lines.push(`${indent}${C.gray('◻ (end)')}`); return; }
  if (depthLimit <= 0)  { lines.push(`${indent}${C.gray('… (truncated)')}`); return; }

  if (visited.has(nodeId)) {
    lines.push(`${indent}${C.gray(`↩ ${nodeId} (visited)`)}`);
    return;
  }
  visited.add(nodeId);

  const node = (wf.nodes || []).find(n => n.id === nodeId);
  if (!node) {
    lines.push(`${indent}${C.red(`✗ "${nodeId}" — node tidak ditemukan`)}`);
    return;
  }

  const { icon, color } = nodeStyle(node.type);
  const summary = configSummary(node);

  // Retry + timeout badges
  const badges = [];
  if (node.retry?.times > 0) {
    badges.push(`↻${node.retry.times}${node.retry.backoff === 'exponential' ? '⤴' : ''}`);
  }
  if (typeof node.timeout === 'number') {
    badges.push(`⏱${Math.round(node.timeout / 1000)}s`);
  }
  const badgeStr = badges.length ? ' ' + C.yellow(badges.join(' ')) : '';

  const label = color(`${icon} ${C.bold(node.id)} [${node.type}]`) + badgeStr +
                (summary ? C.gray(`  ${summary}`) : '');

  lines.push(`${indent}${label}`);

  const nextIndent = indent + '│  ';
  const endIndent  = indent + '   ';

  // ── Special rendering per node type ────────────────────────
  if (node.type === 'condition') {
    const trueId  = node.branches?.true  || null;
    const falseId = node.branches?.false || null;

    lines.push(`${indent}│`);
    lines.push(`${indent}├── ${C.green('TRUE')} ──────────────────`);
    if (trueId) {
      renderNode(wf, trueId, indent + '│   ', false, new Set(visited), lines, depthLimit - 1);
    } else {
      lines.push(`${indent}│   ${C.gray('◻ (end)')}`);
    }

    lines.push(`${indent}│`);
    lines.push(`${indent}└── ${C.red('FALSE')} ─────────────────`);
    if (falseId) {
      renderNode(wf, falseId, indent + '    ', true, new Set(visited), lines, depthLimit - 1);
    } else {
      lines.push(`${indent}    ${C.gray('◻ (end)')}`);
    }
    return; // condition has no linear next
  }

  if (node.type === 'parallel') {
    const branches = node.config?.branches || [];
    branches.forEach((brId, i) => {
      const last = i === branches.length - 1;
      lines.push(`${indent}│`);
      lines.push(`${indent}${last ? '└' : '├'}── ${C.cyan(`branch[${i + 1}]`)} → ${C.bold(brId)}`);
      renderNode(wf, brId, indent + (last ? '    ' : '│   '), last, new Set(visited), lines, depthLimit - 1);
    });
    if (node.next) {
      lines.push(`${indent}│`);
      lines.push(`${indent}▼  ${C.gray('(join)')}`);
      lines.push(`${indent}│`);
      renderNode(wf, node.next, indent, isLast, visited, lines, depthLimit - 1);
    } else {
      lines.push(`${indent}${C.gray('◻ (end)')}`);
    }
    return;
  }

  if (node.type === 'loop' || node.type === 'repeat') {
    const bodyId = node.config?.body;
    if (bodyId) {
      lines.push(`${indent}│`);
      lines.push(`${indent}│  ${C.cyan('┌─ body chain ─────────────────')}`);
      renderNode(wf, bodyId, indent + '│  │  ', false, new Set(visited), lines, depthLimit - 1);
      lines.push(`${indent}│  ${C.cyan('└──────────────────────────────')}`);
    }
    if (node.next) {
      lines.push(`${indent}│`);
      renderNode(wf, node.next, indent, isLast, visited, lines, depthLimit - 1);
    } else {
      lines.push(`${indent}${C.gray('◻ (end)')}`);
    }
    return;
  }

  if (node.type === 'workflow.run') {
    lines.push(`${indent}│  ${C.gray(`calls → ${node.config?.workflowId || '?'}`)}`);
    if (node.next) {
      lines.push(`${indent}│`);
      renderNode(wf, node.next, indent, isLast, visited, lines, depthLimit - 1);
    } else {
      lines.push(`${indent}${C.gray('◻ (end)')}`);
    }
    return;
  }

  // Linear: just follow next
  if (node.next) {
    lines.push(`${indent}│`);
    renderNode(wf, node.next, indent, isLast, visited, lines, depthLimit - 1);
  } else {
    lines.push(`${indent}${C.gray('◻ (end)')}`);
  }
}

// ── Build trigger line ─────────────────────────────────────────
function triggerLine(wf) {
  const t = wf.trigger || {};
  switch (t.type) {
    case 'schedule':       return `${C.cyan('⏱')}  schedule  ${C.bold(t.interval || '?')}`;
    case 'wa.message':     return `${C.green('💬')}  wa.message  match: ${C.bold(t.match || '*')}${t.exclusive ? ' (exclusive)' : ''}`;
    case 'file':           return `${C.yellow('📁')}  file  path: ${C.bold(t.path || '?')}  events: ${(t.events||[]).join(',')}`;
    case 'webhook':        return `${C.blue('🔗')}  webhook  id: ${C.bold(t.webhookId || wf.id)}`;
    case 'wa.group_event': return `${C.magenta('👥')}  wa.group_event  actions: ${C.bold((t.actions||['add','remove']).join('/'))}`;
    default:               return `${C.gray('⚡')}  manual`;
  }
}

// ── Main render function ───────────────────────────────────────
function renderWorkflow(wf) {
  const W = 54;
  const lines = [];

  // Header box
  const status = wf.enabled
    ? C.green('● aktif')
    : C.gray('○ nonaktif');
  const nameRow  = `  ${C.bold(wf.name)}`;
  const idRow    = `  ${C.gray('ID:')} ${wf.id}  ${status}`;
  const descRow  = wf.description ? `  ${C.gray(clip(wf.description, W - 4))}` : null;

  lines.push(C.dim('╔' + '═'.repeat(W) + '╗'));
  lines.push(C.dim('║') + nameRow.padEnd(W + 8) + C.dim('║'));
  lines.push(C.dim('║') + idRow.padEnd(W + 18)  + C.dim('║'));
  if (descRow) lines.push(C.dim('║') + descRow.padEnd(W + 8) + C.dim('║'));
  lines.push(C.dim('╚' + '═'.repeat(W) + '╝'));

  // Node count + summary
  const nodeCount = (wf.nodes || []).length;
  lines.push('');
  lines.push(`${C.bold('Nodes:')} ${nodeCount}  ` +
    (wf.nodes||[]).map(n => nodeStyle(n.type).color(`[${n.type}]`)).join(' '));
  lines.push('');

  // Trigger
  lines.push(`${C.bold('◆ TRIGGER:')} ${triggerLine(wf)}`);
  lines.push('│');

  // DAG from entry
  if (wf.entry) {
    renderNode(wf, wf.entry, '', false, new Set(), lines);
  } else {
    lines.push(C.red('✗ entry node tidak diset'));
  }

  // Orphan nodes (not reachable from entry)
  const reachable = new Set();
  function mark(id) {
    if (!id || reachable.has(id)) return;
    reachable.add(id);
    const node = (wf.nodes||[]).find(n => n.id === id);
    if (!node) return;
    mark(node.next);
    if (node.branches) { mark(node.branches.true); mark(node.branches.false); }
    if (node.config?.branches) node.config.branches.forEach(mark);
    if (node.config?.body) mark(node.config.body);
  }
  mark(wf.entry);

  const orphans = (wf.nodes||[]).filter(n => !reachable.has(n.id));
  if (orphans.length) {
    lines.push('');
    lines.push(C.yellow(`⚠ ${orphans.length} node tidak terhubung:`));
    orphans.forEach(n => {
      const { icon, color } = nodeStyle(n.type);
      lines.push(`   ${color(`${icon} ${n.id} [${n.type}]`)}  ${C.gray(configSummary(n))}`);
    });
  }

  lines.push('');
  return lines.join('\n');
}

// ── Live run trace renderer ────────────────────────────────────
// Returns a patched runWorkflow that emits step events to a callback
function renderRunTrace(wf, run) {
  const lines = [];
  const total = run.steps.length;
  const ok    = run.ok;

  lines.push(C.bold(`\nRUN TRACE: ${wf.name}`));
  lines.push(C.dim('─'.repeat(50)));

  run.steps.forEach((step, i) => {
    const { icon, color } = nodeStyle(step.type);
    const statusIcon = step.ok ? C.green('✓') : C.red('✗');
    const ms         = C.gray(`${step.ms}ms`);
    const retryTag   = step.attempts > 1 ? C.yellow(` ↻×${step.attempts}`) : '';
    const out        = step.output
      ? C.gray(`  → ${clip(String(step.output), 50)}`)
      : '';
    lines.push(`  ${statusIcon} ${color(`${icon} ${step.nodeId}`)}${retryTag}  ${ms}${out}`);
    if (step.error) lines.push(`    ${C.red(`! ${step.error}`)}`);
  });

  lines.push(C.dim('─'.repeat(50)));
  lines.push(
    ok
      ? C.green(`✓ Selesai — ${total} node — ${run.durationMs}ms`)
      : C.red(`✗ Gagal — ${run.error || '?'} — ${run.durationMs}ms`)
  );
  lines.push('');

  return lines.join('\n');
}

module.exports = { renderWorkflow, renderRunTrace };
