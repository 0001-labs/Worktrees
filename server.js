// Worktrees — local dashboard showing open git worktrees + commits across projects.
// Run: node server.js  →  http://localhost:4777

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const PORT = Number(process.env.PORT) || 4777;
const PROJECTS_FILE = path.join(__dirname, "projects.json");

const DEFAULT_PROJECTS = [
  { name: "0001", path: "/Users/joachim/0001/0001", color: "#d6cfc1" },
  { name: "Consistency", path: "/Users/joachim/0001/Consistency", color: "#a6d9c9" },
  { name: "Edge", path: "/Users/joachim/0001/Edge", color: "#c1b6dd" },
  { name: "DS one", path: "/Users/joachim/0001/DS one", color: "#e2acae" },
  { name: "Ezo", path: "/Users/joachim/0001/Ezo", color: "#c9d9a6" },
  { name: "Visual", path: "/Users/joachim/0001/Visual", color: "#dfaec9" },
  { name: "Link", path: "/Users/joachim/0001/Link", color: "#ded5a1" },
  { name: "Woodstock", path: "/Users/joachim/0001/Clients/Woodstock", color: "#a8d6ae" },
  { name: "Iroco", path: "/Users/joachim/0001/Clients/Iroco", color: "#b2bddd" },
  { name: "Thailand Tours", path: "/Users/joachim/Thailand Tours", color: "#debba1" },
  { name: "Nemprint", path: "/Users/joachim/Nemprint", color: "#abcfd9" },
  { name: "Tekstiltryk", path: "/Users/joachim/Tekstiltryk", color: "#dbb2d8" },
];

const PALETTE = [...new Set(DEFAULT_PROJECTS.map((p) => p.color))];

let projectsCache = { mtime: -1, list: DEFAULT_PROJECTS };
let pickingFolder = false;

function normalizeProjectPath(p) {
  return path.resolve(String(p || "").replace(/\/+$/, ""));
}

function sortProjects(list) {
  return list.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
}

function loadProjects() {
  try {
    const st = fs.statSync(PROJECTS_FILE);
    if (st.mtimeMs === projectsCache.mtime) return projectsCache.list;
    const raw = JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf8"));
    if (!Array.isArray(raw)) throw new Error("projects.json is not an array");
    const list = sortProjects(
      raw
        .filter((p) => p && p.name && p.path)
        .map((p) => ({
          name: String(p.name),
          path: normalizeProjectPath(p.path),
          color: p.color || PALETTE[0],
        }))
    );
    projectsCache = { mtime: st.mtimeMs, list };
    return list;
  } catch (err) {
    if (err.code !== "ENOENT") console.error("projects.json:", err.message);
    return sortProjects(
      projectsCache.list.length ? projectsCache.list : DEFAULT_PROJECTS.slice()
    );
  }
}

function saveProjects(list) {
  sortProjects(list);
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(list, null, 2) + "\n");
  const st = fs.statSync(PROJECTS_FILE);
  projectsCache = { mtime: st.mtimeMs, list };
}

function pickColor(name, used) {
  const unused = PALETTE.filter((c) => !used.has(c));
  if (unused.length) return unused[0];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body == null ? "" : JSON.stringify(body));
}

function chooseFolder() {
  return new Promise((resolve, reject) => {
    execFile(
      "osascript",
      ["-e", 'POSIX path of (choose folder with prompt "Add project")'],
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim().replace(/\/+$/, ""));
      }
    );
  });
}

// gh is slow and rate-limited; with the client polling every 10s, cache PR
// listings for two minutes per repo.
const prCache = new Map();
const ghTokenCache = new Map();

function ghUserForRemote(url) {
  // Jo4712 is the default gh account and cannot see Pankado-kk repos.
  return /github\.com[:/]Pankado-kk\//i.test(url || "") ? "JAS-Pankado" : "Jo4712";
}

function ghToken(user) {
  const hit = ghTokenCache.get(user);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    execFile("gh", ["auth", "token", "--user", user], (err, stdout) => {
      const token = err ? "" : stdout.trim();
      if (token) ghTokenCache.set(user, token);
      resolve(token);
    });
  });
}

async function listPRs(cwd) {
  const hit = prCache.get(cwd);
  if (hit && Date.now() - hit.at < 120000) return hit.prs;
  const remote = await git(cwd, ["remote", "get-url", "origin"]).catch(() => "");
  const token = await ghToken(ghUserForRemote(remote));
  return new Promise((resolve) => {
    execFile(
      "gh",
      ["pr", "list", "--state", "all", "--limit", "100", "--json", "number,url,headRefName,headRefOid,state,isDraft"],
      {
        cwd,
        maxBuffer: 1024 * 1024,
        env: token ? { ...process.env, GH_TOKEN: token } : process.env,
      },
      (err, stdout) => {
        let prs = [];
        if (!err) {
          try {
            prs = JSON.parse(stdout);
          } catch {}
        }
        prCache.set(cwd, { at: Date.now(), prs });
        resolve(prs);
      }
    );
  });
}

function git(cwd, args, extraEnv) {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        maxBuffer: 4 * 1024 * 1024,
        env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message || err)
            .trim()
            .split("\n")[0];
          reject(new Error(msg || String(err)));
        } else resolve(stdout);
      }
    );
  });
}

function parseWorktrees(porcelain) {
  const entries = [];
  let current = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice(9), branch: null, head: null, headFull: null, detached: false, prunable: false };
      entries.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.headFull = line.slice(5);
      current.head = line.slice(5, 12);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace("refs/heads/", "");
    } else if (line === "detached") {
      current.detached = true;
    } else if (line.startsWith("prunable")) {
      current.prunable = true;
    }
  }
  return entries;
}

function formatTimestamp(ms) {
  const d = new Date(ms);
  return (
    String(d.getDate()).padStart(2, "0") +
    " " +
    d.toLocaleString("en", { month: "short" }) +
    ", " +
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0")
  );
}

async function lastTouched(wtPath, statusOut) {
  const files = statusOut
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      let p = line.slice(3);
      const arrow = p.indexOf(" -> ");
      if (arrow !== -1) p = p.slice(arrow + 4);
      if (p.startsWith('"')) {
        try {
          p = JSON.parse(p);
        } catch {}
      }
      return p;
    });
  let max = 0;
  await Promise.all(
    files.map((f) =>
      fs.promises
        .stat(path.join(wtPath, f))
        .then((s) => {
          if (s.mtimeMs > max) max = s.mtimeMs;
        })
        .catch(() => {})
    )
  );
  return max ? formatTimestamp(max) : null;
}

async function worktreeDetails(wt, isMain, baseBranch) {
  // Main checkout: recent history. Feature worktrees: only commits the base
  // branch doesn't have, so shared history doesn't repeat in every worktree.
  // --no-merges: on the board a worktree lists only its real work; merge
  // commits still show in the project detail view.
  const ownLog =
    !isMain && baseBranch && wt.branch !== baseBranch
      ? ["log", "-n", "20", "--no-merges", baseBranch + "..HEAD", ...LOG_FORMAT]
      : ["log", "-n", "5", ...LOG_FORMAT];
  const [log, status] = await Promise.all([
    git(wt.path, ownLog).catch(() => ""),
    git(wt.path, ["status", "--porcelain"]).catch(() => ""),
  ]);
  wt.commits = parseCommits(log);
  wt.unique = !isMain;
  if (!isMain) {
    // If the branch name carries a deliverable ID (e.g. Mf42tC-3), show only
    // that deliverable's commits. Candidates are tried left to right so the
    // ID wins over ticket-style fragments like "ws-8464" later in the name.
    const candidates = [...(wt.branch || "").matchAll(/([A-Za-z0-9]+-\d+)/g)].map((m) => m[1]);
    for (const cand of candidates) {
      const exact = wt.commits.filter((c) =>
        c.subject.toLowerCase().includes(cand.toLowerCase())
      );
      const family = new RegExp("\\b" + cand.replace(/-\d+$/, "") + "-\\d+", "i");
      if (exact.length > 0 || wt.commits.some((c) => family.test(c.subject))) {
        wt.commits = exact;
        wt.deliverable = cand;
        break;
      }
    }
  }
  wt.dirty = status ? status.split("\n").filter(Boolean).length : 0;
  wt.lastTouched = wt.dirty > 0 ? await lastTouched(wt.path, status) : null;
  if (!isMain) {
    // A linked worktree's ".git" pointer file is written when the worktree is
    // created — its birthtime is the worktree's creation timestamp.
    wt.created = await fs.promises
      .stat(path.join(wt.path, ".git"))
      .then((s) => formatTimestamp(s.birthtimeMs || s.mtimeMs))
      .catch(() => null);
  }
  return wt;
}

async function projectData(project) {
  const result = { ...project, worktrees: [], error: null };
  try {
    const [porcelain, prs] = await Promise.all([
      git(project.path, ["worktree", "list", "--porcelain"]),
      listPRs(project.path),
    ]);
    // Keep the main checkout even if it is detached; drop leftover detached
    // HEAD trees (Claude/Codex, etc.) and prunable entries from the board.
    const worktrees = parseWorktrees(porcelain).filter(
      (wt, i) => i === 0 || (!wt.prunable && !wt.detached)
    );
    const baseBranch = worktrees[0] ? worktrees[0].branch : null;
    result.worktrees = await Promise.all(
      worktrees.map((wt, i) => worktreeDetails(wt, i === 0, baseBranch))
    );
    // Attach open PRs. A locally renamed branch (feat/Mf42tC-3-ws-8464-...)
    // still ends with the remote head's slug (ws-8464-...), so match on that;
    // commit-id matching would misfire on sibling branches at the same tip.
    for (const wt of result.worktrees) {
      if (!wt.branch) continue;
      const matches = prs.filter(
        (p) =>
          p.headRefName === wt.branch ||
          wt.branch.endsWith("-" + p.headRefName.replace(/^[a-z]+\//, ""))
      );
      // A branch can carry several PRs over time (closed, reopened); an open
      // one always wins, otherwise the newest (gh lists newest first).
      const pr = matches.find((p) => p.state === "OPEN") || matches[0];
      if (pr)
        wt.pr = {
          number: pr.number,
          url: pr.url,
          state: pr.state.toLowerCase(),
          draft: !!pr.isDraft,
        };
    }
  } catch (err) {
    result.error = /not a git repository/i.test(String(err.message))
      ? "No git repository"
      : String(err.message).split("\n")[0];
  }
  return result;
}

const LOG_FORMAT = [
  // format-local, not format: rows must render in the same timezone as the
  // client's formatStamp, or the value jumps the moment a scrub grabs it.
  "--date=format-local:%d %b, %H:%M",
  "--shortstat",
  "--pretty=format:%h\x1f%H\x1f%s\x1f%cr\x1f%an\x1f%cd\x1f%at",
];

function parseCommits(log) {
  // With --shortstat each commit is a \x1f-delimited line, optionally followed
  // by a "N files changed, X insertions(+), Y deletions(-)" line. Merge
  // commits emit no stat line, which is fine — they carry no work of their own.
  const commits = [];
  for (const line of (log || "").split("\n")) {
    if (line.includes("\x1f")) {
      const [hash, full, subject, when, author, date, at] = line.split("\x1f");
      commits.push({
        hash,
        full,
        subject,
        when,
        author,
        date,
        at: Number(at) || null,
        plus: null,
        minus: null,
      });
    } else if (commits.length > 0 && line.includes("changed")) {
      const c = commits[commits.length - 1];
      const ins = line.match(/(\d+) insertion/);
      const del = line.match(/(\d+) deletion/);
      c.plus = ins ? Number(ins[1]) : 0;
      c.minus = del ? Number(del[1]) : 0;
    }
  }
  return commits;
}

function clampUnix(at) {
  const min = Date.parse("2005-04-07T00:00:00Z") / 1000;
  // Hard ceiling at now, floored to the minute so the minute-rounding below
  // can never nudge a stamp past it — a commit is never from the future.
  const max = Math.floor(Date.now() / 60000) * 60;
  const n = Number(at);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(max, Math.max(min, n)) / 60) * 60;
}

async function assertKnownWorktree(folder) {
  const cwd = normalizeProjectPath(folder);
  const st = await fs.promises.stat(cwd).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error("Unknown path");
  const common = path.resolve(cwd, (await git(cwd, ["rev-parse", "--git-common-dir"])).trim());
  for (const project of loadProjects()) {
    try {
      const projectCommon = path.resolve(
        project.path,
        (await git(project.path, ["rev-parse", "--git-common-dir"])).trim()
      );
      if (projectCommon === common) return cwd;
    } catch {}
  }
  throw new Error("Path is not a tracked project");
}

// Every rebase renames commits, but an optimistic client may still hold
// pre-rebase hashes for rows it hasn't refreshed. Each rewrite records
// old hash → new hash for the whole branch so a stale target can be chased
// to the commit's current identity instead of mis-resolving.
const renamedCommits = new Map();
function resolveRenamed(hash) {
  let h = hash;
  for (let i = 0; renamedCommits.has(h) && i < 100; i++) h = renamedCommits.get(h);
  return h;
}

// Scrubbing rewrites history, which is only harmless while it is purely
// local. Refuse the main checkout, any branch that has been pushed (has an
// upstream), and any commit already reachable from a remote — rewriting
// those forces a force-push and breaks everyone who pulled them.
async function assertScrubbable(cwd, full) {
  const gitDir = path.resolve(cwd, (await git(cwd, ["rev-parse", "--git-dir"])).trim());
  const common = path.resolve(cwd, (await git(cwd, ["rev-parse", "--git-common-dir"])).trim());
  if (gitDir === common) throw new Error("Main checkout — scrub only in a local worktree");
  const upstream = (
    await git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]).catch(() => "")
  ).trim();
  if (upstream) throw new Error("Branch is pushed (" + upstream + ") — scrubbing is local-only");
  const onRemote = (await git(cwd, ["branch", "-r", "--contains", full]).catch(() => "")).trim();
  if (onRemote) throw new Error("Commit is already on a remote — scrubbing is local-only");
}

async function rewriteCommitDate(cwd, rev, unixSeconds) {
  const date = new Date(unixSeconds * 1000).toISOString();
  const full = (await git(cwd, ["rev-parse", resolveRenamed(rev)])).trim();
  await assertScrubbable(cwd, full);
  const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  const env = { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const gitDir = path.resolve(cwd, (await git(cwd, ["rev-parse", "--git-dir"])).trim());
  if (
    fs.existsSync(path.join(gitDir, "rebase-merge")) ||
    fs.existsSync(path.join(gitDir, "rebase-apply"))
  ) {
    throw new Error("Rebase already in progress");
  }

  const staged = (await git(cwd, ["diff", "--cached", "--name-only"])).trim();
  if (staged) throw new Error("Staged changes — commit or unstage first");

  // The rebase renames every commit from the target onward, so the target's
  // new hash has to be recovered by position: it sits the same number of
  // commits behind the new HEAD as it did behind the old one. The before /
  // after lists pair up the same way, which is what fills renamedCommits.
  const distance = Number((await git(cwd, ["rev-list", "--count", full + "..HEAD"])).trim());
  const before = (await git(cwd, ["rev-list", "-n", "1000", "HEAD"])).trim().split("\n");
  const rewrittenHash = async () => {
    const after = (await git(cwd, ["rev-list", "-n", "1000", "HEAD"])).trim().split("\n");
    if (after.length === before.length)
      for (let i = 0; i < before.length; i++)
        if (before[i] !== after[i]) renamedCommits.set(before[i], after[i]);
    return (await git(cwd, ["rev-parse", "HEAD~" + distance])).trim();
  };

  if (full === head) {
    await git(cwd, ["commit", "--amend", "--no-edit", "--date", date], env);
    return rewrittenHash();
  }

  const dirty = (await git(cwd, ["status", "--porcelain"])).trim();
  let stashed = false;
  if (dirty) {
    await git(cwd, ["stash", "push", "--include-untracked", "-m", "worktrees-date-scrub"]);
    stashed = true;
  }

  const seq = path.join(os.tmpdir(), "wt-seq-" + process.pid + ".js");
  fs.writeFileSync(
    seq,
    'const fs=require("fs");const f=process.argv[process.argv.length-1];fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(/^pick /,"edit "));\n'
  );

  let onto = "--root";
  try {
    onto = (await git(cwd, ["rev-parse", full + "^"])).trim();
  } catch {}

  try {
    const rebaseEnv = {
      GIT_SEQUENCE_EDITOR: "node " + seq,
      GIT_EDITOR: "true",
      EDITOR: "true",
      VISUAL: "true",
    };
    await git(
      cwd,
      onto === "--root"
        ? ["rebase", "-i", "--root", "--committer-date-is-author-date"]
        : ["rebase", "-i", onto, "--committer-date-is-author-date"],
      rebaseEnv
    );
    await git(cwd, ["commit", "--amend", "--no-edit", "--date", date], env);
    await git(cwd, ["rebase", "--continue"], { GIT_EDITOR: "true" });
  } catch (err) {
    await git(cwd, ["rebase", "--abort"]).catch(() => {});
    throw err;
  } finally {
    fs.unlink(seq, () => {});
    if (stashed) await git(cwd, ["stash", "pop"]).catch(() => {});
  }
  return rewrittenHash();
}

// One rewrite at a time, globally: the client fires these in the background
// now, and two rebases racing in the same repo corrupt each other.
let rewriteChain = Promise.resolve();
function serializeRewrite(job) {
  const run = rewriteChain.then(job, job);
  rewriteChain = run.catch(() => {});
  return run;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/log") {
    const project = loadProjects().find((p) => p.name === url.searchParams.get("project"));
    const skip = parseInt(url.searchParams.get("skip"), 10) || 0;
    const limit = Math.min(parseInt(url.searchParams.get("limit"), 10) || 100, 500);
    if (!project) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown project" }));
      return;
    }
    const grep = url.searchParams.get("grep");
    const requested = (url.searchParams.get("branch") || "").trim();
    if (requested.startsWith("-") || /\s/.test(requested)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid branch" }));
      return;
    }
    try {
      const logArgs = ["log", "-n", String(limit), "--skip", String(skip)];
      // --grep searches the whole message, so a deliverable ID like "Mf42tC-1"
      // matches whether it sits in the subject or a trailer.
      // Scope to real branches: --all would also sweep in filter-branch's
      // refs/original backups and show every commit twice.
      if (grep)
        logArgs.push("--grep", grep, "--regexp-ignore-case", "--branches", "--remotes", "--tags");
      const head = (await git(project.path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      const branch = requested || head;
      if (!grep) {
        if (branch !== head) logArgs.push(head + ".." + branch);
        else logArgs.push(branch);
      }
      const log = await git(project.path, [...logArgs, ...LOG_FORMAT]);
      const commits = parseCommits(log);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          branch: grep ? "all branches" : branch,
          grep: grep || null,
          commits,
          hasMore: commits.length === limit,
        })
      );
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err.message).split("\n")[0] }));
    }
    return;
  }

  if (url.pathname === "/api/commit-date" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 20000) req.destroy();
    });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const hash = String(payload.hash || "");
        const unix = clampUnix(payload.at);
        if (!/^[0-9a-f]{4,40}$/i.test(hash) || unix == null) {
          json(res, 400, { error: "Invalid hash or date" });
          return;
        }
        const cwd = await assertKnownWorktree(payload.path);
        const full = await serializeRewrite(() => rewriteCommitDate(cwd, hash, unix));
        json(res, 200, {
          ok: true,
          at: unix,
          date: formatTimestamp(unix * 1000),
          full,
          hash: full ? full.slice(0, 7) : undefined,
        });
      } catch (err) {
        json(res, 500, { error: String(err.message || err).split("\n")[0] });
      }
    });
    return;
  }

  if (url.pathname === "/api/data") {
    try {
      const projects = await Promise.all(loadProjects().map(projectData));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects, generatedAt: new Date().toISOString() }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  // Native macOS folder picker → append to projects.json (does not touch git).
  if (url.pathname === "/api/projects/pick" && (req.method === "POST" || req.method === "GET")) {
    if (pickingFolder) {
      json(res, 409, { error: "Folder picker already open" });
      return;
    }
    pickingFolder = true;
    try {
      const chosen = await chooseFolder();
      const folder = normalizeProjectPath(chosen);
      const st = await fs.promises.stat(folder).catch(() => null);
      if (!st || !st.isDirectory()) {
        json(res, 400, { error: "Folder does not exist" });
        return;
      }
      const list = loadProjects();
      if (list.some((p) => p.path === folder)) {
        json(res, 200, { projects: list, duplicate: true });
        return;
      }
      const name = path.basename(folder);
      const used = new Set(list.map((p) => p.color));
      list.push({ name, path: folder, color: pickColor(name, used) });
      saveProjects(list);
      json(res, 200, { projects: list });
    } catch {
      // User cancelled the dialog — osascript exits non-zero.
      res.writeHead(204);
      res.end();
    } finally {
      pickingFolder = false;
    }
    return;
  }

  // Remove from the dashboard list only — never deletes the repo on disk.
  if (url.pathname === "/api/projects" && (req.method === "DELETE" || req.method === "POST")) {
    const rawPath = url.searchParams.get("path");
    if (!rawPath) {
      json(res, 400, { error: "Missing path" });
      return;
    }
    const folder = normalizeProjectPath(rawPath);
    const list = loadProjects();
    const next = list.filter((p) => p.path !== folder);
    if (next.length === list.length) {
      json(res, 404, { error: "Unknown project" });
      return;
    }
    saveProjects(next);
    json(res, 200, { projects: next });
    return;
  }
  // Local-only helper: accepts a PNG data URL and stores it as the board
  // background (used to pull rendered artwork out of design tools).
  if (url.pathname === "/api/background" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 30 * 1024 * 1024) req.destroy();
    });
    req.on("end", () => {
      const m = body.match(/^data:image\/png;base64,(.+)$/s);
      if (!m) {
        res.writeHead(400);
        res.end("expected a PNG data URL");
        return;
      }
      fs.writeFile(path.join(__dirname, "background-a.png"), Buffer.from(m[1], "base64"), (err) => {
        res.writeHead(err ? 500 : 200);
        res.end(err ? String(err) : "ok");
      });
    });
    return;
  }
  if (/^\/background-[a-d]\.png$/.test(url.pathname)) {
    fs.readFile(path.join(__dirname, url.pathname.slice(1)), (err, img) => {
      if (err) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(img);
    });
    return;
  }
  fs.readFile(path.join(__dirname, "index.html"), (err, html) => {
    if (err) {
      res.writeHead(500);
      res.end("index.html missing");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
});

server.listen(PORT, () => {
  console.log(`Worktrees dashboard on http://localhost:${PORT}`);
});
