/* Isolated device-pairing presentation model. It never sends native capture commands. */
(() => {
  'use strict';
  const conditions = ['ready', 'permission', 'background', 'disconnected', 'quiet', 'service'];
  const create = () => ({ paired: false, autoListen: false, condition: 'ready', hold: null,
    needsResume: false, status: 'idle', sessionId: null, serial: 0, quietEnabled: false,
    quietStart: '22:00', quietEnd: '08:00' });
  const timeValid = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  const blocked = state => !state.paired || state.condition !== 'ready';
  const start = state => {
    const serial = state.sessionId && ['paused', 'interrupted'].includes(state.status) ? state.serial : state.serial + 1;
    return { ...state, status: 'listening', hold: null, needsResume: false,
      serial, sessionId: state.sessionId && ['paused', 'interrupted'].includes(state.status) ? state.sessionId : 'device-demo-daily-' + serial };
  };
  function reduce(current, event, context = {}) {
    let state = { ...current };
    const external = !!context.activeSessionId;
    if (external && state.status === 'listening') state = { ...state, status: 'interrupted', needsResume: true };
    switch (event.type) {
      case 'pair':
        if (state.paired) return state;
        // Pairing only stores this independent choice; a later power event may start.
        return { ...state, paired: true, autoListen: event.autoListen === true };
      case 'preferences':
        if (!state.paired || !timeValid(event.quietStart) || !timeValid(event.quietEnd) || event.quietStart === event.quietEnd) return state;
        // Changing a preference is not a device start event or a manual resume.
        return { ...state, autoListen: event.autoListen === true, quietEnabled: event.quietEnabled === true,
          quietStart: event.quietStart, quietEnd: event.quietEnd };
      case 'condition':
        if (!conditions.includes(event.condition)) return state;
        if (event.condition !== 'ready') return { ...state, condition: event.condition,
          status: state.status === 'listening' ? 'interrupted' : state.status, needsResume: true };
        return { ...state, condition: 'ready' };
      case 'power':
        if (external || blocked(state) || !state.autoListen || state.hold || state.needsResume || state.status === 'listening') return state;
        return start(state);
      case 'pause':
        return state.status === 'listening' && !external ? { ...state, status: 'paused', hold: 'paused', needsResume: true } : state;
      case 'stop':
        return state.paired && !external ? { ...state, status: 'stopped', hold: 'stopped', sessionId: null, needsResume: true } : state;
      case 'resume':
        return !external && !blocked(state) && state.status !== 'listening' ? start(state) : state;
      case 'reset':
        return create();
      default:
        return state;
    }
  }
  window.OopsDeviceListeningDemo = Object.freeze({ create, reduce, timeValid });
})();
