import type { EditorCore } from "@/core";
import { toast } from "sonner";

type SaveManagerOptions = {
	debounceMs?: number;
};

export class SaveManager {
	private debounceMs: number;
	private isPaused = false;
	private isSaving = false;
	private lastSaveFailed = false;
	private saveSettled: Promise<void> | null = null;
	private settleSave: (() => void) | null = null;
	private hasPendingSave = false;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private unsubscribeHandlers: Array<() => void> = [];

	constructor({
		editor,
		debounceMs = 800,
	}: {
		editor: EditorCore;
	} & SaveManagerOptions) {
		this.editor = editor;
		this.debounceMs = debounceMs;
	}

	private editor: EditorCore;

	start(): void {
		if (this.unsubscribeHandlers.length > 0) return;

		this.unsubscribeHandlers = [
			this.editor.scenes.subscribe(() => {
				this.markDirty();
			}),
			this.editor.timeline.subscribe(() => {
				this.markDirty();
			}),
		];
	}

	stop(): void {
		for (const unsubscribe of this.unsubscribeHandlers) {
			unsubscribe();
		}
		this.unsubscribeHandlers = [];
		this.clearTimer();
	}

	pause(): void {
		this.isPaused = true;
	}

	resume(): void {
		this.isPaused = false;
		if (this.hasPendingSave) {
			this.queueSave();
		}
	}

	markDirty({ force = false }: { force?: boolean } = {}): void {
		if (this.isPaused && !force) return;
		this.hasPendingSave = true;
		this.queueSave();
	}

	async flush(): Promise<void> {
		this.hasPendingSave = true;
		await this.saveNow();
	}

	getIsDirty(): boolean {
		return this.hasPendingSave || this.isSaving;
	}

	private queueSave(): void {
		if (this.isSaving) return;
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
		}
		this.saveTimer = setTimeout(() => {
			void this.saveNow();
		}, this.debounceMs);
	}

	private async saveNow(): Promise<void> {
		if (this.isSaving) {
			await this.saveSettled;
			if (this.hasPendingSave && !this.lastSaveFailed) await this.saveNow();
			return;
		}
		if (!this.hasPendingSave) return;

		const activeProject = this.editor.project.getActive();
		if (!activeProject) return;
		if (this.editor.project.getIsLoading()) return;
		if (this.editor.project.getMigrationState().isMigrating) return;

		this.isSaving = true;
		this.lastSaveFailed = false;
		this.saveSettled = new Promise<void>((resolve) => { this.settleSave = resolve; });
		this.hasPendingSave = false;
		this.clearTimer();

		let failed = false;
		try {
			await this.editor.project.saveCurrentProject();
		} catch (error) {
			failed = true;
			this.lastSaveFailed = true;
			this.hasPendingSave = true;
			toast.error("Project changes were not saved", {
				description: error instanceof Error ? error.message : "Try again before leaving the editor.",
			});
		} finally {
			this.isSaving = false;
			this.settleSave?.();
			this.settleSave = null;
			this.saveSettled = null;
			if (this.hasPendingSave && !failed) {
				this.queueSave();
			}
		}
	}

	private clearTimer(): void {
		if (!this.saveTimer) return;
		clearTimeout(this.saveTimer);
		this.saveTimer = null;
	}
}
