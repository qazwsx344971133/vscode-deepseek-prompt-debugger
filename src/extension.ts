/**
 * DeepSeek Harness - VSCode 插件主入口
 * 功能：侧边栏 Webview 面板，用于 DeepSeek 提示词调试
 *
 * 模块划分：
 *   1) 类型定义         - 请求参数、模板、消息结构
 *   2) Webview Provider - 注册侧边栏视图、生成 HTML、消息路由
 *   3) API 调用封装     - 使用 axios 调用 OpenAI 兼容接口
 *   4) 模板存储         - 通过 globalState 持久化 JSON
 *   5) activate / deactivate - VSCode 生命周期钩子
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import axios, { AxiosError } from 'axios';

// ============== 1. 类型定义 ==============

/** 模型请求参数 */
interface RequestParams {
  temperature: number;
  top_p: number;
  max_tokens: number;
  model: string;
}

/** Prompt 模板（System+User+参数 整套保存） */
interface PromptTemplate {
  id: string;
  name: string;
  systemPrompt: string;
  userPrompt: string;
  params: RequestParams;
  createdAt: number;
}

/** Webview -> Extension 的消息类型 */
type WebviewMessage =
  | { type: 'sendRequest'; data: { systemPrompt: string; userPrompt: string; params: RequestParams } }
  | { type: 'saveTemplate'; data: { name: string; systemPrompt: string; userPrompt: string; params: RequestParams } }
  | { type: 'requestSaveTemplate'; data: { systemPrompt: string; userPrompt: string; params: RequestParams } }
  | { type: 'loadTemplates' }
  | { type: 'deleteTemplate'; data: { id: string } }
  | { type: 'requestDeleteTemplate'; data: { id: string } }
  | { type: 'loadTemplate'; data: { id: string } }
  | { type: 'getSettings' }
  | { type: 'openSettings' }
  | { type: 'copyCode'; data: { code: string } }
  | { type: 'runtimeError'; data: { message: string; stack?: string; source?: string } };

/** Extension -> Webview 的消息类型 */
type ExtensionMessage =
  | { type: 'responseSuccess'; data: { content: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } } }
  | { type: 'responseError'; data: { message: string } }
  | { type: 'templatesList'; data: PromptTemplate[] }
  | { type: 'templateLoaded'; data: PromptTemplate }
  | { type: 'templateSaved'; data: { id: string; name: string } }
  | { type: 'templateDeleted'; data: { id: string } }
  | { type: 'settingsInfo'; data: { apiKeySet: boolean; baseUrl: string; defaultModel: string } }
  | { type: 'copyResult'; data: { success: boolean; message: string } };

// ============== 常量 ==============

/** 模板列表在 globalState 中的存储 key */
const STORAGE_KEY_TEMPLATES = 'deepseek_harness_templates';

// ============== 2. Webview Provider 核心类 ==============

class DeepSeekHarnessViewProvider implements vscode.WebviewViewProvider {
  /** 视图 ID，与 package.json 中 contributes.views 对应 */
  public static readonly viewType = 'deepseekHarnessPanel';

  /** 当前 Webview 视图实例 */
  private _view?: vscode.WebviewView;

  /** 插件上下文，用于读取 globalState、定位资源路径 */
  private readonly _context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
  }

  /**
   * VSCode 在用户打开侧边栏面板时回调此方法
   * 在这里设置 webview 选项、注入 HTML、绑定消息监听
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    console.log('[DeepSeek Harness] resolveWebviewView: 开始构建 Webview 面板');
    this._view = webviewView;

    // 允许 Webview 执行脚本，并声明允许加载的本地资源根
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this._context.extensionPath, 'resources')),
        vscode.Uri.file(path.join(this._context.extensionPath, 'src', 'webview')),
      ],
    };

    // 注入 HTML 内容
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // 处理 Webview 发送过来的消息
    webviewView.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this._handleMessage(msg),
      undefined,
      this._context.subscriptions,
    );

    // ===== 修复：实时监听 VSCode 设置变更，配置一改立刻推给 Webview（避免 UI 黄色条不刷新） =====
    const cfgListener = vscode.workspace.onDidChangeConfiguration((evt) => {
      // 只关心 deepseekHarness 相关项变化（apiKey / baseUrl / defaultModel）
      if (evt.affectsConfiguration('deepseekHarness')) {
        console.log('[DeepSeek Harness] 检测到设置变更，推送最新 settingsInfo 到 Webview');
        if (this._view) {
          this._handleGetSettings((m) => this._view!.webview.postMessage(m));
        }
      }
    });
    this._context.subscriptions.push(cfgListener);
    // 面板被关闭/销毁时释放监听器
    webviewView.onDidDispose(() => cfgListener.dispose(), undefined, this._context.subscriptions);
  }

  /**
   * 消息路由：分发到各处理方法
   */
  private async _handleMessage(message: WebviewMessage): Promise<void> {
    if (!this._view) return;

    // 发消息给 Webview 的快捷方法
    const post = (msg: ExtensionMessage) => this._view!.webview.postMessage(msg);

    try {
      switch (message.type) {
        case 'sendRequest':
          await this._handleSendRequest(message.data, post);
          break;
        case 'saveTemplate':
          await this._handleSaveTemplate(message.data, post);
          break;

        case 'requestSaveTemplate':
          // 【修复保存模板无反应】VSCode Webview 禁用了原生 window.prompt()
          // 改由 Extension Host 调 vscode.window.showInputBox 弹窗让用户输入模板名
          try {
            const existingCount = this._readTemplates().length;
            const name = await vscode.window.showInputBox({
              title: '保存 Prompt 模板',
              prompt: '请输入模板名称（方便以后识别）',
              placeHolder: '例如：算法问答模板 / 代码翻译模板',
              value: '未命名模板 ' + (existingCount + 1),
              ignoreFocusOut: true,
              validateInput: (val) => {
                if (!val || !val.trim()) return '模板名称不能为空';
                if (val.length > 80) return '模板名称过长（≤80字符）';
                return null;
              },
            });
            // 用户点取消 → name 为 undefined，不保存
            if (typeof name !== 'string') return;
            // 拿到名字后走原有保存流程
            await this._handleSaveTemplate(
              { ...message.data, name: name.trim() || ('未命名模板 ' + (existingCount + 1)) },
              post,
            );
          } catch (err) {
            const msg = (err instanceof Error) ? err.message : String(err);
            post({ type: 'responseError', data: { message: '保存模板失败：' + msg } });
            vscode.window.showErrorMessage('保存模板失败：' + msg);
          }
          break;
        case 'loadTemplates':
          await this._handleLoadTemplates(post);
          break;
        case 'loadTemplate':
          await this._handleLoadTemplate(message.data.id, post);
          break;
        case 'deleteTemplate':
          await this._handleDeleteTemplate(message.data.id, post);
          break;

        case 'requestDeleteTemplate':
          // 【修复删除无反应】和保存模板一样的坑：Webview 里 window.confirm() 被 VSCode 静默禁用
          // 改由 Extension Host 调用 showWarningMessage 弹窗，带「删除」/「取消」两个选项
          try {
            const tpls = this._readTemplates();
            const target = tpls.find((t) => t.id === message.data.id);
            const displayName = target ? target.name : '该模板';
            const choice = await vscode.window.showWarningMessage(
              `确定删除模板「${displayName}」吗？（删除后不可恢复）`,
              { modal: true, detail: '删除操作将永久移除该模板，建议先加载导出内容做备份。' },
              '删除',
              '取消',
            );
            if (choice !== '删除') return; // 用户选取消 或 点关闭
            await this._handleDeleteTemplate(message.data.id, post);
          } catch (err) {
            const msg = (err instanceof Error) ? err.message : String(err);
            post({ type: 'responseError', data: { message: '删除模板失败：' + msg } });
            vscode.window.showErrorMessage('删除模板失败：' + msg);
          }
          break;
        case 'getSettings':
          this._handleGetSettings(post);
          break;
        case 'openSettings':
          // 直接打开 VSCode 设置并过滤到本插件
          vscode.commands.executeCommand('workbench.action.openSettings', 'deepseekHarness');
          break;
        case 'copyCode':
          // 代码块复制：使用 VSCode 剪贴板 API
          try {
            await vscode.env.clipboard.writeText(message.data.code);
            post({ type: 'copyResult', data: { success: true, message: '代码已复制到剪贴板' } });
            vscode.window.showInformationMessage('代码已复制到剪贴板');
          } catch (err) {
            const msg = (err instanceof Error) ? err.message : String(err);
            post({ type: 'copyResult', data: { success: false, message: '复制失败：' + msg } });
          }
          break;

        case 'runtimeError':
          // Webview 端 JS 运行时错误：弹框暴露给用户（否则只会静默白屏）
          console.error('[DeepSeek Harness] Webview runtime error:', message.data);
          vscode.window.showErrorMessage(
            '[DeepSeek Harness] 面板脚本错误: ' +
            (message.data.message || '未知错误') +
            (message.data.source ? ' @' + message.data.source : ''),
          );
          break;
      }
    } catch (unexpected: any) {
      // 兜底：任何未捕获的异常都要报告给 Webview
      const errMsg = (unexpected instanceof Error) ? unexpected.message : String(unexpected);
      console.error('[DeepSeek Harness] Unhandled error in message handler:', unexpected);
      post({ type: 'responseError', data: { message: '内部错误: ' + errMsg } });
    }
  }

  // ============== 3. API 请求处理（axios 封装 OpenAI 兼容协议） ==============

  private async _handleSendRequest(
    data: { systemPrompt: string; userPrompt: string; params: RequestParams },
    post: (msg: ExtensionMessage) => void,
  ): Promise<void> {
    // 从 VSCode 设置中读取配置（不会把 key 暴露到 Webview）
    const cfg = vscode.workspace.getConfiguration('deepseekHarness');
    const apiKey: string = (cfg.get<string>('apiKey') || '').trim();
    let baseUrl: string = (cfg.get<string>('baseUrl') || 'https://api.deepseek.com').trim();

    // ------- 基础校验（出错直接返回，不打网络） -------
    if (!apiKey) {
      const msg = 'API Key 为空，请在 VSCode 设置中配置 deepseekHarness.apiKey';
      vscode.window.showErrorMessage(msg);
      post({ type: 'responseError', data: { message: msg } });
      return;
    }
    if (!data.userPrompt || !data.userPrompt.trim()) {
      post({ type: 'responseError', data: { message: 'User Prompt 不能为空' } });
      return;
    }

    // 去除 baseUrl 尾部的 '/'，避免拼接出双斜杠
    baseUrl = baseUrl.replace(/\/+$/, '');

    // 构造 messages（OpenAI Chat Completions 格式）
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (data.systemPrompt && data.systemPrompt.trim()) {
      messages.push({ role: 'system', content: data.systemPrompt.trim() });
    }
    messages.push({ role: 'user', content: data.userPrompt.trim() });

    // 请求体
    const body = {
      model: (data.params.model && data.params.model.trim()) || 'deepseek-chat',
      messages,
      temperature: Number(data.params.temperature) ?? 1.0,
      top_p: Number(data.params.top_p) ?? 1.0,
      max_tokens: Number(data.params.max_tokens) ?? 2048,
      stream: false, // 明确：非流式
    };

    try {
      const resp = await axios.post(
        baseUrl + '/v1/chat/completions',
        body,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey,
          },
          timeout: 120_000, // 120 秒超时
        },
      );

      // OpenAI 兼容格式：choices[0].message.content
      const payload: any = resp.data;
      const content: string =
        (payload && payload.choices && payload.choices[0] &&
          (payload.choices[0].message && payload.choices[0].message.content) ||
          payload.choices[0].text) ||
        '';
      const usage = payload && payload.usage;

      post({ type: 'responseSuccess', data: { content, usage } });
    } catch (rawError) {
      const err = rawError as AxiosError;
      let message: string;

      if (err.response) {
        // HTTP 响应错误（4xx/5xx）
        const status = err.response.status;
        const d: any = err.response.data;
        const detail =
          (d && d.error && d.error.message) ||
          (d && d.message) ||
          JSON.stringify(d).slice(0, 400);
        message = 'HTTP ' + status + ': ' + detail;
      } else if (err.request && !err.code) {
        // 请求已发出但无响应
        message = '网络连接失败：请求已发出但未收到服务器响应，请检查 baseUrl 或网络';
      } else if (err.code === 'ECONNABORTED') {
        message = '请求超时（>120s），请稍后重试或降低 max_tokens';
      } else if (err.code === 'ERR_NETWORK' || err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
        message = '网络错误(' + err.code + ')：无法连接到 ' + baseUrl + '，请检查地址或代理';
      } else {
        message = '请求失败：' + (err.message || String(rawError));
      }

      console.error('[DeepSeek Harness] API error:', err);
      vscode.window.showErrorMessage('API 调用失败: ' + message);
      post({ type: 'responseError', data: { message } });
    }
  }

  // ============== 4. 模板存储管理（globalState JSON 持久化） ==============

  /** 读取模板列表 */
  private _readTemplates(): PromptTemplate[] {
    const list = this._context.globalState.get<PromptTemplate[]>(STORAGE_KEY_TEMPLATES);
    return Array.isArray(list) ? list : [];
  }

  /** 保存模板列表 */
  private async _writeTemplates(list: PromptTemplate[]): Promise<void> {
    await this._context.globalState.update(STORAGE_KEY_TEMPLATES, list);
  }

  /** 新增一个模板 */
  private async _handleSaveTemplate(
    data: { name: string; systemPrompt: string; userPrompt: string; params: RequestParams },
    post: (msg: ExtensionMessage) => void,
  ): Promise<void> {
    const list = this._readTemplates();
    const tpl: PromptTemplate = {
      id: 'tpl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      name: (data.name && data.name.trim()) || ('未命名模板 ' + (list.length + 1)),
      systemPrompt: data.systemPrompt || '',
      userPrompt: data.userPrompt || '',
      params: data.params,
      createdAt: Date.now(),
    };
    list.unshift(tpl); // 新增的放最前
    await this._writeTemplates(list);
    post({ type: 'templateSaved', data: { id: tpl.id, name: tpl.name } });
    post({ type: 'templatesList', data: list });
    vscode.window.showInformationMessage('模板「' + tpl.name + '」已保存');
  }

  /** 拉取模板列表 */
  private async _handleLoadTemplates(post: (msg: ExtensionMessage) => void): Promise<void> {
    post({ type: 'templatesList', data: this._readTemplates() });
  }

  /** 根据 ID 加载单个模板内容 */
  private async _handleLoadTemplate(id: string, post: (msg: ExtensionMessage) => void): Promise<void> {
    const tpl = this._readTemplates().find((t) => t.id === id);
    if (tpl) {
      post({ type: 'templateLoaded', data: tpl });
    } else {
      post({ type: 'responseError', data: { message: '模板 ID ' + id + ' 不存在' } });
    }
  }

  /** 删除模板 */
  private async _handleDeleteTemplate(id: string, post: (msg: ExtensionMessage) => void): Promise<void> {
    const next = this._readTemplates().filter((t) => t.id !== id);
    await this._writeTemplates(next);
    post({ type: 'templateDeleted', data: { id } });
    post({ type: 'templatesList', data: next });
  }

  /**
   * 返回设置信息给 Webview
   * 注意：出于安全考虑，绝不把 apiKey 明文传回 Webview
   */
  private _handleGetSettings(post: (msg: ExtensionMessage) => void): void {
    const cfg = vscode.workspace.getConfiguration('deepseekHarness');
    const apiKey = (cfg.get<string>('apiKey') || '').trim();
    post({
      type: 'settingsInfo',
      data: {
        apiKeySet: !!apiKey,
        baseUrl: cfg.get<string>('baseUrl', 'https://api.deepseek.com'),
        defaultModel: cfg.get<string>('defaultModel', 'deepseek-chat'),
      },
    });
  }

  // ============== Webview HTML 加载 ==============

  /**
   * 从 src/webview/index.html 读取文件，替换占位符：
   *   {{NONCE}}       -> CSP 随机 nonce
   *   {{CSP_SOURCE}}  -> webview.cspSource
   * 避免在 TypeScript 模板字符串中内嵌 JS 导致反引号 / ${} 语法冲突
   */
  private _getHtmlForWebview(webview: vscode.Webview): string {
    const htmlPath = path.join(this._context.extensionPath, 'src', 'webview', 'index.html');
    let html: string;
    try {
      html = fs.readFileSync(htmlPath, 'utf-8');
    } catch (e) {
      const errMsg = '无法读取 webview 页面文件 ' + htmlPath + ': ' + String(e);
      console.error('[DeepSeek Harness]', errMsg);
      return (
        '<!DOCTYPE html><html><body style="color:#c00;padding:16px;font-family:sans-serif;">' +
        '<h2>DeepSeek Harness 加载失败</h2>' +
        '<pre>' + errMsg + '</pre>' +
        '</body></html>'
      );
    }

    const nonce = generateNonce();
    html = html.replace(/\{\{NONCE\}\}/g, nonce);
    html = html.replace(/\{\{CSP_SOURCE\}\}/g, webview.cspSource);
    return html;
  }
}

// ============== 工具函数 ==============

/** 生成 CSP 用的 32 位随机 nonce */
function generateNonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

// ============== 5. VSCode 生命周期 ==============

export function activate(context: vscode.ExtensionContext): void {
  const msg = '[DeepSeek Harness] 扩展激活成功 (Extension activated)';
  console.log(msg);
  // 调试阶段：弹出提示让用户明确感知扩展已加载（正式版可去掉）
  vscode.window.showInformationMessage(msg);

  // 注册侧边栏 webview 视图
  const provider = new DeepSeekHarnessViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      DeepSeekHarnessViewProvider.viewType,
      provider,
      {
        // 保持隐藏时不销毁，避免每次切换面板都重新初始化
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
  );
}

export function deactivate(): void {
  console.log('[DeepSeek Harness] deactivate');
}
