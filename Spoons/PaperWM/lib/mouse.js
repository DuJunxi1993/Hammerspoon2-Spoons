// PaperWM — 鼠标交互
//
// v1 的 events.lua 里有三个基于鼠标的功能：
//
//   drag_window  按住修饰键 + 拖动鼠标 → 整个 Space 的窗口一起左右滑动
//   lift_window  按住修饰键 + 拖动鼠标 → 把窗口从平铺里"抬"出来拖动，
//                松手后放回平铺
//   scroll_window 按住修饰键 + 滚轮     → 整组窗口左右滑动
//
// 滑动依赖"虚拟 X 坐标"：窗口被拖到屏幕外时，真实 frame 已经不能表达
// 它们的相对位置了，所以要额外记一份虚拟坐标（state.xPositions）。
//
// v1 用协程 + 定时器来节流（鼠标事件一秒能来 100~200 次，每次都改
// 窗口位置会让 AX 调用排队积压）。二代不用协程，直接按时间戳节流：
// 累计位移，到 16ms 边界才真正下发一次。

"use strict";

const state = require("./state");
const { config } = require("./config");
const tiling = require("./tiling");
const actions = require("./actions");

const APPLY_INTERVAL_MS = 16;   // 约 60Hz

const mouse = {
    tap: null,

    // 滑动中
    sliding: false,
    slideSpaceId: null,       // 正在滑动的 Space
    slideScreenFrame: null,   // 滑动时锁存的屏幕范围
    slideItems: [],           // [{ win, x }]  虚拟坐标
    pendingDx: 0,
    lastApplyAt: 0,

    // 抬起中
    lifted: null,             // 正在被"抬起"的窗口
    liftedSpaceId: null,      // 抬起时它原本所在的 Space
    liftAnchor: null,         // 抓取点 { win, frameX, frameY, mouseX, mouseY }

};

/** 该 Space 上所有受管窗口（按列顺序） */
function slidingWindows(spaceId) {
    const columns = state.columns.get(spaceId);
    if (!columns) return [];
    const result = [];
    for (const column of columns) {
        for (const win of column) result.push(win);
    }
    return result;
}

/** 立刻把累计的位移应用出去 */
function flush() {
    if (mouse.pendingDx === 0 || !mouse.sliding) return;

    const screenFrame = mouse.slideScreenFrame;
    const leftMargin = screenFrame.x + config.screenMargin;
    const rightMargin = screenFrame.x + screenFrame.w - config.screenMargin;

    for (const item of mouse.slideItems) {
        const win = item.win;
        const frame = win.frame;
        if (!frame) continue;

        item.x += mouse.pendingDx;

        // 窗口不能完全移出屏幕，超出的部分堆在边缘
        const x = Math.max(leftMargin - frame.w, Math.min(item.x, rightMargin));
        // 只改 x，尺寸不变
        tiling.moveWindow(win, { x: x, y: frame.y, w: frame.w, h: frame.h }, true);
    }
    mouse.pendingDx = 0;
}

/** 开始滑动 */
function beginSlide(spaceId, screenFrame) {
    const positions = tiling.virtualPositions(spaceId);

    // 把窗口和它们的虚拟坐标缓存下来——拖动过程中每一帧都要用到，
    // 反复查窗口很贵
    mouse.slideItems = [];
    for (const win of slidingWindows(spaceId)) {
        const x = positions.get(win.id);
        if (x == null) {
            // 这个 Space 还没排过版（没有虚拟坐标），就用当前的真实位置
            const frame = win.frame;
            if (!frame) continue;
            mouse.slideItems.push({ win: win, x: frame.x });
            continue;
        }
        mouse.slideItems.push({ win: win, x: x });
    }

    mouse.sliding = true;
    mouse.slideSpaceId = spaceId;
    mouse.slideScreenFrame = screenFrame;
    mouse.pendingDx = 0;
    mouse.lastApplyAt = Date.now();
}

/**
 * 结束滑动。
 *
 * v1 的做法：把剩下的位移应用掉，然后看看焦点窗口是不是被拖出屏幕了——
 * 是的话把焦点交给那个方向上第一个看得见的窗口（换焦点会触发重排），
 * 否则就用同样的焦点窗口重新排一遍。
 */
function endSlide() {
    if (!mouse.sliding) return;

    flush();
    mouse.sliding = false;

    const spaceId = mouse.slideSpaceId;
    const screenFrame = mouse.slideScreenFrame;
    mouse.slideSpaceId = null;
    mouse.slideScreenFrame = null;
    mouse.slideItems = [];

    if (spaceId == null || !screenFrame) return;

    const focused = hs.window.focusedWindow();
    if (!focused) return;

    const frame = focused.frame;
    if (!frame) return;

    let visible = null;
    if (frame.x < screenFrame.x) {
        visible = tiling.firstVisibleWindow(spaceId, screenFrame, tiling.Direction.LEFT);
    } else if (frame.x + frame.w > screenFrame.x + screenFrame.w) {
        visible = tiling.firstVisibleWindow(spaceId, screenFrame, tiling.Direction.RIGHT);
    }

    if (visible && visible.id !== focused.id) {
        // 换焦点会触发重排
        visible.focus();
    } else {
        tiling.tileSpace(spaceId);
    }
}

/**
 * 把抬起来的窗口放回平铺布局。
 *
 * 关键在于"放到哪一列"：按松手时窗口的水平位置决定——
 * 落在哪一列的范围内，就插进哪一列。这样把窗口拖到屏幕别的地方，
 * 松手后它就留在那儿了。
 */
function dropLifted(win) {
    if (!win) return;

    // 先取消浮动标记，再按位置插回布局
    state.floating.delete(win.id);
    state.transient.delete(win.id);
    actions.persistFloating();

    const spaceId = actions.spaceIdOf(win);
    if (spaceId == null) {
        actions.addWindow(win);
        return;
    }

    // addWindow 默认会优先插到"上一个焦点窗口"右边，
    // 但拖放的时候应该以位置为准，所以这里先把锚点让开
    const savedPrev = state.prevFocused;
    state.prevFocused = null;
    const added = actions.addWindow(win);
    state.prevFocused = savedPrev;

    if (added != null) {
        tiling.tileSpace(added);
    }
    win.focus();
}

/**
 * 把抬起来的窗口拖到指定位置。
 *
 * 两个要点：
 *
 * 1. **位置从"抓取点"算起**，不是从窗口当前的位置累加。
 *    累加的话，窗口只要被系统挪动过一次（聚焦时滚进屏幕、应用自己
 *    调整位置……），那个偏移就会一直跟着窗口走，看起来像是被一个
 *    固定方向的力在牵引。从抓取点算，窗口就严格跟着鼠标走。
 *
 * 2. **只改位置，不改大小**。拖动过程中大小本来就不该变，而设置
 *    大小会让一些应用顺手调整位置（挂载点、标题栏偏移之类），
 *    表现出来就是"斜着走"。这里直接设 AXPosition，绕开
 *    HS2 设置 frame 时那套 enhanced-UI 的开关（一次拖动能省掉
 *    4 次 AX 往返）。
 */
function dragLiftedTo(location) {
    const anchor = mouse.liftAnchor;
    if (!anchor) return;

    const win = anchor.win;
    const x = anchor.frameX + (location.x - anchor.mouseX);
    const y = anchor.frameY + (location.y - anchor.mouseY);

    try {
        win.axElement().setAttributeValue("AXPosition", new HSPoint(x, y));
    } catch (err) {
        // 退回到普通方式
        const frame = win.frame;
        if (frame) {
            tiling.moveWindow(win, { x: x, y: y, w: frame.w, h: frame.h }, true);
        }
    }
}

/** 找到鼠标下面的受管窗口 */
function windowUnderCursor(x, y) {
    const spaceId = tiling.currentSpaceId();
    if (spaceId == null) return null;

    for (const win of slidingWindows(spaceId)) {
        const frame = win.frame;
        if (!frame) continue;
        if (x >= frame.x && x <= frame.x + frame.w && y >= frame.y && y <= frame.y + frame.h) {
            return win;
        }
    }
    return null;
}

/**
 * 修饰键是否与配置完全一致。
 *
 * v1 用的是 flags:containExactly()——多一个键（比如 shift）就不算。
 * 这里保持一致：⌃⌥ 拖动是滑动，⌃⌥⇧ 拖动是抬起，两种不能混。
 *
 * ⚠️ 二代的 flags 数组里除了 "cmd"、"alt" 这些基本名，还带着
 * 哪一侧按下的名字——按住左⌘是 ["cmd", "leftCmd"]，按住右⌘是
 * ["cmd", "rightCmd"]。v1 的 hs.eventtap 没有这些"侧面"名字，
 * 所以直接照搬 containExactly 的写法会永远匹配不上。
 *
 * 所以这里只取基本名来比，"left"/"right" 开头的一律忽略。
 * fn 和 capslock 也不参与比较：fn 是修饰键但不影响意图，
 * capslock 是个开关状态，开着的时候不该拦住拖动。
 */
const PRIMARY_FLAGS = new Set(["cmd", "shift", "alt", "ctrl", "fn", "capslock"]);
const IGNORED_FLAGS = new Set(["fn", "capslock"]);

function primaryFlags(flags) {
    const result = [];
    if (!flags) return result;
    for (const flag of flags) {
        if (!PRIMARY_FLAGS.has(flag)) continue;   // 跳过 leftCmd / rightAlt 之类
        if (IGNORED_FLAGS.has(flag)) continue;
        result.push(flag);
    }
    return result;
}

function flagsMatch(flags, mods) {
    if (!mods || mods.length === 0) return false;

    const active = primaryFlags(flags);
    if (active.length !== mods.length) return false;
    for (const mod of mods) {
        if (!active.includes(mod)) return false;
    }
    return true;
}

/**
 * 鼠标事件的处理逻辑。
 *
 * 单独拎出来是为了能直接喂假事件测试——真实的鼠标拖动没法在
 * 自动化里复现（按住修饰键再拖），但逻辑本身可以验证。
 */
function handleMouseEvent(event) {
    const type = event.type;
        const flags = event.flags || [];
        const location = event.location;

        if (type === hs.eventtap.eventTypes.leftMouseDown) {
            // 拖动增量是拿相邻两次事件的位置差算出来的，
            // 所以按下时就得记下起点
            mouse.lastX = location.x;
            mouse.lastY = location.y;

            if (config.dragWindow && flagsMatch(flags, config.dragWindow)) {
                const win = windowUnderCursor(location.x, location.y);
                if (win) {
                    const index = state.index.get(win.id);
                    const space = index ? hs.screen.spaceForID(index.space) : null;
                    const screen = space ? space.screen : null;
                    if (screen) {
                        beginSlide(index.space, screen.frame);
                        return hs.eventtap.consume;
                    }
                }
            } else if (config.liftWindow && flagsMatch(flags, config.liftWindow)) {
                const win = windowUnderCursor(location.x, location.y);
                if (win) {
                    // 抬起来：临时变成浮动窗口
                    mouse.lifted = win;
                    mouse.liftedSpaceId = state.index.get(win.id)
                        ? state.index.get(win.id).space : null;

                    // 记下"抓取点"：窗口当时的位置 + 鼠标当时的位置。
                    // 之后窗口的位置一律从这两个值算起——
                    // 这样不管中间发生了什么（聚焦时系统把窗口滚进屏幕、
                    // 应用自己调整位置……），窗口都严格跟着鼠标走，
                    // 不会被一个固定方向的偏移拽着跑。
                    const grabbed = win.frame;
                    mouse.liftAnchor = {
                        win: win,
                        frameX: grabbed ? grabbed.x : location.x,
                        frameY: grabbed ? grabbed.y : location.y,
                        mouseX: location.x,
                        mouseY: location.y,
                    };

                    actions.toggleFloating(win);
                    return hs.eventtap.consume;
                }
            }
            return hs.eventtap.emit;
        }

        if (type === hs.eventtap.eventTypes.leftMouseDragged) {
            if (mouse.sliding) {
                // 用增量：鼠标事件给的是当前位置，差值才是位移
                const dx = location.x - mouse.lastX;
                mouse.lastX = location.x;
                mouse.pendingDx += dx;

                const now = Date.now();
                if (now - mouse.lastApplyAt >= APPLY_INTERVAL_MS) {
                    mouse.lastApplyAt = now;
                    flush();
                }
                return hs.eventtap.consume;
            }
            if (mouse.lifted) {
                // 跟着鼠标拖
                dragLiftedTo(location);
                mouse.lastX = location.x;
                mouse.lastY = location.y;
                return hs.eventtap.consume;
            }
            mouse.lastX = location.x;
            mouse.lastY = location.y;
            return hs.eventtap.emit;
        }

        if (type === hs.eventtap.eventTypes.leftMouseUp) {
            mouse.lastX = null;
            mouse.lastY = null;

            if (mouse.sliding) {
                endSlide();
                return hs.eventtap.consume;
            }
            if (mouse.lifted) {
                // 松手：放回平铺。
                //
                // 放回去的时候要按"松手时窗口所在的位置"重新插入，
                // 而不是回到原来那一列——这样才能把窗口拖到新的位置。
                const win = mouse.lifted;
                mouse.lifted = null;
                dropLifted(win);
                return hs.eventtap.consume;
            }
            return hs.eventtap.emit;
        }

        if (type === hs.eventtap.eventTypes.scrollWheel) {
            if (!config.scrollWindow || !flagsMatch(flags, config.scrollWindow)) {
                return hs.eventtap.emit;
            }
            const delta = event.scrollingDeltaX || 0;
            if (!delta) return hs.eventtap.emit;

            const focused = hs.window.focusedWindow();
            if (!focused) return hs.eventtap.emit;
            const index = state.index.get(focused.id);
            if (!index) return hs.eventtap.emit;
            const space = hs.screen.spaceForID(index.space);
            if (!space || !space.screen) return hs.eventtap.emit;

            if (!mouse.sliding) {
                beginSlide(index.space, space.screen.frame);
            }
            mouse.pendingDx += delta * config.scrollGain;
            const now = Date.now();
            if (now - mouse.lastApplyAt >= APPLY_INTERVAL_MS) {
                mouse.lastApplyAt = now;
                flush();
            }
            return hs.eventtap.consume;
        }

    return hs.eventtap.emit;
}

function start() {
    if (mouse.tap) return;

    const types = [
        hs.eventtap.eventTypes.leftMouseDown,
        hs.eventtap.eventTypes.leftMouseDragged,
        hs.eventtap.eventTypes.leftMouseUp,
    ];
    if (config.scrollWindow) types.push(hs.eventtap.eventTypes.scrollWheel);

    mouse.tap = hs.eventtap.addWatcher(types, handleMouseEvent, false);

    if (mouse.tap) mouse.tap.start();
}

function stop() {
    if (mouse.tap) {
        hs.eventtap.removeWatcher(mouse.tap);
        mouse.tap = null;
    }
    mouse.sliding = false;
    mouse.lifted = null;
    mouse.liftAnchor = null;
    mouse.pendingDx = 0;
    mouse.slideItems = [];
    mouse.slideSpaceId = null;
    mouse.slideScreenFrame = null;
}

module.exports = {
    start,
    stop,
    endSlide,
    beginSlide,
    flush,
    windowUnderCursor,
    handleMouseEvent,
    flagsMatch,
    primaryFlags,
    mouse,
};
