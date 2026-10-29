# xiaoxue(小雪)

一个驻留循环智能体:单进程、每秒轮询,通过本地 IO 文件与人对话,
能看虚拟桌面(Xvfb)、操作键鼠、执行 shell,并维护自己的长期记忆。

原则:**实现简单(一个循环),设计深入(IO 契约、上下文反射、可验证性)**。

## 工作方式

```
你 ──send──▶ inbox.jsonl + wake.json ─┐
其他工具 ───────▶ wake.json ──────────┴─▶ [daemon 循环:每秒轮询]
                                     │ wake 变化或到点(self)才醒来跑一轮
                                     ▼
                              context.ts 反射构建上下文
                              (人设+一条系统提醒+最近 K 轮+本轮新消息)
                                     ▼
                              agentLoopContinue(可调用工具)
                                     │
                ┌────────────────────┼────────────────────┐
                ▼                    ▼                    ▼
        run/outbox.jsonl     run/transcript.jsonl   memory/*.md
        (给你的回复)          (全量事件流,审计)      (长期记忆,低频写)
```

- **对话即文件**:没有函数调用式的聊天,你和她的每条消息都是 jsonl 里的一行。
- **外部唤醒**:send 与其他工具都通过递增 `run/wake.json` 的 `seq` 唤醒 daemon;
  daemon 下一秒发现信号变化后读取 inbox,有消息按 inbox 处理,没有则按 self 处理;
  已处理 wake ID 存在 state 中,重启会补处理离线信号。
- **反射上下文**:每次醒来从磁盘重读人设——你改了人设文件,她下一次醒来就感知到。
  人设里的 `${MEMORY}`/`${MEMORY_DIR}`/`${FRIEND}`/`${SUMMARY}` 占位符会被替换成对应记忆文件/目录路径;
  工具用法不在 system prompt,写在各工具 description 里。
- **自然口吻注入**:消息不用 `<data>` 标签,直接以“朋友发来消息”的口吻进上下文;
  游标等程序状态不进上下文。
- **稳定前缀**:system(人设+提醒)逐字节不变时命中 provider 前缀缓存
  (metrics 里的 `cacheRead` 可验证)。
- **steering**:她忙碌中你插发的消息不必排队等下一次醒来——loop 每个工具轮之间
  重读 inbox,新消息以“朋友又发来新消息”高优先级注入,她可以立刻调整甚至放弃手头计划
  (在途的那一次工具调用无法撤销,下一轮边界生效)。
- **主动发言**:闲置满 `AGENT_HEARTBEAT_MIN` 分钟(墙钟驱动;用户活跃期间
  `lastTs` 持续推新,不会插队)自发醒一次,她可以做自己的事,想联系朋友时自己选择工具;
  self 自醒不自动送达最终文本。
- **归档式压缩**:对话超过历史窗口 + 最小批量时,旧事件搬进 `${SUMMARY}/<时间>.json`
  (原始记录)+ `<时间>.md`(LLM 摘要),transcript 截断只留最近窗口——摘要不进上下文,
  她需要时可以自己翻归档(人设里有指引)。

## 目录

```
agent.ts        # 循环骨架:daemon / send 两个入口
env.ts          # .env 加载(import 链最前,自动执行) + envRequired(必填项,缺失拒绝启动)
io.ts           # 唯一磁盘层:文件位置由 .env 必填项标注,上层只经它读写
context.ts      # 上下文反射构建、本轮 transcript 落盘 + 归档式压缩(摘要函数由 agent 注入)
tools/          # 每个工具一个文件,index.ts 是注册表
                #   (screenshot.ts 内含纯 TS 手写 X11 协议截图核心,零外部依赖)
lib/            # 工具基础设施:define.ts(泛型定义助手)、xdo.ts(xdotool 封装,导出 DISPLAY)
```

所有应用配置都在 `.env` 中显式写出(**无代码默认值**,缺失直接拒绝启动);目录和文件不存在会自动创建:

```
AGENT_HOME        # 她的家(独立目录,可在任意位置);bash 的 cwd
AGENT_PERSONA     # 人设文件(只有用户能改——见“禁区”;可用上述四个占位符)
AGENT_MEMORY      # 主记忆文件(占位符 ${MEMORY})
AGENT_MEMORY_DIR  # 记忆细节目录(占位符 ${MEMORY_DIR})
AGENT_FRIEND      # 朋友记忆文件(占位符 ${FRIEND})
AGENT_SUMMARY_DIR # 总结归档目录(占位符 ${SUMMARY})
AGENT_RUN_DIR     # 运行时 IO(不进 git):inbox/outbox/transcript/llm/state/wake/metrics/screen.png
                  #   llm.jsonl = 模型原始返回日志(assistant 全量消息/工具调用与结果)
DISPLAY           # 虚拟桌面显示号(如 :99),必须与 Xvfb 启动参数一致
```

## 工具

| 工具 | 作用 |
|---|---|
| `bash` | 通用 shell(cwd=她的家;读文件/ls/sleep/后台起 GUI,超时强杀) |
| `screenshot` | 截虚拟桌面 → 直接注入模型视觉输入 |
| `view_image` | 把磁盘图片(png/jpg/webp/gif ≤8MB)注入视觉输入 |
| `click` | 鼠标移动+点击(xdotool,DISPLAY 锁死) |
| `type` | 键盘输入;text/组合键/按窗口标题先聚焦 |
| `send_user` | 给用户发一条消息(写 outbox) |

## 禁区(文本护栏)

- **`.env`**:密钥文件,bash 命令文本命中 `.env` 直接拒绝执行。
- **人设文件(`AGENT_PERSONA` 标注的位置)**:bash 拦截命令文本含
  `persona` 的调用——**模型不能自我篡改身份**,人设只由用户维护。
- **运行时目录(`AGENT_RUN_DIR`)**:bash 命令文本命中该路径直接拒绝;截图等系统工具仍可内部读写。
- **环境变量**:bash 只收到 PATH/HOME/DISPLAY/LANG 等必要值,不会继承 API key 和 AGENT 配置。

拦截是保守子串匹配,用于减少误操作;shell 引号/变量可绕过文本匹配,不能替代文件权限或沙箱。

## 运行

前置:Node ≥22.18、Xvfb、xdotool(虚拟桌面安装见下方)。

Debian / Ubuntu 可通过 NodeSource 安装 Node.js 22:

```sh
sudo apt update
sudo apt install -y curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version             # 确认版本 ≥ v22.18.0
```

然后安装依赖并启动:

```sh
cp .env.example .env   # 填 API key,并按实际位置修改所有路径;
                       # 必须配视觉模型(screenshot 靠它看)
npm install
node agent.ts          # 启动循环
```

```sh
node agent.ts send "你好"   # 另开终端:投递消息到 inbox,并更新 wake.json
```

模型配置(`.env`):`AGENT_MODEL_PROVIDER` / `AGENT_MODEL_ID`。设了
`AGENT_MODEL_BASE_URL` 就一律走自定义 OpenAI 兼容模型(默认带视觉);
没设则查 pi-ai 内置注册表,查不到且 provider=deepseek 时用官方地址兑底。

## 虚拟桌面(Xvfb)

她的 `screenshot` / `click` / `type` 都作用在一个无头 X 桌面上,通过 `DISPLAY` 指定;
截图走本地 unix socket,不会碰你的物理屏幕。

### 1. 安装

Debian / Ubuntu:

```sh
sudo apt update
sudo apt install -y xvfb xdotool x11-utils
# 可选:中文字体,否则 GUI 里的中文会显示成方块
sudo apt install -y fonts-noto-cjk
```

- `xvfb`:无头 X 服务器
- `xdotool`:`click` / `type` 的底层命令
- `x11-utils`:提供 `xdpyinfo`,用于验证显示

### 2. 启动

```sh
Xvfb :99 -screen 0 1024x768x24 -nolisten tcp &
```

| 参数 | 含义 |
|---|---|
| `:99` | 显示号,对应 socket `/tmp/.X11-unix/X99`;`.env` 的 `DISPLAY` 必须与之一致 |
| `-screen 0 1024x768x24` | 第 0 块屏幕,1024×768,24 位色 |
| `-nolisten tcp` | 只开本地 unix socket(截图也只支持本地显示) |

**用 24 位色深**:chromium 等应用在 16 位 visual 上渲染颜色是坏的(帧缓冲里就不是原色);
截图 16/32 bpp 都支持,但只有 24 位能保证应用侧颜色正确。

后台常驻:

```sh
nohup Xvfb :99 -screen 0 1024x768x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
pgrep -a Xvfb                    # 确认进程在
cat /tmp/xvfb.log                # 进程不存在或马上退出时查看原因
```

> 分辨率在启动时固定;改尺寸只能杀掉重启(窗口内容会丢)。

### 3. 配置与验证

`.env` 中写明(必填,无默认值):

```dotenv
DISPLAY=:99
```

验证:

```sh
DISPLAY=:99 xdpyinfo | grep dimensions     # dimensions: 1024x768 pixels
DISPLAY=:99 xdotool getdisplaygeometry     # 1024 768
```

daemon 只在启动时读 `.env`;改了 `DISPLAY` 要重启 daemon。

### 4. 没有窗口管理器

Xvfb 只有裸 X 服务器,没有窗口管理器(WM),所以:

- 新窗口不会自动获得键盘焦点;`type` 支持 `window` 参数按标题聚焦
  (`xdotool search --name <标题> windowfocus`);
- `click` 通常能让多数程序获得焦点,但键盘输入仍建议配合 `window`;
- `xwininfo -root -tree` 可列出当前窗口及其标题。

需要窗口装饰、最大化等行为时,可在同一 `DISPLAY` 上再起一个轻量 WM(以 openbox 为例):

```sh
sudo apt install -y openbox
DISPLAY=:99 openbox &     # 也可改用 fluxbox / i3
```

启动她自己的 GUI 程序前,先启动 Xvfb;窗口管理器不是必需品。

### 5. 常用操作

```sh
# 起 GUI 程序(经她的 bash 工具时,命令末尾加 & 后台运行;以下程序需自行安装)
DISPLAY=:99 xterm &
DISPLAY=:99 chromium --no-sandbox --disable-gpu &

# 远程旁观桌面(可选,需安装 x11vnc)
# -localhost 仅监听本机;从另一台机器查看时请通过 SSH 端口转发,不要直接暴露 VNC 端口
x11vnc -display :99 -localhost -nopw
```

上述 Xvfb 命令未启用 X 鉴权,同一台机器上的其他本地用户可能连接并操作这个桌面。
不要把它用于不受信任的多用户环境,也不要删除 `-nolisten tcp` 后直接暴露到网络。

### 6. 停止与清理

```sh
pkill -f "Xvfb :99"
```

异常退出可能留下 `/tmp/.X99-lock`。确认没有 Xvfb 在跑后删除它,
否则下次启动会报 `Server is already active for display 99`。

### 7. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `Cannot open display` | `DISPLAY` 与 Xvfb 显示号不一致,或 Xvfb 没在跑;查 `pgrep -a Xvfb` 与 `/tmp/.X11-unix/X99` |
| `Server is already active for display 99` | 残留 `/tmp/.X99-lock`;确认无进程后删除 |
| `X 服务器要求鉴权(未提供 XAUTHORITY)` | Xvfb 带了 `-auth`;去掉鉴权启动,或提供正确的 `XAUTHORITY` |
| 截图颜色不对 | 用了 16 位屏;改为 `-screen 0 1024x768x24` |
| `暂只支持 bpp=16/32` | 当前屏幕深度不支持;用 x24(或 x16)重启 |
| 键盘输入没反应 | 无 WM,焦点不在目标窗口;用 `type` 的 `window` 参数,或起一个 WM |
| 中文显示成方块 | 安装中文字体(`fonts-noto-cjk`) |

## 后台保活(systemd)

长期驻留用 systemd:SSH 断开不影响、崩溃自动重启、开机自启、日志可追查。
`deploy/` 下有两个服务模板:`xvfb.service`(虚拟桌面)和 `xiaoxue.service`(daemon,
随 xvfb 之后启动)。模板使用上述安装位置 `/usr/bin/node` 与 `/usr/bin/Xvfb`;
运行用户和项目目录不预设,部署时必须按实际环境填写。

### 1. 安装服务

```sh
sudo cp deploy/xvfb.service deploy/xiaoxue.service /etc/systemd/system/
```

然后按实际环境编辑 `/etc/systemd/system/` 下的两个文件。`YOUR_USERNAME` 和
`/absolute/path/to/xiaoxue` 是必须替换的占位符,不能直接启动:

| 配置项 | 说明 |
|---|---|
| `User` | 将 `YOUR_USERNAME` 改为运行 daemon 的实际用户,建议用普通用户而非 root |
| `WorkingDirectory` | 将 `/absolute/path/to/xiaoxue` 改为项目绝对路径;`env.ts` 按相对路径读 `.env`,目录错了会读不到配置 |
| `ExecStart` | 同步替换其中的项目绝对路径;`command -v node` / `command -v Xvfb` 可检查程序路径,不同时也要替换 |
| `Xvfb :99` | 显示号必须与 `.env` 的 `DISPLAY` 一致 |

### 2. 启动与开机自启

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now xvfb xiaoxue
```

### 3. 日常管理

```sh
systemctl status xiaoxue          # 看状态
journalctl -u xiaoxue -f          # 实时日志
sudo systemctl restart xiaoxue    # 改了 .env / 代码后重启
sudo systemctl stop xiaoxue       # 停止(SIGTERM 优雅退出,不会立即强杀)
```

`Restart=always` 让进程退出(包括崩溃)后自动拉起:`xiaoxue` 等 5 秒,`xvfb` 等 3 秒。

临时调试不想装服务时,也可以用 tmux:`tmux new -s xiaoxue` 里跑 `node agent.ts`,
`Ctrl-b d` 脱离;但崩溃不会自动重启,机器重启后也不会恢复。
