# Cenat projects in the OpenCut editor

The Cenat home page opens this fork as its primary editor. Cenat remains the owner of the project document and source media. The editor builds native OpenCut tracks from the current Cenat snapshot and saves edits back to the same Cenat project. Export uses Cenat's renderer so existing effects are retained.

| Capability | OpenCut editor today | Render/export |
| --- | --- | --- |
| Main cuts, trims, order, speed, source audio | Native timeline and clip controls; changes save to Cenat | Exact Cenat render |
| Overlap transitions | Native clip timing follows Cenat's transition catalog; transition controls are in the clip inspector | Exact Cenat render; live transition image may differ |
| Video, image, and audio layers | Native separate tracks with position, scale, opacity, fit, blend, mute, volume, speed and trim | Exact Cenat render |
| Clip filters, effects, grading, curves, color regions, framing, motion and crop keyframes | Cenat controls inside OpenCut's clip inspector; the edited clip is previewed as a rendered proxy | Exact Cenat render |
| Clip titles, captions, stickers, graphics and text motion | Cenat controls inside OpenCut's clip inspector; the edited clip is previewed as a rendered proxy | Exact Cenat render |
| Layer fades, ducking, masks, chroma key, background removal and audio processing | Layer controls save to the Cenat project; fit, blend and visual fades appear in the live canvas | Exact Cenat render; masks, keying, removal and audio processing need a render preview for exact inspection |
| Timeline markers | Native bookmarks; time, label, duration and color save to Cenat | Preserved in project |

Known limits:

- Cenat titles and captions remain attached to their source clip. Native independent OpenCut text/effect tracks cannot yet be saved as Cenat edits. The editor rejects unsupported track content instead of silently dropping it.
- The live OpenCut canvas does not reproduce every Cenat transition, mask, keyer or background-removal frame. The Cenat export is authoritative for those effects.
- This integration requires the local Cenat app and its `/api/editor/catalog` endpoint. The fork's standalone project mode remains available without Cenat.
- The published OpenCut WASM package still fails one existing storage migration test during initialization. Browser project editing, save and export were checked separately.

Validation used isolated copies of existing Cenat projects. A 21-clip project with music, an Ironman project with a graphic layer, an overlap-transition fixture, a portrait-image layer and a marker fixture were opened in the fork. Checks covered no-op reloads, layer movement and volume, fades, transition timing, color-region and graphic edits, and marker edits. No original user project was modified during these checks.
