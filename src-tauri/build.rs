fn main() {
    let attributes = tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "get_desktop_info",
            "get_worker_status",
            "start_worker",
            "stop_worker",
            "update_worker_token",
        ]),
    );

    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
