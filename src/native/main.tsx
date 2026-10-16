import ReactDOM from 'react-dom/client';
import NativeApp from './NativeApp';
import '../styles.css';
import '../prototype.css';
import './native.css';

// Set before mounting: unavailable native services must remain empty, never load browser examples.
Object.assign(window, { __OOPS_NATIVE_APP__: true });
ReactDOM.createRoot(document.getElementById('root')!).render(<NativeApp />);
