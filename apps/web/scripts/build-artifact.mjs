// Bundle the client into one self-contained HTML fragment for publishing as a
// claude.ai artifact (the host wraps it in <html>/<head>/<body>; only CDN
// scripts are allowed, so all JS/CSS is inlined).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;
const assets = join(dist, 'assets');
const files = readdirSync(assets);
const css = files.filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(assets, f), 'utf8')).join('\n');
const js = files.filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(assets, f), 'utf8')).join('\n')
  .replace(/<\/script/gi, '<\\/script');

const html = `<title>Squadron Tactics</title>
<style>
:root { color-scheme: dark; }
${css}
</style>
<div id="viewport"></div>
<header id="hud"><span id="round"></span><span id="phase"></span></header>
<aside id="panel"></aside>
<section id="log"></section>
<script type="module">
${js}
</script>
`;
const out = join(dist, 'artifact.html');
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
