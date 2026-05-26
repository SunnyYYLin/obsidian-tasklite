import { TFile, type App, type Plugin } from "obsidian";
import { reconcileExternalTaskCompletion } from "./externalReconcileCore";
import type { StatusRegistry } from "../model/status";
import type { TaskDocumentStore } from "../model/taskDocumentStore";
import type { TaskLiteSettings } from "../settings";

export class ExternalTaskReconciler {
	private readonly applying = new Set<string>();

	constructor(
		private readonly plugin: Plugin,
		private readonly app: App,
		private readonly registry: StatusRegistry,
		private readonly getSettings: () => TaskLiteSettings,
		private readonly documentStore: TaskDocumentStore,
	) {}

	register(): void {
		this.plugin.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					void this.reconcile(file);
				}
			}),
		);
	}

	private async reconcile(file: TFile): Promise<void> {
		if (this.applying.has(file.path)) return;

		const after = await this.app.vault.read(file);
		const before = this.documentStore.getCachedContent(file.path);
		await this.documentStore.replaceDocumentContent(file, after);
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
			await this.documentStore.replaceDocumentContent(file, reconciled);
		} finally {
			this.applying.delete(file.path);
		}
	}
}
