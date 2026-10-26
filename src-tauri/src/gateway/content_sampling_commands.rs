use std::sync::Arc;

use super::{ContentSample, Gateway, SamplingInput, SamplingStatus};

const TASK_ERROR: &str = "内容采样操作未完成，请重试。";

#[tauri::command]
pub async fn gateway_content_sampling_status(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
) -> Result<SamplingStatus, String> {
    super::ensure_main(&window)?;
    let gateway = gateway.inner().clone();
    tauri::async_runtime::spawn_blocking(move || gateway.content_sampling_status())
        .await
        .map_err(|_| TASK_ERROR.to_string())
}

#[tauri::command]
pub async fn gateway_set_content_sampling(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
    input: SamplingInput,
) -> Result<SamplingStatus, String> {
    super::ensure_main(&window)?;
    let gateway = gateway.inner().clone();
    tauri::async_runtime::spawn_blocking(move || gateway.set_content_sampling(input))
        .await
        .map_err(|_| TASK_ERROR.to_string())?
}

#[tauri::command]
pub async fn gateway_read_content_sample(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
    id: String,
) -> Result<ContentSample, String> {
    super::ensure_main(&window)?;
    let gateway = gateway.inner().clone();
    tauri::async_runtime::spawn_blocking(move || gateway.read_content_sample(&id))
        .await
        .map_err(|_| TASK_ERROR.to_string())?
}

#[tauri::command]
pub async fn gateway_delete_content_samples(
    window: tauri::WebviewWindow,
    gateway: tauri::State<'_, Arc<Gateway>>,
    ids: Option<Vec<String>>,
) -> Result<SamplingStatus, String> {
    super::ensure_main(&window)?;
    let gateway = gateway.inner().clone();
    tauri::async_runtime::spawn_blocking(move || gateway.delete_content_samples(ids))
        .await
        .map_err(|_| TASK_ERROR.to_string())?
}
