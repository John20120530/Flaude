// Prevent a console window from opening on Windows in release builds. In dev
// we keep it so `println!` / panics are visible.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    flaude_app_lib::run();
}
