import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeRuntime } from '../src/native/NativeRuntime';
import { BottomSheet, KeyboardInput, MobileScroll, useKeyboardInsets, useMobileDevice } from '../src/native/NativeMobile';
import '../src/styles.css';
import '../src/prototype.css';
import '../src/native/native.css';

function Fixture() {
  const [open, setOpen] = useState(false);
  const { isKeyboardVisible, bottomInset } = useKeyboardInsets();
  const { device } = useMobileDevice();
  return <><output data-testid="metrics">{JSON.stringify({ keyboard: isKeyboardVisible, bottomInset, top: device.geometry.safeArea.top, bottom: device.geometry.safeArea.bottom })}</output><MobileScroll className="fixture-scroll"><label>姓名<KeyboardInput aria-label="姓名"/></label><button onClick={() => setOpen(true)}>打开面板</button>{Array.from({ length: 60 }, (_, i) => <p key={i}>第{i + 1}条记录</p>)}</MobileScroll><aside className="recording-controls" aria-label="当前记录控制">正在记录</aside><BottomSheet open={open} onOpenChange={setOpen} title="核对内容"><KeyboardInput aria-label="面板文字"/><button onClick={() => setOpen(false)}>保存</button></BottomSheet></>;
}
createRoot(document.getElementById('root')!).render(<NativeRuntime><Fixture/></NativeRuntime>);
