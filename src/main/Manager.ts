/* eslint-disable no-await-in-loop */
import { BrowserWindow, app, ipcMain, powerMonitor } from 'electron';
import { isEqual } from 'lodash';
import path from 'path';
import fs from 'fs';
import { uIOhook } from 'uiohook-napi';
import assert from 'assert';
import {
  addCrashToUI,
  buildClipMetadata,
  checkDisk,
  getMetadataForVideo,
  getOBSFormattedDate,
  validateFlavour,
  tagVideoDisk,
  toggleVideoProtectedDisk,
  openSystemExplorer,
  reverseChronologicalVideoSort,
  loadAllVideosDisk,
  areDatesWithinSeconds,
  markForVideoForDelete,
  getPromiseBomb,
  povNameSort,
} from './util';
import { VideoCategory } from '../types/VideoCategory';
import Poller from '../utils/Poller';
import ClassicLogHandler from '../parsing/ClassicLogHandler';
import RetailLogHandler from '../parsing/RetailLogHandler';
import Recorder from './Recorder';
import ConfigService from './ConfigService';
import {
  ObsBaseConfig,
  ObsVideoConfig,
  ObsAudioConfig,
  RecStatus,
  ConfigStage,
  FlavourConfig,
  ObsOverlayConfig,
  IOBSDevice,
  CrashData,
  VideoQueueItem,
  MicStatus,
  RendererVideo,
  Metadata,
  CloudStatus,
  DiskStatus,
  CloudObject,
} from './types';
import {
  getObsBaseConfig,
  getObsVideoConfig,
  getObsAudioConfig,
  getFlavourConfig,
  getOverlayConfig,
} from '../utils/configUtils';
import { ERecordingState } from './obsEnums';
import {
  runClassicRecordingTest,
  runRetailRecordingTest,
} from '../utils/testButtonUtils';
import VideoProcessQueue from './VideoProcessQueue';
import CloudClient from '../storage/CloudClient';
import CloudSizeMonitor from '../storage/CloudSizeMonitor';
import DiskSizeMonitor from '../storage/DiskSizeMonitor';

/**
 * The manager class is responsible for orchestrating all the functional
 * bits of the app including the Recorder, LogHandlers and Poller classes.
 *
 * In particular, it has the knowledge of how to reconfigure the Recorder
 * class, which is non-trivial as some config can be changed live while others
 * can not.
 *
 * The external interface here is manage(), call this any time a config change
 * occurs and it will always do the right thing.
 */
export default class Manager {
  public recorder: Recorder;

  private mainWindow: BrowserWindow;

  private cfg: ConfigService = ConfigService.getInstance();

  private poller = Poller.getInstance(getFlavourConfig(this.cfg));

  private active = false;

  private queued = false;

  private obsBaseCfg: ObsBaseConfig = getObsBaseConfig(this.cfg);

  private obsVideoCfg: ObsVideoConfig = getObsVideoConfig(this.cfg);

  private obsAudioCfg: ObsAudioConfig = getObsAudioConfig(this.cfg);

  private flavourCfg: FlavourConfig = getFlavourConfig(this.cfg);

  private overlayCfg: ObsOverlayConfig = getOverlayConfig(this.cfg);

  private retailLogHandler: RetailLogHandler | undefined;

  private classicLogHandler: ClassicLogHandler | undefined;

  private cloudClient: CloudClient | undefined;

  private videoProcessQueue: VideoProcessQueue;

  private configValid = false;

  private configMessage = '';

  /**
   * Defined stages of configuration. They are named only for logging
   * purposes. Each stage holds the current state of the stages config,
   * and provides functions to get, validate and configure the config.
   */
  private stages: ConfigStage[] = [
    /* eslint-disable prettier/prettier */
    {
      name: 'obsBase',
      initial: true,
      current: this.obsBaseCfg,
      get: (cfg: ConfigService) => getObsBaseConfig(cfg),
      validate: async (config: ObsBaseConfig) => Manager.validateBaseCfg(config),
      configure: async (config: ObsBaseConfig) => this.configureObsBase(config),
    },
    {
      name: 'obsVideo',
      initial: true,
      current: this.obsVideoCfg,
      get: (cfg: ConfigService) => getObsVideoConfig(cfg),
      validate: async () => {},
      configure: async (config: ObsVideoConfig) => this.configureObsVideo(config),
    },
    {
      name: 'obsAudio',
      initial: true,
      current: this.obsAudioCfg,
      get: (cfg: ConfigService) => getObsAudioConfig(cfg),
      validate: async () => {},
      configure: async (config: ObsAudioConfig) => this.configureObsAudio(config),
    },
    {
      name: 'flavour',
      initial: true,
      current: this.flavourCfg,
      get: (cfg: ConfigService) => getFlavourConfig(cfg),
      validate: async (config: FlavourConfig) => validateFlavour(config),
      configure: async (config: FlavourConfig) => this.configureFlavour(config),
    },
    {
      name: 'overlay',
      initial: true,
      current: this.overlayCfg,
      get: (cfg: ConfigService) => getOverlayConfig(cfg),
      validate: async () => {},
      configure: async (config: ObsOverlayConfig) => this.configureObsOverlay(config),
    },
    /* eslint-enable prettier/prettier */
  ];

  /**
   * Constructor.
   */
  constructor(mainWindow: BrowserWindow) {
    console.info('[Manager] Creating manager');

    this.setupListeners();

    this.mainWindow = mainWindow;
    this.recorder = new Recorder(this.mainWindow);

    this.recorder.on('crash', (crashData) =>
      this.recoverRecorderFromCrash(crashData)
    );

    this.recorder.on('state-change', () => this.refreshStatus());
    this.videoProcessQueue = new VideoProcessQueue(this.mainWindow);

    this.poller
      .on('wowProcessStart', () => this.onWowStarted())
      .on('wowProcessStop', () => this.onWowStopped());

    this.manage();
    setInterval(() => this.restartRecorder(), 5 * (1000 * 60));
  }

  /**
   * The public interface to this class. This function carefully calls into
   * internalManage() but catches duplicate calls and queues them, up to a
   * a limit of one queued call.
   *
   * This prevents someone spamming buttons in the setings page from sending
   * invalid configuration requests to the Recorder class.
   */
  public async manage() {
    if (this.active) {
      if (!this.queued) {
        console.info('[Manager] Queued a manage call');
        this.queued = true;
      }

      return;
    }

    this.active = true;
    await this.internalManage();

    if (this.queued) {
      console.info('[Manager] Execute a queued manage call');
      this.queued = false;
      await this.internalManage();
    }

    this.active = false;
  }

  /**
   * Force a recording to stop regardless of the scenario.
   */
  public async forceStop() {
    if (this.retailLogHandler && this.retailLogHandler.activity) {
      await this.retailLogHandler.forceEndActivity();
    }

    if (this.classicLogHandler && this.classicLogHandler.activity) {
      await this.classicLogHandler.forceEndActivity();
    }
  }

  /**
   * Run a test. We prefer retail here, if the user doesn't have a retail path
   * configured, then fall back to classic. We only pass through the category
   * for retail, any classic tests will default to 2v2. Probably should fix
   * that.
   */
  public test(category: VideoCategory, endTest: boolean) {
    if (this.retailLogHandler) {
      console.info('[Manager] Running retail test');
      const parser = this.retailLogHandler.combatLogWatcher;
      runRetailRecordingTest(category, parser, endTest);
      return;
    }

    if (this.classicLogHandler) {
      console.info('[Manager] Running classic test');
      const parser = this.classicLogHandler.combatLogWatcher;
      runClassicRecordingTest(parser, endTest);
    }
  }

  /**
   * This function iterates through the config stages, checks for any changes,
   * validates the new config and then applies it.
   */
  private async internalManage() {
    console.info('[Manager] Internal manage');

    for (let i = 0; i < this.stages.length; i++) {
      const stage = this.stages[i];
      const newConfig = stage.get(this.cfg);
      const configChanged = !isEqual(newConfig, stage.current);

      try {
        await stage.validate(newConfig);
      } catch (error) {
        stage.current = newConfig;
        stage.initial = false;
        this.setConfigInvalid(String(error));
        return;
      }

      if (stage.initial || configChanged) {
        console.info(
          '[Manager] Configuring stage',
          stage.name,
          'with',
          newConfig
        );

        await stage.configure(newConfig);
        stage.current = newConfig;
        stage.initial = false;
      }
    }

    this.setConfigValid();
  }

  /**
   * Set member variables to reflect the config being valid.
   */
  private setConfigValid() {
    this.configValid = true;
    this.configMessage = '';
    this.refreshStatus();
  }

  /**
   * Set member variables to reflect the config being invalid.
   */
  private setConfigInvalid(reason: string) {
    this.configValid = false;
    this.configMessage = reason;
    this.refreshStatus();
  }

  /**
   * Refresh the recorder and mic status icons in the UI. This is the only
   * place that this should be done from to avoid any status icon confusion.
   */
  public refreshStatus() {
    if (!this.configValid) {
      this.refreshRecStatus(
        RecStatus.InvalidConfig,
        String(this.configMessage)
      );
      return;
    }

    const inOverrun =
      this.retailLogHandler?.overrunning || this.classicLogHandler?.overrunning;
    const inActivity =
      this.retailLogHandler?.activity || this.classicLogHandler?.activity;

    if (inOverrun) {
      this.refreshRecStatus(RecStatus.Overruning);
    } else if (inActivity) {
      this.refreshRecStatus(RecStatus.Recording);
    } else if (this.recorder.obsState === ERecordingState.Recording) {
      this.refreshRecStatus(RecStatus.ReadyToRecord);
    } else if (
      this.recorder.obsState === ERecordingState.Offline ||
      this.recorder.obsState === ERecordingState.Starting ||
      this.recorder.obsState === ERecordingState.Stopping
    ) {
      this.refreshRecStatus(RecStatus.WaitingForWoW);
    }

    this.refreshMicStatus(this.recorder.obsMicState);
  }

  /**
   * Send a message to the frontend to update the recorder status icon.
   */
  private refreshRecStatus(status: RecStatus, msg = '') {
    this.mainWindow.webContents.send('updateRecStatus', status, msg);
  }

  /**
   * Send a message to the frontend to update the mic status icon.
   */
  private refreshMicStatus(status: MicStatus) {
    this.mainWindow.webContents.send('updateMicStatus', status);
  }

  /**
   * Send a message to the frontend to update the cloud status, which populates
   * the cloud usage bar. Safe to call regardless of if cloud storage in use or not.
   */
  private async refreshCloudStatus() {
    if (this.cloudClient === undefined) {
      return;
    }

    try {
      const usage = await new CloudSizeMonitor(
        this.mainWindow,
        this.cloudClient
      ).usage();

      const status: CloudStatus = {
        usageGB: usage / 1024 ** 3,
        maxUsageGB: 250,
      };

      this.mainWindow.webContents.send('updateCloudStatus', status);
    } catch (error) {
      console.error('[Manager] Error getting cloud status', String(error));
    }
  }

  /**
   * Send a message to the frontend to update the disk status, which populates
   * the disk usage bar.
   */
  private async refreshDiskStatus() {
    const usage = await new DiskSizeMonitor(this.mainWindow).usage();

    const status: DiskStatus = {
      usageGB: usage / 1024 ** 3,
      maxUsageGB: this.cfg.get<number>('maxStorage'),
    };

    this.mainWindow.webContents.send('updateDiskStatus', status);
  }

  /**
   * Called when the WoW process is detected, which may be either on launch
   * of the App if WoW is open, or the user has genuinely opened WoW. Attaches
   * the audio sources and starts the buffer recording.
   */
  private async onWowStarted() {
    console.info('[Manager] Detected WoW is running');
    const config = getObsAudioConfig(this.cfg);
    this.recorder.configureAudioSources(config);

    try {
      await this.recorder.start();
    } catch (error) {
      console.error('[Manager] OBS failed to record when WoW started');
    }
  }

  /**
   * Called when the WoW process is detected to have exited. Ends any
   * recording that is still ongoing. We detach audio sources here to
   * allow Windows to go to sleep with WR running.
   */
  private async onWowStopped() {
    console.info(
      '[Manager] Detected WoW not running, or Windows going inactive'
    );

    if (this.retailLogHandler && this.retailLogHandler.activity) {
      await this.retailLogHandler.forceEndActivity();
      this.recorder.removeAudioSources();
    } else if (this.classicLogHandler && this.classicLogHandler.activity) {
      await this.classicLogHandler.forceEndActivity();
      this.recorder.removeAudioSources();
    } else {
      await this.recorder.stop();
      this.recorder.removeAudioSources();
    }
  }

  /**
   * Configure the base OBS config. We need to stop the recording to do this.
   */
  private async configureObsBase(config: ObsBaseConfig) {
    await this.recorder.stop();
    const {
      cloudStorage,
      cloudUpload,
      cloudAccountName,
      cloudAccountPassword,
      cloudGuildName,
    } = config;

    if (this.cloudClient) {
      this.cloudClient.removeAllListeners();
      this.cloudClient.stopPollForUpdates();
      this.cloudClient = undefined;
      this.videoProcessQueue.unsetCloudClient();
    }

    if (cloudStorage) {
      this.cloudClient = new CloudClient(
        cloudAccountName,
        cloudAccountPassword,
        cloudGuildName
      );

      await this.cloudClient.init();

      this.cloudClient.on('change', () => {
        this.mainWindow.webContents.send('refreshState');
        this.refreshCloudStatus();
      });

      this.cloudClient.pollInit();
      this.cloudClient.pollForUpdates(10);

      if (cloudUpload) {
        // The video process queue only needs the cloud client for uploads, so
        // we only need to set this if we're configured to upload.
        this.videoProcessQueue.setCloudClient(this.cloudClient);
      }
    }

    this.refreshDiskStatus();
    this.recorder.configureBase(config);
    this.poller.start();
    this.mainWindow.webContents.send('refreshState');
  }

  /**
   * Configure video settings in OBS. This can all be changed live.
   */
  private configureObsVideo(config: ObsVideoConfig) {
    this.recorder.configureVideoSources(config);
  }

  /**
   * Configure audio settings in OBS. This can all be changed live.
   */
  private configureObsAudio(config: ObsAudioConfig) {
    if (this.poller.isWowRunning) {
      this.recorder.configureAudioSources(config);
    }
  }

  /**
   * Configure the RetailLogHandler.
   */
  private async configureFlavour(config: FlavourConfig) {
    if (this.recorder.obsState === ERecordingState.Recording) {
      // We can't change this config if OBS is recording. If OBS is recording
      // but isRecording is false, that means it's a buffer recording. Stop it
      // briefly to change the config.
      await this.recorder.stop();
    }

    if (this.retailLogHandler) {
      this.retailLogHandler.removeAllListeners();
      this.retailLogHandler.destroy();
    }

    if (this.classicLogHandler) {
      this.classicLogHandler.removeAllListeners();
      this.classicLogHandler.destroy();
    }

    if (config.recordRetail) {
      this.retailLogHandler = new RetailLogHandler(
        this.mainWindow,
        this.recorder,
        this.videoProcessQueue,
        config.retailLogPath
      );

      this.retailLogHandler.on('state-change', () => this.refreshStatus());
    }

    if (config.recordClassic) {
      this.classicLogHandler = new ClassicLogHandler(
        this.mainWindow,
        this.recorder,
        this.videoProcessQueue,
        config.classicLogPath
      );

      this.classicLogHandler.on('state-change', () => this.refreshStatus());
    }

    this.poller.reconfigureFlavour(config);
    this.poller.start();
  }

  /**
   * Configure chat overlay in OBS. This can all be changed live.
   */
  private configureObsOverlay(config: ObsOverlayConfig) {
    this.recorder.configureOverlaySource(config);
  }

  private static async validateBaseCfg(config: ObsBaseConfig) {
    const { cloudStorage } = config;

    await Manager.validateBaseConfig(config);

    if (cloudStorage) {
      await Manager.validateCloudBaseConfig(config);
    }
  }

  private static async validateCloudBaseConfig(config: ObsBaseConfig) {
    const { cloudAccountName, cloudAccountPassword, cloudGuildName } = config;

    if (!cloudAccountName) {
      console.warn('[Manager] Empty account name');
      throw new Error('Account name must not be empty.');
    }

    if (!cloudAccountPassword) {
      console.warn('[Manager] Empty account key');
      throw new Error('Password must not be empty.');
    }

    if (!cloudGuildName) {
      console.warn('[Manager] Empty guild name');
      throw new Error('Guild name must not be empty.');
    }

    try {
      const client = new CloudClient(
        cloudAccountName,
        cloudAccountPassword,
        cloudGuildName
      );

      await client.init();

      // Poll init is a handy way to ensure we access to R2. If the mtime
      // object in R2 if this is the first launch, or to just read it if
      // it's already present.
      await Promise.race([
        client.pollInit(),
        getPromiseBomb(2000, 'R2 access too slow or failed'),
      ]);
    } catch (error) {
      console.warn('[Manager] Cloud validation failed,', String(error));
      throw new Error('Failed to authenticate with the cloud store.');
    }
  }

  private static async validateBaseConfig(config: ObsBaseConfig) {
    const { storagePath, maxStorage, obsPath } = config;

    if (!storagePath) {
      console.warn(
        '[Manager] Validation failed: `storagePath` is falsy',
        storagePath
      );

      throw new Error('Storage path is invalid.');
    }

    if (!fs.existsSync(path.dirname(storagePath))) {
      console.warn(
        '[Manager] Validation failed, storagePath does not exist',
        storagePath
      );

      throw new Error('Storage Path is invalid.');
    }

    await checkDisk(storagePath, maxStorage);

    if (!obsPath) {
      console.warn('[Manager] Validation failed: `obsPath` is falsy', obsPath);
      throw new Error('Buffer Storage Path is invalid.');
    }

    if (!fs.existsSync(path.dirname(obsPath))) {
      console.warn(
        '[Manager] Validation failed, obsPath does not exist',
        obsPath
      );

      throw new Error('Buffer Storage Path is invalid.');
    }

    if (storagePath === obsPath) {
      console.warn(
        '[Manager] Validation failed: Storage Path is the same as Buffer Path'
      );

      throw new Error('Storage Path is the same as Buffer Path');
    }

    // 10GB is a rough guess at what the worst case buffer directory might be.
    if (fs.existsSync(obsPath)) {
      await checkDisk(obsPath, 10);
    } else {
      const parentDir = path.dirname(obsPath);
      await checkDisk(parentDir, 10);
    }
  }

  /**
   * Setup event listeneres the app relies on.
   */
  private setupListeners() {
    // Config change listener we use to tweak the app settings in Windows if
    // the user enables/disables run on start-up.
    this.cfg.on('change', (key: string, value: any) => {
      if (key === 'startUp') {
        const isStartUp = value === true;
        console.info('[Main] OS level set start-up behaviour:', isStartUp);

        app.setLoginItemSettings({
          openAtLogin: isStartUp,
        });
      }
    });

    // The OBS preview window is tacked on-top of the UI so we call this often
    // whenever we need to move, resize, show or hide it.
    ipcMain.on('preview', (_event, args) => {
      if (args[0] === 'show') {
        this.recorder.showPreview(args[1], args[2], args[3], args[4]);
      } else if (args[0] === 'hide') {
        this.recorder.hidePreview();
      }
    });

    // Encoder listener, to populate settings on the frontend.
    ipcMain.handle('getEncoders', (): string[] => {
      const obsEncoders = this.recorder
        .getAvailableEncoders()
        .filter((encoder) => encoder !== 'none');

      return obsEncoders;
    });

    // Audio devices listener, to populate settings on the frontend.
    ipcMain.handle(
      'getAudioDevices',
      (): {
        input: IOBSDevice[];
        output: IOBSDevice[];
      } => {
        if (!this.recorder.obsInitialized) {
          return {
            input: [],
            output: [],
          };
        }

        const inputDevices = this.recorder.getInputAudioDevices();
        const outputDevices = this.recorder.getOutputAudioDevices();

        return {
          input: inputDevices,
          output: outputDevices,
        };
      }
    );

    // Test listener, to enable the test button to start a test.
    ipcMain.on('test', (_event, args) => {
      const testCategory = args[0] as VideoCategory;
      const endTest = Boolean(args[1]);
      this.test(testCategory, endTest);
    });

    // Clipping listener.
    ipcMain.on('clip', async (_event, args) => {
      console.info('[Manager] Clip request received with args', args);

      const source = args[0];
      const offset = args[1];
      const duration = args[2];

      const sourceMetadata = await getMetadataForVideo(source);
      const clipMetadata = buildClipMetadata(sourceMetadata, duration);
      const now = new Date();

      const clipQueueItem: VideoQueueItem = {
        source,
        suffix: `Clipped at ${getOBSFormattedDate(now)}`,
        offset,
        duration,
        deleteSource: false,
        metadata: clipMetadata,
      };

      this.videoProcessQueue.queueVideo(clipQueueItem);
    });

    // Force stop listener, to enable the force stop button to do its job.
    ipcMain.on('recorder', async (_event, args) => {
      if (args[0] === 'stop') {
        console.info('[Manager] Force stopping recording due to user request.');
        this.forceStop();
        return;
      }

      this.manage();
    });

    // Respond to a request from frontend for the cloud or disk usage
    // status; this populates the storage progress bars.
    ipcMain.on('getCloudStatus', () => this.refreshCloudStatus());
    ipcMain.on('getDiskStatus', () => this.refreshDiskStatus());

    // VideoButton event listeners.
    ipcMain.on('videoButton', async (_event, args) => {
      const action = args[0] as string;
      const src = args[1] as string;
      const cloud = args[2] as boolean;
      const tag = args[3] as string;

      if (action === 'open') {
        // Open only called for disk based video, see openURL for cloud version.
        assert(!cloud);
        openSystemExplorer(src);
      }

      if (action === 'save') {
        if (cloud) {
          await this.protectVideoCloud(src);
        } else {
          await toggleVideoProtectedDisk(src);
        }

        this.mainWindow.webContents.send('refreshState');
      }

      if (action === 'tag') {
        if (cloud) {
          await this.tagVideoCloud(src, tag);
        } else {
          await tagVideoDisk(src, tag);
        }

        this.mainWindow.webContents.send('refreshState');
      }

      if (action === 'download') {
        this.videoProcessQueue.queueDownload(src);
      }

      if (action === 'upload') {
        this.videoProcessQueue.queueUpload(src);
      }
    });

    ipcMain.on('safeDeleteVideo', async (_event, args) => {
      const src = args[0] as string;
      const cloud = args[1] as string;

      if (cloud) {
        // No special handling for cloud storage.
        await this.deleteVideoCloud(src);
      } else {
        markForVideoForDelete(src);
      }

      this.mainWindow.webContents.send('refreshState');
    });

    // URL Signer. We expose this so that the videoState doesn't need to
    // contain signed URLs which are variable. That triggers lots of re-renders
    // we can do without if we keep things deterministic.
    ipcMain.handle('signGetUrl', async (_event, args): Promise<string> => {
      const baseUrl = args[0];

      if (this.cloudClient === undefined) {
        return '';
      }

      // Sign the frontend resources for a week in the future so that we don't
      // need to worry about these links expiring. We only use this function for
      // loading images and videos directly into React.
      return this.cloudClient.signGetUrl(baseUrl, 3600 * 24 * 7);
    });

    // Important we shutdown OBS on the before-quit event as if we get closed by
    // the installer we want to ensure we shutdown OBS, this is common when
    // upgrading the app. See issue 325 and 338.
    app.on('before-quit', () => {
      console.info('[Manager] Running before-quit actions');
      this.recorder.shutdownOBS();
      uIOhook.stop();
    });

    // If Windows is going to sleep, we don't want to confuse OBS. Stop the
    // recording as if WoW has been closed, and resume it once Windows has
    // resumed.
    powerMonitor.on('suspend', () => {
      console.info('[Manager] Detected Windows is going to sleep.');
      this.onWowStopped();
    });

    powerMonitor.on('resume', () => {
      console.info('[Manager] Detected Windows waking up from a sleep.');
      this.poller.start();
    });
  }

  /**
   * If the recorder emits a crash event, we shut down OBS and create a new
   * recorder. That may not help whatever caused the crash, but will help
   * the app back into a good state.
   */
  private recoverRecorderFromCrash(crashData: CrashData) {
    console.error('[Manager] OBS got into a bad state, restarting it');
    addCrashToUI(this.mainWindow, crashData);

    this.recorder.removeAllListeners();
    this.recorder.shutdownOBS();

    if (this.retailLogHandler) {
      this.retailLogHandler.removeAllListeners();
      this.retailLogHandler.destroy();
    }

    if (this.classicLogHandler) {
      this.classicLogHandler.removeAllListeners();
      this.classicLogHandler.destroy();
    }

    this.recorder = new Recorder(this.mainWindow);
    this.recorder.on('crash', (cd) => this.recoverRecorderFromCrash(cd));
    this.recorder.on('state-change', () => this.refreshStatus());

    for (let i = 0; i < this.stages.length; i++) {
      this.stages[i].initial = true;
    }

    this.active = false;
    this.queued = false;
    this.manage();
  }

  /**
   * Every so often we'll try restart the recorder to avoid having an
   * infinitely long video sitting in the .temp folder. First we check
   * it's safe to do so, i.e. we're currently recording and not in an
   * activity.
   */
  private async restartRecorder() {
    if (this.recorder.obsState !== ERecordingState.Recording) {
      console.info('[Manager] Not restarting recorder as not recording');
      return;
    }

    const retailNotSafe = this.retailLogHandler?.activity;
    const classicNotSafe = this.classicLogHandler?.activity;

    if (retailNotSafe || classicNotSafe) {
      console.info('[Manager] Not restarting recorder as in an activity');
      return;
    }

    const retailOverrunning = this.retailLogHandler?.overrunning;
    const classicOverrunning = this.classicLogHandler?.overrunning;

    if (retailOverrunning || classicOverrunning) {
      console.info(
        '[Manager] Not restarting recorder as an activity is overrunning'
      );
      return;
    }

    console.info('[Manager] Restart recorder');
    await this.recorder.stop();
    await this.recorder.cleanup();
    await this.recorder.start();
  }

  /**
   * Load the details for all the videos.
   */
  public async loadAllVideos(storagePath: string) {
    const videos: RendererVideo[] = [];

    if (this.cloudClient !== undefined) {
      const cloudVideos = await this.loadAllVideosCloud();
      cloudVideos.forEach((video) => Manager.correlateVideo(video, videos));
    }

    // Deliberately after the cloud stuff so we'll always have cloud povs
    // come first in the UI and not vice versa.
    const diskVideos = await loadAllVideosDisk(storagePath);
    diskVideos.forEach((video) => Manager.correlateVideo(video, videos));

    videos.sort(reverseChronologicalVideoSort).forEach((video) => {
      video.multiPov.sort(povNameSort);
    });

    return videos;
  }

  /**
   * Decide if this video is a different point of view from an already seen
   * video. If so, attach it as a child to the renderer video object, if not
   * add it to the list of videos we know of.
   * @video the video to check
   * @videos the videos we already know about
   */
  private static correlateVideo(video: RendererVideo, videos: RendererVideo[]) {
    // If we can prove this video is another POV of the same activity
    // we will group them in the UI.
    let correlated = false;

    if (video.uniqueHash === undefined || video.start === undefined) {
      // We don't have the fields required to correlate this video to
      // any other so just add it and move on.
      videos.push(video);
      return;
    }

    // We might be able to correlate this, so loop over each of the videos we
    // already know about and look for a match.
    for (let i = 0; i < videos.length; i++) {
      const videoToCompare = videos[i];
      const sameHash = videoToCompare.uniqueHash === video.uniqueHash;

      const clipCompare = videoToCompare.category === VideoCategory.Clips;
      const isClip = video.category === VideoCategory.Clips;

      if ((clipCompare && !isClip) || (isClip && !clipCompare)) {
        // We only correlate clips with other clips. Go next.
        // eslint-disable-next-line no-continue
        continue;
      }

      if (!sameHash || videoToCompare.start === undefined) {
        // Mismatching hash or no start time so either these videos or
        // not correlated or we can't prove they are these are correlated.
        // eslint-disable-next-line no-continue
        continue;
      }

      // The hash is the same, but it could still be similar pull from a
      // different time so check the date. Don't look for an exact match
      // here as I'm not sure how accurate the start event in the combat log
      // is between players; surely it can vary slightly depending on local
      // system clock etc.
      const d1 = new Date(video.start);
      const d2 = new Date(videoToCompare.start);
      const closeStartTime = areDatesWithinSeconds(d1, d2, 5);

      if (sameHash && closeStartTime) {
        // The video is a different POV of the same activity, link them and
        // break, we will never have more than one "parent" video so if we've
        // found it we're good to drop out and save some CPU cycles.
        correlated = true;
        videoToCompare.multiPov.push(video);
        break;
      }
    }

    if (!correlated) {
      // We didn't correlate this video with another so just add it like
      // it is a normal video, this is the fallback case.
      videos.push(video);
    }
  }

  private async loadAllVideosCloud() {
    let objects: CloudObject[];

    try {
      assert(this.cloudClient);
      objects = await this.cloudClient.list();
    } catch (error) {
      console.error('[Manager] Failed to list keys:', String(error));
      return [];
    }

    const videoDetailPromises = objects
      .filter((obj) => obj.key.endsWith('json'))
      .map((obj) => this.loadVideoDetailsCloud(obj));

    const videoDetails: RendererVideo[] = (
      await Promise.all(videoDetailPromises.map((p) => p.catch((e) => e)))
    ).filter((result) => !(result instanceof Error));

    return videoDetails;
  }

  /**
   * Load details for a video from the cloud.
   * @throws
   */
  private loadVideoDetailsCloud = async (
    obj: CloudObject
  ): Promise<RendererVideo> => {
    const jsonKey = obj.key;
    const imageKey = jsonKey.replace('json', 'png');
    const videoKey = jsonKey.replace('json', 'mp4');

    try {
      assert(this.cloudClient);
      const metadata = await this.getMetadataForVideoCloud(jsonKey);
      const videoObject = await this.cloudClient.head(videoKey);

      const thumbnailSource = imageKey;
      const videoSource = videoKey;
      const isProtected = Boolean(metadata.protected);
      const mtime = videoObject.lastMod.getTime();
      const { size } = obj;

      return {
        ...metadata,
        name: videoSource,
        mtime,
        videoSource,
        thumbnailSource,
        isProtected,
        size,
        cloud: true,
        multiPov: [],
      };
    } catch (error) {
      // Just log it and rethrow. Want this to be diagnosable.
      console.warn('[Manager] Failed to load video:', jsonKey, String(error));
      throw error;
    }
  };

  /**
   * Get the metadata object for a video from the accompanying JSON file.
   * @throws
   */
  private getMetadataForVideoCloud = async (jsonKey: string) => {
    assert(this.cloudClient);
    const json = await this.cloudClient.getAsString(jsonKey);
    const metadata = JSON.parse(json) as Metadata;
    return metadata;
  };

  /**
   * Delete a video from the cloud, and it's accompanying metadata and thumbnail.
   */
  private deleteVideoCloud = async (videoKey: string) => {
    const thumbnailKey = videoKey.replace('mp4', 'png');
    const jsonKey = videoKey.replace('mp4', 'json');

    try {
      assert(this.cloudClient);

      await Promise.all([
        this.cloudClient.delete(videoKey),
        this.cloudClient.delete(thumbnailKey),
        this.cloudClient.delete(jsonKey),
      ]);
    } catch (error) {
      // Just log this and quietly swallow it. Nothing more we can do.
      console.warn('[Manager] Failed to delete', jsonKey, String(error));
    }
  };

  /**
   * Tag a video in the cloud.
   */
  private tagVideoCloud = async (videoKey: string, tag: string) => {
    const jsonKey = videoKey.replace('mp4', 'json');

    try {
      const metadata = await this.getMetadataForVideoCloud(jsonKey);

      if (!tag || !/\S/.test(tag)) {
        // empty or whitespace only
        console.info('[Manager] User removed tag');
        metadata.tag = undefined;
      } else {
        console.info('[Manager] User tagged', videoKey, 'with', tag);
        metadata.tag = tag;
      }

      const jsonString = JSON.stringify(metadata, null, 2);
      assert(this.cloudClient);
      await this.cloudClient.putJsonString(jsonString, jsonKey);
    } catch (error) {
      // Just log this and quietly swallow it. Nothing more we can do.
      console.warn('[Manager] Failed to tag', jsonKey, String(error));
    }
  };

  /**
   * Toggle protection on a video in the cloud.
   */
  private protectVideoCloud = async (videoKey: string) => {
    const jsonKey = videoKey.replace('mp4', 'json');

    try {
      const metadata = await this.getMetadataForVideoCloud(jsonKey);
      metadata.protected = !metadata.protected;

      console.info('[Manager] User toggled protection for', videoKey);
      console.info('[Manager] Protected attribute is now', metadata.protected);

      const jsonString = JSON.stringify(metadata, null, 2);
      assert(this.cloudClient);
      await this.cloudClient.putJsonString(jsonString, jsonKey);
    } catch (error) {
      // Just log this and quietly swallow it. Nothing more we can do.
      console.warn('[Manager] Failed to protect', jsonKey, String(error));
    }
  };
}
