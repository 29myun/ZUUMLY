const {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  session,
} = require("electron");
const fs = require("fs");
const path = require("path");

const isDev = !app.isPackaged;
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
// Snapshots are stored in the OS temp directory and cleaned up from renderer actions.
const SNAPSHOT_DIR = path.join(app.getPath("temp"), "screen-assist-snapshots");

function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Screen Assist",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.setContentProtection(true);

  if (isDev) {
    mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
}

function getMainWindow() {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
}

function hideWindowForCapture() {
  const mainWindow = getMainWindow();
  if (!mainWindow) return;

  // Hide without focus handoff during capture selection.
  mainWindow.setOpacity(0);
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
}

function restoreWindowAfterCapture() {
  const mainWindow = BrowserWindow.getAllWindows()[0];
  if (!mainWindow) return;

  mainWindow.setIgnoreMouseEvents(false);
  mainWindow.setOpacity(1);
  mainWindow.focus();
}

function ensureSnapshotDirectory() {
  if (!fs.existsSync(SNAPSHOT_DIR)) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  }
}

function resolveSnapshotPath(filePath) {
  if (!filePath) return null;

  const resolvedPath = path.resolve(filePath);
  const relativePath = path.relative(SNAPSHOT_DIR, resolvedPath);
  // Prevent path traversal by allowing reads/deletes only inside SNAPSHOT_DIR.
  const insideSnapshotDir =
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath);

  return insideSnapshotDir ? resolvedPath : null;
}

function saveSnapshotFromDataUrl(dataUrl) {
  ensureSnapshotDirectory();

  const filePath = path.join(SNAPSHOT_DIR, `snapshot-${Date.now()}.png`);
  const base64Data = dataUrl.replace(/^data:image\/png;base64,/, "");
  fs.writeFileSync(filePath, base64Data, "base64");

  return filePath;
}

function readSnapshotAsDataUrl(filePath) {
  const safePath = resolveSnapshotPath(filePath);
  if (!safePath || !fs.existsSync(safePath)) return null;

  const buffer = fs.readFileSync(safePath);
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

function deleteSnapshotFile(filePath) {
  const safePath = resolveSnapshotPath(filePath);
  if (!safePath) return;
  if (fs.existsSync(safePath)) fs.unlinkSync(safePath);
}

function registerIpcHandlers() {
  ipcMain.handle("list-sources", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: true,
    });

    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL(),
    }));
  });

  ipcMain.handle("minimize-window", () => {
    hideWindowForCapture();
  });

  ipcMain.handle("restore-window", () => {
    restoreWindowAfterCapture();
  });

  ipcMain.handle("save-snapshot", (_event, dataUrl) => {
    return saveSnapshotFromDataUrl(dataUrl);
  });

  ipcMain.handle("read-snapshot", (_event, filePath) => {
    return readSnapshotAsDataUrl(filePath);
  });

  ipcMain.handle("delete-snapshot", (_event, filePath) => {
    deleteSnapshotFile(filePath);
  });
}

function registerDisplayMediaHandler() {
  // Auto-select the first screen so renderer getDisplayMedia works without a native picker.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      callback({ video: sources[0] || null });
    },
  );
}

async function bootstrap() {
  await app.whenReady();

  // Register process-level handlers before opening the window.
  registerIpcHandlers();
  registerDisplayMediaHandler();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}

void bootstrap();

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});