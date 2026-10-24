# 6. 云端同步与手机端

[← 预算提醒](05-budget.md) · [目录](README.md) · 下一章：[壁纸与小组件 →](07-wallpaper-widgets.md)

云端同步是可选的，默认关闭。开启后，多台电脑的用量会汇总到一起，Android 手机也能看。

TokenLedger 没有自己的公共服务器：云端用的是**你自己的 Supabase 项目**（免费档就够用），数据只在你的项目里。

## 准备云端（只做一次）

1. 在 [Supabase](https://supabase.com) 新建一个项目。
2. 用 Supabase CLI 把本仓库 `supabase/migrations/` 里的迁移部署到这个项目：

   ```bash
   supabase link --project-ref <你的项目 ref>
   supabase db push
   ```

   详细说明与回滚见 [supabase/README.md](../../../supabase/README.md)。以后升级 TokenLedger 时，如果新版本带了新迁移，再执行一次 `supabase db push`。
3. 在 Supabase 控制台的 Project Settings › API 里记下 **Project URL** 和 **Publishable key**。不需要、也不要填 service role key。

## 在桌面登录并同步

打开 **设置 › 云端账户**：

![设置 › 云端账户](../images/settings-cloud.png)

1. 填入 Supabase URL 与 Publishable Key，点「保存配置」。
2. 点「检查账户状态」。这一步会读取本机钥匙串，系统可能弹出安全存储授权，输入的是**本机系统密码**，不是云端账户密码。
3. 第一次使用点「注册」，之后用同一个邮箱和密码「登录」。同一个账号可以在多台电脑、多部手机上登录。
4. 点「立即同步」完成首次同步。

之后每次后台扫描有新记录时会自动同步；失败会稍后重试（最多每 15 分钟一次）。用量页切到「云端汇总」就能看到所有设备的合计，用「设备」维度拆开看每台电脑。

要从头重传，可以在「设置 › 数据与帮助 › 维护 › 重置同步」，下次同步会重新上传全部记录。退出登录不会删除云端已有的数据。

## Android 手机端

Android 端是只读看板：数据全部来自云端，手机本身不扫描、不保存任何供应商 key。

### 安装

Android 端连接哪个云端，是在**构建 APK 时**写进去的。自己部署了 Supabase 的话，需要用同一个 Project URL 和 Publishable key 构建 APK，步骤见 [apps/android/README.md](../../../apps/android/README.md)。装好后用和桌面相同的邮箱、密码登录。

从文件管理器安装 APK 时，Android 会要求允许「安装未知应用」，按系统提示对文件管理器或浏览器授权一次即可。

### 首次引导

第一次登录后，如果云端还没有任何桌面数据，手机会弹出四步引导：登录同一账户、在桌面开启云端同步、锁屏动态壁纸、桌面小组件。之后可以在「我的 › 帮助 › 接入步骤」再打开。

<p>
  <img src="../images/android/first-run.png" alt="Android 首次引导" width="260">
  <img src="../images/android/overview.png" alt="Android 用量概览（深色）" width="260">
</p>

### 四个分区

底栏有四个分区：

| 分区 | 内容 |
| --- | --- |
| 用量 | 概览、趋势、来源（按 Agent、模型、设备、账号拆分）、日历、请求明细，时间范围与桌面相同 |
| 路由 | 桌面网关的实时路由，见[第 7 章](07-wallpaper-widgets.md#手机锁屏动态壁纸) |
| 额度 | 各订阅与供应商的可用额度（需要桌面开启额度的跨设备同步） |
| 我的 | 账号与同步状态、锁屏壁纸与桌面小组件入口、待机屏 / 墨水屏、偏好 |

<p>
  <img src="../images/android/quota.png" alt="Android 额度" width="260">
  <img src="../images/android/me.png" alt="Android 我的" width="260">
</p>

几个常用偏好都在「我的」里：

- **货币**：手机默认用人民币显示预估费用，可以切换。
- **隐藏费用**：截图或投屏时把金额换成星号，同时作用于小组件；底层数据不变。
- **Token 口径**：有效（默认）或含缓存。
- **待机屏 / 墨水屏**：充电时常亮显示的全屏看板，有墨水屏优化版式。
- 平板、折叠屏和横屏会自动换成双栏布局。

手机上的数据比桌面晚一点：桌面同步之后，云端汇总刷新完成才会出现在手机上。
