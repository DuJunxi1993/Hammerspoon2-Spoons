// PaperWM — 事件
//
// v1 靠 hs.window.filter 的订阅拿到窗口事件：
//   windowFocused / windowVisible / windowNotVisible /
//   windowFullscreened / windowUnfullscreened / windowDestroyed
// 这是原生的、事件驱动的，很好。
//
// 二代没有 hs.window.filter 子模块。取而代之的是 hs.ax 的 AX 观察者，
// 同样是原生、事件驱动的，只是不那么"一条龙"：
//
//   · 每个应用挂一个 AX 观察者，收 windowCreated / focusedWindowChanged /
//     mainWindowChanged / windowMiniaturized / windowDeminiaturized
//   · 每个受管窗口挂一个 AX 观察者，收 windowMoved / windowResized /
//     uIElementDestroyed
//   · hs.screen 的 spaceChange / change 事件
//
// 全部是回调驱动的，没有轮询。

"use strict";

const state = require("./state");
const { config } = require("./config");
const filter = require("./filter");
const ax = require("./ax");
const tiling = require("./tiling");
const actions = require("./actions");
const animate = require("./animate");
const spaces = require("./spaces");

// 重排的防抖时长（秒）：一次事件风暴里只排一次版
const RETILE_DEBOUNCE = 0.06;

// ---------------------------------------------------------------- 工具

function log(...args) {
    console.log.apply(console, ["PaperWM:"].concat(args));
}

/** 窗口被我们自己的布局改动过吗？（是的话忽略这次事件） */
function isSelfInflicted(winId, actualFrame) {
    return tiling.consumeExpected(winId, actualFrame);
}

/**
 * 重新排布某个 Space。
 *
 * 用"尾部防抖"：一次事件风暴（比如一次拖拽带来的几十个 AX 事件）
 * 只会真正排一次版，而且排的是最后那一刻的状态。
 */
function retile(spaceId) {
    if (spaceId == null) return;

    const existing = state.retileTimers.get(spaceId);
    if (existing) existing.stop();

    const timer = hs.timer.doAfter(RETILE_DEBOUNCE, () => {
        state.retileTimers.delete(spaceId);
        tiling.tileSpace(spaceId);
    });
    state.retileTimers.set(spaceId, timer);
}

/**
 * 焦点变了 → 布局跟着动。
 *
 * 这是 PaperWM 的核心手感之一，也是 v1 的 windowFocused 事件做的事：
 * 焦点窗口成为新的锚点，被夹回屏幕可见范围内，其余窗口随之左右滑动，
 * 就像 niri 那样"前台窗口总是看得见"。
 *
 * v1 里这一步是隐含在 hs.window.filter 的 windowFocused 订阅里的；
 * 二代没有 window.filter，得自己接上。
 */
function focusFollows(win) {
    if (!win) return;
    if (state.floating.has(win.id)) return;      // 浮动窗口不参与平铺
    const index = state.index.get(win.id);
    if (!index) return;                          // 还没纳管
    if (state.lastFocusedId === win.id) return;  // 焦点没变，别白干一场

    state.lastFocusedId = win.id;
    retile(index.space);
}

// ---------------------------------------------------------------- 窗口级观察者

/**
 * 给一个窗口挂上 AX 观察者。
 * @param {object} win HSWindow
 */
function watchWindow(win) {
    if (!win || state.windowWatchers.has(win.id)) return;

    let element;
    try {
        element = hs.ax.windowElement(win);
    } catch (err) {
        return;
    }
    if (!element) return;

    const listener = (notification, element) => {
        switch (notification) {
        case ax.SHORT.windowMoved:
        case ax.SHORT.windowResized: {
            if (state.floating.has(win.id)) return;
            const frame = element.frame;
            const actual = frame ? frame.toJSON() : null;

            // 正在做补间动画：窗口的移动是我们自己造成的，忽略。
            // 但如果偏得太多，说明用户真的在拖它——那就取消动画，
            // 把控制权交回去。
            if (animate.isAnimating(win.id)) {
                if (!animate.deviated(win.id, actual)) return;
                animate.cancel(win.id);
            }

            if (isSelfInflicted(win.id, actual)) return;

            // 用户自己拖动了窗口 → 重新排布
            const index = state.index.get(win.id);
            if (index) retile(index.space);
            break;
        }
        case ax.SHORT.uIElementDestroyed: {
            // 窗口被关掉了
            state.windowWatchers.delete(win.id);
            if (state.floating.has(win.id)) {
                state.floating.delete(win.id);
                actions.persistFloating();
                return;
            }
            const index = state.index.get(win.id);
            if (!index) return;
            const spaceId = actions.removeWindow(win, false);
            if (spaceId != null) tiling.tileSpace(spaceId);
            break;
        }
        default:
            break;
        }
    };

    // 逐个注册，不要用数组：
    // hs.ax.on() 传数组时是"全有或全无"的——只要有一个通知不被支持，
    // 已经注册的那些也会被撤销。窗口元素不一定支持全部通知，
    // 所以必须一个一个来。
    const notifications = [
        ax.RAW.windowMoved,
        ax.RAW.windowResized,
        ax.RAW.uIElementDestroyed,
    ];
    const registered = registerNotifications(element, notifications, listener);
    if (registered.length === 0) return;

    state.windowWatchers.set(win.id, { element, listener, notifications: registered });
}

/**
 * 逐个注册 AX 通知。
 *
 * 不能用 hs.ax.on(element, [a, b, c], fn)：数组形式是全有或全无的，
 * 一个通知不被支持就会把已经注册的全撤销掉。所以这里一个一个注册，
 * 失败的那个跳过就行。
 *
 * @returns {string[]} 成功注册的通知名
 */
function registerNotifications(element, notifications, listener) {
    const registered = [];
    for (const notification of notifications) {
        try {
            hs.ax.on(element, notification, listener);
            registered.push(notification);
        } catch (err) {
            // 这个通知不被支持，跳过
        }
    }
    return registered;
}

/** 取消窗口的观察者 */
function unwatchWindow(winId) {
    const entry = state.windowWatchers.get(winId);
    if (!entry) return;
    try {
        for (const notification of entry.notifications || []) {
            hs.ax.off(entry.element, notification, entry.listener);
        }
    } catch (err) {
        // 窗口已经没了，off 会失败——不影响
    }
    state.windowWatchers.delete(winId);
}

// ---------------------------------------------------------------- 应用级观察者

/**
 * 给一个应用挂上 AX 观察者，收窗口创建/焦点变化。
 * @param {object} app HSApplication
 */
function watchApplication(app) {
    if (!app || state.appWatchers.has(app.pid)) return;

    let element;
    try {
        element = app.axElement();
    } catch (err) {
        return;
    }
    if (!element) return;

    const listener = (notification, element) => {
        switch (notification) {
        case ax.SHORT.windowCreated: {
            // 新窗口：把这个应用还没纳管的窗口都加进来
            adoptNewWindows(app);
            break;
        }
        case ax.SHORT.focusedWindowChanged:
        case ax.SHORT.mainWindowChanged: {
            const focused = hs.window.focusedWindow();
            if (focused) {
                const wasManaged = state.index.has(focused.id);
                state.prevFocused = focused;

                if (!wasManaged && !state.floating.has(focused.id)) {
                    // 新获得焦点但还没纳管（例如从浮动变平铺）
                    const spaceId = actions.addWindow(focused);
                    if (spaceId != null) tiling.tileSpace(spaceId);
                } else {
                    // 焦点换到别的窗口 → 布局跟着动，
                    // 把焦点窗口带回屏幕可见范围
                    focusFollows(focused);
                }
            }
            break;
        }
        case ax.SHORT.windowMiniaturized: {
            const index = state.index.get(windowIdOf(element));
            if (index) retile(index.space);
            break;
        }
        default:
            break;
        }
    };

    // 逐个注册（理由同 watchWindow：数组形式是全有或全无的）
    const notifications = [
        ax.RAW.windowCreated,
        ax.RAW.focusedWindowChanged,
        ax.RAW.mainWindowChanged,
    ];
    const registered = registerNotifications(element, notifications, listener);
    if (registered.length === 0) return;

    state.appWatchers.set(app.pid, { listener, notifications: registered });
}

/** 从 AX 元素反查窗口 id（用标题+位置匹配，够用了） */
function windowIdOf(element) {
    const title = element.title;
    const frame = element.frame;
    if (!title || !frame) return null;

    for (const win of hs.window.allWindows()) {
        if (win.title !== title) continue;
        const wf = win.frame;
        if (!wf) continue;
        if (Math.abs(wf.x - frame.x) < 3 && Math.abs(wf.y - frame.y) < 3) return win.id;
    }
    return null;
}

/**
 * 把某个应用里新出现的窗口纳入布局。
 * 做法是拿这个应用当前的窗口列表，和我们已经跟踪的做差。
 */
function adoptNewWindows(app) {
    let windows;
    try {
        windows = hs.window.windowsForApp(app);
    } catch (err) {
        return;
    }
    if (!windows) return;

    let spaceId = null;
    for (const win of windows) {
        if (state.index.has(win.id) || state.floating.has(win.id)) continue;
        if (!filter.isAllowed(win)) continue;
        const added = actions.addWindow(win);
        if (added != null) {
            spaceId = added;
            watchWindow(win);
        }
    }

    if (spaceId != null) tiling.tileSpace(spaceId);
}

/** 取消应用的观察者 */
function unwatchApplication(pid) {
    const entry = state.appWatchers.get(pid);
    if (!entry) return;
    // AX 观察者在应用退出时会自动清理，这里只清自己的记录
    state.appWatchers.delete(pid);
}

// ---------------------------------------------------------------- 屏幕 / Space

function watchScreens() {
    const onSpaceChange = (details) => {
        // 切到了别的 Space：把那个 Space 的布局重建一遍
        const space = details && details.to;
        if (!space) return;
        spaces.noteSpace(space.id);
        rebuildSpace(space.id);
    };

    const onChange = () => {
        rebuildSpace(tiling.currentSpaceId());
    };

    hs.screen.on("spaceChange", onSpaceChange);
    hs.screen.on("change", onChange);

    state.screenListeners = () => {
        hs.screen.off("spaceChange", onSpaceChange);
        hs.screen.off("change", onChange);
    };
}

/**
 * 重建某个 Space 的布局：扫描当前所有窗口，把属于这个 Space 的纳入布局。
 *
 * 已经排好的列会被保留（窗口回到原来那一列），只有新出现的窗口才会
 * 插进来——插在哪里按它当前的水平位置决定，这样从别的 Space 切回来时
 * 顺序不会乱。
 */
function rebuildSpace(spaceId) {
    if (spaceId == null) return;

    const windows = filter.managedWindows();
    const columns = tiling.columnsFor(spaceId);

    // 记下原来的列结构，作为"放回原位"的依据
    const previous = columns.map((column) => column.slice());

    // 这个 Space 上的窗口，按水平位置排序（没有位置信息的排最后）
    const onSpace = [];
    for (const win of windows) {
        if (state.floating.has(win.id)) continue;
        const spaces = win.spaces;
        if (!spaces.some((s) => s.id === spaceId)) continue;
        onSpace.push(win);
    }
    onSpace.sort((a, b) => {
        const fa = a.frame;
        const fb = b.frame;
        if (!fa || !fb) return 0;
        return (fa.x + fa.w / 2) - (fb.x + fb.w / 2);
    });

    // 已经在旧列里的窗口，回到原来的列；新窗口按位置插入
    const newColumns = [];
    const columnOf = new Map();   // windowId -> 该窗口所在的新列

    for (const win of onSpace) {
        let target = -1;
        for (let col = 0; col < previous.length; col++) {
            if (previous[col].some((w) => w.id === win.id)) {
                target = col;
                break;
            }
        }

        if (target >= 0) {
            // 沿用原来的列号
            while (newColumns.length <= target) newColumns.push([]);
            newColumns[target].push(win);
            columnOf.set(win.id, target);
        } else {
            // 新窗口：插到它当前水平位置所对应的列里
            const frame = win.frame;
            let insertAt = newColumns.length;
            if (frame) {
                const center = frame.x + frame.w / 2;
                for (let col = 0; col < newColumns.length; col++) {
                    const first = newColumns[col][0];
                    const otherFrame = first && first.frame;
                    if (!otherFrame) continue;
                    if (center < otherFrame.x + otherFrame.w / 2) {
                        insertAt = col;
                        break;
                    }
                }
            }
            newColumns.splice(insertAt, 0, [win]);
            // 插入之后，后面的列号都变了
            for (const [id, col] of columnOf) {
                if (col >= insertAt) columnOf.set(id, col + 1);
            }
            columnOf.set(win.id, insertAt);
        }
    }

    // 去掉空列
    for (let i = newColumns.length - 1; i >= 0; i--) {
        if (!newColumns[i] || newColumns[i].length === 0) newColumns.splice(i, 1);
    }

    // 换掉旧的列结构，并把索引表里属于这个 Space 的条目清掉重建
    columns.length = 0;
    for (const column of newColumns) columns.push(column);

    for (const [winId, index] of [...state.index]) {
        if (index.space === spaceId) state.index.delete(winId);
    }
    actions.reindex(spaceId);

    for (const column of columns) {
        for (const win of column) {
            state.tracked.set(win.id, win);
            watchWindow(win);
        }
    }

    tiling.tileSpace(spaceId);
}

// ---------------------------------------------------------------- 启动 / 停止

function start() {
    if (state.started) return;
    state.started = true;

    actions.restoreFloating();

    // 监听所有正在运行的应用
    for (const app of hs.application.runningApplications()) {
        watchApplication(app);
    }

    // 新启动的应用也要监听
    const onLaunch = (app) => {
        if (!app) return;
        // 应用刚起来，AX 元素可能还拿不到，稍后再试
        hs.timer.doAfter(0.5, () => watchApplication(app));
    };
    const onTerminate = (app) => {
        if (app) unwatchApplication(app.pid);
    };

    // 前台应用换了 → 焦点多半也换了 → 布局跟着动。
    //
    // 这是 AX 观察者的补：有些应用不接受 AX 观察（注册时会报
    // kAXErrorCannotComplete），这类应用就靠 NSWorkspace 的应用激活
    // 通知兜底。反正 didActivate 是系统通知，不需要辅助功能权限。
    const onActivate = () => {
        const focused = hs.window.focusedWindow();
        if (!focused) return;
        // 焦点没变就别动——应用激活事件比焦点事件频繁得多
        if (state.lastFocusedId === focused.id) return;
        focusFollows(focused);
    };

    hs.application.on("didLaunch", onLaunch);
    hs.application.on("didTerminate", onTerminate);
    hs.application.on("didActivate", onActivate);
    state.appLaunchListener = onLaunch;
    state.appTerminateListener = onTerminate;
    state.appActivateListener = onActivate;

    watchScreens();

    // 记下当前 Space，"切到上一个 Space"才有得切
    spaces.noteSpace(tiling.currentSpaceId());

    // 扫描当前 Space，建立初始布局
    rebuildSpace(tiling.currentSpaceId());
}

function stop() {
    if (!state.started) return;
    state.started = false;

    for (const winId of [...state.windowWatchers.keys()]) {
        unwatchWindow(winId);
    }
    state.windowWatchers.clear();

    state.appWatchers.clear();

    if (state.appLaunchListener) {
        hs.application.off("didLaunch", state.appLaunchListener);
        state.appLaunchListener = null;
    }
    if (state.appTerminateListener) {
        hs.application.off("didTerminate", state.appTerminateListener);
        state.appTerminateListener = null;
    }

    if (state.appActivateListener) {
        hs.application.off("didActivate", state.appActivateListener);
        state.appActivateListener = null;
    }

    for (const timer of state.retileTimers.values()) {
        timer.stop();
    }
    state.retileTimers.clear();

    if (state.screenListeners) {
        state.screenListeners();
        state.screenListeners = null;
    }

    state.columns.clear();
    state.index.clear();
    state.xPositions.clear();
    state.tracked.clear();
    state.anchors.clear();
    state.floating.clear();
    state.expected.clear();
    state.prevFocused = null;
    state.lastFocusedId = null;
    animate.cancelAll();
}

module.exports = {
    start,
    stop,
    watchWindow,
    unwatchWindow,
    watchApplication,
    unwatchApplication,
    adoptNewWindows,
    rebuildSpace,
    retile,
    windowIdOf,
};
