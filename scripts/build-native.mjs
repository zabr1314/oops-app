#!/usr/bin/env node
import path from 'node:path';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originalAssets = path.join(root, 'android/app/src/main/assets');
const generatedAssets = path.join(root, 'android/app/build/generated/unifiedWebAssets');
const web = path.join(generatedAssets, 'web');
const tools = path.join(generatedAssets, 'native-tools');
await rm(generatedAssets, { recursive: true, force: true });
await mkdir(generatedAssets, { recursive: true });
await cp(originalAssets, generatedAssets, { recursive: true });
await rename(web, tools);
// A packaged native tool must fail closed if the Android bridge is unavailable.
// The browser-only stand-in is copied only to an explicitly requested preview.
const toolsIndex = (await readFile(path.join(tools, 'index.html'), 'utf8'))
  .replace(/\s*<script\s+src=["']bridge-mock\.js["']\s*><\/script>/g, '');
if (/bridge-mock/.test(toolsIndex)) throw new Error('Native tools entry still loads the browser mock');
await writeFile(path.join(tools, 'index.html'), toolsIndex);
await rm(path.join(tools, 'bridge-mock.js'), { force: true });
await build({ configFile: path.join(root, 'vite.native.config.ts') });
await rename(path.join(web, 'native.html'), path.join(web, 'index.html'));
for (const directory of ['brand', 'icons']) await cp(path.join(root, 'public', directory), path.join(web, directory), { recursive: true });
const index = await readFile(path.join(web, 'index.html'), 'utf8');
if (/bridge-mock|PhoneFrame|keyboard-dock/.test(index)) throw new Error('Native entry contains preview-only runtime');
const manifest = { version: 1, runtime: 'shared-react-native', entry: 'web/index.html', tools: 'native-tools/index.html', builtAt: new Date().toISOString() };
await writeFile(path.join(generatedAssets, 'unified-web.json'), JSON.stringify(manifest, null, 2) + '\n');
if (process.argv.includes('--preview')) {
  const preview = path.join(root, 'public/unified-preview');
  await rm(preview, { recursive: true, force: true });
  await cp(generatedAssets, preview, { recursive: true });
  const explicitMock = '<script>if(new URLSearchParams(location.search).get("native-preview")==="1"){document.write(\'<script src="../native-tools/bridge-mock.js"><\\/script>\');}</script>';
  await writeFile(path.join(preview, 'web/index.html'), index.replace('<head>', '<head>' + explicitMock));
  await cp(path.join(originalAssets, 'web/bridge-mock.js'), path.join(preview, 'native-tools/bridge-mock.js'));
  const explicitToolsMock = '<script>if(new URLSearchParams(location.search).get("preview")==="1"){document.write(\'<script src="bridge-mock.js"><\\/script>\');}</script>';
  await writeFile(path.join(preview, 'native-tools/index.html'), toolsIndex.replace('<head>', '<head>' + explicitToolsMock));
  console.log('Isolated native preview: /unified-preview/web/index.html?native-preview=1');
}
console.log('Unified Android assets ready: ' + generatedAssets);
