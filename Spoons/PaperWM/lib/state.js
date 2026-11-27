// PaperWM — 状态
//
// v1 用 Lua 的 table + 元表模拟二维/三维数组（window_list[space][col][row]）。
// 二代直接用 Map 和普通数组，不需要那些元表技巧。
//
// 布局结构：
//   columns : Map<spaceId, Array<Array<HSWindow>>>
//             每个 Space 一份；外层是"列"，每列里是上下堆叠的窗口。
//   index   : Map<windowId, {space, col, row}>
//             窗口在布局里的位置，用于 O(1) 查找。
//   xPositions : Map<spaceId, Map<windowId, number>>
//             窗口的"虚拟 X 坐标"——拖动/滑动时窗口会整体移出屏幕，
//             这时真实 frame 已经没有意义了，靠虚拟坐标维持相对位置。

"use strict";

const state = {
    // ---- 布局 ----
    columns: new Map(),       // spaceId -> Array<Array<HSWindow>>
    index: new Map(),         // windowId -> { space, col, row }
    xPositions: new Map(),    // spaceId -> Map<windowId, number>

    // ---- 手风琴叠放（stacked columns）----
    //
    // 每一列可以切换成"手风琴"：列里的窗口叠在一起，每个只露出一点标题栏。
    //
    // v1 把这个标记直接挂在列的 table 上（Lua 的 table 可以随便加字段），
    // 交换/slurp/barf 的时候跟着列一起走。JS 的数组挂不了额外字段，
    // 所以这里用一张平行的表：spaceId -> (col -> { stacked, activeRow })。
    // 列移动的时候要同步搬这里的记录。
    stacks: new Map(),        // spaceId -> Map<col, { stacked, activeRow }>

    // ---- 窗口 ----
    tracked: new Map(),       // windowId -> HSWindow
    floating: new Set(),      // windowId（浮动窗口不参与平铺）

    // 弹出式窗口（文件选择面板、sheet、模态框……）的 id。
    // 它们也是浮动窗口，但和用户手动设的浮动窗口要分开：
    //   · 用户设的会存进 userdefaults，下次启动还在
    //   · 弹出式的用完就没了，不该存
    transient: new Set(),


    // ---- 期望位置 ----
    // 我们自己改动窗口位置后，AX 会回报一个 windowMoved/windowResized 事件。
    // 记下"我们要求的 frame"，事件到来时比对，吻合就忽略——
    // 这是避免自己触发自己、无限重排的关键。
    expected: new Map(),      // windowId -> { x, y, w, h }

    // ---- 观察者 ----
    windowWatchers: new Map(),   // windowId -> { element, listener }
    appWatchers: new Map(),      // pid -> listener
    screenListeners: null,       // hs.screen.on 的清理函数
    appLaunchListener: null,     // hs.application.on('didLaunch') 的处理函数
    appTerminateListener: null,  // hs.application.on('didTerminate') 的处理函数
    appActivateListener: null,   // hs.application.on('didActivate') 的处理函数

    // ---- 其它 ----
    prevFocused: null,        // 上一个获得焦点的窗口
    lastFocusedId: null,      // 最近一次触发过"布局跟随焦点"的窗口 id
    anchors: new Map(),       // spaceId -> windowId（该 Space 当前的锚点窗口）
    retileTimers: new Map(),  // spaceId -> hs.timer（重排的防抖计时器）
    recentSpaces: [],         // 最近去过的 Space id（新的在前）
    started: false,
    tiling: false,           // 正在下发布局
};

module.exports = state;
