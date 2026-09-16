pub mod store;

use std::path::PathBuf;
use store::{CaptureCommand, DailyTask, Store};
use tauri::{Manager, State};
use tokio::sync::OnceCell;

struct LocalDatabase {
    path: PathBuf,
    store: OnceCell<Store>,
}

impl LocalDatabase {
    async fn get(&self) -> Result<&Store, String> {
        self.store
            .get_or_try_init(|| Store::open(&self.path))
            .await
            .map_err(|_| "无法打开本机数据库，请检查目录权限和磁盘空间后重试。".to_owned())
    }
}

#[tauri::command]
async fn capture_task(
    command: CaptureCommand,
    database: State<'_, LocalDatabase>,
) -> Result<DailyTask, String> {
    database
        .get()
        .await?
        .capture(&command)
        .await
        .map_err(|_| "未能确认保存结果，请检查磁盘空间与权限后重试。重试不会重复录入。".to_owned())
}

#[tauri::command]
async fn list_day(
    date: String,
    database: State<'_, LocalDatabase>,
) -> Result<Vec<DailyTask>, String> {
    database
        .get()
        .await?
        .list_day(&date)
        .await
        .map_err(|_| "无法读取本机任务，请重试。".to_owned())
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            // Isolated QA data is only configurable in debug builds.
            #[cfg(debug_assertions)]
            let data_dir = std::env::var_os("PRAXIS_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or(data_dir);
            app.manage(LocalDatabase {
                path: data_dir.join("praxis.db"),
                store: OnceCell::new(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![capture_task, list_day])
        .run(tauri::generate_context!())
        .expect("Praxis could not start");
}
