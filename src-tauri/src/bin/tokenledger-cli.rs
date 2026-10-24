// 命令行入口：参数解析与排版都在 app_lib::cli，这里只转交并带回退出码。
// 不加 windows_subsystem，Windows 上才有控制台输出。

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(app_lib::run_cli(args));
}
