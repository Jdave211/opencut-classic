# Cenat migration into the OpenCut Classic fork

> Historical pilot record. Cenat's home now opens this editor directly for existing and new projects. Compatibility reports and separate destination projects are no longer part of the normal editing flow. See [the current integration](cenat-editor-integration.md).

The initial pilot ran alongside the existing Cenat editor and used compatibility gates before importing a separate project. That pilot started from OpenCut Classic commit `cf5e79e919144200294fb9fed22a222592a0aeea`.

## Working baseline

- Classic starts locally with Bun 1.2.18 and its example environment file.
- A project can be created without Cenat services.
- `ridge.mp4` from Cenat's bundled sample media was imported, inserted on the main track, previewed, and selected for property editing.
- The production web build passes after pinning the root Next.js version and repairing several stale TypeScript call sites in the archived source.
- The legacy storage migration suite now passes: pure tick rounding was separated from WASM startup, so tests no longer initialize the compositor merely to check a saved value.
- Classic's own track/scene model, commands, snapping, selection, playback, and undo remain the editor's authority. We will not replace them with Cenat's timeline component.

## Home and menu ownership

Cenat's existing home, project menu, library, folders, account surface, and project creation flow remain the product entry point. Classic's `/projects` page is only a standalone fork test surface. The eventual product route will open a migrated project in Classic's editor from Cenat's existing home; this work must not replace Cenat's home with Classic's projects page.

In local development, Cenat at `localhost:5173` now lands on that home even when an older editor session was open. A blank timeline starts a fresh project in the fork at `localhost:3000/new`, and Exit project returns to Cenat home. Opening an existing Cenat project shows a compatibility stop first; the user can continue in the current editor or try a separate blank Classic project. This is a development bridge, not a completed account migration. The fork stores projects in the browser profile that opened it, so the pilot imported in Codex's browser does not appear automatically in Dia or Chrome. The Cenat source record is never overwritten by this navigation.

## First local project pilot

- A real five-clip Cenat project JSON from the local project review artifacts was analyzed before any Classic project was created. The report found five linked media files, no blockers, and explicit 30 fps and frame-rounding warnings.
- The report and pilot manifest are in `.cenat-migration/`, which is ignored by Git. Footage and project data remain local to the source and the browser's fork storage.
- All five media files were imported into a new Classic project. A guarded migration screen verifies the source JSON hash, report status, media byte sizes and metadata, then writes the planned timeline to that new project.
- The saved project was reopened: five clips were present in source order and the displayed duration was `00:15:36:22`, matching the report's 30 fps frame plan. Preview displayed real footage.
- This source is a project JSON artifact, not a full Cenat snapshot record. History, messages, and account ownership have not been migrated. Full export parity has not yet been checked.

To analyze another local project, run `bun scripts/cenat-compatibility.mjs --project <source.json> --assets <assets.json> --media-root <Cenat data directory> --out .cenat-migration/<report.json>`. A `blocked` report prevents the guarded import screen from applying it. Create a blank Classic project, import footage through its media panel, then open `/migrate/cenat/<destination-project-id>` and select the original JSON and its report. The importer refuses to replace a nonempty destination timeline.

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

The first project pilot covers clips, media, frame timing, save/reload, and preview. The next gate is an export comparison, followed by transitions, titles, grades, audio processing, and Jev edits. Each new capability must appear in the compatibility report before import and pass its own UI, save/reload, preview, and export checks.

## Repository boundaries

`/Users/davejaga/Desktop/startups/cenat` remains the working Cenat editor and home. This fork is at `/Users/davejaga/Desktop/startups/opencut-classic` on `codex/cenat-integration`. Media and project state in the local browser belong to the fork's own origin. The original Cenat account project and snapshot history remain unchanged.
