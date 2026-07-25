'use strict';
// build-site.js - render the repo's markdown into a self-contained static site.
//
//   node tools/build-site.js [outDir]     (default: ./site)
//
// Deliberately dependency-free: no npm install, no generator to keep current.
// The site is built FROM README.md and SECURITY.md so no section is ever
// maintained in two places.
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(repo, 'site'));

// --- a small, correct-enough markdown subset for these documents ------------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, (_, c) => '<code>' + c + '</code>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, a, u) => '<img alt="' + a + '" src="' + u + '">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => '<a href="' + rewriteLink(u) + '">' + t + '</a>')
    // Bold first, with a non-greedy body that MAY contain single asterisks --
    // otherwise `**bold with *italic* inside**` never matches and the italic
    // rule consumes the inner pair, leaving literal ** on the page.
    .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(>])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
}

// Repo-relative links must point at the built pages, not the .md files.
function rewriteLink(u) {
  if (/^https?:|^#|^mailto:/.test(u)) return u;
  const m = u.match(/^([A-Za-z0-9._-]+)\.md$/);
  if (m) return m[1].toLowerCase() === 'readme' ? './' : m[1].toLowerCase() + '.html';
  return u;
}

const slug = (s) => s.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

function render(md) {
  const lines = md.split(/\r?\n/);
  const html = [];
  const toc = [];
  let i = 0;
  let inList = false;
  const closeList = () => { if (inList) { html.push('</ul>'); inList = false; } };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code, incl. mermaid -> rendered client-side
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const lang = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      closeList();
      if (lang === 'mermaid') html.push('<pre class="mermaid">' + esc(body.join('\n')) + '</pre>');
      else html.push('<pre><code class="lang-' + lang + '">' + esc(body.join('\n')) + '</code></pre>');
      continue;
    }

    // GitHub alert blocks -> callouts
    const alert = line.match(/^>\s*\[!(\w+)\]/);
    if (alert) {
      const kind = alert[1].toLowerCase();
      const body = [];
      i++;
      while (i < lines.length && /^>/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      closeList();
      html.push('<div class="callout ' + kind + '"><strong>' + alert[1] + '</strong>' +
                '<p>' + inline(body.join(' ').trim()) + '</p></div>');
      continue;
    }

    // tables
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|/.test(lines[i + 1])) {
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
      closeList();
      html.push('<table><thead><tr>' + head.map((h) => '<th>' + inline(h) + '</th>').join('') +
                '</tr></thead><tbody>' +
                rows.map((r) => '<tr>' + r.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') +
                '</tbody></table>');
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      const id = slug(h[2]);
      if (level === 2) toc.push({ id, text: h[2] });
      html.push('<h' + level + ' id="' + id + '">' + inline(h[2]) +
                ' <a class="anchor" href="#' + id + '">#</a></h' + level + '>');
      i++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { html.push('<ul>'); inList = true; }
      html.push('<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>');
      i++;
      continue;
    }

    if (/^---+$/.test(line)) { closeList(); html.push('<hr>'); i++; continue; }

    if (!line.trim()) { closeList(); i++; continue; }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\||>\s*\[!|\s*[-*]\s|---+$)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    closeList();
    html.push('<p>' + inline(para.join(' ')) + '</p>');
  }
  closeList();
  return { body: html.join('\n'), toc };
}

const shell = ({ title, body, toc, nav, active }) => `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="Detached, reboot-surviving interactive AI agent sessions on Windows.">
<style>
:root{--bg:#0d1117;--fg:#e6edf3;--mut:#8b949e;--line:#30363d;--card:#161b22;--acc:#58a6ff;--warn:#d29922;--err:#f85149}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
.wrap{display:grid;grid-template-columns:240px minmax(0,1fr);gap:48px;max-width:1180px;margin:0 auto;padding:0 24px}
aside{position:sticky;top:0;align-self:start;height:100vh;overflow-y:auto;padding:32px 0;border-right:1px solid var(--line)}
aside h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin:24px 0 8px}
aside a{display:block;padding:4px 0;color:var(--fg);font-size:14px}
aside a.on{color:var(--acc);font-weight:600}
aside .toc a{color:var(--mut);font-size:13px;padding-left:10px;border-left:2px solid transparent}
aside .toc a:hover{border-left-color:var(--acc);color:var(--fg)}
main{padding:32px 0 96px;min-width:0}
h1{font-size:34px;margin:.2em 0 .6em;letter-spacing:-.02em}
h2{font-size:24px;margin:1.8em 0 .6em;padding-bottom:.3em;border-bottom:1px solid var(--line)}
h3{font-size:18px;margin:1.5em 0 .5em}
code{background:#1f2428;padding:.15em .4em;border-radius:5px;font-size:.88em;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;overflow-x:auto}
pre code{background:none;padding:0;font-size:13.5px;line-height:1.55}
table{border-collapse:collapse;width:100%;margin:1.2em 0;font-size:14.5px;display:block;overflow-x:auto}
th,td{border:1px solid var(--line);padding:8px 12px;text-align:left;vertical-align:top}
th{background:var(--card);font-weight:600}
tr:nth-child(even) td{background:rgba(255,255,255,.02)}
.callout{border-left:3px solid var(--acc);background:var(--card);padding:12px 16px;margin:1.2em 0;border-radius:0 8px 8px 0}
.callout p{margin:.4em 0 0}
.callout strong{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--acc)}
.callout.warning{border-left-color:var(--err)}.callout.warning strong{color:var(--err)}
.callout.important{border-left-color:var(--warn)}.callout.important strong{color:var(--warn)}
.anchor{opacity:0;color:var(--mut);font-weight:400}h2:hover .anchor,h3:hover .anchor{opacity:1}
hr{border:0;border-top:1px solid var(--line);margin:2em 0}
.brand{font-size:20px;font-weight:700;letter-spacing:-.01em}
.brand span{color:var(--acc)}
.ghost{color:var(--mut);font-size:13px;margin-top:4px}
.mermaid{text-align:center}
footer{border-top:1px solid var(--line);color:var(--mut);font-size:13px;padding:20px 0;margin-top:48px}
@media(max-width:860px){.wrap{grid-template-columns:1fr;gap:0}aside{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line)}}
</style>
</head><body>
<div class="wrap">
<aside>
  <div class="brand">omp<span>job</span></div>
  <div class="ghost">detached interactive agents</div>
  <h2>Pages</h2>
  ${nav}
  <h2>On this page</h2>
  <div class="toc">${toc.map((t) => '<a href="#' + t.id + '">' + esc(t.text) + '</a>').join('')}</div>
  <h2>Links</h2>
  <a href="https://github.com/AdityaIndoori/ompjob">GitHub repo &rarr;</a>
</aside>
<main>
${body}
<footer>MIT licensed. Built from the repository's own markdown &mdash; if this page is wrong, the README is too.</footer>
</main>
</div>
<script type="module">
  import m from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
  m.initialize({startOnLoad:true,theme:'dark',themeVariables:{background:'#0d1117',primaryColor:'#161b22',primaryTextColor:'#e6edf3',lineColor:'#8b949e'}});
</script>
</body></html>
`;

const pages = [
  { src: 'README.md',   file: 'index.html',    title: 'ompjob - detached, reboot-surviving interactive AI agent sessions', label: 'Overview' },
  { src: 'SECURITY.md', file: 'security.html', title: 'Security - ompjob', label: 'Security' },
];

fs.mkdirSync(out, { recursive: true });

const nav = pages.map((p) => p.file).map((f, i) =>
  '<a href="' + (f === 'index.html' ? './' : f) + '" data-f="' + f + '">' + pages[i].label + '</a>');

for (const p of pages) {
  const md = fs.readFileSync(path.join(repo, p.src), 'utf8');
  const { body, toc } = render(md);
  const navHtml = nav.map((a) => a.includes('data-f="' + p.file + '"')
    ? a.replace('<a ', '<a class="on" ') : a).join('');
  fs.writeFileSync(path.join(out, p.file), shell({ title: p.title, body, toc, nav: navHtml }));
  console.log('wrote ' + path.join(out, p.file));
}

// Custom 404 so a wrong path never falls through to the tunnel's catch-all.
fs.writeFileSync(path.join(out, '404.html'), shell({
  title: '404 - ompjob',
  body: '<h1>404</h1><p>No such page. Try the <a href="./">overview</a>.</p>',
  toc: [], nav: nav.join(''),
}));
console.log('wrote ' + path.join(out, '404.html'));
