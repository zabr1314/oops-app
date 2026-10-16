import assert from 'node:assert/strict';
import test from 'node:test';
import { measureNativeViewport, normalizeNativeInsets } from '../src/native/viewport.ts';

test('native inset message accepts CSS pixels and rejects nonfinite or negative values', () => {
  assert.deepEqual(normalizeNativeInsets({ top: 28, bottom: 24, ime: 310, imeVisible: true }), { top: 28, bottom: 24, ime: 310, imeVisible: true });
  assert.deepEqual(normalizeNativeInsets({ top: -2, bottom: Infinity, ime: '310' }), { top: 0, bottom: 0 });
});
test('adjustResize and visual viewport both detect keyboard without subtracting it a second time', () => {
  const base = { width: 393, height: 850, baselineHeight: 850, insets: { top: 24, bottom: 24 } };
  assert.equal(measureNativeViewport(base).keyboardVisible, false);
  const resized = measureNativeViewport({ ...base, height: 520 });
  assert.equal(resized.height, 520);
  assert.equal(resized.keyboardVisible, true);
  assert.equal(resized.keyboardHeight, 330);
  assert.equal(measureNativeViewport({ ...base, visualHeight: 520 }).height, 520);
});
test('native explicit IME state wins over browser address bar or rotation differences', () => {
  const viewport = measureNativeViewport({ width: 393, height: 720, baselineHeight: 850, insets: { top: 24, bottom: 24, imeVisible: false } });
  assert.equal(viewport.keyboardVisible, false);
  assert.equal(viewport.keyboardHeight, 0);
  assert.equal(measureNativeViewport({ width: 393, height: 520, baselineHeight: 850, insets: { top: 24, bottom: 24, imeVisible: true, ime: 320 } }).keyboardHeight, 330);
});
