import { TFile, type App, type Plugin } from "obsidian";
import { reconcileExternalTaskCompletion } from "./externalReconcileCore";
import type { StatusRegistry } from "../model/status";
import type { TaskLiteSettings } from "../settings";

export class ExternalTaskReconciler {
	private readonly snapshots = new Map<string, string>();
	private readonly applying = new Set<string>();

	constructor(
		private readonly plugin: Plugin,
		private readonly app: App,
		private readonly registry: StatusRegistry,
		private readonly getSettings: () => TaskLiteSettings,
	) {}

	register(): void {
		this.plugin.app.workspace.onLayoutReady(() => {
			void this.seedSnapshots();
		});
		this.plugin.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					void this.reconcile(file);
				}
			}),
		);
	}

	private async seedSnapshots(): Promise<void> {
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!this.snapshots.has(file.path)) {
				this.snapshots.set(file.path, await this.app.vault.read(file));
			}
		}
	}

	private async reconcile(file: TFile): Promise<void> {
		if (this.applying.has(file.path)) return;

		const after = await this.app.vault.read(file);
		const before = this.snapshots.get(file.path);
		this.snapshots.set(file.path, after);
		if (!before || before === after) return;

		const reconciled = reconcileExternalTaskCompletion({
			before: before.split("\n"),
			after: after.split("\n"),
			registry: this.registry,
			settings: this.getSettings(),
		});
		if (!reconciled || reconciled === after) return;

		this.applying.add(file.path);
		try {
			await this.app.vault.modify(file, reconciled);
			this.snapshots.set(file.path, reconciled);
		} finally {
			this.applying.delete(file.path);
		}
	}
}
