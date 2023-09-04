import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, moment } from 'obsidian';

import { google, } from 'googleapis';
import { existsSync } from 'fs';
import * as path from 'path';
import { authenticate } from '@google-cloud/local-auth';
import { OAuth2Client } from 'google-auth-library';

// Remember to rename these classes and interfaces!

interface GlitchedVideoPluginSettings {
	mySetting: string;

	/**
	 * Path location where keys should exist at
	 */
	oauth2KeysLocation: string;
}

const DEFAULT_SETTINGS: GlitchedVideoPluginSettings = {
	mySetting: 'default',
	oauth2KeysLocation: ''
}

/**
 * Defines the known properties on the dynamically returned column 
 */
interface AnalyticsReportColumn {
	name: string;
	columnType: string;
	dataType: string;
}

/**
 * Defines the known properties on the dynamically returned report object
 */
interface AnalyticsReport {

	columnHeaders: AnalyticsReportColumn[];

	rows: number[][]
}

/**
 * Defines whether a set of options is valid or not
 */
type OptionsValidationResult = {
	/**
	 * whether the options are valid or not
	 */
	valid: boolean;
	/**
	 * any reasons why the options were not valid, only populated when valid is false
	 */
	violations: string | undefined;
}

interface VideoReportOptions {
	/**
	 * End date for video report, in YYYY-MM-DD
	 */
	endDate: string;
	/**
	 * start date for video report, in YYYY-MM-DD
	 */
	startDate: string;

	/**
	 * metrics to retrieve, comma separated
	 */
	metrics: string;

	/**
	 * Identifier for the video
	 */
	videoId: string;
}

export default class GlitchedVideoPlugin extends Plugin {
	settings: GlitchedVideoPluginSettings;

	oauth2Client: OAuth2Client;

	/**
	 * Cache any options set and start with some defaults
	 */
	previousReportOptions: VideoReportOptions = {
		metrics: "views,comments,likes",
		endDate: moment().format("YYYY-MM-DD"),
		startDate: moment().format("YYYY-MM-DD"),
		videoId: ''
	};

	async onload() {
		await this.loadSettings();

		const videoAnalyticsButton = this.addRibbonIcon('wand-glyph', 'Video Analysis', (evt: MouseEvent) => {
			console.log('[glitched-analytics-plugin] VideoAnalyisis');

			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view) {

				const oauthKeyLocation = this.settings.oauth2KeysLocation;

				// check if a value is set
				if (!oauthKeyLocation) {
					new OAuth2MisconfiguredErrorModal(this.app).open();
					return;
				}

				// ensure location exists
				if (!existsSync(path.normalize(oauthKeyLocation))) {
					new ErrorModal(this.app, `Invalid Location: \"${oauthKeyLocation}`).open();
					return;
				}

				// retrieve or assign an empty value
				const previousOptions = this.previousReportOptions ?? {};

				new VideoReportOptionsModal(this.app, previousOptions, (result) => {
					const validate = this.validateOptions(result);
					// set interim results regardless of valid or not
					this.previousReportOptions = result;

					if (!validate.valid) {
						new ErrorModal(this.app, "Options set incorrectly:\n" + validate.violations).open();
					}
					else {
						this.runVideoReport(view.editor, this.previousReportOptions);
					}
				}).open();
			}
		});

		// Tie a button to the ribbon to interact with the plugin
		videoAnalyticsButton.addClass('my-plutin-ribbon-class');

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new GlitchedVideoPluginSettingsTab(this.app, this));

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
	}


	/**
	 * Actually runs the report using the youtube api, then pastes formatted results onto the editor
	 * 
	 * @param editor the editor to set contents onto
	 * @param options the options when configuring the report
	 */
	private runVideoReport(editor: Editor, options: VideoReportOptions) {

		// Avoid requiring a login every time
		if (this.shouldAuthenticate()) {
			console.log(`[glitched-analytics-plugin] Reauthenticating using "${this.settings.oauth2KeysLocation}"`);

			authenticate({
				scopes: ['https://www.googleapis.com/auth/yt-analytics.readonly',
					'https://www.googleapis.com/auth/yt-analytics-monetary.readonly'
				],
				keyfilePath: this.settings.oauth2KeysLocation
			}).then(client => {
				console.log('[glitched-analytics-plugin] Acquired credentials');
				this.oauth2Client = client;
				return client
			})
				.then(client => {
					google.options({ auth: client });

					this.fetchReportDetails(editor, options);
				});
		}
		else {
			this.fetchReportDetails(editor, options);
		}

	}

	/**
	 * Determines if we need to reauthenticate via oauth or not
	 * @returns true if we need to reauthenticate, false otherwise
	 */
	private shouldAuthenticate(): boolean {
		// nothing cached
		if (this.oauth2Client == null) {
			return true;
		}

		const cachedCreds = this.oauth2Client.credentials;

		// cannot determine if we should or not
		if (!cachedCreds.expiry_date) {
			return true;
		}

		// current date is greater than when the token expired
		const timeNowMs = new Date().getUTCMilliseconds();
		return timeNowMs > cachedCreds.expiry_date;
	}

	/**
	 * Runs the configured analytics report
	 * @param editor the editor to paste the results into
	 * @param options configuration options for the report
	 */
	private fetchReportDetails(editor: Editor, options: VideoReportOptions) {
		console.log('[glitched-analytics-plugin] Fetching analytics report for ', JSON.stringify(options));

		google.youtubeAnalytics("v2").reports.query({
			endDate: options.endDate,
			startDate: options.startDate,
			metrics: options.metrics,
			// Youtube Analytics explains all of this
			ids: "channel==MINE",
			filters: `video==${options.videoId}`
		})
			.then(gresponse => {
				const metricsData = gresponse.data;
				console.log(`[glitched-analytics-plugin] Received: ${metricsData}`);

				editor.replaceRange(this.formatReport(metricsData as AnalyticsReport), editor.getCursor());
			})
			.catch(error => {
				new ErrorModal(this.app, "Retrieval failed: " + error).open();
			});
	}

	/**
	 * Formats the result of the report to YAML frontmatter
	 * @param data the value of the report, bound to a typescript type of known properties
	 * @returns line separated values for frontmatter
	 */
	private formatReport(data: AnalyticsReport): string {

		let frontMattered = "";

		for (let i = 0; i < data.rows.length; i++) {
			const row = data.rows[i];

			// for every row get the data and column value
			for (let j = 0; j < row.length; j++) {
				const columnName = data.columnHeaders[j].name;
				const dataValue = row[j];

				frontMattered += `${columnName}:: ${dataValue}\n`
			}
		}

		return frontMattered.trim();
	}

	/**
	 * Verifies that all the parameters are set correctly or throws an error dialog
	 * @param options the options to validate prior to running a report
	 */
	private validateOptions(options: VideoReportOptions): OptionsValidationResult {

		let violations = "";

		let valid = true;

		if (!moment(options.startDate, "YYYY-MM-DD").isValid()) {
			violations += "\n"
			violations += "\tstartDate: not set correctly."
			valid = false;
		}

		if (!moment(options.endDate, "YYYY-MM-DD").isValid()) {
			violations += "\n"
			violations += "\tendDate: not set correctly."
			valid = false;
		}

		if (!options.metrics) {
			violations += "\n"
			violations += "\tmetrics: not set correctly."
			valid = false;
		}

		if (!options.videoId) {
			violations += "\n"
			violations += "\tvideoId: not set correctly."
			valid = false;
		}

		if (valid) {
			return { valid, violations: undefined }
		}

		return { valid, violations: violations.trim() }
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class GlitchedVideoPluginSettingsTab extends PluginSettingTab {
	plugin: GlitchedVideoPlugin;

	constructor(app: App, plugin: GlitchedVideoPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('OAuth2 Keys')
			.setDesc("JSON file where your OAuth2 keys live")
			.addTextArea(text =>
				text.setValue(this.plugin.settings.oauth2KeysLocation || '')
					.onChange(async (value) => {
						if (value.length > 0) {
							this.plugin.settings.oauth2KeysLocation = path.normalize(value)
							await this.plugin.saveSettings();
						}
					}));
	}
}


class OAuth2MisconfiguredErrorModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.setText('OAUth2 Key location not defined!');
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class ErrorModal extends Modal {
	errorMessage: string;
	constructor(app: App, errorMessage: string) {
		super(app);
		this.errorMessage = errorMessage;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.setText(`ERROR:\n ${this.errorMessage}`);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Modal that configures the kind of report to run
 */
class VideoReportOptionsModal extends Modal {
	result: VideoReportOptions;
	onSubmit: (result: VideoReportOptions) => void;

	constructor(app: App, previousOptions: VideoReportOptions, onSubmit: (result: VideoReportOptions) => void) {
		super(app);
		this.onSubmit = onSubmit;
		this.result = previousOptions;
	}

	onOpen() {
		const { contentEl } = this;

		contentEl.createEl("h1", { text: "Report Dates" });

		new Setting(contentEl)
			.setName("Start Date")
			.setDesc("Start date in YYYY-MM-DD format")
			.addText((text) =>
				text.setValue(this.result.startDate)
					.onChange((value) => {
						this.result.startDate = value;
					}));

		new Setting(contentEl)
			.setName("End Date")
			.setDesc("End date in YYYY-MM-DD format")
			.addText((text) =>
				text.setValue(this.result.endDate)
					.onChange((value) => {
						this.result.endDate = value;
					}));

		contentEl.createEl("h1", { text: "Video Data" });

		new Setting(contentEl)
			.setName("Report Metrics")
			.setDesc("Comma separated value of metrics to fetch")
			.addText((text) =>
				text.setValue(this.result.metrics)
					.onChange((value) => {
						this.result.metrics = value;
					}));

		new Setting(contentEl)
			.setName("Video Id")
			.setDesc("The ID of the video to get data for")
			.addText((text) =>
				text.setValue(this.result.videoId)
					.onChange((value) => {
						this.result.videoId = value;
					}));

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Submit")
					.setCta()
					.onClick(() => {
						this.close();
						this.onSubmit(this.result);
					}));
	}

	onClose() {
		let { contentEl } = this;
		contentEl.empty();
	}
}