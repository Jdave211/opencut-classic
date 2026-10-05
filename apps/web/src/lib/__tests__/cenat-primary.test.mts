import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import type { TProject } from "@/project/types";
import type { ImageElement, StickerElement } from "@/timeline/types";

// The published WASM package cannot initialize in Bun tests. These mapper tests
// use the same tick constant without starting the compositor.
mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 120_000,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) => Math.round(seconds * 120_000),
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120_000,
	lastFrameTime: () => 0, parseTimecode: () => 0, roundToFrame: () => 0,
	snappedSeekTime: () => 0, formatTimecode: () => "",
}));

const [{ CenatPrimarySession }, { buildDefaultScene }, { buildDefaultParamValues, getBuiltInElementParams },
	{ roundMediaTime }] = await Promise.all([
	import("../cenat-primary"),
	import("@/timeline/scenes"),
	import("@/params/registry"),
	import("@/wasm/media-time-rounding"),
]);
const ticks = (seconds: number) => roundMediaTime({ time: seconds * 120_000 });
const originalOverlay = {
	id: "visual-1", kind: "sticker", sticker: "star",
	start: 0.5, end: 2.5, x: 0.5, y: 0.5, size: 0.15,
	color: "#ffffff", background: false,
};
const sourceClip = {
	id: "clip-1", assetId: "photo-1", label: "Photo",
	in: 0, out: 4, speed: 1, brightness: 1, volume: 0,
	overlays: [originalOverlay],
};
const original = { name: "Sticker test", aspect: "9:16", fps: 30, clips: [sourceClip] };
const assets = [{
	id: "photo-1", name: "photo.png", url: "/assets/photo.png", duration: 5,
	width: 1080, height: 1920, hasAudio: false, kind: "image",
}];

function fixture() {
	const scene = buildDefaultScene({ name: "Main scene", isMain: true });
	const image: ImageElement = {
		id: sourceClip.id, type: "image", mediaId: assets[0].id, name: "Photo",
		startTime: ticks(0), duration: ticks(4), trimStart: ticks(0), trimEnd: ticks(1),
		sourceDuration: ticks(5), params: buildDefaultParamValues(getBuiltInElementParams({ type: "image" })),
		cenatEdit: { clip: structuredClone(sourceClip), sourceMediaId: assets[0].id, proxyMediaId: assets[0].id, fps: 30, aspect: "9:16" },
	};
	const sticker: StickerElement = {
		id: `${sourceClip.id}:${originalOverlay.id}`, type: "sticker", name: "star sticker",
		stickerId: "shapes:star", intrinsicWidth: 1080, intrinsicHeight: 1920,
		startTime: ticks(0.5), duration: ticks(2), trimStart: ticks(0), trimEnd: ticks(0),
		params: buildDefaultParamValues(getBuiltInElementParams({ type: "sticker" })),
		cenatOverlays: [{ clipId: sourceClip.id, overlay: structuredClone(originalOverlay) }],
		cenatOverlaySourceRate: 1,
	};
	const project: TProject = {
		metadata: { id: "project-1", name: original.name, duration: ticks(4), createdAt: new Date(), updatedAt: new Date() },
		scenes: [{ ...scene, tracks: { ...scene.tracks, main: { ...scene.tracks.main, elements: [image] },
			overlay: [{ id: "cenat-graphic-0", type: "graphic", name: "Stickers & graphics", hidden: false,
				cenatGraphicLane: 0, elements: [sticker] }] } }],
		currentSceneId: scene.id,
		settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1080, height: 1920 },
			canvasSizeMode: "custom", lastCustomCanvasSize: null, originalCanvasSize: null,
			background: { type: "color", color: "#000000" } },
		version: 31,
	};
	const Session = CenatPrimarySession as unknown as new (args: {
		id: string; project: typeof original; assets: typeof assets; revision: string;
		overlapIds: Set<string>; fontIds: Set<string>;
	}) => CenatPrimarySession;
	const session = new Session({ id: "project-1", project: original, assets, revision: "1",
		overlapIds: new Set(), fontIds: new Set(["Arial"]) });
	return { session, project, sticker };
}

test("an unchanged photo and sticker round-trip without rewriting their project", () => {
	const { session, project } = fixture();
	assert.deepEqual(session.toCenatProject({ project }), original);
});

test("sticker design and timing edits become source-timed Cenat overlays", () => {
	const { session, project, sticker } = fixture();
	sticker.startTime = ticks(1);
	sticker.duration = ticks(1.5);
	sticker.cenatOverlayStyle = { kind: "graphic", graphic: "badge", label: "W",
		x: 0.45, y: 0.4, size: 0.2, color: "#2ea86b", animation: "pop" };
	const saved = session.toCenatProject({ project });
	const overlay = saved.clips[0].overlays?.[0] as Record<string, unknown>;
	assert.equal(overlay.kind, "graphic");
	assert.equal(overlay.graphic, "badge");
	assert.equal(overlay.label, "W");
	assert.equal(overlay.start, 1);
	assert.equal(overlay.end, 2.5);
	assert.equal(overlay.color, "#2ea86b");
	assert.equal(saved.textLanes?.graphic, 1);
});

test("canvas movement and scale export at the same visual position", () => {
	const { session, project, sticker } = fixture();
	sticker.params = { ...sticker.params,
		"transform.positionX": 108,
		"transform.positionY": -192,
		"transform.scaleX": 1.5,
		"transform.scaleY": 1.5,
	};
	const saved = session.toCenatProject({ project });
	const overlay = saved.clips[0].overlays?.[0] as Record<string, unknown>;
	assert.equal(overlay.x, 0.6);
	assert.equal(overlay.y, 0.4);
	assert.ok(Math.abs(Number(overlay.size) - 0.225) < 1e-10);
});

test("new main photos receive editable clip data before their first save", () => {
	const { session } = fixture();
	const bare: ImageElement = {
		id: "new-photo", type: "image", mediaId: "photo-1", name: "Another photo",
		startTime: ticks(4), duration: ticks(3), trimStart: ticks(0), trimEnd: ticks(2),
		sourceDuration: ticks(5), params: buildDefaultParamValues(getBuiltInElementParams({ type: "image" })),
	};
	const decorated = session.decorateNewMainElement({ element: bare, asset: {
		id: "photo-1", name: "photo.png", type: "image", hasAudio: false,
	} as Parameters<typeof session.decorateNewMainElement>[0]["asset"] });
	assert.equal(decorated.type, "image");
	if (decorated.type !== "image") throw new Error("Expected a photo.");
	assert.equal(decorated.cenatEdit?.clip.out, 3);
	assert.equal(decorated.cenatEdit?.sourceMediaId, "photo-1");
});

test("inline exact preview renders the working timeline without saving it", async () => {
	const { session, project } = fixture();
	const oldFetch = globalThis.fetch;
	const calls: string[] = [];
	const mockedSession = session as typeof session & { save: () => Promise<void> };
	const oldSave = mockedSession.save;
	mockedSession.save = async () => { throw new Error("Preview must not save the project."); };
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		calls.push(String(input));
		return new Response(JSON.stringify({ id: "preview-1", status: "complete",
			url: "/previews/preview-1/cenat-export.mp4" }),
			{ status: 200, headers: { "Content-Type": "application/json" } });
	}) as typeof fetch;
	try {
		const url = await session.preview({ project, persist: false });
		assert.equal(url, "/cenat/previews/preview-1/cenat-export.mp4");
		assert.deepEqual(calls, ["/cenat/api/preview"]);
	} finally {
		globalThis.fetch = oldFetch;
		mockedSession.save = oldSave;
	}
});
