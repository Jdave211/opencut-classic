# Cenat migration into the OpenCut Classic fork

This fork runs alongside the existing Cenat editor. The existing editor and its saved projects remain available until the fork passes the gates below. The fork starts from OpenCut Classic commit `cf5e79e919144200294fb9fed22a222592a0aeea`.

## Working baseline

- Classic starts locally with Bun 1.2.18 and its example environment file.
- A project can be created without Cenat services.
- `ridge.mp4` from Cenat's bundled sample media was imported, inserted on the main track, previewed, and selected for property editing.
- The production web build passes after pinning the root Next.js version and repairing several stale TypeScript call sites in the archived source.
- The keybinding and storage migration test run passed 102 tests. One storage migration test still fails because Bun 1.2.18 cannot initialize the published `opencut-wasm` package in that test process (`wasm.__wbindgen_start is not a function`). This must be resolved before treating storage migration tests as a release gate.
- Classic's own track/scene model, commands, snapping, selection, playback, and undo remain the editor's authority. We will not replace them with Cenat's timeline component.

## Capability map

| Capability                    | Cenat source                                           | Classic base                                                    | Integration gate                                                                  |
| ----------------------------- | ------------------------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Clips, trims, tracks, speed   | `src/types.ts`, `shared/sequence.mjs`                  | `timeline/types.ts`, `core/managers/timeline-manager.ts`        | Import a saved Cenat project and preserve timing to a frame.                      |
| Media files and search        | `src/components/AssetLibrary.tsx`, media services      | Media manager, IndexedDB metadata, OPFS files                   | Relink every imported asset; report missing media before creating a fork project. |
| Transitions                   | `Clip.transition`, `shared/catalog.mjs`, FFmpeg export | Assets panel says “coming soon”; no timeline transition model   | Add a timeline transition model, editable controls, matching preview and export.  |
| Titles, captions, motion text | `Clip.overlays`, text lanes, motion templates          | Text tracks and text elements                                   | Preserve layout, fonts, timing, animation, and export frames.                     |
| Color grading                 | `Clip` grade fields, `shared/grade-model.mjs`          | Effects and property params; Adjustment view says “coming soon” | Map every supported control and compare preview with export.                      |
| Audio mix and cleanup         | Clip volume/fades, track mix, processing               | Audio tracks, volume, retime                                    | Preserve gains/fades and implement processing or flag it as unsupported.          |
| Jev edits                     | `server/edit-plan.mjs`, `shared/edit-intents.mjs`      | Command manager with undo/redo                                  | Translate one AI plan into native commands and undo it as one edit.               |
| Preview and export            | Browser preview, `server/render.mjs` FFmpeg            | Rust/WASM compositor and browser export                         | Render the same frame through both paths and compare visibly.                     |
| Saved projects and history    | `shared/projects.mjs` snapshots                        | Project manager, IndexedDB, OPFS, command history               | Import to a new project ID; retain source record and recovery path.               |

## Migration rules

1. A project converter must produce a compatibility report before it writes anything. Unknown fields, missing media, unsupported effects, and timing conversions are explicit blockers or warnings.
2. Imported projects receive new fork IDs. The Cenat source record is never overwritten or deleted by import.
3. Use OpenCut's integer media ticks and rational frame rate internally. Convert Cenat's seconds at the boundary and test 23.976, 29.97, and 30 fps frame alignment.
4. User edits and Jev edits go through OpenCut commands so selection, undo, redo, save, and preview stay synchronized.
5. A feature is migrated only when it works in the UI, survives save/reload, previews correctly, and exports correctly. A visible control alone does not count.
6. Keep the existing Cenat editor as the fallback until representative old projects pass the same review in the fork.

## First end-to-end slice

Import one existing Cenat project with two video clips and linked media. Trim and move a clip in Classic, save/reload, apply one transition, add one title and one grade, issue one Jev edit, undo it, then export. Compare duration, frame boundaries, titles, color, and sound against the existing Cenat render. Any unsupported field must appear in the compatibility report before import.

## Repository boundaries

`/Users/davejaga/Desktop/startups/cenat` remains the working Cenat editor. This fork is at `/Users/davejaga/Desktop/startups/opencut-classic` on `codex/cenat-integration`. Media and project state in the local browser belong to the fork's own origin; no Cenat project data has been migrated yet.
