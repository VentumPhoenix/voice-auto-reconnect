/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 VentumPhoenix
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

import { DEFAULT_CONFIG, LogicConfig } from "./logic";

const nonNegative = (value: number) => (Number.isFinite(value) && value >= 0) || "Must be a number >= 0";
const atLeastOne = (value: number) => (Number.isFinite(value) && value >= 1) || "Must be a number >= 1";

export const settings = definePluginSettings({
    mode: {
        type: OptionType.SELECT,
        description: "What to do when the voice connection silently dies",
        options: [
            { label: "Notify and reconnect automatically", value: "notifyAndReconnect", default: true },
            { label: "Reconnect automatically (no notification)", value: "reconnect" },
            { label: "Only notify me", value: "notify" },
        ],
    },
    playSound: {
        type: OptionType.BOOLEAN,
        description: "Play a short alert sound together with notifications",
        default: true,
    },
    badDurationSeconds: {
        type: OptionType.NUMBER,
        description: "Seconds the connection quality must stay bad (red bars) before acting",
        default: DEFAULT_CONFIG.badDurationSeconds,
        isValid: nonNegative,
    },
    staleSeconds: {
        type: OptionType.NUMBER,
        description: "Seconds without any voice ping update (while shown as connected) before acting",
        default: DEFAULT_CONFIG.staleSeconds,
        isValid: nonNegative,
    },
    stuckConnectingSeconds: {
        type: OptionType.NUMBER,
        description: "Seconds the connection may hang in Connecting / No Route / ICE Checking before acting",
        default: DEFAULT_CONFIG.stuckConnectingSeconds,
        isValid: nonNegative,
    },
    graceSeconds: {
        type: OptionType.NUMBER,
        description: "Grace period in seconds after joining a channel during which nothing is detected",
        default: DEFAULT_CONFIG.graceSeconds,
        isValid: nonNegative,
    },
    reconnectDelayMs: {
        type: OptionType.NUMBER,
        description: "Pause in milliseconds between leaving and rejoining the channel",
        default: 1000,
        isValid: nonNegative,
    },
    cooldownSeconds: {
        type: OptionType.NUMBER,
        description: "Minimum seconds between two automatic reconnects (or two notifications in notify-only mode)",
        default: DEFAULT_CONFIG.cooldownSeconds,
        isValid: nonNegative,
    },
    maxAttempts: {
        type: OptionType.NUMBER,
        description: "Maximum automatic reconnects per attempt window. After that, auto reconnect pauses and you get notified",
        default: DEFAULT_CONFIG.maxAttempts,
        isValid: atLeastOne,
    },
    attemptWindowMinutes: {
        type: OptionType.NUMBER,
        description: "Length of the attempt window in minutes (see maxAttempts)",
        default: DEFAULT_CONFIG.attemptWindowMinutes,
        isValid: nonNegative,
    },
    debugLogging: {
        type: OptionType.BOOLEAN,
        description: "Log every connection state, ping and quality change to the console (for troubleshooting)",
        default: false,
    },
});

const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback);

/** Reads the current settings as a sanitised LogicConfig. */
export function getLogicConfig(): LogicConfig {
    const s = settings.store;
    return {
        mode: s.mode === "notify" || s.mode === "reconnect" ? s.mode : "notifyAndReconnect",
        badDurationSeconds: num(s.badDurationSeconds, DEFAULT_CONFIG.badDurationSeconds),
        staleSeconds: num(s.staleSeconds, DEFAULT_CONFIG.staleSeconds),
        stuckConnectingSeconds: num(s.stuckConnectingSeconds, DEFAULT_CONFIG.stuckConnectingSeconds),
        graceSeconds: num(s.graceSeconds, DEFAULT_CONFIG.graceSeconds),
        cooldownSeconds: num(s.cooldownSeconds, DEFAULT_CONFIG.cooldownSeconds),
        maxAttempts: Math.max(1, num(s.maxAttempts, DEFAULT_CONFIG.maxAttempts)),
        attemptWindowMinutes: num(s.attemptWindowMinutes, DEFAULT_CONFIG.attemptWindowMinutes),
    };
}
