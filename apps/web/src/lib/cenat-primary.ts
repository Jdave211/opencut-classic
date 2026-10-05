import type { MediaAsset } from "@/media/types";
import type { TProject } from "@/project/types";
import type { AudioElement, AudioTrack, ImageElement, OverlayTrack, TimelineElement, VideoElement, VideoTrack } from "@/timeline/types";
import { buildDefaultScene } from "@/timeline/scenes";
import { buildDefaultParamValues, getBuiltInElementParams } from "@/params/registry";
import { roundMediaTime } from "@/wasm/media-time-rounding";
import type { MediaTime } from "@/wasm";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import type { EditorCore } from "@/core";
import { renderCenatClip } from "@/lib/cenat-proxy";

const CHANNEL = "cenat-primary-editor";
const TICKS = 120_000;
const API = "http://127.0.0.1:3001";

type CenatClip = {
	id: string; assetId: string; label?: string; in: number; out: number;
	speed: number; brightness: number; volume: number;
	[key: string]: unknown;
};
type CenatItem = {
	id: string; assetId: string; in: number; out: number; speed: number; at: number;
	volume: number; x: number; y: number; width: number; height: number;
	opacity: number; fit: "cover" | "contain"; fadeIn: number; fadeOut: number;
	ducking: boolean; anchorClipId?: string; [key: string]: unknown;
};
type CenatTrack = { id: string; name: string; kind: "video" | "audio"; muted: boolean; items: CenatItem[]; gain?: number; locked?: boolean; [key: string]: unknown };
type CenatMarker = { id: string; at: number; end?: number; label: string; color: string; note?: string; [key: string]: unknown };
type CenatProject = { name: string; aspect: string; fps?: number; clips: CenatClip[]; tracks?: CenatTrack[]; markers?: CenatMarker[]; [key: string]: unknown };
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

export function getCenatPrimarySession(): CenatPrimarySession | null { return active; }

export class CenatPrimarySession {
	private revision: string;
	private original: CenatProject;
	private assets: CenatAsset[];
	private overlapIds: Set<string>;
	private saveQueue: Promise<void> = Promise.resolve();
	private previewing = new Set<string>();
	private unbindSelection: (() => void) | null = null;
	readonly id: string;

	private constructor({ id, project, assets, revision, overlapIds }: { id: string; project: CenatProject; assets: CenatAsset[]; revision: string; overlapIds: Set<string> }) {
		this.id = id;
		this.original = project;
		this.assets = assets;
		this.revision = revision;
		this.overlapIds = overlapIds;
	}

	static async open({ id, onProgress }: { id: string; onProgress?: (message: string) => void }): Promise<{ session: CenatPrimarySession; project: TProject; media: MediaAsset[] }> {
		const reply = await request({ projectId: id, type: "ready" });
		if (!reply.project || !reply.assets || !reply.revision) throw new Error("Cenat sent an incomplete project.");
		const canonicalProject = reply.project;
		const canonicalAssets = reply.assets;
		const catalogResponse = await fetch(`${API}/api/editor/catalog`);
		if (!catalogResponse.ok) throw new Error("Could not load Cenat transition timing.");
		const catalog: { transitions: { id: string; overlap: boolean }[] } = await catalogResponse.json();
		const overlapIds = new Set(catalog.transitions.filter((entry) => entry.overlap).map((entry) => entry.id));
		const session = new CenatPrimarySession({ id, project: canonicalProject, assets: canonicalAssets, revision: reply.revision, overlapIds });
		const referenced = new Set([
			...canonicalProject.clips.map((clip) => clip.assetId),
			...(canonicalProject.tracks || []).flatMap((track) => track.items.map((item) => item.assetId)),
		]);
		const sources = canonicalAssets.filter((asset) => referenced.has(asset.id));
		const media: MediaAsset[] = [];
		for (const [index, source] of sources.entries()) {
			onProgress?.(`Loading source media ${index + 1} of ${sources.length}…`);
			const response = await fetch(new URL(source.url, API));
			if (!response.ok) throw new Error(`Could not load ${source.name}.`);
			const blob = await response.blob();
			const file = new File([blob], source.name || `${source.id}.mp4`, { type: response.headers.get("Content-Type") || "video/mp4" });
			media.push({
				id: source.id, name: source.name, file, url: URL.createObjectURL(file),
				type: source.kind === "image" ? "image" : source.kind === "audio" ? "audio" : "video",
				width: source.width, height: source.height, duration: source.duration,
				hasAudio: source.hasAudio, fps: canonicalProject.fps || 30,
				thumbnailUrl: source.thumbnail ? new URL(source.thumbnail, API).href : undefined,
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
			const response = await fetch(new URL(source.url, API));
			if (!response.ok) throw new Error(`Could not load ${source.name}.`);
			const file = new File([await response.blob()], source.name, { type: response.headers.get("Content-Type") || "video/mp4" });
			media.push({
				id: source.id, name: source.name, file, url: URL.createObjectURL(file),
				type: source.kind === "image" ? "image" : source.kind === "audio" ? "audio" : "video",
				width: source.width, height: source.height, duration: source.duration,
				hasAudio: source.hasAudio, fps: this.original.fps || 30,
				thumbnailUrl: source.thumbnail ? new URL(source.thumbnail, API).href : undefined,
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
			(Array.isArray(source.overlays) && source.overlays.length > 0) ||
			(source.volume !== 0 && source.volume !== 1);
		if (!needsRender) return;
		this.previewing.add(elementId);
		try {
			const rendered = await renderCenatClip({ clip: source, fps: element.cenatEdit.fps, aspect: element.cenatEdit.aspect });
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
		const tracks: CenatTrack[] = [];
		for (const track of [...main.tracks.overlay, ...main.tracks.audio]) {
			if (track.type !== "video" && track.type !== "audio") {
				if (track.elements.length) throw new Error(`${track.name} contains an OpenCut layer that cannot be saved to Cenat. Add text through the clip's Text controls for now.`);
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
		const candidate = { ...this.original, name: project.metadata.name, clips,
			...(this.original.tracks || tracks.length ? { tracks } : {}),
			...(this.original.markers || markers.length ? { markers } : {}) };
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
		return new URL(job.url, API).href;
	}

	clear(): void { this.unbindSelection?.(); this.unbindSelection = null; if (active === this) active = null; }
}
