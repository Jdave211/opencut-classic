import type { MediaAsset } from "@/media/types";
import type { TProject } from "@/project/types";
import type { VideoElement } from "@/timeline/types";
import { buildDefaultScene } from "@/timeline/scenes";
import { buildDefaultParamValues, getBuiltInElementParams } from "@/params/registry";
import { roundMediaTime } from "@/wasm/media-time-rounding";
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
type CenatProject = { name: string; aspect: string; fps?: number; clips: CenatClip[]; [key: string]: unknown };
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

export function getCenatPrimarySession(): CenatPrimarySession | null { return active; }

export class CenatPrimarySession {
	private revision: string;
	private original: CenatProject;
	private assets: CenatAsset[];
	private saveQueue: Promise<void> = Promise.resolve();
	private previewing = new Set<string>();
	private unbindSelection: (() => void) | null = null;
	readonly id: string;

	private constructor({ id, project, assets, revision }: { id: string; project: CenatProject; assets: CenatAsset[]; revision: string }) {
		this.id = id;
		this.original = project;
		this.assets = assets;
		this.revision = revision;
	}

	static async open({ id, onProgress }: { id: string; onProgress?: (message: string) => void }): Promise<{ session: CenatPrimarySession; project: TProject; media: MediaAsset[] }> {
		const reply = await request({ projectId: id, type: "ready" });
		if (!reply.project || !reply.assets || !reply.revision) throw new Error("Cenat sent an incomplete project.");
		const canonicalProject = reply.project;
		const canonicalAssets = reply.assets;
		const session = new CenatPrimarySession({ id, project: canonicalProject, assets: canonicalAssets, revision: reply.revision });
		const referenced = new Set(canonicalProject.clips.map((clip) => clip.assetId));
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
		let start = 0;
		const elements: VideoElement[] = canonicalProject.clips.map((clip) => {
			const source = sources.find((item) => item.id === clip.assetId);
			if (!source) throw new Error(`Source media for ${clip.id} is missing.`);
			const speed = clip.speed || 1;
			const duration = (clip.out - clip.in) / speed;
			const element: VideoElement = {
				id: clip.id, type: "video", mediaId: clip.assetId,
				name: clip.label || source.name,
				startTime: roundMediaTime({ time: start * TICKS }),
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
			start += duration;
			return element;
		});
		const canvasSize = aspectSize({ aspect: canonicalProject.aspect, first: sources[0] });
		const now = new Date();
		const project: TProject = {
			metadata: { id, name: canonicalProject.name, duration: roundMediaTime({ time: start * TICKS }), createdAt: now, updatedAt: now },
			scenes: [{ ...scene, tracks: { ...scene.tracks, main: { ...scene.tracks.main, elements } } }],
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
		if (main.tracks.overlay.some((track) => track.elements.length > 0) ||
			main.tracks.audio.some((track) => track.elements.length > 0) ||
			main.tracks.main.elements.some((element) => element.type !== "video"))
			throw new Error("This timeline contains an edit that Cenat cannot save yet. Remove it before leaving or exporting.");
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
			return { ...base, id: element.id, assetId: source.id, label: element.name, in: trimStart, out, speed };
		});
		return { ...this.original, name: project.metadata.name, clips };
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
