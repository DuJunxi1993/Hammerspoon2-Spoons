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
const axutil = require("./axutil");
const ax = require("./ax");
const tiling = require("./tiling");
const actions = require("./actions");
const animate = require("./animate");
const spaces = require("./spaces");

// 重排的防抖时长（秒）：一次事件风暴里只排一次版
const RETILE_DEBOUNCE = 0.06;

// ---------------------------------------------------------------- 系统原生平铺

// macOS 自带的窗口平铺快捷键：
//   ⌃⌥ + 方向键      把窗口移到半屏
//   ⌃⌥⇧ + 方向键     两个窗口分屏
//
// 只监听不拦截——系统该干什么还是干什么。我们只是需要知道
// "用户刚让系统平铺了窗口"，好给它让出位置，别被下一次重排冲掉。
const ARROW_KEY_CODES = new Set([123, 124, 125, 126]);   // ← → ↓ ↑

// 等系统的平铺动画走完，再看哪些窗口被它动了。
// 系统的平铺动画大概 0.25 秒，这里留够余量，
// 这样读到被钉住窗口的位置时，它已经停在最终位置上了。
const SYSTEM_TILING_DELAY = 0.45;

// 这段时间里不插手重排——不然系统刚摆好的窗口就被我们搬走了
let systemTilingUntil = 0;

let systemTilingTap = null;

/**
 * 监听 macOS 原生的窗口平铺快捷键。
 *
 * 用 listenOnly 的事件监听：不吞事件、不改行为，
 * 系统该怎么平铺还是怎么平铺。
 */
function watchSystemTiling() {
    if (systemTilingTap || !config.followSystemTiling) return;

    const types = hs.eventtap.eventTypes;
    try {
        systemTilingTap = hs.eventtap.addWatcher([types.keyDown], (event) => {
            if (event.type !== types.keyDown) return hs.eventtap.emit;
            // 先看键码是不是方向键——普通打字不该为此付出代价
            // （读 event.flags 会分配一个数组）
            if (!ARROW_KEY_CODES.has(event.keyCode)) return hs.eventtap.emit;
            const flags = event.flags || [];
            if (!flags.includes("ctrl") || !flags.includes("alt")) return hs.eventtap.emit;
            onSystemTilingShortcut();
            return hs.eventtap.emit;   // 放行，系统照常处理
        }, true);
        if (systemTilingTap) systemTilingTap.start();
    } catch (err) {
        console.error("PaperWM: 监听系统平铺快捷键失败：" + err.message);
        systemTilingTap = null;
    }
}

/** 取消监听 */
function unwatchSystemTiling() {
    if (!systemTilingTap) return;
    try {
        systemTilingTap.stop();
    } catch (err) {
        // 已经停了，不影响
    }
    systemTilingTap = null;
}

/**
 * 用户按了系统平铺快捷键。
 *
 * 系统马上要动窗口了：先声明"这段时间别插手"，不然我们自己的
 * 重排会把系统刚摆好的位置冲掉。等系统的动画走完，再看哪些
 * 窗口被它动了——那些窗口钉住，位置大小听系统的。
 */
function onSystemTilingShortcut() {
    if (!config.followSystemTiling) return;

    systemTilingUntil = Date.now() + (SYSTEM_TILING_DELAY + 0.4) * 1000;

    // 还没触发的重排先取消掉——它们要是正好在这段时间里跑起来，
    // 窗口的位置就不是"系统改的"了，判断会出错。
    for (const timer of state.retileTimers.values()) timer.stop();
    state.retileTimers.clear();

    // 记下每个受管窗口现在的位置，等系统平铺完再对比。
    // 正在做动画的窗口不记——它的位置是中间值，比对没有意义
    // （AX 回报的位置总会比动画慢半拍，差个几像素很正常）。
    const before = new Map();
    for (const [id, win] of state.tracked) {
        if (!state.index.has(id)) continue;
        if (animate.isAnimating(id)) continue;
        const frame = win.frame;
        if (!frame) continue;
        before.set(id, { x: frame.x, y: frame.y, w: frame.w, h: frame.h });
    }

    hs.timer.doAfter(SYSTEM_TILING_DELAY, () => {
        let changed = windowsMovedSince(before);

        // 万一系统比我们的按键回调还快（快照拍晚了），
        // 那就退一步，拿"PaperWM 最后一次摆放的位置"来比。
        if (!changed.length) changed = windowsMovedExternally();

        if (!changed.length) return;

        const spaceIds = new Set();
        for (const id of changed) {
            const index = state.index.get(id);
            if (!index) continue;
            state.pinned.set(id, { space: index.space });
            spaceIds.add(index.space);
        }
        if (!spaceIds.size) return;

        // 其余平铺窗口绕开被系统平铺的窗口，铺到剩下的空间里
        for (const spaceId of spaceIds) tiling.tileSpace(spaceId);
    });
}

/**
 * 哪些窗口的位置和快照不一样？
 *
 * @param {Map<number, {x,y,w,h}>} before 按键时的位置
 */
function windowsMovedSince(before) {
    const changed = [];
    for (const [id, prev] of before) {
        if (animate.isAnimating(id)) continue;   // 还在动，不判断
        const win = state.tracked.get(id);
        const frame = win && win.frame;
        if (!frame) continue;
        if (Math.abs(frame.x - prev.x) > 3 ||
            Math.abs(frame.y - prev.y) > 3 ||
            Math.abs(frame.w - prev.w) > 3 ||
            Math.abs(frame.h - prev.h) > 3) {
            changed.push(id);
        }
    }
    return changed;
}

/**
 * 哪些受管窗口被"别人"动过了？
 *
 * 拿现在的帧和 PaperWM 最后一次摆放的位置比。差得多就是外部动的
 * （系统平铺、用户手动拖拽都会这样）。这个比较不依赖时序，
 * 不用担心事件来得早晚。
 */
function windowsMovedExternally() {
    const changed = [];
    for (const [id, win] of state.tracked) {
        if (!state.index.has(id)) continue;    // 只管受管的平铺窗口
        if (animate.isAnimating(id)) continue; // 还在动，不判断
        const actual = win.frame;
        if (!actual) continue;
        const placed = animate.lastPlaced.get(id);
        if (!placed) continue;
        if (Math.abs(actual.x - placed.x) > 3 ||
            Math.abs(actual.y - placed.y) > 3 ||
            Math.abs(actual.w - placed.w) > 3 ||
            Math.abs(actual.h - placed.h) > 3) {
            changed.push(id);
        }
    }
    return changed;
}

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

    // 焦点窗口居中——相当于对它按一次 ⌥⌘H。
    // 先把它挪到中间，接着的重排就会围着它展开，
    // 其余窗口自然分列它左右两侧。
    //
    // 排版本身不会动锚点的位置（锚点在哪就以哪为基准），
    // 所以这个"居中"是明确的一步，不会被别的事件顶回去。
    if (config.centerFocusedWindow) {
        tiling.centerAnchor(win);
    }

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

            // 系统正在做原生平铺：别插手，否则刚摆好的位置会被冲掉
            if (Date.now() < systemTilingUntil) return;

            // 用户自己拖动了窗口 → 重新排布
            const index = state.index.get(win.id);
            if (!index) return;

            // 被系统平铺（钉住）的窗口：用户手动动了它，就解除钉住，
            // 交回控制权
            if (state.pinned.has(win.id)) {
                state.pinned.delete(win.id);
            }

            retile(index.space);
            break;
        }
        case ax.SHORT.uIElementDestroyed: {
            // 窗口被关掉了
            state.windowWatchers.delete(win.id);
            axutil.forget(win.id);
            state.pinned.delete(win.id);
            if (state.floating.has(win.id)) {
                // 浮动窗口（含弹出式窗口）没了：从浮动列表里摘掉。
                // 弹出式窗口不写 userdefaults，用完就没了。
                actions.unfloat(win);
                state.tracked.delete(win.id);
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
                if (!state.transient.has(focused.id)) {
                    state.prevFocused = focused;
                }

                if (!wasManaged && !state.floating.has(focused.id)) {
                    // 新获得焦点但还没纳管（新建的窗口，或者从浮动变平铺）
                    const spaceId = adoptFocusedWindow(focused);
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
 * 把一个"刚获得焦点、但还没纳管"的窗口收编。
 *
 * @param {object} focused HSWindow
 * @returns {number|null} 如果往布局里加了窗口，返回它所在的 Space id，
 *                         调用方需要重排；弹出式窗口返回 null（布局不动）
 */
function adoptFocusedWindow(focused) {
    if (!focused) return null;

    const kind = filter.classify(focused);
    if (kind === "ignore") return null;

    if (kind === "float") {
        // 弹出式窗口（文件选择面板、sheet、模态框……）：只跟踪，不动布局。
        // 面板抢焦点是常事，但绝不能因此打乱现有的平铺布局。
        actions.makeFloating(focused, true);
        state.tracked.set(focused.id, focused);
        watchWindow(focused);
        return null;
    }

    return actions.addWindow(focused);
}

/**
 * 把某个应用里新出现的窗口纳入布局。
 *
 * 做法是拿这个应用当前的窗口列表，和我们已经跟踪的做差。
 *
 * 新窗口分三种：
 *   · 普通窗口     → 加进布局，然后重排
 *   · 弹出式窗口   → 当成浮动窗口跟踪，**布局一个像素都不动**
 *   · 不该管的     → 跳过
 *
 * 最后一条是关键：文件选择面板这类窗口一冒出来就占掉一列的话，
 * 整个布局会被挤歪，面板一关又会触发"列被删掉但索引表没重建"的问题。
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

        const kind = filter.classify(win, false);
        if (kind === "ignore") continue;

        if (kind === "float") {
            // 弹出式窗口：只跟踪，不进布局。
            // 注意这里**不重排**——弹窗出现不该影响现有窗口。
            actions.makeFloating(win, true);
            state.tracked.set(win.id, win);
            watchWindow(win);
            continue;
        }

        const added = actions.addWindow(win);
        if (added != null) {
            spaceId = added;
            watchWindow(win);
        }
    }

    // 只有真的往布局里加了窗口才重排。
    // 弹出式窗口出现时，一个像素都不该动。
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

    const columns = tiling.columnsFor(spaceId);

    // 记下原来的列结构，作为"放回原位"的依据
    const previous = columns.map((column) => column.slice());

    const all = filter.allWindows();

    // hs.window.allWindows() 偶尔会因为某个应用正忙（AX 查询超时）
    // 漏掉它的窗口。已经纳管的窗口补回来——不能因为一次读取失败
    // 就把人家踢出布局。
    const seen = new Set(all.map((w) => w.id));
    for (const column of previous) {
        for (const win of column) {
            if (!win || seen.has(win.id)) continue;
            seen.add(win.id);
            all.push(win);
        }
    }

    // 这个 Space 上的窗口，按水平位置排序（没有位置信息的排最后）
    const onSpace = [];
    for (const win of all) {
        // 已经纳管的窗口：AX 读数不可靠时不要把它踢出去
        const kind = filter.classify(win, state.index.has(win.id));

        if (kind === "float") {
            // 弹出式窗口：当成浮动窗口跟踪，不进布局
            if (!state.floating.has(win.id)) {
                actions.makeFloating(win, true);
                state.tracked.set(win.id, win);
                watchWindow(win);
            }
            continue;
        }
        if (kind !== "tile") continue;

        // 之前因为规则被判成浮动，现在规则改了 → 恢复成平铺窗口
        if (state.transient.has(win.id)) {
            actions.unfloat(win);
        } else if (state.floating.has(win.id)) {
            // 用户手动设的浮动窗口，保持浮动
            continue;
        }

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

    // 已经在旧列里的窗口，回到原来的列；新窗口按位置插入。
    //
    // 这里要注意列号的换算：插入一个新列之后，后面所有列的序号都会
    // 往前挪一位。要是拿旧的列号直接往数组里塞，原本不相干的两个
    // 窗口会被塞进同一列——布局看起来就乱了。
    //
    // 所以先按"旧列号"分组，再排序展开，最后才把新窗口插进来，
    // 这样旧列的身份从头到尾都不会错位。
    const groups = new Map();    // 旧列号 -> 这一列剩下的窗口
    const newcomers = [];        // 不在旧列里的新窗口

    for (const win of onSpace) {
        let oldCol = -1;
        for (let col = 0; col < previous.length; col++) {
            if (previous[col].some((w) => w.id === win.id)) {
                oldCol = col;
                break;
            }
        }
        if (oldCol >= 0) {
            if (!groups.has(oldCol)) groups.set(oldCol, []);
            groups.get(oldCol).push(win);
        } else {
            newcomers.push(win);
        }
    }

    // 旧列按原来的顺序展开。空了的列（窗口都走了）自然消失，
    // 不用事后再去清理空数组。
    const newColumns = [...groups.keys()]
        .sort((a, b) => a - b)
        .map((oldCol) => groups.get(oldCol));

    // 新窗口：按它当前的水平位置插进来
    for (const win of newcomers) {
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

        // 弹出式窗口（文件选择面板）抢了焦点：把它当成浮动窗口跟踪，
        // 但**不要动布局**。面板关掉以后焦点会回到原来的窗口，
        // 那时布局本来就没变过，也不需要重排。
        if (!state.index.has(focused.id) && !state.floating.has(focused.id)) {
            const spaceId = adoptFocusedWindow(focused);
            if (spaceId != null) tiling.tileSpace(spaceId);
            return;
        }

        focusFollows(focused);
    };

    hs.application.on("didLaunch", onLaunch);
    hs.application.on("didTerminate", onTerminate);
    hs.application.on("didActivate", onActivate);
    state.appLaunchListener = onLaunch;
    state.appTerminateListener = onTerminate;
    state.appActivateListener = onActivate;

    watchScreens();
    watchSystemTiling();

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

    unwatchSystemTiling();
    state.pinned.clear();

    state.columns.clear();
    state.index.clear();
    state.xPositions.clear();
    state.tracked.clear();
    state.anchors.clear();
    state.floating.clear();
    state.transient.clear();
    state.expected.clear();
    state.prevFocused = null;
    state.lastFocusedId = null;
    axutil.clearCache();
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
    watchSystemTiling,
    unwatchSystemTiling,
    onSystemTilingShortcut,
    windowsMovedExternally,
    windowsMovedSince,
};
