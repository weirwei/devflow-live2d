import { spawn, spawnSync } from "child_process";
import fs from "fs";
import { homedir } from "os";
import path from "path";

const PROTOCOL_PORT = 4317;
const PROTOCOL_HOST = "127.0.0.1";
const CLAUDE_PLUGIN_NAME = "devflow-protocol";
const CLAUDE_MCP_SERVER_NAME = "devflow-protocol";
const PROCESS_STOP_TIMEOUT_MS = 3000;
const STARTUP_HEALTH_TIMEOUT_MS = 8000;
const STARTUP_HEALTH_INTERVAL_MS = 250;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function removeIfExists(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function setExecutable(filePath) {
  try {
    fs.chmodSync(filePath, 0o755);
  } catch {}
}

function appendProcessOutput(stream, prefix, data) {
  if (!stream || !data || data.length === 0) return;
  const text = Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
  if (!text) return;
  const normalized = text.endsWith("\n") ? text : `${text}\n`;
  stream.write(`[${new Date().toISOString()}] ${prefix}${normalized}`);
}

export class DesktopServiceRuntime {
  constructor({ app, rootDir, protocolBaseUrl }) {
    this.app = app;
    this.rootDir = rootDir;
    this.protocolBaseUrl = protocolBaseUrl;
    this.processes = {
      protocol: null,
      codexBridge: null,
    };
    this.lastErrors = {
      protocol: "",
      codexBridge: "",
    };
    this.hostCapabilities = this.getHostCapabilities();
    this.claudePluginInstalled = this.isClaudeGlobalPluginInstalled();
  }

  getBundleRoot() {
    if (this.app.isPackaged) {
      return path.join(process.resourcesPath, "bundle", "devflow-protocol-go");
    }
    return path.resolve(this.rootDir, "..", "devflow-protocol-go");
  }

  getProtocolSourceRoot() {
    return this.getBundleRoot();
  }

  getProtocolBinary() {
    return path.join(this.getProtocolSourceRoot(), "bin", "devflow-protocol");
  }

  getCodexBridgeScript() {
    return path.join(this.getProtocolSourceRoot(), "claude-plugin", "codex", "bridge_rollout.py");
  }

  getClaudePluginSourceRoot() {
    return path.join(this.getBundleRoot(), "claude-plugin");
  }

  getClaudePluginInstallRoot() {
    return path.join(homedir(), ".claude", "plugins", CLAUDE_PLUGIN_NAME);
  }

  getClaudeSettingsPath() {
    return path.join(homedir(), ".claude", "settings.json");
  }

  getRuntimeDataRoot() {
    return path.join(this.app.getPath("userData"), "runtime");
  }

  getDevflowStateRoot() {
    return path.join(homedir(), ".devflow", "live2d");
  }

  getProtocolDataDir() {
    return path.join(this.getRuntimeDataRoot(), "devflow-protocol");
  }

  getLogDir() {
    return path.join(this.getRuntimeDataRoot(), "logs");
  }

  getProtocolLogPath() {
    return path.join(this.getLogDir(), "devflow-protocol.log");
  }

  getCodexBridgeLogPath() {
    return path.join(this.getLogDir(), "codex-bridge.log");
  }

  getCodexBridgeStatePath() {
    return path.join(this.getRuntimeDataRoot(), "codex-bridge-state.json");
  }

  getPluginStateDir() {
    return path.join(this.getClaudePluginInstallRoot(), ".devflow-plugin-state");
  }

  getHostCapabilities() {
    return {
      bash: this.resolveCommandBinary("bash"),
      node: this.resolveCommandBinary("node"),
      python3: this.resolveCommandBinary("python3"),
    };
  }

  resolveCommandBinary(command) {
    // Use login shell to resolve command path, so that PATH from
    // shell profile (nvm, homebrew, etc.) is available even in
    // packaged macOS .app where GUI processes get a minimal PATH.
    const shell = process.env.SHELL || "/bin/zsh";
    const result = spawnSync(shell, ["-lc", `which ${command}`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) return "";
    return String(result.stdout || "").trim();
  }

  getStatus() {
    const capabilities = this.hostCapabilities;
    return {
      protocol: {
        running: Boolean(this.processes.protocol),
        pid: this.processes.protocol?.pid || null,
        logPath: this.getProtocolLogPath(),
        lastError: this.lastErrors.protocol || "",
      },
      codexBridge: {
        running: Boolean(this.processes.codexBridge),
        pid: this.processes.codexBridge?.pid || null,
        logPath: this.getCodexBridgeLogPath(),
        lastError: this.lastErrors.codexBridge || "",
      },
      claudePlugin: {
        installed: this.claudePluginInstalled,
        installRoot: this.getClaudePluginInstallRoot(),
        settingsPath: this.getClaudeSettingsPath(),
      },
      capabilities: {
        bash: Boolean(capabilities.bash),
        node: Boolean(capabilities.node),
        python3: Boolean(capabilities.python3),
      },
    };
  }

  ensurePathsForRuntime() {
    ensureDir(this.getProtocolDataDir());
    ensureDir(this.getLogDir());
  }

  verifySourceExists(filePath, label) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`${label} not found: ${filePath}`);
    }
  }

  createLogStream(logPath) {
    ensureDir(path.dirname(logPath));
    return fs.createWriteStream(logPath, { flags: "a" });
  }

  spawnManagedProcess({ key, command, args, cwd, env, logPath, label }) {
    if (this.processes[key]) return this.processes[key];

    const logStream = this.createLogStream(logPath);
    appendProcessOutput(logStream, `${label} `, `starting: ${command} ${args.join(" ")}`);

    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (data) => appendProcessOutput(logStream, `${label} `, data));
    child.stderr.on("data", (data) => appendProcessOutput(logStream, `${label} `, data));
    child.on("error", (error) => {
      this.lastErrors[key] = error instanceof Error ? error.message : String(error);
      appendProcessOutput(logStream, `${label} error `, this.lastErrors[key]);
    });
    child.on("exit", (code, signal) => {
      appendProcessOutput(
        logStream,
        `${label} `,
        `exited code=${code ?? "null"} signal=${signal ?? "null"}`,
      );
      logStream.end();
      if (this.processes[key]?.pid === child.pid) {
        this.processes[key] = null;
      }
    });

    this.processes[key] = child;
    this.lastErrors[key] = "";
    return child;
  }

  async waitForProtocolHealth(timeoutMs = STARTUP_HEALTH_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (!this.processes.protocol) {
        throw new Error(this.lastErrors.protocol || "devflow-protocol exited before becoming healthy");
      }

      try {
        const response = await fetch(`${this.protocolBaseUrl.replace(/\/+$/, "")}/health`);
        if (response.ok) return true;
      } catch {}

      await sleep(STARTUP_HEALTH_INTERVAL_MS);
    }

    throw new Error(`devflow-protocol did not become healthy within ${timeoutMs}ms`);
  }

  async startProtocol() {
    if (this.processes.protocol) return this.getStatus().protocol;

    const protocolBinary = this.getProtocolBinary();
    this.verifySourceExists(protocolBinary, "devflow-protocol binary");
    this.ensurePathsForRuntime();

    this.spawnManagedProcess({
      key: "protocol",
      command: protocolBinary,
      args: [],
      cwd: this.getProtocolSourceRoot(),
      env: {
        HOST: PROTOCOL_HOST,
        PORT: String(PROTOCOL_PORT),
        DEVFLOW_PROTOCOL_DIR: this.getProtocolDataDir(),
      },
      logPath: this.getProtocolLogPath(),
      label: "protocol",
    });

    try {
      await this.waitForProtocolHealth();
    } catch (error) {
      await this.stopProtocol();
      this.lastErrors.protocol = error instanceof Error ? error.message : String(error);
      throw error;
    }

    return this.getStatus().protocol;
  }

  async stopManagedProcess(key) {
    const child = this.processes[key];
    if (!child) return false;

    const pid = child.pid;
    this.processes[key] = null;

    child.kill("SIGTERM");
    const deadline = Date.now() + PROCESS_STOP_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        return true;
      }
      await sleep(100);
    }

    try {
      process.kill(pid, "SIGKILL");
    } catch {}

    return true;
  }

  async stopProtocol() {
    await this.stopCodexBridge();
    return this.stopManagedProcess("protocol");
  }

  async restartProtocol() {
    await this.stopProtocol();
    return this.startProtocol();
  }

  async startCodexBridge() {
    if (this.processes.codexBridge) return this.getStatus().codexBridge;

    try {
      const bridgeScript = this.getCodexBridgeScript();
      this.verifySourceExists(bridgeScript, "Codex bridge script");
      this.ensurePathsForRuntime();

      const pythonBinary = this.hostCapabilities.python3;
      if (!pythonBinary) {
        throw new Error("Codex bridge requires python3");
      }

      if (!this.processes.protocol) {
        await this.startProtocol();
      }

      this.spawnManagedProcess({
        key: "codexBridge",
        command: pythonBinary,
        args: [
          bridgeScript,
          "--protocol-url",
          this.protocolBaseUrl,
          "--state-file",
          this.getCodexBridgeStatePath(),
        ],
        cwd: this.getProtocolSourceRoot(),
        env: {
          PYTHONUNBUFFERED: "1",
        },
        logPath: this.getCodexBridgeLogPath(),
        label: "codex-bridge",
      });

      this.lastErrors.codexBridge = "";
      return this.getStatus().codexBridge;
    } catch (error) {
      this.lastErrors.codexBridge = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async stopCodexBridge() {
    return this.stopManagedProcess("codexBridge");
  }

  async restartCodexBridge() {
    await this.stopCodexBridge();
    return this.startCodexBridge();
  }

  getRequiredPluginFiles() {
    return [
      ".claude-plugin",
      "hooks",
      "mcp",
      "scripts",
      "README.md",
      "package.json",
    ];
  }

  ensurePluginSourceReady() {
    const sourceRoot = this.getClaudePluginSourceRoot();
    for (const relativePath of this.getRequiredPluginFiles()) {
      this.verifySourceExists(path.join(sourceRoot, relativePath), `Plugin asset ${relativePath}`);
    }
  }

  copyClaudePluginFiles() {
    this.ensurePluginSourceReady();

    const sourceRoot = this.getClaudePluginSourceRoot();
    const targetRoot = this.getClaudePluginInstallRoot();
    ensureDir(path.dirname(targetRoot));
    removeIfExists(targetRoot);
    ensureDir(targetRoot);

    for (const relativePath of this.getRequiredPluginFiles()) {
      fs.cpSync(path.join(sourceRoot, relativePath), path.join(targetRoot, relativePath), {
        recursive: true,
        force: true,
      });
    }

    const executableFiles = [
      path.join(targetRoot, "mcp", "server.mjs"),
      path.join(targetRoot, "scripts", "control.sh"),
      path.join(targetRoot, "hooks", "post-tool-hook.sh"),
      path.join(targetRoot, "hooks", "pre-tool-hook.sh"),
      path.join(targetRoot, "hooks", "session-end-hook.sh"),
      path.join(targetRoot, "hooks", "session-start-hook.sh"),
      path.join(targetRoot, "hooks", "stop-hook.sh"),
      path.join(targetRoot, "hooks", "user-prompt-hook.sh"),
      path.join(targetRoot, "hooks", "_lib.sh"),
    ];

    for (const filePath of executableFiles) {
      if (fs.existsSync(filePath)) {
        setExecutable(filePath);
      }
    }

    const stateDir = this.getPluginStateDir();
    ensureDir(stateDir);
    fs.writeFileSync(path.join(stateDir, "enabled"), "");
  }

  loadClaudeSettings() {
    const settingsPath = this.getClaudeSettingsPath();
    const parsed = readJsonFile(settingsPath, {});
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  }

  saveClaudeSettings(settings) {
    writeJsonFile(this.getClaudeSettingsPath(), settings);
  }

  filterHookGroups(groups, pluginRoot) {
    if (!Array.isArray(groups)) return [];

    return groups.filter((group) => {
      const hooks = Array.isArray(group?.hooks) ? group.hooks : [];
      return hooks.every((hook) => {
        const command = typeof hook?.command === "string" ? hook.command : "";
        return !command.includes(pluginRoot);
      });
    });
  }

  buildClaudeHookCommand(fileName) {
    const bashBinary = this.resolveCommandBinary("bash") || "bash";
    return `${shellQuote(bashBinary)} ${shellQuote(path.join(this.getClaudePluginInstallRoot(), "hooks", fileName))}`;
  }

  updateClaudeSettingsForInstall() {
    const settings = this.loadClaudeSettings();
    const pluginRoot = this.getClaudePluginInstallRoot();
    const hookFiles = {
      SessionStart: "session-start-hook.sh",
      SessionEnd: "session-end-hook.sh",
      PreToolUse: "pre-tool-hook.sh",
      PostToolUse: "post-tool-hook.sh",
      Stop: "stop-hook.sh",
      UserPromptSubmit: "user-prompt-hook.sh",
    };

    settings.hooks = typeof settings.hooks === "object" && settings.hooks ? settings.hooks : {};

    for (const [eventName, fileName] of Object.entries(hookFiles)) {
      const currentGroups = this.filterHookGroups(settings.hooks[eventName], pluginRoot);
      currentGroups.push({
        hooks: [
          {
            type: "command",
            command: this.buildClaudeHookCommand(fileName),
          },
        ],
      });
      settings.hooks[eventName] = currentGroups;
    }

    settings.mcpServers =
      typeof settings.mcpServers === "object" && settings.mcpServers ? settings.mcpServers : {};
    const nodeBinary = this.resolveCommandBinary("node") || "node";
    settings.mcpServers[CLAUDE_MCP_SERVER_NAME] = {
      command: nodeBinary,
      args: [path.join(pluginRoot, "mcp", "server.mjs")],
      env: {
        DEVFLOW_PROTOCOL_URL: this.protocolBaseUrl,
      },
    };

    this.saveClaudeSettings(settings);
  }

  updateClaudeSettingsForUninstall() {
    const settings = this.loadClaudeSettings();
    const pluginRoot = this.getClaudePluginInstallRoot();

    if (typeof settings.hooks === "object" && settings.hooks) {
      for (const eventName of Object.keys(settings.hooks)) {
        settings.hooks[eventName] = this.filterHookGroups(settings.hooks[eventName], pluginRoot);
      }
    }

    if (typeof settings.mcpServers === "object" && settings.mcpServers) {
      delete settings.mcpServers[CLAUDE_MCP_SERVER_NAME];
    }

    this.saveClaudeSettings(settings);
  }

  isClaudeGlobalPluginInstalled() {
    const pluginRoot = this.getClaudePluginInstallRoot();
    const settingsPath = this.getClaudeSettingsPath();
    if (!fs.existsSync(pluginRoot) || !fs.existsSync(settingsPath)) return false;

    const settings = this.loadClaudeSettings();
    const hasMcp =
      typeof settings.mcpServers === "object" &&
      settings.mcpServers !== null &&
      Boolean(settings.mcpServers[CLAUDE_MCP_SERVER_NAME]);
    if (!hasMcp) return false;

    if (typeof settings.hooks !== "object" || !settings.hooks) return false;

    return Object.values(settings.hooks).some((groups) =>
      Array.isArray(groups) &&
      groups.some((group) =>
        Array.isArray(group?.hooks) &&
        group.hooks.some((hook) => String(hook?.command || "").includes(pluginRoot)),
      ),
    );
  }

  validatePluginInstallDependencies() {
    const capabilities = this.hostCapabilities;
    const missing = [];
    if (!capabilities.bash) missing.push("bash");
    if (!capabilities.node) missing.push("node");
    if (missing.length > 0) {
      throw new Error(`Claude plugin requires: ${missing.join(", ")}`);
    }
  }

  async installClaudeGlobalPlugin() {
    this.validatePluginInstallDependencies();
    this.copyClaudePluginFiles();
    this.updateClaudeSettingsForInstall();
    this.claudePluginInstalled = true;
    return {
      pluginRoot: this.getClaudePluginInstallRoot(),
      settingsPath: this.getClaudeSettingsPath(),
    };
  }

  async uninstallClaudeGlobalPlugin() {
    this.updateClaudeSettingsForUninstall();
    removeIfExists(this.getClaudePluginInstallRoot());
    this.claudePluginInstalled = false;
    return {
      pluginRoot: this.getClaudePluginInstallRoot(),
      settingsPath: this.getClaudeSettingsPath(),
    };
  }

  async shutdown() {
    await this.stopCodexBridge();
    await this.stopProtocol();
  }
}
