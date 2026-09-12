# Enhanced mod-layer evaluation (Phase 3D)

Phase 3D asked whether GTA 5 Mod Manager can install Enhanced vehicle/archive mods **without OpenIV** and **without writing official encrypted RPFs**.

This document is research and architecture. It does not enable writes. No encryption keys were extracted or copied.

**Decision: `NO SAFE ENHANCED MOD LAYER FOUND`**

There is a technically attractive *future* model (manager-owned DLC + licence-clear overlay). No candidate today is Enhanced-proven, RPH/LSPDFR-safe, *and* commercially redistributable. Encrypted native RPF writing is **REJECTED** until a lawful key source exists.

## Supported today / not yet supported

### Supported today

- Plugin mods, callouts, and other filesystem dependencies
- Smart Install V2 transactional filesystem installs
- Vehicle recognition, analysis, and dry-run planning
- OPEN / unencrypted RPF7 test archives (read-only)
- Identifying official Enhanced archives as encrypted without mutating them

### Not yet supported

- Encrypted Enhanced RPF modification
- Real replacement-vehicle archive install
- Automatic EUP / weapon / audio archive installation
- Bundled OpenIV, OpenRPF, LML, or Simple Mods Loader
- Any overlay that requires extracting NG keys from the game

## Duty snapshot used for compatibility notes

The current known-good Duty folder (verified by `npm run verify`) has:

- RAGE Plugin Hook + LSPDFR
- Ultimate ASI Loader (`XInput1_4.dll`) and `dinput8.dll`
- `DirectStorageFix.asi`
- `HeapAdjuster.asi`
- `PackfileLimitAdjusterEnhanced.asi`
- No `mods\` folder, no `lml\`, no `OpenIV.asi`, no `OpenRPF.asi`

Any new ASI is a launch-risk until proven against that set. Script Hook V and Script Hook V .NET stay parked / not auto-enabled.

---

## 1. Vanilla Enhanced loose files

| Field | Value |
| --- | --- |
| Mechanism name | Official loose-file / folder override |
| How it works | Place `.yft` / `.ytd` next to the game exe or in a game folder and hope the packfile system loads them |
| GTA Enhanced support | **No.** Enhanced loads streamed assets from RPF packfiles. There is no documented Rockstar loose-file API for vehicles. |
| Modifies original archives | No |
| Requires ASI/plugin | No |
| RPH/LSPDFR compatible | N/A — the game will not see the files |
| Licence | N/A (first-party filesystem) |
| Redistribution | N/A |
| Commercial suitability | Yes, but useless for vehicle models |
| Stability | N/A |
| Game-update resilience | HIGH (nothing to break) if used only for plugins |
| Profile support | Yes for filesystem files |
| Uninstall | Delete files |
| Performance | Not measured; unused for vehicles |
| Known limitations | Loose `police3.yft` in the Duty root does not replace the streamed model |
| Recommendation | **REJECTED** for vehicle/archive assets. Keep for plugins only. |

---

## 2. Official DLC pack mount (no overlay)

| Field | Value |
| --- | --- |
| Mechanism name | Standalone `dlcpacks/<name>/dlc.rpf` + `dlclist.xml` |
| How it works | Enhanced already mounts DLC listed in `update.rpf/common/data/dlclist.xml`. A new pack is ignored until that list is updated. |
| GTA Enhanced support | Yes, for Rockstar and well-formed add-on DLC **after** registration |
| Modifies original archives | **Yes**, unless a copy of `dlclist.xml` is overlaid. Official `update.rpf` is NG-encrypted. |
| Requires ASI/plugin | Not if you edit the official archive (unsafe / not viable). Yes if you overlay `dlclist` |
| RPH/LSPDFR compatible | DLC itself is fine; editing `update.rpf` is not acceptable here |
| Licence | First-party pack content can be MIT; the registration problem is technical/legal on the archive side |
| Commercial suitability | Pack *layout* is fine. Writing official encrypted `update.rpf` is not. |
| Stability | Add-on DLC usually also needs HeapAdjuster + Packfile Limit Adjuster Enhanced + a raised `gameconfig` (already in Duty for the first two) |
| Game-update resilience | LOW if official `update.rpf` is edited (updates overwrite / re-encrypt). MEDIUM if a mods-folder copy is used. |
| Profile support | Poor if each profile rewrites a multi-gigabyte `update.rpf` copy. Better if only a small overlay XML changes. |
| Uninstall | Remove pack folder **and** revert `dlclist`. Vanilla does not return if the official archive was edited. |
| Performance | Not measured. Extra DLC packs increase startup/stream cost; that is why limit adjusters exist. |
| Known limitations | This manager can already patch a *writable loose* `dlclist.xml` (`src/services/dlclist.js`) **only if one already exists outside the encrypted archive**. Duty does not have that file. |
| Recommendation | **NOT SUFFICIENT ALONE.** Attractive as the *content* format once a licence-clear overlay can register the pack. |

---

## 3. OpenIV.asi mods folder

| Field | Value |
| --- | --- |
| Mechanism name | OpenIV ASI archive redirect |
| How it works | Copies of RPFs (or edited archives) under `mods\` are preferred over official files |
| GTA Enhanced support | Legacy yes. Enhanced: OpenIV.asi is widely reported as **not** the Enhanced path; community moved to OpenRPF |
| Modifies original archives | No, if users only edit `mods\` copies. Still requires copying `update.rpf` (large) |
| Requires ASI/plugin | Yes (`OpenIV.asi`) |
| RPH/LSPDFR compatible | Unproven on this Duty set; extra ASI risk. Product rule: do not depend on OpenIV |
| Licence | Proprietary. No redistribution of OpenIV binaries |
| Commercial suitability | **No** for bundling or automation |
| Stability | Unknown on Enhanced + RPH |
| Game-update resilience | MEDIUM (copy `update.rpf` again after updates) |
| Profile support | Possible by swapping `mods\`, but copies are huge |
| Uninstall | Remove `mods\` copy; vanilla returns if official files were untouched |
| Performance | Not measured |
| Known limitations | Phase 3C/3D forbid OpenIV automation, DLLs, and UI driving |
| Recommendation | **REJECTED** — OpenIV dependency |

---

## 4. OpenRPF / RageOpenV

| Field | Value |
| --- | --- |
| Mechanism name | OpenRPF.asi (Enhanced OpenIV.asi replacement); RageOpenV is the related open-source tree |
| How it works | ASI redirects packfile reads to `mods\` RPFs; supports OPEN and encrypted archives; Gen9 `rpf.cache` bypass |
| GTA Enhanced support | Community-used for Enhanced. Version-sensitive (e.g. 1013.17+) |
| Modifies original archives | No, if only `mods\` is used |
| Requires ASI/plugin | Yes. Historically shipped with an extra ASI loader (`dsound.dll`) that can fight `XInput1_4.dll` |
| RPH/LSPDFR compatible | **Not proven** on this Duty layout. Extra loader + cache bypass is a launch risk |
| Licence | OpenRPF / RageOpenV: GPL-3.0 and **“DO NOT REDISTRIBUTE built binaries”** (Phase 3C). **REJECTED_FOR_LICENSING** |
| Redistribution | Binaries prohibited; GPL source-disclosure if we ship a derived ASI |
| Commercial suitability | **No** for a closed commercial Electron app that bundles the ASI |
| Stability | Community reports both success and Enhanced/NVE crash cases. Not measured here |
| Game-update resilience | MEDIUM |
| Profile support | Same huge `mods\update.rpf` problem |
| Uninstall | Remove ASI + `mods\`; official archives stay intact |
| Performance | Not measured. Authors claim better loading than OpenIV.asi |
| Known limitations | Still needs someone to *author* modified RPFs (OpenIV/CodeWalker). Does not remove the archive-edit problem; it only redirects it |
| Recommendation | **REJECTED_FOR_LICENSING.** Do not bundle, invoke, or automate. Detection-only is already enough for health warnings. |

---

## 5. Simple Mods Loader

| Field | Value |
| --- | --- |
| Mechanism name | Simple Mods Loader (GTA5-Mods) |
| How it works | ASI loads loose files or RPFs from `mods\` (`update/update.rpf/example.ytd` or `update--update.rpf--example.ytd`). Claims auto add-on discovery and heap/packfile adjust. Changelog: **“Find ng-encryption from game files.”** |
| GTA Enhanced support | Author claims Legacy + Enhanced |
| Modifies original archives | No |
| Requires ASI/plugin | Yes. Claims no ScriptHookV / OpenIV |
| RPH/LSPDFR compatible | **Unknown.** Auto heap/packfile may collide with Duty’s HeapAdjuster and Packfile Limit Adjuster Enhanced |
| Licence | **LICENCE_UNCLEAR.** No public OSI licence found. Treat as non-redistributable |
| Commercial suitability | **No** for bundling |
| Stability | Not measured. Closed source |
| Game-update resilience | HIGH *if* the advertised “no reinstall after game file change” holds — **unverified** |
| Profile support | Folder swap would be easy *if* the loader is trusted |
| Uninstall | Remove ASI + `mods\` |
| Performance | Not measured |
| Known limitations | Runtime key discovery from the game is exactly the path this product must not implement or ship. Using a closed binary that does it is still a redistribution/legal risk |
| Recommendation | **REJECTED** — `LICENCE_UNCLEAR` + key-derivation approach |

---

## 6. Lenny's Mod Loader (LML)

| Field | Value |
| --- | --- |
| Mechanism name | LML per-file replace + add-on streaming |
| How it works | `lml/<mod>/install.xml` maps replacements and add-ons without editing RPFs |
| GTA Enhanced support | **Not established.** Public material is Legacy-oriented (including later Legacy builds). No verified Enhanced + RPH report was found that we can treat as product evidence |
| Modifies original archives | No |
| Requires ASI/plugin | Yes (`lml.asi` / LML package) |
| RPH/LSPDFR compatible | Legacy LSPDFR users use LML; Enhanced is unproven |
| Licence | **LICENCE_UNCLEAR** for redistribution/bundling |
| Commercial suitability | Not until licence + Enhanced proof exist |
| Stability | Not measured on Enhanced |
| Game-update resilience | HIGH on Legacy *in principle* (no RPF copies). Unverified on Enhanced |
| Profile support | Strong (enable/disable folders) *if* it worked |
| Uninstall | Delete the LML pack folder; vanilla returns |
| Performance | Not measured |
| Known limitations | Most replacement vehicles are still shipped as OpenIV/RPF packs, not LML `install.xml` |
| Recommendation | **NOT SELECTED.** Revisit only with a written redistribution licence and Enhanced+RPH proof |

---

## 7. LSPDFR XML slot remap (Duty filesystem)

| Field | Value |
| --- | --- |
| Mechanism name | `lspdfr/data/agency.xml`, `backup.xml`, `duty_selection.xml` (and Ultimate Backup XMLs) |
| How it works | LSPDFR spawn lists can name an add-on model instead of `police3` |
| GTA Enhanced support | Yes — these are ordinary XML files on disk |
| Modifies original archives | No |
| Requires ASI/plugin | LSPDFR only (already present) |
| RPH/LSPDFR compatible | **Yes.** This is first-party LSPDFR configuration |
| Licence | LSPDFR configs are user-owned; manager can edit Duty copies |
| Commercial suitability | Yes |
| Stability | HIGH for XML edits if we stay transactional (V2) |
| Game-update resilience | HIGH for our files; LSPDFR updates may refresh default XML |
| Profile support | Excellent |
| Uninstall | Restore previous XML; vanilla LSPDFR lists return. World traffic still uses vanilla models |
| Performance | Not measured; XML parse cost is negligible vs streaming |
| Known limitations | Does **not** install `.yft`/`.ytd`. Does **not** change world/ambient GTA police cars. Requires the add-on model to already be mounted by the game |
| Recommendation | **KEEP as a complementary Duty-only step**, never as a complete vehicle installer |

---

## 8. Replacement → add-on conversion (content strategy)

Desired transform:

```text
police3.yft + police3_hi.yft + police3.ytd
        → manager-owned DLC pack
        → game uses that content for the slot
```

### Feasibility

**Partial.** The files can be *packaged* as add-on DLC. They cannot be *mounted* on Enhanced without either:

1. a licence-clear overlay that registers `dlclist` / streams the pack, or
2. writing official encrypted `update.rpf` (**REJECTED**)

### Same-name vs new-name

- **Same model name (`police3`)** inside a later-loading DLC can override the vanilla slot for *all* game systems that request `police3`. That is the only path that replaces world traffic without editing base `vehicles.rpf`.
- **New model name** needs LSPDFR/UB XML remap for Duty spawns. Ambient GTA police stay vanilla.

### Metadata required

| Piece | Auto-derived from `.yft`/`.ytd`? | Notes |
| --- | --- | --- |
| Model name / slot | Yes, from filename | `police3` |
| Texture dictionary link | Usually yes if names match | `police3.ytd` |
| `_hi` model | Present or absent | Missing is a warning, not fatal |
| `vehicles.meta` | **No** | Layout, flags, cameras, extras, audio name |
| `handling.meta` | **No** | Physics; cannot invent safely |
| `carvariations.meta` | Partial | Liveries/sirens often need the pack’s file |
| `carcols.meta` | Partial | Only if the pack ships it |
| Vehicle layouts / extras | **No** | Mod-specific |
| `content.xml` / `setup2.xml` | Template-possible | DLC mount metadata |
| `dlclist.xml` entry | Template-possible | Still needs a writable overlay |

A replacement pack that ships metas can be wrapped. A “models only” pack cannot become a correct add-on without inventing handling/vehicles data.

### Recommendation

Document as the **preferred content format** for a later phase. Do not implement real Duty writes now.

---

## 9. First-party encrypted RPF backend

| Field | Value |
| --- | --- |
| Mechanism name | Native NG/AES RPF read/write |
| How it works | Decrypt TOC/entries, replace resources, rebuild, re-encrypt |
| GTA Enhanced support | Official archives are RPF7 + NG (Phase 3C smoke test) |
| Modifies original archives | Yes |
| Licence / keys | **No lawful distributable key source.** Keys live in the game binary. Extracting or copying them is **REJECTED** |
| Recommendation | **REJECTED.** Native encrypted archive writing is **not currently viable** for this product |

### What a lawful future backend would still need (assessment only)

- Complete Enhanced RPF7/NG format rules (TOC, names, resource flags, 512-byte sectors)
- A **legal** encryption API or key-provisioning channel from the rights holder (does not exist for third-party commercial tools)
- Compression (deflate / resource compression) with bounds
- TOC rebuild, alignment, and hash/integrity rules
- Full-archive backup + rollback
- Corruption detection without “repair” guesses
- Write tests on non-GTA fixtures only

Until a lawful key source exists, do not implement decryption.

---

## Comparison

| Mechanism | Enhanced | Official RPF untouched | Licence | RPH-safe evidence | Update resilience | Profiles | Decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Loose files | No | Yes | N/A | Yes (unused) | HIGH | Yes | REJECTED for vehicles |
| Official DLC only | Yes if registered | **No** | N/A | N/A | LOW | Poor | NOT SUFFICIENT |
| OpenIV.asi | Weak/no | Yes (copy) | Proprietary | Unproven | MEDIUM | Poor | REJECTED |
| OpenRPF | Community yes | Yes (copy) | GPL / no binaries | Unproven | MEDIUM | Poor | REJECTED_FOR_LICENSING |
| Simple Mods Loader | Claimed | Yes | LICENCE_UNCLEAR | Unknown | Unverified | Good if trusted | REJECTED |
| LML | Unproven | Yes | LICENCE_UNCLEAR | Unproven | Unverified | Good if trusted | NOT SELECTED |
| LSPDFR XML remap | Yes | Yes | OK | Yes | HIGH | Yes | Complementary only |
| Encrypted RPF write | Yes (unsafe) | No | No key source | N/A | LOW | Poor | REJECTED |

## Duty-only

Every acceptable future layer must write only under Duty. Online stays a clean Steam folder: no ASI, no RPH, no `mods\`, no LML. Strategy selection already rejects `ONLINE_TARGET_REJECTED`.

## Preferred architecture (not enabled)

```text
CLEAN DUTY GAME FILES          (official RPFs never written)
        +
LICENCE-CLEAR OVERLAY          (none available to ship today)
        +
MANAGER-OWNED DLC / LOOSE PACK
        +
OPTIONAL LSPDFR XML REMAP
        ↓
GAME LOADS MODDED VEHICLE
```

This would score better than native archive edits for rollback, updates, profiles, and Online/Duty separation — **after** licensing and RPH proof.

## Encrypted RPF blocker

1. Official Enhanced archives are NG/AES encrypted (Phase 3C).
2. There is no documented, redistributable key API.
3. Key extraction is forbidden.
4. Therefore native encrypted writes are not viable.

## Product limitation

**Vehicle intelligence supported. Real encrypted archive installation unsupported.**

Do not tell users to modify Online. Do not claim an OpenIV replacement.

Phase 3E should not start overlay installation unless a loader has a written commercial-redistribution licence **and** a measured Duty launch (RPH + LSPDFR + current ASI set) that stays green.
