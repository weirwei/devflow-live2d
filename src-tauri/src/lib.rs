use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
};

const WINDOW_LABEL: &str = "main";
const STATE_EVENT: &str = "overlay-state";
const PREVIEW_EVENT: &str = "overlay:previewAvatarState";
const DEFAULT_PROTOCOL_BASE_URL: &str = "http://127.0.0.1:4317";
const SETTINGS_FILE_NAME: &str = "devflow-live2d-settings.json";
const DEVFLOW_CONFIG_FILE: &str = ".devflow/live2d/config.json";

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ModelInfo {
    id: String,
    name: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct RuntimeStatus {
    protocol_running: bool,
    protocol_pid: Option<u32>,
    protocol_log_path: String,
    protocol_last_error: String,
    codex_bridge_running: bool,
    codex_bridge_pid: Option<u32>,
    codex_bridge_log_path: String,
    codex_bridge_last_error: String,
    claude_plugin_installed: bool,
    has_bash: bool,
    has_node: bool,
    has_python3: bool,
}

struct ManagedChild {
    child: Child,
}

struct AppBackend {
    state: Value,
    models: Vec<ModelInfo>,
    tray: Option<TrayIcon>,
    protocol: Option<ManagedChild>,
    codex_bridge: Option<ManagedChild>,
    protocol_last_error: String,
    codex_bridge_last_error: String,
}

type BackendState = Mutex<AppBackend>;

fn home_dir() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf()
}

fn default_state() -> Value {
    json!({
        "protocolBaseUrl": DEFAULT_PROTOCOL_BASE_URL,
        "clickThrough": false,
        "alwaysOnTop": true,
        "allWorkspaces": true,
        "hidden": false,
        "panelCollapsed": true,
        "codexBridgeEnabled": false,
        "selectedModelId": "nito",
        "avatarTuning": { "scale": 100, "offsetX": 0, "offsetY": 0 },
        "personaDialogue": {
            "enabled": false,
            "provider": "openai-compatible",
            "apiUrl": "",
            "apiKey": "",
            "model": "",
            "timeoutMs": 8000
        },
        "windowBounds": { "x": 0, "y": 0, "width": 420, "height": 720 }
    })
}

fn clamp_number(value: Option<f64>, fallback: f64, min: f64, max: f64) -> f64 {
    value.unwrap_or(fallback).clamp(min, max)
}

fn merge_value(base: &mut Value, patch: &Value) {
    match (base, patch) {
        (Value::Object(base_map), Value::Object(patch_map)) => {
            for (key, value) in patch_map {
                merge_value(base_map.entry(key).or_insert(Value::Null), value);
            }
        }
        (base_slot, patch_value) => {
            *base_slot = patch_value.clone();
        }
    }
}

fn normalize_state(mut state: Value, models: &[ModelInfo]) -> Value {
    let default = default_state();
    merge_value(&mut state, &json!({}));

    let selected = state
        .get("selectedModelId")
        .and_then(Value::as_str)
        .unwrap_or("nito");
    let selected = models
        .iter()
        .find(|model| model.id == selected)
        .or_else(|| models.first())
        .map(|model| model.id.clone())
        .unwrap_or_else(|| "nito".to_string());
    state["selectedModelId"] = Value::String(selected);

    let tuning = state.get("avatarTuning").cloned().unwrap_or(default["avatarTuning"].clone());
    state["avatarTuning"] = json!({
        "scale": clamp_number(tuning.get("scale").and_then(Value::as_f64), 100.0, 50.0, 150.0),
        "offsetX": clamp_number(tuning.get("offsetX").and_then(Value::as_f64), 0.0, -220.0, 220.0),
        "offsetY": clamp_number(tuning.get("offsetY").and_then(Value::as_f64), 0.0, -220.0, 220.0)
    });

    if state.get("protocolBaseUrl").and_then(Value::as_str).unwrap_or("").trim().is_empty() {
        state["protocolBaseUrl"] = Value::String(DEFAULT_PROTOCOL_BASE_URL.to_string());
    }

    state
}

fn read_json(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, serde_json::to_string_pretty(value).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(SETTINGS_FILE_NAME))
}

fn persona_config_path() -> PathBuf {
    home_dir().join(DEVFLOW_CONFIG_FILE)
}

fn load_models() -> Vec<ModelInfo> {
    let root = project_root();
    let paths = [
        "assets/live2d/models/nito-runtime/nito.live2d.json",
        "assets/live2d/models/nito-runtime/nico.live2d.json",
        "assets/live2d/models/nito-runtime/ni-j.live2d.json",
        "assets/live2d/models/nito-runtime/nipsilon.live2d.json",
        "assets/live2d/models/nito-runtime/nietzsche.live2d.json",
    ];

    let mut models = Vec::new();
    for relative in paths {
        let Some(json) = read_json(&root.join(relative)) else {
            continue;
        };
        if json.get("enabled").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let model = json.get("model").unwrap_or(&Value::Null);
        let id = json
            .get("id")
            .or_else(|| model.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("nito")
            .to_string();
        let name = json
            .get("name")
            .or_else(|| model.get("name"))
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_string();
        models.push(ModelInfo { id, name });
    }

    if models.is_empty() {
        models.push(ModelInfo {
            id: "nito".to_string(),
            name: "Nito".to_string(),
        });
    }
    models
}

fn public_state(app: &AppHandle, backend: &AppBackend) -> Value {
    let mut state = backend.state.clone();
    let selected = state.get("selectedModelId").and_then(Value::as_str).unwrap_or("nito");
    let selected_model = backend
        .models
        .iter()
        .find(|model| model.id == selected)
        .or_else(|| backend.models.first())
        .cloned();
    state["selectedModel"] = serde_json::to_value(selected_model).unwrap_or(Value::Null);
    state["platform"] = Value::String(std::env::consts::OS.to_string());
    state["focused"] = Value::Bool(false);
    state["runtimeStatus"] = serde_json::to_value(runtime_status(app, backend)).unwrap_or(Value::Null);

    if let Some(persona) = state.get_mut("personaDialogue").and_then(Value::as_object_mut) {
        let configured = persona
            .get("apiKey")
            .and_then(Value::as_str)
            .map(|key| !key.trim().is_empty())
            .unwrap_or(false)
            || !std::env::var("OPENAI_API_KEY").unwrap_or_default().trim().is_empty();
        persona.remove("apiKey");
        persona.insert("configured".to_string(), Value::Bool(configured));
    }

    state
}

fn broadcast_state(app: &AppHandle) {
    if let Some(state) = app.try_state::<BackendState>() {
        if let Ok(backend) = state.lock() {
            let _ = app.emit(STATE_EVENT, public_state(app, &backend));
        }
    }
}

fn apply_window_state(app: &AppHandle, state: &Value) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let hidden = state.get("hidden").and_then(Value::as_bool).unwrap_or(false);
    if hidden {
        let _ = window.hide();
    } else {
        let _ = window.show();
    }
    let _ = window.set_always_on_top(state.get("alwaysOnTop").and_then(Value::as_bool).unwrap_or(true));
    let _ = window.set_skip_taskbar(true);
    let _ = window.set_ignore_cursor_events(state.get("clickThrough").and_then(Value::as_bool).unwrap_or(false));
}

fn persist_state(app: &AppHandle, backend: &AppBackend) -> Result<(), String> {
    write_json(&settings_path(app)?, &backend.state)?;
    let persona = backend
        .state
        .get("personaDialogue")
        .cloned()
        .unwrap_or_else(|| json!({}));
    write_json(&persona_config_path(), &json!({ "personaDialogue": persona }))?;
    Ok(())
}

fn runtime_data_root(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| home_dir().join("Library/Application Support/com.devflow.live2d"))
        .join("runtime")
}

fn log_dir(app: &AppHandle) -> PathBuf {
    runtime_data_root(app).join("logs")
}

fn protocol_log_path(app: &AppHandle) -> PathBuf {
    log_dir(app).join("devflow-protocol.log")
}

fn codex_log_path(app: &AppHandle) -> PathBuf {
    log_dir(app).join("codex-bridge.log")
}

fn resolve_command(command: &str) -> String {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    Command::new(shell)
        .args(["-lc", &format!("which {command}")])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|path| !path.is_empty())
        .unwrap_or_default()
}

fn protocol_binary(_app: &AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        project_root().join("../devflow-protocol-go/bin/devflow-protocol")
    } else {
        std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(|parent| parent.join("devflow-protocol")))
            .unwrap_or_else(|| PathBuf::from("devflow-protocol"))
    }
}

fn claude_plugin_source(app: &AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        project_root().join("../devflow-protocol-go/claude-plugin")
    } else {
        app.path()
            .resolve("bundle/devflow-protocol-go/claude-plugin", tauri::path::BaseDirectory::Resource)
            .unwrap_or_else(|_| PathBuf::from("bundle/devflow-protocol-go/claude-plugin"))
    }
}

fn codex_bridge_script(app: &AppHandle) -> PathBuf {
    claude_plugin_source(app).join("codex/bridge_rollout.py")
}

fn append_log(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let line = format!("[{}] {text}\n", chrono_like_timestamp());
    let _ = fs::OpenOptions::new().create(true).append(true).open(path).and_then(|mut file| {
        use std::io::Write;
        file.write_all(line.as_bytes())
    });
}

fn chrono_like_timestamp() -> String {
    let output = Command::new("date").arg("-u").arg("+%Y-%m-%dT%H:%M:%SZ").output();
    output
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "now".to_string())
}

fn start_protocol(app: &AppHandle, backend: &mut AppBackend) -> Result<(), String> {
    if backend.protocol.is_some() {
        return Ok(());
    }
    let bin = protocol_binary(app);
    if !bin.exists() {
        backend.protocol_last_error = format!("devflow-protocol not found: {}", bin.display());
        return Err(backend.protocol_last_error.clone());
    }
    let data_dir = runtime_data_root(app).join("devflow-protocol");
    fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    let log_path = protocol_log_path(app);
    append_log(&log_path, &format!("protocol starting: {}", bin.display()));
    let stdout = fs::OpenOptions::new().create(true).append(true).open(&log_path).map_err(|e| e.to_string())?;
    let stderr = stdout.try_clone().map_err(|e| e.to_string())?;
    let child = Command::new(&bin)
        .env("HOST", "127.0.0.1")
        .env("PORT", "4317")
        .env("DEVFLOW_PROTOCOL_DIR", &data_dir)
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|error| error.to_string())?;
    backend.protocol = Some(ManagedChild { child });
    backend.protocol_last_error.clear();
    Ok(())
}

fn stop_child(child: &mut Option<ManagedChild>) {
    if let Some(mut managed) = child.take() {
        let _ = managed.child.kill();
        let _ = managed.child.wait();
    }
}

fn start_codex_bridge(app: &AppHandle, backend: &mut AppBackend) -> Result<(), String> {
    if backend.codex_bridge.is_some() {
        return Ok(());
    }
    start_protocol(app, backend)?;
    let python = resolve_command("python3");
    if python.is_empty() {
        backend.codex_bridge_last_error = "Codex bridge requires python3".to_string();
        return Err(backend.codex_bridge_last_error.clone());
    }
    let script = codex_bridge_script(app);
    if !script.exists() {
        backend.codex_bridge_last_error = format!("Codex bridge script not found: {}", script.display());
        return Err(backend.codex_bridge_last_error.clone());
    }
    let log_path = codex_log_path(app);
    let stdout = fs::OpenOptions::new().create(true).append(true).open(&log_path).map_err(|e| e.to_string())?;
    let stderr = stdout.try_clone().map_err(|e| e.to_string())?;
    let child = Command::new(python)
        .arg(script)
        .arg("--protocol-url")
        .arg(DEFAULT_PROTOCOL_BASE_URL)
        .arg("--state-file")
        .arg(runtime_data_root(app).join("codex-bridge-state.json"))
        .arg("--backfill-recent-minutes")
        .arg("20")
        .env("PYTHONUNBUFFERED", "1")
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|error| error.to_string())?;
    backend.codex_bridge = Some(ManagedChild { child });
    backend.codex_bridge_last_error.clear();
    Ok(())
}

fn claude_plugin_install_root() -> PathBuf {
    home_dir().join(".claude/plugins/devflow-protocol")
}

fn claude_settings_path() -> PathBuf {
    home_dir().join(".claude/settings.json")
}

fn is_claude_installed() -> bool {
    let plugin_root = claude_plugin_install_root();
    let Some(settings) = read_json(&claude_settings_path()) else {
        return false;
    };
    let has_mcp = settings
        .pointer("/mcpServers/devflow-protocol")
        .is_some();
    has_mcp && plugin_root.exists()
}

fn shell_quote(value: &Path) -> String {
    format!("'{}'", value.display().to_string().replace('\'', "'\\''"))
}

fn filter_hook_groups(groups: &Value, plugin_root: &Path) -> Value {
    let Some(groups) = groups.as_array() else {
        return json!([]);
    };
    let plugin_root = plugin_root.display().to_string();
    let filtered: Vec<Value> = groups
        .iter()
        .filter(|group| {
            let hooks = group.get("hooks").and_then(Value::as_array).cloned().unwrap_or_default();
            hooks.iter().all(|hook| {
                !hook
                    .get("command")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .contains(&plugin_root)
            })
        })
        .cloned()
        .collect();
    Value::Array(filtered)
}

fn update_claude_settings_for_install() -> Result<(), String> {
    let plugin_root = claude_plugin_install_root();
    let mut settings = read_json(&claude_settings_path()).unwrap_or_else(|| json!({}));
    if !settings.is_object() {
        settings = json!({});
    }
    if !settings.get("hooks").is_some_and(Value::is_object) {
        settings["hooks"] = json!({});
    }
    let bash = resolve_command("bash");
    let bash = if bash.is_empty() { PathBuf::from("bash") } else { PathBuf::from(bash) };
    let hook_files = [
        ("SessionStart", "session-start-hook.sh"),
        ("SessionEnd", "session-end-hook.sh"),
        ("PreToolUse", "pre-tool-hook.sh"),
        ("PostToolUse", "post-tool-hook.sh"),
        ("Stop", "stop-hook.sh"),
        ("UserPromptSubmit", "user-prompt-hook.sh"),
    ];
    for (event_name, file_name) in hook_files {
        let mut groups = filter_hook_groups(&settings["hooks"][event_name], &plugin_root)
            .as_array()
            .cloned()
            .unwrap_or_default();
        groups.push(json!({
            "hooks": [{
                "type": "command",
                "command": format!("{} {}", shell_quote(&bash), shell_quote(&plugin_root.join("hooks").join(file_name)))
            }]
        }));
        settings["hooks"][event_name] = Value::Array(groups);
    }
    if !settings.get("mcpServers").is_some_and(Value::is_object) {
        settings["mcpServers"] = json!({});
    }
    let node = resolve_command("node");
    settings["mcpServers"]["devflow-protocol"] = json!({
        "command": if node.is_empty() { "node" } else { &node },
        "args": [plugin_root.join("mcp/server.mjs").display().to_string()],
        "env": { "DEVFLOW_PROTOCOL_URL": DEFAULT_PROTOCOL_BASE_URL }
    });
    write_json(&claude_settings_path(), &settings)
}

fn update_claude_settings_for_uninstall() -> Result<(), String> {
    let plugin_root = claude_plugin_install_root();
    let mut settings = read_json(&claude_settings_path()).unwrap_or_else(|| json!({}));
    if let Some(hooks) = settings.get("hooks").and_then(Value::as_object).cloned() {
        for event_name in hooks.keys() {
            settings["hooks"][event_name] = filter_hook_groups(&settings["hooks"][event_name], &plugin_root);
        }
    }
    if settings.pointer("/mcpServers/devflow-protocol").is_some() {
        if let Some(servers) = settings.get_mut("mcpServers").and_then(Value::as_object_mut) {
            servers.remove("devflow-protocol");
        }
    }
    write_json(&claude_settings_path(), &settings)
}

fn copy_dir(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        fs::remove_dir_all(target).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(target).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if source_path.is_dir() {
            copy_dir(&source_path, &target_path)?;
        } else {
            fs::copy(&source_path, &target_path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn install_claude_plugin(app: &AppHandle) -> Result<(), String> {
    let source = claude_plugin_source(app);
    if !source.exists() {
        return Err(format!("Claude plugin source not found: {}", source.display()));
    }
    let target = claude_plugin_install_root();
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    copy_dir(&source, &target)?;
    fs::create_dir_all(target.join(".devflow-plugin-state")).map_err(|error| error.to_string())?;
    fs::write(target.join(".devflow-plugin-state/enabled"), "").map_err(|error| error.to_string())?;
    update_claude_settings_for_install()?;
    Ok(())
}

fn uninstall_claude_plugin() -> Result<(), String> {
    update_claude_settings_for_uninstall()?;
    let target = claude_plugin_install_root();
    if target.exists() {
        fs::remove_dir_all(target).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn runtime_status(app: &AppHandle, backend: &AppBackend) -> RuntimeStatus {
    RuntimeStatus {
        protocol_running: backend.protocol.is_some(),
        protocol_pid: backend.protocol.as_ref().map(|managed| managed.child.id()),
        protocol_log_path: protocol_log_path(app).display().to_string(),
        protocol_last_error: backend.protocol_last_error.clone(),
        codex_bridge_running: backend.codex_bridge.is_some(),
        codex_bridge_pid: backend.codex_bridge.as_ref().map(|managed| managed.child.id()),
        codex_bridge_log_path: codex_log_path(app).display().to_string(),
        codex_bridge_last_error: backend.codex_bridge_last_error.clone(),
        claude_plugin_installed: is_claude_installed(),
        has_bash: !resolve_command("bash").is_empty(),
        has_node: !resolve_command("node").is_empty(),
        has_python3: !resolve_command("python3").is_empty(),
    }
}

fn update_tray_menu(app: &AppHandle) {
    let Some(state_mutex) = app.try_state::<BackendState>() else {
        return;
    };
    let Ok(backend) = state_mutex.lock() else {
        return;
    };
    let Some(tray) = backend.tray.as_ref() else {
        return;
    };
    if let Ok(menu) = build_menu(app, &backend) {
        let _ = tray.set_menu(Some(menu));
    }
}

fn build_menu(app: &AppHandle, backend: &AppBackend) -> tauri::Result<tauri::menu::Menu<Wry>> {
    let state = &backend.state;
    let selected_model = state.get("selectedModelId").and_then(Value::as_str).unwrap_or("nito");
    let hidden = state.get("hidden").and_then(Value::as_bool).unwrap_or(false);
    let scale = state.pointer("/avatarTuning/scale").and_then(Value::as_f64).unwrap_or(100.0) as i64;
    let status = runtime_status(app, backend);

    let mut model_menu = SubmenuBuilder::new(app, "模型");
    for model in &backend.models {
        model_menu = model_menu.item(
            &CheckMenuItemBuilder::with_id(format!("model:{}", model.id), &model.name)
                .checked(model.id == selected_model)
                .build(app)?,
        );
    }

    let scale_menu = SubmenuBuilder::new(app, "角色大小")
        .item(&MenuItemBuilder::with_id("scale:smaller", "缩小一点").build(app)?)
        .item(&MenuItemBuilder::with_id("scale:larger", "放大一点").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("scale:reset", "恢复默认").build(app)?);

    let services_menu = SubmenuBuilder::new(app, "后台服务")
        .item(
            &MenuItemBuilder::with_id(
                "protocol:toggle",
                if status.protocol_running {
                    "停止 devflow-protocol"
                } else {
                    "启动 devflow-protocol"
                },
            )
            .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(
                "codex:toggle",
                if state.get("codexBridgeEnabled").and_then(Value::as_bool).unwrap_or(false) {
                    "关闭 Codex bridge"
                } else {
                    "开启 Codex bridge"
                },
            )
            .enabled(status.has_python3)
            .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(
                "claude:toggle",
                if status.claude_plugin_installed {
                    "卸载 Claude 全局插件"
                } else {
                    "安装 Claude 全局插件"
                },
            )
            .enabled(status.has_bash && status.has_node)
            .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("logs:open", "打开日志目录").build(app)?);

    MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("visibility:toggle", if hidden { "显示角色" } else { "隐藏角色" }).build(app)?)
        .separator()
        .item(&CheckMenuItemBuilder::with_id("alwaysOnTop:toggle", "始终置顶").checked(state.get("alwaysOnTop").and_then(Value::as_bool).unwrap_or(true)).build(app)?)
        .item(&CheckMenuItemBuilder::with_id("allWorkspaces:toggle", "所有桌面可见").checked(state.get("allWorkspaces").and_then(Value::as_bool).unwrap_or(true)).build(app)?)
        .item(&CheckMenuItemBuilder::with_id("clickThrough:toggle", "点击穿透").checked(state.get("clickThrough").and_then(Value::as_bool).unwrap_or(false)).build(app)?)
        .separator()
        .item(&model_menu.build()?)
        .item(&scale_menu.build()?)
        .item(&MenuItemBuilder::with_id("preview:idle", "行为预览").build(app)?)
        .item(&MenuItemBuilder::new(format!("当前大小: {scale}%")).enabled(false).build(app)?)
        .separator()
        .item(&services_menu.build()?)
        .separator()
        .item(&MenuItemBuilder::with_id("quit", "退出").accelerator("CmdOrCtrl+Q").build(app)?)
        .build()
}

fn update_state_inner(app: &AppHandle, backend: &mut AppBackend, partial: Value) -> Result<Value, String> {
    merge_value(&mut backend.state, &partial);
    backend.state = normalize_state(backend.state.clone(), &backend.models);
    apply_window_state(app, &backend.state);
    persist_state(app, backend)?;
    let public = public_state(app, backend);
    app.emit(STATE_EVENT, public.clone()).map_err(|error| error.to_string())?;
    Ok(public)
}

#[tauri::command]
fn get_overlay_state(app: AppHandle, backend: tauri::State<BackendState>) -> Result<Value, String> {
    let backend = backend.lock().map_err(|_| "backend lock poisoned".to_string())?;
    Ok(public_state(&app, &backend))
}

#[tauri::command]
fn update_overlay_state(app: AppHandle, backend: tauri::State<BackendState>, partial_state: Value) -> Result<Value, String> {
    let mut backend = backend.lock().map_err(|_| "backend lock poisoned".to_string())?;
    let next = update_state_inner(&app, &mut backend, partial_state)?;
    drop(backend);
    update_tray_menu(&app);
    Ok(next)
}

#[tauri::command]
fn open_overlay_menu(app: AppHandle) -> Result<Value, String> {
    update_tray_menu(&app);
    let Some(state) = app.try_state::<BackendState>() else {
        return Err("backend state unavailable".to_string());
    };
    let backend = state.lock().map_err(|_| "backend lock poisoned".to_string())?;
    Ok(public_state(&app, &backend))
}

#[tauri::command]
fn quit_app(app: AppHandle) -> bool {
    app.exit(0);
    true
}

#[tauri::command]
async fn generate_persona_dialogue(app: AppHandle, backend: tauri::State<'_, BackendState>, payload: Value) -> Result<Value, String> {
    let settings = {
        let backend = backend.lock().map_err(|_| "backend lock poisoned".to_string())?;
        backend.state.get("personaDialogue").cloned().unwrap_or_else(|| json!({}))
    };
    let enabled = settings.get("enabled").and_then(Value::as_bool).unwrap_or(false);
    let api_key = settings
        .get("apiKey")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|key| !key.trim().is_empty())
        .or_else(|| std::env::var("OPENAI_API_KEY").ok())
        .unwrap_or_default();
    if !enabled || api_key.is_empty() {
        return Ok(json!({ "ok": false, "text": "", "reason": "disabled" }));
    }

    let api_url = settings.get("apiUrl").and_then(Value::as_str).unwrap_or("").trim();
    let api_url = if api_url.ends_with("/chat/completions") || api_url.ends_with("/responses") {
        api_url.to_string()
    } else {
        format!("{}/v1/chat/completions", api_url.trim_end_matches('/'))
    };
    let model = settings.get("model").and_then(Value::as_str).unwrap_or("gpt-4.1-mini");
    let fallback = payload.get("fallbackText").and_then(Value::as_str).unwrap_or("");
    let prompt = format!("根据桌面 Live2D 助手状态生成一句简短中文台词。只返回 JSON: {{\"lines\":[\"...\"]}}。\n上下文: {}", payload);
    let timeout_ms = settings.get("timeoutMs").and_then(Value::as_u64).unwrap_or(8000);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .post(api_url)
        .bearer_auth(api_key)
        .json(&json!({
            "model": model,
            "messages": [
                { "role": "system", "content": "你是一个桌面 Live2D 桌宠的台词生成器。只输出纯 JSON，格式: {\"lines\":[\"第一句\",\"第二句\"]}。不要 markdown、不要解释。" },
                { "role": "user", "content": prompt }
            ],
            "temperature": 0.92,
            "max_tokens": 150
        }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let raw = response.text().await.map_err(|error| error.to_string())?;
    let parsed = serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| json!({ "choices": [{ "message": { "content": raw } }] }));
    let content = parsed
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .or_else(|| parsed.get("output_text").and_then(Value::as_str))
        .unwrap_or(fallback);
    let lines = serde_json::from_str::<Value>(content)
        .ok()
        .and_then(|value| value.get("lines").and_then(Value::as_array).cloned())
        .map(|lines| {
            lines.into_iter()
                .filter_map(|line| line.as_str().map(str::trim).map(str::to_string))
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|lines| !lines.is_empty())
        .unwrap_or_else(|| vec![content.trim().to_string()]);
    let text = lines.first().cloned().unwrap_or_else(|| fallback.to_string());
    let _ = app.emit(PREVIEW_EVENT, json!({ "previewText": text }));
    Ok(json!({ "ok": true, "text": text, "lines": lines, "provider": "openai-compatible", "model": model }))
}

fn handle_menu(app: &AppHandle, id: &str) {
    let Some(state) = app.try_state::<BackendState>() else {
        return;
    };
    let mut backend = match state.lock() {
        Ok(backend) => backend,
        Err(_) => return,
    };
    let mut patch = json!({});
    match id {
        "visibility:toggle" => patch["hidden"] = Value::Bool(!backend.state.get("hidden").and_then(Value::as_bool).unwrap_or(false)),
        "alwaysOnTop:toggle" => patch["alwaysOnTop"] = Value::Bool(!backend.state.get("alwaysOnTop").and_then(Value::as_bool).unwrap_or(true)),
        "allWorkspaces:toggle" => patch["allWorkspaces"] = Value::Bool(!backend.state.get("allWorkspaces").and_then(Value::as_bool).unwrap_or(true)),
        "clickThrough:toggle" => patch["clickThrough"] = Value::Bool(!backend.state.get("clickThrough").and_then(Value::as_bool).unwrap_or(false)),
        "scale:smaller" => {
            let scale = backend.state.pointer("/avatarTuning/scale").and_then(Value::as_f64).unwrap_or(100.0) - 10.0;
            patch["avatarTuning"] = json!({ "scale": scale });
        }
        "scale:larger" => {
            let scale = backend.state.pointer("/avatarTuning/scale").and_then(Value::as_f64).unwrap_or(100.0) + 10.0;
            patch["avatarTuning"] = json!({ "scale": scale });
        }
        "scale:reset" => patch["avatarTuning"] = json!({ "scale": 100, "offsetX": 0, "offsetY": 0 }),
        "preview:idle" => {
            let _ = app.emit(PREVIEW_EVENT, json!({ "mood": "calm", "expression": "calm", "motion": "Idle", "source": "tray-preview", "label": "行为预览" }));
        }
        "protocol:toggle" => {
            if backend.protocol.is_some() {
                stop_child(&mut backend.codex_bridge);
                stop_child(&mut backend.protocol);
            } else {
                let _ = start_protocol(app, &mut backend);
            }
        }
        "codex:toggle" => {
            if backend.codex_bridge.is_some() {
                stop_child(&mut backend.codex_bridge);
                patch["codexBridgeEnabled"] = Value::Bool(false);
            } else {
                patch["codexBridgeEnabled"] = Value::Bool(true);
                let _ = start_codex_bridge(app, &mut backend);
            }
        }
        "claude:toggle" => {
            if is_claude_installed() {
                let _ = uninstall_claude_plugin();
            } else {
                let _ = install_claude_plugin(app);
            }
        }
        "logs:open" => {
            let _ = fs::create_dir_all(log_dir(app));
            let _ = Command::new("open").arg(log_dir(app)).spawn();
        }
        "quit" => app.exit(0),
        id if id.starts_with("model:") => patch["selectedModelId"] = Value::String(id.trim_start_matches("model:").to_string()),
        _ => {}
    }
    if patch != json!({}) {
        let _ = update_state_inner(app, &mut backend, patch);
    } else {
        let _ = app.emit(STATE_EVENT, public_state(app, &backend));
    }
    drop(backend);
    update_tray_menu(app);
}

fn load_initial_backend(app: &AppHandle) -> AppBackend {
    let models = load_models();
    let mut state = default_state();
    if let Ok(path) = settings_path(app) {
        if let Some(stored) = read_json(&path) {
            merge_value(&mut state, &stored);
        }
    }
    if let Some(persona) = read_json(&persona_config_path()).and_then(|value| value.get("personaDialogue").cloned()) {
        state["personaDialogue"] = persona;
    }
    state = normalize_state(state, &models);
    AppBackend {
        state,
        models,
        tray: None,
        protocol: None,
        codex_bridge: None,
        protocol_last_error: String::new(),
        codex_bridge_last_error: String::new(),
    }
}

fn create_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::default())
        .title("DPartner")
        .inner_size(420.0, 720.0)
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(true)
        .build()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_overlay_state,
            update_overlay_state,
            open_overlay_menu,
            quit_app,
            generate_persona_dialogue
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let backend = load_initial_backend(&handle);
            app.manage(Mutex::new(backend));

            let window = create_window(&handle)?;
            {
                let state = app.state::<BackendState>();
                if let Ok(backend) = state.lock() {
                    apply_window_state(&handle, &backend.state);
                    let menu = build_menu(&handle, &backend)?;
                    drop(backend);
                    let tray = TrayIconBuilder::new()
                        .tooltip("DPartner")
                        .icon(app.default_window_icon().unwrap().clone())
                        .menu(&menu)
                        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
                        .on_tray_icon_event(|tray, event| {
                            if let TrayIconEvent::Click {
                                button: MouseButton::Left,
                                button_state: MouseButtonState::Up,
                                ..
                            } = event
                            {
                                handle_menu(tray.app_handle(), "visibility:toggle");
                            }
                        })
                        .build(app)?;
                    let _ = tray.set_icon_as_template(true);
                    if let Ok(mut backend) = state.lock() {
                        backend.tray = Some(tray);
                        let _ = persist_state(&handle, &backend);
                    }
                };
            }

            let _ = window.set_focus();
            let app_for_start = handle.clone();
            tauri::async_runtime::spawn(async move {
                let start = Instant::now();
                if let Some(state) = app_for_start.try_state::<BackendState>() {
                    if let Ok(mut backend) = state.lock() {
                        let _ = start_protocol(&app_for_start, &mut backend);
                    }
                }
                while start.elapsed() < Duration::from_secs(2) {
                    tokio_sleep(Duration::from_millis(250)).await;
                }
                broadcast_state(&app_for_start);
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(state) = window.app_handle().try_state::<BackendState>() {
                    if let Ok(mut backend) = state.lock() {
                        stop_child(&mut backend.codex_bridge);
                        stop_child(&mut backend.protocol);
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running DPartner");
}

async fn tokio_sleep(duration: Duration) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration))
        .await
        .ok();
}
