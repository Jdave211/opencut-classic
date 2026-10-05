// Cenat's primary editor uses the app's own /api and media routes. The
// standalone OpenCut route retains its /cenat proxy for old test projects.
export const CENAT_API_ORIGIN = typeof window !== "undefined" &&
	new URLSearchParams(window.location.search).get("direct") === "1" ? "" : "/cenat";
const MEDIA_CHUNK_BYTES = 8 * 1024 * 1024;
const MEDIA_ATTEMPTS = 3;

async function retryMediaRequest<T>(run: () => Promise<T>): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < MEDIA_ATTEMPTS; attempt++) {
		try { return await run(); }
		catch (error) {
			lastError = error;
			if (attempt + 1 < MEDIA_ATTEMPTS)
				await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
		}
	}
	throw lastError instanceof Error ? lastError : new Error("The media transfer stopped.");
}

type ExportJob = {
	id: string;
	status: string;
	progress?: number;
	error?: string;
	url?: string;
	duration?: number;
	width?: number;
	height?: number;
};

export async function copyLocalVideo({ url, knownBytes }: { url: string; knownBytes?: number }): Promise<Blob> {
	let bytes = knownBytes;
	let contentType = "video/mp4";
	if (!bytes) {
		const head = await retryMediaRequest(() => fetch(url, { method: "HEAD", signal: AbortSignal.timeout(30_000) }));
		if (!head.ok) throw new Error("The media file is unavailable.");
		bytes = Number(head.headers.get("Content-Length"));
		contentType = head.headers.get("Content-Type") || contentType;
	}
	if (!Number.isSafeInteger(bytes) || bytes <= 0)
		throw new Error("The media size could not be verified.");
	const parts: Blob[] = [];
	for (let start = 0; start < bytes; start += MEDIA_CHUNK_BYTES) {
		const end = Math.min(bytes - 1, start + MEDIA_CHUNK_BYTES - 1);
		const part = await retryMediaRequest(async () => {
			const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(30_000) });
			if (response.status !== 206 || response.headers.get("Content-Range") !== `bytes ${start}-${end}/${bytes}`)
				throw new Error("The media server did not return the requested part.");
			const chunk = await response.blob();
			if (chunk.size !== end - start + 1)
				throw new Error("A media part was incomplete.");
			return chunk;
		});
		parts.push(part);
	}
	return new Blob(parts, { type: contentType });
}

export async function renderCenatClip({
	clip,
	fps,
	aspect,
	preview = false,
	onProgress,
}: {
	clip: Record<string, unknown>;
	fps: number;
	aspect: string;
	preview?: boolean;
	onProgress?: (progress: number) => void;
}): Promise<{ blob: Blob; duration: number; width: number; height: number }> {
	let response: Response;
	try {
		response = await fetch(`${CENAT_API_ORIGIN}/api/${preview ? "preview" : "export"}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				project: { name: "OpenCut editable clip", aspect, fps, clips: [clip] },
				...(!preview ? { resolution: "720", requestId: `opencut-${crypto.randomUUID()}` } : {}),
			}),
		});
	} catch {
		throw new Error("Cenat's local render service is unavailable. Start Cenat before applying this edit.");
	}
	let job: ExportJob = await response.json();
	if (!response.ok) throw new Error(job.error || "Cenat could not render this clip.");
	while (job.status !== "complete") {
		if (job.status === "failed") throw new Error(job.error || "Cenat could not render this clip.");
		onProgress?.(job.progress ?? 0);
		await new Promise((resolve) => setTimeout(resolve, 1200));
		const status = await fetch(`${CENAT_API_ORIGIN}/api/export/${encodeURIComponent(job.id)}`);
		if (!status.ok) throw new Error("The clip render status could not be read.");
		job = await status.json();
	}
	if (!job.url?.startsWith(preview ? "/previews/" : "/exports/") || !Number.isFinite(job.duration) ||
		!Number.isFinite(job.width) || !Number.isFinite(job.height))
		throw new Error("The rendered clip is missing its video metadata.");
	const blob = await copyLocalVideo({ url: `${CENAT_API_ORIGIN}${job.url}` });
	return { blob, duration: job.duration!, width: job.width!, height: job.height! };
}

/** Take a representative frame from Cenat's exact clip render for still-photo previews. */
export async function renderCenatStill({ videoBlob }: { videoBlob: Blob }): Promise<Blob> {
	const url = URL.createObjectURL(videoBlob);
	const video = document.createElement("video");
	video.muted = true;
	video.preload = "auto";
	video.playsInline = true;
	try {
		await new Promise<void>((resolve, reject) => {
			video.onloadeddata = () => resolve();
			video.onerror = () => reject(new Error("The graded photo preview could not be decoded."));
			video.src = url;
			video.load();
		});
		if (!video.videoWidth || !video.videoHeight) throw new Error("The graded photo has no image frame.");
		const canvas = document.createElement("canvas");
		canvas.width = video.videoWidth;
		canvas.height = video.videoHeight;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("The graded photo could not be drawn.");
		context.drawImage(video, 0, 0, canvas.width, canvas.height);
		return await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("The graded photo could not be saved.")), "image/png"));
	} finally {
		video.removeAttribute("src");
		video.load();
		URL.revokeObjectURL(url);
	}
}
