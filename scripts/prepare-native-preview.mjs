import { readdir, readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { resolve, relative, dirname, extname } from 'node:path';
import { createHash } from 'node:crypto';
const root = process.cwd();
const source = resolve(root, 'android/app/src/main/assets/web');
const output = resolve(root, 'public/native-preview');
const allowed = new Set(['.html','.js','.css','.png','.jpg','.svg','.woff','.woff2']);
async function files(dir) {
  const entries = await readdir(dir, {withFileTypes: true});
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(resolve(dir,entry.name)) : [resolve(dir,entry.name)]))).flat().sort();
}
const sourceFiles = (await files(source)).filter(file => allowed.has(extname(file)) && !relative(source,file).split('/').some(part => part.startsWith('.')));
await rm(output, {recursive:true,force:true});
await mkdir(output, {recursive:true});
const manifest=[];
for (const file of sourceFiles) {
  const path=relative(source,file), bytes=await readFile(file), target=resolve(output,path);
  await mkdir(dirname(target),{recursive:true}); await copyFile(file,target);
  manifest.push({path,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
}
await writeFile(resolve(output,'source-manifest.json'),JSON.stringify({source:'android/app/src/main/assets/web',files:manifest},null,2)+'\n');
console.log(`Prepared isolated native preview from ${manifest.length} current Android H5 source files.`);
