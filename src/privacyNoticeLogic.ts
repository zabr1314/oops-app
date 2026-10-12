import type { AppData } from './store';

export const PRIVACY_NOTICE_VERSION = 'prototype-2026-10-12';
const versionKey = 'privacy-notice-version';
const acceptedAtKey = 'privacy-notice-accepted-at';

export function privacyNoticeAccepted(data: AppData): boolean {
  const retention = data.settings.retention;
  return retention[versionKey] === PRIVACY_NOTICE_VERSION &&
    Number.isFinite(Date.parse(retention[acceptedAtKey] || ''));
}

export function privacyNoticeAcceptedAt(data: AppData): string | undefined {
  return privacyNoticeAccepted(data) ? data.settings.retention[acceptedAtKey] : undefined;
}

export function confirmPrivacyNotice(data: AppData, checked: boolean, now = new Date()): AppData {
  if (!checked || !Number.isFinite(now.getTime())) return data;
  return {...data, settings: {...data.settings, retention: {...data.settings.retention,
    [versionKey]: PRIVACY_NOTICE_VERSION, [acceptedAtKey]: now.toISOString()}}};
}

export function saveWelcomeChoices(data: AppData, choices: {name: string; role: string; cloud: boolean; memory: boolean}): AppData {
  if (!privacyNoticeAccepted(data) || !choices.name.trim()) return data;
  return {...data, settings: {...data.settings, name: choices.name.trim(), role: choices.role.trim(),
    toggles: {...data.settings.toggles, cloud: choices.cloud, memory: choices.memory}}};
}
