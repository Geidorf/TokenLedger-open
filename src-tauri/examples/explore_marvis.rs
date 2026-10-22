use rusqlite::Connection;
use std::path::PathBuf;
use walkdir::WalkDir;

fn main() {
    println!("=== 探索腾讯 Marvis 本地日志 ===");

    // 获取 AppData 路径
    let appdata = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .expect("无法读取 APPDATA 环境变量");

    let marvis_user_dir = appdata.join("Tencent\\Marvis\\User");
    println!("Marvis 用户目录: {:?}", marvis_user_dir);

    if !marvis_user_dir.exists() {
        println!("Marvis 用户目录不存在！");
        return;
    }

    let mut db_paths = Vec::new();
    for entry in WalkDir::new(&marvis_user_dir)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path.is_file() && path.file_name().and_then(|s| s.to_str()) == Some("data.db") {
            // 确保路径包含 \database\data.db
            if path.to_string_lossy().contains("database") {
                db_paths.push(path.to_path_buf());
            }
        }
    }

    if db_paths.is_empty() {
        println!("未找到任何 Marvis data.db 数据库文件");
        return;
    }

    for db_path in db_paths {
        println!("\n发现数据库: {:?}", db_path);
        match Connection::open(&db_path) {
            Ok(conn) => {
                println!("成功打开数据库！");

                // 1. 打印表结构
                println!("--- 表 llm_token_usage 的结构 ---");
                let mut stmt = conn.prepare("PRAGMA table_info(llm_token_usage)").unwrap();
                let mut rows = stmt.query([]).unwrap();
                while let Some(row) = rows.next().unwrap() {
                    let cid: i32 = row.get(0).unwrap();
                    let name: String = row.get(1).unwrap();
                    let type_str: String = row.get(2).unwrap();
                    println!("  列 #{} - {} ({})", cid, name, type_str);
                }

                // 2. 打印前 5 行数据
                println!("\n--- 前 5 行数据样例 ---");
                let mut stmt = conn
                    .prepare("SELECT * FROM llm_token_usage LIMIT 5")
                    .unwrap();
                let col_count = stmt.column_count();
                let mut col_names = Vec::new();
                for i in 0..col_count {
                    col_names.push(stmt.column_name(i).unwrap().to_string());
                }
                println!("列名: {:?}", col_names);

                let mut rows = stmt.query([]).unwrap();
                while let Some(row) = rows.next().unwrap() {
                    let mut row_vals = Vec::new();
                    for i in 0..col_count {
                        let val: rusqlite::types::Value = row.get(i).unwrap();
                        let val_str = match val {
                            rusqlite::types::Value::Null => "NULL".to_string(),
                            rusqlite::types::Value::Integer(i) => i.to_string(),
                            rusqlite::types::Value::Real(f) => f.to_string(),
                            rusqlite::types::Value::Text(s) => s,
                            rusqlite::types::Value::Blob(b) => format!("[BLOB: {}B]", b.len()),
                        };
                        row_vals.push(val_str);
                    }
                    println!("  数据: {:?}", row_vals);
                }
            }
            Err(e) => {
                println!("打开数据库失败: {}", e);
            }
        }
    }
}
