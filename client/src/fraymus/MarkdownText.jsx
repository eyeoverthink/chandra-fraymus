import { parseMarkdown } from './markdown.js';

// Renders an agent's answer from parseMarkdown()'s plain data — React elements only, never HTML.
function Inline({ spans }) {
  return spans.map((s, i) => {
    if (s.t === 'bold') return <strong key={i}><Inline spans={s.v} /></strong>;
    if (s.t === 'em') return <em key={i}><Inline spans={s.v} /></em>;
    if (s.t === 'code') return <code key={i}>{s.v}</code>;
    if (s.t === 'link') return <a key={i} href={s.href} target="_blank" rel="noopener noreferrer">{s.v}</a>;
    return <span key={i}>{s.v}</span>;
  });
}

export default function MarkdownText({ text, className = '' }) {
  const blocks = parseMarkdown(text);
  return (
    <div className={`md ${className}`.trim()}>
      {blocks.map((b, i) => {
        if (b.t === 'h') { const H = `h${b.level + 2 > 6 ? 6 : b.level + 2}`; return <H key={i} className="md-h"><Inline spans={b.inline} /></H>; }
        if (b.t === 'list') {
          const items = b.items.map((it, j) => <li key={j}><Inline spans={it} /></li>);
          return b.ordered ? <ol key={i} start={b.start}>{items}</ol> : <ul key={i}>{items}</ul>;
        }
        if (b.t === 'code') return <pre key={i}><code>{b.v}</code></pre>;
        if (b.t === 'hr') return <hr key={i} />;
        return <p key={i}><Inline spans={b.inline} /></p>;
      })}
    </div>
  );
}
