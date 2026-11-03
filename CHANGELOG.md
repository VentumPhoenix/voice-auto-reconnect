# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-04

### Added

- Detection of silently dead voice connections:
  - connection quality stays `bad` for longer than `badDurationSeconds` (default 5 s)
  - no ping updates for longer than `staleSeconds` (default 8 s) while RTC is connected
  - RTC stuck in a connecting state for longer than `stuckConnectingSeconds` (default 15 s)
- Modes `notify`, `reconnect` and `notifyAndReconnect` (default), optional alert sound.
- Automatic leave + rejoin of the same channel, keeping mute / deafen and camera state.
- Grace period after joining, no reaction to manual leave / channel switch or during own reconnects.
- Loop protection: cooldown, `maxAttempts` per `attemptWindowMinutes`, then a single "paused" notification.
- Manual "Reconnect voice now" action in the Vencord Toolbox.
- Self check on start with a clear "incompatible" message if Discord internals are missing.
- Optional debug logging.
- Unit tests for the pure detection logic, CI against Vencord main and a daily compatibility check that opens / closes a `compat` issue.
- Update scripts for Windows (`scripts/update.ps1`) and Linux / macOS (`scripts/update.sh`).

[Unreleased]: https://github.com/VentumPhoenix/voice-auto-reconnect/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/VentumPhoenix/voice-auto-reconnect/releases/tag/v0.1.0
