export type NativeInsets = { top: number; bottom: number; ime?: number; imeVisible?: boolean };
export type NativeViewport = { width: number; height: number; offsetTop: number; keyboardVisible: boolean; keyboardHeight: number };

export function normalizeNativeInsets(value: unknown): NativeInsets {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const px = (item: unknown) => typeof item === 'number' && Number.isFinite(item) ? Math.max(0, Math.min(1200, item)) : 0;
  return { top: px(raw.top), bottom: px(raw.bottom), ...(typeof raw.ime === 'number' ? { ime: px(raw.ime) } : {}), ...(typeof raw.imeVisible === 'boolean' ? { imeVisible: raw.imeVisible } : {}) };
}

/** The WebView already resizes above its IME. Only report visibility; never inset it twice. */
export function measureNativeViewport(input: { width: number; height: number; visualHeight?: number; visualTop?: number; baselineHeight: number; insets: NativeInsets }): NativeViewport {
  const height = Math.max(1, Math.min(input.height, input.visualHeight || input.height));
  const reduction = Math.max(0, input.baselineHeight - height);
  const keyboardVisible = input.insets.imeVisible ?? (input.insets.ime !== undefined ? input.insets.ime > input.insets.bottom + 80 : reduction > Math.max(100, input.baselineHeight * 0.15));
  return { width: Math.max(1, input.width), height, offsetTop: Math.max(0, input.visualTop || 0), keyboardVisible, keyboardHeight: keyboardVisible ? Math.max(input.insets.ime || 0, reduction) : 0 };
}
