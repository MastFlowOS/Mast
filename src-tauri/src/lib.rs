use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerStatus {
    pub is_running: bool,
    pub status: String,
    pub pid: Option<u32>,
    pub last_error: Option<String>,
    pub recent_logs: Vec<String>,
}

#[derive(Default)]
pub struct AppState {
    pub worker_child: Arc<Mutex<Option<Child>>>,
    pub status: Arc<Mutex<String>>,
    pub last_error: Arc<Mutex<Option<String>>>,
    pub recent_logs: Arc<Mutex<Vec<String>>>,
}

fn push_log(logs: &Arc<Mutex<Vec<String>>>, raw_line: &str) {
    let mut sanitized = raw_line.to_string();

    // Redact Bearer credentials if present
    if let Some(idx) = sanitized.find("Bearer ") {
        sanitized = format!("{}[REDACTED_AUTH_TOKEN]", &sanitized[..idx + 7]);
    }

    // Redact standalone JWT tokens (eyJ...)
    if let Some(idx) = sanitized.find("eyJ") {
        if let Some(end_idx) = sanitized[idx..].find(|c: char| c.is_whitespace() || c == '"' || c == '\'') {
            sanitized.replace_range(idx..idx + end_idx, "[REDACTED_JWT]");
        } else {
            sanitized.truncate(idx);
            sanitized.push_str("[REDACTED_JWT]");
        }
    }

    let mut l = logs.lock().unwrap();
    if l.len() >= 200 {
        l.remove(0);
    }
    l.push(sanitized);
}

fn validate_api_url(raw_url: &str) -> Result<String, String> {
    let trimmed = raw_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        #[cfg(debug_assertions)]
        return Ok("http://localhost:3000".to_string());

        #[cfg(not(debug_assertions))]
        return Err("API URL cannot be empty in production builds.".to_string());
    }

    let (scheme, rest) = if let Some(s) = trimmed.strip_prefix("https://") {
        ("https", s)
    } else if let Some(s) = trimmed.strip_prefix("http://") {
        ("http", s)
    } else {
        return Err("API URL must begin with https:// or http://".to_string());
    };

    let host_and_port = rest.split('/').next().unwrap_or("");
    let host = host_and_port.split(':').next().unwrap_or("").to_lowercase();

    if host == "localhost" || host == "127.0.0.1" {
        #[cfg(debug_assertions)]
        return Ok(trimmed.to_string());

        #[cfg(not(debug_assertions))]
        return Err("Connecting to localhost is disallowed in production builds.".to_string());
    }

    if scheme != "https" {
        return Err("Remote API connections must use HTTPS".to_string());
    }

    let is_allowed = host == "mast-flow.com"
        || host.ends_with(".mast-flow.com")
        || host.ends_with(".railway.app")
        || host.ends_with(".supabase.co");

    if !is_allowed {
        return Err(format!(
            "Unauthorized API host: '{}'. Only approved MAST cloud domains are allowed.",
            host
        ));
    }

    Ok(trimmed.to_string())
}

fn get_mast_data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let p = PathBuf::from(local_app_data).join("MAST");
            let _ = std::fs::create_dir_all(&p);
            return p;
        }
        if let Ok(app_data) = std::env::var("APPDATA") {
            let p = PathBuf::from(app_data).join("MAST");
            let _ = std::fs::create_dir_all(&p);
            return p;
        }
    }
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        let p = PathBuf::from(home).join(".mast");
        let _ = std::fs::create_dir_all(&p);
        return p;
    }
    let p = PathBuf::from(".mast");
    let _ = std::fs::create_dir_all(&p);
    p
}

fn write_auth_token_file(token: &str) {
    let dir = get_mast_data_dir();
    let token_file = dir.join("auth.token");
    let _ = std::fs::write(&token_file, token.trim());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o600));
    }
}

fn remove_auth_token_file() {
    let dir = get_mast_data_dir();
    let token_file = dir.join("auth.token");
    let _ = std::fs::remove_file(token_file);
}

fn resolve_worker_path(app: &AppHandle) -> Result<(PathBuf, Vec<String>), String> {
    // 1. Packaged resource directory (<resource_dir>/bin/mast-desktop-worker/mast-desktop-worker.exe or <resource_dir>/bin/mast-desktop-worker.exe)
    if let Ok(resource_dir) = app.path().resource_dir() {
        let packaged_sub = resource_dir.join("bin").join("mast-desktop-worker").join("mast-desktop-worker.exe");
        if packaged_sub.exists() {
            return Ok((packaged_sub, vec![]));
        }
        let packaged_root = resource_dir.join("bin").join("mast-desktop-worker.exe");
        if packaged_root.exists() {
            return Ok((packaged_root, vec![]));
        }
    }

    // 2. Relative to current exe
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            let local_sub = exe_dir.join("bin").join("mast-desktop-worker").join("mast-desktop-worker.exe");
            if local_sub.exists() {
                return Ok((local_sub, vec![]));
            }
            let local_bin = exe_dir.join("mast-desktop-worker.exe");
            if local_bin.exists() {
                return Ok((local_bin, vec![]));
            }
            let dist_bin = exe_dir.join("dist-worker").join("mast-desktop-worker").join("mast-desktop-worker.exe");
            if dist_bin.exists() {
                return Ok((dist_bin, vec![]));
            }
        }
    }

    // 3. Workspace dev / staged directories
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let staged = cwd.join("src-tauri").join("bin").join("mast-desktop-worker").join("mast-desktop-worker.exe");
    if staged.exists() {
        return Ok((staged, vec![]));
    }
    let dev_dist = cwd.join("dist-worker").join("mast-desktop-worker").join("mast-desktop-worker.exe");
    if dev_dist.exists() {
        return Ok((dev_dist, vec![]));
    }

    // 4. Dev fallback: python mast-lead-engine/desktop_worker.py
    let py_script = cwd.join("mast-lead-engine").join("desktop_worker.py");
    if py_script.exists() {
        return Ok((PathBuf::from("python"), vec![py_script.to_string_lossy().to_string()]));
    }

    Err("MAST Desktop Worker executable not found. Build mast-desktop-worker or bundle in bin/.".to_string())
}

#[tauri::command]
fn get_desktop_info() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "is_desktop": true,
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

#[tauri::command]
fn get_worker_status(state: State<AppState>) -> Result<WorkerStatus, String> {
    let mut child_guard = state.worker_child.lock().unwrap();
    let mut status_guard = state.status.lock().unwrap();
    let mut last_error_guard = state.last_error.lock().unwrap();
    let logs_guard = state.recent_logs.lock().unwrap();

    let mut pid = None;
    let mut is_running = false;

    if let Some(ref mut child) = *child_guard {
        match child.try_wait() {
            Ok(Some(exit_status)) => {
                is_running = false;
                if !exit_status.success() && last_error_guard.is_none() {
                    *last_error_guard = Some(format!("Worker process exited with code: {:?}", exit_status.code()));
                    *status_guard = "error".to_string();
                } else {
                    *status_guard = "stopped".to_string();
                }
                *child_guard = None;
            }
            Ok(None) => {
                is_running = true;
                pid = Some(child.id());
                *status_guard = "running".to_string();
            }
            Err(e) => {
                *last_error_guard = Some(format!("Failed to query worker status: {}", e));
                *status_guard = "error".to_string();
            }
        }
    }

    Ok(WorkerStatus {
        is_running,
        status: status_guard.clone(),
        pid,
        last_error: last_error_guard.clone(),
        recent_logs: logs_guard.clone(),
    })
}

#[tauri::command]
fn start_worker(
    app: AppHandle,
    state: State<AppState>,
    api_url: Option<String>,
    auth_token: String,
) -> Result<WorkerStatus, String> {
    if auth_token.trim().is_empty() {
        return Err("A valid user JWT authentication token is required to start the desktop worker.".to_string());
    }

    let raw_api_url = match api_url {
        Some(ref u) if !u.trim().is_empty() => u.clone(),
        _ => {
            #[cfg(debug_assertions)]
            {
                "http://localhost:3000".to_string()
            }
            #[cfg(not(debug_assertions))]
            {
                return Err("API URL is required to start the desktop worker in production.".to_string());
            }
        }
    };

    // SSRF & token exfiltration guard: strictly validate target API host
    let validated_api_url = validate_api_url(&raw_api_url)?;

    let mut child_guard = state.worker_child.lock().unwrap();
    if let Some(ref mut child) = *child_guard {
        if let Ok(None) = child.try_wait() {
            return Ok(WorkerStatus {
                is_running: true,
                status: "running".to_string(),
                pid: Some(child.id()),
                last_error: None,
                recent_logs: state.recent_logs.lock().unwrap().clone(),
            });
        }
    }

    let (executable, initial_args) = resolve_worker_path(&app)?;
    let mut cmd = Command::new(&executable);
    if let Some(parent_dir) = executable.parent() {
        cmd.current_dir(parent_dir);
    }
    for arg in initial_args {
        cmd.arg(arg);
    }

    cmd.arg("--api-url").arg(validated_api_url);

    // Pass auth token securely via environment variable (not visible in command line / Process Explorer)
    write_auth_token_file(&auth_token);
    cmd.env("MAST_AUTH_TOKEN", auth_token.trim());

    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW = 0x08000000
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn worker ({:?}): {}", executable, e))?;
    let pid = child.id();

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let logs_arc = Arc::clone(&state.recent_logs);
    let err_slot = Arc::clone(&state.last_error);

    if let Some(out) = stdout {
        let logs = Arc::clone(&logs_arc);
        thread::spawn(move || {
            let reader = BufReader::new(out);
            for line in reader.lines().flatten() {
                push_log(&logs, &line);
            }
        });
    }

    if let Some(err) = stderr {
        let logs = Arc::clone(&logs_arc);
        let err_slot_clone = Arc::clone(&err_slot);
        thread::spawn(move || {
            let reader = BufReader::new(err);
            for line in reader.lines().flatten() {
                if line.contains("[ERROR]") || line.contains("Error") {
                    let mut e = err_slot_clone.lock().unwrap();
                    *e = Some(line.clone());
                }
                push_log(&logs, &line);
            }
        });
    }

    *child_guard = Some(child);
    *state.status.lock().unwrap() = "running".to_string();
    *state.last_error.lock().unwrap() = None;

    Ok(WorkerStatus {
        is_running: true,
        status: "running".to_string(),
        pid: Some(pid),
        last_error: None,
        recent_logs: state.recent_logs.lock().unwrap().clone(),
    })
}

#[tauri::command]
fn update_worker_token(auth_token: String) -> Result<(), String> {
    if auth_token.trim().is_empty() {
        return Err("Cannot update with empty auth token".to_string());
    }
    write_auth_token_file(&auth_token);
    Ok(())
}

#[tauri::command]
fn stop_worker(state: State<AppState>) -> Result<WorkerStatus, String> {
    let mut child_guard = state.worker_child.lock().unwrap();
    if let Some(ref mut child) = *child_guard {
        let _ = child.kill();
        let _ = child.wait();
    }
    *child_guard = None;
    *state.status.lock().unwrap() = "stopped".to_string();
    remove_auth_token_file();

    Ok(WorkerStatus {
        is_running: false,
        status: "stopped".to_string(),
        pid: None,
        last_error: state.last_error.lock().unwrap().clone(),
        recent_logs: state.recent_logs.lock().unwrap().clone(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = AppState {
        worker_child: Arc::new(Mutex::new(None)),
        status: Arc::new(Mutex::new("stopped".to_string())),
        last_error: Arc::new(Mutex::new(None)),
        recent_logs: Arc::new(Mutex::new(Vec::new())),
    };

    tauri::Builder::default()
        .manage(app_state)
        .plugin(tauri_plugin_log::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            get_desktop_info,
            get_worker_status,
            start_worker,
            stop_worker,
            update_worker_token
        ])
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                    let state = window.state::<AppState>();
                    let mut child_guard = state.worker_child.lock().unwrap();
                    if let Some(ref mut child) = *child_guard {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                    *child_guard = None;
                    remove_auth_token_file();
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_api_url_valid_railway() {
        let res = validate_api_url("https://mast-production-4e64.up.railway.app/");
        assert_eq!(res.unwrap(), "https://mast-production-4e64.up.railway.app");
    }

    #[test]
    fn test_validate_api_url_valid_mast_domain() {
        let res = validate_api_url("https://app.mast-flow.com");
        assert_eq!(res.unwrap(), "https://app.mast-flow.com");
    }

    #[test]
    fn test_validate_api_url_rejects_unauthorized_host() {
        let res = validate_api_url("https://evil.example.com");
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Unauthorized API host"));
    }

    #[test]
    fn test_validate_api_url_rejects_insecure_remote_http() {
        let res = validate_api_url("http://mast-production-4e64.up.railway.app");
        assert!(res.unwrap_err().contains("Remote API connections must use HTTPS"));
    }

    #[test]
    fn test_acl_permission_resolution() {
        let acl_json = include_str!("../gen/schemas/acl-manifests.json");
        let cap_json = include_str!("../gen/schemas/capabilities.json");
        let acl: std::collections::BTreeMap<String, tauri::utils::acl::manifest::Manifest> =
            serde_json::from_str(acl_json).unwrap();
        let cap: std::collections::BTreeMap<String, tauri::utils::acl::capability::Capability> =
            serde_json::from_str(cap_json).unwrap();
        let target = tauri::utils::platform::Target::Windows;
        let resolved =
            tauri::utils::acl::resolved::Resolved::resolve(&acl, cap, target).unwrap();
        assert!(resolved.has_app_acl);

        let required_commands = [
            "get_desktop_info",
            "get_worker_status",
            "start_worker",
            "stop_worker",
            "update_worker_token",
        ];

        for cmd in required_commands {
            assert!(
                resolved.allowed_commands.contains_key(cmd),
                "allowed_commands does not contain {}! Found: {:?}",
                cmd,
                resolved.allowed_commands.keys().collect::<Vec<_>>()
            );
            let cmds = resolved.allowed_commands.get(cmd).unwrap();
            assert!(!cmds.is_empty(), "Resolved command list is empty for {}", cmd);
        }
    }
}
