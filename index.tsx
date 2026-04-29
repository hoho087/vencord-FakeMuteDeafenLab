/*
 * FakeMuteDeafenLab
 * Vencord user plugin: display mute/deafen voice states while restoring local RTC media.
 */

import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { findAll, findComponentByCodeLazy } from "@webpack";
import { Button, FluxDispatcher, Forms, React, UserStore, useStateFromStores, VoiceStateStore } from "@webpack/common";

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
            void setFakeMute(value, "settings");
        }
    },
    fakeDeafen: {
        type: OptionType.BOOLEAN,
        description: "Display yourself as deafened while keeping local input/output restored.",
        default: false,
        onChange(value: boolean) {
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
let ensureGeneration = 0;

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

function restoreLocalMediaSoon() {
    if (!settings.store.fakeMute && !settings.store.fakeDeafen) return;

    window.setTimeout(() => {
        forceLocalMedia({
            muted: false,
            deafened: settings.store.fakeDeafen ? false : undefined
        });
    }, Math.max(0, Number(settings.store.restoreDelayMs) || 0));
}

function scheduleApplyConfiguredState(reason: string, delay = 300) {
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
        applyTimer = undefined;
        log("scheduled_apply", { reason, remote: currentRemoteState(), media: inspectMediaConnection() });
        ensureConfiguredState(reason);
    }, delay);
}

// 透過 Discord 原有 Flux action 更新對外可見的 mute / deafen 狀態。
function dispatchRemoteMute(mute: boolean) {
    FluxDispatcher.dispatch({
        type: "AUDIO_SET_SELF_MUTE",
        context: "default",
        mute,
        playSoundEffect: true
    } as any);
}

function toggleRemoteDeaf() {
    FluxDispatcher.dispatch({
        type: "AUDIO_TOGGLE_SELF_DEAF",
        context: "default",
        syncRemote: true
    } as any);
}

async function setFakeMute(enabled: boolean, source = "ui") {
    settings.store.fakeMute = enabled;
    log("set_fake_mute", { enabled, source, before: inspectMediaConnection() });
    ensureConfiguredState(`setFakeMute:${source}`);
}

async function setFakeDeafen(enabled: boolean, source = "ui") {
    settings.store.fakeDeafen = enabled;
    log("set_fake_deafen", { enabled, source, before: inspectMediaConnection() });
    ensureConfiguredState(`setFakeDeafen:${source}`);
}

// Fake Deafen 在 Discord UI 中通常也會帶有 selfMute，所以 desired state 在這裡統一計算。
function desiredRemoteState() {
    return {
        selfDeaf: Boolean(settings.store.fakeDeafen),
        selfMute: Boolean(settings.store.fakeMute || settings.store.fakeDeafen)
    };
}

function remoteMatchesDesired(remote = currentRemoteState()) {
    const desired = desiredRemoteState();
    return remote.selfDeaf === desired.selfDeaf && remote.selfMute === desired.selfMute;
}

// 主要狀態機：先對齊可見狀態，再恢復本地 media；重連或切換頻道時會自動重試。
function ensureConfiguredState(reason = "ensure", attempt = 0, generation = ++ensureGeneration) {
    const remote = currentRemoteState();
    if (!remote.channelId) {
        log("apply_skipped", { reason: "not in voice", remote });
        return;
    }

    const desired = desiredRemoteState();

    log("ensure_configured_state", { reason, attempt, desired, remote, media: inspectMediaConnection() });

    if (remote.selfDeaf !== desired.selfDeaf) {
        toggleRemoteDeaf();
        restoreLocalMediaSoon();
    } else if (remote.selfMute !== desired.selfMute) {
        dispatchRemoteMute(desired.selfMute);
        restoreLocalMediaSoon();
    } else if (desired.selfMute || desired.selfDeaf) {
        restoreLocalMediaSoon();
    }

    if (attempt >= 8) return;

    window.setTimeout(() => {
        if (generation !== ensureGeneration) return;

        const nextRemote = currentRemoteState();
        if (!remoteMatchesDesired(nextRemote)) {
            ensureConfiguredState(`${reason}:retry`, attempt + 1, generation);
            return;
        }

        if (desired.selfMute || desired.selfDeaf) restoreLocalMediaSoon();
    }, Math.max(650, Number(settings.store.restoreDelayMs) + 300));
}

function startRestoreTimer() {
    stopRestoreTimer();
    restoreTimer = setInterval(() => {
        if (!settings.store.autoRestoreLocalMedia) return;
        if (!settings.store.fakeMute && !settings.store.fakeDeafen) return;

        forceLocalMedia({
            muted: false,
            deafened: settings.store.fakeDeafen ? false : undefined
        });
    }, 1500);
}

function stopRestoreTimer() {
    if (restoreTimer) clearInterval(restoreTimer);
    restoreTimer = undefined;
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = undefined;
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

// Discord 左下角帳號區的快捷按鈕；只在目前已加入語音時顯示。
function FakeMuteDeafenPanelButtons(props: { nameplate?: any; }) {
    const { showPanelButtons } = settings.use(["showPanelButtons"]);
    const remote = useStateFromStores([VoiceStateStore], currentRemoteState);
    const [tick, setTick] = React.useState(0);
    void tick;

    if (!showPanelButtons || !remote.channelId) return null;

    const refresh = () => setTick(t => t + 1);

    return <>
        <PanelButton
            tooltipText={settings.store.fakeMute ? "Disable Fake Mute" : "Enable Fake Mute"}
            icon={FakeMuteIcon}
            role="switch"
            aria-checked={settings.store.fakeMute}
            redGlow={settings.store.fakeMute}
            plated={props?.nameplate != null}
            onClick={() => {
                void setFakeMute(!settings.store.fakeMute, "panel-button").then(refresh);
            }}
        />
        <PanelButton
            tooltipText={settings.store.fakeDeafen ? "Disable Fake Deafen" : "Enable Fake Deafen"}
            icon={FakeDeafenIcon}
            role="switch"
            aria-checked={settings.store.fakeDeafen}
            redGlow={settings.store.fakeDeafen}
            plated={props?.nameplate != null}
            onClick={() => {
                void setFakeDeafen(!settings.store.fakeDeafen, "panel-button").then(refresh);
            }}
        />
    </>;
}

// 暴露少量 DevTools helper，方便 Discord 更新後快速確認狀態。
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
        exposeHelpers();
        startRestoreTimer();
        window.setTimeout(() => ensureConfiguredState("startup"), 1500);
    },

    stop() {
        stopRestoreTimer();
        removeHelpers();
        uninstallRtcTracker();
    },

    FakeMuteDeafenPanelButtons: ErrorBoundary.wrap(FakeMuteDeafenPanelButtons, { noop: true }),

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: Array<{ userId?: string; channelId?: string | null; selfMute?: boolean; selfDeaf?: boolean; }>; }) {
            const currentUserId = UserStore.getCurrentUser?.()?.id;
            if (!currentUserId) return;
            if (!voiceStates?.some(state => state?.userId === currentUserId)) return;

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
