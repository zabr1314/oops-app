import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { MobileScroll, useKeyboard, useKeyboardInsets, useMobileDevice, useScreenPortal } from './mobile';
import { initialData, OopsContext, useOops, type AppData, type Route } from './store';
import { Icon, Row, Sheet, isTextEntryTarget } from './ui';
import { Assistant, Home, homeTitle, homeTaskAttentionQueue, Notifications, SearchScreen, Voice, Welcome, taskVisible, sessionVisible, notificationVisible } from './features/Home';
import Tasks, { TaskTabBar, TaskPrimaryFooter, taskTitle } from './features/Tasks';
import Sessions, { SessionTabBar, sessionTitle, useSessionRecorder } from './features/Sessions';
import { MemoryScreens, SettingsScreens, memoryTitle, settingsTitle } from './features/MemorySettings';
import { RecordingControls, EndRecordingSheet } from './features/RecordingControls';
import { clearViewState } from './viewState';
import { migrateStoredData } from './stateMigrations';

const roots=['home','sessions','tasks','memory','settings'];
const tabs=[{view:'home',title:'首页',icon:'house'},{view:'sessions',title:'会话',icon:'chat-circle'},{view:'tasks',title:'任务',icon:'check-square'},{view:'memory',title:'记忆',icon:'bookmark-simple'},{view:'settings',title:'我的',icon:'user'}];
function initialRoute():Route{const p=window.location.hash.slice(1).split('/').map(x=>{try{return decodeURIComponent(x)}catch{return x}});return {view:p[0]||'home',id:p[1]||undefined,mode:p[2]||undefined}}
function routeHash(r:Route){return '#'+[r.view,r.id||'',r.mode||''].map(encodeURIComponent).join('/').replace(/\/+$/,'')}
function spaceNames(d:AppData):string[]{try{const rows=JSON.parse(d.settings.retention.spaces||'null');if(Array.isArray(rows))return [...new Set(['我的空间',...rows.map(x=>x.name).filter((x:unknown)=>typeof x==='string')])] as string[]}catch{}return ['我的空间','Oops 产品团队']}
function readData(){try{const d=JSON.parse(localStorage.getItem('oops-front-v2')||'null');if(d?.sessions&&d?.settings&&d?.tasks)return migrateStoredData(d as AppData)}catch{}return initialData()}
type EndRequest = { id: string; resume: boolean };

export default function Prototype() {
  const keyboard = useKeyboard();
  const { screenRef } = useScreenPortal();
  const [data, setData] = useState<AppData>(readData);
  const [route, setRoute] = useState<Route>(initialRoute);
  const [endRequest, setEndRequest] = useState<EndRequest | null>(null);
  const history = useRef<Route[]>([]);
  const scrollPositions = useRef(new Map<string, number>());
  const restorePosition = useRef<number | null>(null);
  const [message, setMessage] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const update = useCallback((change: Partial<AppData> | ((current: AppData) => AppData)) => setData(d => typeof change === 'function' ? change(d) : { ...d, ...change }), []);
  const navigate = (next: Route) => {
    keyboard.hide();
    if (next.view === route.view && next.id === route.id && next.mode === route.mode) return;
    const scroll = screenRef.current?.querySelector<HTMLElement>('.oops-scroll .mobile-scroll');
    scrollPositions.current.set(data.settings.space + routeHash(route), scroll?.scrollTop || 0);
    history.current.push(route);
    if (history.current.length > 64) history.current.shift();
    restorePosition.current = roots.includes(next.view) ? scrollPositions.current.get(data.settings.space + routeHash(next)) || 0 : 0;
    setRoute(next);
    window.history.replaceState(null, '', routeHash(next));
  };
  const back = () => {
    keyboard.hide();
    const scroll = screenRef.current?.querySelector<HTMLElement>('.oops-scroll .mobile-scroll');
    scrollPositions.current.set(data.settings.space + routeHash(route), scroll?.scrollTop || 0);
    const prev = history.current.pop() || { view: 'home' };
    restorePosition.current = scrollPositions.current.get(data.settings.space + routeHash(prev)) || 0;
    setRoute(prev);
    window.history.replaceState(null, '', routeHash(prev));
  };
  const toast = (text: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setMessage(text);
    toastTimer.current = setTimeout(() => setMessage(''), 2800);
  };
  const requestEnd = (id: string) => {
    keyboard.hide();
    if (endRequest) return;
    const session = data.sessions.find(s => s.id === id && !s.archived);
    if (!session || data.activeSessionId !== id || !['进行中', '暂停'].includes(session.status) || !sessionVisible(data, id)) {
      toast('请回到当前记录所在的空间再结束');
      return;
    }
    // Stop incoming demo content before the save-range sheet takes its snapshot.
    update(current => ({ ...current, sessions: current.sessions.map(s => s.id === id ? { ...s, status: '暂停' } : s) }));
    setEndRequest({ id, resume: session.status === '进行中' });
  };
  const reset = () => {
    keyboard.hide();
    setEndRequest(null);
    setData(initialData());
    setRoute({ view: 'home' });
    history.current = [];
    scrollPositions.current.clear();
    restorePosition.current = 0;
    clearViewState();
    window.history.replaceState(null, '', '#home');
  };
  useEffect(() => {
    try { localStorage.setItem('oops-front-v2', JSON.stringify(data)); }
    catch { /* Keep the session usable when the visitor's browser blocks storage. */ }
  }, [data]);
  useLayoutEffect(() => {
    if (restorePosition.current === null) return;
    const scroll = screenRef.current?.querySelector<HTMLElement>('.oops-scroll .mobile-scroll');
    if (scroll) scroll.scrollTop = restorePosition.current;
    restorePosition.current = null;
  }, [route.view, route.id, route.mode, data.settings.space, screenRef]);
  useEffect(() => {
    document.title = 'Oops · 日常陪伴 App';
    const onHash = () => { keyboard.hide(); setRoute(initialRoute()); };
    window.addEventListener('hashchange', onHash);
    return () => { window.removeEventListener('hashchange', onHash); if (toastTimer.current) clearTimeout(toastTimer.current); };
  }, []);
  return <OopsContext.Provider value={{ data, update, route, navigate, back, toast, reset, requestEnd }}>
    <AppShell message={message} endRequest={endRequest} onCloseEnd={() => setEndRequest(null)} />
  </OopsContext.Provider>;
}

function useAppFocusGuard(route: Route) {
  const keyboard = useKeyboard();
  const { screenRef } = useScreenPortal();
  const { device } = useMobileDevice();
  const hide = useRef(keyboard.hide);
  hide.current = keyboard.hide;
  useEffect(() => {
    const screen = screenRef.current;
    if (!screen) return;
    let frame = 0;
    const resetScreenOffset = () => {
      if (screen.scrollTop) screen.scrollTop = 0;
      if (screen.scrollLeft) screen.scrollLeft = 0;
    };
    const resetAfterFocus = () => {
      resetScreenOffset();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resetScreenOffset);
    };
    const onFocus = (event: FocusEvent) => {
      if (!isTextEntryTarget(event.target)) hide.current();
      resetAfterFocus();
    };
    const onBlur = (event: FocusEvent) => {
      if (!isTextEntryTarget(event.relatedTarget)) hide.current();
      resetAfterFocus();
    };
    const onPointerDown = (event: MouseEvent) => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      // Keep a keyboard-attached button under the pointer until its click is
      // delivered. Dismissing on blur first would move the sheet mid-tap.
      if (button && isTextEntryTarget(document.activeElement)) event.preventDefault();
    };
    // Browser focus must not scroll the outer phone surface. MobileScroll and
    // BottomSheet keep their own scroll positions and gesture behavior.
    screen.addEventListener('scroll', resetScreenOffset, { passive: true });
    screen.addEventListener('focusin', onFocus);
    screen.addEventListener('focusout', onBlur);
    screen.addEventListener('pointerdown', onPointerDown, true);
    screen.addEventListener('mousedown', onPointerDown, true);
    resetAfterFocus();
    return () => {
      cancelAnimationFrame(frame);
      screen.removeEventListener('scroll', resetScreenOffset);
      screen.removeEventListener('focusin', onFocus);
      screen.removeEventListener('focusout', onBlur);
      screen.removeEventListener('pointerdown', onPointerDown, true);
      screen.removeEventListener('mousedown', onPointerDown, true);
    };
  }, [screenRef, device.id]);
  useLayoutEffect(() => {
    const screen = screenRef.current;
    if (screen) { screen.scrollTop = 0; screen.scrollLeft = 0; }
  }, [screenRef, route.view, route.id, route.mode, keyboard.visible]);
}

function AppShell({ message, endRequest, onCloseEnd }: { message: string; endRequest: EndRequest | null; onCloseEnd: () => void }) {
  const { data, route, navigate, back, update } = useOops();
  const { bottomInset, isKeyboardVisible } = useKeyboardInsets();
  const { device } = useMobileDevice();
  const [spaceOpen, setSpaceOpen] = useState(false);
  useAppFocusGuard(route);
  useSessionRecorder();
  const active = route.view.startsWith('task') ? 'tasks' : route.view.startsWith('session') ? 'sessions' : route.view.startsWith('memory') ? 'memory' : route.view.startsWith('settings') ? 'settings' : 'home';
  const isRoot = roots.includes(route.view);
  const isHome = route.view === 'home';
  const title = active === 'tasks' ? taskTitle(route) : active === 'sessions' ? sessionTitle(route) : active === 'memory' ? memoryTitle(route) : active === 'settings' ? settingsTitle(route) : homeTitle(route);
  const session = data.sessions.find(s => s.id === data.activeSessionId && !s.archived && sessionVisible(data, s.id) && ['进行中', '暂停'].includes(s.status));
  const hasRecordingControls = !!session && !isKeyboardVisible;
  const hasPrepareFooter = route.view === 'session-create' && !session;
  const hasSessionTabs = ['session-detail', 'session-transcript'].includes(route.view) && !!route.id && sessionVisible(data, route.id);
  const visibleTask = data.tasks.find(t => t.id === route.id && taskVisible(data, t));
  const hasTaskTabs = route.view === 'task-detail' && !!visibleTask;
  const hasTaskPrimary = hasTaskTabs && !isKeyboardVisible;
  const pendingTasks = homeTaskAttentionQueue(data).length;
  const content = active === 'tasks' ? <Tasks /> : active === 'sessions' ? <Sessions /> : active === 'memory' ? <MemoryScreens /> : active === 'settings' ? <SettingsScreens /> : route.view === 'assistant' ? <Assistant /> : route.view === 'voice' ? <Voice /> : route.view === 'search' ? <SearchScreen /> : route.view === 'notifications' ? <Notifications /> : route.view === 'welcome' ? <Welcome /> : <Home />;
  return <div className={`oops-root ${isHome ? 'is-home' : ''} ${hasRecordingControls ? 'has-recording-controls' : ''} ${hasPrepareFooter ? 'has-prepare-footer' : ''} ${hasSessionTabs ? 'has-session-tabs' : ''} ${hasTaskTabs ? 'has-task-tabs' : ''} ${hasTaskPrimary ? 'has-task-primary' : ''}`} data-route={route.view} style={{ '--mobile-status-bar-height': `${device.geometry.safeArea.top}px`, '--mobile-safe-area-height': `${device.platform === 'android' || isKeyboardVisible ? 0 : device.geometry.safeArea.bottom}px` } as CSSProperties}>
    <header className={`app-header ${isHome ? 'home-header' : ''}`}>
      {isHome ? <><img className="wordmark" src="/brand/wordmark.png" alt="Oops" /><div className="header-tools"><button className="space-pill" onClick={() => setSpaceOpen(true)}>{data.settings.space}<Icon name="caret-down" size={13} /></button><button className="icon-button notification-button" aria-label="通知" onClick={() => navigate({ view: 'notifications' })}><Icon name="bell" size={25} />{data.notifications.some(n => !n.read && notificationVisible(data, n.route)) && <i />}</button></div></> : <><button className="icon-button" aria-label={isRoot ? '搜索全部内容' : '返回上一页'} onClick={isRoot ? () => navigate({ view: 'search' }) : back}><Icon name={isRoot ? 'magnifying-glass' : 'caret-left'} size={23} /></button><h1>{title}</h1><button className="icon-button" aria-label={active === 'sessions' ? '新建记录' : active === 'tasks' ? '新建任务' : '回到首页'} onClick={() => navigate({ view: active === 'sessions' ? 'session-mode' : active === 'tasks' ? 'task-edit' : 'home' })}><Icon name={['sessions', 'tasks'].includes(active) ? 'plus' : 'house'} size={22} /></button></>}
    </header>
    {hasSessionTabs && <div className="session-fixed-tabs"><SessionTabBar /></div>}
    {hasTaskTabs && <div className="task-fixed-tabs"><TaskTabBar /></div>}
    <MobileScroll key={`${data.settings.space}:${route.view}:${route.id || ''}`} className="oops-scroll"><main className={`screen-content ${isHome ? 'home-main' : ''}`} aria-label={title}>{content}</main></MobileScroll>
    {!isKeyboardVisible && <nav className="app-nav" aria-label="主导航">{tabs.map(t => <button key={t.view} aria-label={t.title} aria-current={active === t.view ? 'page' : undefined} className={active === t.view ? 'selected' : ''} onClick={() => navigate({ view: t.view })}><Icon name={t.icon} size={25} /><span>{t.title}</span>{t.view === 'tasks' && pendingTasks > 0 && <b>{pendingTasks}</b>}</button>)}</nav>}
    {hasPrepareFooter && <div className="session-prepare-footer" style={{ bottom: bottomInset + (isKeyboardVisible ? 12 : 78) }}><button className="button primary" type="submit" form="oops-session-prepare-form"><Icon name="play" size={20} /><span>{data.sessions.find(s => s.id === route.id)?.status === '已结束' ? '开始后续示例记录' : '开始示例记录'}</span></button></div>}
    {hasTaskTabs && <aside className={`task-fixed-actions ${isKeyboardVisible ? 'keyboard-open' : ''}`} aria-label="任务下一步" style={{ bottom: bottomInset + (hasRecordingControls ? 244 : 78) }}><TaskPrimaryFooter /></aside>}
    <RecordingControls />
    <EndRecordingSheet request={endRequest} onClose={onCloseEnd} />
    {message && <div className="app-toast" style={{ bottom: bottomInset + (isKeyboardVisible ? 20 : hasRecordingControls ? hasTaskPrimary ? 338 : 248 : hasTaskPrimary ? 176 : hasPrepareFooter ? 146 : 88) }} role="status">{message}</div>}
    <Sheet open={spaceOpen} onClose={() => setSpaceOpen(false)} title="选择工作空间">{spaceNames(data).map(space => <Row key={space} title={space} subtitle={space === '我的空间' ? '私人提问、记忆与成长' : '项目共享的会话、资料与行动'} icon={space === '我的空间' ? 'user' : 'users-three'} trailing={data.settings.space === space ? <Icon name="check" /> : undefined} onClick={() => { update(d => ({ ...d, settings: { ...d.settings, space } })); setSpaceOpen(false); }} />)}<Row title="管理工作空间" icon="gear-six" onClick={() => { setSpaceOpen(false); navigate({ view: 'settings-spaces' }); }} /></Sheet>
  </div>;
}
