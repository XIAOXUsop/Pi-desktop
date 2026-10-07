import { marked } from './marked.js';
import { copyButton } from './message-actions.js';

function element(tag, text) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; }
export function renderMarkdown(target, text, copy = () => {}, openLink = () => {}) {
  const safeText = String(text); target.replaceChildren();
  // Avoid expensive Markdown parsing for large replies without dropping any content.
  if (safeText.length > 256 * 1024) {
    const full = element('div', safeText); full.className = 'long-output';
    full.style.whiteSpace = 'pre-wrap'; full.style.overflowWrap = 'anywhere';
    full.title = '长回复使用纯文本显示，内容完整保留'; target.append(full); return;
  }
  function inline(parent, tokens, depth = 0) {
    if (depth > 30) return;
    for (const token of tokens ?? []) {
      if (['strong', 'em', 'del'].includes(token.type)) { const node = element(token.type === 'strong' ? 'strong' : token.type); inline(node, token.tokens, depth + 1); parent.append(node); }
      else if (token.type === 'codespan') parent.append(element('code', token.text));
      else if (token.type === 'br') parent.append(element('br'));
      else if (token.type === 'link') {
        let url; try { const parsed = new URL(token.href); if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) url = parsed.href; } catch { /* Render relative or unsafe links as text. */ }
        const node = element(url ? 'a' : 'span'); node.className = 'md-link'; node.title = token.href;
        if (url) { node.href = url; node.onclick = event => { event.preventDefault(); openLink(url); }; }
        inline(node, token.tokens, depth + 1); parent.append(node);
      }
      else if (token.type === 'image') parent.append(document.createTextNode(`[图片：${token.text || '未命名'}]`));
      else if (token.tokens) inline(parent, token.tokens, depth + 1);
      else parent.append(document.createTextNode(token.text ?? token.raw ?? ''));
    }
  }
  function blocks(parent, tokens, depth = 0) {
    if (depth > 30) return;
    for (const token of tokens) {
      let node;
      if (token.type === 'space') continue;
      if (token.type === 'code') {
        node = element('div'); node.className = 'code-block'; const header = element('div'); header.className = 'code-heading';
        header.append(element('span', token.lang || '代码')); header.append(copyButton(() => token.text,copy,{label:'复制代码',compact:false}));
        const pre = element('pre'); pre.append(element('code', token.text)); node.append(header, pre);
      } else if (token.type === 'heading') { node = element(`h${Math.min(token.depth, 6)}`); inline(node, token.tokens); }
      else if (token.type === 'paragraph' || token.type === 'text') { node = element('p'); inline(node, token.tokens ?? [{ type: 'text', text: token.text }]); }
      else if (token.type === 'blockquote') { node = element('blockquote'); blocks(node, token.tokens, depth + 1); }
      else if (token.type === 'list') { node = element(token.ordered ? 'ol' : 'ul'); if (token.ordered && token.start !== 1) node.start = token.start;
        for (const item of token.items) { const li = element('li'); if (item.task) li.append(element('span', item.checked ? '☑ ' : '☐ ')); blocks(li, item.tokens, depth + 1); node.append(li); }
      } else if (token.type === 'table') { node = element('div'); node.className = 'table-scroll'; const table = element('table'); const header = element('tr');
        for (const cell of token.header) { const th = element('th'); inline(th, cell.tokens); header.append(th); } const head = element('thead'); head.append(header); table.append(head);
        const body = element('tbody'); for (const row of token.rows) { const tr = element('tr'); for (const cell of row) { const td = element('td'); inline(td, cell.tokens); tr.append(td); } body.append(tr); } table.append(body); node.append(table);
      } else if (token.type === 'hr') node = element('hr');
      else node = element('p', token.text ?? token.raw ?? '');
      parent.append(node);
    }
  }
  try { blocks(target, marked.lexer(safeText, { gfm: true })); } catch { target.textContent = safeText; }
}
