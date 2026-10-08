// Pi 1.0.1's public barrel also starts loading the CLI and terminal interface.
// Re-export the official implementations through this version-specific adapter.
// Pi's own loader still controls extension module resolution and isolation.
export const piModule = path => import(new URL(path, import.meta.resolve('@earendil-works/pi-coding-agent')));
const [packages, settings, skills, trust, sessions, events] = await Promise.all([
  piModule('core/package-manager.js'), piModule('core/settings-manager.js'),
  piModule('core/skills.js'), piModule('core/trust-manager.js'),
  piModule('core/session-manager.js'), piModule('core/event-bus.js'),
]);
export const {DefaultPackageManager} = packages;
export const {SettingsManager} = settings;
export const {loadSkills} = skills;
export const {ProjectTrustStore} = trust;
export const {SessionManager} = sessions;
export const {createEventBus} = events;
