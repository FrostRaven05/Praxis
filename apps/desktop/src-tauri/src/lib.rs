mod ai_gateway;
mod lan_sync;
pub mod store;
#[tauri::command]
async fn lan_entity_snapshot(
    database: State<'_, LocalDatabase>,
) -> Result<Vec<store::entities::Entity>, String> {
    database.get(None).await?.entities_snapshot().await
}
#[tauri::command]
async fn lan_entity_conflicts(
    database: State<'_, LocalDatabase>,
) -> Result<serde_json::Value, String> {
    database.get(None).await?.entities_conflicts().await
}
#[tauri::command]
async fn lan_entity_resolve(
    operation_id: String,
    resolution_id: String,
    decision: String,
    token: String,
    merged: Option<Vec<store::entities::Entity>>,
    database: State<'_, LocalDatabase>,
) -> Result<(), String> {
    database
        .get(None)
        .await?
        .entities_resolve(&operation_id, &resolution_id, &decision, &token, merged)
        .await
}
#[tauri::command]
async fn lan_entity_edit(
    operation_id: String,
    entity: store::entities::Entity,
    expected: Option<store::entities::Entity>,
    database: State<'_, LocalDatabase>,
) -> Result<(), String> {
    database
        .get(None)
        .await?
        .entities_edit(&operation_id, entity, expected)
        .await
}

#[tauri::command]
async fn lan_sync_conflicts(
    database: State<'_, LocalDatabase>,
) -> Result<serde_json::Value, String> {
    database.get(None).await?.lan_conflicts().await
}
#[tauri::command]
async fn lan_sync_resolve(
    operation_id: String,
    id: String,
    remote_version: i64,
    local_text: String,
    keep_copy: bool,
    database: State<'_, LocalDatabase>,
) -> Result<(), String> {
    database
        .get(None)
        .await?
        .lan_resolve(&operation_id, &id, remote_version, &local_text, keep_copy)
        .await
}
#[tauri::command]
async fn lan_sync_status(
    runtime: State<'_, lan_sync::LanRuntime>,
) -> Result<serde_json::Value, String> {
    Ok(runtime.status.read().await.clone())
}
#[tauri::command]
async fn lan_capture_edit(
    operation_id: String,
    id: String,
    expected_version: i64,
    raw_text: String,
    database: State<'_, LocalDatabase>,
) -> Result<(), String> {
    database
        .get(None)
        .await?
        .lan_edit_capture(&operation_id, &id, expected_version, &raw_text)
        .await
}

#[tauri::command]
async fn recurrence_edit_preview(
    action: store::RecurrenceAction,
    database: State<'_, LocalDatabase>,
) -> Result<serde_json::Value, String> {
    database
        .get(None)
        .await?
        .recurrence_edit_preview(&action)
        .await
        .map_err(|e| {
            database.record_error("recurrence_preview", None, &e);
            e.strip_prefix("USER:")
                .unwrap_or("无法读取规则预览，请刷新后重试。")
                .to_string()
        })
}

#[tauri::command]
async fn review_snapshot(database: State<'_, LocalDatabase>) -> Result<serde_json::Value, String> {
    database
        .get(None)
        .await?
        .review_snapshot(&chrono::Utc::now().to_rfc3339())
        .await
        .map_err(|e| {
            database.record_error("review_read", None, &e);
            "无法读取项目检查和周回顾，请重试。".into()
        })
}
#[tauri::command]
async fn review_command(
    command: store::ReviewCommand,
    database: State<'_, LocalDatabase>,
) -> Result<(), String> {
    database
        .get(Some(&command.operation_id))
        .await?
        .review_command(&command)
        .await
        .map_err(|e| {
            database.record_error("review_write", Some(&command.operation_id), &e);
            if let Some(message) = e.strip_prefix("USER:") {
                message.to_string()
            } else if e.starts_with("STATE_CONFLICT") {
                "回顾已更新，请重新读取后重试；输入仍保留。".into()
            } else {
                "未能确认保存结果，请重试；同一操作不会重复提交。".into()
            }
        })
}

#[tauri::command]
async fn view_snapshot(database: State<'_, LocalDatabase>) -> Result<serde_json::Value, String> {
    database
        .get(None)
        .await?
        .view_snapshot()
        .await
        .map_err(|e| {
            database.record_error("view_read", None, &e);
            "无法读取保存视图，请重试。".into()
        })
}
#[tauri::command]
async fn view_query(
    query: store::ViewQuery,
    database: State<'_, LocalDatabase>,
) -> Result<serde_json::Value, String> {
    database
        .get(None)
        .await?
        .view_query(&query)
        .await
        .map_err(|e| {
            database.record_error("view_query", None, &e);
            e.strip_prefix("USER:")
                .unwrap_or("无法搜索，请检查条件后重试。")
                .to_string()
        })
}
#[tauri::command]
async fn view_command(
    command: store::ViewCommand,
    database: State<'_, LocalDatabase>,
) -> Result<(), String> {
    database
        .get(Some(&command.operation_id))
        .await?
        .view_command(&command)
        .await
        .map_err(|e| {
            database.record_error("view_write", Some(&command.operation_id), &e);
            if let Some(message) = e.strip_prefix("USER:") {
                message.to_string()
            } else if e.starts_with("STATE_CONFLICT") {
                "视图已更新，请重新打开；输入仍保留。".into()
            } else {
                "未能确认保存结果，请重试；同一操作不会重复提交。".into()
            }
        })
}

#[tauri::command]
async fn trash_snapshot(database: State<'_, LocalDatabase>) -> Result<serde_json::Value, String> {
    database
        .get(None)
        .await?
        .trash_snapshot()
        .await
        .map_err(|e| {
            database.record_error("trash_read", None, &e);
            "无法读取数据，请重试。".into()
        })
}
#[tauri::command]
async fn trash_command(
    command: store::TrashCommand,
    database: State<'_, LocalDatabase>,
) -> Result<(), String> {
    database
        .get(Some(&command.operation_id))
        .await?
        .trash_command(&command)
        .await
        .map_err(|e| {
            database.record_error("trash_write", Some(&command.operation_id), &e);
            if let Some(message) = e.strip_prefix("USER:") {
                message.to_string()
            } else if e.starts_with("STATE_CONFLICT") {
                "内容已更新，请刷新后重试；未保存的输入仍保留。".into()
            } else {
                "未能确认保存结果，请重试；同一操作不会重复提交。".into()
            }
        })
}

#[tauri::command]
async fn recurrence_snapshot(
    database: State<'_, LocalDatabase>,
) -> Result<serde_json::Value, String> {
    database
        .get(None)
        .await?
        .recurrence_snapshot()
        .await
        .map_err(|e| {
            database.record_error("recurrence_read", None, &e);
            "无法读取数据，请重试。".into()
        })
}
#[tauri::command]
async fn recurrence_command(
    command: store::RecurrenceCommand,
    database: State<'_, LocalDatabase>,
) -> Result<(), String> {
    database
        .get(Some(&command.operation_id))
        .await?
        .recurrence_command(&command)
        .await
        .map_err(|e| {
            database.record_error("recurrence_write", Some(&command.operation_id), &e);
            if let Some(message) = e.strip_prefix("USER:") {
                message.to_string()
            } else if e.starts_with("STATE_CONFLICT") {
                "内容已更新，请刷新后重试；未保存的输入仍保留。".into()
            } else {
                "未能确认保存结果，请重试；同一操作不会重复提交。".into()
            }
        })
}

#[tauri::command]
async fn habit_snapshot(
    date: String,
    database: State<'_, LocalDatabase>,
) -> Result<serde_json::Value, String> {
    database
        .get(None)
        .await?
        .habit_snapshot(&date)
        .await
        .map_err(|e| {
            database.record_error("habit_read", None, &e);
            "无法读取数据，请重试。".into()
        })
}
#[tauri::command]
async fn habit_command(
    command: store::HabitCommand,
    database: State<'_, LocalDatabase>,
) -> Result<(), String> {
    database
        .get(Some(&command.operation_id))
        .await?
        .habit_command(&command)
        .await
        .map_err(|e| {
            database.record_error("habit_write", Some(&command.operation_id), &e);
            if let Some(message) = e.strip_prefix("USER:") {
                message.to_string()
            } else if e.starts_with("STATE_CONFLICT") {
                "内容已更新，请刷新后重试；未保存的输入仍保留。".into()
            } else {
                "未能确认保存结果，请重试；同一操作不会重复提交。".into()
            }
        })
}

#[tauri::command]
async fn productivity_snapshot(
    database: State<'_, LocalDatabase>,
) -> Result<serde_json::Value, String> {
    database
        .get(None)
        .await?
        .productivity_snapshot()
        .await
        .map_err(|e| {
            database.record_error("productivity_read", None, &e);
            "无法读取工作空间，请重试。".into()
        })
}
#[tauri::command]
async fn productivity_command(
    command: store::ProductivityCommand,
    database: State<'_, LocalDatabase>,
) -> Result<(), String> {
    database
        .get(Some(&command.operation_id))
        .await?
        .productivity_command(&command)
        .await
        .map_err(|e| {
            database.record_error("productivity_write", Some(&command.operation_id), &e);
            if let Some(message) = e.strip_prefix("USER:") {
                message.to_string()
            } else if e.starts_with("STATE_CONFLICT") {
                "内容已更新，请返回并重新打开后再预览。未保存的输入仍保留。".into()
            } else {
                "未能确认保存结果，请检查输入并重试；重复提交不会重复创建。".into()
            }
        })
}

use std::{io::Write, path::PathBuf};
use store::{CaptureCommand, DailyTask, Store};
use tauri::{Manager, State};
use tokio::sync::OnceCell;
use uuid::Uuid;

struct LocalDatabase {
    path: PathBuf,
    diagnostics_path: PathBuf,
    diagnostics_lock: std::sync::Mutex<()>,
    store: OnceCell<Store>,
}

mod accounts;
mod theme_preferences;
use theme_preferences::{read_theme_color, save_theme_color};

impl LocalDatabase {
    async fn get(&self, operation_id: Option<&str>) -> Result<&Store, String> {
        self.store
            .get_or_try_init(|| Store::open(&self.path))
            .await
            .map_err(|error| {
                self.record_error("open", operation_id, &error);
                  if error.starts_with("DATABASE_CORRUPT") {
                      return "本机数据库已损坏，原文件已保留。请从健康备份恢复后再打开，勿反复重试或清空数据。".to_owned();
                  }
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
        let Ok(_guard) = self.diagnostics_lock.lock() else {
            return;
        };
        if let Some(parent) = self.diagnostics_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.diagnostics_path)
        {
            let _ = file.write_all(format!("{record}\n").as_bytes());
        }
    }
}

#[tauri::command]
async fn capture_task_on_date(
    command: CaptureCommand,
    database: State<'_, LocalDatabase>,
) -> Result<DailyTask, String> {
    database.get(Some(&command.operation_id)).await?.capture_on_date(&command).await
        .map_err(|e| planning_error(&database, "capture-on-date", Some(&command.operation_id), e))
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
async fn prepare_daily_tasks(
    time_zone: Option<String>,
    database: State<'_, LocalDatabase>,
) -> Result<(), String> {
    let store = database.get(None).await?;
    if let Some(zone) = time_zone {
        store.initialize_workspace_zone(&zone).await
            .map_err(|e| planning_error(&database, "workspace-default-zone", None, e))?;
    }
    store
        .prepare_daily_tasks(&chrono::Utc::now().to_rfc3339())
        .await
        .map_err(|e| planning_error(&database, "daily-rollover", None, e))
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
            if let Some(message) = error.strip_prefix("USER:") {
                message.to_string()
            } else if error == "SUMMARY_TASK" {
                "还有子任务未完成，不能在今日列表里直接勾选完成。".to_owned()
            } else if error == "STATE_CONFLICT" {
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
            if let Some(message) = error.strip_prefix("USER:") {
                message.to_string()
            } else if error == "STATE_CONFLICT" {
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
async fn accept_suggestion(
    command: store::ScheduleCommand,
    database: State<'_, LocalDatabase>,
) -> Result<(), String> {
    database
        .get(Some(&command.operation_id))
        .await?
        .accept_suggestion(&command)
        .await
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
#[tauri::command]
async fn project_workspace(
    command: store::WorkspaceCommand,
    database: State<'_, LocalDatabase>,
) -> Result<(), String> {
    database
        .get(Some(&command.operation_id))
        .await?
        .project_workspace(&command)
        .await
        .map_err(|e| {
            if let Some(message) = e.strip_prefix("USER:") {
                message.to_string()
            } else if e == "SUMMARY_TASK" {
                "父任务只汇总进度，请操作叶子任务。".into()
            } else {
                planning_error(
                    &database,
                    "project-workspace",
                    Some(&command.operation_id),
                    e,
                )
            }
        })
}
#[tauri::command]
async fn content_snapshot(database: State<'_, LocalDatabase>) -> Result<serde_json::Value, String> {
    database
        .get(None)
        .await?
        .content_snapshot()
        .await
        .map_err(|_| "读取失败，请重试；本机内容仍保留。".into())
}
#[tauri::command]
async fn content_command(
    command: store::ContentCommand,
    database: State<'_, LocalDatabase>,
) -> Result<(), String> {
    database
        .get(Some(&command.operation_id))
        .await?
        .content_command(&command)
        .await
        .map_err(|e| {
            database.record_error("content", Some(&command.operation_id), &e);
            if let Some(s) = e.strip_prefix("USER:") {
                s.to_string()
            } else if e == "STATE_CONFLICT" {
                "内容已变化，请重新读取后再操作；草稿仍保留。".into()
            } else {
                "保存未确认，请重试；同一操作不会重复提交。".into()
            }
        })
}
#[tauri::command]
async fn backup_list(
    database: State<'_, LocalDatabase>,
) -> Result<Vec<store::backup::BackupInfo>, String> {
    store::backup::list_backups(database.path.parent().ok_or("没有数据库目录")?)
        .map_err(|_| "无法读取备份列表".into())
}
#[tauri::command]
async fn backup_create(database: State<'_, LocalDatabase>) -> Result<String, String> {
    database
        .get(None)
        .await?
        .create_backup(database.path.parent().ok_or("没有数据库目录")?)
        .await
        .map_err(|_| "备份失败，请检查磁盘和目录权限。".into())
}
#[tauri::command]
async fn backup_restore(
    name: String,
    database: State<'_, LocalDatabase>,
) -> Result<String, String> {
    store::backup::prepare_restore(database.path.parent().ok_or("没有数据库目录")?, &name)
        .await
        .map_err(|e| {
            e.strip_prefix("USER:")
                .unwrap_or("恢复失败，原数据库未被替换。请检查备份和目录权限。")
                .to_string()
        })
}

#[tauri::command]
async fn ai_project_snapshot(project_id:String,database:State<'_,LocalDatabase>)->Result<serde_json::Value,String>{
    database.get(None).await?.ai_project_snapshot(&project_id).await.map_err(|e|match e.as_str(){"AI_PROJECT_TOO_LARGE"=>"此版本支持最多 100 项任务的项目，请先缩小项目范围。".into(),"AI_STALE_PROJECT"=>"项目已变化、暂停或归档，请重新打开进行中的项目。".into(),_=>"无法读取项目恢复资料，请重新打开项目后重试。".into()})
}

#[tauri::command]
async fn ai_apply(command:store::AiApplyCommand,database:State<'_,LocalDatabase>)->Result<store::AiApplyReceipt,String>{
    database.get(Some(&command.operation_id)).await?.ai_apply(&command).await.map_err(|error|{
        database.record_error("ai_apply",Some(&command.operation_id),&error);
        if error.starts_with("AI_"){error}else{"AI_APPLY_UNCONFIRMED".into()}
    })
}
#[tauri::command]
async fn ai_receipt(operation_id:String,database:State<'_,LocalDatabase>)->Result<Option<store::AiApplyReceipt>,String>{
    database.get(None).await?.ai_receipt(&operation_id).await.map_err(|_|"AI_APPLY_UNCONFIRMED".into())
}
#[tauri::command]
async fn ai_undo(operation_id:String,apply_operation_id:String,database:State<'_,LocalDatabase>)->Result<(),String>{
    database.get(Some(&operation_id)).await?.ai_undo(&operation_id,&apply_operation_id).await.map_err(|error|{
        database.record_error("ai_undo",Some(&operation_id),&error);
        if error.starts_with("AI_"){error}else{"AI_APPLY_UNCONFIRMED".into()}
    })
}

#[tauri::command]
async fn cultivation_snapshot(database:State<'_,LocalDatabase>)->Result<serde_json::Value,String>{database.get(None).await?.cultivation_snapshot().await}
#[tauri::command]
async fn cultivation_command(command:store::CultivationCommand,database:State<'_,LocalDatabase>)->Result<(),String>{database.get(Some(&command.operation_id)).await?.cultivation_command(&command).await.map_err(|e|if e.contains("constraint")||e.contains("database"){"保存未确认，请重试同一操作。".into()}else{e})}

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
            app.manage(theme_preferences::ThemePreferences {
                path: data_dir.join("appearance.json"),
                lock: std::sync::Mutex::new(()),
            });
            let active = accounts::selected(&data_dir)?;
            let workspace_dir = match &active {
                Some(account) => accounts::account_dir(&data_dir, account)?,
                None => data_dir.clone(),
            };
            app.manage(accounts::Accounts {
                root: data_dir.clone(),
                active,
                lock: tokio::sync::Mutex::new(()),
            });
            app.manage(LocalDatabase {
                path: store::backup::selected_database(&workspace_dir),
                diagnostics_path: log_dir.join("storage-errors.jsonl"),
                diagnostics_lock: std::sync::Mutex::new(()),
                store: OnceCell::new(),
            });
            app.manage(lan_sync::LanRuntime {
                status: tokio::sync::RwLock::new(serde_json::json!({"state":"starting"})),
            });
            lan_sync::start(app.handle().clone(), workspace_dir.join("lan-sync.dpapi"));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_theme_color,
            save_theme_color,
            ai_gateway::ai_gateway_request,
            cultivation_snapshot,
            cultivation_command,
            ai_project_snapshot,
            ai_apply,
            ai_receipt,
            ai_undo,
            accounts::account_status,
            accounts::account_authenticate,
            accounts::account_logout,
            accounts::account_restart,
            accounts::account_change_password,
            accounts::app_release_check,
            accounts::app_release_open,
            lan_entity_snapshot,
            lan_entity_conflicts,
            lan_entity_resolve,
            lan_entity_edit,
            lan_sync_status,
            lan_sync_conflicts,
            lan_sync_resolve,
            lan_capture_edit,
            recurrence_edit_preview,
            review_snapshot,
            review_command,
            view_snapshot,
            view_query,
            view_command,
            trash_snapshot,
            trash_command,
            recurrence_snapshot,
            recurrence_command,
            habit_snapshot,
            habit_command,
            productivity_snapshot,
            productivity_command,
            content_snapshot,
            content_command,
            backup_list,
            backup_create,
            backup_restore,
            project_workspace,
            add_subtasks,
            task_details,
            save_task_details,
            capture_task,
            capture_task_on_date,
            list_day,
            prepare_daily_tasks,
            change_completion,
            edit_task,
            update_plan,
            set_capacity,
            day_load,
            capture_inbox,
            list_inbox,
            schedule_task,
            accept_suggestion,
            save_project,
            add_project_tasks,
            assign_project,
            list_projects,
            project_tasks
        ])
        .run(tauri::generate_context!())
        .expect("Praxis could not start");
}
