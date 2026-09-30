export const PI_BG_FEATURE_VALUES = Object.freeze(['process']);
export const PI_BG_DEFAULT_FEATURES = PI_BG_FEATURE_VALUES;
export const PI_BG_DOCK_SHORTCUT_VALUES = Object.freeze([
    'shift+down',
    'ctrl+alt+b',
    'off',
]);
export const PI_BG_DEFAULT_DOCK_SHORTCUT = 'shift+down';
const CONFIG_VALUE_EXCERPT_CHARS = 96;
function boundedConfigValue(value) {
    if (value.length <= CONFIG_VALUE_EXCERPT_CHARS)
        return JSON.stringify(value);
    return `${JSON.stringify(value.slice(0, CONFIG_VALUE_EXCERPT_CHARS))}… (${String(value.length)} chars)`;
}
function invalidConfig(variable, reason, value) {
    throw new Error(`pi_bg_config_invalid: ${variable} ${reason}; received ${boundedConfigValue(value)}`);
}
function parseFeatures() {
    return Object.freeze({
        process: true,
    });
}
function parseDockShortcut(rawValue) {
    const raw = rawValue ?? PI_BG_DEFAULT_DOCK_SHORTCUT;
    if (!PI_BG_DOCK_SHORTCUT_VALUES.includes(raw)) {
        invalidConfig('PI_BG_DOCK_SHORTCUT', `accepted values are exactly ${PI_BG_DOCK_SHORTCUT_VALUES.join(',')}`, raw);
    }
    return raw;
}
export function parseBackgroundTasksConfig(env = process.env) {
    const features = parseFeatures();
    const dockShortcut = parseDockShortcut(env['PI_BG_DOCK_SHORTCUT']);
    return Object.freeze({ features, dockShortcut });
}
export function dockShortcutFooterHint(shortcut) {
    if (shortcut === 'shift+down')
        return 'Shift↓';
    if (shortcut === 'ctrl+alt+b')
        return 'CtrlAltB';
    return '/bg-jobs';
}
//# sourceMappingURL=config.js.map