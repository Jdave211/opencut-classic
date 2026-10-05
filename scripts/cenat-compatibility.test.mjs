import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { analyzeCenatProject } from "./cenat-compatibility.mjs";

const mediaRoot = mkdtempSync(path.join(tmpdir(), "cenat-compat-"));
mkdirSync(path.join(mediaRoot, "uploads"));
writeFileSync(path.join(mediaRoot, "uploads", "asset-1.mp4"), "video bytes");
afterAll(() => rmSync(mediaRoot, { recursive: true, force: true }));

const assets = [
	{
		id: "asset-1",
		name: "A video",
		url: "/uploads/asset-1.mp4",
		duration: 4,
		width: 1920,
		height: 1080,
	},
];
const project = {
	name: "A real edit",
	aspect: "source",
	fps: 30,
	clips: [
		{
			id: "clip-1",
			assetId: "asset-1",
			in: 0,
			out: 1.5,
			speed: 1,
			volume: 1,
			brightness: 1,
		},
		{
			id: "clip-2",
			assetId: "asset-1",
			in: 2,
			out: 4,
			speed: 1,
			volume: 0,
			brightness: 1,
		},
	],
};

test("reports a frame-aligned two-clip plan without writing a destination", () => {
	const report = analyzeCenatProject({
		source: project,
		assets,
		mediaRoot,
		sourceHash: "source-hash",
	});
	expect(report.status).toBe("ready");
	expect(report.media).toHaveLength(1);
	expect(
		report.clips.map((clip) => [
			clip.startTicks,
			clip.durationTicks,
			clip.sourceAudioEnabled,
		]),
	).toEqual([
		[0, 180_000, true],
		[180_000, 240_000, false],
	]);
	expect(report.totalDurationTicks).toBe(420_000);
});

test("blocks unsupported transitions and unknown clip fields", () => {
	const altered = structuredClone(project);
	altered.clips[1].transition = { type: "film-burn", duration: 0.5 };
	altered.clips[1].customShader = "unknown";
	const report = analyzeCenatProject({
		source: altered,
		assets,
		mediaRoot,
		sourceHash: "source-hash",
	});
	expect(report.status).toBe("blocked");
	expect(report.issues.map((item) => item.code)).toContain(
		"transition-unmapped",
	);
	expect(report.issues.map((item) => item.code)).toContain(
		"unknown-clip-field",
	);
});

test("keeps filters, grades, and timed titles editable through a clip proxy", () => {
	const altered = structuredClone(project);
	altered.clips[0].filter = "cinematic";
	altered.clips[0].brightness = 1.2;
	altered.clips[0].overlays = [{
		id: "title-1", kind: "text", text: "A title", start: 0, end: 1,
	}];
	const report = analyzeCenatProject({
		source: altered, assets, mediaRoot, sourceHash: "source-hash",
	});
	expect(report.status).toBe("ready");
	expect(report.clips[0].needsProxy).toBe(true);
	expect(report.clips[1].needsProxy).toBe(false);
	expect(report.clips[0].cenatEdit.clip).toEqual(altered.clips[0]);
});

test("blocks absent and unsafe media paths", () => {
	const missing = analyzeCenatProject({
		source: project,
		assets: [{ ...assets[0], url: "/uploads/missing.mp4" }],
		mediaRoot,
		sourceHash: "source-hash",
	});
	expect(missing.issues.map((item) => item.code)).toContain("missing-media");
	const unsafe = analyzeCenatProject({
		source: project,
		assets: [{ ...assets[0], url: "/uploads/../private.mp4" }],
		mediaRoot,
		sourceHash: "source-hash",
	});
	expect(unsafe.issues.map((item) => item.code)).toContain("unsafe-media-path");
});
