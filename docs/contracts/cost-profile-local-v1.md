# 本机订阅设置契约 v1（T10.188；方案 T10.154 B1）

## 范围与事实源

订阅设置记录用户的订阅方案（例如覆盖 Claude Code 的 Claude Max 月付）、各工具的付费方式与美元兑人民币汇率。本契约只规定它在本机的形态、校验、读写命令与 revision 语义；费用拆分与回本计算（B2，`cost-breakdown-local-v1`）、设置页（B4）与跨设备同步（C1，`cost-profile-sync-v1`）各有自己的任务与契约，这里只写它们依赖的部分。方案依据是 `docs/design/cost-naming-subscription-v1.md` §2–§3 与文末「用户决定」。

- 权威实现：Rust `src-tauri/src/cost_profile/`（`model.rs` 声明为 `settings::cost_model`，放模型、校验与设置文件清洗；`mod.rs` 放四个命令；`cycle.rs` 放计费周期）。
- 前端边界：`src/utils/contracts/costProfile.ts`。四个命令各有类型化封装（`getCostProfile`、`validateCostProfile`、`saveCostProfile`、`clearCostProfile`），设置页只经它们调用（截至 2026-10-17 设置页界面 B4 尚未实现，暂无调用方；`cost-breakdown-local-v1`、`cost-profile-sync-v1` 两份契约也尚未建立）；原生返回值失败即关闭。类型在 `src/types.ts`。
- 浏览器预览：`src/devMockTauri.ts` 的四个 mock 复用同一个前端校验镜像（`checkCostProfileInput`），规则、错误顺序与提示文案与 Rust 相同，以 Rust 为准；「今天」取其余 mock 统一的固定日期 2026-07-15（`mockNow`）。

## 1. 命令

| 命令 | 参数 | 返回 |
|---|---|---|
| `get_cost_profile` | 无 | 订阅设置（§2.1） |
| `validate_cost_profile` | `{ profile }`：整份提交（§2.2） | `{ valid, errors }`；只校验、从不写入 |
| `save_cost_profile` | `{ profile, expectedRevision }` | `saved`、`conflict` 或 `invalid` 三选一（§5） |
| `clear_cost_profile` | `{ expectedRevision }` | `saved`（`cleared: true`）或 `conflict`（§6）；没有 `invalid` |

- 四个命令只读写 `app_settings.json` 里的四个 `cost_*` 字段（§7），不经通用 `save_settings`。
- `save_cost_profile` 与 `clear_cost_profile` 返回 `saved` 后发出既有事件 `settings-updated`，载荷 `{ "source": "cost-profile" }`；`conflict`、`invalid` 与命令错误都不发事件。
- 参数缺失或类型不对（例如没有 `profile` 键、`expectedRevision` 不是非负整数）时整个调用失败，这是 Tauri 的参数错误，不是字段级错误。`profile` 为 `null` 不属于这一类，见 §2.2。
- 系统错误以命令错误返回下列固定的中文句子之一，从不转述底层错误原文（serde 的错误会引用设置文件里出错的值，锁与写盘错误是英文）：

| 情形 | 命令错误 |
|---|---|
| 读取时设置文件读不出或整体无法解析（`get_cost_profile`、`validate_cost_profile`） | 读取订阅设置失败：设置文件无法读取或解析。 |
| 保存或删除时没拿到设置文件锁（例如另一进程占用超过 2 秒） | 订阅设置未保存：暂时无法取得设置文件锁，请稍后重试。 |
| 保存或删除时设置文件读不出或整体无法解析 | 订阅设置未保存：设置文件无法读取或解析。 |
| 写盘失败（原子替换没有发生，文件保持原样） | 订阅设置未保存：设置文件无法写入。 |
| 读写之后释放设置文件锁失败 | 订阅设置的保存结果未知：设置文件锁未能正常释放，请重新读取订阅设置。 |
| 内存中的设置状态异常 | 订阅设置未保存：设置状态异常，请重启应用后重试。 |
| revision 已达上限（§5） | 订阅设置未保存：版本号已达上限。 |
| 校验通过的提交无法转成订阅设置（内部不一致，不应出现） | 订阅设置校验结果不一致，未保存。 |
| 后台任务异常退出 | 订阅设置的后台任务异常退出，保存结果未知，请重新读取订阅设置。 |

## 2. JSON 形态

### 2.1 读到的订阅设置（`get_cost_profile`，以及 `saved.profile`）

```json
{
  "revision": 4,
  "plans": [
    {
      "id": "sub-0123456789abcdef",
      "name": "Claude Max",
      "provider": "anthropic",
      "fee": 200,
      "currency": "USD",
      "cycle": "monthly",
      "anchorDay": 15,
      "startDate": "2026-03-15",
      "endDate": null,
      "tools": ["claude"],
      "modelPrefixes": ["claude-"],
      "machines": []
    }
  ],
  "toolBillingModes": { "opencode": "payg" },
  "cnyPerUsd": 7.2
}
```

所有键总是出现。`cnyPerUsd` 为 `null` 表示设置文件里的汇率无法识别：人民币换算「不可得」（GLB-01），直到用户保存有效汇率；读者不得拿 7.2 或 0 代替。前端解析器对任何不合本契约之处（含未知字段）整份拒绝：设置页保存的是整份设置，少显示一条再保存就等于删掉它。

### 2.2 提交（`validate_cost_profile` 与 `save_cost_profile` 的 `profile`）

与 §2.1 相同但不含 `revision`（revision 另作 `expectedRevision` 传；写进 `profile` 是拼错了地方，按未知字段报错）。此外：

- 新订阅的 `id` 为 `null` 或省略，保存时由本机生成；已有订阅必须带回原 `id`，ID 不随名称或顺序变化。
- `endDate` 省略等于 `null`；`modelPrefixes`、`machines` 省略或 `null` 等于空列表。其余字段必填。
- 未知字段报 `invalid`：订阅对象里的记在 `field: "plan"`，顶层的记在 `field: "profile"`，字段名放在 `key`。
- `profile` 为 `null` 不是订阅设置：报 `field: "profile"`、`code: "required"`（提示「缺少订阅设置」），`save_cost_profile` 返回 `invalid`，什么都不改；其他不是对象的值报 `invalid`。设置页误把尚未加载完的状态提交上来时因此只会报错，不会清空。删除全部只用 `clear_cost_profile`（§6）。
- 汇率不可得时前端原样提交 `null`，得到 `cnyPerUsd` 的 `required` 错误，由用户填写；不代填默认值。
- 金额提交用户输入的原值（例如 `Number("19.99")`），不要提交运算结果（`0.1 + 0.2` 是 17 位小数，会报 `precision`）。

## 3. 字段与校验

| 字段 | 规则 |
|---|---|
| `id` | `sub-` 加 16 位小写十六进制 |
| `name` | 先去掉首尾空白（Unicode White_Space），再对剩下的全部字符判断：1–40 个字符；不含控制字符（Cc）；不含零宽、不可见与文字方向控制字符：U+00AD、U+061C、U+180E、U+200B–U+200F、U+2028–U+202E、U+2060–U+2064、U+2066–U+206F、U+FEFF；不区分大小写不重名。U+FEFF 不是空白，不会被去掉。读到的名称一定是去过空白的 |
| `provider` | `anthropic`、`openai`、`google`、`moonshot`、`zhipu`、`minimax`、`deepseek`、`other`；只用于图标与覆盖工具建议，不参与计算 |
| `fee` | 每个计费周期的订阅费，单位是 `currency`；有限数，大于 0，不超过 100,000，最多两位小数（美元与人民币的最小单位都是分） |
| `currency` | `USD`、`CNY` |
| `cycle` | `monthly`、`yearly` |
| `anchorDay` | 整数 1–31。月付每月的计费日期取 `min(anchorDay, 当月天数)`，计费日 31 在 2 月落在 28 或 29 日。年付忽略它，以开始日期的月日计费，2 月 29 日在平年按 2 月 28 日；年付仍须给出 1–31（设置页取开始日期的日） |
| `startDate` | `YYYY-MM-DD` 写法的真实日期，含；不早于 2020-01-01；不晚于上界（见下） |
| `endDate` | `null`（仍在订阅）或不早于 `startDate` 的日期，含 |
| `tools` | 1–16 个不重复的工具 ID，与账本 `tool` 逐字匹配 |
| `modelPrefixes` | 0–16 个，每个 1–64 个 ASCII 可见字符（0x21–0x7E，不含空格与其他空白，不含非 ASCII 字符），例如 `claude-3-5-sonnet-v2@20241022`、`claude-sonnet-4[1m]`、`gpt-4o+search`；不区分 ASCII 大小写不重复；空表示这些工具的全部模型；按模型名不区分 ASCII 大小写的前缀匹配 |
| `machines` | 0–16 个不重复的设备 ID，与账本 `machine_id` 逐字匹配；空表示全部设备；`all`、`all_cloud` 是看板筛选的哨兵值，不接受 |
| `plans` | 最多 12 个 |
| `toolBillingModes` | 工具 ID → `"payg"`（按量付费），最多 64 项；没出现的工具即「未设置」，不默认视为按量 |
| `cnyPerUsd` | 1 美元 = x 元；有限数，1–20，最多 4 位小数；默认 7.2 |

- 工具 ID 与设备 ID：非空、无首尾空白、无控制字符、不超过 256 个 UTF-8 字节。Rust 不对照账本检查它们：设置页只提供账本出现过的工具与已知设备作为选项，已登记但本机暂未出现的工具、其他设备同步来的设备 ID 都保持有效。
- **开始日期的上界**只检查新订阅和改过开始日期的订阅；已保存且没改动的开始日期不因时钟或时区差异被重新判定。设置页录入（`validate_cost_profile`、`save_cost_profile`）的上界是本机本地的今天。应用其他设备已校验过的副本（C1）时上界放宽为本机今天 + 2 天（Rust 入口 `save_cost_profile_impl(.., remote_copy_latest_start(本机今天))`）：同一时刻各地的本地日期最多相差两天（UTC−12 与 UTC+14），录入设备的「今天」可能比本机晚；更晚的日期照样报 `in_future`，其余规则不变。
- **小数位**按最短往返的十进制写法数（与 Rust `f64` 的显示、JavaScript `String(n)` 同一口径，科学计数法折回小数位），不设容差：订阅费 `19.99` 合法，`19.999`、`19.999999999` 报 `precision`；汇率 `7.2345` 合法，`7.23456`、`7.20000000001` 报 `precision`。设置文件里位数多出的值同样不合规（§7），所以存下的金额只有一种写法。

### 3.1 订阅之间

- ID 不重复；名称不区分大小写不重名。
- **重叠即拒绝**：两个订阅的时段相交（起止都含）、覆盖的工具相交、模型前缀相交（任一为空，或一方前缀是另一方前缀的前缀，不区分 ASCII 大小写）且设备相交（任一为空，或有共同设备）时，账本无法区分记录来自哪个订阅，拒绝保存。旧方案 8 月 31 日结束、新方案 9 月 1 日开始不算重叠；同一天交接两段都含这一天，算重叠。
- 冲突记在后一个订阅上（`planIndex`），`relatedPlanIndex` 指向较早的那个。

## 4. 字段级错误

```json
{
  "planIndex": 1,
  "field": "tools",
  "itemIndex": null,
  "key": null,
  "relatedPlanIndex": 0,
  "code": "overlap",
  "message": "「Claude Pro」与「Claude Max」自 2026-09-01 起同时覆盖 claude，账本无法区分记录来自哪个订阅。请用模型前缀或设备区分，或合并为一个订阅（订阅费相加）。"
}
```

- 七个键总是出现。`field` 是闭合集合：整份设置的 `profile`、`plans`、`toolBillingModes`、`cnyPerUsd`（`planIndex` 为 `null`），与订阅内的 `plan`、`id`、`name`、`provider`、`fee`、`currency`、`cycle`、`anchorDay`、`startDate`、`endDate`、`tools`、`modelPrefixes`、`machines`（`planIndex` 为该订阅在提交数组里的下标）。
- `itemIndex` 指出 `tools`、`modelPrefixes`、`machines` 中出错的那一项；`key` 是 `toolBillingModes` 中出错的工具或无法识别的字段名；`relatedPlanIndex` 只在重复与重叠时出现，且小于 `planIndex`。
- `message` 是可直接显示的中文提示，可能含订阅名称：只用于界面，不得写日志。

| `code` | 含义 |
|---|---|
| `required` | 缺少或为 `null`（含整份提交为 `null`） |
| `invalid` | 类型不对、取值不在闭合集合里、格式不对、含不允许的字符或未知字段 |
| `too_long` | 超过长度上限 |
| `too_many` | 超过条数上限 |
| `duplicate` | 列表内重复，或订阅之间 ID、名称重复 |
| `out_of_range` | 数值或日期越界（订阅费、计费日、汇率、早于 2020-01-01） |
| `precision` | 小数位过多（订阅费 2 位、汇率 4 位） |
| `in_future` | 开始日期晚于上界（§3） |
| `before_start` | 结束日期早于开始日期 |
| `overlap` | 与较早的订阅重叠（§3.1） |

错误顺序固定：顶层未知字段；`plans`；逐个订阅（未知字段、`id`、`name`、`provider`、`fee`、`currency`、`cycle`、`anchorDay`、`startDate`、`endDate`、`tools`、`modelPrefixes`、`machines`）；订阅之间（按后一个订阅、再按较早的订阅：ID、名称、重叠）；`toolBillingModes`（按工具名）；`cnyPerUsd`。

## 5. 保存结果与 revision

```json
{ "status": "saved", "profile": { "revision": 5, "plans": [], "toolBillingModes": {}, "cnyPerUsd": 7.2 }, "cleared": true }
{ "status": "conflict", "currentRevision": 5 }
{ "status": "invalid", "errors": [ { "planIndex": 0, "field": "fee", "itemIndex": null, "key": null, "relatedPlanIndex": null, "code": "precision", "message": "订阅费最多两位小数" } ] }
```

- `revision` 是 0 到 2^53−1 的整数（JavaScript 能精确比较的范围）。0 表示本机从未保存过（或设置文件里的版本号损坏后被重置，§7）。每次成功的保存或删除全部都加一，包括内容没变的保存与对空状态再删一次；`conflict` 与 `invalid` 不改。已达上限时保存与删除都以命令错误拒绝，从不回绕。
- `save_cost_profile` 与 `clear_cost_profile` 在设置写锁内读取磁盘上的权威设置，先比对 `expectedRevision`：不同就返回 `conflict` 与当前 revision，什么都不写；相同才继续。`save_cost_profile` 接着校验，校验不过返回 `invalid`（`errors` 至少一条），同样什么都不写。
- `saved.profile` 是保存后的状态（新订阅已有 ID），客户端以它替换本地副本并记下新 revision；`cleared` 为真表示保存后是规范空状态（§6）。
- 设置页收到 `conflict` 时重新 `get_cost_profile` 并提示用户订阅设置已在别处更改，不自动合并；收到 `settings-updated` 时重读。
- revision 只是本机计数，不是全局版本；跨设备怎样使用见 §9。

## 6. 删除全部订阅设置

- `clear_cost_profile({ expectedRevision })`：删除全部订阅与付费方式，汇率回到 7.2，revision 加一，返回 `saved` 且 `cleared: true`。它和保存一样受 revision 保护，拿着旧 revision 的页面删不掉别处刚保存的设置，只会得到 `conflict`。前端只经 `clearCostProfile(expectedRevision)` 调用。
- `save_cost_profile` 不能删除全部：提交 `null` 报 `required`（§2.2）。
- **规范空状态**：没有订阅、没有付费方式、汇率为 7.2。从未登记的安装（revision 0）、「删除全部」之后、手动删到空且汇率为 7.2 都是它，`cleared` 均为真。汇率不可得（`null`）不是规范空状态。
- C1 把规范空状态映射为云端删除墓碑（§9）。

## 7. 存储、清洗与兼容

- `app_settings.json` 的四个顶层字段：`cost_subscription_plans`（订阅对象数组，对象内键名与 §2.1 相同，为驼峰）、`cost_tool_billing_modes`、`cost_cny_per_usd`、`cost_profile_revision`。所有窗口与 Rust 托盘读同一份。
- 通用 `save_settings` 从不合并这四个字段：陈旧的设置页即使把旧值一并提交也会被忽略。`get_settings` 会带回它们，只作只读镜像（TypeScript 中为 `readonly` 的可选字段），读写一律用本契约的命令。
- **读取宽松、写出严格**：四个字段各自独立反序列化，字段内容的类型或取值不合法只丢这一项，其他设置照常读出。整份文件不是合法 JSON（含嵌套超过解析器上限）时，与其他设置一样整体读不出：读取回落默认值，本契约的命令返回 §1 的固定错误。
  - 订阅逐条按「保存时会写出的规范形态」校验：必须带合法 ID、名称已去空白、`endDate` 键存在（可为 `null`）、`modelPrefixes` 与 `machines` 为数组，其余同 §3（含小数位）。未知的服务商、币种与计费周期让这一条非法，整条丢弃，从不改写成默认值。与已保留的订阅 ID 重复、重名或重叠的后一条丢弃；超过 12 条的部分丢弃。
  - 付费方式中工具 ID 不合法或取值不是 `payg` 的条目丢弃，超过 64 项的部分丢弃。
  - 汇率不合法读成 `null`（不可得），不改写成 7.2；revision 不是 0 到 2^53−1 的整数时读成 0。
  - 丢弃只记条数与固定类别名，从不记名称、金额或原值；同一类别每个进程只记一次，例如 `cost profile: ignored 3 invalid subscription plan(s) in app settings; not logged again until restart`。额度同步等路径会周期性地读设置文件，手改过的文件在下一次写入前每次读取都会丢弃同样的条目，但不再重复记日志。清洗后的值在下一次任何设置写入时写回文件；清洗本身不改 revision。
- 早于 T10.188 的版本读到这四个字段会忽略它们，但它自己写设置时会把它们丢掉：降级后本机订阅设置丢失（C1 的云端副本可以恢复）。v1 读者会丢弃带新取值（例如新服务商）的整条订阅，并在写回时丢掉它不认识的订阅字段；这类演进需要升版本号并同步 C1 的兼容策略。

## 8. 隐私

- 订阅名称、订阅费与覆盖范围属于个人消费信息，不是凭据，不进系统安全存储。
- 不写日志：日志只记条数；Rust `Debug` 输出只含订阅 ID；校验提示只回给设置页；命令错误是 §1 的固定句子，不含设置文件内容；前端解析器的错误只含固定问题代码。
- 不进 CSV 导出与诊断信息；分享海报与简报中的订阅费、API 等值与回本倍数受「隐藏费用」约束（B7）。
- 跨设备同步只经 C1 的专用云端表（RLS 只允许本人读写），不借用额度同步或统计上传通道；未登录或云端未部署时只存本机。

## 9. 与后续任务的衔接

- **B2**：计费周期由 `CostSubscriptionPlan::billing_cycle_containing(date)` 给出 `[本次计费日, 下次计费日)`，周期只由计费日（月付）或开始日期的月日（年付）决定，首末部分周期由 B2 按起止日期按天折算。有效 Token 口径不变（输入 + 输出，缓存读写单列）；`cnyPerUsd` 为 `null` 时人民币换算不可得。
- **B4**：`getCostProfile()` → 就地调用 `validateCostProfile(profile)` 显示字段级错误（宜防抖）→ `saveCostProfile(profile, revision)` 带上读到的 revision；「删除全部订阅设置」确认后调用 `clearCostProfile(revision)`。命令错误原样显示（§1 的固定句子）。
- **C1（订阅设置跨设备同步）**无需改动本机模型即可实现：
  - 云端每个用户一行：订阅设置（§2.2 的提交形态，含各订阅 ID）、云端版本号、墓碑标记与时间戳；RPC 按云端版本号条件更新，本机 revision 只是本机计数，不作云端条件。
  - 同步状态存 C1 自己的文件，不进 `AppSettings`：上次同步时的本机 revision 与云端版本号、待写的墓碑。
  - 本机 revision 大于上次同步值，说明本机改过：保存结果 `cleared` 为真（删除全部或删到空）时写墓碑（U-2），否则上传整份设置。本机汇率为 `null`（不可得）时不上传，先让用户补填：别的设备应用这样的副本只会得到 `invalid`。
  - 云端版本号大于上次同步值且本机没改过：用 `save_cost_profile_impl(副本, 当前本机 revision, remote_copy_latest_start(本机今天))` 应用副本，墓碑则用 `clear_cost_profile_impl(当前本机 revision)`；应用本身也按 revision 条件执行，不会覆盖用户同时做的本机修改。两边都改过时由 C1 决定处理方式。
  - 应用成功后，C1 必须把返回的 `saved.profile.revision` 记为「上次同步时的本机 revision」：应用本身会让本机 revision 加一，不记下的话下一轮会把刚拉下来的副本当成本机修改再上传一次，墓碑还会再写一次。
  - 应用成功后，C1 必须自己发 `settings-updated`，载荷 `{ "source": "cost-profile-sync" }`：事件由命令包装层发出，`_impl` 不发；不发的话打开着的设置页与看板不会重读。
  - revision 为 0 的新安装从不上传墓碑，先拉取；本机 revision 小于上次同步值（设置文件损坏后被重置）视为本机数据丢失，从云端恢复。清洗丢弃（§7）不改 revision，C1 不能只靠 revision 判断本机文件是否被手改过。
  - 墓碑之后，拿着旧版本号的设备写云端会遇到版本冲突，只能先拉取并应用删除，已删除的订阅不会被别的设备同步回来。
  - 关闭同步时询问是否删除云端副本、默认保留（U-1），首次同步前提示一次（U-3），都属于 C1 的界面与契约，不影响本机模型。

## 版本记录

- v1（2026-09-25，T10.188）：首版。
- v1 修订（2026-09-26，T10.188 评审修复轮 R-50，合入前完成，没有已发布的读者）：新增第四个命令 `clear_cost_profile`，`profile: null` 改为报 `required`、不再删除全部；§1 列出全部系统错误的固定句子；名称另拒零宽与文字方向控制字符；模型前缀放宽为 ASCII 可见字符；小数位不设容差；C1 应用副本的开始日期上界改为本机今天 + 2 天；同一类清洗告警每个进程只记一次；§7 措辞改为「整份文件不是合法 JSON 时整体读不出」，镜像字段标为 `readonly`；§9 写明 C1 应用副本后记下新的本机 revision 并自己发 `settings-updated`。
