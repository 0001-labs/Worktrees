// Worktrees — Electron shell. The whole app is the existing local server
// plus one BrowserWindow pointed at it; Electron contributes Chromium
// rendering, a dock icon, and a writable data directory.
const { app, BrowserWindow, shell } = require("electron");
const path = require("path");

// GUI apps launch with a bare PATH; git/gh/SetFile live in these.
process.env.PATH = [
  process.env.PATH,
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/Library/Developer/CommandLineTools/usr/bin",
].join(":");

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

function createWindow(port) {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: "Worktrees",
    backgroundColor: "#161616",
    webPreferences: { contextIsolation: true },
  });
  // PR links etc. belong in the real browser, not this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.loadURL("http://127.0.0.1:" + port);
  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(() => {
  // The server reads this at require time, so set it before requiring.
  process.env.WORKTREES_DATA_DIR = app.getPath("userData");
  const { server } = require(path.join(__dirname, "..", "server.js"));
  // Port 0 = any free port; never collides with a dev server on 4777.
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    createWindow(port);
    app.on("activate", () => {
      if (win === null) createWindow(port);
    });
  });
});

app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
