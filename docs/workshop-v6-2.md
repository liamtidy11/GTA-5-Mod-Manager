# Workshop / Mod Browser (V6.2)

Browse Mods is a Steam Workshop-style **discovery** page. It is not a second installer.

```text
SOURCE → PACKAGE → FINGERPRINT → SCAN → RECOGNITION → DEPENDENCIES
→ COMPATIBILITY → INSTALL SAFETY → PREVIEW → SNAPSHOT IF NEEDED
→ TRANSACTIONAL INSTALL
```

Every archive still goes through Smart Install. A source page is not a safety rating.

## Provider architecture

`src/services/workshop/providers/`

| Provider | Role |
| --- | --- |
| `localCatalogProvider` | Bundled catalog: list, search, details, official links |
| `lcpdfrProvider` | Optional authenticated API **architecture**. Direct download stays false |

Capabilities: `SEARCH`, `LIST`, `DETAILS`, `VERSION_CHECK`, `SCREENSHOTS`, `OPEN_SOURCE_PAGE`, `DIRECT_DOWNLOAD`.

`DIRECT_DOWNLOAD` defaults to false. Metadata access and file-download permission are separate. This app does not invent LCPDFR endpoints. Until LCPDFR documents third-party metadata routes, live list/search stay off even if a key is saved.

User-Agent (if a documented call is ever enabled): `GTA5ModManager/1.0 (personal; +https://github.com/liamtidy11/GTA-5-Mod-Manager)`

## Local catalog

`src/data/workshopCatalog.json` is discovery metadata only.

- Official `https` source URLs on an allow-list
- Enhanced field in the file is not compatibility truth
- Dependencies and Enhanced status on cards come from **local** knowledge / inventory / manifests
- Vehicle and EUP categories show that automatic Enhanced archive install is unsupported

## API configuration

Settings → Workshop → LCPDFR API key.

- Never enter an LCPDFR password
- Never ship a shared key
- The key is stored with Electron `safeStorage` under `userData/workshop/secrets.json`
- Settings never return the raw key
- Browse Mods works with no key (local catalog + official links)

Optional smoke: `npm run verify:workshop-api` (read-only capability check, no binary download, no invented endpoint).

## Official-page download flow

1. **Get Mod** opens the official source page
2. Optionally **Watch Downloads** remembers the expected mod
3. You download zip/rar/7z yourself
4. **Import Download** or the **Downloads inbox** asks to analyze
5. Smart Install preview / confirm still required

## Smart Install handoff

Handoff context:

```json
{
  "expectedCanonicalModId": "policing-redefined",
  "provider": "LCPDFR",
  "providerFileId": null,
  "sourceVersion": ""
}
```

Smart Install still identifies the package. A mismatch shows:

```text
DOWNLOAD DOES NOT MATCH SELECTED MOD
```

Weak / unknown recognition shows a warning. Nothing installs from that warning alone.

## Downloads inbox

Scans the configured download directory (default: your user Downloads folder).

States: `NEW`, `RECOGNIZED`, `UNKNOWN`, `INSTALLED`, `IGNORED`.

Never auto-installs. Never opens or runs archives or EXEs.

## Favorites and collections

Stored in `userData/workshop/library.json`. Collections are browser bookmarks, not Duty profiles.

## Offline / cache

Metadata cache: `userData/workshop/cache/` with TTL (Settings → cache retention).

If a provider is unavailable, Browse Mods still shows the local catalog, cache timestamp, installed state, and local knowledge. Duty launch never depends on workshop network access.

## Security

Do not:

- scrape login cookies or automate site login
- store website passwords
- run downloaded EXEs
- auto-open archives
- bypass Smart Install
- treat LCPDFR/GitHub as “safe to install”
- download binaries through an undocumented API

## Limitations

- No unattended direct binary downloading
- No one-click dependency installation
- No screenshot scraping
- Encrypted Enhanced vehicle/EUP archives stay recognized, not auto-installed
- Live LCPDFR search requires documented API access that this build does not assume
