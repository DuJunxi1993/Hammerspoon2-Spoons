// PaperWM — Hammerspoon 2 Spoon
//
// 平铺窗口管理（Tiling Window Manager）。
//
// 从 Hammerspoon v1 的 PaperWM.spoon 移植。二代没有 hs.window.filter
// 子模块，所以事件层整个换成了 hs.ax 的 AX 观察者；Space 操作则换成了
// Hammerspoon 2 原生的 Spaces 支持——v1 那套"开 Mission Control + 模拟
// 鼠标拖拽"的 440 行代码，在二代里一行都不需要了。
//
// ------------------------------------------------------------------
// 用法
// ------------------------------------------------------------------
//
//   const PaperWM = hs.spoons.load("PaperWM");
//   PaperWM.bindHotkeys({
//       focus_left:  [["alt", "cmd"], "j"],
//       focus_right: [["alt", "cmd"], "l"],
//       swap_left:   [["alt", "cmd", "shift"], "j"],
//       ...
//   });
//   PaperWM.start();
//
//   // 窗口排除规则（按应用名 / 按标题）
//   PaperWM.setAppFilter("Safari", { rejectTitles: ["^画中画$"] });
//   PaperWM.setBundleFilter("com.example.helper", true);
//
//   热键写法和 v1 的 Lua 写法不同：v1 用 { { "alt", "cmd" }, "j" }，
//   那是 Lua 的数组；JS 里对应的写法是 [["alt", "cmd"], "j"]。
//   也接受 { mods: ["alt", "cmd"], key: "j" } 这种对象写法。
//
// ------------------------------------------------------------------
// 与 v1 的差别
// ------------------------------------------------------------------
//
// · 事件层：v1 的 hs.window.filter 订阅 → 二代用 hs.ax 的 AX 观察者。
//   仍然是完全事件驱动的，没有轮询。
//
// · Space 操作：v1 要开 Mission Control 并模拟鼠标拖拽窗口（440 行，
//   而且经常失手）→ 二代直接 window.moveToSpace(space) / space.goto()。
//
// · 窗口移动：v1 需要 setFrame(frame, 0) 来禁用 200ms 的动画 → 二代
//   本来就没有动画，而且 Hammerspoon 2 会临时关掉应用的
//   AXEnhancedUserInterface，Chromium 系应用不会自己播动画。
//
// · 自身触发的问题：v1 靠"移动时停掉监听器、动画结束后再装回去"来避免
//   自己触发自己 → 二代记下"我们要求的 frame"，事件回来时比对，吻合就
//   忽略。少了一堆定时器。
//
// · 触摸板滑动手势：v1 用 hs.eventtap 的 gesture 事件（私有 API）。
//   Hammerspoon 2 没有暴露这个事件类型，所以这个功能没有移植——
//   v1 的默认配置里它本来就是关的（swipe_fingers = 0）。
//   要滑动整组窗口，用「按住修饰键 + 滚轮」或「按住修饰键 + 拖动」。

"use strict";

const { config, defaultRules, defaultBundleRules } = require("./lib/config");
const state = require("./lib/state");
const filter = require("./lib/filter");
const tiling = require("./lib/tiling");
const actions = require("./lib/actions");
const spaces = require("./lib/spaces");
const events = require("./lib/events");
const hotkeys = require("./lib/hotkeys");
const mouse = require("./lib/mouse");
const animate = require("./lib/animate");
const stack = require("./lib/stack");

const PaperWM = {
    name: "PaperWM",
    version: "2.0.0",
    author: "djx",
    description: "平铺窗口管理：自动排布、焦点导航、跨 Space 切换与移动",

    // 配置项直接挂在对象上，方便外部随时改（和 v1 一样）
    config: config,
};

// 把配置项铺到顶层，和 v1 的 PaperWM.window_gap 用法保持一致
for (const key of Object.keys(config)) {
    PaperWM[key] = config[key];
}

PaperWM.state = state;
PaperWM.filter = filter;
PaperWM.tiling = tiling;
PaperWM.actions = actions;
PaperWM.spaces = spaces;

/** 启动自动平铺 */
PaperWM.start = function () {
    if (state.started) return PaperWM;

    events.start();
    mouse.start();
    // 热键跟着 start/stop 走：在 TogglePanel 里关掉再打开，热键不会丢
    hotkeys.bindHotkeys(config.hotkeys);

    console.log("PaperWM: 已启动");
    return PaperWM;
};

/** 停止自动平铺 */
PaperWM.stop = function () {
    if (!state.started) return PaperWM;

    events.stop();
    mouse.stop();
    hotkeys.stopHotkeys();

    console.log("PaperWM: 已停止");
    return PaperWM;
};

/** 绑定热键（v1 的调用方式） */
PaperWM.bindHotkeys = function (mapping) {
    hotkeys.bindHotkeys(mapping);
    return PaperWM;
};

PaperWM.stopHotkeys = function () {
    hotkeys.stopHotkeys();
    return PaperWM;
};

/** 立刻重新排布当前 Space */
PaperWM.refreshWindows = function () {
    events.rebuildSpace(tiling.currentSpaceId());
    return PaperWM;
};

/** 打印当前布局 */
PaperWM.dumpState = function () {
    hotkeys.dumpState();
    return PaperWM;
};

/** 按应用名设置排除规则 */
PaperWM.setAppFilter = function (appName, rules) {
    filter.setAppFilter(appName, rules);
    PaperWM.refreshWindows();
    return PaperWM;
};

/** 排除某个应用的全部窗口 */
PaperWM.rejectApp = function (appName) {
    filter.rejectApp(appName);
    PaperWM.refreshWindows();
    return PaperWM;
};

/** 按 Bundle ID 排除整个进程的窗口 */
PaperWM.setBundleFilter = function (bundleID, reject) {
    filter.setBundleFilter(bundleID, reject);
    PaperWM.refreshWindows();
    return PaperWM;
};

/** 只平铺指定显示器上的窗口（传 null 恢复全部） */
PaperWM.setScreens = function (names) {
    filter.setScreens(names);
    PaperWM.refreshWindows();
    return PaperWM;
};

/** 恢复默认的排除规则 */
PaperWM.resetRules = function () {
    filter.resetRules();
    PaperWM.refreshWindows();
    return PaperWM;
};

/** 切换窗口的浮动状态 */
PaperWM.toggleFloating = function (win) {
    actions.toggleFloating(win);
    return PaperWM;
};

/** 切换焦点窗口所在列的手风琴叠放 */
PaperWM.toggleStack = function () {
    actions.toggleStack();
    return PaperWM;
};

/** 把焦点窗口和左边的列各占一半屏幕 */
PaperWM.splitScreen = function () {
    actions.splitScreen();
    return PaperWM;
};

/** 把焦点窗口贴到画布的左/右边缘 */
PaperWM.anchorWindow = function (direction) {
    actions.moveToSideEdge(direction);
    return PaperWM;
};

/** 当前的列结构（调试用） */
Object.defineProperty(PaperWM, "layout", {
    get() {
        const result = {};
        for (const [spaceId, columns] of state.columns) {
            result[spaceId] = columns.map((column) => column.map((w) => ({
                id: w.id,
                title: w.title,
            })));
        }
        return result;
    },
});

// Spoon 的入口：init() 在每次 hs.spoons.load() 时都会被调用，必须幂等。
module.exports = {
    name: "PaperWM",
    version: "2.0.0",
    author: "djx",
    description: "平铺窗口管理：自动排布、焦点导航、跨 Space 切换与移动",

    init() {
        // 什么都不用做——所有状态都在 lib/ 里，且是惰性的
    },

    start: PaperWM.start,
    stop: PaperWM.stop,
    bindHotkeys: PaperWM.bindHotkeys,
    stopHotkeys: PaperWM.stopHotkeys,
    refreshWindows: PaperWM.refreshWindows,
    dumpState: PaperWM.dumpState,
    setAppFilter: PaperWM.setAppFilter,
    rejectApp: PaperWM.rejectApp,
    setBundleFilter: PaperWM.setBundleFilter,
    setScreens: PaperWM.setScreens,
    resetRules: PaperWM.resetRules,
    toggleFloating: PaperWM.toggleFloating,
    toggleStack: PaperWM.toggleStack,
    splitScreen: PaperWM.splitScreen,
    anchorWindow: PaperWM.anchorWindow,

    get config() { return config; },
    get layout() { return PaperWM.layout; },
    get state() { return state; },
    get actions() { return actions; },
    get spaces() { return spaces; },
    get tiling() { return tiling; },
    get filter() { return filter; },
    get hotkeys() { return hotkeys; },
    get animate() { return animate; },
    get stack() { return stack; },
};
