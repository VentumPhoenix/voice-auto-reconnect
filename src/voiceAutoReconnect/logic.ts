/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 VentumPhoenix
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Pure, Discord-independent detection state machine.
// This file intentionally has no imports so it can be unit tested in isolation.
// The plugin glue (index.ts) translates Flux events / store reads into LogicEvents
// and executes the returned Actions.

export type Mode = "notify" | "reconnect" | "notifyAndReconnect";

/** Mirrors Discord's RTCConnectionQuality values. */
export type Quality = "unknown" | "bad" | "average" | "fine";

export type Reason = "badQuality" | "stalePing" | "stuckConnecting" | "manual";

export interface LogicConfig {
    mode: Mode;
    /** How long quality must stay "bad" before acting. */
    badDurationSeconds: number;
    /** How long ping updates may be missing while RTC is connected. */
    staleSeconds: number;
    /** How long RTC may stay in a connecting-like state. */
    stuckConnectingSeconds: number;
    /** No detection right after joining a channel. */
    graceSeconds: number;
    /** Minimum time between two automatic reconnects (or two notifications in notify mode). */
    cooldownSeconds: number;
    /** Maximum automatic reconnects per attempt window. */
    maxAttempts: number;
    attemptWindowMinutes: number;
}

export const DEFAULT_CONFIG: Readonly<LogicConfig> = Object.freeze({
    mode: "notifyAndReconnect",
    badDurationSeconds: 5,
    staleSeconds: 8,
    stuckConnectingSeconds: 15,
    graceSeconds: 10,
    cooldownSeconds: 30,
    maxAttempts: 3,
    attemptWindowMinutes: 5,
});

/** Discord's RTCConnectionState value for a fully established media connection. */
export const CONNECTED_STATE = "RTC_CONNECTED";

/**
 * RTCConnectionState values in which the connection is still being (re-)established.
 * Staying in one of these for too long means the connection is stuck.
 * "DISCONNECTED" is deliberately excluded: that is "not in voice", not "stuck".
 */
export const STUCK_STATES: ReadonlySet<string> = new Set([
    "AWAITING_ENDPOINT",
    "AUTHENTICATING",
    "CONNECTING",
    "RTC_DISCONNECTED",
    "RTC_CONNECTING",
    "NO_ROUTE",
    "ICE_CHECKING",
    "DTLS_CONNECTING",
]);

/** Safety net: if the glue never reports reconnectDone, give up waiting after this long. */
export const RECONNECT_TIMEOUT_MS = 30_000;

/**
 * If two ticks are further apart than this, the event loop was stalled (system sleep,
 * debugger, frozen renderer). Timestamps measured across such a gap are meaningless,
 * so we restart the grace period instead of reporting a false "stale ping".
 */
export const STALL_THRESHOLD_MS = 5_000;

export type LogicEvent =
    /** The currently selected voice channel as observed by the glue (null = not in voice). */
    | { type: "channel"; at: number; channelId: string | null; }
    /** Current RTC connection state (RTC_CONNECTION_STATE event or store poll). */
    | { type: "rtcState"; at: number; state: string; }
    /** A ping update arrived (RTC_CONNECTION_PING). */
    | { type: "ping"; at: number; quality?: Quality; }
    /** Current connection quality (store poll or RTC_CONNECTION_LOSS_RATE). */
    | { type: "quality"; at: number; quality: Quality; }
    /** Periodic timer while in voice. */
    | { type: "tick"; at: number; }
    /** The user explicitly asked for a reconnect. */
    | { type: "manualReconnect"; at: number; }
    /** The glue finished executing a reconnect; channelId is the voice channel afterwards. */
    | { type: "reconnectDone"; at: number; channelId: string | null; };

export type ActionType = "none" | "notify" | "reconnect" | "pauseNotify";

export type Action =
    | { type: "notify"; reason: Reason; durationMs: number; channelId: string; }
    | { type: "reconnect"; reason: Reason; durationMs: number; channelId: string; }
    | { type: "pauseNotify"; reason: Reason; durationMs: number; channelId: string; attempts: number; };

export interface LogicState {
    channelId: string | null;
    /** Start of the grace period (join, rejoin or event-loop stall). */
    joinedAt: number;
    rtcState: string | null;
    rtcStateSince: number;
    lastPingAt: number | null;
    quality: Quality;
    badSince: number | null;
    lastTickAt: number | null;
    reconnecting: boolean;
    reconnectStartedAt: number;
    /** The current incident was already acted upon (re-armed once the connection is healthy). */
    incidentHandled: boolean;
    lastNotifyAt: number | null;
    lastReconnectAt: number | null;
    /** Timestamps of automatic reconnects, used for maxAttempts / attemptWindowMinutes. */
    attempts: number[];
    /** pauseNotify was already sent for the current pause. */
    paused: boolean;
}

export interface Detection {
    reason: Exclude<Reason, "manual">;
    since: number;
}

export interface StepResult {
    state: LogicState;
    /** Actions to execute. An empty array means "none". */
    actions: Action[];
    /** The detection that was evaluated for this step, if any (useful for debug logging). */
    detection: Detection | null;
}

export function createInitialState(): LogicState {
    return {
        channelId: null,
        joinedAt: 0,
        rtcState: null,
        rtcStateSince: 0,
        lastPingAt: null,
        quality: "unknown",
        badSince: null,
        lastTickAt: null,
        reconnecting: false,
        reconnectStartedAt: 0,
        incidentHandled: false,
        lastNotifyAt: null,
        lastReconnectAt: null,
        attempts: [],
        paused: false,
    };
}

/** Resets everything that belongs to a single voice connection. */
function freshConnection(s: LogicState, channelId: string | null, at: number): LogicState {
    return {
        ...s,
        channelId,
        joinedAt: at,
        rtcStateSince: at,
        lastPingAt: null,
        quality: "unknown",
        badSince: null,
        incidentHandled: false,
    };
}

function applyQuality(s: LogicState, quality: Quality, at: number): LogicState {
    return {
        ...s,
        quality,
        badSince: quality === "bad" ? s.badSince ?? at : null,
    };
}

/** Pure detection: is the current connection considered dead right now? */
export function detect(s: LogicState, at: number, config: LogicConfig): Detection | null {
    if (s.channelId == null || s.reconnecting) return null;
    if (at - s.joinedAt < config.graceSeconds * 1000) return null;

    if (s.rtcState != null && STUCK_STATES.has(s.rtcState)) {
        if (at - s.rtcStateSince >= config.stuckConnectingSeconds * 1000)
            return { reason: "stuckConnecting", since: s.rtcStateSince };
        return null;
    }

    if (s.rtcState !== CONNECTED_STATE) return null;

    if (s.quality === "bad" && s.badSince != null && at - s.badSince >= config.badDurationSeconds * 1000)
        return { reason: "badQuality", since: s.badSince };

    // Before the first ping of a connection, measure from the moment RTC became connected.
    const pingBaseline = Math.max(s.lastPingAt ?? -Infinity, s.rtcStateSince);
    if (at - pingBaseline >= config.staleSeconds * 1000)
        return { reason: "stalePing", since: pingBaseline };

    return null;
}

function decide(s: LogicState, d: Detection, at: number, config: LogicConfig): { state: LogicState; actions: Action[]; } {
    const channelId = s.channelId!;
    const durationMs = at - d.since;
    const { reason } = d;
    const cooldownMs = config.cooldownSeconds * 1000;

    if (config.mode === "notify") {
        if (s.incidentHandled) return { state: s, actions: [] };
        if (s.lastNotifyAt != null && at - s.lastNotifyAt < cooldownMs) return { state: s, actions: [] };
        return {
            state: { ...s, incidentHandled: true, lastNotifyAt: at },
            actions: [{ type: "notify", reason, durationMs, channelId }],
        };
    }

    const windowMs = config.attemptWindowMinutes * 60_000;
    const attempts = s.attempts.filter(t => at - t < windowMs);
    const maxAttempts = Math.max(1, Math.floor(config.maxAttempts));

    if (attempts.length >= maxAttempts) {
        if (s.paused) return { state: { ...s, attempts }, actions: [] };
        return {
            state: { ...s, attempts, paused: true, incidentHandled: true },
            actions: [{ type: "pauseNotify", reason, durationMs, channelId, attempts: attempts.length }],
        };
    }

    // An attempt slot is free again, so a previous pause is over.
    const base: LogicState = { ...s, attempts, paused: false };

    if (s.lastReconnectAt != null && at - s.lastReconnectAt < cooldownMs) return { state: base, actions: [] };

    const actions: Action[] = [];
    if (config.mode === "notifyAndReconnect") actions.push({ type: "notify", reason, durationMs, channelId });
    actions.push({ type: "reconnect", reason, durationMs, channelId });

    return {
        state: {
            ...base,
            attempts: [...attempts, at],
            lastReconnectAt: at,
            lastNotifyAt: config.mode === "notifyAndReconnect" ? at : s.lastNotifyAt,
            reconnecting: true,
            reconnectStartedAt: at,
            incidentHandled: true,
        },
        actions,
    };
}

/** Applies an event to the state without running detection. */
function reduce(s: LogicState, e: LogicEvent): { state: LogicState; actions: Action[]; } {
    const { at } = e;

    switch (e.type) {
        case "channel": {
            // Channel changes during our own reconnect are expected and handled via reconnectDone.
            if (s.reconnecting || e.channelId === s.channelId) return { state: s, actions: [] };
            // The user joined, left or switched channels by themselves: start over and
            // give automatic reconnects a fresh budget, since the user took control.
            return { state: { ...freshConnection(s, e.channelId, at), attempts: [], paused: false }, actions: [] };
        }

        case "rtcState": {
            if (e.state === s.rtcState) return { state: s, actions: [] };
            let next: LogicState = { ...s, rtcState: e.state, rtcStateSince: at };
            // Discord reports quality "unknown" whenever RTC is not connected.
            if (e.state !== CONNECTED_STATE) next = applyQuality(next, "unknown", at);
            return { state: next, actions: [] };
        }

        case "ping": {
            const next: LogicState = { ...s, lastPingAt: at };
            return { state: e.quality != null ? applyQuality(next, e.quality, at) : next, actions: [] };
        }

        case "quality":
            return { state: applyQuality(s, e.quality, at), actions: [] };

        case "tick": {
            let next: LogicState = { ...s, lastTickAt: at };
            if (s.lastTickAt != null && at - s.lastTickAt > STALL_THRESHOLD_MS) {
                next = { ...next, joinedAt: at, rtcStateSince: at, lastPingAt: null, badSince: next.quality === "bad" ? at : null };
            }
            if (next.reconnecting && at - next.reconnectStartedAt > RECONNECT_TIMEOUT_MS) {
                next = { ...next, reconnecting: false, joinedAt: at };
            }
            return { state: next, actions: [] };
        }

        case "manualReconnect": {
            if (s.channelId == null || s.reconnecting) return { state: s, actions: [] };
            return {
                state: { ...s, reconnecting: true, reconnectStartedAt: at },
                actions: [{ type: "reconnect", reason: "manual", durationMs: 0, channelId: s.channelId }],
            };
        }

        case "reconnectDone":
            return { state: { ...freshConnection(s, e.channelId, at), reconnecting: false }, actions: [] };
    }
}

/**
 * Feeds one event into the state machine.
 * Returns the new state and the actions to execute (empty array = "none").
 */
export function step(state: LogicState, event: LogicEvent, config: LogicConfig): StepResult {
    const reduced = reduce(state, event);
    let { state: s } = reduced;
    const actions = [...reduced.actions];

    const detection = detect(s, event.at, config);
    if (detection == null) {
        // Healthy (or not evaluated): re-arm so the next incident is acted on again.
        if (s.incidentHandled && s.channelId != null && !s.reconnecting) s = { ...s, incidentHandled: false };
        return { state: s, actions, detection: null };
    }

    const decided = decide(s, detection, event.at, config);
    return { state: decided.state, actions: [...actions, ...decided.actions], detection };
}

/** Small stateful convenience wrapper around step() for the plugin glue. */
export function createDetector(initial: LogicState = createInitialState()) {
    let state = initial;
    return {
        handle(event: LogicEvent, config: LogicConfig): StepResult {
            const result = step(state, event, config);
            ({ state } = result);
            return result;
        },
        getState(): Readonly<LogicState> {
            return state;
        },
        reset() {
            state = createInitialState();
        },
    };
}

/** Human readable description of a reason, used for notifications and logs. */
export function describeReason(reason: Reason): string {
    switch (reason) {
        case "badQuality": return "connection quality stayed bad (red bars)";
        case "stalePing": return "no voice ping updates although shown as connected";
        case "stuckConnecting": return "voice connection is stuck while connecting";
        case "manual": return "manual reconnect requested";
    }
}
