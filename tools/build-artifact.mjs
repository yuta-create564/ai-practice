// Claude の Artifact(claude.ai の中で開く版)用に、1つのHTMLファイルへまとめる。
// 使い方: node tools/build-artifact.mjs <出力先.html>
// 同期・ホーム画面用の部品(manifest, service worker, Supabase)は入れない。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'sentence-app');
const out = process.argv[2];
if (!out) { console.error('出力先を指定してください'); process.exit(1); }

const read = (f) => readFileSync(join(root, f), 'utf8');
const inline = (f) => {
  const code = read(f);
  if (/<\/script/i.test(code)) throw new Error(f + ' に </script が含まれています');
  return '<script>\n' + code + '\n</script>';
};
let html = read('index.html');
html = html
  .replace(/<!--PWA-HEAD-->[\s\S]*?<!--\/PWA-HEAD-->\n?/, '')
  .replace(/<!--SCRIPTS-->[\s\S]*?<!--\/SCRIPTS-->/, ['<script>window.EIGO_ENV = "artifact";</script>', inline('core.js'), inline('app.js')].join('\n'))
  .replace(/<!doctype html>\s*/i, '')
  .replace(/<\/?html[^>]*>\s*/gi, '')
  .replace(/<\/?head>\s*/gi, '')
  .replace(/<\/?body>\s*/gi, '')
  .replace(/<meta (charset|name="viewport")[^>]*>\s*/gi, '');
writeFileSync(out, html);
console.log('書き出しました: ' + out + ' (' + Math.round(html.length / 1024) + 'KB)');
