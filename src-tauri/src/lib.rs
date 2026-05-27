use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{
    image::Image,
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Monitor, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, Window, Wry,
};
use tauri_plugin_global_shortcut::{Code, Modifiers, ShortcutState};

#[cfg(target_os = "macos")]
use objc2::{
    ffi,
    runtime::{AnyClass, AnyObject, Imp, Sel},
    sel, MainThreadMarker,
};
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSScreenSaverWindowLevel, NSWindow,
    NSWindowCollectionBehavior,
};
#[cfg(target_os = "macos")]
use objc2_foundation::NSRect;

const WINDOW_LABEL: &str = "main";
const STATE_EVENT: &str = "overlay-state";
const PREVIEW_EVENT: &str = "overlay:previewAvatarState";
const DEFAULT_PROTOCOL_BASE_URL: &str = "http://127.0.0.1:4317";
const SETTINGS_FILE_NAME: &str = "devflow-live2d-settings.json";
const DEVFLOW_CONFIG_FILE: &str = ".devflow/live2d/config.json";
const WINDOW_VISIBLE_MARGIN: f64 = 80.0;
const MACOS_OVERLAY_REINFORCE_INTERVAL: Duration = Duration::from_millis(1200);
const TRAY_TEMPLATE_ICON_BYTES: &[u8] = include_bytes!("../../assets/app/trayTemplate.png");
const SCALE_PRESETS: [f64; 3] = [100.0, 80.0, 50.0];

#[cfg(target_os = "macos")]
static OVERLAY_WINDOW_PATCHED: std::sync::OnceLock<()> = std::sync::OnceLock::new();

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ModelInfo {
    id: String,
    name: String,
    config: Value,
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
    claude_plugin_last_error: String,
    has_bash: bool,
    has_node: bool,
    has_python3: bool,
}

#[derive(Debug, Deserialize)]
struct ContentSize {
    width: f64,
    height: f64,
}

#[derive(Debug, Deserialize)]
struct WindowPosition {
    x: f64,
    y: f64,
    #[serde(default = "default_true")]
    persist: bool,
}

fn default_true() -> bool {
    true
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
    claude_plugin_installed: bool,
    claude_plugin_last_error: String,
    has_bash: bool,
    has_node: bool,
    has_python3: bool,
    suppress_window_move_persistence: bool,
}

type BackendState = Mutex<AppBackend>;

#[derive(Clone)]
struct MenuSnapshot {
    state: Value,
    models: Vec<ModelInfo>,
    codex_bridge_running: bool,
    claude_plugin_installed: bool,
    has_bash: bool,
    has_node: bool,
    has_python3: bool,
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
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
        "windowBounds": { "x": 0, "y": 60, "width": 420, "height": 444 }
    })
}

fn clamp_number(value: Option<f64>, fallback: f64, min: f64, max: f64) -> f64 {
    value.unwrap_or(fallback).clamp(min, max)
}

fn normalize_scale_preset(value: Option<f64>) -> f64 {
    let target = value.unwrap_or(100.0);
    SCALE_PRESETS
        .into_iter()
        .min_by(|left, right| {
            (left - target)
                .abs()
                .partial_cmp(&(right - target).abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(100.0)
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

    let tuning = state
        .get("avatarTuning")
        .cloned()
        .unwrap_or(default["avatarTuning"].clone());
    state["avatarTuning"] = json!({
        "scale": normalize_scale_preset(tuning.get("scale").and_then(Value::as_f64)),
        "offsetX": clamp_number(tuning.get("offsetX").and_then(Value::as_f64), 0.0, -220.0, 220.0),
        "offsetY": clamp_number(tuning.get("offsetY").and_then(Value::as_f64), 0.0, -220.0, 220.0)
    });

    if state
        .get("protocolBaseUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        state["protocolBaseUrl"] = Value::String(DEFAULT_PROTOCOL_BASE_URL.to_string());
    }

    let bounds = state
        .get("windowBounds")
        .cloned()
        .unwrap_or(default["windowBounds"].clone());
    state["windowBounds"] = normalize_window_bounds(&bounds);

    state
}

fn normalize_window_bounds(bounds: &Value) -> Value {
    normalize_window_bounds_inner(bounds, true)
}

fn normalize_live_window_bounds(bounds: &Value) -> Value {
    normalize_window_bounds_inner(bounds, false)
}

fn normalize_window_bounds_inner(bounds: &Value, migrate_legacy_physical_size: bool) -> Value {
    let mut x = bounds.get("x").and_then(Value::as_f64).unwrap_or(0.0);
    let mut y = bounds.get("y").and_then(Value::as_f64).unwrap_or(60.0);
    let mut width = bounds.get("width").and_then(Value::as_f64).unwrap_or(420.0);
    let mut height = bounds
        .get("height")
        .and_then(Value::as_f64)
        .unwrap_or(720.0);

    if migrate_legacy_physical_size && (width > 620.0 || height > 900.0) {
        x /= 2.0;
        y /= 2.0;
        width /= 2.0;
        height /= 2.0;
    }

    json!({
        "x": x.clamp(-520.0, 10000.0).round(),
        "y": y.clamp(-520.0, 10000.0).round(),
        "width": width.clamp(320.0, 520.0).round(),
        "height": height.clamp(360.0, 920.0).round()
    })
}

fn constrain_bounds_to_visible_area(bounds: &Value, monitors: &[Monitor]) -> Value {
    constrain_bounds_to_visible_area_inner(bounds, monitors, true)
}

fn constrain_live_bounds_to_visible_area(bounds: &Value, monitors: &[Monitor]) -> Value {
    constrain_bounds_to_visible_area_inner(bounds, monitors, false)
}

fn constrain_bounds_to_visible_area_inner(
    bounds: &Value,
    monitors: &[Monitor],
    migrate_legacy_physical_size: bool,
) -> Value {
    let normalized = normalize_window_bounds_inner(bounds, migrate_legacy_physical_size);
    if monitors.is_empty() {
        return normalized;
    }

    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;

    for monitor in monitors {
        let scale_factor = monitor.scale_factor();
        let work_area = monitor.work_area();
        let x = work_area.position.x as f64 / scale_factor;
        let y = work_area.position.y as f64 / scale_factor;
        let width = work_area.size.width as f64 / scale_factor;
        let height = work_area.size.height as f64 / scale_factor;
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x + width);
        max_y = max_y.max(y + height);
    }

    if !min_x.is_finite() || !min_y.is_finite() || !max_x.is_finite() || !max_y.is_finite() {
        return normalized;
    }

    let width = normalized
        .get("width")
        .and_then(Value::as_f64)
        .unwrap_or(420.0);
    let height = normalized
        .get("height")
        .and_then(Value::as_f64)
        .unwrap_or(444.0);
    let x = normalized
        .get("x")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .clamp(
            min_x - width + WINDOW_VISIBLE_MARGIN,
            max_x - WINDOW_VISIBLE_MARGIN,
        );
    let y = normalized
        .get("y")
        .and_then(Value::as_f64)
        .unwrap_or(60.0)
        .clamp(
            min_y - height + WINDOW_VISIBLE_MARGIN,
            max_y - WINDOW_VISIBLE_MARGIN,
        );

    json!({
        "x": x.round(),
        "y": y.round(),
        "width": width,
        "height": height
    })
}

fn normalize_live_window_bounds_for_window(window: &WebviewWindow, bounds: &Value) -> Value {
    match window.available_monitors() {
        Ok(monitors) => constrain_live_bounds_to_visible_area(bounds, &monitors),
        Err(_) => normalize_live_window_bounds(bounds),
    }
}

fn normalize_window_bounds_for_tauri_window(window: &Window<Wry>, bounds: &Value) -> Value {
    match window.available_monitors() {
        Ok(monitors) => constrain_bounds_to_visible_area(bounds, &monitors),
        Err(_) => normalize_window_bounds(bounds),
    }
}

fn normalize_window_bounds_for_app(app: &AppHandle, bounds: &Value) -> Value {
    match app.available_monitors() {
        Ok(monitors) => constrain_bounds_to_visible_area(bounds, &monitors),
        Err(_) => normalize_window_bounds(bounds),
    }
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
    fs::write(
        path,
        serde_json::to_string_pretty(value).map_err(|error| error.to_string())?,
    )
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
        let config = normalize_model_config(json, &id, &name);
        models.push(ModelInfo { id, name, config });
    }

    if models.is_empty() {
        models.push(ModelInfo {
            id: "nito".to_string(),
            name: "Nito".to_string(),
            config: json!({
                "id": "nito",
                "name": "Nito",
                "defaults": { "motion": "Idle", "expression": "", "mood": "calm", "holdMs": 0 },
                "events": {},
                "runtimeEvents": {},
                "manifestModel": { "id": "nito", "name": "Nito" }
            }),
        });
    }
    models
}

fn clean_string(value: Option<&Value>, fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn clean_number(value: Option<&Value>, fallback: f64) -> f64 {
    value.and_then(Value::as_f64).unwrap_or(fallback)
}

fn normalize_behavior(value: Option<&Value>, fallback: &Value) -> Value {
    let object = value.and_then(Value::as_object);
    let fallback_motion = fallback
        .get("motion")
        .and_then(Value::as_str)
        .unwrap_or("Idle");
    let fallback_expression = fallback
        .get("expression")
        .and_then(Value::as_str)
        .unwrap_or("");
    let fallback_mood = fallback
        .get("mood")
        .and_then(Value::as_str)
        .unwrap_or("calm");
    let fallback_hold = fallback
        .get("holdMs")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    json!({
        "motion": object.and_then(|map| map.get("motion")).and_then(Value::as_str).unwrap_or(fallback_motion),
        "expression": object.and_then(|map| map.get("expression")).and_then(Value::as_str).unwrap_or(fallback_expression),
        "mood": object.and_then(|map| map.get("mood")).and_then(Value::as_str).unwrap_or(fallback_mood),
        "holdMs": object.and_then(|map| map.get("holdMs")).and_then(Value::as_f64).unwrap_or(fallback_hold).max(0.0),
        "bubbleTone": object.and_then(|map| map.get("bubbleTone")).and_then(Value::as_str).unwrap_or(""),
        "bubbleChannel": object.and_then(|map| map.get("bubbleChannel")).and_then(Value::as_str).unwrap_or("")
    })
}

fn normalize_behavior_map(value: Option<&Value>, fallback: &Value) -> Value {
    let Some(map) = value.and_then(Value::as_object) else {
        return json!({});
    };
    let mut output = serde_json::Map::new();
    for (event, behavior) in map {
        output.insert(event.clone(), normalize_behavior(Some(behavior), fallback));
    }
    Value::Object(output)
}

fn behavior_map_to_legacy_motions(events: &Value, runtime_events: &Value) -> Value {
    let mappings = [
        ("idleWave", "session.started"),
        ("acknowledge", "task.updated"),
        ("greet", "request.created"),
        ("workLoop", "tool.started"),
        ("ponder", "usage.updated"),
        ("celebrate", "task.completed"),
        ("shake", "error"),
    ];
    let mut output = serde_json::Map::new();
    for (legacy, event) in mappings {
        let motion = events
            .pointer(&format!("/{event}/motion"))
            .or_else(|| runtime_events.pointer(&format!("/{event}/motion")))
            .and_then(Value::as_str);
        if let Some(motion) = motion {
            output.insert(legacy.to_string(), Value::String(motion.to_string()));
        }
    }
    Value::Object(output)
}

fn behavior_map_to_legacy_expressions(events: &Value, runtime_events: &Value) -> Value {
    let mut output = serde_json::Map::new();
    for behavior in events
        .as_object()
        .into_iter()
        .flat_map(|map| map.values())
        .chain(
            runtime_events
                .as_object()
                .into_iter()
                .flat_map(|map| map.values()),
        )
    {
        let mood = behavior.get("mood").and_then(Value::as_str).unwrap_or("");
        let expression = behavior
            .get("expression")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !mood.is_empty() && !expression.is_empty() {
            output.insert(mood.to_string(), Value::String(expression.to_string()));
        }
    }
    Value::Object(output)
}

fn normalize_model_config(raw: Value, id: &str, name: &str) -> Value {
    let model = raw.get("model").unwrap_or(&Value::Null);
    let layout = raw.get("layout").unwrap_or(&Value::Null);
    let runtime = raw.get("runtime").unwrap_or(&Value::Null);
    let defaults = normalize_behavior(
        raw.get("defaults"),
        &json!({ "motion": "Idle", "expression": "", "mood": "calm", "holdMs": 0 }),
    );
    let events = normalize_behavior_map(raw.get("events"), &defaults);
    let runtime_events = normalize_behavior_map(raw.get("runtimeEvents"), &defaults);
    let base_path = clean_string(model.get("basePath"), &format!("assets/live2d/models/{id}"));
    let model_json = clean_string(model.get("modelJson"), &format!("{id}.model3.json"));
    let runtime_resources_root = clean_string(
        runtime
            .get("resourcesRoot")
            .or_else(|| model.get("runtimeResourcesRoot")),
        base_path.trim_start_matches("assets/live2d/models/"),
    );
    let runtime_model_json = clean_string(model.get("runtimeModelJson"), &model_json);
    json!({
        "version": clean_number(raw.get("version"), 1.0),
        "id": id,
        "name": name,
        "enabled": raw.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        "runtime": {
            "engine": clean_string(runtime.get("engine"), "external-official"),
            "resourcesRoot": runtime_resources_root
        },
        "model": {
            "basePath": base_path,
            "modelJson": model_json,
            "runtimeResourcesRoot": runtime_resources_root,
            "runtimeModelJson": runtime_model_json
        },
        "layout": {
            "runtimeWidth": clean_number(layout.get("runtimeWidth"), 1.1),
            "centerX": clean_number(layout.get("centerX"), 0.45),
            "centerY": clean_number(layout.get("centerY"), 0.12),
            "scale": clean_number(layout.get("scale"), 1.0),
            "offsetX": clean_number(layout.get("offsetX"), 0.0),
            "offsetY": clean_number(layout.get("offsetY"), 0.0)
        },
        "defaults": defaults,
        "events": events,
        "runtimeEvents": runtime_events,
        "interaction": raw.get("interaction").cloned().unwrap_or_else(|| json!({})),
        "metadata": raw.get("metadata").cloned().unwrap_or_else(|| json!({})),
        "manifestModel": {
            "id": clean_string(model.get("id"), id),
            "name": name,
            "basePath": base_path,
            "modelJson": model_json,
            "runtimeResourcesRoot": runtime_resources_root,
            "runtimeModelJson": runtime_model_json,
            "runtimeWidth": clean_number(layout.get("runtimeWidth"), 1.1),
            "centerX": clean_number(layout.get("centerX"), 0.45),
            "centerY": clean_number(layout.get("centerY"), 0.12),
            "scale": clean_number(layout.get("scale"), 1.0),
            "offsetX": clean_number(layout.get("offsetX"), 0.0),
            "offsetY": clean_number(layout.get("offsetY"), 0.0)
        },
        "motions": behavior_map_to_legacy_motions(&events, &runtime_events),
        "expressions": behavior_map_to_legacy_expressions(&events, &runtime_events)
    })
}

fn public_state(app: &AppHandle, backend: &AppBackend) -> Value {
    let mut state = backend.state.clone();
    let selected = state
        .get("selectedModelId")
        .and_then(Value::as_str)
        .unwrap_or("nito");
    let selected_model = backend
        .models
        .iter()
        .find(|model| model.id == selected)
        .or_else(|| backend.models.first())
        .map(|model| model.config.clone());
    state["selectedModel"] = selected_model.unwrap_or(Value::Null);
    state["platform"] = Value::String(std::env::consts::OS.to_string());
    state["focused"] = Value::Bool(false);
    state["runtimeStatus"] =
        serde_json::to_value(runtime_status(app, backend)).unwrap_or(Value::Null);

    if let Some(persona) = state
        .get_mut("personaDialogue")
        .and_then(Value::as_object_mut)
    {
        let configured = persona
            .get("apiKey")
            .and_then(Value::as_str)
            .map(|key| !key.trim().is_empty())
            .unwrap_or(false)
            || !std::env::var("OPENAI_API_KEY")
                .unwrap_or_default()
                .trim()
                .is_empty();
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
    let hidden = state
        .get("hidden")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if hidden {
        let _ = window.hide();
    } else {
        let _ = window.show();
    }
    let _ = window.set_always_on_top(
        state
            .get("alwaysOnTop")
            .and_then(Value::as_bool)
            .unwrap_or(true),
    );
    apply_macos_overlay_window_level(&window);
    let _ = window.set_skip_taskbar(true);
    let _ = window.set_ignore_cursor_events(
        state
            .get("clickThrough")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    );
}

fn tray_template_icon(app: &AppHandle) -> Image<'static> {
    Image::from_bytes(TRAY_TEMPLATE_ICON_BYTES).unwrap_or_else(|_| {
        app.default_window_icon()
            .expect("default window icon should be available")
            .clone()
            .to_owned()
    })
}

#[cfg(target_os = "macos")]
fn apply_macos_overlay_window_level(window: &WebviewWindow) {
    apply_macos_overlay_app_policy();
    apply_macos_overlay_window_level_inner(window, false);
}

#[cfg(target_os = "macos")]
fn reinforce_macos_overlay_window_level(window: &WebviewWindow) {
    apply_macos_overlay_app_policy();
    apply_macos_overlay_window_level_inner(window, true);
}

#[cfg(target_os = "macos")]
fn apply_macos_overlay_app_policy() {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    let _ = app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);
}

#[cfg(target_os = "macos")]
fn apply_macos_overlay_window_level_inner(window: &WebviewWindow, order_front: bool) {
    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    if ns_window_ptr.is_null() {
        return;
    }
    let ns_window = unsafe { &*(ns_window_ptr.cast::<NSWindow>()) };
    install_unconstrained_window_constraint(ns_window);
    ns_window.setLevel(NSScreenSaverWindowLevel);
    let behavior = NSWindowCollectionBehavior::CanJoinAllApplications
        | NSWindowCollectionBehavior::CanJoinAllSpaces
        | NSWindowCollectionBehavior::FullScreenAuxiliary
        | NSWindowCollectionBehavior::Transient
        | NSWindowCollectionBehavior::IgnoresCycle
        | NSWindowCollectionBehavior::FullScreenDisallowsTiling;
    ns_window.setCollectionBehavior(behavior);
    ns_window.setCanHide(false);
    ns_window.setHidesOnDeactivate(false);
    if order_front {
        ns_window.orderFrontRegardless();
    }
}

#[cfg(target_os = "macos")]
fn install_unconstrained_window_constraint(ns_window: &NSWindow) {
    let object: &AnyObject = ns_window.as_ref();
    let window_class = object.class();
    OVERLAY_WINDOW_PATCHED.get_or_init(|| {
        unsafe extern "C-unwind" fn constrain_frame_rect_to_screen(
            _this: *mut AnyObject,
            _cmd: Sel,
            frame: NSRect,
            _screen: *mut AnyObject,
        ) -> NSRect {
            frame
        }

        let method_types = c"{CGRect={CGPoint=dd}{CGSize=dd}}@:{CGRect={CGPoint=dd}{CGSize=dd}}@";
        let implementation: Imp = unsafe {
            std::mem::transmute(
                constrain_frame_rect_to_screen
                    as unsafe extern "C-unwind" fn(
                        *mut AnyObject,
                        Sel,
                        NSRect,
                        *mut AnyObject,
                    ) -> NSRect,
            )
        };
        let _ = unsafe {
            ffi::class_addMethod(
                window_class as *const AnyClass as *mut AnyClass,
                sel!(constrainFrameRect:toScreen:),
                implementation,
                method_types.as_ptr(),
            )
        };
    });
}

#[cfg(not(target_os = "macos"))]
fn apply_macos_overlay_window_level(_window: &WebviewWindow) {}

#[cfg(not(target_os = "macos"))]
fn reinforce_macos_overlay_window_level(_window: &WebviewWindow) {}

fn persist_state(app: &AppHandle, backend: &AppBackend) -> Result<(), String> {
    write_json(&settings_path(app)?, &backend.state)?;
    let persona = backend
        .state
        .get("personaDialogue")
        .cloned()
        .unwrap_or_else(|| json!({}));
    write_json(
        &persona_config_path(),
        &json!({ "personaDialogue": persona }),
    )?;
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
            .resolve(
                "bundle/devflow-protocol-go/claude-plugin",
                tauri::path::BaseDirectory::Resource,
            )
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
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| {
            use std::io::Write;
            file.write_all(line.as_bytes())
        });
}

fn chrono_like_timestamp() -> String {
    let output = Command::new("date")
        .arg("-u")
        .arg("+%Y-%m-%dT%H:%M:%SZ")
        .output();
    output
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "now".to_string())
}

fn spawn_protocol_child(app: &AppHandle) -> Result<ManagedChild, String> {
    let bin = protocol_binary(app);
    if !bin.exists() {
        return Err(format!("devflow-protocol not found: {}", bin.display()));
    }
    let data_dir = runtime_data_root(app).join("devflow-protocol");
    fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
    let log_path = protocol_log_path(app);
    append_log(&log_path, &format!("protocol starting: {}", bin.display()));
    let stdout = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| e.to_string())?;
    let stderr = stdout.try_clone().map_err(|e| e.to_string())?;
    let child = Command::new(&bin)
        .env("HOST", "127.0.0.1")
        .env("PORT", "4317")
        .env("DEVFLOW_PROTOCOL_DIR", &data_dir)
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(ManagedChild { child })
}

fn start_protocol(app: &AppHandle, backend: &mut AppBackend) -> Result<(), String> {
    if backend.protocol.is_some() {
        return Ok(());
    }
    let child = match spawn_protocol_child(app) {
        Ok(child) => child,
        Err(error) => {
            backend.protocol_last_error = error;
            return Err(backend.protocol_last_error.clone());
        }
    };
    backend.protocol = Some(child);
    backend.protocol_last_error.clear();
    Ok(())
}

fn stop_child(child: &mut Option<ManagedChild>) {
    if let Some(mut managed) = child.take() {
        let _ = managed.child.kill();
        let _ = managed.child.wait();
    }
}

fn child_exited(child: &mut Option<ManagedChild>) -> bool {
    let Some(managed) = child.as_mut() else {
        return false;
    };
    match managed.child.try_wait() {
        Ok(Some(_)) => {
            *child = None;
            true
        }
        Ok(None) => false,
        Err(_) => {
            *child = None;
            true
        }
    }
}

fn spawn_codex_bridge_child(app: &AppHandle) -> Result<ManagedChild, String> {
    let python = resolve_command("python3");
    if python.is_empty() {
        return Err("Codex bridge requires python3".to_string());
    }
    let script = codex_bridge_script(app);
    if !script.exists() {
        return Err(format!(
            "Codex bridge script not found: {}",
            script.display()
        ));
    }
    let log_path = codex_log_path(app);
    let stdout = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| e.to_string())?;
    let stderr = stdout.try_clone().map_err(|e| e.to_string())?;
    let child = Command::new(python)
        .arg(script)
        .arg("--protocol-url")
        .arg(DEFAULT_PROTOCOL_BASE_URL)
        .arg("--state-file")
        .arg(runtime_data_root(app).join("codex-bridge-state.json"))
        .env("PYTHONUNBUFFERED", "1")
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(ManagedChild { child })
}

fn start_codex_bridge(app: &AppHandle, backend: &mut AppBackend) -> Result<(), String> {
    if backend.codex_bridge.is_some() {
        return Ok(());
    }
    start_protocol(app, backend)?;
    let child = match spawn_codex_bridge_child(app) {
        Ok(child) => child,
        Err(error) => {
            backend.codex_bridge_last_error = error;
            return Err(backend.codex_bridge_last_error.clone());
        }
    };
    backend.codex_bridge = Some(child);
    backend.codex_bridge_last_error.clear();
    Ok(())
}

fn start_codex_bridge_without_backend_lock(app: &AppHandle) -> Result<(), String> {
    let needs_protocol = {
        let Some(state) = app.try_state::<BackendState>() else {
            return Err("backend state unavailable".to_string());
        };
        let backend = state
            .lock()
            .map_err(|_| "backend lock poisoned".to_string())?;
        if backend.codex_bridge.is_some() {
            return Ok(());
        }
        backend.protocol.is_none()
    };

    if needs_protocol {
        let mut protocol_child = Some(spawn_protocol_child(app)?);
        let mut duplicate_protocol = None;
        let Some(state) = app.try_state::<BackendState>() else {
            stop_child(&mut protocol_child);
            return Err("backend state unavailable".to_string());
        };
        let Ok(mut backend) = state.lock() else {
            stop_child(&mut protocol_child);
            return Err("backend lock poisoned".to_string());
        };
        if backend.protocol.is_none() {
            backend.protocol = protocol_child.take();
            backend.protocol_last_error.clear();
        } else {
            duplicate_protocol = protocol_child.take();
        }
        if backend.codex_bridge.is_some() {
            let _ = update_state_inner(app, &mut backend, json!({ "codexBridgeEnabled": true }));
            drop(backend);
            stop_child(&mut duplicate_protocol);
            return Ok(());
        }
        drop(backend);
        stop_child(&mut duplicate_protocol);
    }

    let mut bridge_child = Some(spawn_codex_bridge_child(app)?);
    let mut duplicate_bridge = None;
    let Some(state) = app.try_state::<BackendState>() else {
        stop_child(&mut bridge_child);
        return Err("backend state unavailable".to_string());
    };
    let Ok(mut backend) = state.lock() else {
        stop_child(&mut bridge_child);
        return Err("backend lock poisoned".to_string());
    };
    if backend.codex_bridge.is_none() {
        backend.codex_bridge = bridge_child.take();
        backend.codex_bridge_last_error.clear();
    } else {
        duplicate_bridge = bridge_child.take();
    }
    let result = update_state_inner(app, &mut backend, json!({ "codexBridgeEnabled": true }));
    drop(backend);
    stop_child(&mut duplicate_bridge);
    result.map(|_| ())
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
    let has_mcp = settings.pointer("/mcpServers/devflow-protocol").is_some();
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
            let hooks = group
                .get("hooks")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
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
    let bash = if bash.is_empty() {
        PathBuf::from("bash")
    } else {
        PathBuf::from(bash)
    };
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
            settings["hooks"][event_name] =
                filter_hook_groups(&settings["hooks"][event_name], &plugin_root);
        }
    }
    if settings.pointer("/mcpServers/devflow-protocol").is_some() {
        if let Some(servers) = settings
            .get_mut("mcpServers")
            .and_then(Value::as_object_mut)
        {
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
            if source_path.extension().and_then(|ext| ext.to_str()) == Some("sh") {
                let mut permissions = fs::metadata(&target_path)
                    .map_err(|error| error.to_string())?
                    .permissions();
                permissions.set_mode(0o755);
                fs::set_permissions(&target_path, permissions)
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

fn install_claude_plugin(app: &AppHandle) -> Result<(), String> {
    let source = claude_plugin_source(app);
    if !source.exists() {
        return Err(format!(
            "Claude plugin source not found: {}",
            source.display()
        ));
    }
    let target = claude_plugin_install_root();
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    copy_dir(&source, &target)?;
    fs::create_dir_all(target.join(".devflow-plugin-state")).map_err(|error| error.to_string())?;
    fs::write(target.join(".devflow-plugin-state/enabled"), "")
        .map_err(|error| error.to_string())?;
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
        codex_bridge_pid: backend
            .codex_bridge
            .as_ref()
            .map(|managed| managed.child.id()),
        codex_bridge_log_path: codex_log_path(app).display().to_string(),
        codex_bridge_last_error: backend.codex_bridge_last_error.clone(),
        claude_plugin_installed: backend.claude_plugin_installed,
        claude_plugin_last_error: backend.claude_plugin_last_error.clone(),
        has_bash: backend.has_bash,
        has_node: backend.has_node,
        has_python3: backend.has_python3,
    }
}

fn menu_snapshot(backend: &AppBackend) -> MenuSnapshot {
    MenuSnapshot {
        state: backend.state.clone(),
        models: backend.models.clone(),
        codex_bridge_running: backend.codex_bridge.is_some(),
        claude_plugin_installed: backend.claude_plugin_installed,
        has_bash: backend.has_bash,
        has_node: backend.has_node,
        has_python3: backend.has_python3,
    }
}

fn update_tray_menu(app: &AppHandle) {
    let Some(state_mutex) = app.try_state::<BackendState>() else {
        return;
    };
    let Ok(backend) = state_mutex.lock() else {
        return;
    };
    let Some(tray) = backend.tray.clone() else {
        return;
    };
    let snapshot = menu_snapshot(&backend);
    drop(backend);
    let menu = build_menu(app, &snapshot).ok();
    if let Some(menu) = menu {
        let _ = tray.set_menu(Some(menu));
    }
}

fn motion_member_label(file_path: &str, index: usize) -> String {
    Path::new(file_path)
        .file_stem()
        .and_then(|name| name.to_str())
        .map(|name| {
            name.strip_suffix(".motion3")
                .unwrap_or(name)
                .trim_start_matches(|c: char| {
                    c.is_ascii_digit() || c == '_' || c == '-' || c.is_whitespace()
                })
                .to_string()
        })
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| format!("Motion {}", index + 1))
}

fn model_motion_groups(model: &Value) -> Vec<(String, Vec<(usize, String, String)>)> {
    let manifest_model = model
        .get("manifestModel")
        .or_else(|| model.get("model"))
        .unwrap_or(&Value::Null);
    let Some(base_path) = manifest_model.get("basePath").and_then(Value::as_str) else {
        return Vec::new();
    };
    let Some(model_json) = manifest_model
        .get("modelJson")
        .or_else(|| manifest_model.get("runtimeModelJson"))
        .and_then(Value::as_str)
    else {
        return Vec::new();
    };
    let Some(model3) = read_json(&project_root().join(base_path).join(model_json)) else {
        return Vec::new();
    };
    let Some(motions) = model3
        .pointer("/FileReferences/Motions")
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    motions
        .iter()
        .filter(|(motion, _)| !motion.is_empty())
        .map(|(motion, entries)| {
            let members = entries
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .enumerate()
                        .map(|(index, item)| {
                            let file = item
                                .get("File")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let label = motion_member_label(&file, index);
                            (index, file, label)
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            (motion.clone(), members)
        })
        .collect()
}

fn event_behavior_for_motion(model: &Value, motion: &str) -> Value {
    for group_name in ["events", "runtimeEvents"] {
        if let Some(map) = model.get(group_name).and_then(Value::as_object) {
            for behavior in map.values() {
                if behavior.get("motion").and_then(Value::as_str) == Some(motion) {
                    return behavior.clone();
                }
            }
        }
    }
    model
        .get("defaults")
        .cloned()
        .unwrap_or_else(|| json!({ "expression": "", "mood": "calm" }))
}

fn selected_model_config_from(state: &Value, models: &[ModelInfo]) -> Value {
    let selected = state
        .get("selectedModelId")
        .and_then(Value::as_str)
        .unwrap_or("nito");
    models
        .iter()
        .find(|model| model.id == selected)
        .or_else(|| models.first())
        .map(|model| model.config.clone())
        .unwrap_or(Value::Null)
}

fn selected_model_config(backend: &AppBackend) -> Value {
    selected_model_config_from(&backend.state, &backend.models)
}

fn build_menu(app: &AppHandle, snapshot: &MenuSnapshot) -> tauri::Result<tauri::menu::Menu<Wry>> {
    let state = &snapshot.state;
    let selected_model = state
        .get("selectedModelId")
        .and_then(Value::as_str)
        .unwrap_or("nito");
    let hidden = state
        .get("hidden")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let scale = state
        .pointer("/avatarTuning/scale")
        .and_then(Value::as_f64)
        .unwrap_or(100.0) as i64;
    let codex_bridge_enabled = state
        .get("codexBridgeEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let codex_bridge_running = snapshot.codex_bridge_running;
    let claude_plugin_installed = snapshot.claude_plugin_installed;
    let current_model = selected_model_config_from(&snapshot.state, &snapshot.models);

    let mut model_menu = SubmenuBuilder::new(app, "模型");
    for model in &snapshot.models {
        model_menu = model_menu.item(
            &CheckMenuItemBuilder::with_id(format!("model:{}", model.id), &model.name)
                .checked(model.id == selected_model)
                .build(app)?,
        );
    }

    let scale_menu = SubmenuBuilder::new(app, "角色大小").items(&[
        &CheckMenuItemBuilder::with_id("scale:preset:100", "大")
            .checked(scale == 100)
            .build(app)?,
        &CheckMenuItemBuilder::with_id("scale:preset:80", "中")
            .checked(scale == 80)
            .build(app)?,
        &CheckMenuItemBuilder::with_id("scale:preset:50", "小")
            .checked(scale == 50)
            .build(app)?,
    ]);

    let mut behavior_menu = SubmenuBuilder::new(app, "模型行为预览");
    let mut motion_groups = model_motion_groups(&current_model);
    if motion_groups.is_empty() {
        let mut seen = std::collections::BTreeSet::new();
        for group_name in ["events", "runtimeEvents"] {
            if let Some(map) = current_model.get(group_name).and_then(Value::as_object) {
                for behavior in map.values() {
                    if let Some(motion) = behavior
                        .get("motion")
                        .and_then(Value::as_str)
                        .filter(|motion| !motion.is_empty())
                    {
                        seen.insert(motion.to_string());
                    }
                }
            }
        }
        motion_groups = seen
            .into_iter()
            .map(|motion| (motion, Vec::new()))
            .collect();
    }
    if motion_groups.is_empty() {
        behavior_menu = behavior_menu.item(
            &MenuItemBuilder::new("当前模型无可用行为")
                .enabled(false)
                .build(app)?,
        );
    } else {
        for (motion, members) in motion_groups {
            if members.is_empty() {
                behavior_menu = behavior_menu.item(
                    &MenuItemBuilder::with_id(format!("preview:{motion}:0"), &motion).build(app)?,
                );
            } else {
                let mut motion_menu = SubmenuBuilder::new(app, &motion);
                for (index, _file, label) in members {
                    motion_menu = motion_menu.item(
                        &MenuItemBuilder::with_id(format!("preview:{motion}:{index}"), &label)
                            .build(app)?,
                    );
                }
                behavior_menu = behavior_menu.item(&motion_menu.build()?);
            }
        }
    }

    let codex_menu = SubmenuBuilder::new(app, "Codex bridge")
        .item(
            &MenuItemBuilder::new(if codex_bridge_enabled {
                if codex_bridge_running {
                    "已开启"
                } else {
                    "已开启，等待启动"
                }
            } else {
                "未开启"
            })
            .enabled(false)
            .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(
                "codex:toggle",
                if codex_bridge_enabled {
                    "关闭 Codex bridge"
                } else {
                    "开启 Codex bridge"
                },
            )
            .enabled(snapshot.has_python3)
            .build(app)?,
        );

    let claude_menu = SubmenuBuilder::new(app, "Claude 全局插件")
        .item(
            &MenuItemBuilder::new(if claude_plugin_installed {
                "已安装"
            } else {
                "未安装"
            })
            .enabled(false)
            .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(
                "claude:toggle",
                if claude_plugin_installed {
                    "卸载 Claude 全局插件"
                } else {
                    "安装 Claude 全局插件"
                },
            )
            .enabled(snapshot.has_bash && snapshot.has_node)
            .build(app)?,
        );

    let logs_menu = SubmenuBuilder::new(app, "日志")
        .item(&MenuItemBuilder::with_id("logs:open", "打开日志目录").build(app)?);

    MenuBuilder::new(app)
        .item(
            &MenuItemBuilder::with_id(
                "visibility:toggle",
                if hidden {
                    "显示角色"
                } else {
                    "隐藏角色"
                },
            )
            .build(app)?,
        )
        .separator()
        .item(
            &CheckMenuItemBuilder::with_id("alwaysOnTop:toggle", "始终置顶")
                .checked(
                    state
                        .get("alwaysOnTop")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                )
                .build(app)?,
        )
        .item(
            &CheckMenuItemBuilder::with_id("allWorkspaces:toggle", "所有桌面可见")
                .checked(
                    state
                        .get("allWorkspaces")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                )
                .build(app)?,
        )
        .item(
            &CheckMenuItemBuilder::with_id("clickThrough:toggle", "点击穿透")
                .checked(
                    state
                        .get("clickThrough")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )
                .build(app)?,
        )
        .separator()
        .item(&model_menu.build()?)
        .item(&behavior_menu.build()?)
        .item(&scale_menu.build()?)
        .item(&MenuItemBuilder::with_id("scale:reset", "恢复默认").build(app)?)
        .separator()
        .item(&codex_menu.build()?)
        .item(&claude_menu.build()?)
        .item(&logs_menu.build()?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("quit", "退出")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?,
        )
        .build()
}

fn update_state_inner(
    app: &AppHandle,
    backend: &mut AppBackend,
    partial: Value,
) -> Result<Value, String> {
    merge_value(&mut backend.state, &partial);
    backend.state = normalize_state(backend.state.clone(), &backend.models);
    apply_window_state(app, &backend.state);
    persist_state(app, backend)?;
    let public = public_state(app, backend);
    app.emit(STATE_EVENT, public.clone())
        .map_err(|error| error.to_string())?;
    Ok(public)
}

#[tauri::command]
fn get_overlay_state(app: AppHandle, backend: tauri::State<BackendState>) -> Result<Value, String> {
    let backend = backend
        .lock()
        .map_err(|_| "backend lock poisoned".to_string())?;
    Ok(public_state(&app, &backend))
}

#[tauri::command]
fn update_overlay_state(
    app: AppHandle,
    backend: tauri::State<BackendState>,
    partial_state: Value,
) -> Result<Value, String> {
    let mut backend = backend
        .lock()
        .map_err(|_| "backend lock poisoned".to_string())?;
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
    let backend = state
        .lock()
        .map_err(|_| "backend lock poisoned".to_string())?;
    Ok(public_state(&app, &backend))
}

fn current_window_frame(window: &WebviewWindow) -> Result<Value, String> {
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let position = window
        .outer_position()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale_factor);
    let size = window
        .inner_size()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale_factor);
    Ok(json!({
        "x": position.x,
        "y": position.y,
        "width": size.width,
        "height": size.height
    }))
}

#[tauri::command]
fn get_window_frame(app: AppHandle) -> Result<Value, String> {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return Err("main window unavailable".to_string());
    };
    current_window_frame(&window)
}

#[tauri::command]
fn set_window_position(
    app: AppHandle,
    backend: tauri::State<BackendState>,
    position: WindowPosition,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return Err("main window unavailable".to_string());
    };
    if !position.persist {
        {
            let mut backend = backend
                .lock()
                .map_err(|_| "backend lock poisoned".to_string())?;
            backend.suppress_window_move_persistence = true;
        }
        if let Err(error) = window.set_position(LogicalPosition::new(position.x, position.y)) {
            if let Some(state) = app.try_state::<BackendState>() {
                if let Ok(mut backend) = state.lock() {
                    backend.suppress_window_move_persistence = false;
                }
            }
            return Err(error.to_string());
        }
        return Ok(());
    }

    window
        .set_position(LogicalPosition::new(position.x, position.y))
        .map_err(|error| error.to_string())?;

    let frame = current_window_frame(&window)?;
    let next_bounds = normalize_live_window_bounds_for_window(
        &window,
        &json!({
            "x": position.x,
            "y": position.y,
            "width": frame.get("width").and_then(Value::as_f64).unwrap_or(420.0),
            "height": frame.get("height").and_then(Value::as_f64).unwrap_or(396.0)
        }),
    );
    let mut backend = backend
        .lock()
        .map_err(|_| "backend lock poisoned".to_string())?;
    backend.suppress_window_move_persistence = false;
    backend.state["windowBounds"] = next_bounds;
    persist_state(&app, &backend)
}

#[tauri::command]
fn sync_window_content_size(
    app: AppHandle,
    backend: tauri::State<BackendState>,
    size: ContentSize,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        return Err("main window unavailable".to_string());
    };
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let old_position = window
        .outer_position()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale_factor);
    let old_size = window
        .inner_size()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale_factor);
    let next_bounds = normalize_live_window_bounds_for_window(
        &window,
        &json!({
            "x": old_position.x,
            "y": old_position.y,
            "width": size.width,
            "height": size.height
        }),
    );
    let width = next_bounds
        .get("width")
        .and_then(Value::as_f64)
        .unwrap_or(420.0);
    let height = next_bounds
        .get("height")
        .and_then(Value::as_f64)
        .unwrap_or(584.0);
    if (old_size.width - width).abs() >= 2.0 || (old_size.height - height).abs() >= 2.0 {
        window
            .set_size(LogicalSize::new(width, height))
            .map_err(|error| error.to_string())?;
    }

    let mut backend = backend
        .lock()
        .map_err(|_| "backend lock poisoned".to_string())?;
    backend.state["windowBounds"] = next_bounds;
    persist_state(&app, &backend)
}

#[tauri::command]
fn read_text_file(relative_path: String) -> Result<String, String> {
    let relative = Path::new(&relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("relative path must stay inside the app bundle".to_string());
    }
    let path = project_root().join(relative);
    fs::read_to_string(&path).map_err(|error| format!("Failed to load {}: {error}", path.display()))
}

#[tauri::command]
fn quit_app(app: AppHandle) -> bool {
    app.exit(0);
    true
}

#[tauri::command]
async fn generate_persona_dialogue(
    app: AppHandle,
    backend: tauri::State<'_, BackendState>,
    payload: Value,
) -> Result<Value, String> {
    let settings = {
        let backend = backend
            .lock()
            .map_err(|_| "backend lock poisoned".to_string())?;
        backend
            .state
            .get("personaDialogue")
            .cloned()
            .unwrap_or_else(|| json!({}))
    };
    let enabled = settings
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
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

    let api_url = settings
        .get("apiUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let api_url = if api_url.ends_with("/chat/completions") || api_url.ends_with("/responses") {
        api_url.to_string()
    } else {
        format!("{}/v1/chat/completions", api_url.trim_end_matches('/'))
    };
    let model = settings
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("gpt-4.1-mini");
    let fallback = payload
        .get("fallbackText")
        .and_then(Value::as_str)
        .unwrap_or("");
    let prompt = format!("根据桌面 Live2D 助手状态生成一句简短中文台词。只返回 JSON: {{\"lines\":[\"...\"]}}。\n上下文: {}", payload);
    let timeout_ms = settings
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(8000);
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
    let parsed = serde_json::from_str::<Value>(&raw)
        .unwrap_or_else(|_| json!({ "choices": [{ "message": { "content": raw } }] }));
    let content = parsed
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .or_else(|| parsed.get("output_text").and_then(Value::as_str))
        .unwrap_or(fallback);
    let lines = serde_json::from_str::<Value>(content)
        .ok()
        .and_then(|value| value.get("lines").and_then(Value::as_array).cloned())
        .map(|lines| {
            lines
                .into_iter()
                .filter_map(|line| line.as_str().map(str::trim).map(str::to_string))
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|lines| !lines.is_empty())
        .unwrap_or_else(|| vec![content.trim().to_string()]);
    let text = lines
        .first()
        .cloned()
        .unwrap_or_else(|| fallback.to_string());
    let _ = app.emit(PREVIEW_EVENT, json!({ "previewText": text }));
    Ok(
        json!({ "ok": true, "text": text, "lines": lines, "provider": "openai-compatible", "model": model }),
    )
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
        "visibility:toggle" => {
            patch["hidden"] = Value::Bool(
                !backend
                    .state
                    .get("hidden")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            )
        }
        "alwaysOnTop:toggle" => {
            patch["alwaysOnTop"] = Value::Bool(
                !backend
                    .state
                    .get("alwaysOnTop")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
            )
        }
        "allWorkspaces:toggle" => {
            patch["allWorkspaces"] = Value::Bool(
                !backend
                    .state
                    .get("allWorkspaces")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
            )
        }
        "clickThrough:toggle" => {
            patch["clickThrough"] = Value::Bool(
                !backend
                    .state
                    .get("clickThrough")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            )
        }
        "scale:reset" => {
            patch["avatarTuning"] = json!({ "scale": 100, "offsetX": 0, "offsetY": 0 })
        }
        id if id.starts_with("scale:preset:") => {
            if let Ok(scale) = id.trim_start_matches("scale:preset:").parse::<f64>() {
                patch["avatarTuning"] = json!({ "scale": scale });
            }
        }
        id if id.starts_with("preview:") => {
            let mut parts = id.splitn(3, ':');
            let _ = parts.next();
            let motion = parts.next().unwrap_or("Idle");
            let motion_index = parts
                .next()
                .and_then(|raw| raw.parse::<usize>().ok())
                .unwrap_or(0);
            let model = selected_model_config(&backend);
            let behavior = event_behavior_for_motion(&model, motion);
            let _ = app.emit(
                PREVIEW_EVENT,
                json!({
                    "mood": behavior.get("mood").and_then(Value::as_str).unwrap_or("calm"),
                    "expression": behavior.get("expression").and_then(Value::as_str).unwrap_or(""),
                    "motion": motion,
                    "motionIndex": motion_index,
                    "source": "tray-preview",
                    "label": motion
                }),
            );
        }
        "codex:toggle" => {
            let app_for_task = app.clone();
            drop(backend);
            tauri::async_runtime::spawn_blocking(move || {
                if let Some(state) = app_for_task.try_state::<BackendState>() {
                    if let Ok(mut backend) = state.lock() {
                        if backend.codex_bridge.is_some() {
                            let mut codex_bridge = backend.codex_bridge.take();
                            let _ = update_state_inner(
                                &app_for_task,
                                &mut backend,
                                json!({ "codexBridgeEnabled": false }),
                            );
                            drop(backend);
                            stop_child(&mut codex_bridge);
                        } else {
                            drop(backend);
                            if let Err(error) =
                                start_codex_bridge_without_backend_lock(&app_for_task)
                            {
                                if let Some(state) = app_for_task.try_state::<BackendState>() {
                                    if let Ok(mut backend) = state.lock() {
                                        backend.codex_bridge_last_error = error;
                                        let _ = app_for_task.emit(
                                            STATE_EVENT,
                                            public_state(&app_for_task, &backend),
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
                update_tray_menu(&app_for_task);
            });
            return;
        }
        "claude:toggle" => {
            let app_for_task = app.clone();
            let should_uninstall = backend.claude_plugin_installed;
            drop(backend);
            tauri::async_runtime::spawn_blocking(move || {
                let result = if should_uninstall {
                    uninstall_claude_plugin()
                } else {
                    install_claude_plugin(&app_for_task)
                };
                if let Some(state) = app_for_task.try_state::<BackendState>() {
                    if let Ok(mut backend) = state.lock() {
                        match result {
                            Ok(()) => {
                                backend.claude_plugin_installed = !should_uninstall;
                                backend.claude_plugin_last_error.clear();
                            }
                            Err(error) => {
                                backend.claude_plugin_last_error = error;
                            }
                        }
                        let _ =
                            app_for_task.emit(STATE_EVENT, public_state(&app_for_task, &backend));
                    }
                }
                update_tray_menu(&app_for_task);
            });
            return;
        }
        "logs:open" => {
            let _ = fs::create_dir_all(log_dir(app));
            let _ = Command::new("open").arg(log_dir(app)).spawn();
        }
        "quit" => app.exit(0),
        id if id.starts_with("model:") => {
            patch["selectedModelId"] = Value::String(id.trim_start_matches("model:").to_string())
        }
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
    if let Some(persona) =
        read_json(&persona_config_path()).and_then(|value| value.get("personaDialogue").cloned())
    {
        state["personaDialogue"] = persona;
    }
    state = normalize_state(state, &models);
    let has_bash = !resolve_command("bash").is_empty();
    let has_node = !resolve_command("node").is_empty();
    let has_python3 = !resolve_command("python3").is_empty();
    AppBackend {
        state,
        models,
        tray: None,
        protocol: None,
        codex_bridge: None,
        protocol_last_error: String::new(),
        codex_bridge_last_error: String::new(),
        claude_plugin_installed: is_claude_installed(),
        claude_plugin_last_error: String::new(),
        has_bash,
        has_node,
        has_python3,
        suppress_window_move_persistence: false,
    }
}

fn create_window(app: &AppHandle, state: &Value) -> tauri::Result<WebviewWindow> {
    let bounds =
        normalize_window_bounds_for_app(app, state.get("windowBounds").unwrap_or(&Value::Null));
    WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::default())
        .title("DPartner")
        .inner_size(
            bounds.get("width").and_then(Value::as_f64).unwrap_or(420.0),
            bounds
                .get("height")
                .and_then(Value::as_f64)
                .unwrap_or(720.0),
        )
        .position(
            bounds.get("x").and_then(Value::as_f64).unwrap_or(0.0),
            bounds.get("y").and_then(Value::as_f64).unwrap_or(0.0),
        )
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
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["CommandOrControl+Shift+X", "CommandOrControl+Shift+H"])
                .expect("valid global shortcut definitions")
                .with_handler(|app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    let Some(state) = app.try_state::<BackendState>() else {
                        return;
                    };
                    let mut backend = match state.lock() {
                        Ok(backend) => backend,
                        Err(_) => return,
                    };
                    let expected_mods = if cfg!(target_os = "macos") {
                        Modifiers::SUPER | Modifiers::SHIFT
                    } else {
                        Modifiers::CONTROL | Modifiers::SHIFT
                    };
                    let patch = if shortcut.matches(expected_mods, Code::KeyX) {
                        json!({ "clickThrough": false })
                    } else if shortcut.matches(expected_mods, Code::KeyH) {
                        json!({ "hidden": !backend.state.get("hidden").and_then(Value::as_bool).unwrap_or(false) })
                    } else {
                        json!({})
                    };
                    if patch != json!({}) {
                        let _ = update_state_inner(app, &mut backend, patch);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_overlay_state,
            update_overlay_state,
            open_overlay_menu,
            quit_app,
            get_window_frame,
            set_window_position,
            sync_window_content_size,
            read_text_file,
            generate_persona_dialogue
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let backend = load_initial_backend(&handle);
            let initial_window_state = backend.state.clone();
            app.manage(Mutex::new(backend));

            let window = create_window(&handle, &initial_window_state)?;
            apply_macos_overlay_window_level(&window);
            {
                let state = app.state::<BackendState>();
                if let Ok(backend) = state.lock() {
                    apply_window_state(&handle, &backend.state);
                    let snapshot = menu_snapshot(&backend);
                    drop(backend);
                    let menu = build_menu(&handle, &snapshot)?;
                    let tray_icon = tray_template_icon(&handle);
                    let tray = TrayIconBuilder::new()
                        .tooltip("DPartner")
                        .icon(tray_icon)
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
                        if backend
                            .state
                            .get("codexBridgeEnabled")
                            .and_then(Value::as_bool)
                            .unwrap_or(false)
                        {
                            let _ = start_codex_bridge(&app_for_start, &mut backend);
                        }
                    }
                }
                while start.elapsed() < Duration::from_secs(2) {
                    tokio_sleep(Duration::from_millis(250)).await;
                }
                broadcast_state(&app_for_start);
            });
            let app_for_watchdog = handle.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio_sleep(Duration::from_secs(5)).await;
                    if let Some(state) = app_for_watchdog.try_state::<BackendState>() {
                        let mut should_broadcast = false;
                        if let Ok(mut backend) = state.lock() {
                            if child_exited(&mut backend.protocol) {
                                backend.protocol_last_error =
                                    "devflow-protocol exited unexpectedly".to_string();
                                should_broadcast = true;
                            }
                            if child_exited(&mut backend.codex_bridge) {
                                backend.codex_bridge_last_error =
                                    "Codex bridge exited unexpectedly".to_string();
                                should_broadcast = true;
                            }
                            if backend
                                .state
                                .get("codexBridgeEnabled")
                                .and_then(Value::as_bool)
                                .unwrap_or(false)
                                && backend.codex_bridge.is_none()
                            {
                                let _ = start_codex_bridge(&app_for_watchdog, &mut backend);
                                should_broadcast = true;
                            }
                        }
                        if should_broadcast {
                            broadcast_state(&app_for_watchdog);
                            update_tray_menu(&app_for_watchdog);
                        }
                    }
                }
            });
            let app_for_overlay_reinforce = handle.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio_sleep(MACOS_OVERLAY_REINFORCE_INTERVAL).await;
                    let app_for_main_thread = app_for_overlay_reinforce.clone();
                    let _ = app_for_overlay_reinforce.run_on_main_thread(move || {
                        let should_reinforce = app_for_main_thread
                            .try_state::<BackendState>()
                            .and_then(|state| {
                                state.lock().ok().map(|backend| {
                                    !backend
                                        .state
                                        .get("hidden")
                                        .and_then(Value::as_bool)
                                        .unwrap_or(false)
                                        && backend
                                            .state
                                            .get("alwaysOnTop")
                                            .and_then(Value::as_bool)
                                            .unwrap_or(true)
                                })
                            })
                            .unwrap_or(false);
                        if should_reinforce {
                            if let Some(window) = app_for_main_thread.get_webview_window(WINDOW_LABEL)
                            {
                                reinforce_macos_overlay_window_level(&window);
                            }
                        }
                    });
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Moved(_)) {
                if let Some(state) = window.app_handle().try_state::<BackendState>() {
                    if let Ok(backend) = state.lock() {
                        if backend.suppress_window_move_persistence {
                            return;
                        }
                    }
                }
            }
            if matches!(
                event,
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
            ) {
                let scale_factor = window.scale_factor().unwrap_or(1.0);
                let position = window
                    .outer_position()
                    .ok()
                    .map(|position| position.to_logical::<f64>(scale_factor));
                let size = window
                    .inner_size()
                    .ok()
                    .map(|size| size.to_logical::<f64>(scale_factor));
                if let (Some(position), Some(size), Some(state)) = (
                    position,
                    size,
                    window.app_handle().try_state::<BackendState>(),
                ) {
                    if let Ok(mut backend) = state.lock() {
                        backend.state["windowBounds"] = normalize_window_bounds_for_tauri_window(
                            window,
                            &json!({
                                "x": position.x,
                                "y": position.y,
                                "width": size.width,
                                "height": size.height
                            }),
                        );
                        let _ = persist_state(window.app_handle(), &backend);
                    }
                }
            }
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
