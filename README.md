# Hammerspoon 2 Spoons

为 [Hammerspoon 2](https://github.com/cmsj/Hammerspoon2) 写的一套 Spoon 插件。

Hammerspoon 2 是 macOS 上的自动化工具，Swift + JavaScriptCore 实现，
比一代（Hammerspoon 1）多了原生 Spaces、原生 Liquid Glass 界面、AX 观察者等能力。
本仓库插件均按二代的 API 重写。

## 插件

| Spoon | 说明 |
|---|---|
| [PaperWM](Spoons/PaperWM/) | 平铺窗口管理：自动排布、焦点导航、跨 Space 切换与移动 |
| [TogglePanel](Spoons/TogglePanel/) | 插件开关面板：实时启停各个 Spoon，无需重载配置 |
| [ResizeMouse](Spoons/ResizeMouse/) | ⌃⇧ 调整窗口大小 · ⌃⌥ 移动窗口 |
| [TextActions](Spoons/TextActions/) | 对选中文字执行清理、重排和中文符号包裹 |
| [WindowInspector](Spoons/WindowInspector/) | 检查当前聚焦窗口，并生成窗口排除规则 |
| [InputSourceSwitcher](Spoons/InputSourceSwitcher/) | 按当前应用自动切换中英文输入源 |
| [Notice](Spoons/Notice/) | 轻量提示条（原生 SwiftUI，不抢焦点），供其它插件调用 |

PaperWM 是从 Hammerspoon 1 的 PaperWM.spoon 完整移植。

## 安装

把 `Spoons/` 下的目录复制到 Hammerspoon 2 的配置目录：

```bash
cp -R Spoons/* ~/.config/Hammerspoon2/Spoons/
```

HS2主程序会自动加载配置，也可以在程序Console加载：

```js
const TogglePanel = hs.spoons.load("TogglePanel");
TogglePanel.start();
```

各插件的启停状态由 TogglePanel 记在 `hs.userdefaults` 里，
面板里（⌃⌥⌘K）可以随时开关，⌘0 一键全开/全关。

如果需要 PaperWM，额外加载并绑定热键（完整列表见
[Spoons/PaperWM/README.md](Spoons/PaperWM/README.md)）：

```js
const PaperWM = hs.spoons.load("PaperWM");
PaperWM.bindHotkeys({
    focus_left:  [["alt", "cmd"], "j"],
    focus_right: [["alt", "cmd"], "l"],
    // ...
});
PaperWM.start();
```

## 目录结构

```
.
├── Spoons/           ← 插件本体
├── init.js           ← 主配置入口的模板
├── LICENSE           ← MIT
└── upstream/         ← Hammerspoon 2 上游源码（参考与构建用，不进版本库）
```

`upstream/` 是一份完整的 Hammerspoon 2 仓库（保留了上游 git 历史，
可以随时 `git -C upstream pull` 更新），用来对照源码和本地构建。
它被 `.gitignore` 排除，不进本仓库的版本库。

## 致谢

- [Hammerspoon 2](https://github.com/cmsj/Hammerspoon2) —— 二代本体，MIT
- [PaperWM](https://github.com/mogenson/PaperWM.spoon) —— 平铺窗口管理的算法来源，MIT
- [PaperWM (GNOME)](https://github.com/paperwm/paperwm) —— 最初的 PaperWM 思路来源

## 许可证

MIT，见 [LICENSE](LICENSE)。

`upstream/` 目录内的 Hammerspoon 2 源码版权归原作者所有，
遵循其原有许可证，仅作参考与构建用途。
