// A small, safe Markdown reader for agent answers (2026-11-13: answers showed raw "###" and "**", and their line
// breaks were collapsed into one paragraph). It returns plain data — blocks and inline spans — that a component turns
// into React elements; nothing is ever set as HTML, so a model's text cannot inject markup or script.
//
// Blocks:  heading (#, ##, ###…), paragraph, list (- * • or 1. 1)), code (``` fences), rule (--- ***)
// Inline:  **bold**, __bold__, *italic*, _italic_, `code`, [text](http/https link) — anything else stays text

const LINK = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/;

export function parseInline(text) {
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
  let i = 0;
  const s = String(text ?? '');
  while (i < s.length) {
    const rest = s.slice(i);
    let m;
    if (rest.startsWith('`') && (m = rest.match(/^`([^`]+)`/))) { flush(); out.push({ t: 'code', v: m[1] }); i += m[0].length; continue; }
    if ((m = rest.match(/^\*\*([^*][\s\S]*?)\*\*/)) || (m = rest.match(/^__([^_][\s\S]*?)__/))) { flush(); out.push({ t: 'bold', v: parseInline(m[1]) }); i += m[0].length; continue; }
    // italic needs a non-space right after the marker, so "2 * 3 * 4" stays arithmetic
    if ((m = rest.match(/^\*([^\s*][^*]*?)\*(?!\*)/)) || (m = rest.match(/^_([^\s_][^_]*?)_(?![A-Za-z0-9])/))) {
      const before = s[i - 1];
      if (!before || /[\s(["'—-]/.test(before)) { flush(); out.push({ t: 'em', v: parseInline(m[1]) }); i += m[0].length; continue; }
    }
    if (rest.startsWith('[') && (m = rest.match(LINK))) { flush(); out.push({ t: 'link', v: m[1], href: m[2] }); i += m[0].length; continue; }
    buf += s[i]; i++;
  }
  flush();
  return out;
}

export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [], list = null;
  const endPara = () => { if (para.length) { blocks.push({ t: 'p', inline: parseInline(para.join(' ')) }); para = []; } };
  const endList = () => { if (list) { blocks.push(list); list = null; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      endPara(); endList();
      const code = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith('```'); i++) code.push(lines[i]);
      blocks.push({ t: 'code', v: code.join('\n') });
      continue;
    }
    if (!trimmed) { endPara(); endList(); continue; }
    let m;
    if ((m = trimmed.match(/^(#{1,6})\s+(.*)$/))) { endPara(); endList(); blocks.push({ t: 'h', level: Math.min(m[1].length, 4), inline: parseInline(m[2].replace(/\s#+\s*$/, '')) }); continue; }
    if (/^([-*_])\1{2,}$/.test(trimmed.replace(/\s/g, ''))) { endPara(); endList(); blocks.push({ t: 'hr' }); continue; }
    const bullet = trimmed.match(/^[-*•]\s+(.*)$/);
    const number = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
    if (bullet || number) {
      endPara();
      const ordered = !!number;
      if (!list || list.ordered !== ordered) { endList(); list = { t: 'list', ordered, start: ordered ? Number(number[1]) : 1, items: [] }; }
      list.items.push(parseInline(ordered ? number[2] : bullet[1]));
      continue;
    }
    // an indented line right under a list item continues that item
    if (list && /^\s{2,}\S/.test(line)) { const last = list.items[list.items.length - 1]; last.push({ t: 'text', v: ' ' }, ...parseInline(trimmed)); continue; }
    endList();
    para.push(trimmed);
  }
  endPara(); endList();
  return blocks;
}
