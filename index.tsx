/*
 * FakeMuteDeafenLab
 * Vencord user plugin: display mute/deafen voice states while restoring local RTC media.
 */

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { findAll, findComponentByCodeLazy } from "@webpack";
import { Button, ContextMenuApi, FluxDispatcher, Forms, Menu, React, UserStore, useStateFromStores, VoiceStateStore } from "@webpack/common";

const logger = new Logger("FakeMuteDeafenLab");
const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

const settings = definePluginSettings({
    showPanelButtons: {
        type: OptionType.BOOLEAN,
        description: "Show quick toggles next to Discord's mute/deafen controls.",
        default: true
    },
    fakeMute: {
        type: OptionType.BOOLEAN,
        description: "Display yourself as muted while keeping local voice input restored.",
        default: false,
        onChange(value: boolean) {
            if (suppressFakeSettingOnChange) return;
            void setFakeMute(value, "settings");
        }
    },
    fakeDeafen: {
        type: OptionType.BOOLEAN,
        description: "Display yourself as deafened while keeping local input/output restored.",
        default: false,
        onChange(value: boolean) {
            if (suppressFakeSettingOnChange) return;
            void setFakeDeafen(value, "settings");
        }
    },
    autoRestoreLocalMedia: {
        type: OptionType.BOOLEAN,
        description: "Periodically re-apply local mic/listen restoration while fake states are enabled.",
        default: true
    },
    restoreDelayMs: {
        type: OptionType.NUMBER,
        description: "Delay before restoring local media after changing the visible voice state.",
        default: 450
    },
    debugLogs: {
        type: OptionType.BOOLEAN,
        description: "Log concise state changes to DevTools.",
        default: true
    }
});

type UnknownRecord = Record<string, any>;

let rtcConnectionClass: any | undefined;
let lastRtcConnectionInstance: any | undefined;
let originalRtcConnect: ((...args: any[]) => any) | undefined;
let originalRtcSetState: ((...args: any[]) => any) | undefined;
let restoreTimer: ReturnType<typeof setInterval> | undefined;
let applyTimer: ReturnType<typeof setTimeout> | undefined;
let restoreBurstTimers: number[] = [];
let remoteRestoreTimer: ReturnType<typeof setTimeout> | undefined;
let ensureGeneration = 0;
let originalFluxDispatch: ((...args: any[]) => any) | undefined;
let pluginDispatchDepth = 0;
let pendingDeafTarget: boolean | undefined;
let pendingDeafUntil = 0;
let ignoreRemoteIntentUntil = 0;
let suppressFakeSettingOnChange = false;
const realVoiceIntent = {
    initialized: false,
    selfMute: false,
    selfDeaf: false
};

function log(event: string, payload: UnknownRecord = {}) {
    if (!settings.store.debugLogs) return;
    console.info("[FakeMuteDeafenLab]", event, payload);
    logger.debug(event, payload);
}

// 讀取目前帳號在 VoiceStateStore 裡的對外語音狀態。
function currentVoiceState() {
    const userId = UserStore.getCurrentUser?.()?.id;
    return userId ? VoiceStateStore.getVoiceStateForUser?.(userId) : undefined;
}

function currentRemoteState() {
    const state = currentVoiceState();
    return {
        selfMute: Boolean(state?.selfMute),
        selfDeaf: Boolean(state?.selfDeaf),
        channelId: state?.channelId,
        sessionIdPresent: Boolean(state?.sessionId)
    };
}

// Discord 內部類名與 module id 經常會變，因此用特徵字串動態尋找 RTCConnection。
function getRtcConnectionClass() {
    if (rtcConnectionClass) return rtcConnectionClass;

    const [mod] = findAll((m: any) => {
        try {
            const candidate = typeof m === "function"
                ? m
                : typeof m?.A === "function"
                    ? m.A
                    : undefined;
            if (!candidate?.prototype) return false;

            const src = Function.prototype.toString.call(candidate);
            return src.includes("RTCConnection._handleConnect")
                && src.includes("_handleDisconnect")
                && src.includes("selectProtocol")
                && typeof candidate.prototype.setState === "function";
        } catch {
            return false;
        }
    });

    rtcConnectionClass = typeof mod === "function" ? mod : mod?.A;
    return rtcConnectionClass;
}

// 掛鉤 connect / setState，只保存最新 RTCConnection 實例，不改變原本流程。
function installRtcTracker() {
    const cls = getRtcConnectionClass();
    const proto = cls?.prototype;
    if (!proto) {
        log("rtc_tracker_failed", { reason: "RTCConnection class not found" });
        return;
    }

    if (!originalRtcConnect && typeof proto.connect === "function") {
        originalRtcConnect = proto.connect;
        proto.connect = function (...args: any[]) {
            lastRtcConnectionInstance = this;
            return originalRtcConnect!.apply(this, args);
        };
    }

    if (!originalRtcSetState && typeof proto.setState === "function") {
        originalRtcSetState = proto.setState;
        proto.setState = function (...args: any[]) {
            lastRtcConnectionInstance = this;
            return originalRtcSetState!.apply(this, args);
        };
    }

    log("rtc_tracker_installed", { hasConnect: Boolean(originalRtcConnect), hasSetState: Boolean(originalRtcSetState) });
}

function uninstallRtcTracker() {
    const cls = getRtcConnectionClass();
    const proto = cls?.prototype;
    if (proto && originalRtcConnect) proto.connect = originalRtcConnect;
    if (proto && originalRtcSetState) proto.setState = originalRtcSetState;
    originalRtcConnect = undefined;
    originalRtcSetState = undefined;
}

function fakeStateActive() {
    return Boolean(settings.store.fakeMute || settings.store.fakeDeafen);
}

function updateFakeMuteSetting(enabled: boolean) {
    if (settings.store.fakeMute === enabled) return;
    suppressFakeSettingOnChange = true;
    try {
        settings.store.fakeMute = enabled;
    } finally {
        suppressFakeSettingOnChange = false;
    }
}

function updateFakeDeafenSetting(enabled: boolean) {
    if (settings.store.fakeDeafen === enabled) return;
    suppressFakeSettingOnChange = true;
    try {
        settings.store.fakeDeafen = enabled;
    } finally {
        suppressFakeSettingOnChange = false;
    }
}

function cancelPendingApplyTimer() {
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = undefined;
}

function cancelPendingRemoteRestore() {
    if (remoteRestoreTimer) clearTimeout(remoteRestoreTimer);
    remoteRestoreTimer = undefined;
}

function cancelPendingFakeWork() {
    cancelPendingApplyTimer();
    cancelPendingRemoteRestore();
    clearRestoreBurst();
    pendingDeafTarget = undefined;
    pendingDeafUntil = 0;
    ensureGeneration++;
}


function captureRealVoiceIntent(reason: string, remote = currentRemoteState()) {
    realVoiceIntent.initialized = true;
    realVoiceIntent.selfDeaf = Boolean(remote.selfDeaf);
    realVoiceIntent.selfMute = Boolean(remote.selfMute || remote.selfDeaf);
    log("real_voice_intent_captured", { reason, realVoiceIntent: { ...realVoiceIntent }, remote });
}

function maybeCaptureRealVoiceIntentFromRemote(reason: string, remote = currentRemoteState()) {
    if (fakeStateActive() || Date.now() < ignoreRemoteIntentUntil) return;
    captureRealVoiceIntent(reason, remote);
}

function ensureRealVoiceIntent(reason: string) {
    if (!realVoiceIntent.initialized) captureRealVoiceIntent(reason);
}

function observeExternalAudioAction(action: any) {
    if (!action?.type) return;

    ensureRealVoiceIntent(`external action ${action.type}`);

    if (action.type === "AUDIO_SET_SELF_MUTE") {
        const nextMute = action.mute ?? action.muted ?? action.selfMute;
        if (nextMute != null) realVoiceIntent.selfMute = Boolean(nextMute);
    } else if (action.type === "AUDIO_TOGGLE_SELF_MUTE") {
        realVoiceIntent.selfMute = !currentRemoteState().selfMute;
    } else if (action.type === "AUDIO_SET_SELF_DEAF") {
        const nextDeaf = action.deaf ?? action.deafened ?? action.selfDeaf;
        if (nextDeaf != null) realVoiceIntent.selfDeaf = Boolean(nextDeaf);
    } else if (action.type === "AUDIO_TOGGLE_SELF_DEAF") {
        realVoiceIntent.selfDeaf = !currentRemoteState().selfDeaf;
    } else {
        return;
    }

    if (realVoiceIntent.selfDeaf) realVoiceIntent.selfMute = true;
    log("real_voice_intent_updated", { type: action.type, action, realVoiceIntent: { ...realVoiceIntent } });
}

function installFluxDispatchObserver() {
    if (originalFluxDispatch) return;

    originalFluxDispatch = FluxDispatcher.dispatch;
    FluxDispatcher.dispatch = function (this: any, ...args: any[]) {
        if (!pluginDispatchDepth) {
            try { observeExternalAudioAction(args[0]); } catch (err) { log("observe_external_audio_action_failed", { error: String(err) }); }
        }

        return originalFluxDispatch!.apply(this, args);
    } as any;

    log("flux_dispatch_observer_installed");
}

function uninstallFluxDispatchObserver() {
    if (!originalFluxDispatch) return;

    try { FluxDispatcher.dispatch = originalFluxDispatch as any; } catch { }
    originalFluxDispatch = undefined;
}

function dispatchPluginAction(action: any) {
    pluginDispatchDepth++;
    ignoreRemoteIntentUntil = Date.now() + 2500;
    try {
        return FluxDispatcher.dispatch(action);
    } finally {
        pluginDispatchDepth--;
    }
}

function getMediaConnection() {
    return lastRtcConnectionInstance?._connection;
}

// DevTools 用的狀態快照，便於 Discord 更新後檢查欄位是否改名。
function inspectMediaConnection() {
    const connection = getMediaConnection();
    if (!connection) return { present: false, remote: currentRemoteState() };

    return {
        present: true,
        constructor: connection.constructor?.name,
        ownKeys: Object.keys(connection).slice(0, 80),
        protoKeys: Object.getOwnPropertyNames(Object.getPrototypeOf(connection) ?? {}).slice(0, 140),
        selfMute: connection.getSelfMute?.(),
        selfDeaf: connection.getSelfDeaf?.(),
        rtcState: lastRtcConnectionInstance?.state,
        rtcConnectionId: lastRtcConnectionInstance?.getRTCConnectionId?.(),
        mediaSessionIdPresent: Boolean(lastRtcConnectionInstance?.getMediaSessionId?.()),
        mediaEngineConnectionId: lastRtcConnectionInstance?._mediaEngineConnectionId,
        remote: currentRemoteState()
    };
}

function callFirstAvailable(connection: any, candidates: string[], value: boolean, invertFor?: string) {
    const attempts: UnknownRecord[] = [];

    for (const name of candidates) {
        if (typeof connection?.[name] !== "function") continue;

        try {
            connection[name](name === invertFor ? !value : value);
            attempts.push({ name, ok: true });
        } catch (err) {
            attempts.push({ name, ok: false, error: String(err) });
        }
    }

    return attempts;
}

// 對本地 RTC media connection 套用實際麥克風/收聽狀態；方法名會因 Discord 更新而不同。
function forceLocalMedia(options: { muted?: boolean; deafened?: boolean; } = {}) {
    const connection = getMediaConnection();
    if (!connection) {
        log("force_local_media_failed", { reason: "RTC media connection unavailable", remote: currentRemoteState() });
        return false;
    }

    const attempts: UnknownRecord = {};

    if (options.muted != null) {
        attempts.mute = callFirstAvailable(connection, [
            "setSelfMute",
            "setMute",
            "setLocalMute",
            "setInputMuted",
            "setMicrophoneMute",
            "setAudioEnabled"
        ], Boolean(options.muted), "setAudioEnabled");
    }

    if (options.deafened != null) {
        attempts.deaf = callFirstAvailable(connection, [
            "setSelfDeaf",
            "setDeaf",
            "setOutputMuted",
            "setAudioOutputMuted",
            "setSpeakerMute"
        ], Boolean(options.deafened));
    }

    log("force_local_media", { options, attempts, after: inspectMediaConnection() });
    return Object.values(attempts).some((list: any) => Array.isArray(list) && list.some(a => a.ok));
}

function fakeRestoreOptions() {
    return {
        muted: settings.store.fakeMute || settings.store.fakeDeafen ? false : undefined,
        deafened: settings.store.fakeDeafen ? false : undefined
    };
}

function clearRestoreBurst() {
    for (const timer of restoreBurstTimers) window.clearTimeout(timer);
    restoreBurstTimers = [];
}

function restoreLocalMediaSoon(reason = "restore") {
    if (!fakeStateActive()) return;

    clearRestoreBurst();
    const delay = Math.max(0, Number(settings.store.restoreDelayMs) || 0);
    const delays = [0, delay, delay + 250, delay + 700, delay + 1300, delay + 2200];

    for (const wait of delays) {
        restoreBurstTimers.push(window.setTimeout(() => {
            forceLocalMedia(fakeRestoreOptions());
        }, wait));
    }

    log("restore_local_media_burst_scheduled", { reason, delays, options: fakeRestoreOptions() });
}

function syncLocalToRealIntentSoon(reason = "sync-real") {
    ensureRealVoiceIntent(reason);
    window.setTimeout(() => {
        if (fakeStateActive()) return;
        forceLocalMedia({
            muted: Boolean(realVoiceIntent.selfMute || realVoiceIntent.selfDeaf),
            deafened: Boolean(realVoiceIntent.selfDeaf)
        });
    }, Math.max(0, Number(settings.store.restoreDelayMs) || 0));
}

function scheduleApplyConfiguredState(reason: string, delay = 300) {
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
        applyTimer = undefined;
        log("scheduled_local_restore", { reason, remote: currentRemoteState(), media: inspectMediaConnection() });
        ensureConfiguredState(reason);
    }, delay);
}

// 透過 Discord 原有 Flux action 更新對外可見的 mute / deafen 狀態。
function dispatchRemoteMute(mute: boolean) {
    dispatchPluginAction({
        type: "AUDIO_SET_SELF_MUTE",
        context: "default",
        mute,
        playSoundEffect: true
    } as any);
}

function dispatchRemoteDeaf(deafened: boolean) {
    pendingDeafTarget = deafened;
    pendingDeafUntil = Date.now() + 1800;

    dispatchPluginAction({
        type: "AUDIO_SET_SELF_DEAF",
        context: "default",
        deaf: deafened,
        deafened,
        syncRemote: true,
        playSoundEffect: true
    } as any);
}

async function setFakeMute(enabled: boolean, source = "ui") {
    const wasFakeActive = fakeStateActive();
    if (enabled && !wasFakeActive) ensureRealVoiceIntent(`enable fake mute:${source}`);

    cancelPendingFakeWork();
    updateFakeMuteSetting(enabled);

    const isFakeActive = fakeStateActive();
    log("set_fake_mute", { enabled, source, wasFakeActive, isFakeActive, realVoiceIntent: { ...realVoiceIntent }, before: inspectMediaConnection() });

    if (isFakeActive) {
        restoreLocalMediaSoon(`setFakeMute:${source}`);
    } else {
        syncLocalToRealIntentSoon(`disable fake mute:${source}`);
    }
}

async function setFakeDeafen(enabled: boolean, source = "ui") {
    const wasFakeActive = fakeStateActive();
    if (enabled && !wasFakeActive) ensureRealVoiceIntent(`enable fake deafen:${source}`);

    cancelPendingFakeWork();
    updateFakeDeafenSetting(enabled);

    const isFakeActive = fakeStateActive();
    log("set_fake_deafen", { enabled, source, wasFakeActive, isFakeActive, realVoiceIntent: { ...realVoiceIntent }, before: inspectMediaConnection() });

    if (isFakeActive) {
        restoreLocalMediaSoon(`setFakeDeafen:${source}`);
    } else {
        syncLocalToRealIntentSoon(`disable fake deafen:${source}`);
    }
}

// Fake Deafen 在 Discord UI 中通常也會帶有 selfMute，所以 desired state 在這裡統一計算。
function desiredRemoteState() {
    ensureRealVoiceIntent("desired remote state");

    return {
        selfDeaf: Boolean(realVoiceIntent.selfDeaf || settings.store.fakeDeafen),
        selfMute: Boolean(realVoiceIntent.selfMute || realVoiceIntent.selfDeaf || settings.store.fakeMute || settings.store.fakeDeafen)
    };
}

function remoteMatchesDesired(remote = currentRemoteState()) {
    const desired = desiredRemoteState();
    return remote.selfDeaf === desired.selfDeaf && remote.selfMute === desired.selfMute;
}

function realRemoteState() {
    ensureRealVoiceIntent("real remote state");
    return {
        selfDeaf: Boolean(realVoiceIntent.selfDeaf),
        selfMute: Boolean(realVoiceIntent.selfMute || realVoiceIntent.selfDeaf)
    };
}

function applyRemoteTargetOnce(target: { selfMute: boolean; selfDeaf: boolean; }, reason: string) {
    const remote = currentRemoteState();
    if (!remote.channelId) return;

    log("apply_remote_target_once", { reason, target, remote });

    if (remote.selfDeaf !== target.selfDeaf) dispatchRemoteDeaf(target.selfDeaf);

    // Changing deaf can implicitly affect mute inside Discord, so set mute once shortly after.
    if (remote.selfMute !== target.selfMute || remote.selfDeaf !== target.selfDeaf) {
        cancelPendingRemoteRestore();
        remoteRestoreTimer = setTimeout(() => {
            remoteRestoreTimer = undefined;
            if (fakeStateActive()) return;

            const nextRemote = currentRemoteState();
            if (nextRemote.channelId && nextRemote.selfMute !== target.selfMute)
                dispatchRemoteMute(target.selfMute);
        }, remote.selfDeaf !== target.selfDeaf ? 450 : 0);
    }
}

function restoreRemoteToRealIntent(reason = "restore-real") {
    if (fakeStateActive()) return;
    applyRemoteTargetOnce(realRemoteState(), reason);
}


// 主要狀態機：先對齊可見狀態，再恢復本地 media；重連或切換頻道時會自動重試。
// Local-only state machine: fake toggles never press Discord's native mute/deafen for you.
// They only keep local RTC input/output restored while you choose the visible Discord state yourself.
function ensureConfiguredState(reason = "ensure", attempt = 0, generation = ++ensureGeneration) {
    const remote = currentRemoteState();
    if (!remote.channelId) {
        log("apply_skipped", { reason: "not in voice", remote });
        return;
    }

    if (!fakeStateActive()) {
        log("apply_skipped", { reason: "fake disabled", trigger: reason, remote, realVoiceIntent: { ...realVoiceIntent } });
        return;
    }

    log("ensure_local_restore_state", { reason, attempt, remote, realVoiceIntent: { ...realVoiceIntent }, media: inspectMediaConnection() });
    restoreLocalMediaSoon(reason);

    if (attempt >= 2 || !fakeStateActive()) return;

    window.setTimeout(() => {
        if (generation !== ensureGeneration || !fakeStateActive()) return;
        restoreLocalMediaSoon(`${reason}:retry-local`);
    }, Math.max(900, Number(settings.store.restoreDelayMs) + 500));
}

function startRestoreTimer() {
    stopRestoreTimer();
    restoreTimer = setInterval(() => {
        if (!settings.store.autoRestoreLocalMedia) return;
        if (!settings.store.fakeMute && !settings.store.fakeDeafen) return;

        forceLocalMedia(fakeRestoreOptions());
    }, 1500);
}

function stopRestoreTimer() {
    if (restoreTimer) clearInterval(restoreTimer);
    restoreTimer = undefined;
    cancelPendingApplyTimer();
    cancelPendingRemoteRestore();
    clearRestoreBurst();
}

function StatusPanel() {
    const [, setTick] = React.useState(0);
    const refresh = () => setTick(t => t + 1);
    const remote = currentRemoteState();
    const media = inspectMediaConnection();

    return <>
        <Forms.FormText>
            Displays your voice state as muted/deafened while restoring the local RTC media connection.
        </Forms.FormText>
        <Forms.FormText>
            Remote: selfMute={String(remote.selfMute)}, selfDeaf={String(remote.selfDeaf)}, channel={remote.channelId ?? "none"}
        </Forms.FormText>
        <Forms.FormText>
            Local media: present={String(media.present)}, selfMute={String((media as any).selfMute)}, selfDeaf={String((media as any).selfDeaf)}, rtc={String((media as any).rtcState)}
        </Forms.FormText>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            <Button onClick={() => { void setFakeMute(!settings.store.fakeMute, "button"); refresh(); }}>
                {settings.store.fakeMute ? "Disable Fake Mute" : "Enable Fake Mute"}
            </Button>
            <Button onClick={() => { void setFakeDeafen(!settings.store.fakeDeafen, "button"); refresh(); }}>
                {settings.store.fakeDeafen ? "Disable Fake Deafen" : "Enable Fake Deafen"}
            </Button>
            <Button onClick={() => { forceLocalMedia({ muted: false, deafened: false }); refresh(); }}>
                Restore local mic/listen
            </Button>
            <Button onClick={refresh} color={Button.Colors.PRIMARY}>Refresh Status</Button>
        </div>
    </>;
}

function FakeMuteIcon() {
    const enabled = settings.use(["fakeMute"]).fakeMute;

    return (
        <svg width="20" height="20" viewBox="0 0 24 24">
            <path
                fill={enabled ? "var(--status-danger)" : "currentColor"}
                d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3Zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7Z"
            />
            {enabled && <path fill="var(--status-danger)" d="M21.18 1.7 22.6 3.12 3.12 22.6 1.7 21.18Z" />}
        </svg>
    );
}

function FakeDeafenIcon() {
    const enabled = settings.use(["fakeDeafen"]).fakeDeafen;

    return (
        <svg width="20" height="20" viewBox="0 0 24 24">
            <path
                fill={enabled ? "var(--status-danger)" : "currentColor"}
                d="M12 3a8 8 0 0 0-8 8v4a3 3 0 0 0 3 3h2v-8H7a5 5 0 0 1 10 0h-2v8h2a3 3 0 0 0 3-3v-4a8 8 0 0 0-8-8Z"
            />
            {enabled && <path fill="var(--status-danger)" d="M21.18 1.7 22.6 3.12 3.12 22.6 1.7 21.18Z" />}
        </svg>
    );
}

function FakeMuteDeafenCombinedIcon() {
    const { fakeDeafen } = settings.use(["fakeDeafen"]);
    return fakeDeafen ? <FakeDeafenIcon /> : <FakeMuteIcon />;
}

function FakeMuteDeafenContextMenu() {
    const { fakeMute, fakeDeafen } = settings.use(["fakeMute", "fakeDeafen"]);

    return <Menu.Menu
        navId="fake-mute-deafen-lab-menu"
        onClose={ContextMenuApi.closeContextMenu}
        aria-label="Fake Mute/Deafen"
    >
        <Menu.MenuCheckboxItem
            id="fake-mute-deafen-lab-mute"
            label="Fake Mute"
            checked={fakeMute}
            action={() => void setFakeMute(!fakeMute, "panel-menu")}
        />
        <Menu.MenuCheckboxItem
            id="fake-mute-deafen-lab-deafen"
            label="Fake Deafen"
            checked={fakeDeafen}
            action={() => void setFakeDeafen(!fakeDeafen, "panel-menu")}
        />
    </Menu.Menu>;
}

// Adaptive account-area entry: one native PanelButton, no fixed pixel offsets.
function FakeMuteDeafenPanelButtons(props: { nameplate?: any; }) {
    const { showPanelButtons, fakeMute, fakeDeafen } = settings.use(["showPanelButtons", "fakeMute", "fakeDeafen"]);
    const remote = useStateFromStores([VoiceStateStore], currentRemoteState);

    if (!showPanelButtons || !remote.channelId) return null;

    const active = fakeMute || fakeDeafen;
    const tooltipText = active
        ? `Fake: ${fakeMute ? "Mute" : ""}${fakeMute && fakeDeafen ? " + " : ""}${fakeDeafen ? "Deafen" : ""}`
        : "Fake Mute/Deafen";

    return <PanelButton
        tooltipText={tooltipText}
        icon={FakeMuteDeafenCombinedIcon}
        role="button"
        aria-checked={active}
        redGlow={active}
        plated={props?.nameplate != null}
        onClick={(event: React.MouseEvent) => {
            ContextMenuApi.openContextMenu(event, () => <FakeMuteDeafenContextMenu />);
        }}
    />;
}

// DevTools helpers for checking state after Discord updates.
function exposeHelpers() {
    const g = globalThis as typeof globalThis & {
        FakeMuteDeafenLabStatus?: () => unknown;
        FakeMuteDeafenLabSetMute?: (enabled: boolean) => Promise<void>;
        FakeMuteDeafenLabSetDeafen?: (enabled: boolean) => Promise<void>;
        FakeMuteDeafenLabRestoreLocal?: () => boolean;
    };

    g.FakeMuteDeafenLabStatus = inspectMediaConnection;
    g.FakeMuteDeafenLabSetMute = (enabled: boolean) => setFakeMute(Boolean(enabled), "console");
    g.FakeMuteDeafenLabSetDeafen = (enabled: boolean) => setFakeDeafen(Boolean(enabled), "console");
    g.FakeMuteDeafenLabRestoreLocal = () => forceLocalMedia({ muted: false, deafened: false });
}

function removeHelpers() {
    const g = globalThis as any;
    delete g.FakeMuteDeafenLabStatus;
    delete g.FakeMuteDeafenLabSetMute;
    delete g.FakeMuteDeafenLabSetDeafen;
    delete g.FakeMuteDeafenLabRestoreLocal;
}

export default definePlugin({
    name: "FakeMuteDeafenLab",
    description: "Display mute/deafen status while keeping local RTC media restored.",
    authors: [{ name: "local", id: 0n }],
    settings,
    patches: [
        {
            // 將快捷按鈕插入 Discord 左下角帳號控制列。
            find: ".DISPLAY_NAME_STYLES_COACHMARK)",
            replacement: {
                match: /children:\[(?=.{0,25}?accountContainerRef)/,
                replace: "children:[$self.FakeMuteDeafenPanelButtons(arguments[0]),"
            }
        }
    ],

    settingsAboutComponent: StatusPanel,

    start() {
        installRtcTracker();
        installFluxDispatchObserver();
        ensureRealVoiceIntent("startup");
        exposeHelpers();
        startRestoreTimer();
        window.setTimeout(() => ensureConfiguredState("startup"), 1500);
    },

    stop() {
        stopRestoreTimer();
        removeHelpers();
        uninstallFluxDispatchObserver();
        uninstallRtcTracker();
    },

    FakeMuteDeafenPanelButtons: ErrorBoundary.wrap(FakeMuteDeafenPanelButtons, { noop: true }),

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: Array<{ userId?: string; channelId?: string | null; selfMute?: boolean; selfDeaf?: boolean; }>; }) {
            const currentUserId = UserStore.getCurrentUser?.()?.id;
            if (!currentUserId) return;
            const ownState = voiceStates?.find(state => state?.userId === currentUserId);
            if (!ownState) return;

            maybeCaptureRealVoiceIntentFromRemote("own VOICE_STATE_UPDATES", {
                selfMute: Boolean(ownState.selfMute),
                selfDeaf: Boolean(ownState.selfDeaf),
                channelId: ownState.channelId,
                sessionIdPresent: true
            });
            scheduleApplyConfiguredState("own VOICE_STATE_UPDATES");
        },

        RTC_CONNECTION_STATE({ state }: { state?: string; }) {
            if (state === "RTC_CONNECTED" || state === "RTC_CONNECTING" || state === "AUTHENTICATING")
                scheduleApplyConfiguredState(`RTC_CONNECTION_STATE ${state}`);
        },

        VOICE_CHANNEL_SELECT() {
            scheduleApplyConfiguredState("VOICE_CHANNEL_SELECT", 1000);
        }
    }
});
