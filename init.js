// Hammerspoon 2 配置
//
// 这个文件在启动时加载，也可以从菜单栏图标选 "Reload Config" 重新加载。
//
// 完整 API 文档：https://www.hammerspoon.org/2/
// 也可以随时在 Hammerspoon Console 里执行：hs.docs.show()
//
// ------------------------------------------------------------------
// 目录结构
// ------------------------------------------------------------------
// Spoons/ 下是各个插件（每个插件一个目录，含 spoon.json 与 init.js）：
//
//   TogglePanel         插件开关面板，兼作总开关（⌃⌥⌘K）
//   PaperWM             平铺窗口管理
//   ResizeMouse         ⌃⇧ 调整窗口大小 · ⌃⌥ 移动窗口
//   TextActions         文字操作（⌃⌥⌘T）
//   WindowInspector     窗口检查（⌃⌥⌘I）
//   InputSourceSwitcher 按应用自动切换中英文输入源
//   Notice              轻量提示条，供其它插件调用
//
// 每个插件的启停状态由 TogglePanel 记在 hs.userdefaults 里，
// 所以这里只需要把 TogglePanel 拉起来——它会把其余插件按保存的状态带起来。
//
// 想改成自己控制，也完全可以逐个加载：
//
//   const ResizeMouse = hs.spoons.load("ResizeMouse");
//   ResizeMouse.start();
//
// ------------------------------------------------------------------
// PaperWM
// ------------------------------------------------------------------
//
// 平铺窗口管理默认不开——它会改变所有窗口的位置，想用的时候在
// TogglePanel 面板里打开就行（⌃⌥⌘K）。
//
// 热键表在 PaperWM 自己的配置里（Spoons/PaperWM/lib/config.js 的
// config.hotkeys），沿用 v1 init.lua 里的分配。想改就改那个文件，
// 或者在加载后调用 PaperWM.bindHotkeys({...}) 覆盖。
//
// 热键写法：v1 的 Lua 用 { { "alt", "cmd" }, "j" }，
// JS 里对应 [["alt", "cmd"], "j"]。

"use strict";

// 注意：一定要把返回值存进一个活着的变量，否则下一次垃圾回收之后
// 插件就悄悄不工作了。
const TogglePanel = hs.spoons.load("TogglePanel");
TogglePanel.start();

// 打开 IPC 通道，这样就能用 hs2 命令行工具在终端里跟 Hammerspoon 说话：
//   hs2 --no-prompt -e 'hs.window.focusedWindow()'
// 想关掉的话，删掉下面这一行就行。
hs.ipc.start();

console.log("Hammerspoon 2 配置已加载。⌃⌥⌘K 打开插件开关面板。");
