import { test } from "bun:test";
import assert from "node:assert/strict";
import { needsCenatCompositePreview } from "../cenat-exact-preview";

test("simple clips keep the immediate native canvas", () => {
	assert.equal(needsCenatCompositePreview({ clips: [{}, {}], tracks: [] }), false);
});

test("transitions and visual overlays request exact composite frames", () => {
	assert.equal(needsCenatCompositePreview({ clips: [{ transition: { type: "wipe-left", duration: 0.5 } }] }), true);
	assert.equal(needsCenatCompositePreview({ clips: [{ overlays: [{ kind: "text" }] }] }), true);
});

test("masks, keying, and background removal request exact composite frames", () => {
	for (const item of [
		{ mask: { shape: "ellipse" } },
		{ chromaKey: { enabled: true } },
		{ backgroundRemoval: { background: "transparent" } },
	]) assert.equal(needsCenatCompositePreview({ clips: [{}], tracks: [{ items: [item] }] }), true);
});

test("processed audio requests exact composite playback", () => {
	assert.equal(needsCenatCompositePreview({ clips: [{ audioProcessing: { denoise: true } }] }), true);
	assert.equal(needsCenatCompositePreview({ clips: [{ audioProcessing: { normalize: false } }] }), false);
	assert.equal(needsCenatCompositePreview({ clips: [{}], tracks: [{ items: [{ audioProcessing: { voice: true } }] }] }), true);
});
