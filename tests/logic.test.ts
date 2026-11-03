/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 VentumPhoenix
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";

import {
    Action,
    createDetector,
    createInitialState,
    DEFAULT_CONFIG,
    describeReason,
    detect,
    LogicConfig,
    LogicEvent,
    Mode,
    RECONNECT_TIMEOUT_MS,
    STALL_THRESHOLD_MS,
    step,
    STUCK_STATES,
} from "../src/voiceAutoReconnect/logic";

const CH = "111";
const OTHER = "222";
const S = 1000;

/**
 * Small simulator: drives the state machine with explicit timestamps the same way the
 * plugin glue does (events + a 1s tick), and records every emitted action.
 */
function sim(overrides: Partial<LogicConfig> = {}) {
    const config: LogicConfig = { ...DEFAULT_CONFIG, ...overrides };
    const d = createDetector();
    const actions: { at: number; action: Action; }[] = [];
    let now = 0;

    const send = (e: LogicEvent) => {
        for (const action of d.handle(e, config).actions) actions.push({ at: e.at, action });
    };

    const api = {
        config,
        actions,
        get state() { return d.getState(); },
        get now() { return now; },
        types: () => actions.map(a => a.action.type),
        send,
        channel(channelId: string | null) { send({ type: "channel", at: now, channelId }); return api; },
        rtc(state: string) { send({ type: "rtcState", at: now, state }); return api; },
        ping(quality: "unknown" | "bad" | "average" | "fine" = "fine") { send({ type: "ping", at: now, quality }); return api; },
        quality(quality: "unknown" | "bad" | "average" | "fine") { send({ type: "quality", at: now, quality }); return api; },
        manual() { send({ type: "manualReconnect", at: now }); return api; },
        done(channelId: string | null = CH) { send({ type: "reconnectDone", at: now, channelId }); return api; },
        /** Advance time in 1s ticks. Optionally send a fine ping every `pingEveryMs`. */
        advance(ms: number, opts: { pingEveryMs?: number; pingQuality?: "bad" | "fine" | "average"; } = {}) {
            const end = now + ms;
            let nextPing = opts.pingEveryMs != null ? now + opts.pingEveryMs : Infinity;
            while (now < end) {
                now = Math.min(now + S, end);
                while (nextPing <= now) {
                    send({ type: "ping", at: nextPing, quality: opts.pingQuality ?? "fine" });
                    nextPing += opts.pingEveryMs!;
                }
                send({ type: "tick", at: now });
            }
            return api;
        },
        /** Join a channel and get to a healthy connected state. */
        join(channelId = CH) {
            api.channel(channelId).rtc("AWAITING_ENDPOINT").advance(1 * S).rtc("RTC_CONNECTED").ping("fine");
            return api;
        },
        /** Join and stay healthy until the grace period is over. */
        joinHealthy(channelId = CH) {
            api.join(channelId).advance(config.graceSeconds * S + S, { pingEveryMs: 2 * S });
            return api;
        },
    };
    return api;
}

describe("healthy connection", () => {
    it("does nothing for a long, healthy session", () => {
        const s = sim().joinHealthy().advance(10 * 60 * S, { pingEveryMs: 2 * S });
        expect(s.actions).toEqual([]);
    });

    it("average quality is not treated as dead", () => {
        const s = sim().joinHealthy().advance(60 * S, { pingEveryMs: 2 * S, pingQuality: "average" });
        expect(s.actions).toEqual([]);
    });

    it("does nothing while not in voice", () => {
        const s = sim();
        s.rtc("RTC_CONNECTED").quality("bad").advance(60 * S);
        expect(s.actions).toEqual([]);
    });
});

describe("bad quality", () => {
    it("bad quality shorter than the threshold does nothing", () => {
        const s = sim().joinHealthy();
        s.ping("bad").advance(4 * S, { pingEveryMs: 2 * S, pingQuality: "bad" });
        s.ping("fine").advance(60 * S, { pingEveryMs: 2 * S });
        expect(s.actions).toEqual([]);
    });

    it("bad quality longer than the threshold reconnects", () => {
        const s = sim({ mode: "reconnect" }).joinHealthy();
        const badStart = s.now;
        s.ping("bad").advance(6 * S, { pingEveryMs: 1 * S, pingQuality: "bad" });
        expect(s.types()).toEqual(["reconnect"]);
        const [{ at, action }] = s.actions;
        expect(action).toMatchObject({ reason: "badQuality", channelId: CH });
        expect(at - badStart).toBe(5 * S);
        expect(action.durationMs).toBe(5 * S);
    });

    it("bad quality reported via store poll (loss rate) is detected too", () => {
        const s = sim({ mode: "notify" }).joinHealthy();
        s.quality("bad").advance(6 * S, { pingEveryMs: 2 * S, pingQuality: "bad" });
        expect(s.actions[0].action).toMatchObject({ type: "notify", reason: "badQuality" });
    });

    it("a single fine sample resets the bad timer", () => {
        const s = sim().joinHealthy();
        s.ping("bad").advance(4 * S);
        s.ping("fine");
        s.ping("bad").advance(4 * S);
        expect(s.actions).toEqual([]);
    });
});

describe("stale ping", () => {
    it("missing ping updates while connected triggers stalePing", () => {
        const s = sim({ mode: "reconnect" }).joinHealthy();
        const lastPing = s.state.lastPingAt!;
        s.advance(20 * S);
        expect(s.types()).toEqual(["reconnect"]);
        expect(s.actions[0].action.reason).toBe("stalePing");
        expect(s.actions[0].at - lastPing).toBe(8 * S);
    });

    it("pings slightly slower than the threshold are fine", () => {
        const s = sim().joinHealthy().advance(120 * S, { pingEveryMs: 7 * S });
        expect(s.actions).toEqual([]);
    });

    it("no ping at all after connecting is measured from the connect time", () => {
        const s = sim({ mode: "notify", graceSeconds: 0 });
        s.channel(CH).rtc("RTC_CONNECTED");
        const connectedAt = s.now;
        s.advance(10 * S);
        expect(s.actions[0].action.reason).toBe("stalePing");
        expect(s.actions[0].at - connectedAt).toBe(8 * S);
    });

    it("does not report stale pings while not connected", () => {
        const s = sim({ stuckConnectingSeconds: 1000 }).joinHealthy();
        s.rtc("RTC_CONNECTING").advance(60 * S);
        expect(s.actions).toEqual([]);
    });
});

describe("stuck connecting", () => {
    it.each(["CONNECTING", "RTC_CONNECTING", "NO_ROUTE", "ICE_CHECKING", "DTLS_CONNECTING", "RTC_DISCONNECTED"])(
        "stuck in %s triggers stuckConnecting after the threshold",
        state => {
            const s = sim({ mode: "reconnect" }).joinHealthy();
            const since = s.now;
            s.rtc(state).advance(20 * S);
            expect(s.types()).toEqual(["reconnect"]);
            expect(s.actions[0].action.reason).toBe("stuckConnecting");
            expect(s.actions[0].at - since).toBe(15 * S);
        },
    );

    it("short connecting phases (Discord's own recovery) do nothing", () => {
        const s = sim().joinHealthy();
        s.rtc("RTC_DISCONNECTED").advance(3 * S).rtc("RTC_CONNECTING").advance(10 * S).rtc("RTC_CONNECTED").ping();
        s.advance(60 * S, { pingEveryMs: 2 * S });
        expect(s.actions).toEqual([]);
    });

    it("changing between connecting states restarts the timer", () => {
        const s = sim().joinHealthy();
        s.rtc("RTC_CONNECTING").advance(10 * S).rtc("ICE_CHECKING").advance(10 * S);
        expect(s.actions).toEqual([]);
    });

    it("DISCONNECTED is not considered stuck", () => {
        expect(STUCK_STATES.has("DISCONNECTED")).toBe(false);
        const s = sim().joinHealthy();
        s.rtc("DISCONNECTED").advance(60 * S);
        expect(s.actions).toEqual([]);
    });

    it("hanging right after join is caught once grace and threshold passed", () => {
        const s = sim({ mode: "reconnect" });
        s.channel(CH).rtc("AWAITING_ENDPOINT");
        const since = s.now;
        s.advance(30 * S);
        expect(s.types()).toEqual(["reconnect"]);
        expect(s.actions[0].at - since).toBe(15 * S);
    });
});

describe("grace period", () => {
    it("ignores a dead connection during the grace period after join", () => {
        const s = sim({ mode: "notify", graceSeconds: 10 });
        s.channel(CH).rtc("RTC_CONNECTED").ping("bad").advance(9 * S);
        expect(s.actions).toEqual([]);
    });

    it("acts right after the grace period if the problem persisted", () => {
        const s = sim({ mode: "notify", graceSeconds: 10 });
        const joinedAt = s.now;
        s.channel(CH).rtc("RTC_CONNECTED").ping("bad").advance(15 * S, { pingEveryMs: 1 * S, pingQuality: "bad" });
        expect(s.types()).toEqual(["notify"]);
        expect(s.actions[0].at - joinedAt).toBe(10 * S);
    });

    it("applies after an automatic rejoin as well", () => {
        const s = sim({ mode: "reconnect", cooldownSeconds: 0 }).joinHealthy();
        s.advance(9 * S); // stale ping -> reconnect
        expect(s.types()).toEqual(["reconnect"]);
        s.done(CH).rtc("RTC_CONNECTED");
        s.advance(9 * S); // no pings, but still inside grace
        expect(s.types()).toEqual(["reconnect"]);
    });
});

describe("user actions", () => {
    it("leaving manually while bad does nothing", () => {
        const s = sim().joinHealthy();
        s.ping("bad").advance(3 * S).channel(null).rtc("DISCONNECTED").advance(60 * S);
        expect(s.actions).toEqual([]);
        expect(s.state.channelId).toBeNull();
    });

    it("switching channels resets timers and starts a new grace period", () => {
        const s = sim().joinHealthy();
        s.ping("bad").advance(4 * S);
        s.channel(OTHER).rtc("RTC_CONNECTING").advance(1 * S).rtc("RTC_CONNECTED").ping("fine");
        s.advance(60 * S, { pingEveryMs: 2 * S });
        expect(s.actions).toEqual([]);
        expect(s.state.channelId).toBe(OTHER);
    });

    it("the same channel id reported again is not a channel change", () => {
        const s = sim().joinHealthy();
        const { joinedAt } = s.state;
        s.channel(CH);
        expect(s.state.joinedAt).toBe(joinedAt);
    });

    it("channel changes during our own reconnect are ignored", () => {
        const s = sim({ mode: "reconnect" }).joinHealthy();
        s.advance(9 * S);
        expect(s.state.reconnecting).toBe(true);
        s.channel(null);
        expect(s.state.channelId).toBe(CH);
        expect(s.state.reconnecting).toBe(true);
        s.channel(CH).done(CH);
        expect(s.state.reconnecting).toBe(false);
    });

    it("no detection while our own reconnect is in progress", () => {
        const s = sim({ mode: "reconnect", cooldownSeconds: 0 }).joinHealthy();
        s.advance(9 * S);
        s.rtc("RTC_CONNECTING").advance(20 * S);
        expect(s.types()).toEqual(["reconnect"]);
    });

    it("manual rejoin after pause resets the attempt budget", () => {
        const s = sim({ mode: "reconnect", cooldownSeconds: 0, maxAttempts: 1 }).joinHealthy();
        s.advance(9 * S).done(CH).rtc("RTC_CONNECTED");
        s.advance(20 * S);
        expect(s.types()).toEqual(["reconnect", "pauseNotify"]);
        s.channel(null).channel(CH).rtc("RTC_CONNECTED").ping();
        s.advance(20 * S);
        expect(s.types()).toEqual(["reconnect", "pauseNotify", "reconnect"]);
    });
});

describe("loop protection", () => {
    /** Join, then let the connection die repeatedly (no pings), completing every reconnect immediately. */
    function dieRepeatedly(overrides: Partial<LogicConfig>, totalMs: number) {
        const s = sim({ mode: "reconnect", ...overrides }).joinHealthy();
        const end = s.now + totalMs;
        while (s.now < end) {
            s.advance(1 * S);
            if (s.state.reconnecting) s.done(CH).rtc("RTC_CONNECTED");
        }
        return s;
    }

    it("respects the cooldown between reconnects", () => {
        const s = dieRepeatedly({ cooldownSeconds: 30, maxAttempts: 100 }, 100 * S);
        const times = s.actions.filter(a => a.action.type === "reconnect").map(a => a.at);
        expect(times.length).toBeGreaterThan(1);
        for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(30 * S);
    });

    it("pauses after maxAttempts and notifies exactly once", () => {
        const s = dieRepeatedly({ cooldownSeconds: 30, maxAttempts: 3, attemptWindowMinutes: 5 }, 4 * 60 * S);
        expect(s.types()).toEqual(["reconnect", "reconnect", "reconnect", "pauseNotify"]);
        const pause = s.actions[3].action;
        expect(pause).toMatchObject({ type: "pauseNotify", attempts: 3, channelId: CH });
    });

    it("resumes once the attempt window has passed", () => {
        const s = dieRepeatedly({ cooldownSeconds: 30, maxAttempts: 3, attemptWindowMinutes: 5 }, 8 * 60 * S);
        expect(s.types().slice(0, 4)).toEqual(["reconnect", "reconnect", "reconnect", "pauseNotify"]);
        expect(s.types().slice(4)).toContain("reconnect");
        const firstAttempt = s.actions[0].at;
        const resumed = s.actions.find((a, i) => i > 3 && a.action.type === "reconnect")!;
        expect(resumed.at - firstAttempt).toBeGreaterThanOrEqual(5 * 60 * S);
    });

    it("a fractional / zero maxAttempts still allows one attempt", () => {
        const s = dieRepeatedly({ cooldownSeconds: 0, maxAttempts: 0 }, 60 * S);
        expect(s.types()).toEqual(["reconnect", "pauseNotify"]);
    });

    it("clears a stuck reconnect after the safety timeout", () => {
        const s = sim({ mode: "reconnect" }).joinHealthy();
        s.advance(9 * S);
        expect(s.state.reconnecting).toBe(true);
        s.advance(RECONNECT_TIMEOUT_MS + S);
        expect(s.state.reconnecting).toBe(false);
    });
});

describe("modes", () => {
    const killConnection = (mode: Mode) => sim({ mode }).joinHealthy().advance(9 * S);

    it("notify mode only notifies", () => {
        const s = killConnection("notify");
        expect(s.types()).toEqual(["notify"]);
        expect(s.state.reconnecting).toBe(false);
    });

    it("reconnect mode only reconnects", () => {
        expect(killConnection("reconnect").types()).toEqual(["reconnect"]);
    });

    it("notifyAndReconnect mode notifies and reconnects", () => {
        const s = killConnection("notifyAndReconnect");
        expect(s.types()).toEqual(["notify", "reconnect"]);
        expect(s.actions[0].action).toMatchObject({ reason: "stalePing", channelId: CH });
        expect(s.actions[1].action).toMatchObject({ reason: "stalePing", channelId: CH });
    });

    it("notify mode does not spam while the incident persists", () => {
        const s = sim({ mode: "notify" }).joinHealthy().advance(10 * 60 * S);
        expect(s.types()).toEqual(["notify"]);
    });

    it("notify mode notifies again for a new incident after recovery and cooldown", () => {
        const s = sim({ mode: "notify", cooldownSeconds: 30 }).joinHealthy();
        s.advance(9 * S);
        s.ping().advance(60 * S, { pingEveryMs: 2 * S });
        s.advance(10 * S);
        expect(s.types()).toEqual(["notify", "notify"]);
    });

    it("notify mode respects the cooldown for flapping connections", () => {
        const s = sim({ mode: "notify", cooldownSeconds: 30 }).joinHealthy();
        s.advance(9 * S); // incident 1
        s.ping().advance(1 * S); // recovers briefly
        s.advance(9 * S); // incident 2 within cooldown -> suppressed
        expect(s.types()).toEqual(["notify"]);
        s.advance(30 * S); // still dead, cooldown passed -> notify again
        expect(s.types()).toEqual(["notify", "notify"]);
    });

    it("pauseNotify is emitted in notifyAndReconnect mode too", () => {
        const s = sim({ mode: "notifyAndReconnect", cooldownSeconds: 0, maxAttempts: 1 }).joinHealthy();
        s.advance(9 * S).done(CH).rtc("RTC_CONNECTED").advance(20 * S);
        expect(s.types()).toEqual(["notify", "reconnect", "pauseNotify"]);
    });
});

describe("manual reconnect", () => {
    it("emits a reconnect with reason manual, bypassing cooldown and budget", () => {
        const s = sim({ maxAttempts: 1 }).joinHealthy();
        s.manual();
        expect(s.actions.map(a => a.action)).toEqual([{ type: "reconnect", reason: "manual", durationMs: 0, channelId: CH }]);
        s.done(CH);
        expect(s.state.attempts).toEqual([]);
        s.manual();
        expect(s.types()).toEqual(["reconnect", "reconnect"]);
    });

    it("is ignored when not in voice or already reconnecting", () => {
        const s = sim();
        s.manual();
        expect(s.actions).toEqual([]);
        s.joinHealthy().manual().manual();
        expect(s.types()).toEqual(["reconnect"]);
    });

    it("a failed rejoin (channel null) returns to idle", () => {
        const s = sim().joinHealthy().manual().done(null);
        expect(s.state).toMatchObject({ channelId: null, reconnecting: false });
        s.advance(60 * S);
        expect(s.types()).toEqual(["reconnect"]);
    });
});

describe("event loop stalls", () => {
    it("a long gap between ticks (system sleep) restarts the grace period instead of firing", () => {
        const s = sim({ mode: "notify" }).joinHealthy();
        // Simulate the renderer being frozen for 60s: next tick arrives late.
        s.send({ type: "tick", at: s.now + 60 * S });
        expect(s.actions).toEqual([]);
        expect(s.state.joinedAt).toBe(s.now + 60 * S);
        expect(STALL_THRESHOLD_MS).toBeLessThan(60 * S);
    });

    it("a stall while quality is bad restarts the bad timer", () => {
        const s = sim({ mode: "notify" }).joinHealthy().ping("bad");
        const t = s.now + 60 * S;
        s.send({ type: "tick", at: t });
        expect(s.state.badSince).toBe(t);
    });
});

describe("pure helpers", () => {
    it("detect returns null without a channel", () => {
        expect(detect(createInitialState(), 1e9, DEFAULT_CONFIG)).toBeNull();
    });

    it("step does not mutate the input state", () => {
        const state = createInitialState();
        const copy = structuredClone(state);
        step(state, { type: "channel", at: 5, channelId: CH }, DEFAULT_CONFIG);
        expect(state).toEqual(copy);
    });

    it("rtcState repeated with the same value keeps the original timestamp", () => {
        let { state } = step(createInitialState(), { type: "rtcState", at: 1, state: "RTC_CONNECTING" }, DEFAULT_CONFIG);
        ({ state } = step(state, { type: "rtcState", at: 5, state: "RTC_CONNECTING" }, DEFAULT_CONFIG));
        expect(state.rtcStateSince).toBe(1);
    });

    it("ping without quality only updates the ping timestamp", () => {
        const { state } = step(createInitialState(), { type: "ping", at: 7 }, DEFAULT_CONFIG);
        expect(state).toMatchObject({ lastPingAt: 7, quality: "unknown" });
    });

    it("leaving RTC_CONNECTED resets quality to unknown", () => {
        const s = sim().joinHealthy().ping("bad");
        s.rtc("RTC_CONNECTING");
        expect(s.state).toMatchObject({ quality: "unknown", badSince: null });
    });

    it("createDetector.reset restores the initial state", () => {
        const d = createDetector();
        d.handle({ type: "channel", at: 1, channelId: CH }, DEFAULT_CONFIG);
        d.reset();
        expect(d.getState()).toEqual(createInitialState());
    });

    it("describeReason covers every reason", () => {
        for (const r of ["badQuality", "stalePing", "stuckConnecting", "manual"] as const)
            expect(describeReason(r)).toMatch(/\w+/);
    });
});
