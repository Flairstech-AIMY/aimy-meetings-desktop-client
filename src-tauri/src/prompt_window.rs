use crate::types::DetectedMeeting;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

const PROMPT_WIDTH: f64 = 428.0;
const PROMPT_HEIGHT: f64 = 208.0;

#[derive(Clone, Default)]
pub struct PromptWindowManager {
    current_meeting: Arc<Mutex<Option<DetectedMeeting>>>,
}

impl PromptWindowManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get_active_meeting(&self) -> Option<DetectedMeeting> {
        self.current_meeting.lock().unwrap().clone()
    }

    pub fn show(&self, app_handle: &AppHandle, meeting: DetectedMeeting) {
        *self.current_meeting.lock().unwrap() = Some(meeting.clone());

        if let Some(win) = app_handle.get_webview_window("meeting-prompt") {
            let _ = win.emit("meeting:detected", meeting);
            position_bottom_right(&win);
            let _ = win.show();
            return;
        }

        let url = WebviewUrl::App("index.html#/meeting-prompt".into());
        if let Ok(win) = WebviewWindowBuilder::new(app_handle, "meeting-prompt", url)
            .title("")
            .inner_size(PROMPT_WIDTH, PROMPT_HEIGHT)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .minimizable(false)
            .maximizable(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .build()
        {
            position_bottom_right(&win);
            let _ = win.show();
            let _ = win.emit("meeting:detected", meeting);
        }
    }

    pub fn hide(&self, app_handle: &AppHandle) {
        *self.current_meeting.lock().unwrap() = None;
        if let Some(win) = app_handle.get_webview_window("meeting-prompt") {
            let _ = win.close();
        }
    }
}

fn position_bottom_right(win: &tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = win.primary_monitor() {
        let work_area = monitor.work_area();
        let scale = monitor.scale_factor();
        let win_w = (PROMPT_WIDTH * scale).round() as i32;
        let win_h = (PROMPT_HEIGHT * scale).round() as i32;
        let margin = (20.0 * scale).round() as i32;
        let x = work_area.position.x + (work_area.size.width as i32) - win_w - margin;
        let y = work_area.position.y + (work_area.size.height as i32) - win_h - margin;
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
}
