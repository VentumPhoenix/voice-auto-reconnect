/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 VentumPhoenix
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { FluxDispatcher, MediaEngineStore, RTCConnectionStore, SelectedChannelStore } from "@webpack/common";

import { Action, createDetector, describeReason, LogicEvent, Quality, StepResult } from "./logic";
import { getLogicConfig, settings } from "./settings";

// Same lookup as Vencord's userVoiceShow plugin. The module also has disconnect(), which calls selectVoiceChannel(null).
const ChannelActions: {
    selectVoiceChannel(channelId: string | null, video?: boolean): void;
} = findByPropsLazy("selectVoiceChannel", "selectChannel");

const logger = new Logger("VoiceAutoReconnect", "#f0a35e");
const TITLE = "VoiceAutoReconnect";
const TICK_MS = 1000;
const KNOWN_QUALITIES: ReadonlySet<string> = new Set(["unknown", "bad", "average", "fine"]);

const detector = createDetector();
let running = false;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let incompatibleNotified = false;

function debug(...args: unknown[]) {
    // console.debug is hidden by default in DevTools, so use info level.
    if (settings.store.debugLogging) logger.info("[debug]", ...args);
}

function asQuality(value: unknown): Quality {
    return typeof value === "string" && KNOWN_QUALITIES.has(value) ? value as Quality : "unknown";
}

// Self check

function findMissingInternals(): string[] {
    const missing: string[] = [];
    const check = (name: string, ok: () => boolean) => {
        try {
            if (!ok()) missing.push(name);
        } catch {
            missing.push(name);
        }
    };

    check("FluxDispatcher", () => typeof FluxDispatcher?.subscribe === "function");
    check("RTCConnectionStore.getState", () => typeof RTCConnectionStore?.getState === "function");
    check("RTCConnectionStore.getQuality", () => typeof RTCConnectionStore?.getQuality === "function");
    check("SelectedChannelStore.getVoiceChannelId", () => typeof SelectedChannelStore?.getVoiceChannelId === "function");
    check("ChannelActions.selectVoiceChannel", () => typeof ChannelActions.selectVoiceChannel === "function");

    return missing;
}

function reportIncompatible(missing: string[]) {
    logger.error("Incompatible with current Discord version. Missing internals:", missing);
    if (incompatibleNotified) return;
    incompatibleNotified = true;
    showNotification({
        title: TITLE,
        body: "VoiceAutoReconnect: incompatible with current Discord version, please update the plugin. "
            + `Missing: ${missing.join(", ")}`,
        color: "var(--status-danger)",
        permanent: true,
    });
}

// Feeding the state machine

function feed(event: LogicEvent) {
    if (!running) return;
    let result: StepResult;
    try {
        result = detector.handle(event, getLogicConfig());
    } catch (e) {
        logger.error("Detection logic threw", e);
        return;
    }

    if (result.detection && result.actions.length) {
        debug("Detection", result.detection, "->", result.actions.map(a => a.type));
    }
    for (const action of result.actions) execute(action);
    updateTimer();
}

function pollStores() {
    const at = Date.now();
    feed({ type: "channel", at, channelId: SelectedChannelStore.getVoiceChannelId() ?? null });
    feed({ type: "rtcState", at, state: RTCConnectionStore.getState() });
    feed({ type: "quality", at, quality: asQuality(RTCConnectionStore.getQuality()) });
}

function tick() {
    try {
        pollStores();
        feed({ type: "tick", at: Date.now() });
    } catch (e) {
        logger.error("Tick failed", e);
    }
}

// Only tick while in voice (or while our own reconnect is in progress).
function updateTimer() {
    const state = detector.getState();
    const needed = running && (state.channelId != null || state.reconnecting);
    if (needed && tickTimer == null) {
        tickTimer = setInterval(tick, TICK_MS);
    } else if (!needed && tickTimer != null) {
        clearInterval(tickTimer);
        tickTimer = undefined;
    }
}

// Executing actions

function playAlertSound() {
    if (!settings.store.playSound) return;
    try {
        // Synthesised locally: no network request and no dependency on Discord's sound module.
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const t = ctx.currentTime;
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, t);
        osc.frequency.setValueAtTime(587, t + 0.16);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
        osc.connect(gain).connect(ctx.destination);
        osc.onended = () => void ctx.close();
        osc.start(t);
        osc.stop(t + 0.42);
    } catch (e) {
        logger.warn("Could not play alert sound", e);
    }
}

function seconds(ms: number) {
    return `${(ms / 1000).toFixed(1)}s`;
}

function execute(action: Action) {
    const why = `${describeReason(action.reason)} for ${seconds(action.durationMs)}`;

    switch (action.type) {
        case "notify": {
            const autoReconnect = settings.store.mode !== "notify";
            logger.warn(`Dead voice connection detected (${action.reason}): ${why}`);
            showNotification({
                title: TITLE,
                body: autoReconnect
                    ? `Voice connection died (${why}). Reconnecting...`
                    : `Voice connection died (${why}). Leave and rejoin the channel to fix it.`,
                color: "var(--status-warning)",
            });
            playAlertSound();
            break;
        }
        case "pauseNotify":
            logger.warn(`Dead voice connection detected (${action.reason}): ${why}. `
                + `Automatic reconnect paused after ${action.attempts} attempts.`);
            showNotification({
                title: TITLE,
                body: "Automatic reconnect paused, check your connection manually. "
                    + `(${action.attempts} reconnects within ${settings.store.attemptWindowMinutes} min)`,
                color: "var(--status-danger)",
                permanent: true,
            });
            playAlertSound();
            break;
        case "reconnect":
            if (action.reason !== "manual") logger.warn(`Dead voice connection detected (${action.reason}): ${why}`);
            void reconnect(action.channelId, action.reason);
            break;
    }
}

function readSelfState() {
    try {
        return {
            mute: MediaEngineStore.isSelfMute(),
            deaf: MediaEngineStore.isSelfDeaf(),
            video: MediaEngineStore.isVideoEnabled(),
        };
    } catch {
        return null;
    }
}

async function reconnect(channelId: string, reason: string) {
    const before = readSelfState();
    let after: string | null = SelectedChannelStore.getVoiceChannelId() ?? null;

    try {
        logger.info(`Reconnecting to voice channel ${channelId} (reason: ${reason})`, before ?? "");
        ChannelActions.selectVoiceChannel(null);

        await new Promise(r => setTimeout(r, Math.max(0, Number(settings.store.reconnectDelayMs) || 0)));
        if (!running) return;

        const current = SelectedChannelStore.getVoiceChannelId() ?? null;
        if (current != null) {
            // The user joined some channel during the pause; respect that.
            logger.info(`Not rejoining: user is now in voice channel ${current}`);
            after = current;
            return;
        }

        // Self mute/deafen are global client settings and survive leave+rejoin.
        // Camera state is passed explicitly, the same way Discord itself rejoins channels.
        ChannelActions.selectVoiceChannel(channelId, before?.video ?? false);
        after = channelId;
        logger.info(`Rejoined voice channel ${channelId}`);

        const now = readSelfState();
        if (before && now && (before.mute !== now.mute || before.deaf !== now.deaf)) {
            logger.warn("Mute/deafen state changed during reconnect", { before, now });
        }
    } catch (e) {
        logger.error("Reconnect failed", e);
        after = SelectedChannelStore.getVoiceChannelId() ?? null;
    } finally {
        feed({ type: "reconnectDone", at: Date.now(), channelId: after });
    }
}

function manualReconnect() {
    if (!running) return;
    if (SelectedChannelStore.getVoiceChannelId() == null) {
        showNotification({ title: TITLE, body: "You are not in a voice channel." });
        return;
    }
    feed({ type: "manualReconnect", at: Date.now() });
}

export default definePlugin({
    name: "VoiceAutoReconnect",
    description: "Detects when Discord voice silently dies (red connection bars, no audio, still shown as connected) and automatically rejoins the channel or notifies you.",
    authors: [{ name: "VentumPhoenix", id: 0n }],
    tags: ["Voice", "Utility"],
    settings,

    // Shown in the Vencord Toolbox (requires the VencordToolbox plugin). No code patch needed.
    toolboxActions: {
        "Reconnect voice now": manualReconnect,
    },

    flux: {
        // Payload verified against Discord's ChannelActions: { channelId, guildId, currentVoiceChannelId, ... }
        VOICE_CHANNEL_SELECT(e: { channelId?: string | null; }) {
            feed({ type: "channel", at: Date.now(), channelId: e?.channelId ?? null });
        },
        // Dispatched by RTCConnectionStore: { type, state, ...extra }
        RTC_CONNECTION_STATE(e: { state?: string; }) {
            if (typeof e?.state !== "string") return;
            debug("RTC state", e.state);
            feed({ type: "rtcState", at: Date.now(), state: e.state });
        },
        // Dispatched by RTCConnectionStore: { type, pings, quality }
        RTC_CONNECTION_PING(e: { pings?: { time: number; value: number; }[]; quality?: string; }) {
            debug("Ping", e?.pings?.at(-1)?.value, "quality", e?.quality);
            feed({ type: "ping", at: Date.now(), quality: asQuality(e?.quality) });
        },
        // Loss rate feeds into Discord's quality calculation, so re-read the quality.
        RTC_CONNECTION_LOSS_RATE() {
            if (!running) return;
            feed({ type: "quality", at: Date.now(), quality: asQuality(RTCConnectionStore.getQuality()) });
        },
    },

    start() {
        const missing = findMissingInternals();
        if (missing.length) {
            reportIncompatible(missing);
            return;
        }

        const state = RTCConnectionStore.getState();
        if (typeof state !== "string") logger.warn("Unexpected RTCConnectionStore.getState() value:", state);
        if (readSelfState() == null) logger.warn("MediaEngineStore mute/deaf/video getters unavailable; state is not logged");

        detector.reset();
        running = true;
        pollStores();
        logger.info("Started", getLogicConfig());
    },

    stop() {
        running = false;
        updateTimer();
        detector.reset();
    },
});
