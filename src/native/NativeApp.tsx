import Prototype from '../Prototype';
import { NativeRuntime } from './NativeRuntime';

export default function NativeApp() {
  return <NativeRuntime><Prototype nativeHost /></NativeRuntime>;
}
