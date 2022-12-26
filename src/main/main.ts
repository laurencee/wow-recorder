/* eslint global-require: off, no-console: off, promise/always-return: off */
import path from 'path';

import {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  dialog,
  Tray,
  Menu,
} from 'electron';

import {
  resolveHtmlPath,
  loadAllVideos,
  deleteVideo,
  openSystemExplorer,
  toggleVideoProtected,
  setupApplicationLogging,
  getAvailableDisplays,
  checkAppUpdate,
} from './util';

const logDir = setupApplicationLogging();

console.log('[Main] App starting: version', app.getVersion());

import {
  pollWowProcess,
  runRetailRecordingTest,
  runClassicRecordingTest,
  makeRetailHandler,
  makeClassicHandler,
} from './logutils';

const obsRecorder = require('./obsRecorder');

import { Recorder, RecorderOptionsType } from './recorder';
import { getAvailableAudioInputDevices, getAvailableAudioOutputDevices } from './obsAudioDeviceUtils';
import { RecStatus, VideoPlayerSettings } from './types';
import ConfigService from './ConfigService';
import CombatLogParser from '../parsing/CombatLogParser';
import { getObsAvailableRecEncoders, getObsResolutions } from './obsRecorder';
import RetailLogHandler from 'parsing/RetailLogHandler';
import ClassicLogHandler from 'parsing/ClassicLogHandler';

let retailHandler: RetailLogHandler;
let classicHandler: ClassicLogHandler;
let recorder: Recorder;
let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray = null;

/**
 * Guard against any UnhandledPromiseRejectionWarnings. If OBS isn't behaving
 * as expected then it's better to crash the app. See:
 * - https://nodejs.org/api/process.html#process_event_unhandledrejection.
 * - https://nodejs.org/api/process.html#event-unhandledrejection
 */
process.on('unhandledRejection', (reason: Error) => {
  console.error('UnhandledPromiseRejectionWarning:', reason);

  // If the mainWindow exists, open a pretty dialog box.
  // If not, throw it as a generic JavaScript error.
  if (mainWindow) {
    mainWindow.webContents.send('fatalError', reason.stack);
  } else {
    throw new Error(reason.toString());
  }
});

/**
 * Load and return recorder options from the configuration store.
 * Does some basic sanity checking for default values.
 */
const loadRecorderOptions = (cfg: ConfigService): RecorderOptionsType => {
  return {
    /* eslint-disable prettier/prettier */
    storageDir:           cfg.get<string>('storagePath'),
    bufferStorageDir:     cfg.get<string>('bufferStoragePath'),
    maxStorage:           cfg.get<number>('maxStorage'),
    monitorIndex:         cfg.get<number>('monitorIndex'),
    audioInputDeviceId:   cfg.get<string>('audioInputDevice'),
    audioOutputDeviceId:  cfg.get<string>('audioOutputDevice'),
    minEncounterDuration: cfg.get<number>('minEncounterDuration'),
    obsBaseResolution:    cfg.get<string>('obsBaseResolution'),
    obsOutputResolution:  cfg.get<string>('obsOutputResolution'),
    obsFPS:               cfg.get<number>('obsFPS'),
    obsKBitRate:          cfg.get<number>('obsKBitRate'),
    obsCaptureMode:       cfg.get<string>('obsCaptureMode'),
    obsRecEncoder:        cfg.get<string>('obsRecEncoder'),
    /* eslint-enable prettier/prettier */
  };
};

/**
 * Create a settings store to handle the config.
 * This defaults to a path like:
 *   - (prod) "C:\Users\alexa\AppData\Roaming\WarcraftRecorder\config-v2.json"
 *   - (dev)  "C:\Users\alexa\AppData\Roaming\Electron\config-v2.json"
 */
const cfg = ConfigService.getInstance();

cfg.on('change', (key: string, value: any) => {
  if (key === 'startUp') {
    const isStartUp = value === true;
    console.log('[Main] OS level set start-up behaviour:', isStartUp);

    app.setLoginItemSettings({
      openAtLogin: isStartUp,
    });
  }
});

// Default video player settings on app start
const videoPlayerSettings: VideoPlayerSettings = {
  muted: false,
  volume: 1,
};

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

if (isDebug) {
  require('electron-debug')();
}

const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions = ['REACT_DEVELOPER_TOOLS'];

  return installer
    .default(
      extensions.map((name) => installer[name]),
      forceDownload
    )
    .catch(console.log);
};

const RESOURCES_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'assets')
  : path.join(__dirname, '../../assets');

const getAssetPath = (...paths: string[]): string => {
  return path.join(RESOURCES_PATH, ...paths);
};

/**
 * Setup tray icon, menu and even listeners.
 */
const setupTray = () => {
  tray = new Tray(getAssetPath('./icon/small-icon.png'));

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open',
      click() {
        console.log('[Main] User clicked open on tray icon');
        if (mainWindow) mainWindow.show();
      },
    },
    {
      label: 'Quit',
      click() {
        console.log('[Main] User clicked close on tray icon');
        if (mainWindow) mainWindow.close();
      },
    },
  ]);

  tray.setToolTip('Warcraft Recorder');
  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    console.log('[Main] User double clicked tray icon');
    if (mainWindow) mainWindow.show();
  });
};

/**
 * Updates the status icon for the application.
 * @param status the status number
 */
const updateRecStatus = (status: RecStatus, reason = '') => {
  if (mainWindow !== null) {
    mainWindow.webContents.send('updateRecStatus', status, reason);
  }
};

/**
 * Create or reconfigure the recorder instance
 */
const makeRecorder = (): void => {
  if (!mainWindow) {
    console.error('[Main] No mainWindow defined when creating recorder');
    throw new Error('[Main] No mainWindow defined when creating recorder');
  }

  const recorderOpts = loadRecorderOptions(cfg);

  if (recorder) {
    recorder.reconfigure(mainWindow, recorderOpts);
  } else {
    recorder = new Recorder(mainWindow, recorderOpts);
  }
};

/**
 * Checks the app config.
 * @returns true if config is setup, false otherwise.
 */
const checkConfig = (): boolean => {
  if (mainWindow === null) {
    return false;
  }

  try {
    cfg.validate();
  } catch (error) {
    updateRecStatus(RecStatus.InvalidConfig, String(error));
    console.info('[Main] Config is bad: ', String(error));
    return false;
  }

  return true;
};

/**
 * Creates the main window.
 */
const createWindow = async () => {
  if (isDebug) {
    await installExtensions();
  }

  const appVersion = app.getVersion();

  mainWindow = new BrowserWindow({
    show: false,
    height: 1020 * 0.75,
    width: 1980 * 0.65,
    icon: getAssetPath('./icon/small-icon.png'),
    frame: false,
    title: `Warcraft Recorder v${appVersion}`,
    webPreferences: {
      nodeIntegration: true,
      webSecurity: false,
      // devTools: false,
      preload: app.isPackaged
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, '../../.erb/dll/preload.js'),
    },
  });

  mainWindow.loadURL(resolveHtmlPath('mainWindow.index.html'));

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) throw new Error('"mainWindow" is not defined');

    const initialStatus = checkConfig()
      ? RecStatus.WaitingForWoW
      : RecStatus.InvalidConfig;

    updateRecStatus(initialStatus);

    // This shows the correct version on a release build, not during development.
    mainWindow.webContents.send(
      'updateTitleBar',
      `Warcraft Recorder v${appVersion}`
    );

    const cfgStartMinimized = cfg.get<boolean>('startMinimized');

    if (!cfgStartMinimized) {
      mainWindow.show();
    }

    if (!checkConfig()) return;
    makeRecorder();

    const retailLogPath = cfg.getPath('retailLogPath');
    const classicLogPath = cfg.getPath('classicLogPath');

    if (retailLogPath) {
      retailHandler = makeRetailHandler(recorder, retailLogPath);
    }

    if (classicLogPath) {
      classicHandler = makeClassicHandler(recorder, classicLogPath);
    }

    pollWowProcess();
    checkAppUpdate(mainWindow);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  setupTray();

  // Open urls in the user's browser
  mainWindow.webContents.setWindowOpenHandler((edata) => {
    shell.openExternal(edata.url);
    return { action: 'deny' };
  });
};

/**
 * Creates the settings window, called on clicking the settings cog.
 */
const createSettingsWindow = async () => {
  if (isDebug) {
    await installExtensions();
  }

  settingsWindow = new BrowserWindow({
    show: false,
    width: 650,
    height: 525,
    resizable: process.env.NODE_ENV !== 'production',
    icon: getAssetPath('./icon/settings-icon.svg'),
    frame: false,
    webPreferences: {
      webSecurity: false,
      // devTools: false,
      preload: app.isPackaged
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, '../../.erb/dll/preload.js'),
    },
  });

  settingsWindow.loadURL(resolveHtmlPath('settings.index.html'));

  settingsWindow.on('ready-to-show', () => {
    if (!settingsWindow) {
      throw new Error('"settingsWindow" is not defined');
    }
    if (process.env.START_MINIMIZED) {
      settingsWindow.minimize();
    } else {
      settingsWindow.show();
    }
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  // Open urls in the user's browser
  settingsWindow.webContents.setWindowOpenHandler((edata) => {
    shell.openExternal(edata.url);
    return { action: 'deny' };
  });
};

const openPathDialog = (event: any, args: any) => {
  if (!settingsWindow) return;
  const setting = args[1];

  dialog
    .showOpenDialog(settingsWindow, { properties: ['openDirectory'] })
    .then((result) => {
      if (!result.canceled) {
        const selectedPath = result.filePaths[0];
        let validationResult = true;

        // Validate the path if it's a path for a log directory
        if (setting === 'retailLogPath' || setting === 'classicLogPath') {
          validationResult = CombatLogParser.validateLogPath(selectedPath);
        }

        event.reply('settingsWindow', [
          'pathSelected',
          setting,
          selectedPath,
          validationResult,
        ]);
      }
    })
    .catch((err) => {
      console.log(err);
    });
};

/**
 * mainWindow event listeners.
 */
ipcMain.on('mainWindow', (_event, args) => {
  if (mainWindow === null) return;

  if (args[0] === 'minimize') {
    console.log('[Main] User clicked minimize');
    mainWindow.hide();
  }

  if (args[0] === 'resize') {
    console.log('[Main] User clicked resize');

    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }

  if (args[0] === 'quit') {
    console.log('[Main] User clicked quit');
    mainWindow.close();
  }
});

/**
 * settingsWindow event listeners.
 */
ipcMain.on('settingsWindow', (event, args) => {
  if (args[0] === 'create') {
    console.log('[Main] User clicked open settings');
    if (!settingsWindow) createSettingsWindow();
  }

  if (settingsWindow === null) return;

  if (args[0] === 'quit') {
    console.log('[Main] User closed settings');
    settingsWindow.close();
  }

  if (args[0] === 'update') {
    console.log('[Main] User updated settings');

    settingsWindow.once('closed', () => {
      if (!checkConfig()) return;
      updateRecStatus(RecStatus.WaitingForWoW);
      makeRecorder();

      const retailLogPath = cfg.getPath('retailLogPath');
      const classicLogPath = cfg.getPath('classicLogPath');

      if (retailLogPath) {
        retailHandler = makeRetailHandler(recorder, retailLogPath);
      }

      if (classicLogPath) {
        classicHandler = makeClassicHandler(recorder, classicLogPath);
      }

      pollWowProcess();
    });

    settingsWindow.close();
  }

  if (args[0] === 'openPathDialog') {
    openPathDialog(event, args);
    return;
  }

  if (args[0] === 'getAllDisplays') {
    event.returnValue = getAvailableDisplays();
    return;
  }

  if (args[0] === 'getObsAvailableResolutions') {
    if (!recorder) {
      event.returnValue = { Base: [], Output: [] };
      return;
    }

    event.returnValue = getObsResolutions();
    return;
  }

  if (args[0] === 'getObsAvailableRecEncoders') {
    if (!recorder) {
      event.returnValue = [];
      return;
    }

    const obsEncoders = getObsAvailableRecEncoders();
    const defaultEncoder = obsEncoders.at(-1);
    const encoderList = [{ id: 'auto', name: `Automatic (${defaultEncoder})` }];

    obsEncoders
      // We don't want people to be able to select 'none'.
      .filter((encoder) => encoder !== 'none')
      .forEach((encoder) => {
        const isHardwareEncoder =
          encoder.includes('amd') ||
          encoder.includes('nvenc') ||
          encoder.includes('qsv');

        const encoderType = isHardwareEncoder ? 'Hardware' : 'Software';

        encoderList.push({
          id: encoder,
          name: `${encoderType} (${encoder})`,
        });
      });

    event.returnValue = encoderList;
  }
});

/**
 * contextMenu event listeners.
 */
ipcMain.on('contextMenu', (_event, args) => {
  if (args[0] === 'delete') {
    const videoForDeletion = args[1];
    deleteVideo(videoForDeletion);
    if (mainWindow) mainWindow.webContents.send('refreshState');
  }

  if (args[0] === 'open') {
    const fileToOpen = args[1];
    openSystemExplorer(fileToOpen);
  }

  if (args[0] === 'save') {
    const videoToToggle = args[1];
    toggleVideoProtected(videoToToggle);
    if (mainWindow) mainWindow.webContents.send('refreshState');
  }

  if (args[0] === 'seekVideo') {
    const videoIndex = parseInt(args[1], 10);
    const seekTime = parseInt(args[2], 10);

    if (mainWindow) {
      mainWindow.webContents.send('seekVideo', videoIndex, seekTime);
    }
  }
});

/**
 * logPath event listener.
 */
ipcMain.on('logPath', (_event, args) => {
  if (args[0] === 'open') {
    openSystemExplorer(logDir);
  }
});

/**
 * openURL event listener.
 */
ipcMain.on('openURL', (event, args) => {
  event.preventDefault();
  require('electron').shell.openExternal(args[0]);
});

/**
 * Get the list of video files and their state.
 */
ipcMain.handle('getVideoState', async () =>
  loadAllVideos(cfg.get<string>('storagePath'))
);

ipcMain.on('getAudioDevices', (event) => {
  // We can only get this information if the recorder (OBS) has been
  // initialized and that only happens when the storage directory has
  // been configured.
  if (!recorder) {
    event.returnValue = { input: [], output: [] };
    return;
  }

  event.returnValue = {
    input: getAvailableAudioInputDevices(),
    output: getAvailableAudioOutputDevices(),
  };
});

/**
 * Set/Get global video player settings
 */
ipcMain.on('videoPlayerSettings', (event, args) => {
  switch (args[0]) {
    case 'get':
      event.returnValue = videoPlayerSettings;
      break;

    case 'set':
      {
        const settings = args[1] as VideoPlayerSettings;
        videoPlayerSettings.muted = settings.muted;
        videoPlayerSettings.volume = settings.volume;
      }
      break;

    default:
      break;
  }
});

/**
 * Test button listener.
 */
ipcMain.on('test', (_event, args) => {
  if (!checkConfig()) return;

  if (retailHandler) {
    console.info('[Main] Running retail test');
    runRetailRecordingTest(Boolean(args[0]));
  } else if (classicHandler) {
    console.info('[Main] Running classic test');
    runClassicRecordingTest(Boolean(args[0]));
  }
});

/**
 * Handle when a user clicks the stop recording button.
 */
ipcMain.on('recorder', (_event, args) => {
  if (args[0] === 'stop') {
    console.log('[Main] Force stopping recording due to user request.');

    if (retailHandler && retailHandler.activity) {
      retailHandler.forceEndActivity(0, false);
      return;
    }

    if (classicHandler && classicHandler.activity) {
      classicHandler.forceEndActivity(0, false);
      return;
    }

    if (recorder) recorder.forceStop();
  }
});

/**
 * Shutdown the app if all windows closed.
 */
app.on('window-all-closed', () => {
  console.log('[Main] User closed app');
  if (recorder) recorder.cleanupBuffer(0);
  obsRecorder.shutdown();
  app.quit();
});

/**
 * App start-up.
 */
app
  .whenReady()
  .then(() => {
    console.log('[Main] App ready');
    const singleInstanceLock = app.requestSingleInstanceLock();

    if (!singleInstanceLock) {
      console.warn(
        '[Main] Blocked attempt to launch a second instance of the application'
      );
      app.quit();
    } else {
      createWindow();
    }
  })
  .catch(console.log);

export { recorder, retailHandler, classicHandler };
