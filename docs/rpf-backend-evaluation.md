# RPF backend evaluation (Phase 3C)

Phase 3C required a commercially redistributable, Enhanced-capable, read-only RPF reader that does not depend on OpenIV.

Technical quality does not override licence restrictions.

## Comparison

| Name | Source | Licence | Commercial? | Redistribution? | Enhanced? | Read-only? | Write? | Native? | Node/Electron | Maintenance | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CodeWalker | github.com/dexyfex/CodeWalker | **No project licence** (all rights reserved by default). Third-party notices include MIT RageLib pieces and GPL FbxWriter | No (unclear / ARR) | No | Best community Enhanced explorer | Yes (app) | Yes (app) | .NET | Would require bundling unlicensed Core | Active | **REJECTED_FOR_LICENSING** |
| CodeWalker.API | github.com/flobros/CodeWalker.API | MIT on the API wrapper | Wrapper yes; **depends on CodeWalker** | Same problem | Indirect | Yes | Yes | .NET 9 | Local HTTP API | Small | **REJECTED_FOR_LICENSING** |
| RageKit | github.com/ThymonA/RageKit | Claims MIT; CodeWalker fork + GPL FBX notice | Contaminated | Unsafe | Unclear | Yes | Unknown | .NET | Poor | Stale | **REJECTED_FOR_LICENSING** |
| RageIO | github.com/ranstar74/RageIO | None; requires CodeWalker.Core | No | No | Unclear | Yes | Unknown | .NET | Poor | Stale | **REJECTED_FOR_LICENSING** |
| gta-toolkit / RageLib | github.com/Neodymium146/gta-toolkit | MIT on many files; project discontinued | MIT files yes | Yes with attribution | **Not claimed for Enhanced** | Yes | Yes | .NET / C++ | Need a helper process | Last push 2021 | **REJECTED** — licence OK, Enhanced unproven, abandoned, no Node path |
| rpf-archive / rpf-rs | crates.io/crates/rpf-archive, github.com/VIRUXE/rpf-rs | MIT on crates.io; Unlicense on GitHub | Yes | Yes | Documents **RPF7 / FiveM**, not Enhanced | Yes | Yes (not to be exposed) | Rust cdylib | No maintained Node binding; `RpfFile` loads whole archive | Very new, few users | **REJECTED** — licence OK, but loads entire archives, no Enhanced proof, no Electron integration, encryption keys from `GTA5.exe` are legally sensitive |
| OpenRPF / RageOpenV | gta5-mods / github.com/Chiheb-Bacha/RageOpenV | GPL-3.0; **“DO NOT REDISTRIBUTE built binaries”** | GPL copyleft | Binaries prohibited | ASI for Enhanced | In-game loader, not a library | N/A | Native ASI | Must not bundle or invoke | Active | **REJECTED_FOR_LICENSING** + OpenIV-adjacent |
| OpenIV | Closed commercial tool | Proprietary | No | No | Yes | Yes | Yes | Native | Forbidden | Active | **REJECTED** — Phase 3C must stay independent |
| First-party OPEN RPF7 reader | this repository | MIT (project licence) | Yes | Yes | Identifies RPF7; **encrypted official archives unsupported** | Yes | Refused | Node `fs` only | In-process, bounded TOC | Owned | **SELECTED** for Phase 3C read-only |

## Selected backend

**First-party OPEN/unencrypted RPF7 reader** (`src/services/archive/realRpfBackend.js`).

Why this is the only commercially usable option:

- No third-party RPF library is bundled
- No OpenIV code, DLLs, or automation
- No GPL / ARR / “no redistribute” component
- Writes are compile-time disabled (`ENABLE_NATIVE_ARCHIVE_WRITES=false`)
- Official Enhanced archives are typically NG/AES encrypted; those return `ENCRYPTED_RPF_NOT_SUPPORTED` after a 16-byte header read
- Supported archives are independently generated OPEN RPF7 fixtures (dummy bytes, no Rockstar assets)

## If we had selected nothing

The fallback report would have been `NO ACCEPTABLE RPF BACKEND FOUND` for **encrypted official Enhanced archives**. That remains a documented limitation. Building a key-extracting or NG-decrypting reader was rejected: distributing or deriving Rockstar keys is not acceptable for this product.

## Own-parser feasibility

A bounded OPEN RPF7 TOC reader is feasible and is what Phase 3C ships:

- Magic `0x52504637`, 16-byte header, 16-byte entries, names table
- OPEN (`0x4E45504F`) or none (`0`)
- Lazy: header + TOC only; file bodies on `readEntry`
- Safety limits on entry count, names size, and read size

Encrypted RPF7, RPF8, and other versions are explicitly unsupported. Phase 3D confirmed there is no lawful distributable key source; native encrypted writes stay rejected. Overlay alternatives are documented in `docs/enhanced-mod-layer-evaluation.md`.
