# Changelog

## [1.2.0](https://github.com/Luce-Florian/focus/compare/v1.1.0...v1.2.0) (2026-09-22)


### Features

* rank sessions by importance inside a class ([cf3d4f3](https://github.com/Luce-Florian/focus/commit/cf3d4f32db392de40a3e278505cd86f10ea36ba8)), closes [#4](https://github.com/Luce-Florian/focus/issues/4)
* remove pin feature ([#11](https://github.com/Luce-Florian/focus/issues/11)) ([e350774](https://github.com/Luce-Florian/focus/commit/e350774c8cea1b9315595f1662256d266a485b37))

## [1.1.0](https://github.com/Luce-Florian/focus/compare/v1.0.0...v1.1.0) (2026-09-17)


### Features

* attention arbiter for a fleet of Claude Code sessions ([121328e](https://github.com/Luce-Florian/focus/commit/121328e1ec47b006155b8375821ce3e609bc488c))
* migrate config to TypeScript, fix ROOT for the compiled bundle depth ([8772db4](https://github.com/Luce-Florian/focus/commit/8772db427bc420ae9748701c3841a2f8011cd1d5))
* migrate db to TypeScript, add SQLite row shapes to the shared protocol ([aa25294](https://github.com/Luce-Florian/focus/commit/aa25294cf719e6974c7f8e43fa927258952dbe01))
* migrate Electron main entry to TypeScript ([badc337](https://github.com/Luce-Florian/focus/commit/badc3371701697e772f806beea7f9ef948849ad6))
* migrate hooks-server to TypeScript ([ec45b40](https://github.com/Luce-Florian/focus/commit/ec45b40686276149fca5f3863e39af3482b7aa87))
* migrate preload to TypeScript, add the FleetBridge contract ([42bc175](https://github.com/Luce-Florian/focus/commit/42bc1752bb39f55b21e98af100dbebfffe37bebb))
* migrate renderer to TypeScript, drop the UMD xterm.js load ([86f781a](https://github.com/Luce-Florian/focus/commit/86f781a08ca2e187e63ce2376e8aa261d9fe270b))
* migrate session-settings to TypeScript ([44624eb](https://github.com/Luce-Florian/focus/commit/44624eba082b3fc9649471cc62deecee0ace1998))
* migrate the arbiter state machine to TypeScript ([771a9b1](https://github.com/Luce-Florian/focus/commit/771a9b10f7efcc0b6156b9ef56f1d8cdee7343ef))
* migrate the smoke test to TypeScript ([073c953](https://github.com/Luce-Florian/focus/commit/073c953063ec2c108635b428a3f8d3b9b2742acf))
* migrate tmux control-mode bridge to TypeScript ([04e7b4f](https://github.com/Luce-Florian/focus/commit/04e7b4f6a833f1a35191043eead71204fd227ab8))
* start a Claude Code session from the user interface ([95b0f05](https://github.com/Luce-Florian/focus/commit/95b0f0546a733dc54216a7e76bb7e59a0b993e7f)), closes [#2](https://github.com/Luce-Florian/focus/issues/2)
* wire the esbuild/ESLint pipeline into make check, fix strict-lint findings ([55a6558](https://github.com/Luce-Florian/focus/commit/55a6558d6862a9438f1c87cb29e2878a764a57be))


### Bug Fixes

* address high-confidence code-review findings on the TS migration ([8f5fd92](https://github.com/Luce-Florian/focus/commit/8f5fd92ed7bf4eae6a59e136794cf91cb0475be3))
