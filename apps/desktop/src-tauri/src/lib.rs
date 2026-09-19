pub mod store;

use std::{io::Write, path::PathBuf};
use store::{CaptureCommand, DailyTask, Store};
use tauri::{Manager, State};
use tokio::sync::OnceCell;
use uuid::Uuid;

struct LocalDatabase {
    path: PathBuf,
    diagnostics_path: PathBuf,
    store: OnceCell<Store>,
}

impl LocalDatabase {
    async fn get(&self, operation_id: Option<&str>) -> Result<&Store, String> {
        self.store
            .get_or_try_init(|| Store::open(&self.path))
            .await
            .map_err(|error| {
                self.record_error("open", operation_id, &error);
                "无法打开本机数据库，请检查目录权限和磁盘空间后重试。".to_owned()
            })
    }

    /// Keep operational identifiers and numeric error codes; never task text, paths or raw SQL.
    fn record_error(&self, stage: &str, operation_id: Option<&str>, error: &str) {
        let numeric_code = |prefix: &str| {
            error
                .split(prefix)
                .nth(1)
                .map(|tail| {
                    tail.chars()
                        .take_while(|c| c.is_ascii_digit())
                        .collect::<String>()
                })
                .filter(|code| !code.is_empty())
        };
        let sqlite_code = numeric_code("(code: ");
        let os_code = numeric_code("(os error ");
        let category = if sqlite_code.is_some() {
            "sqlite"
        } else if os_code.is_some() {
            "filesystem"
        } else if error.to_lowercase().contains("migration") {
            "migration"
        } else {
            "storage"
        };
        let record = serde_json::json!({
            "event": "local_storage_error",
            "at": chrono::Utc::now().to_rfc3339(),
            "stage": stage,
            "operationId": operation_id.and_then(|id| Uuid::parse_str(id).ok()).map(|id| id.to_string()),
            "category": category,
            "sqliteCode": sqlite_code,
            "osCode": os_code,
        }).to_string();
        eprintln!("{record}");
        // Logging must not turn a recoverable storage error into a second failure.
        if let Some(parent) = self.diagnostics_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.diagnostics_path)
        {
            let _ = writeln!(file, "{record}");
        }
    }
}

#[tauri::command]
async fn capture_task(
    command: CaptureCommand,
    database: State<'_, LocalDatabase>,
) -> Result<DailyTask, String> {
    database
        .get(Some(&command.operation_id))
        .await?
        .capture(&command)
        .await
        .map_err(|error| {
            database.record_error("capture", Some(&command.operation_id), &error);
            "未能确认保存结果，请检查磁盘空间与权限后重试。重试不会重复录入。".to_owned()
        })
}

#[tauri::command]
async fn list_day(
    date: String,
    database: State<'_, LocalDatabase>,
) -> Result<Vec<DailyTask>, String> {
    database
        .get(None)
        .await?
        .list_day(&date)
        .await
        .map_err(|error| {
            database.record_error("list", None, &error);
            "无法读取本机任务，请重试。".to_owned()
        })
}

#[tauri::command]
async fn change_completion(
    command: store::CompletionCommand,
    database: State<'_, LocalDatabase>,
) -> Result<DailyTask, String> {
    database
        .get(Some(&command.operation_id))
        .await?
        .change_completion(&command)
        .await
        .map_err(|error| {
            database.record_error("completion", Some(&command.operation_id), &error);
            if error == "STATE_CONFLICT" {
                "任务状态已变化，请重新读取列表后再操作。".to_owned()
            } else {
                "未能确认状态更新，请重试；重复操作不会重复记录。".to_owned()
            }
        })
}

#[tauri::command]
async fn edit_task(
    command: store::EditTaskCommand,
    database: State<'_, LocalDatabase>,
) -> Result<DailyTask, String> {
    database
        .get(Some(&command.operation_id))
        .await?
        .edit_task(&command)
        .await
        .map_err(|error| {
            database.record_error("edit", Some(&command.operation_id), &error);
            if error == "STATE_CONFLICT" {
                "任务已有更新，请重新打开详情后再修改。".to_owned()
            } else if error == "COMPLETED_PLAN" {
                "已完成任务不能改期，请先撤销完成。".to_owned()
            } else if error == "PLAN_CONFLICT" {
                "目标日期已有这项任务的安排，请选择其他日期。".to_owned()
            } else {
                "未能确认修改结果，请重试；相同操作不会重复保存。".to_owned()
            }
        })
}

fn planning_error(db: &LocalDatabase, stage: &str, id: Option<&str>, error: String) -> String {
    db.record_error(stage, id, &error);
    if error == "STATE_CONFLICT" {
        "安排已发生变化，请刷新后重试。".into()
    } else {
        "未能确认操作结果，请重试；相同操作不会重复保存。".into()
    }
}
#[tauri::command]
async fn update_plan(
    command: store::PlanCommand,
    database: State<'_, LocalDatabase>,
) -> Result<(), String> {
    database
        .get(Some(&command.operation_id))
        .await?
        .update_plan(&command)
        .await
        .map_err(|e| planning_error(&database, "plan", Some(&command.operation_id), e))
}
#[tauri::command]
async fn set_capacity(
    command: store::CapacityCommand,
    database: State<'_, LocalDatabase>,
) -> Result<(), String> {
    database
        .get(Some(&command.operation_id))
        .await?
        .set_capacity(&command)
        .await
        .map_err(|e| planning_error(&database, "capacity", Some(&command.operation_id), e))
}
#[tauri::command]
async fn day_load(
    date: String,
    database: State<'_, LocalDatabase>,
) -> Result<store::DayLoad, String> {
    database
        .get(None)
        .await?
        .day_load(&date)
        .await
        .map_err(|e| planning_error(&database, "load", None, e))
}
#[tauri::command]
async fn capture_inbox(
    command: store::InboxCommand,
    database: State<'_, LocalDatabase>,
) -> Result<(), String> {
    database
        .get(Some(&command.operation_id))
        .await?
        .capture_inbox(&command)
        .await
        .map_err(|e| planning_error(&database, "inbox", Some(&command.operation_id), e))
}
#[tauri::command]
async fn list_inbox(database: State<'_, LocalDatabase>) -> Result<Vec<store::InboxTask>, String> {
    database
        .get(None)
        .await?
        .list_inbox()
        .await
        .map_err(|e| planning_error(&database, "inbox-list", None, e))
}
#[tauri::command]
async fn schedule_task(
    command: store::ScheduleCommand,
    database: State<'_, LocalDatabase>,
) -> Result<(), String> {
    database
        .get(Some(&command.operation_id))
        .await?
        .schedule_task(&command)
        .await
        .map_err(|e| planning_error(&database, "schedule", Some(&command.operation_id), e))
}

#[tauri::command]
async fn save_project(
    command: store::SaveProjectCommand,
    database: State<'_, LocalDatabase>,
) -> Result<(), String> {
    database
        .get(Some(&command.operation_id))
        .await?
        .save_project(&command)
        .await
        .map_err(|e| planning_error(&database, "save_project", Some(&command.operation_id), e))
}

#[tauri::command]
async fn add_project_tasks(
    command: store::AddProjectTasksCommand,
    database: State<'_, LocalDatabase>,
) -> Result<(), String> {
    database
        .get(Some(&command.operation_id))
        .await?
        .add_project_tasks(&command)
        .await
        .map_err(|e| {
            planning_error(
                &database,
                "add_project_tasks",
                Some(&command.operation_id),
                e,
            )
        })
}

#[tauri::command]
async fn assign_project(
    command: store::AssignProjectCommand,
    database: State<'_, LocalDatabase>,
) -> Result<(), String> {
    database
        .get(Some(&command.operation_id))
        .await?
        .assign_project(&command)
        .await
        .map_err(|e| planning_error(&database, "assign_project", Some(&command.operation_id), e))
}

#[tauri::command]
async fn list_projects(database: State<'_, LocalDatabase>) -> Result<Vec<store::Project>, String> {
    database
        .get(None)
        .await?
        .list_projects()
        .await
        .map_err(|e| planning_error(&database, "projects", None, e))
}
#[tauri::command]
async fn project_tasks(
    project_id: String,
    database: State<'_, LocalDatabase>,
) -> Result<Vec<store::ProjectTask>, String> {
    database
        .get(None)
        .await?
        .project_tasks(&project_id)
        .await
        .map_err(|e| planning_error(&database, "project-tasks", None, e))
}

#[tauri::command]
async fn task_details(
    task_id: String,
    database: State<'_, LocalDatabase>,
) -> Result<store::TaskDetails, String> {
    database
        .get(None)
        .await?
        .task_details(&task_id)
        .await
        .map_err(|e| planning_error(&database, "task-details", None, e))
}
#[tauri::command]
async fn save_task_details(
    command: store::TaskDetailsCommand,
    database: State<'_, LocalDatabase>,
) -> Result<store::TaskDetails, String> {
    database
        .get(Some(&command.operation_id))
        .await?
        .save_task_details(&command)
        .await
        .map_err(|e| {
            planning_error(
                &database,
                "task-details-save",
                Some(&command.operation_id),
                e,
            )
        })
}

#[tauri::command]
async fn add_subtasks(
    command: store::AddSubtasksCommand,
    database: State<'_, LocalDatabase>,
) -> Result<(), String> {
    database
        .get(Some(&command.operation_id))
        .await?
        .add_subtasks(&command)
        .await
        .map_err(|e| {
            if e == "SUMMARY_CONFIRMATION_REQUIRED" {
                "父任务已有安排，请确认转换为汇总项后重试。".into()
            } else {
                planning_error(&database, "subtasks", Some(&command.operation_id), e)
            }
        })
}
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let log_dir = app.path().app_log_dir()?;
            // Isolated QA directories can only be selected in debug builds.
            #[cfg(debug_assertions)]
            let (data_dir, log_dir) = match std::env::var_os("PRAXIS_DATA_DIR") {
                Some(path) => {
                    let data = PathBuf::from(path);
                    let logs = data
                        .parent()
                        .unwrap_or(std::path::Path::new("."))
                        .join("praxis-qa-logs");
                    (data, logs)
                }
                None => (data_dir, log_dir),
            };
            app.manage(LocalDatabase {
                path: data_dir.join("praxis.db"),
                diagnostics_path: log_dir.join("storage-errors.jsonl"),
                store: OnceCell::new(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            add_subtasks,
            task_details,
            save_task_details,
            capture_task,
            list_day,
            change_completion,
            edit_task,
            update_plan,
            set_capacity,
            day_load,
            capture_inbox,
            list_inbox,
            schedule_task,
            save_project,
            add_project_tasks,
            assign_project,
            list_projects,
            project_tasks
        ])
        .run(tauri::generate_context!())
        .expect("Praxis could not start");
}
