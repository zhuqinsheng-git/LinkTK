# LinkTK

[English](README.md) | 简体中文

LinkTK 是一个基于 Web Serial API 的浏览器串口与网络调试工具。支持在 Edge/Chrome 的系统串口选择器中选择 COM 口，并提供文本/HEX 收发、时间戳、自动滚动、日志保存和自动发送。界面默认英文，可在顶栏一键切换简体中文。

刚上手？先看[图文教程](docs/tutorial.zh-CN.md)：用真实界面截图走通串口、网络、YMODEM、终端与 AI 控制通道。

顶部“串口 / 网络”用于切换工作区，右侧会显示当前工作区的连接状态；TCP 服务端会显示已连接的客户端数量。网络工作区通过同一个 Vite 开发服务器内的本地桥接，提供真实 TCP/UDP 服务器和客户端，可以在两个浏览器页面中分别建立服务器和客户端进行收发验证，也可以直接连接 SSH 设备进入交互式 Shell。

接收区使用固定高度的内部滚动，不会随着日志增长把整个页面撑长。文本模式可开关 ANSI 颜色渲染，开启时解析常见终端颜色和样式，关闭时自动移除 ANSI 控制码。

连续同方向的接收或发送数据会合并到同一个 `RX` / `TX` 区块，串口分包不会被重复的方向标签打断。手动向上查看历史数据时，“跟随”开关不会被取消，并会显示“回到最新”按钮；滚回底部或点击按钮即可继续跟随。

连续同方向日志会合并为一个 RX/TX 色块，只在色块开头显示一次方向标签。色块内按时间分段，同一时间戳只显示一次，时间变化时在同一色块中显示新的时间戳。

日志工具栏提供 RX、TX、SYS 三个方向显示开关，可独立隐藏不需要的方向；时间戳、自动跟随、ANSI 颜色、HEX 双列和时间格式集中在“显示”弹窗中，时间格式支持绝对时间、连接运行时间和相对时间。开启“双列”后，文本数据会同时显示 UTF-8 文本和 HEX，HEX 数据会同时显示 HEX 和 ASCII 预览。

串口和网络日志支持快捷复制：点击日志块内容会复制该块完整文本，点击显示出来的时间戳会复制时间值；如果当前已有文本选区，则保留选区且不触发复制。

“日志 / 终端”用于在工作台和交互式 Shell 之间切换。终端模式使用 xterm.js，键盘输入会直接发送到串口，支持方向键、退格、Tab、Ctrl+C、Ctrl+D、ANSI 光标控制和历史回滚。RTOS 自身不回显时，可以开启“本地回显”。

左侧“YMODEM 文件传输”支持向设备发送本地文件，也支持接收设备发送的单个文件。发送时默认使用 1 KB 数据块，可切换到 128 B；协议使用 CRC16-XMODEM，包含文件头、超时重传、EOT 和批次结束头处理。接收完成后浏览器会保存文件。

YMODEM 区域可以像快捷发送一样折叠，折叠状态会保存在浏览器中。

网络工作区支持：

- TCP 服务器：监听端口，可连接多个客户端，发送时广播到所有已连接客户端
- TCP 客户端：连接指定主机和端口
- UDP 服务器：监听端口，接收数据后自动记住最近发送方，回复时发送到该地址
- UDP 客户端：连接指定主机和端口
- SSH 终端：连接目标主机、端口和用户名，使用密码登录后进入 xterm.js 交互式 Shell
- SSH 文件面板：复用当前 SSH 链路启动 SFTP，可浏览绝对路径、保存预设专属快捷路径，并上传、下载、新建文件夹、重命名和删除
- 文本/HEX 显示与发送、时间戳、TX 日志、日志保存
- 定时发送、发送区折叠、暂停接收显示，以及手动查看历史后“回到最新”

SSH 模式使用本机 Vite 服务中的 `ssh2` 桥接，浏览器只负责显示终端、文件面板和转发键盘输入。连接成功后，普通网络监视器、发送区和快捷发送会隐藏，避免与 SSH 终端混用。文件面板在首次打开时按需启动 SFTP，上传和下载都会分块传输，适合固件、日志等较大文件。SSH 密码默认只用于当前连接的协议请求，不会写入浏览器 localStorage；只有勾选“保存密码”并保存预设时，密码才会随该预设保存在本机浏览器存储中。连接成功后会显示主机 SHA-256 指纹。当前版本会自动接受主机密钥并显示指纹供人工核对，但还没有 `known_hosts` 持久化和比对。SSH 会话也不参与“串口 ↔ 网络”桥接。

网络日志不会把远端地址反复拼在每条数据前。每个远端 `IP:端口` 会在监视器上方分配一个稳定颜色，日志块的起始位置显示对应色标；同一远端、同一方向的连续数据仍按 RX/TX 规则合并。

串口和网络监视器都支持关键词高亮与筛选。多个关键词可用中文或英文逗号分隔；输入关键词后会直接高亮匹配内容，打开“筛选”后只保留匹配的日志，清空关键词即可恢复全部显示。“过滤配置”可切换大小写敏感、全词匹配，并在串口日志、网络日志和终端查找之间共享。终端模式保留完整的 shell 状态，因此提供关键词查找、高亮和上下跳转，不会隐藏不匹配的终端行。

串口和网络工作区都连接后，可以使用顶部“桥接”功能在两者之间双向转发数据。桥接可以分别控制“串口到网络”和“网络到串口”两个方向，并显示各方向的累计转发字节数；串口断开、网络断开或 YMODEM 传输开始时会自动停止桥接。

发送区默认收起，把主要空间留给接收区和终端；点击发送区标题栏右侧的折叠按钮即可展开。

串口和网络工作区都提供可折叠的快捷发送列表。每条内容可以直接编辑，支持单独发送、回车发送、添加和删除；数量上限为 20 条，并始终至少保留一条。内容和折叠状态会分别保存在浏览器中。

发送区、快捷发送和自动发送支持 `{{变量名}}` 模板变量。内置变量包括时间、日期、Unix 时间、发送计数、随机数、随机 HEX 和 UUID；自定义变量可直接在“模板变量”弹窗中维护。变量会在每次实际发送前解析，因此自动发送时时间、随机值和计数会逐次更新；串口与网络使用同一份变量表，但发送计数各自独立。自定义变量名区分显示、匹配时不区分大小写，前方加 `\` 可发送字面量 `{{变量名}}`。

串口和网络的发送框支持使用 `↑` / `↓` 浏览最近发送内容，历史最多保留 50 条并保存在浏览器中。浏览历史时会保留当前草稿，回到最新记录后继续按 `↓` 即可恢复草稿。

自动发送可以设置发送次数，数字为 `0` 时不限次数，填正数后发送指定次数并自动停止。常用快捷键包括 `Ctrl+Enter` 发送、`Ctrl+K` 清屏、`Ctrl+L` 聚焦日志和 `Esc` 停止自动发送。

日志自动保存可以通过工具栏的设置按钮启用，支持串口和网络分别写入独立文件，并可按文件大小或时间间隔自动切分。该功能使用浏览器 File System Access API，因此需要使用桌面版 Chrome 或 Edge，并在启用时选择一个本地文件夹。

串口和网络发送区都提供响应测试。测试会发送当前发送区内容，在指定超时时间内跨接收分片等待预期文本，命中后显示往返延迟和匹配片段，超时或连接断开时自动结束；匹配支持区分大小写。预期内容和超时时间会保存在浏览器中。

串口、普通网络和 SSH 都提供连接配置预设。保存串口预设时会记录端口、波特率、数据位、停止位、校验、流控、DTR 和 RTS；保存普通网络预设时会记录 TCP/UDP、服务端/客户端、地址和端口；保存 SSH 预设时会记录别名、地址、端口、用户名和可选密码。下拉选择预设即可套用，重复保存相同端点会更新原预设，最多保留 20 条；连接期间预设控件会锁定，避免运行中的参数被替换。

串口工作区提供 Macro 宏命令录制。终端模式下键盘输入会按回车切分成命令，日志模式下每次点击发送会记录为一条命令。录制完成后可以点击 Macro 回放，并可配置命令之间的间隔和每个字符之间的发送间隔。

## AI 控制通道

LinkTK 内置一个只监听本机开发服务器的 AI 控制通道。AI 或自动化脚本可以通过 Agent CLI 或 MCP 操作已经打开的 LinkTK 页面；串口、TCP/UDP、YMODEM、Macro、链路桥接、SSH 终端、SFTP 目录和文件传输都会同步显示在页面中，AI 操作会以 `AI` 标记或终端提示区分。

控制通道启动时会生成随机令牌并写入 `~/.linktk/agent-token`。Agent CLI 和 MCP 会自动读取并使用该令牌，页面控制通道同时校验 Origin，外部网页无法直接伪装成 AI 控制器。需要自定义时，可在服务和客户端进程中同时设置 `LINKTK_AGENT_TOKEN`；令牌文件位置可通过 `LINKTK_AGENT_TOKEN_FILE` 覆盖。

AI 可以先调用 `linktk_launch` 自动启动本地服务和浏览器页面。默认 MCP 面只暴露 AI 真正需要的业务能力，例如 `linktk_targets`、`linktk_connect`、`linktk_execute`、`linktk_observe`、`linktk_transfer_file`、`linktk_macro` 和 `linktk_bridge`。对于已经由用户授权过的串口，AI 可以读取目标目录并通过 `linktk_connect` 重新打开目标串口；首次授权某个物理串口仍然必须由用户在浏览器中完成。

每个浏览器标签页都有独立 `sessionId` 和设备别名。多页面同时运行时，AI 必须先通过 `linktk_sessions` 查看目标，再用 `linktk_select_session` 选择会话；`linktk_snapshot` 会返回连接、界面、桥接、AI 控制和最近操作的完整状态。长时间任务可以使用 `linktk_operation_start`、`linktk_operation_status` 和 `linktk_operation_cancel` 独立跟踪与终止。

顶栏“AI 记录”按钮会用角标提示未读操作和待批准状态。面板分为“操作记录”和“控制设置”两个页签，前者用整块可滚动区域显示最近 80 次操作，后者显示当前会话、操作目标、批准策略、设备 Profile 和任务模板。用户可以在“只读”“写操作需要确认”“完全信任”之间切换，也可以暂停 AI 或终止当前操作。默认策略是写操作需要人工确认；暂停后只读查询仍可用，但串口发送、命令执行和 SFTP 修改会被阻止。批准等待会显示倒计时；超时或控制端断开会立即撤回弹窗和写锁，设备不会执行，迟到点击也不会补执行。

设备 Profile 用于保存板卡、Shell 类型、提示符正则、登录/启动提示、默认换行、常用命令和危险模式。AI 选择 Profile 后，发送命令会继承对应的默认换行方式；Profile 会随快照返回，使 AI 不需要每次从零猜测目标设备。设备 Profile 可通过 AI 记录面板的“配置”按钮维护，也可以通过 `linktk_device_profile` 统一列出、选择、保存或删除。

AI 操作证据包会在每次操作前后记录会话、连接、界面、Profile、请求参数和结果，并自动隐藏密码、密钥和较大的 base64 内容。可在 AI 记录面板点击操作右侧的文件按钮导出 JSON，也可以通过 `linktk_evidence` 读取。已完成的操作或事务还能保存成任务模板，在后续通过页面按钮或 `linktk_task` 按步骤回放。

事务通过 `linktk_transaction` 顺序执行多个步骤，并支持 SFTP 文件的恢复式回滚：上传会尝试恢复旧文件，删除会尝试恢复备份，重命名会尝试改回原路径，空目录创建会尝试删除。串口、SSH 和网络命令默认视为不可逆，原子事务会拒绝执行不可回滚步骤；确需执行时应显式允许不可逆步骤，或关闭原子模式。失败步骤本身也会尝试回滚，避免只恢复前面已成功的步骤。

多个 AI 控制端会获得不同的控制器身份。对同一页面写入前可使用 `linktk_session_claim` 声明 `exclusive` 会话租约，其他控制端的写操作会被拒绝，而状态和日志等只读查询仍可继续；`linktk_session_release` 释放租约，`linktk_leases` 查看当前持有者。租约过期或控制端断开后会自动释放，用户仍可在页面暂停、终止或接管 AI。

面向 AI 代理的完整操作规范、命令参数、游标处理和排障流程见 [`docs/AI_AGENT.md`](docs/AI_AGENT.md)。根目录的 `AGENTS.md` 会要求 AI 在操作 LinkTK 前先读取该文档。

浏览器安全模型不允许页面或 AI 自动获取串口权限。首次使用时，需要先在 LinkTK 页面点击“选择 COM 口”并授权目标设备，再打开串口。串口打开后即可在另一个终端运行：

```powershell
npm run agent -- status
npm run agent -- serial-ports
npm run agent -- serial-connect --name "COM12 调试口"
npm run agent -- send --text "help" --ending lf
npm run agent -- exec --text "uname -a" --expect "Linux" --timeout 5000
npm run agent -- exec --data 'printf "LINKTK_%s\n" AGENT_OK' --expect "LINKTK_AGENT_OK" --timeout 5000
npm run agent -- read --wait 1000
npm run agent -- wait --expect "login:" --timeout 10000
npm run agent -- network-connect --protocol tcp --role client --host 127.0.0.1 --port 9000
npm run agent -- network-exec --text "PING" --expect "PONG" --timeout 5000
npm run agent -- ymodem-send --file .\firmware.bin
npm run agent -- macro-list
npm run agent -- bridge-status
npm run agent -- device-profiles
npm run agent -- device-profile-select --name "EVB-A1 Linux"
npm run agent -- transactions
npm run agent -- tasks
```

`exec` 会先发送文本，再等待接收区出现指定文本；默认使用包含匹配。结果以 JSON 输出，包含发送字节数、匹配状态、超时状态和接收内容。也可以直接运行 `node tools/linktk-agent.mjs status`。控制地址默认是 `ws://127.0.0.1:5173/__agent-control`，可设置 `LINKTK_AGENT_URL` 覆盖。

除了命令行，LinkTK 还提供基于 stdio 的 MCP 服务：

```powershell
npm run mcp
```

将以下配置加入 Codex 的 `mcp_servers` 后，AI 默认获得 23 个业务工具：生命周期与会话、长操作、`linktk_targets`、`linktk_connect`、`linktk_disconnect`、`linktk_execute`、`linktk_observe`、`linktk_transfer_file`、`linktk_bridge`、`linktk_macro`、`linktk_device_profile`、`linktk_transaction`、`linktk_task` 和 `linktk_evidence`。MCP 仍然通过运行中的 LinkTK 页面操作目标设备，不会创建第二条串口、TCP/UDP 或 SSH 连接。

```toml
[mcp_servers.linktk]
command = "node"
args = ["C:\\path\\to\\LinkTK\\tools\\linktk-mcp.mjs"]
env = { LINKTK_AGENT_URL = "ws://127.0.0.1:5173/__agent-control" }
```

页面顶栏的“AI 记录”面板也提供“复制配置”按钮，会按当前项目位置和页面地址生成一份可直接粘贴的 MCP JSON 配置。修改项目目录后无需手动更新其中的 `linktk-mcp.mjs` 路径。

默认不暴露 `linktk_serial_*`、`linktk_network_*`、`linktk_ssh_*`、`linktk_sftp_*`、`linktk_ymodem_*` 等协议级工具，避免 AI 被按钮式接口牵走。需要兼容旧脚本时，可以在 MCP 进程中显式设置 `LINKTK_MCP_ADVANCED=1`，再使用这些高级工具。

MCP 工具会携带 `readOnlyHint`、`destructiveHint` 和 `idempotentHint` 注解。支持这些注解的客户端可以在调用前提示“读取状态”“修改设备”或“可能破坏远端状态”，页面侧批准策略仍然是最终门禁。

`linktk_transfer_file` 会自动在 SFTP 和 YMODEM 之间选择，并在内部处理分块。SFTP 单次业务传输上限为 16 MiB，YMODEM 单次上传上限为 1 MiB。

同一时间只允许执行一个 AI 写操作，避免多个命令交错写入串口；只读观察、状态查询和等待响应可以与写操作并行。浏览器页面关闭或刷新时，未完成的 AI 请求会立即返回错误。

## 运行

Windows 下可以直接双击项目根目录 `LinkTK` 下的 `start.bat`。脚本会自动进入项目目录、检查 Node.js、在需要时安装依赖，并在单独的窗口中直接启动 Vite，启动器窗口随后会自动关闭。需要关闭服务时，在服务器窗口按 `Ctrl+C`，窗口会立即退出；直接关闭该窗口也会停止服务。

也可以使用命令行启动：

```powershell
npm install
npm run dev
```

然后使用桌面版 Chrome 或 Edge 打开：

```text
http://127.0.0.1:5173
```

Web Serial 要求安全上下文。本机 `localhost` 和 HTTPS 可用，普通 `http://` 局域网地址通常不可用。

## 使用说明

1. 点击“选择 COM 口”，在浏览器弹出的系统选择器中选择串口设备。
2. 设置波特率、数据位、停止位、校验位和流控。
3. 点击“打开串口”。
4. 使用文本或 HEX 模式发送数据，接收区会按 RX/TX 开关显示收发日志。

浏览器的 Web Serial API 不会把系统串口名称（例如 `COM3`）直接暴露给网页。本工具会在本地 Vite 服务中读取 Windows 串口名称，再通过 VID/PID 与浏览器已授权端口匹配，尽量显示设备管理器中的 `XR21V1410 USB UART (COM12)` 这类名称；如果无法匹配，则回退显示 USB 的 VID/PID。

## 构建与测试

```powershell
npm run build
npm run test:coordination
npm run test:ssh
npm run test:mcp
npm run test:ymodem
npm run test:smoke
```

`test:coordination` 启动本地 AI 控制桥接，验证多个控制端之间的独占租约、并发写拒绝、只读查询、释放和强制接管。`test:ssh` 会启动本地 SSH/SFTP 服务器和浏览器，检查弹窗连接、终端输出、键盘输入、文件浏览器布局、SFTP 上传下载和断开流程。`test:mcp` 会分别启动默认和高级 stdio MCP 服务，检查默认只暴露 23 个业务工具、高级模式保留旧协议工具，并验证连接、执行、观察、Profile 和任务参数转发。`test:ymodem` 使用发送端/接收端回环测试 CRC16、1 KB、128 B 和零字节文件传输。`test:smoke` 使用本机 Edge 启动一个模拟 Web Serial 端口，检查 Agent CLI 串口连接与闭环、网络闭环、YMODEM、Macro、链路桥接、会话与活动面板、设备 Profile、只读原子事务、任务模板、证据包、写操作批准与拒绝、AI 暂停、后台操作取消、端口连接、发送接收、快捷键和日志状态。

烟雾测试还会打开两个页面，分别运行 TCP 和 UDP 服务器/客户端，并双向发送数据验证真实网络桥接；同时使用模拟串口验证“串口 ↔ 网络”的双向链路桥接。

## 示例项目

`examples/linktk-probe` 是一个通过 LinkTK Agent CLI 部署到 Linux 板端运行的零依赖巡检工具。它演示了环境探测、本地单元测试、串口分片部署、板端语法检查、真实运行和阈值退出码验证。运行方式见 [`examples/linktk-probe/README.md`](examples/linktk-probe/README.md)。

## 许可证

MIT,详见 [LICENSE](LICENSE)。
