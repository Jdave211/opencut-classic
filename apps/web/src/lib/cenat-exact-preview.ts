function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value)) : {};
}

function hasAudioProcessing(value: unknown): boolean {
	const processing = record(value);
	return ["denoise", "normalize", "voice"].some((key) => processing[key] === true);
}

/** Composite edits whose live OpenCut drawing cannot match Cenat frame for frame. */
export function needsCenatCompositePreview(project: {
	clips: unknown[];
	tracks?: unknown[];
}): boolean {
	if (project.clips.some((raw) => {
		const clip = record(raw);
		const transition = record(clip.transition);
		return (typeof transition.type === "string" && transition.type !== "none") ||
			(Array.isArray(clip.overlays) && clip.overlays.length > 0) ||
			hasAudioProcessing(clip.audioProcessing);
	})) return true;
	return (project.tracks || []).some((rawTrack) => {
		const items = record(rawTrack).items;
		return Array.isArray(items) && items.some((raw: unknown) => {
			const item = record(raw);
			return !!item.mask || !!item.backgroundRemoval || record(item.chromaKey).enabled === true ||
				hasAudioProcessing(item.audioProcessing) ||
				item.blendMode === "hardlight" || item.blendMode === "softlight";
		});
	});
}
