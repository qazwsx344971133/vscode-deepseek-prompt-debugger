# DeepSeek Harness

DeepSeek 提示词调试工具 - VSCode 侧边栏 Webview 面板插件，兼容 OpenAI 接口协议，用于快速调试 System / User Prompt 与采样参数。

---

## ✨ 功能一览

| 功能 | 说明 |
|---|---|
| 📝 Prompt 输入 | 独立的 **System Prompt** 与 **User Prompt** 输入框 |
| ⚙️ 参数配置 | `temperature`、`top_p`、`max_tokens`、`model` 可配置 |
| 🔑 设置读取 | `API Key` 与 `baseUrl` 从 VSCode 设置 `deepseekHarness.*` 中读取 |
| 🚀 API 调用 | 使用 axios 调用 DeepSeek（或任意 OpenAI 兼容）`/v1/chat/completions` 接口 |
| 📚 模板持久化 | 一键保存/加载/删除 System+User+参数整套模板，存储在插件 global storage（JSON） |
| 📋 代码块复制 | 自动识别 ` ```lang ... ``` ` 代码块，提供复制按钮（走 VSCode 剪贴板） |
| 🚨 错误提示 | API Key 为空、网络错误、HTTP 错误、超时都有中文提示 |
| 🧵 非流式响应 | 普通完整返回即可，不带多轮对话上下文，更便于调试单轮 Prompt |

---

## 📁 项目结构

```
deepseek-harness/
├── package.json          # 插件清单、依赖、配置项定义
├── tsconfig.json         # TypeScript 编译配置
├── .vscodeignore         # 打包排除项
├── resources/
│   └── icon.svg          # 侧边栏图标
└── src/
    └── extension.ts      # 主入口：WebviewProvider + API + 模板存储 + 前端页面（内联）
```

> 注：Webview 的 HTML / CSS / JS 全部以字符串形式直接内联在 `extension.ts` 中，因此无需额外的前端构建步骤，`tsc` 后即可直接运行。

---

## 🚀 本地加载 & 调试步骤（Windows）

### 前置准备

1. 安装 **Node.js 18+**（推荐 LTS）：<https://nodejs.org/>
2. 安装 **VSCode**：<https://code.visualstudio.com/>

### 第一步：安装依赖 & 编译

打开 PowerShell 或 CMD，进入项目目录：

```powershell
cd "C:\Users\35058\Desktop\deepseek插件\deepseek-harness"
npm install
npm run compile
```

编译成功后会生成 `out/extension.js` 与 `out/extension.js.map`。

### 第二步：在 VSCode 中按 F5 调试（推荐）

1. 用 VSCode 打开项目根目录：
   ```
   File → Open Folder → 选择 deepseek-harness 文件夹
   ```
2. 按 `F5`（或菜单：**Run → Start Debugging**）。
3. VSCode 会自动弹出一个 **扩展开发宿主窗口（Extension Development Host）**。
4. 在新窗口左侧活动栏找到 **「DeepSeek Harness」图标（💬 气泡）**，点击即可展开侧边栏面板。

> 如果 F5 没反应，手动创建 `.vscode/launch.json`（见下一节）。

### （可选）手动创建 `.vscode/launch.json`

如果项目没有 `.vscode/launch.json`，可以新建一份：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Extension",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/out/**/*.js"],
      "preLaunchTask": "${defaultBuildTask}"
    }
  ]
}
```

以及 `.vscode/tasks.json`：

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "npm",
      "script": "watch",
      "problemMatcher": "$tsc-watch",
      "isBackground": true,
      "presentation": { "reveal": "never" },
      "group": { "kind": "build", "isDefault": true }
    }
  ]
}
```

### 第三步：配置 API Key & BaseUrl

在扩展开发宿主窗口（或你自己的 VSCode）里：

1. 按 `Ctrl+,` 打开设置
2. 搜索 `deepseekHarness`
3. 填写：
   - **Deepseek Harness: Api Key**：你的 DeepSeek API Key（形如 `sk-xxxxxxxxxx`）
   - **Deepseek Harness: Base Url**：默认 `https://api.deepseek.com`（带 `/v1/...` 会自动拼接，末尾带 `/` 也兼容）
   - **Deepseek Harness: Default Model**：默认 `deepseek-chat`

也可以直接在 `settings.json` 中写：

```json
{
  "deepseekHarness.apiKey": "sk-xxxxxxxxxxxxxxxxxxxx",
  "deepseekHarness.baseUrl": "https://api.deepseek.com",
  "deepseekHarness.defaultModel": "deepseek-chat"
}
```

> 🔒 **Key 安全说明**：Key 只存于 VSCode 用户设置里，调用时走 axios Authorization 头，**不会**明文出现在 Webview 中（Webview 只知道 key 是否已配置）。

### 第四步：使用面板

1. **System Prompt**：填入系统指令（可选），例如「你是资深 TypeScript 工程师，请用中文回答」
2. **User Prompt**：填入用户问题（必填），例如「写一个防抖函数，带立即执行选项」
3. 展开 **⚙ 参数配置**，调整 temperature / top_p / max_tokens / model
4. 点击 **🚀 发送请求**，等待结果
5. 结果区分为：
   - 上半部分：**渲染版**，自动识别 ``` 代码块并提供「📋 复制代码」按钮
   - 下半部分：**原始文本版** textarea，方便全选复制
6. 点击 **💾 保存模板**，给当前 System+User+参数起个名，一键存到本地
7. 打开 **📚 Prompt 模板** 折叠区，随时「加载 / 删除」历史模板

---

## 🧪 编译验证命令

```powershell
# 一次性编译
npm run compile

# 监听模式（开发时用）
npm run watch
```

编译无错误 = 成功 ✅

---

## 📦 打包为 .vsix（可选）

如需发布或离线安装：

```powershell
npm install -g @vscode/vsce
vsce package
```

会在根目录生成 `deepseek-harness-0.0.1.vsix`，手动安装：

```
VSCode → Extensions → ... → Install from VSIX...
```

---

## 🐛 常见问题

### 1. 点击发送没反应 / 报错说 API Key 为空
- 检查是否在 **当前窗口（扩展开发宿主窗口）** 的设置里配了 `deepseekHarness.apiKey`；主窗口和宿主窗口的用户设置是共享的，但 workspace 设置是独立的。

### 2. 网络错误 `ECONNREFUSED` / `ETIMEDOUT`
- 检查 `baseUrl` 是否正确（默认 `https://api.deepseek.com`，不要加 `/v1` 后缀，代码会自动拼 `/v1/chat/completions`）
- 检查代理或防火墙是否放行 443 出站

### 3. HTTP 401 Unauthorized
- API Key 错误或已失效，到 DeepSeek 控制台重发 Key。

### 4. HTTP 429 Too Many Requests
- 免费额度 / RPM 超限，稍后再试或升级套餐。

### 5. 侧边栏看不到 DeepSeek Harness 图标
- 确认活动栏视图容器 ID 对应：视图在 `DeepSeek Harness` 容器内，不是 Explorer
- 右键活动栏 → 勾选「DeepSeek Harness」

---

## 🔧 开发说明

- 所有核心代码都在 [`src/extension.ts`](./src/extension.ts)，包含详细中文注释
- 接口遵循 OpenAI Chat Completions 协议，所以切换 `baseUrl` 即可兼容：
  - 官方 DeepSeek：`https://api.deepseek.com`
  - 本地 Ollama（开启 OpenAI 兼容端口）：`http://localhost:11434/v1`
  - 其他兼容 OpenAI 的中转服务同理
- 模板存储使用 `vscode.ExtensionContext.globalState`，JSON 序列化持久化到用户目录下的 VSCode globalStorage

---

## 📄 License

MIT
