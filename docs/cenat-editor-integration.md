# Cenat projects in the primary editor

The Cenat home page opens the upgraded editor. Cenat remains the owner of the project document and source media. The editor builds native tracks from the current Cenat snapshot and saves edits back to the same Cenat project. Export uses Cenat's renderer so existing effects are retained.

| Capability | Primary editor | Render/export |
| --- | --- | --- |
| Main cuts, trims, order, speed, source audio | Native timeline and clip controls; changes save to Cenat | Exact Cenat render |
| Overlap transitions | Native clip timing follows Cenat's full transition catalog; transition controls are in the clip inspector and Transitions panel. The main canvas shows the exact composite render when it is ready and uses native clip drawing during edits. | Exact Cenat render |
| Video, image, and audio layers | Native separate tracks with position, scale, opacity, fit, blend, mute, volume, speed and trim | Exact Cenat render |
| Clip filters, effects, grading, curves, color regions, framing, motion and crop keyframes | Controls work on videos and still photos. The selected clip gets a rendered preview while editing; photos keep their image behavior on the timeline. | Exact Cenat render |
| Titles and captions | Native draggable Titles and Captions rows; the Text panel controls wording, font and placement, and Style controls motion, treatment, title design and timed words | Exact Cenat render; rendered clip previews omit baked text so it appears once |
| Stickers and graphics | Native selectable, draggable Stickers & graphics rows. The asset panel adds all five Cenat stickers and six graphic shapes; the Design inspector edits each one. The live canvas draws their shape, color and motion. | Exact Cenat render |
| Layer fades, ducking, masks, chroma key, background removal and audio processing | Layer controls save to the Cenat project. Composite video and processed audio play in the main canvas after the render finishes; the native canvas stays responsive while edits are in progress. | Exact Cenat render |
| Timeline markers | Native bookmarks; time, label, duration and color save to Cenat | Preserved in project |

The main canvas automatically renders the current Cenat timeline when it contains transitions, visual overlays, masks, keying, background removal or a blend that needs exact compositing. This preview uses the working timeline without saving it. The **Full preview** button opens a larger player for reviewing the entire edit.

Known limits:

- Native title, caption, sticker and graphic rows are independent timeline objects, but Cenat stores their render data in source-clip overlay fragments. Saving creates one fragment per intersected clip and groups them back into one draggable object on reopen. Source-timed caption words retain their timing and per-word styling; moving a timed caption to another source clip requires a new caption. Unsupported native text controls and effect tracks are rejected at save rather than discarded.
- Exact composite rendering takes time, especially for long projects. The native canvas remains available during the render and while a layer is being dragged; the exact video and processed audio replace it when ready. Reopening the same unchanged edit reuses its completed preview. Automatic single-clip previews render at 360p, with at most two in progress; a failed clip preview waits a minute before retrying unless that clip changes.
- This integration requires the local Cenat app and its `/api/editor/catalog` endpoint. Standalone projects remain available without Cenat.
- The published OpenCut WASM package still fails one existing storage migration test during initialization. Browser project editing, save and export were checked separately.

Validation used isolated copies of existing Cenat projects. A 21-clip project with music, an Ironman project with a graphic layer, an overlap-transition fixture, a portrait-image layer and a marker fixture were opened in the editor. Checks covered no-op reloads, layer movement and volume, fades, transition timing, color-region and graphic edits, and marker edits. A title spanning a cross dissolve saved as two fragments and reopened as one native title; a caption with seven timed words retained its exact word times and per-word styling after an edit. A three-second project rendered and played through Full preview. Current tests also cover unchanged photo and sticker round trips, sticker design and movement, adding a new photo, composite-preview detection, and rendering the unsaved working timeline. Live Cenat preview jobs completed for a treated quarter-second photo and a wipe transition. No original user project was modified during these checks.
