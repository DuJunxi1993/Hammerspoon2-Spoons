// PaperWM — 配置
//
// 这里的取值对应 v1 时代 init.lua 里的设置，改动直接生效（不需要重载）。
//
// 窗口排除规则来自 v1 init.lua 里的那一大段 setAppFilter 调用，
// 原本靠 hs.window.filter 的应用级过滤实现。二代没有 hs.window.filter
// 子模块，过滤是一个普通函数，所以规则收在这里。

"use strict";

// 窗口间距：数字表示四边相同，也可以给 {top, bottom, left, right}
const DEFAULT_GAP = 8;

const config = {
    // 窗口之间的缝隙
    windowGap: 5,

    // 屏幕边缘留白：macOS 不允许窗口完全移出屏幕，超出的部分堆在边缘，
    // 留白越大越不容易被挤出屏幕
    screenMargin: 5,

    // 切换 Space 后是否把鼠标移到屏幕中央
    centerMouse: false,

    // 循环调整窗口宽/高时依次使用的比例
    windowRatios: [1 / 3, 1 / 2, 2 / 3],

    // 外部菜单栏占用的空间（给第三方菜单栏留位置）
    // 例如 { top: 25 }
    externalBar: null,

    // 过渡动画
    //
    // v1 是瞬移的（它专门把 macOS 的窗口动画关掉了，因为一次动好几个
    // 窗口时动画会乱）。这里反过来——自己实现补间动画，让窗口"滑"过去。
    //
    // 全部动画共用一个定时器，每帧推进一次，窗口多也不太费。
    animation: true,

    // 动画时长（秒）。0.18 左右接近系统窗口动画的观感。
    animationDuration: 0.18,

    // 新窗口的默认宽度（屏幕宽度的比例）
    defaultWidth: 0.5,

    // 按应用指定新窗口宽度（覆盖 defaultWidth）。
    // 键是应用显示名或 Bundle ID，值是比例。
    appWidths: {},

    // 有些应用明明能平铺，却报告"不可最大化"。
    // 这时可以把它的窗口 id 写进来（或者写成一个返回 true 的函数）。
    allowNonMaximizableWindow: null,

    // ---- 弹出式窗口 ----
    //
    // 文件选择面板（open-panel）、sheet、模态框这类临时窗口一出现，
    // 就不该动现有的平铺布局——它们会被当成浮动窗口跟随。
    //
    // 弹出的窗口默认按 AX 属性自动识别。除此之外用户还可以自己加规则：
    //
    //   panelRules: [
    //       { app: "某个应用", title: "^设置$" },   // 强制当成弹出窗口
    //   ],
    //   panelWhiteList: [
    //       { app: "另一个应用", title: "^我的面板$" },  // 强制当成普通窗口平铺
    //   ],
    //
    // 规则形如 { app?, title? }：
    //   app   —— 应用显示名（不区分大小写），省略表示不限应用
    //   title —— 标题正则（"/.../i" 写法）或普通字符串，省略表示不限标题
    //
    // 白名单优先级最高：命中的窗口一定是普通窗口，一定参与平铺。
    panelRules: [],

    // 弹出式窗口白名单：命中的窗口即使长得像弹出面板，也照样平铺。
    panelWhiteList: [],

    // 焦点走到两端时是否循环（从最左往左跳到最右）
    infiniteLoopWindow: false,

    // 切换 Space 时是否保留当前应用的前台状态
    preserveAppFocus: false,

    // 用 move_window_N 把窗口移到别的 Space 之后，是否留在当前 Space
    // （false = 跟着窗口过去）
    moveWindowKeepSpace: false,

    // 列的布局方式："tiled"（等分）还是 "stacked"（手风琴式叠放）
    columnLayout: "tiled",

    // 手风琴叠放时，每个折叠起来的窗口露出多少标题栏（像素）
    accordionPeek: 36,

    // 手风琴叠放时，窗口高度的下限（再矮就没法用了）
    stackMinHeight: 150,

    // 按住这些修饰键 + 拖动鼠标：整组窗口左右滑动
    dragWindow: ["alt", "cmd"],

    // 按住这些修饰键 + 点击窗口：把窗口从平铺中"抬"出来变成浮动窗口
    liftWindow: ["alt", "cmd", "shift"],

    // 按住这些修饰键 + 滚轮：整组窗口左右滑动
    scrollWindow: null,

    // 滚轮滑动时每一格移动多少像素
    scrollGain: 10,

    // 帧位置比较的容差（px）：窗口位置落在容差内就认为是我们自己动的
    frameEpsilon: 2,

    // 浮动窗口列表的持久化键
    floatingKey: "paperwm.floatingWindows",

    // 热键表（沿用 v1 init.lua 里的分配）。
    // 写法是 JS 的数组形式：[[修饰键...], 键名]。
    // 也可以在加载后调用 PaperWM.bindHotkeys({...}) 覆盖。
    hotkeys: {
        // 焦点移动
        focus_left: [["alt", "cmd"], "j"],
        focus_right: [["alt", "cmd"], "l"],
        focus_up: [["alt", "cmd"], "i"],
        focus_down: [["alt", "cmd"], "k"],
        focus_prev: [["alt", "cmd"], "k"],
        focus_next: [["alt", "cmd"], "j"],

        // 交换窗口
        swap_left: [["alt", "cmd", "shift"], "j"],
        swap_right: [["alt", "cmd", "shift"], "l"],
        swap_up: [["alt", "cmd", "shift"], "i"],
        swap_down: [["alt", "cmd", "shift"], "k"],

        // 窗口尺寸与位置
        center_window: [["alt", "cmd"], "h"],
        anchor_window_left: [["ctrl", "alt", "cmd"], ","],
        anchor_window_right: [["ctrl", "alt", "cmd"], "."],
        full_width: [["alt", "cmd"], "f"],
        cycle_width: [["alt", "cmd"], "r"],
        cycle_height: [["alt", "cmd", "shift"], "r"],
        reverse_cycle_width: [["ctrl", "alt", "cmd"], "r"],
        reverse_cycle_height: [["ctrl", "alt", "cmd", "shift"], "r"],
        increase_width: [["alt", "cmd"], "o"],
        decrease_width: [["alt", "cmd"], "u"],

        // 列的拆分与合并
        slurp_in: [["alt", "cmd"], "y"],
        barf_out: [["alt", "cmd", "shift"], "y"],
        toggle_stack: [["alt", "cmd", "shift"], "s"],
        split_screen: [["alt", "cmd"], "s"],

        // 浮动窗口
        toggle_floating: [["alt", "cmd"], "p"],
        focus_floating: [["alt", "cmd", "shift"], "f"],

        // 切换 Space
        switch_space_l: [["alt", "cmd"], ","],
        switch_space_r: [["alt", "cmd"], "."],
        switch_recent_space: [["ctrl", "alt", "cmd"], "6"],
        switch_space_1: [["alt", "cmd"], "1"],
        switch_space_2: [["alt", "cmd"], "2"],
        switch_space_3: [["alt", "cmd"], "3"],
        switch_space_4: [["alt", "cmd"], "4"],
        switch_space_5: [["alt", "cmd"], "5"],
        switch_space_6: [["alt", "cmd"], "6"],
        switch_space_7: [["alt", "cmd"], "7"],
        switch_space_8: [["alt", "cmd"], "8"],
        switch_space_9: [["alt", "cmd"], "9"],

        // 聚焦第 n 个窗口
        focus_window_1: [["cmd", "shift"], "1"],
        focus_window_2: [["cmd", "shift"], "2"],
        focus_window_3: [["cmd", "shift"], "3"],
        focus_window_4: [["cmd", "shift"], "4"],
        focus_window_5: [["cmd", "shift"], "5"],
        focus_window_6: [["cmd", "shift"], "6"],
        focus_window_7: [["cmd", "shift"], "7"],
        focus_window_8: [["cmd", "shift"], "8"],
        focus_window_9: [["cmd", "shift"], "9"],
        focus_window_first: [["cmd", "shift"], "home"],
        focus_window_last: [["cmd", "shift"], "end"],

        // 把窗口移到第 n 个 Space
        move_window_1: [["alt", "cmd", "shift"], "1"],
        move_window_2: [["alt", "cmd", "shift"], "2"],
        move_window_3: [["alt", "cmd", "shift"], "3"],
        move_window_4: [["alt", "cmd", "shift"], "4"],
        move_window_5: [["alt", "cmd", "shift"], "5"],
        move_window_6: [["alt", "cmd", "shift"], "6"],
        move_window_7: [["alt", "cmd", "shift"], "7"],
        move_window_8: [["alt", "cmd", "shift"], "8"],
        move_window_9: [["alt", "cmd", "shift"], "9"],

        // 把窗口移到相邻显示器的 Space 上
        move_window_l: [["ctrl", "alt", "cmd"], "left"],
        move_window_r: [["ctrl", "alt", "cmd"], "right"],
        move_window_u: [["ctrl", "alt", "cmd"], "up"],
        move_window_d: [["ctrl", "alt", "cmd"], "down"],

        // 维护
        refresh_windows: [["alt", "cmd", "shift"], "r"],
        refresh_windows_forcedly: [["alt", "cmd", "shift"], "t"],
        dump_state: [["alt", "cmd", "shift"], "d"],
    },
};

// ---------------------------------------------------------------- 窗口排除规则
//
// 每条规则针对一个应用（按显示名匹配），rejectTitles 里的每条是一个
// 正则字符串，匹配窗口标题就排除该窗口（标题为 null 的窗口不受影响）。
//
// 说明：v1 用的是 Lua 模式（^...$），这里换成 JS 正则字符串。
// v1 的 "^画中画$" 这种写法在这里要写成 "/^画中画$/" 或者直接用
// "^画中画$"（下面两种写法都支持）。

const defaultRules = {
    // Hammerspoon 自己的控制台不该被平铺
    "Hammerspoon": {
        rejectTitles: ["^Hammerspoon Console$", "^Console$", "^控制台$"],
    },
    // Finder 的简介窗口
    "Finder": {
        rejectTitles: ["^简介$", "^Info$"],
    },
    "访达": {
        rejectTitles: ["^简介$", "^Info$"],
    },
    // 微信的图片预览、通话窗口
    "WeChat": {
        rejectTitles: ["^图片和视频$", "^图片预览$", "^Image Preview$",
                       "^视频通话$", "^Video Call$", "^语音通话$", "^Audio Call$"],
    },
    "微信": {
        rejectTitles: ["^图片和视频$", "^图片预览$", "^Image Preview$",
                       "^视频通话$", "^Video Call$", "^语音通话$", "^Audio Call$"],
    },
    // 浏览器的画中画小窗
    "Safari": {
        rejectTitles: ["^画中画$", "^Picture in Picture$", "^Picture-in-Picture$"],
    },
    "Safari浏览器": {
        rejectTitles: ["^画中画$", "^Picture in Picture$", "^Picture-in-Picture$"],
    },
    "Google Chrome": {
        rejectTitles: ["^画中画$", "^Picture in Picture$", "^Picture-in-Picture$"],
    },
    "Microsoft Edge": {
        rejectTitles: ["^画中画$", "^Picture in Picture$", "^Picture-in-Picture$"],
    },
    "Arc": {
        rejectTitles: ["^画中画$", "^Picture in Picture$", "^Picture-in-Picture$"],
    },
    "Brave Browser": {
        rejectTitles: ["^画中画$", "^Picture in Picture$", "^Picture-in-Picture$"],
    },
    // 音乐 App 的迷你播放条
    "音乐": {
        rejectTitles: ["^迷你播放器$", "^MiniPlayer$", "^Mini Player$"],
    },
    "Music": {
        rejectTitles: ["^迷你播放器$", "^MiniPlayer$", "^Mini Player$"],
    },
    "网易云音乐": {
        rejectTitles: ["^迷你播放器$", "^MiniPlayer$", "^Mini Player$"],
    },
    "NeteaseMusic": {
        rejectTitles: ["^迷你播放器$", "^MiniPlayer$", "^Mini Player$"],
    },
    // Clash Verge
    "Clash Verge": {
        rejectTitles: ["^Clash Verge$"],
    },
};

// 按 Bundle ID 排除整个进程产生的窗口
const defaultBundleRules = {
    // 快捷指令的对话框宿主：它自己会弹一个窗口，不该被平铺
    "com.apple.WorkflowKit.ShortcutsViewService": true,
};

module.exports = {
    config,
    defaultRules,
    defaultBundleRules,
    DEFAULT_GAP,
};
