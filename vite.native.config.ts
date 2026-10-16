import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.join(root, 'src/mobile');
export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [
    {
      name: 'oops-native-runtime',
      enforce: 'pre',
      resolveId(source, importer) {
        if (importer && source.startsWith('.') && path.resolve(path.dirname(importer.split('?')[0]), source) === mobile) return path.join(root, 'src/native/NativeMobile.tsx');
      },
      transform(code, id) {
        if (id.startsWith(path.join(root, 'src/')) && /\.[tj]sx?(?:\?|$)/.test(id)) {
          // JSX asset strings are not Vite imports. Keep them local to /assets/web/ in the APK.
          return { code: code.replace(/(["'`])\/(brand|icons)\//g, '$1./$2/'), map: null };
        }
      },
      generateBundle(_options, bundle) {
        for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') {
          const simulated = chunk.moduleIds.filter(id => id.startsWith(mobile + path.sep));
          if (simulated.length) this.error('Native build includes simulated mobile runtime: ' + simulated.join(', '));
        }
      },
    },
    react(),
  ],
  build: { target: 'es2022', outDir: 'android/app/build/generated/unifiedWebAssets/web', emptyOutDir: true, rollupOptions: { input: path.join(root, 'native.html') } },
  server: { host: '127.0.0.1' },
});
