// release 构建时不弹控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ai_grading_system_lib::run()
}
