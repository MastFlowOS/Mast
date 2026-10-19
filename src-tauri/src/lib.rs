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

fn sanitize_log_line(raw: &str) -> String {
    let mut sanitized = raw.to_string();

    // Redact Bearer credentials if present
    if let Some(idx) = sanitized.find("Bearer ") {
        let after = &sanitized[idx + 7..];
        let token_len = after.find(|c: char| c.is_whitespace() || c == '"' || c == '\'').unwrap_or(after.len());
        sanitized.replace_range(idx + 7..idx + 7 + token_len, "[REDACTED_AUTH_TOKEN]");
    }

    // Redact standalone JWT tokens (eyJ...)
    while let Some(idx) = sanitized.find("eyJ") {
        if let Some(end_idx) = sanitized[idx..].find(|c: char| c.is_whitespace() || c == '"' || c == '\'') {
            sanitized.replace_range(idx..idx + end_idx, "[REDACTED_JWT]");
        } else {
            sanitized.truncate(idx);
            sanitized.push_str("[REDACTED_JWT]");
            break;
        }
    }

    sanitized
}

fn push_log(logs: &Arc<Mutex<Vec<String>>>, sanitized: &str) {
    let mut l = logs.lock().unwrap();
    if l.len() >= 200 {
        l.remove(0);
    }
    l.push(sanitized.to_string());
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

#[derive(Debug, Clone)]
pub struct ResolvedWorker {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub work_dir: PathBuf,
    pub is_python: bool,
    pub mode: String,
}

fn resolve_worker(app: &AppHandle) -> Result<ResolvedWorker, String> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

    // 0. Manual environment variable override (e.g. MAST_DESKTOP_WORKER_PATH or MAST_WORKER_EXECUTABLE)
    if let Ok(override_path_str) = std::env::var("MAST_DESKTOP_WORKER_PATH").or_else(|_| std::env::var("MAST_WORKER_EXECUTABLE")) {
        let override_path = PathBuf::from(&override_path_str);
        if override_path.exists() {
            if override_path.extension().map_or(false, |ext| ext == "py") {
                let work_dir = override_path.parent().and_then(|p| p.parent()).unwrap_or(&cwd).to_path_buf();
                return Ok(ResolvedWorker {
                    executable: PathBuf::from("python"),
                    args: vec![override_path.to_string_lossy().to_string()],
                    work_dir,
                    is_python: true,
                    mode: "custom-override-python".to_string(),
                });
            } else {
                let work_dir = override_path.parent().unwrap_or(&cwd).to_path_buf();
                return Ok(ResolvedWorker {
                    executable: override_path,
                    args: vec![],
                    work_dir,
                    is_python: false,
                    mode: "custom-override-binary".to_string(),
                });
            }
        }
    }

    // 1. In development mode (debug_assertions), prioritize the live Python source script
    // unless explicitly overridden by MAST_DESKTOP_USE_PACKAGED_WORKER=1
    let force_packaged = std::env::var("MAST_DESKTOP_USE_PACKAGED_WORKER")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    if cfg!(debug_assertions) && !force_packaged {
        // Find mast-lead-engine/desktop_worker.py
        let candidate_dirs = [
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().map(|p| p.to_path_buf()),
            Some(cwd.clone()),
            cwd.parent().map(|p| p.to_path_buf()),
        ];

        for base in candidate_dirs.into_iter().flatten() {
            let py_script = base.join("mast-lead-engine").join("desktop_worker.py");
            if py_script.exists() {
                return Ok(ResolvedWorker {
                    executable: PathBuf::from("python"),
                    args: vec![py_script.to_string_lossy().to_string()],
                    work_dir: base,
                    is_python: true,
                    mode: "development-python".to_string(),
                });
            }
        }
    }

    // 2. Packaged resource directory (<resource_dir>/bin/mast-desktop-worker/mast-desktop-worker.exe or <resource_dir>/bin/mast-desktop-worker.exe)
    if let Ok(resource_dir) = app.path().resource_dir() {
        let packaged_sub = resource_dir.join("bin").join("mast-desktop-worker").join("mast-desktop-worker.exe");
        if packaged_sub.exists() {
            let work_dir = packaged_sub.parent().unwrap_or(&cwd).to_path_buf();
            return Ok(ResolvedWorker {
                executable: packaged_sub,
                args: vec![],
                work_dir,
                is_python: false,
                mode: "packaged-resource".to_string(),
            });
        }
        let packaged_root = resource_dir.join("bin").join("mast-desktop-worker.exe");
        if packaged_root.exists() {
            let work_dir = packaged_root.parent().unwrap_or(&cwd).to_path_buf();
            return Ok(ResolvedWorker {
                executable: packaged_root,
                args: vec![],
                work_dir,
                is_python: false,
                mode: "packaged-resource".to_string(),
            });
        }
    }

    // 3. Relative to current exe (installed or release build)
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            let local_sub = exe_dir.join("bin").join("mast-desktop-worker").join("mast-desktop-worker.exe");
            if local_sub.exists() {
                let work_dir = local_sub.parent().unwrap_or(&cwd).to_path_buf();
                return Ok(ResolvedWorker {
                    executable: local_sub,
                    args: vec![],
                    work_dir,
                    is_python: false,
                    mode: "packaged-exe-relative".to_string(),
                });
            }
            let local_bin = exe_dir.join("mast-desktop-worker.exe");
            if local_bin.exists() {
                let work_dir = local_bin.parent().unwrap_or(&cwd).to_path_buf();
                return Ok(ResolvedWorker {
                    executable: local_bin,
                    args: vec![],
                    work_dir,
                    is_python: false,
                    mode: "packaged-exe-relative".to_string(),
                });
            }
            let dist_bin = exe_dir.join("dist-worker").join("mast-desktop-worker").join("mast-desktop-worker.exe");
            if dist_bin.exists() {
                let work_dir = dist_bin.parent().unwrap_or(&cwd).to_path_buf();
                return Ok(ResolvedWorker {
                    executable: dist_bin,
                    args: vec![],
                    work_dir,
                    is_python: false,
                    mode: "packaged-dist".to_string(),
                });
            }
        }
    }

    // 4. Staged or dist binaries in dev/build directory (used when packaging or testing binary builds)
    let staged = cwd.join("src-tauri").join("bin").join("mast-desktop-worker").join("mast-desktop-worker.exe");
    if staged.exists() {
        let work_dir = staged.parent().unwrap_or(&cwd).to_path_buf();
        return Ok(ResolvedWorker {
            executable: staged,
            args: vec![],
            work_dir,
            is_python: false,
            mode: "development-staged-binary".to_string(),
        });
    }
    let dev_dist = cwd.join("dist-worker").join("mast-desktop-worker").join("mast-desktop-worker.exe");
    if dev_dist.exists() {
        let work_dir = dev_dist.parent().unwrap_or(&cwd).to_path_buf();
        return Ok(ResolvedWorker {
            executable: dev_dist,
            args: vec![],
            work_dir,
            is_python: false,
            mode: "development-dist-binary".to_string(),
        });
    }

    // 5. Fallback to python script if binaries not found (even in non-debug mode)
    let candidate_dirs = [
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().map(|p| p.to_path_buf()),
        Some(cwd.clone()),
        cwd.parent().map(|p| p.to_path_buf()),
    ];
    for base in candidate_dirs.into_iter().flatten() {
        let py_script = base.join("mast-lead-engine").join("desktop_worker.py");
        if py_script.exists() {
            return Ok(ResolvedWorker {
                executable: PathBuf::from("python"),
                args: vec![py_script.to_string_lossy().to_string()],
                work_dir: base,
                is_python: true,
                mode: "python-fallback".to_string(),
            });
        }
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

    let resolved = resolve_worker(&app)?;
    let mut cmd = Command::new(&resolved.executable);
    cmd.current_dir(&resolved.work_dir);

    for arg in &resolved.args {
        cmd.arg(arg);
    }

    cmd.arg("--api-url").arg(validated_api_url);
    cmd.arg("--concurrency").arg("1");

    // Pass auth token securely via environment variable (not visible in command line / Process Explorer)
    write_auth_token_file(&auth_token);
    cmd.env("MAST_AUTH_TOKEN", auth_token.trim());

    if resolved.is_python {
        cmd.env("PYTHONUNBUFFERED", "1");
        cmd.env("PYTHONIOENCODING", "utf-8");
    }

    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW = 0x08000000
        cmd.creation_flags(0x08000000);
    }

    println!(
        "[desktop-worker:launcher] Spawning worker mode={} executable={:?} work_dir={:?} args={:?}",
        resolved.mode, resolved.executable, resolved.work_dir, resolved.args
    );

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn worker ({:?}): {}", resolved.executable, e))?;
    let pid = child.id();
    println!(
        "[desktop-worker:launcher] Worker process started successfully with PID {}",
        pid
    );

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let logs_arc = Arc::clone(&state.recent_logs);
    let err_slot = Arc::clone(&state.last_error);

    if let Some(out) = stdout {
        let logs = Arc::clone(&logs_arc);
        thread::spawn(move || {
            let reader = BufReader::new(out);
            for line in reader.lines().flatten() {
                let sanitized = sanitize_log_line(&line);
                println!("[desktop-worker:stdout] {}", sanitized);
                push_log(&logs, &sanitized);
            }
        });
    }

    if let Some(err) = stderr {
        let logs = Arc::clone(&logs_arc);
        let err_slot_clone = Arc::clone(&err_slot);
        thread::spawn(move || {
            let reader = BufReader::new(err);
            for line in reader.lines().flatten() {
                let sanitized = sanitize_log_line(&line);
                eprintln!("[desktop-worker:stderr] {}", sanitized);
                if sanitized.contains("[ERROR]")
                    || sanitized.contains("Error")
                    || sanitized.contains("Exception")
                    || sanitized.contains("Traceback")
                {
                    let mut e = err_slot_clone.lock().unwrap();
                    if e.is_none() {
                        *e = Some(sanitized.clone());
                    }
                }
                push_log(&logs, &sanitized);
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

fn terminate_child_process_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let pid = child.id();
        println!("[desktop-worker:lifecycle] Terminating process tree for PID {}", pid);
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(0x08000000)
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[tauri::command]
fn stop_worker(state: State<AppState>) -> Result<WorkerStatus, String> {
    let mut child_guard = state.worker_child.lock().unwrap();
    if let Some(ref mut child) = *child_guard {
        terminate_child_process_tree(child);
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
        // Temporary diagnostic: print every page-load URL so we can determine whether
        // the webview starts on localhost and later navigates to a remote origin.
        .on_page_load(|_webview, payload| {
            if cfg!(debug_assertions) {
                println!("[MAST PAGE LOAD] event={:?} url={}", payload.event(), payload.url());
            }
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                    let state = window.state::<AppState>();
                    let mut child_guard = state.worker_child.lock().unwrap();
                    if let Some(ref mut child) = *child_guard {
                        terminate_child_process_tree(child);
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

        let authority = tauri::ipc::RuntimeAuthority::new(acl, resolved);
        let allowed_origins = [
            tauri::ipc::Origin::Local,
            tauri::ipc::Origin::Remote {
                url: "https://mast-flow.vercel.app/dashboard/leads".parse().unwrap(),
            },
            tauri::ipc::Origin::Remote {
                url: "https://app.mast-flow.com/dashboard/leads".parse().unwrap(),
            },
            tauri::ipc::Origin::Remote {
                url: "http://localhost:5173/dashboard/leads".parse().unwrap(),
            },
        ];

        for origin in &allowed_origins {
            for cmd in required_commands {
                let access = authority.resolve_access(cmd, "main", "main", origin);
                assert!(
                    access.is_some(),
                    "resolve_access returned None for command: {} on origin: {}",
                    cmd,
                    origin
                );
            }
        }

        let unauthorized_origin = tauri::ipc::Origin::Remote {
            url: "https://evil.example.com/dashboard/leads".parse().unwrap(),
        };
        for cmd in required_commands {
            let access = authority.resolve_access(cmd, "main", "main", &unauthorized_origin);
            assert!(
                access.is_none(),
                "resolve_access should have returned None for command: {} on unauthorized origin: {}",
                cmd,
                unauthorized_origin
            );
        }
    }

    #[test]
    fn test_sanitize_log_line_redacts_tokens() {
        let raw = "Sending request with Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc and standalone eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token.data here";
        let sanitized = sanitize_log_line(raw);
        assert!(!sanitized.contains("eyJhbGciOiJIUzI1NiJ9"));
        assert!(sanitized.contains("[REDACTED_AUTH_TOKEN]"));
        assert!(sanitized.contains("[REDACTED_JWT]"));
    }
}
