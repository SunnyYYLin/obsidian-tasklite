import { Modal, Setting, type App } from "obsidian";
import { TASK_SYMBOLS } from "../model/format";
import { allStatuses, type StatusConfiguration, type StatusRegistry } from "../model/status";
import { fieldsFromTaskLine, taskLineFromFields, type TaskLineFields } from "../model/taskLineFields";
import type { TaskLiteSettings } from "../settings";

interface TaskLineModalOptions {
	app: App;
	title: string;
	initialLine: string;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
}

export function openTaskLineModal(options: TaskLineModalOptions): Promise<string> {
	return new Promise((resolve) => {
		new TaskLineModal(options, resolve).open();
	});
}

class TaskLineModal extends Modal {
	private readonly fields: TaskLineFields;
	private readonly isCreateMode: boolean;
	private resolved = false;

	constructor(
		private readonly options: TaskLineModalOptions,
		private readonly resolve: (line: string) => void,
	) {
		super(options.app);
		this.fields = fieldsFromTaskLine(options.initialLine, options.registry);
		this.isCreateMode = options.initialLine.trim() === "";
	}

	onOpen(): void {
		this.setTitle(this.options.title);
		this.contentEl.empty();
		this.contentEl.addClass("taskslite-modal");

		new Setting(this.contentEl).setName("Description").addTextArea((text) => {
			text.setValue(this.fields.description).setPlaceholder("Task description").onChange((value) => {
				this.fields.description = value;
			});
			text.inputEl.rows = 3;
			text.inputEl.addClass("taskslite-modal-description");
			window.setTimeout(() => text.inputEl.focus(), 0);
		});

		new Setting(this.contentEl).setName("Status").addDropdown((dropdown) => {
			for (const status of modalStatuses(this.options.settings, this.options.registry)) {
				dropdown.addOption(status.symbol, status.name);
			}
			dropdown.setValue(this.fields.statusSymbol).onChange((value) => {
				this.fields.statusSymbol = value;
			});
		});

		this.addDateSetting("Start date", "start");
		this.addDateSetting("Scheduled date", "scheduled");
		this.addDateSetting("Due date", "due");
		if (!this.isCreateMode) {
			this.addDateSetting("Created date", "created");
			this.addDateSetting("Done date", "done");
			this.addDateSetting("Cancelled date", "cancelled");
		}
		this.addRecurrenceSetting();
		this.addOnCompletionSetting();
		this.addPrioritySetting();
		this.addTextSetting("Task ID", "id", "id");
		this.addTextSetting("Depends on", "id1, id2", "dependsOn");
		this.addTextSetting("Block link", "^block-id", "blockLink");

		new Setting(this.contentEl)
			.addButton((button) =>
				button.setButtonText("Cancel").onClick(() => {
					this.finish("");
				}),
			)
			.addButton((button) =>
				button
					.setButtonText("Save")
					.setCta()
					.onClick(() => {
						this.finish(taskLineFromFields(this.fields, this.options.registry));
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		this.finish("");
	}

	private addDateSetting(name: string, key: "start" | "created" | "scheduled" | "due" | "done" | "cancelled"): void {
		new Setting(this.contentEl).setName(name).addText((text) => {
			text.inputEl.type = "date";
			text.setValue(this.fields[key]).onChange((value) => {
				this.fields[key] = value;
			});
		});
	}

	private addOnCompletionSetting(): void {
		new Setting(this.contentEl).setName("On completion").addDropdown((dropdown) => {
			const values = ["", "delete", "keep", "complete"];
			for (const value of values) {
				dropdown.addOption(value, value || "None");
			}
			if (this.fields.onCompletion && !values.includes(this.fields.onCompletion)) {
				dropdown.addOption(this.fields.onCompletion, this.fields.onCompletion);
			}
			dropdown.setValue(this.fields.onCompletion).onChange((value) => {
				this.fields.onCompletion = value;
			});
		});
	}

	private addRecurrenceSetting(): void {
		new Setting(this.contentEl).setName("Recurrence").addDropdown((dropdown) => {
			const values = [
				"",
				"every day",
				"every week",
				"every month",
				"every year",
				"every day when done",
				"every week when done",
				"every month when done",
				"every year when done",
			];
			for (const value of values) {
				dropdown.addOption(value, value || "None");
			}
			if (this.fields.recurrence && !values.includes(this.fields.recurrence)) {
				dropdown.addOption(this.fields.recurrence, this.fields.recurrence);
			}
			dropdown.setValue(this.fields.recurrence).onChange((value) => {
				this.fields.recurrence = value;
			});
		});
	}

	private addPrioritySetting(): void {
		new Setting(this.contentEl).setName("Priority").addDropdown((dropdown) => {
			dropdown.addOption("", "None");
			dropdown.addOption(TASK_SYMBOLS.priority.highest, "Highest");
			dropdown.addOption(TASK_SYMBOLS.priority.high, "High");
			dropdown.addOption(TASK_SYMBOLS.priority.medium, "Medium");
			dropdown.addOption(TASK_SYMBOLS.priority.low, "Low");
			dropdown.addOption(TASK_SYMBOLS.priority.lowest, "Lowest");
			if (this.fields.priority && !Object.values(TASK_SYMBOLS.priority).includes(this.fields.priority)) {
				dropdown.addOption(this.fields.priority, this.fields.priority);
			}
			dropdown.setValue(this.fields.priority).onChange((value) => {
				this.fields.priority = value;
			});
		});
	}

	private addTextSetting(name: string, placeholder: string, key: keyof Omit<TaskLineFields, "statusSymbol" | "description">): void {
		new Setting(this.contentEl).setName(name).addText((text) => {
			text.setValue(this.fields[key]).setPlaceholder(placeholder).onChange((value) => {
				this.fields[key] = value;
			});
		});
	}

	private finish(line: string): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolve(line);
		this.close();
	}
}

function modalStatuses(settings: TaskLiteSettings, registry: StatusRegistry): StatusConfiguration[] {
	const statuses = allStatuses(settings.statusSettings);
	if (statuses.some((status) => status.symbol === " ")) return statuses;
	return [registry.get(" "), ...statuses];
}
