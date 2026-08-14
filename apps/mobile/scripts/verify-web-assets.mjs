import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import process from 'node:process';

function readReachableJavaScript(root, entryAssets) {
  const pending = entryAssets.map((asset) => resolve(root, asset.replace(/^\.\//, '')));
  const visited = new Set();
  const sources = [];

  while (pending.length > 0) {
    const filePath = pending.pop();
    if (!filePath || visited.has(filePath)) continue;
    if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
      throw new Error(`Mobile web JavaScript dependency escapes the bundle root: ${filePath}`);
    }
    // Bundles can contain fallback filenames such as PDF.js's default worker path that are not
    // module dependencies. Vite's emitted chunk names are present and are followed below.
    if (!existsSync(filePath)) continue;

    visited.add(filePath);
    const source = readFileSync(filePath, 'utf8');
    sources.push(source);
    for (const match of source.matchAll(/["'`](\.\.?\/[^"'`?#]+\.m?js)(?:[?#][^"'`]*)?["'`]/g)) {
      const dependency = resolve(dirname(filePath), match[1]);
      if (!visited.has(dependency)) pending.push(dependency);
    }
  }

  return sources.join('\n');
}

const roots = (process.argv.length > 2 ? process.argv.slice(2) : ['web']).map((path) =>
  resolve(process.cwd(), path),
);

for (const root of roots) {
  const indexPath = resolve(root, 'index.html');

  if (!existsSync(indexPath)) {
    throw new Error(`Mobile web entry point is missing: ${indexPath}`);
  }

  const html = readFileSync(indexPath, 'utf8');
  const referencedAssets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((value) => value && !/^(?:[a-z]+:|\/\/|#)/i.test(value));

  const missingAssets = referencedAssets.filter((asset) => {
    const relativePath = asset.replace(/^\.\//, '').split(/[?#]/, 1)[0];
    return relativePath ? !existsSync(resolve(root, relativePath)) : false;
  });

  if (missingAssets.length > 0) {
    throw new Error(`Mobile web assets are missing: ${missingAssets.join(', ')}`);
  }

  if (referencedAssets.some((asset) => asset.startsWith('/'))) {
    throw new Error('Mobile web entry point contains an absolute asset URL');
  }

  const javascript = readReachableJavaScript(
    root,
    referencedAssets.filter((asset) => /\.m?js(?:[?#]|$)/.test(asset)),
  );
  if (!javascript.includes('https://bonifacio.work')) {
    throw new Error('Mobile web bundle does not contain the public API/WebSocket origin');
  }
  if (/rel=["']manifest["']/i.test(html) || javascript.includes('serviceWorker.register')) {
    throw new Error('Mobile web bundle must not register the browser PWA service worker');
  }

  process.stdout.write(
    `Verified ${referencedAssets.length} mobile web asset references in ${indexPath}\n`,
  );
}
