import { Modal, Setting, SuggestModal, type App, type TextComponent } from "obsidian";
import { TASK_SYMBOLS } from "../model/format";
import { allStatuses, type StatusConfiguration, type StatusRegistry } from "../model/status";
import { fieldsFromTaskLine, taskLineFromFields, type TaskLineFields } from "../model/taskLineFields";
import type { TaskLiteSettings } from "../settings";
import { t } from "../i18n";

interface TaskLineModalOptions {
	app: App;
	title: string;
	initialLine: string;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
	targetFile?: TaskLineModalTargetFileOptions;
	parentTask?: TaskLineModalParentTaskOptions;
}

interface TaskLineModalTargetFileOptions {
	basePath: string;
	defaultValue: string;
}

interface TaskLineModalParentTaskOptions {
	options: Array<{
		label: string;
		path: string;
		lineNumber: number;
	}>;
}

export interface TaskLineModalResult {
	line: string;
	targetPath?: string;
	parentLineNumber?: number;
}

export function openTaskLineModal(options: TaskLineModalOptions): Promise<string> {
	return new Promise((resolve) => {
		new TaskLineModal(options, (result) => resolve(result.line)).open();
	});
}

export function openTaskLineModalWithTarget(options: TaskLineModalOptions & {targetFile: TaskLineModalTargetFileOptions}): Promise<TaskLineModalResult | null> {
	return new Promise((resolve) => {
		new TaskLineModal(options, (result) => resolve(result.line ? result : null)).open();
	});
}

class TaskLineModal extends Modal {
	private readonly fields: TaskLineFields;
	private readonly isCreateMode: boolean;
	private targetFileValue: string;
	private parentTaskValue = "";
	private resolved = false;

	constructor(
		private readonly options: TaskLineModalOptions,
		private readonly resolve: (result: TaskLineModalResult) => void,
	) {
		super(options.app);
		this.fields = fieldsFromTaskLine(options.initialLine, options.registry);
		this.isCreateMode = options.initialLine.trim() === "";
		this.targetFileValue = "";
	}

	onOpen(): void {
		this.setTitle(this.options.title);
		this.contentEl.empty();
		this.contentEl.addClass("taskslite-modal");

		new Setting(this.contentEl).setName(t("modal.name")).addText((text) => {
			text.setValue(this.fields.description).setPlaceholder(t("modal.taskNamePlaceholder")).onChange((value) => {
				this.fields.description = value;
			});
			window.setTimeout(() => text.inputEl.focus(), 0);
		});

		if (this.options.targetFile) {
			this.addTargetFileSetting(this.contentEl, this.options.targetFile);
		}
		if (this.options.parentTask) {
			this.addParentTaskSetting(this.contentEl, this.options.parentTask);
		}

		new Setting(this.contentEl).setName(t("modal.status")).addDropdown((dropdown) => {
			for (const status of modalStatuses(this.options.settings, this.options.registry)) {
				dropdown.addOption(status.symbol, statusOptionLabel(status));
			}
			dropdown.setValue(this.fields.statusSymbol).onChange((value) => {
				this.fields.statusSymbol = value;
			});
		});

		this.addPrioritySetting(this.contentEl);
		this.addDateSetting(`${TASK_SYMBOLS.start} ${t("modal.startDate")}`, "start");
		this.addDateSetting(`${TASK_SYMBOLS.scheduled} ${t("modal.scheduledDate")}`, "scheduled");
		this.addDateSetting(`${TASK_SYMBOLS.due} ${t("modal.dueDate")}`, "due");
		if (!this.isCreateMode) {
			this.addDateSetting(`${TASK_SYMBOLS.created} ${t("modal.createdDate")}`, "created");
			this.addDateSetting(`${TASK_SYMBOLS.done} ${t("modal.doneDate")}`, "done");
			this.addDateSetting(`${TASK_SYMBOLS.cancelled} ${t("modal.cancelledDate")}`, "cancelled");
		}
		const advanced = this.addAdvancedDetails();
		this.addRecurrenceSetting(advanced);
		this.addOnCompletionSetting(advanced);
		this.addTextSetting(advanced, `${TASK_SYMBOLS.id} ${t("modal.taskId")}`, "id", "id");
		this.addTextSetting(advanced, `${TASK_SYMBOLS.dependsOn} ${t("modal.dependsOn")}`, "id1, id2", "dependsOn");
		this.addTextSetting(advanced, t("modal.blockLink"), "^block-id", "blockLink");

		new Setting(this.contentEl)
			.addButton((button) =>
				button.setButtonText(t("common.cancel")).onClick(() => {
					this.finish({line: ""});
				}),
			)
			.addButton((button) =>
				button
					.setButtonText(t("common.save"))
					.setCta()
					.onClick(() => {
						this.finish({
							line: taskLineFromFields(this.fields, this.options.registry),
							targetPath: this.options.targetFile ? targetFilePath(this.options.targetFile.basePath, this.targetFileValue) : undefined,
							parentLineNumber: this.options.parentTask ? parseParentTaskValue(this.parentTaskValue).lineNumber : undefined,
						});
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		this.finish({line: ""});
	}

	private addTargetFileSetting(container: HTMLElement, options: TaskLineModalTargetFileOptions): void {
		const values = targetFileOptions(this.app, options.basePath);
		let input: TextComponent | null = null;
		let manualInput = false;
		new Setting(container).setName(t("modal.file")).addText((text) => {
			input = text;
			text.inputEl.readOnly = true;
			text.inputEl.addClass("taskslite-file-input");
			text.inputEl.setAttr("autocomplete", "off");
			text.inputEl.setAttr("autocorrect", "off");
			text.inputEl.setAttr("autocapitalize", "none");
			text.inputEl.setAttr("spellcheck", "false");
			text.setPlaceholder(options.defaultValue).onChange((value) => {
				this.targetFileValue = value;
			});
			text.inputEl.addEventListener("click", () => {
				if (!manualInput) {
					new TargetFileSuggestModal(this.app, values, input?.getValue() ?? "", (value) => {
						this.targetFileValue = value;
						input?.setValue(value);
					}).open();
				}
			});
		}).addExtraButton((button) => {
			button
				.setIcon("folder-open")
				.setTooltip(t("modal.chooseFile"))
				.onClick(() => {
					new TargetFileSuggestModal(this.app, values, input?.getValue() ?? "", (value) => {
						this.targetFileValue = value;
						input?.setValue(value);
					}).open();
				});
		}).addExtraButton((button) => {
			button
				.setIcon("pencil")
				.setTooltip(t("modal.editFilePath"))
				.onClick(() => {
					manualInput = !manualInput;
					if (input) {
						input.inputEl.readOnly = !manualInput;
						input.inputEl.toggleClass("taskslite-file-input-manual", manualInput);
						if (manualInput) input.inputEl.focus();
						else input.inputEl.blur();
					}
				});
		});
	}

	private addDateSetting(name: string, key: "start" | "created" | "scheduled" | "due" | "done" | "cancelled"): void {
		new Setting(this.contentEl).setName(name).addText((text) => {
			text.inputEl.type = "date";
			text.inputEl.addClass("taskslite-modal-date-input");
			text.setValue(this.fields[key]).onChange((value) => {
				this.fields[key] = value;
			});
		});
	}

	private addParentTaskSetting(container: HTMLElement, options: TaskLineModalParentTaskOptions): void {
		new Setting(container).setName(t("modal.parentTask")).addDropdown((dropdown) => {
			dropdown.addOption("", t("common.none"));
			for (const option of options.options) {
				dropdown.addOption(serializeParentTaskValue(option.path, option.lineNumber), option.label);
			}
			dropdown.setValue(this.parentTaskValue).onChange((value) => {
				this.parentTaskValue = value;
			});
		});
	}

	private addAdvancedDetails(): HTMLElement {
		const details = this.contentEl.createEl("details", {cls: "taskslite-modal-advanced"});
		if (hasAdvancedFields(this.fields)) details.open = true;
		details.createEl("summary", {text: t("modal.advanced")});
		return details.createDiv({cls: "taskslite-modal-advanced-content"});
	}

	private addOnCompletionSetting(container: HTMLElement): void {
		new Setting(container).setName(`${TASK_SYMBOLS.onCompletion} ${t("modal.onCompletion")}`).addDropdown((dropdown) => {
			const values = ["", "delete", "keep", "complete"];
			for (const value of values) {
				dropdown.addOption(value, value || t("common.none"));
			}
			if (this.fields.onCompletion && !values.includes(this.fields.onCompletion)) {
				dropdown.addOption(this.fields.onCompletion, this.fields.onCompletion);
			}
			dropdown.setValue(this.fields.onCompletion).onChange((value) => {
				this.fields.onCompletion = value;
			});
		});
	}

	private addRecurrenceSetting(container: HTMLElement): void {
		new Setting(container).setName(`${TASK_SYMBOLS.recurrence} ${t("modal.recurrence")}`).addDropdown((dropdown) => {
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
				dropdown.addOption(value, value || t("common.none"));
			}
			if (this.fields.recurrence && !values.includes(this.fields.recurrence)) {
				dropdown.addOption(this.fields.recurrence, this.fields.recurrence);
			}
			dropdown.setValue(this.fields.recurrence).onChange((value) => {
				this.fields.recurrence = value;
			});
		});
	}

	private addPrioritySetting(container: HTMLElement): void {
		new Setting(container).setName(t("modal.priority")).addDropdown((dropdown) => {
			dropdown.addOption("", t("common.none"));
			dropdown.addOption(TASK_SYMBOLS.priority.highest, `${TASK_SYMBOLS.priority.highest} ${t("priority.highest")}`);
			dropdown.addOption(TASK_SYMBOLS.priority.high, `${TASK_SYMBOLS.priority.high} ${t("priority.high")}`);
			dropdown.addOption(TASK_SYMBOLS.priority.medium, `${TASK_SYMBOLS.priority.medium} ${t("priority.medium")}`);
			dropdown.addOption(TASK_SYMBOLS.priority.low, `${TASK_SYMBOLS.priority.low} ${t("priority.low")}`);
			dropdown.addOption(TASK_SYMBOLS.priority.lowest, `${TASK_SYMBOLS.priority.lowest} ${t("priority.lowest")}`);
			if (this.fields.priority && !Object.values(TASK_SYMBOLS.priority).includes(this.fields.priority)) {
				dropdown.addOption(this.fields.priority, this.fields.priority);
			}
			dropdown.setValue(this.fields.priority).onChange((value) => {
				this.fields.priority = value;
			});
		});
	}

	private addTextSetting(container: HTMLElement, name: string, placeholder: string, key: keyof Omit<TaskLineFields, "statusSymbol" | "description">): void {
		new Setting(container).setName(name).addText((text) => {
			text.setValue(this.fields[key]).setPlaceholder(placeholder).onChange((value) => {
				this.fields[key] = value;
			});
		});
	}

	private finish(result: TaskLineModalResult): void {
		if (this.resolved) return;
		this.resolved = true;
		this.resolve(result);
		this.close();
	}
}

class TargetFileSuggestModal extends SuggestModal<string> {
	constructor(
		app: App,
		private readonly values: string[],
		private readonly initialQuery: string,
		private readonly onChoose: (value: string) => void,
	) {
		super(app);
		this.setPlaceholder(t("modal.filePlaceholder"));
		this.inputEl.value = initialQuery;
	}

	getSuggestions(query: string): string[] {
		const normalized = query.trim().toLowerCase();
		if (!normalized) return this.values;
		return this.values.filter((value) => value.toLowerCase().includes(normalized));
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	onChooseSuggestion(value: string): void {
		this.onChoose(value);
	}
}

function modalStatuses(settings: TaskLiteSettings, registry: StatusRegistry): StatusConfiguration[] {
	const statuses = allStatuses(settings.statusSettings);
	if (statuses.some((status) => status.symbol === " ")) return statuses;
	return [registry.get(" "), ...statuses];
}

function statusOptionLabel(status: StatusConfiguration): string {
	const symbol = status.symbol === " " ? "☐" : status.symbol || " ";
	return `${symbol} ${status.name}`;
}

function hasAdvancedFields(fields: TaskLineFields): boolean {
	return Boolean(fields.recurrence || fields.onCompletion || fields.id || fields.dependsOn || fields.blockLink);
}

function targetFileOptions(app: App, basePath: string): string[] {
	const prefix = normalizeFolderPath(basePath);
	return app.vault
		.getMarkdownFiles()
		.map((file) => file.path)
		.filter((path) => path.startsWith(`${prefix}/`))
		.map((path) => path.slice(prefix.length + 1).replace(/\.md$/iu, ""))
		.sort((left, right) => left.localeCompare(right));
}

function targetFilePath(basePath: string, value: string): string {
	const prefix = normalizeFolderPath(basePath);
	const trimmed = value.trim() || "New_Tasks";
	const withoutLeadingSlash = trimmed.replace(/^\/+/u, "");
	const withExtension = withoutLeadingSlash.toLowerCase().endsWith(".md") ? withoutLeadingSlash : `${withoutLeadingSlash}.md`;
	return `${prefix}/${withExtension}`.replace(/\/+/gu, "/");
}

function serializeParentTaskValue(path: string, lineNumber: number): string {
	return `${path}::${lineNumber}`;
}

function parseParentTaskValue(value: string): {path: string; lineNumber: number | undefined} {
	const [path, linePart] = value.split("::");
	const parsed = Number.parseInt(linePart ?? "", 10);
	return {path: path ?? "", lineNumber: Number.isFinite(parsed) ? parsed : undefined};
}

function normalizeFolderPath(value: string): string {
	return value.trim().replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "") || "Tasks";
}
