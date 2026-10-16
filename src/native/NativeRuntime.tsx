import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type PropsWithChildren, type RefObject } from 'react';
import { measureNativeViewport, normalizeNativeInsets, type NativeInsets, type NativeViewport } from './viewport';

type NativeRuntimeValue = {
  screenRef: RefObject<HTMLDivElement | null>;
  viewport: NativeViewport;
  insets: NativeInsets;
  focusedElement: HTMLElement | null;
  show: (element?: HTMLElement | null) => void;
  hide: () => void;
};
const RuntimeContext = createContext<NativeRuntimeValue | null>(null);

export function useNativeRuntime() {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error('Native mobile components require NativeRuntime');
  return runtime;
}

export function NativeRuntime({ children }: PropsWithChildren) {
  const screenRef = useRef<HTMLDivElement>(null);
  const [insets, setInsets] = useState<NativeInsets>({ top: 0, bottom: 0 });
  const [focusedElement, setFocusedElement] = useState<HTMLElement | null>(null);
  const baseline = useRef({ width: window.innerWidth, height: window.innerHeight });
  const [viewport, setViewport] = useState<NativeViewport>(() => measureNativeViewport({ width: window.innerWidth, height: window.innerHeight, baselineHeight: window.innerHeight, insets }));
  const hide = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setFocusedElement(null);
  }, []);
  const show = useCallback((element?: HTMLElement | null) => setFocusedElement(element || null), []);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      const vv = window.visualViewport;
      // A rotation starts a new baseline; a keyboard resize must retain the old one.
      if (Math.abs(window.innerWidth - baseline.current.width) > 80) baseline.current = { width: window.innerWidth, height: window.innerHeight };
      else baseline.current.height = Math.max(baseline.current.height, window.innerHeight, vv?.height || 0);
      setViewport(measureNativeViewport({ width: vv?.width || window.innerWidth, height: window.innerHeight, visualHeight: vv?.height, visualTop: vv?.offsetTop, baselineHeight: baseline.current.height, insets }));
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const focus = (event: FocusEvent) => { if (event.target instanceof HTMLElement) setFocusedElement(event.target); schedule(); };
    measure();
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('scroll', schedule);
    document.addEventListener('focusin', focus);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('scroll', schedule); document.removeEventListener('focusin', focus); };
  }, [insets]);
  useEffect(() => {
    const onMessage = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const raw = detail?.type === 'snapshot' ? detail.payload?.insets : detail?.type === 'insets' ? detail.payload : null;
      if (raw) setInsets(normalizeNativeInsets(raw));
    };
    window.addEventListener('oops:native-message', onMessage);
    return () => window.removeEventListener('oops:native-message', onMessage);
  }, []);
  const value = useMemo(() => ({ screenRef, viewport, insets, focusedElement, hide, show }), [viewport, insets, focusedElement, hide, show]);
  const style = { height: `${viewport.height}px`, top: `${viewport.offsetTop}px`, '--native-bottom-inset': `${viewport.keyboardVisible ? 0 : insets.bottom}px`, '--native-top-inset': `${insets.top}px` } as CSSProperties;
  return <RuntimeContext.Provider value={value}><div className="native-device-screen" ref={screenRef} style={style} data-platform="android" data-native-runtime="true" data-keyboard-visible={String(viewport.keyboardVisible)}><div className="native-app-viewport">{children}</div></div></RuntimeContext.Provider>;
}
