# Cenat projects in the OpenCut editor

The Cenat home page opens this fork as its primary editor. Cenat remains the owner of the project document and source media. The editor builds native OpenCut tracks from the current Cenat snapshot and saves edits back to the same Cenat project. Export uses Cenat's renderer so existing effects are retained.

| Capability | OpenCut editor today | Render/export |
| --- | --- | --- |
| Main cuts, trims, order, speed, source audio | Native timeline and clip controls; changes save to Cenat | Exact Cenat render |
| Overlap transitions | Native clip timing follows Cenat's transition catalog; transition controls are in the clip inspector | Exact Cenat render; live transition image may differ |
| Video, image, and audio layers | Native separate tracks with position, scale, opacity, fit, blend, mute, volume, speed and trim | Exact Cenat render |
| Clip filters, effects, grading, curves, color regions, framing, motion and crop keyframes | Cenat controls inside OpenCut's clip inspector; the edited clip is previewed as a rendered proxy | Exact Cenat render |
| Titles and captions | Native draggable Titles and Captions rows; the Text panel controls wording, font and placement, and the Cenat tab controls motion, treatment, title design and timed words | Exact Cenat render; rendered clip proxies omit baked text so it appears once |
| Stickers and graphics | Cenat controls inside OpenCut's clip inspector; the edited clip is previewed as a rendered proxy | Exact Cenat render |
| Layer fades, ducking, masks, chroma key, background removal and audio processing | Layer controls save to the Cenat project; fit, blend and visual fades appear in the live canvas | Exact Cenat render; masks, keying, removal and audio processing need a render preview for exact inspection |
| Timeline markers | Native bookmarks; time, label, duration and color save to Cenat | Preserved in project |

The **Exact preview** button in the editor header renders the current Cenat project and plays it in a dialog. Use it to inspect transitions, composite effects, text motion, masks, keys, grading and processed audio before export.

Known limits:

- OpenCut title and caption rows are independent timeline objects, but Cenat stores their render data in source-clip overlay fragments. The save bridge creates one fragment per intersected clip and groups them back into one draggable object on reopen. Source-timed caption words retain their timing and per-word styling; moving a timed caption to another source clip requires a new caption. Unsupported OpenCut text controls and effect tracks are rejected at save rather than discarded.
- The live OpenCut canvas does not reproduce every Cenat transition, mask, keyer or background-removal frame. The Cenat export is authoritative for those effects.
- This integration requires the local Cenat app and its `/api/editor/catalog` endpoint. The fork's standalone project mode remains available without Cenat.
- The published OpenCut WASM package still fails one existing storage migration test during initialization. Browser project editing, save and export were checked separately.

Validation used isolated copies of existing Cenat projects. A 21-clip project with music, an Ironman project with a graphic layer, an overlap-transition fixture, a portrait-image layer and a marker fixture were opened in the fork. Checks covered no-op reloads, layer movement and volume, fades, transition timing, color-region and graphic edits, and marker edits. A title spanning a cross dissolve saved as two fragments and reopened as one native title; a caption with seven timed words retained its exact word times and per-word styling after an edit. A three-second project rendered and played through Exact preview. No original user project was modified during these checks.
