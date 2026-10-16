import { useEffect, useId, useRef, type InputHTMLAttributes, type PropsWithChildren, type Ref, type TextareaHTMLAttributes } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useNativeRuntime, NativeRuntime } from './NativeRuntime';

export { NativeRuntime as MobileRuntime };
export function useKeyboard() {
  const runtime = useNativeRuntime();
  return { visible: runtime.viewport.keyboardVisible, height: 0, fullHeight: runtime.viewport.keyboardHeight, progress: runtime.viewport.keyboardVisible ? 1 : 0, dragOffset: 0, isDragging: false, focusedElement: runtime.focusedElement, show: runtime.show, hide: runtime.hide, setDragOffset: (_offset: number) => {}, setDragging: (_dragging: boolean) => {} };
}
export function useKeyboardInsets() {
  const { viewport } = useNativeRuntime();
  return { keyboardHeight: 0, keyboardFullHeight: viewport.keyboardHeight, keyboardDragging: false, bottomInset: 0, availableHeight: viewport.height, isKeyboardVisible: viewport.keyboardVisible };
}
export function useScreenPortal() { const { screenRef } = useNativeRuntime(); return { screenRef }; }
export function useMobileDevice() {
  const { viewport, insets } = useNativeRuntime();
  const geometry = { device: { width: viewport.width, height: viewport.height }, screen: { width: viewport.width, height: viewport.height, left: 0, top: 0 }, safeArea: { top: insets.top, bottom: insets.bottom }, keyboard: { height: viewport.keyboardHeight } };
  return { deviceId: 'pixel-10' as const, device: { id: 'pixel-10', label: 'Android', platform: 'android' as const, geometry }, setDeviceId: () => {} };
}
export function KeyboardInput({ ref, ...props }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  const keyboard = useKeyboard();
  return <input {...props} ref={ref} onFocus={event => { keyboard.show(event.currentTarget); props.onFocus?.(event); }} />;
}
export function KeyboardTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const keyboard = useKeyboard();
  return <textarea {...props} onFocus={event => { keyboard.show(event.currentTarget); props.onFocus?.(event); }} />;
}
export function MobileTextField({ id, label, placeholder, testId }: { id: string; label: string; placeholder?: string; testId?: string }) {
  return <label className="mobile-field" htmlFor={id}><span className="field-label">{label}</span><KeyboardInput id={id} placeholder={placeholder} data-testid={testId}/></label>;
}

function useDragClickGuard() {
  const drag = useRef({ x: 0, y: 0, moved: false });
  return {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => { drag.current = { x: event.clientX, y: event.clientY, moved: false }; },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => { if (Math.hypot(event.clientX - drag.current.x, event.clientY - drag.current.y) > 9) drag.current.moved = true; },
    onClickCapture: (event: React.MouseEvent<HTMLElement>) => { if (drag.current.moved) { event.preventDefault(); event.stopPropagation(); drag.current.moved = false; } },
  };
}
export function MobileScroll({ className, children }: PropsWithChildren<{ className?: string }>) {
  const { isKeyboardVisible } = useKeyboardInsets();
  const guard = useDragClickGuard();
  return <section className={`mobile-page ${className || ''}`} data-keyboard-visible={String(isKeyboardVisible)}><div className="mobile-scroll" data-testid="mobile-scroll" {...guard}><div className="mobile-scroll-content">{children}</div></div></section>;
}
export type CarouselProps = PropsWithChildren<{ className?: string; contentClassName?: string; ariaLabel?: string; showScrollbar?: boolean; draggingEnabled?: boolean }>;
export function Carousel({ className = '', contentClassName = '', ariaLabel, children }: CarouselProps) {
  const guard = useDragClickGuard();
  return <div className={`mobile-carousel ${className}`} aria-label={ariaLabel} {...guard}><div className={`mobile-carousel-content ${contentClassName}`}>{children}</div></div>;
}
export function BottomSheet({ open, onOpenChange, title, description, snap = 0.72, children }: PropsWithChildren<{ open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; snap?: number }>) {
  const descriptionId = useId();
  const { screenRef, viewport } = useNativeRuntime();
  const keyboard = useKeyboard();
  useEffect(() => { if (open) keyboard.hide(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => { if (!event.defaultPrevented) { event.preventDefault(); onOpenChange(false); } };
    window.addEventListener('oops:native-back', close);
    return () => window.removeEventListener('oops:native-back', close);
  }, [open, onOpenChange]);
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal container={screenRef.current || undefined}><Dialog.Overlay className="sheet-overlay" data-testid="sheet-overlay"/><Dialog.Content className="bottom-sheet" data-testid="bottom-sheet" style={{ maxHeight: Math.max(180, viewport.height * Math.min(1, Math.max(0.35, snap))), bottom: viewport.keyboardVisible ? 0 : 'var(--native-bottom-inset)' }} aria-describedby={description ? descriptionId : undefined} onOpenAutoFocus={event => event.preventDefault()}><button type="button" className="native-sheet-close" aria-label="关闭" onClick={() => onOpenChange(false)}>×</button><div className="sheet-handle-zone" aria-hidden="true"><div className="sheet-handle"/></div><div className="sheet-header"><Dialog.Title className="sheet-title">{title}</Dialog.Title>{description && <Dialog.Description id={descriptionId} className="sheet-description">{description}</Dialog.Description>}</div><div className="sheet-content">{children}</div></Dialog.Content></Dialog.Portal></Dialog.Root>;
}
