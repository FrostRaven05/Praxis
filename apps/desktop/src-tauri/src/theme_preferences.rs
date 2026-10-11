use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Mutex};
use tauri::State;

#[derive(Serialize, Deserialize)]
pub struct ThemeColor {
    pub color: String,
}
pub struct ThemePreferences {
    pub path: PathBuf,
    pub lock: Mutex<()>,
}
fn normalized(color: &str) -> Result<String, String> {
    if color.len() != 7
        || !color.starts_with('#')
        || !color[1..].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("请选择有效的颜色。".into());
    }
    Ok(color.to_uppercase())
}
#[tauri::command]
pub fn read_theme_color(preferences: State<'_, ThemePreferences>) -> Result<ThemeColor, String> {
    let _lock = preferences.lock.lock().map_err(|_| "无法读取主题设置。")?;
    match std::fs::read(&preferences.path) {
        Ok(bytes) => {
            let value: ThemeColor =
                serde_json::from_slice(&bytes).map_err(|_| "无法读取主题设置。")?;
            Ok(ThemeColor {
                color: normalized(&value.color)?,
            })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ThemeColor {
            color: "#BDE7EE".into(),
        }),
        Err(_) => Err("无法读取主题设置。".into()),
    }
}
#[tauri::command]
pub fn save_theme_color(
    color: String,
    preferences: State<'_, ThemePreferences>,
) -> Result<(), String> {
    let value = ThemeColor {
        color: normalized(&color)?,
    };
    let _lock = preferences.lock.lock().map_err(|_| "无法保存主题设置。")?;
    let parent = preferences.path.parent().ok_or("无法保存主题设置。")?;
    std::fs::create_dir_all(parent).map_err(|_| "无法保存主题设置。")?;
    let temp = parent.join(format!("appearance-{}.tmp", uuid::Uuid::new_v4()));
    let write = || -> Result<(), std::io::Error> {
        use std::io::Write;
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(&serde_json::to_vec(&value)?)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, &preferences.path)
    };
    if write().is_err() {
        let _ = std::fs::remove_file(&temp);
        return Err("无法保存主题设置。".into());
    }
    Ok(())
}
