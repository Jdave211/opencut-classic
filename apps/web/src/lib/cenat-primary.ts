import type { MediaAsset } from "@/media/types";
import type { TProject } from "@/project/types";
import type { AudioElement, AudioTrack, ImageElement, OverlayTrack, TextElement, TextTrack, TimelineElement, VideoElement, VideoTrack } from "@/timeline/types";
import { buildDefaultScene } from "@/timeline/scenes";
import { buildDefaultParamValues, getBuiltInElementParams } from "@/params/registry";
import { roundMediaTime } from "@/wasm/media-time-rounding";
import type { MediaTime } from "@/wasm";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import type { EditorCore } from "@/core";
import { CENAT_API_ORIGIN, copyLocalVideo, renderCenatClip } from "@/lib/cenat-proxy";
import { FONT_SIZE_SCALE_REFERENCE } from "@/text/typography";

const CHANNEL = "cenat-primary-editor";
const TICKS = 120_000;
const API = CENAT_API_ORIGIN;
function cenatUrl(path: string): string {
	if (!path.startsWith("/")) throw new Error("Cenat returned an invalid media URL.");
	return `${API}${path}`;
}

type CenatClip = {
	id: string; assetId: string; label?: string; in: number; out: number;
	speed: number; brightness: number; volume: number;
	[key: string]: unknown;
};
type CenatOverlay = {
	id: string; kind: "text" | "subtitle" | "sticker" | "graphic";
	start: number; end: number; text?: string; x: number; y: number;
	size: number; color: string; background: boolean; lane?: number;
	openCutGroupId?: string; [key: string]: unknown;
};
type CenatItem = {
	id: string; assetId: string; in: number; out: number; speed: number; at: number;
	volume: number; x: number; y: number; width: number; height: number;
	opacity: number; fit: "cover" | "contain"; fadeIn: number; fadeOut: number;
	ducking: boolean; anchorClipId?: string; [key: string]: unknown;
};
type CenatTrack = { id: string; name: string; kind: "video" | "audio"; muted: boolean; items: CenatItem[]; gain?: number; locked?: boolean; [key: string]: unknown };
type CenatMarker = { id: string; at: number; end?: number; label: string; color: string; note?: string; [key: string]: unknown };
type CenatProject = { name: string; aspect: string; fps?: number; clips: CenatClip[]; tracks?: CenatTrack[]; markers?: CenatMarker[]; textLanes?: { title?: number; caption?: number; graphic?: number }; [key: string]: unknown };
type CenatAsset = {
	id: string; name: string; url: string; thumbnail?: string;
	duration: number; width: number; height: number; hasAudio: boolean; kind?: string;
};
type Reply = { channel: string; projectId: string; requestId: string; type: string; project?: CenatProject; assets?: CenatAsset[]; revision?: string; error?: string };

function isCenatClip(value: unknown): value is CenatClip {
	return !!value && typeof value === "object" &&
		"id" in value && typeof value.id === "string" &&
		"assetId" in value && typeof value.assetId === "string" &&
		"in" in value && typeof value.in === "number" &&
		"out" in value && typeof value.out === "number" &&
		"speed" in value && typeof value.speed === "number" &&
		"brightness" in value && typeof value.brightness === "number" &&
		"volume" in value && typeof value.volume === "number";
}
function isCenatOverlay(value: unknown): value is CenatOverlay {
	return !!value && typeof value === "object" &&
		"id" in value && typeof value.id === "string" &&
		"kind" in value && (value.kind === "text" || value.kind === "subtitle") &&
		"start" in value && typeof value.start === "number" &&
		"end" in value && typeof value.end === "number";
}
function isCenatItem(value: unknown): value is CenatItem {
	return !!value && typeof value === "object" &&
		"id" in value && typeof value.id === "string" &&
		"assetId" in value && typeof value.assetId === "string" &&
		"in" in value && typeof value.in === "number" &&
		"out" in value && typeof value.out === "number" &&
		"at" in value && typeof value.at === "number";
}
function isCenatMarker(value: unknown): value is CenatMarker {
	return !!value && typeof value === "object" &&
		"id" in value && typeof value.id === "string" &&
		"at" in value && typeof value.at === "number" &&
		"label" in value && typeof value.label === "string" &&
		"color" in value && typeof value.color === "string";
}

let active: CenatPrimarySession | null = null;

function parentOrigin(): string {
	const value = new URLSearchParams(window.location.search).get("parentOrigin");
	if (!value) throw new Error("Open this project from Cenat.");
	const origin = new URL(value);
	if (!["localhost", "127.0.0.1"].includes(origin.hostname)) throw new Error("Invalid Cenat origin.");
	return origin.origin;
}

function request({ projectId, type, data = {} }: { projectId: string; type: string; data?: object }): Promise<Reply> {
	const origin = parentOrigin();
	if (window.parent === window) throw new Error("Open this project from Cenat.");
	const requestId = crypto.randomUUID();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { window.removeEventListener("message", receive); reject(new Error("Cenat did not respond.")); }, 20_000);
		const receive = (event: MessageEvent) => {
			if (event.origin !== origin || event.source !== window.parent) return;
			const body: unknown = event.data;
			if (!body || typeof body !== "object" ||
				!("channel" in body) || body.channel !== CHANNEL ||
				!("requestId" in body) || body.requestId !== requestId ||
				!("projectId" in body) || body.projectId !== projectId) return;
			clearTimeout(timer);
			window.removeEventListener("message", receive);
			// Transport envelope and sender have been checked above.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			const reply = body as Reply;
			if (reply.type === "error") reject(new Error(reply.error || "Cenat could not save the project."));
			else resolve(reply);
		};
		window.addEventListener("message", receive);
		window.parent.postMessage({ channel: CHANNEL, projectId, requestId, type, ...data }, origin);
	});
}

function aspectSize({ aspect, first }: { aspect: string; first: CenatAsset | undefined }) {
	if (aspect === "9:16") return { width: 1080, height: 1920 };
	if (aspect === "1:1") return { width: 1080, height: 1080 };
	if (aspect === "source" && first) return { width: first.width, height: first.height };
	return { width: 1920, height: 1080 };
}

function seconds(time: number): number { return time / TICKS; }
function ticks(time: number): MediaTime { return roundMediaTime({ time: time * TICKS }); }
function clipStarts({ clips, overlapIds }: { clips: CenatClip[]; overlapIds: Set<string> }): Map<string, number> {
	const starts = new Map<string, number>();
	let position = 0;
	for (const [index, clip] of clips.entries()) {
		const previous = clips[index - 1];
		const transition = clip.transition;
		if (previous && transition && typeof transition === "object" &&
			"type" in transition && typeof transition.type === "string" &&
			"duration" in transition && typeof transition.duration === "number" &&
			overlapIds.has(transition.type)) {
			position -= Math.max(0, Math.min(transition.duration,
				(previous.out - previous.in) / (previous.speed || 1) / 2,
				(clip.out - clip.in) / (clip.speed || 1) / 2));
		}
		starts.set(clip.id, position);
		position += (clip.out - clip.in) / (clip.speed || 1);
	}
	return starts;
}
function itemStart({ item, starts }: { item: CenatItem; starts: Map<string, number> }): number {
	return item.at + (item.anchorClipId ? starts.get(item.anchorClipId) || 0 : 0);
}
function volumeDb(gain: number): number { return gain <= 0 ? -60 : 20 * Math.log10(gain); }
function volumeGain(db: number): number { return db <= -60 ? 0 : Math.pow(10, db / 20); }
function paramNumber({ element, key, fallback }: { element: TimelineElement; key: string; fallback: number }): number {
	const value = element.params[key];
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function cenatOverlays(clip: CenatClip): CenatOverlay[] {
	return Array.isArray(clip.overlays) ? clip.overlays.filter(isCenatOverlay) : [];
}
type CenatTimedWord = { text: string; start: number; end: number; [key: string]: unknown };
function cenatTimedWords(value: unknown): CenatTimedWord[] | null {
	if (!Array.isArray(value)) return null;
	const candidates: unknown[] = value;
	if (!candidates.every((word): word is CenatTimedWord => !!word && typeof word === "object" &&
		"text" in word && typeof word.text === "string" &&
		"start" in word && typeof word.start === "number" && Number.isFinite(word.start) &&
		"end" in word && typeof word.end === "number" && Number.isFinite(word.end))) return null;
	return candidates;
}
function textParams({ overlay, canvas }: { overlay: CenatOverlay; canvas: { width: number; height: number } }) {
	return {
		...buildDefaultParamValues(getBuiltInElementParams({ type: "text" })),
		content: overlay.text || "Text",
		fontFamily: typeof overlay.font === "string" ? overlay.font : "Arial",
		fontSize: overlay.size * FONT_SIZE_SCALE_REFERENCE,
		color: overlay.color,
		fontWeight: typeof overlay.weight === "number" && overlay.weight >= 600 ? "bold" : "normal",
		fontStyle: overlay.italic ? "italic" : "normal",
		"background.enabled": overlay.background,
		"transform.positionX": (overlay.x - 0.5) * canvas.width,
		"transform.positionY": (overlay.y - 0.5) * canvas.height,
		"transform.rotate": typeof overlay.rotation === "number" ? overlay.rotation : 0,
	};
}
function textLane({ kind, lane }: { kind: "text" | "subtitle"; lane: number }): TextTrack {
	return {
		id: `cenat-${kind}-${lane}`, type: "text",
		name: `${kind === "subtitle" ? "Captions" : "Titles"}${lane ? ` ${lane + 1}` : ""}`,
		hidden: false, elements: [], cenatTextKind: kind, cenatLane: lane,
	};
}
function textKind({ element, track }: { element: TextElement; track: TextTrack }): "text" | "subtitle" {
	return element.cenatTextKind || track.cenatTextKind || (track.name.toLowerCase().includes("caption") ? "subtitle" : "text");
}
const TEXT_PARAM_KEYS = ["content", "fontFamily", "fontSize", "color", "fontWeight", "fontStyle", "background.enabled",
	"transform.positionX", "transform.positionY", "transform.rotate"] as const;
function nativeTextMatches({ element, overlay, canvas }: { element: TextElement; overlay: CenatOverlay; canvas: { width: number; height: number } }): boolean {
	const expected = textParams({ overlay, canvas });
	return TEXT_PARAM_KEYS.every((key) => element.params[key] === expected[key]);
}

export function getCenatPrimarySession(): CenatPrimarySession | null { return active; }

export class CenatPrimarySession {
	private revision: string;
	private original: CenatProject;
	private assets: CenatAsset[];
	private overlapIds: Set<string>;
	private fontIds: Set<string>;
	private saveQueue: Promise<void> = Promise.resolve();
	private previewing = new Set<string>();
	private unbindSelection: (() => void) | null = null;
	readonly id: string;

	private constructor({ id, project, assets, revision, overlapIds, fontIds }: { id: string; project: CenatProject; assets: CenatAsset[]; revision: string; overlapIds: Set<string>; fontIds: Set<string> }) {
		this.id = id;
		this.original = project;
		this.assets = assets;
		this.revision = revision;
		this.overlapIds = overlapIds;
		this.fontIds = fontIds;
	}

	static async open({ id, onProgress }: { id: string; onProgress?: (message: string) => void }): Promise<{ session: CenatPrimarySession; project: TProject; media: MediaAsset[] }> {
		const reply = await request({ projectId: id, type: "ready" }).catch((error: unknown) => {
			throw new Error(`Cenat project handshake failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		});
		if (!reply.project || !reply.assets || !reply.revision) throw new Error("Cenat sent an incomplete project.");
		const canonicalProject = reply.project;
		const canonicalAssets = reply.assets;
		onProgress?.("Loading editing controls…");
		const catalogResponse = await fetch(`${API}/api/editor/catalog`).catch(() => {
			throw new Error("The Cenat editing controls could not be reached through this editor.");
		});
		if (!catalogResponse.ok) throw new Error("Could not load Cenat transition timing.");
		const catalog: { transitions: { id: string; overlap: boolean }[]; fonts: string[] } = await catalogResponse.json().catch(() => {
			throw new Error("The Cenat editing controls returned an incomplete response.");
		});
		const overlapIds = new Set(catalog.transitions.filter((entry) => entry.overlap).map((entry) => entry.id));
		const fontIds = new Set(catalog.fonts);
		const session = new CenatPrimarySession({ id, project: canonicalProject, assets: canonicalAssets, revision: reply.revision, overlapIds, fontIds });
		const referenced = new Set([
			...canonicalProject.clips.map((clip) => clip.assetId),
			...(canonicalProject.tracks || []).flatMap((track) => track.items.map((item) => item.assetId)),
		]);
		const sources = canonicalAssets.filter((asset) => referenced.has(asset.id));
		const media: MediaAsset[] = [];
		for (const [index, source] of sources.entries()) {
			onProgress?.(`Loading source media ${index + 1} of ${sources.length}…`);
			const blob = await copyLocalVideo({ url: cenatUrl(source.url) }).catch((error: unknown) => {
				throw new Error(`Could not load ${source.name}: ${error instanceof Error ? error.message : "The download stopped."}`);
			});
			const file = new File([blob], source.name || `${source.id}.mp4`, { type: blob.type });
			media.push({
				id: source.id, name: source.name, file, url: URL.createObjectURL(file),
				type: source.kind === "image" ? "image" : source.kind === "audio" ? "audio" : "video",
				width: source.width, height: source.height, duration: source.duration,
				hasAudio: source.hasAudio, fps: canonicalProject.fps || 30,
				thumbnailUrl: source.thumbnail ? cenatUrl(source.thumbnail) : undefined,
			});
		}
		const scene = buildDefaultScene({ name: "Main scene", isMain: true });
		const fps = canonicalProject.fps || 30;
		const starts = clipStarts({ clips: canonicalProject.clips, overlapIds });
		const elements: VideoElement[] = canonicalProject.clips.map((clip) => {
			const source = sources.find((item) => item.id === clip.assetId);
			if (!source) throw new Error(`Source media for ${clip.id} is missing.`);
			const speed = clip.speed || 1;
			const duration = (clip.out - clip.in) / speed;
			const element: VideoElement = {
				id: clip.id, type: "video", mediaId: clip.assetId,
				name: clip.label || source.name,
				startTime: ticks(starts.get(clip.id) || 0),
				duration: roundMediaTime({ time: duration * TICKS }),
				trimStart: roundMediaTime({ time: clip.in * TICKS }),
				trimEnd: roundMediaTime({ time: Math.max(0, source.duration - clip.out) * TICKS }),
				sourceDuration: roundMediaTime({ time: source.duration * TICKS }),
				isSourceAudioEnabled: clip.volume !== 0,
				...(speed !== 1 ? { retime: { rate: speed } } : {}),
				hidden: false,
				params: buildDefaultParamValues(getBuiltInElementParams({ type: "video" })),
				cenatEdit: { clip: structuredClone(clip), sourceMediaId: clip.assetId, proxyMediaId: clip.assetId, fps, aspect: canonicalProject.aspect },
			};
			return element;
		});
		const canvasSize = aspectSize({ aspect: canonicalProject.aspect, first: sources[0] });
		const end = Math.max(0, ...elements.map((element) => seconds(element.startTime + element.duration)));
		const overlay: OverlayTrack[] = [];
		const audio: AudioTrack[] = [];
		for (const track of canonicalProject.tracks || []) {
			if (track.kind === "audio") {
				const nativeTrack: AudioTrack = {
					id: track.id, name: track.name, type: "audio", muted: track.muted,
					cenatTrack: structuredClone(track), elements: [],
				};
				for (const item of track.items) {
					const source = sources.find((candidate) => candidate.id === item.assetId);
					if (!source) throw new Error(`Source media for ${item.id} is missing.`);
					const element: AudioElement = {
						id: item.id, type: "audio", sourceType: "upload", mediaId: item.assetId,
						name: source.name, startTime: ticks(itemStart({ item, starts })),
						duration: ticks((item.out - item.in) / (item.speed || 1)),
						trimStart: ticks(item.in), trimEnd: ticks(Math.max(0, source.duration - item.out)),
						sourceDuration: ticks(source.duration),
						...(item.speed !== 1 ? { retime: { rate: item.speed } } : {}),
						params: { ...buildDefaultParamValues(getBuiltInElementParams({ type: "audio" })), volume: volumeDb(item.volume * (track.gain ?? 1)) },
						cenatItem: structuredClone(item),
					};
					nativeTrack.elements.push(element);
				}
				audio.push(nativeTrack);
				continue;
			}
			const nativeTrack: VideoTrack = {
				id: track.id, name: track.name, type: "video", muted: track.muted,
				hidden: track.muted, cenatTrack: structuredClone(track), elements: [],
			};
			for (const item of track.items) {
				const source = sources.find((candidate) => candidate.id === item.assetId);
				if (!source) throw new Error(`Source media for ${item.id} is missing.`);
				const sourceScale = Math.min(canvasSize.width / source.width, canvasSize.height / source.height);
				const params = {
					...buildDefaultParamValues(getBuiltInElementParams({ type: source.kind === "image" ? "image" : "video" })),
					"transform.positionX": (item.x - 0.5) * canvasSize.width,
					"transform.positionY": (item.y - 0.5) * canvasSize.height,
					"transform.scaleX": item.width * canvasSize.width / (source.width * sourceScale),
					"transform.scaleY": item.height * canvasSize.height / (source.height * sourceScale),
					opacity: item.opacity,
					...(source.kind === "image" ? {} : { volume: volumeDb(item.volume) }),
				};
				const base = {
					id: item.id, mediaId: item.assetId, name: source.name,
					startTime: ticks(itemStart({ item, starts })), duration: ticks((item.out - item.in) / (item.speed || 1)),
					trimStart: ticks(item.in), trimEnd: ticks(Math.max(0, source.duration - item.out)),
					sourceDuration: ticks(source.duration), hidden: false, params,
					cenatItem: structuredClone(item),
				};
				if (source.kind === "image") nativeTrack.elements.push({ ...base, type: "image" } satisfies ImageElement);
				else nativeTrack.elements.push({ ...base, type: "video", isSourceAudioEnabled: item.volume > 0,
					...(item.speed !== 1 ? { retime: { rate: item.speed } } : {}) } satisfies VideoElement);
			}
			overlay.push(nativeTrack);
		}
		const textGroups = new Map<string, { kind: "text" | "subtitle"; lane: number; start: number; end: number; parts: { clipId: string; overlay: CenatOverlay }[] }>();
		for (const clip of canonicalProject.clips) {
			const clipStart = starts.get(clip.id) || 0;
			for (const text of cenatOverlays(clip)) {
				if (text.kind !== "text" && text.kind !== "subtitle") continue;
				const from = Math.max(clip.in, text.start);
				const to = Math.min(clip.out, text.end);
				if (to <= from) continue;
				const start = clipStart + (from - clip.in) / (clip.speed || 1);
				const finish = clipStart + (to - clip.in) / (clip.speed || 1);
				const groupId = text.openCutGroupId || `${clip.id}:${text.id}`;
				const group = textGroups.get(groupId);
				if (group) {
					group.start = Math.min(group.start, start);
					group.end = Math.max(group.end, finish);
					group.parts.push({ clipId: clip.id, overlay: structuredClone(text) });
				} else textGroups.set(groupId, { kind: text.kind, lane: text.lane || 0,
					start, end: finish, parts: [{ clipId: clip.id, overlay: structuredClone(text) }] });
			}
		}
		const textTracks = new Map<string, TextTrack>();
		for (const kind of ["text", "subtitle"] as const) {
			const maxLane = Math.max(0,
				kind === "text" ? (canonicalProject.textLanes?.title || 0) - 1
					: (canonicalProject.textLanes?.caption || 0) - 1,
				...Array.from(textGroups.values()).filter((group) => group.kind === kind).map((group) => group.lane));
			for (let lane = 0; lane <= maxLane; lane++) {
				const track = textLane({ kind, lane });
				textTracks.set(`${kind}:${lane}`, track);
				overlay.push(track);
			}
		}
		for (const [id, group] of textGroups) {
			const base = group.parts[0].overlay;
			const track = textTracks.get(`${group.kind}:${group.lane}`);
			if (!track) continue;
			track.elements.push({
				id, type: "text", name: group.kind === "subtitle" ? "Caption" : "Title",
				startTime: ticks(group.start), duration: ticks(group.end - group.start),
				trimStart: ticks(0), trimEnd: ticks(0),
				params: textParams({ overlay: base, canvas: canvasSize }),
				cenatTextKind: group.kind, cenatOverlays: group.parts,
			});
		}
		const now = new Date();
		const project: TProject = {
			metadata: { id, name: canonicalProject.name, duration: ticks(end), createdAt: now, updatedAt: now },
			scenes: [{ ...scene,
				bookmarks: (canonicalProject.markers || []).map((marker) => ({
					time: ticks(marker.at), note: marker.label, color: marker.color,
					...(marker.end !== undefined ? { duration: ticks(marker.end - marker.at) } : {}),
					cenatMarker: structuredClone(marker),
				})),
				tracks: { ...scene.tracks, main: { ...scene.tracks.main, elements }, overlay, audio } }],
			currentSceneId: scene.id,
			settings: { fps: { numerator: fps, denominator: 1 }, canvasSize, canvasSizeMode: "custom", lastCustomCanvasSize: null, originalCanvasSize: null, background: { type: "color", color: "#000000" } },
			version: CURRENT_PROJECT_VERSION,
		};
		active = session;
		return { session, project, media };
	}

	getSourceProject(): CenatProject { return this.original; }

	async importFiles({ files, onProgress }: { files: File[]; onProgress?: (progress: number) => void }): Promise<MediaAsset[]> {
		const form = new FormData();
		for (const file of files) form.append("files", file);
		form.append("projectId", this.id);
		form.append("requestId", `opencut-import-${crypto.randomUUID()}`);
		const started = await fetch(`${API}/api/upload`, { method: "POST", body: form });
		let job: { id: string; status: string; progress?: { completed?: number; total?: number }; error?: string; result?: CenatAsset[] } = await started.json();
		if (!started.ok) throw new Error(job.error || "Could not import media.");
		while (job.status !== "complete") {
			if (job.status === "failed" || job.status === "cancelled") throw new Error(job.error || "Media import failed.");
			const { completed = 0, total = files.length } = job.progress || {};
			onProgress?.(total > 0 ? Math.round(completed / total * 100) : 0);
			await new Promise((resolve) => setTimeout(resolve, 1200));
			const response = await fetch(`${API}/api/import/${encodeURIComponent(job.id)}`);
			if (!response.ok) throw new Error("Media import status is unavailable.");
			job = await response.json();
		}
		if (!Array.isArray(job.result)) throw new Error("The imported media is missing.");
		const media: MediaAsset[] = [];
		for (const source of job.result) {
			const blob = await copyLocalVideo({ url: cenatUrl(source.url) });
			const file = new File([blob], source.name, { type: blob.type });
			media.push({
				id: source.id, name: source.name, file, url: URL.createObjectURL(file),
				type: source.kind === "image" ? "image" : source.kind === "audio" ? "audio" : "video",
				width: source.width, height: source.height, duration: source.duration,
				hasAudio: source.hasAudio, fps: this.original.fps || 30,
				thumbnailUrl: source.thumbnail ? cenatUrl(source.thumbnail) : undefined,
			});
		}
		this.assets.push(...job.result.filter((asset) => !this.assets.some((known) => known.id === asset.id)));
		onProgress?.(100);
		return media;
	}

	bindPreview({ editor }: { editor: EditorCore }): void {
		const selected = () => {
			const elementId = editor.selection.getSelectedElements()[0]?.elementId;
			if (elementId) void this.prepareClipPreview({ editor, elementId });
		};
		this.unbindSelection = editor.selection.subscribe(selected);
		const first = editor.scenes.getActiveSceneOrNull()?.tracks.main.elements[0];
		if (first) void this.prepareClipPreview({ editor, elementId: first.id });
	}

	private async prepareClipPreview({ editor, elementId }: { editor: EditorCore; elementId: string }): Promise<void> {
		if (this.previewing.has(elementId)) return;
		const scene = editor.scenes.getActiveSceneOrNull();
		if (!scene) return;
		const element = scene?.tracks.main.elements.find((item) => item.id === elementId);
		if (element?.type !== "video" || !element.cenatEdit || element.mediaId !== element.cenatEdit.sourceMediaId) return;
			const source: unknown = element.cenatEdit.clip;
			if (!isCenatClip(source)) return;
		const graded = Object.entries({ brightness: 1, contrast: 1, saturation: 1, temperature: 0, tint: 0, shadows: 0, highlights: 0, hue: 0, clarity: 0, vignette: 0, glow: 0, lensBlur: 0 })
			.some(([key, fallback]) => source[key] !== undefined && source[key] !== fallback);
		const needsRender = graded ||
			(typeof source.filter === "string" && source.filter !== "none") ||
			(typeof source.effect === "string" && source.effect !== "none") ||
			(typeof source.animation === "string" && source.animation !== "none") ||
			(source.volume !== 0 && source.volume !== 1);
		if (!needsRender) return;
		this.previewing.add(elementId);
		try {
			const rendered = await renderCenatClip({ clip: { ...source, overlays: undefined }, fps: element.cenatEdit.fps, aspect: element.cenatEdit.aspect });
			const current = editor.scenes.getActiveSceneOrNull()?.tracks.main.elements.find((item) => item.id === elementId);
			if (current?.type !== "video" || !current.cenatEdit || current.mediaId !== current.cenatEdit.sourceMediaId ||
				JSON.stringify(current.cenatEdit.clip) !== JSON.stringify(source)) return;
			const file = new File([rendered.blob], `preview-${elementId}.mp4`, { type: "video/mp4" });
			const asset: MediaAsset = { id: crypto.randomUUID(), name: file.name, type: "video", file,
				url: URL.createObjectURL(file), duration: rendered.duration, width: rendered.width, height: rendered.height,
				hasAudio: source.volume !== 0, ephemeral: true,
				thumbnailUrl: editor.media.getAssets().find((item) => item.id === current.cenatEdit?.sourceMediaId)?.thumbnailUrl };
			editor.media.setAssets({ assets: [...editor.media.getAssets(), asset] });
			const sourceDuration = roundMediaTime({ time: rendered.duration * TICKS });
			if (sourceDuration < current.duration - TICKS / element.cenatEdit.fps) return;
			editor.timeline.updateElements({ updates: [{ trackId: scene.tracks.main.id, elementId,
				patch: { mediaId: asset.id, sourceDuration, trimStart: roundMediaTime({ time: 0 }),
					trimEnd: roundMediaTime({ time: Math.max(0, sourceDuration - current.duration) }),
					retime: undefined, cenatEdit: { ...current.cenatEdit, proxyMediaId: asset.id } } }] });
		} catch (error) {
			console.error("Cenat clip preview could not be prepared:", error);
		} finally { this.previewing.delete(elementId); }
	}

	private mapTextTracks({ project, clips, main }: { project: TProject; clips: CenatClip[]; main: TProject["scenes"][number] }): {
		clips: CenatClip[]; textLanes?: CenatProject["textLanes"];
	} {
		const rows = main.tracks.overlay.filter((track): track is TextTrack => track.type === "text");
		const entries = rows.flatMap((track) => track.elements.map((element) => ({ track, element })));
		const oldGroups = new Set(this.original.clips.flatMap((clip) => cenatOverlays(clip)
			.filter((overlay) => overlay.kind === "text" || overlay.kind === "subtitle")
			.map((overlay) => overlay.openCutGroupId || `${clip.id}:${overlay.id}`)));
		const originalStarts = clipStarts({ clips: this.original.clips, overlapIds: this.overlapIds });
		const frame = 1 / (this.original.fps || 30);
		const canvas = project.settings.canvasSize;
		const mainUnchanged = JSON.stringify(clips.map(({ id, in: sourceIn, out, speed }) => [id, sourceIn, out, speed])) ===
			JSON.stringify(this.original.clips.map(({ id, in: sourceIn, out, speed }) => [id, sourceIn, out, speed]));
		const same = mainUnchanged && oldGroups.size === entries.length && entries.every(({ track, element }) => {
			const parts = element.cenatOverlays;
			const first = parts?.[0]?.overlay;
			if (!parts?.length || !isCenatOverlay(first) || element.cenatTextStyle || track.hidden || textKind({ element, track }) !== first.kind ||
				track.cenatLane !== (first.lane || 0)) return false;
			let start = Number.POSITIVE_INFINITY;
			let end = Number.NEGATIVE_INFINITY;
			for (const part of parts) {
				const clip = this.original.clips.find((entry) => entry.id === part.clipId);
				const original = clip && cenatOverlays(clip).find((overlay) => overlay.id === part.overlay.id);
				if (!clip || !original || JSON.stringify(original) !== JSON.stringify(part.overlay)) return false;
				const clipStart = originalStarts.get(clip.id) || 0;
				start = Math.min(start, clipStart + (Math.max(clip.in, original.start) - clip.in) / (clip.speed || 1));
				end = Math.max(end, clipStart + (Math.min(clip.out, original.end) - clip.in) / (clip.speed || 1));
			}
			return Math.abs(seconds(element.startTime) - start) < frame / 4 &&
				Math.abs(seconds(element.duration) - (end - start)) < frame / 4 &&
				nativeTextMatches({ element, overlay: first, canvas });
		});
		if (same) return { clips };
		const copy = clips.map((clip) => ({ ...clip,
			overlays: Array.isArray(clip.overlays) ? clip.overlays.filter((overlay) => !isCenatOverlay(overlay)) : [] }));
		const starts = clipStarts({ clips: copy, overlapIds: this.overlapIds });
		const endOfStory = Math.max(0, ...copy.map((clip) => (starts.get(clip.id) || 0) + (clip.out - clip.in) / (clip.speed || 1)));
		const laneCounts = { title: 0, caption: 0, graphic: this.original.textLanes?.graphic || 0 };
		for (const [index, row] of rows.entries()) {
			const kind = row.cenatTextKind || row.elements[0]?.cenatTextKind || (row.name.toLowerCase().includes("caption") ? "subtitle" : "text");
			const lane = row.cenatLane ?? rows.slice(0, index).filter((candidate) =>
				(candidate.cenatTextKind || candidate.elements[0]?.cenatTextKind ||
					(candidate.name.toLowerCase().includes("caption") ? "subtitle" : "text")) === kind).length;
			if (lane > 63) throw new Error("Cenat supports up to 64 title or caption rows.");
			laneCounts[kind === "subtitle" ? "caption" : "title"] = Math.max(laneCounts[kind === "subtitle" ? "caption" : "title"], lane + 1);
			if (row.hidden && row.elements.length) throw new Error(`Show the ${row.name} row before saving it to Cenat.`);
			for (const element of row.elements) {
				if (element.hidden) throw new Error(`Show ${element.name} before saving it to Cenat.`);
				if (element.effects?.length || element.animations) throw new Error(`Use the Cenat text style tab for ${element.name}'s effects and motion.`);
				const defaults = buildDefaultParamValues(getBuiltInElementParams({ type: "text" }));
				const unsupported = ["textAlign", "textDecoration", "letterSpacing", "lineHeight", "background.color",
					"background.cornerRadius", "background.paddingX", "background.paddingY", "background.offsetX", "background.offsetY",
					"transform.scaleX", "transform.scaleY", "opacity", "blendMode"];
				if (unsupported.some((key) => element.params[key] !== defaults[key]))
					throw new Error(`Some text controls on ${element.name} have no render equivalent yet. Use the text style tab.`);
				const elementKind = textKind({ element, track: row });
				const base = element.cenatOverlays?.[0]?.overlay;
				const original = isCenatOverlay(base) ? base : undefined;
				const content = String(element.params.content ?? "").trim();
				if (!content || content.length > 240) throw new Error("Use 1–240 characters per title or caption.");
				const font = String(element.params.fontFamily || "Arial");
				if (!this.fontIds.has(font)) throw new Error(`The font ${font} is not available in Cenat. Choose a Cenat font before saving.`);
				const start = seconds(element.startTime);
				const end = start + seconds(element.duration);
				if (start < -frame / 4 || end > endOfStory + frame / 4 || end <= start)
					throw new Error(`${element.name} must fit within the video sequence.`);
				let segments = 0;
				for (const clip of copy) {
					const clipStart = starts.get(clip.id) || 0;
					const clipEnd = clipStart + (clip.out - clip.in) / (clip.speed || 1);
					const from = Math.max(start, clipStart);
					const to = Math.min(end, clipEnd);
					if (to - from < frame / 2) continue;
					const sourceStart = clip.in + (from - clipStart) * (clip.speed || 1);
					const sourceEnd = clip.in + (to - clipStart) * (clip.speed || 1);
					const oldPart = element.cenatOverlays?.find((part) => part.clipId === clip.id)?.overlay;
					if (original?.words && !oldPart) throw new Error(`${element.name} has source-timed words. Keep it on its original source clip, or add a new caption for the other clip.`);
					const basis = { ...(isCenatOverlay(oldPart) ? oldPart : original || {}), ...(element.cenatTextStyle || {}) };
					const expected = isCenatOverlay(basis) ? textParams({ overlay: basis, canvas }) : null;
					const changed = (key: typeof TEXT_PARAM_KEYS[number]) => !expected || element.params[key] !== expected[key];
					const x = Math.max(0.05, Math.min(0.95, 0.5 + paramNumber({ element, key: "transform.positionX", fallback: 0 }) / canvas.width));
					const y = Math.max(0.05, Math.min(0.95, 0.5 + paramNumber({ element, key: "transform.positionY", fallback: 0 }) / canvas.height));
					const size = Math.max(0.025, Math.min(0.3, paramNumber({ element, key: "fontSize", fallback: 5 }) / FONT_SIZE_SCALE_REFERENCE));
					const next: CenatOverlay = {
						...basis, id: isCenatOverlay(oldPart) ? oldPart.id : `${element.id}:${clip.id}`,
						kind: elementKind, text: content, start: sourceStart, end: sourceEnd,
						x: changed("transform.positionX") ? x : Number(basis.x ?? x),
						y: changed("transform.positionY") ? y : Number(basis.y ?? y),
						size: changed("fontSize") ? size : Number(basis.size ?? size),
						color: changed("color") ? String(element.params.color || "#ffffff") : String(basis.color ?? "#ffffff"),
						background: changed("background.enabled") ? Boolean(element.params["background.enabled"]) : Boolean(basis.background),
						font: changed("fontFamily") ? font : basis.font,
						weight: changed("fontWeight") ? (element.params.fontWeight === "bold" ? 700 : 400) : basis.weight,
						italic: changed("fontStyle") ? element.params.fontStyle === "italic" : basis.italic,
						rotation: changed("transform.rotate") ? paramNumber({ element, key: "transform.rotate", fallback: 0 }) : basis.rotation,
						lane, openCutGroupId: element.id,
					};
					if (elementKind === "subtitle") {
						const words = cenatTimedWords(next.words);
						if (next.words !== undefined && (!words || !words.length))
							throw new Error(`${element.name} has invalid word timing. Edit the timed words in the Cenat text tab.`);
						if (words) {
							const originalWords = cenatTimedWords(oldPart?.words);
							const wordText = words.map((word) => word.text.trim()).join(" ");
							if (content !== wordText && content !== oldPart?.text)
								throw new Error(`${element.name} has timed words. Edit their wording in the Cenat text tab so the caption stays synchronized.`);
							const unchangedWords = originalWords && JSON.stringify(words) === JSON.stringify(originalWords);
							const shift = unchangedWords && isCenatOverlay(oldPart) ? sourceStart - oldPart.start : 0;
							const shifted = words.map((word) => ({ ...word, start: word.start + shift, end: word.end + shift }));
							if (shifted.some((word) => !word.text.trim() || word.end <= word.start ||
								word.start < sourceStart - frame / 4 || word.end > sourceEnd + frame / 4))
								throw new Error(`${element.name}'s timed words no longer fit inside the caption. Adjust the caption length or word times.`);
							next.words = shifted;
						}
					}
					if (elementKind === "subtitle") {
						delete next.remotionTemplate;
						delete next.titleMotion;
						delete next.titleCurve;
						delete next.titleContext;
						delete next.depth;
					} else delete next.words;
					const target = copy.find((candidate) => candidate.id === clip.id);
					if (!target) throw new Error("A title lost its source clip.");
					const overlays = Array.isArray(target.overlays) ? target.overlays : [];
					overlays.push(next);
					target.overlays = overlays;
					segments++;
				}
				if (!segments) throw new Error(`${element.name} does not overlap a video clip.`);
			}
		}
		return { clips: copy, textLanes: laneCounts };
	}

	toCenatProject({ project }: { project: TProject }): CenatProject {
		const main = project.scenes.find((scene) => scene.isMain);
		if (!main) throw new Error("The main timeline is missing.");
		if (main.tracks.main.elements.some((element) => element.type !== "video"))
			throw new Error("The main Cenat sequence only accepts video clips. Place titles and other media on a track above it.");
		const elements = main.tracks.main.elements.filter((element): element is VideoElement => element.type === "video").slice().sort((a, b) => a.startTime - b.startTime);
		const clips = elements.map((element) => {
			if (!element.cenatEdit) {
				const source = this.assets.find((asset) => asset.id === element.mediaId);
				if (!source || source.kind === "audio") throw new Error(`The clip ${element.name} needs to be imported into Cenat first.`);
				return {
					id: element.id, assetId: source.id, label: element.name,
					in: element.trimStart / TICKS,
					out: source.duration - element.trimEnd / TICKS,
					speed: element.retime?.rate || 1,
					brightness: 1, volume: element.isSourceAudioEnabled ? 1 : 0,
				};
			}
			const base: unknown = element.cenatEdit.clip;
			if (!isCenatClip(base)) throw new Error(`The clip ${element.name} has invalid Cenat edit data.`);
			const usesRenderedClip = element.mediaId === element.cenatEdit.proxyMediaId && element.cenatEdit.proxyMediaId !== element.cenatEdit.sourceMediaId;
			const speed = usesRenderedClip ? (base.speed || 1) * (element.retime?.rate || 1) : element.retime?.rate || base.speed || 1;
			const source = this.assets.find((asset) => asset.id === element.cenatEdit?.sourceMediaId);
			if (!source) throw new Error(`Source media for ${element.name} is unavailable.`);
			const rawIn = usesRenderedClip ? base.in + element.trimStart / TICKS * (base.speed || 1) : element.trimStart / TICKS;
			const rawOut = usesRenderedClip ? base.out - element.trimEnd / TICKS * (base.speed || 1) : source.duration - element.trimEnd / TICKS;
			const frame = 1 / (this.original.fps || 30);
			const trimStart = Math.abs(rawIn - base.in) < frame / 4 ? base.in : rawIn;
			const out = Math.abs(rawOut - base.out) < frame / 4 ? base.out : rawOut;
			return { ...base, id: element.id, assetId: source.id,
				...(element.name !== (base.label || source.name) ? { label: element.name } : {}),
				in: trimStart, out, speed };
		});
		const starts = clipStarts({ clips, overlapIds: this.overlapIds });
		const canvas = project.settings.canvasSize;
		const text = this.mapTextTracks({ project, clips, main });
		const tracks: CenatTrack[] = [];
		for (const track of [...main.tracks.overlay, ...main.tracks.audio]) {
			if (track.type === "text") continue;
			if (track.type !== "video" && track.type !== "audio") {
				if (track.elements.length) throw new Error(`${track.name} contains a layer that cannot be saved. Add text through the clip's Text controls for now.`);
				continue;
			}
			const oldTrack = this.original.tracks?.find((candidate) => candidate.id === track.id);
			const kind = track.type === "audio" ? "audio" : "video";
			const items: CenatItem[] = [];
			for (const element of track.elements) {
				if (kind === "audio" && (element.type !== "audio" || element.sourceType !== "upload"))
					throw new Error(`Import ${element.name} into Cenat before saving this audio track.`);
				if (kind === "video" && element.type !== "video" && element.type !== "image")
					throw new Error(`${element.name} cannot be saved on a Cenat video track.`);
				const mediaId = "mediaId" in element ? element.mediaId : null;
				const source = this.assets.find((candidate) => candidate.id === mediaId);
				if (!source) throw new Error(`Source media for ${element.name} is unavailable.`);
				const oldItem = oldTrack?.items.find((candidate) => candidate.id === element.id);
				const speed = "retime" in element ? element.retime?.rate || 1 : oldItem?.speed || 1;
				const start = seconds(element.startTime);
				const sourceIn = seconds(element.trimStart);
				const sourceOut = source.kind === "image"
					? sourceIn + seconds(element.duration) * speed
					: source.duration - seconds(element.trimEnd);
				const inPoint = oldItem && Math.abs(sourceIn - oldItem.in) < 1 / (this.original.fps || 30) / 4 ? oldItem.in : sourceIn;
				const unchangedDuration = oldItem &&
					Math.abs(sourceIn - oldItem.in) < 1 / (this.original.fps || 30) / 4 &&
					Math.abs(seconds(element.duration) - (oldItem.out - oldItem.in) / (oldItem.speed || 1)) < 1 / (this.original.fps || 30) / 4;
				const outPoint = oldItem && (unchangedDuration || Math.abs(sourceOut - oldItem.out) < 1 / (this.original.fps || 30) / 4) ? oldItem.out : sourceOut;
				const anchorStart = oldItem?.anchorClipId ? starts.get(oldItem.anchorClipId) : undefined;
				const keepAnchor = anchorStart !== undefined && oldItem !== undefined &&
					Math.abs(start - (anchorStart + oldItem.at)) < 1 / (this.original.fps || 30) / 4;
				const at = keepAnchor ? start - anchorStart : start;
				const editedItem = element.cenatItem;
				const base: CenatItem = isCenatItem(editedItem)
					? structuredClone(editedItem) : oldItem ? structuredClone(oldItem) : {
					id: element.id, assetId: source.id, in: inPoint, out: outPoint, speed,
					at, volume: 1, x: 0, y: 0, width: 1, height: 1, opacity: 1,
					fit: "contain", fadeIn: 0, fadeOut: 0, ducking: false,
				};
				base.assetId = source.id;
				base.in = inPoint;
				base.out = outPoint;
				base.speed = speed;
				base.at = at;
				if (!keepAnchor) delete base.anchorClipId;
				if (kind === "audio") {
					const expected = volumeDb((oldItem?.volume ?? 1) * (oldTrack?.gain ?? 1));
					const actual = paramNumber({ element, key: "volume", fallback: 0 });
					if (!oldItem || Math.abs(actual - expected) > 0.001)
						base.volume = Math.min(2, volumeGain(actual) / (oldTrack?.gain || 1));
				} else {
					const naturalScale = Math.min(canvas.width / source.width, canvas.height / source.height);
					const x = paramNumber({ element, key: "transform.positionX", fallback: 0 });
					const y = paramNumber({ element, key: "transform.positionY", fallback: 0 });
					const scaleX = paramNumber({ element, key: "transform.scaleX", fallback: 1 });
					const scaleY = paramNumber({ element, key: "transform.scaleY", fallback: 1 });
					const width = Math.max(0.05, Math.min(1, scaleX * source.width * naturalScale / canvas.width));
					const height = Math.max(0.05, Math.min(1, scaleY * source.height * naturalScale / canvas.height));
					const boxX = Math.max(0, Math.min(1, 0.5 + x / canvas.width));
					const boxY = Math.max(0, Math.min(1, 0.5 + y / canvas.height));
					if (!oldItem || Math.abs(boxX - oldItem.x) > 1e-4 || Math.abs(boxY - oldItem.y) > 1e-4 ||
						Math.abs(width - oldItem.width) > 1e-4 || Math.abs(height - oldItem.height) > 1e-4) {
						base.x = boxX; base.y = boxY; base.width = width; base.height = height;
					}
					const opacity = paramNumber({ element, key: "opacity", fallback: 1 });
					if (!oldItem || Math.abs(opacity - oldItem.opacity) > 1e-4) base.opacity = opacity;
					if (element.type === "video") {
						const actual = paramNumber({ element, key: "volume", fallback: 0 });
						if (!oldItem || Math.abs(actual - volumeDb(oldItem.volume)) > 0.001)
							base.volume = element.isSourceAudioEnabled === false ? 0 : Math.min(2, volumeGain(actual));
					}
				}
				items.push(base);
			}
			tracks.push({ ...(oldTrack || {}), id: track.id, name: track.name, kind,
				muted: track.type === "audio" ? track.muted : track.muted || track.hidden, items });
		}
		const originalOrder = new Map((this.original.tracks || []).map((track, index) => [track.id, index]));
		tracks.sort((a, b) => (originalOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (originalOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER));
		const unclaimedMarkers = [...(this.original.markers || [])];
		const markers: CenatMarker[] = main.bookmarks.map((bookmark) => {
			const original = isCenatMarker(bookmark.cenatMarker) ? bookmark.cenatMarker
				: unclaimedMarkers.find((candidate) => ticks(candidate.at) === bookmark.time &&
					candidate.label === bookmark.note && candidate.color === bookmark.color)
					|| (unclaimedMarkers.length === 1 && main.bookmarks.length === 1 ? unclaimedMarkers[0] : undefined);
			if (original) {
				const index = unclaimedMarkers.findIndex((candidate) => candidate.id === original.id);
				if (index >= 0) unclaimedMarkers.splice(index, 1);
			}
			if (original && ticks(original.at) === bookmark.time && bookmark.note === original.label &&
				bookmark.color === original.color &&
				(bookmark.duration ?? 0) === (original.end === undefined ? 0 : ticks(original.end - original.at)))
				return structuredClone(original);
			const at = seconds(bookmark.time);
			return { ...(original || {}), id: original?.id || crypto.randomUUID(), at,
				label: bookmark.note || original?.label || "Marker", color: bookmark.color || original?.color || "#f5c542",
				...(bookmark.duration !== undefined ? { end: at + seconds(bookmark.duration) } : { end: undefined }) };
		});
		const candidate = { ...this.original, name: project.metadata.name, clips: text.clips,
			...(this.original.tracks || tracks.length ? { tracks } : {}),
			...(this.original.markers || markers.length ? { markers } : {}),
			...(text.textLanes ? { textLanes: text.textLanes } : {}) };
		return JSON.stringify(candidate) === JSON.stringify(this.original) ? this.original : candidate;
	}

	async save({ project }: { project: TProject }): Promise<void> {
		const canonical = this.toCenatProject({ project });
		if (JSON.stringify(canonical) === JSON.stringify(this.original)) return;
		const previous = this.saveQueue;
		const next = previous.catch(() => {}).then(async () => {
			if (JSON.stringify(canonical) === JSON.stringify(this.original)) return;
			const reply = await request({ projectId: this.id, type: "save", data: { revision: this.revision, project: canonical } });
			if (!reply.revision) throw new Error("Cenat did not confirm the save.");
			this.revision = reply.revision;
			this.original = canonical;
		});
		this.saveQueue = next;
		await next;
	}

	async exit(): Promise<void> {
		await this.saveQueue;
		await request({ projectId: this.id, type: "exit" });
	}

	async export({ project, resolution, onProgress }: {
		project: TProject;
		resolution: "720" | "1080" | "2160";
		onProgress?: (value: number) => void;
	}): Promise<string> {
		await this.save({ project });
		const canonical = this.toCenatProject({ project });
		const started = await fetch(`${API}/api/export`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ project: canonical, resolution, format: "mp4-h264", requestId: `opencut-${crypto.randomUUID()}` }),
		});
		let job: { id: string; status: string; progress?: number; error?: string; url?: string } = await started.json();
		if (!started.ok) throw new Error(job.error || "Could not start export.");
		while (job.status !== "complete") {
			if (job.status === "failed") throw new Error(job.error || "Export failed.");
			onProgress?.(job.progress || 0);
			await new Promise((resolve) => setTimeout(resolve, 1200));
			const response = await fetch(`${API}/api/export/${encodeURIComponent(job.id)}`);
			if (!response.ok) throw new Error("Export status is unavailable.");
			job = await response.json();
		}
		if (!job.url?.startsWith("/exports/")) throw new Error("The export is missing its video file.");
		onProgress?.(100);
		return cenatUrl(job.url);
	}

	async preview({ project, onProgress }: {
		project: TProject;
		onProgress?: (value: number) => void;
	}): Promise<string> {
		await this.save({ project });
		const started = await fetch(`${API}/api/preview`, {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ project: this.toCenatProject({ project }) }),
		});
		let job: { id: string; status: string; progress?: number; error?: string; url?: string } = await started.json();
		if (!started.ok) throw new Error(job.error || "Could not start the exact preview.");
		while (job.status !== "complete") {
			if (job.status === "failed") throw new Error(job.error || "The exact preview failed.");
			onProgress?.(job.progress || 0);
			await new Promise((resolve) => setTimeout(resolve, 1200));
			const response = await fetch(`${API}/api/export/${encodeURIComponent(job.id)}`);
			if (!response.ok) throw new Error("The exact preview status is unavailable.");
			job = await response.json();
		}
		if (!job.url?.startsWith("/previews/")) throw new Error("The exact preview is missing its video file.");
		onProgress?.(100);
		return cenatUrl(job.url);
	}

	clear(): void { this.unbindSelection?.(); this.unbindSelection = null; if (active === this) active = null; }
}
