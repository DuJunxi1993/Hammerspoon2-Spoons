// PaperWM — Space 相关动作
//
// v1 这里是最难啃的一块：space.lua + mission_control.lua 共 440 行，
// 全靠"打开 Mission Control → 模拟鼠标拖拽窗口 → 点击目标 Space"来实现
// 切换 Space 和移动窗口。拖拽的坐标全靠估算，失败率不低。
//
// 二代完全不需要这些。Hammerspoon 2 原生支持 Spaces：
//   · hs.screen.allSpaces()        列出所有 Space
//   · hs.screen.focusedSpace()     当前焦点 Space
//   · space.goto()                 切到某个 Space（内部自己走 Mission Control，但可靠）
//   · window.moveToSpace(space)    把窗口移到另一个 Space（不走 Mission Control）
//
// 于是这一层从 440 行变成 100 行，而且是原生实现，不会失手。

"use strict";

const state = require("./state");
const { config } = require("./config");
const tiling = require("./tiling");
const actions = require("./actions");

/** 所有普通桌面（排除全屏 Space），按 Mission Control 的编号排列 */
function desktopSpaces() {
    const spaces = hs.screen.allSpaces().filter((space) => space.type === "desktop");
    spaces.sort((a, b) => {
        const da = a.desktopNumber == null ? Number.MAX_SAFE_INTEGER : a.desktopNumber;
        const db = b.desktopNumber == null ? Number.MAX_SAFE_INTEGER : b.desktopNumber;
        return da - db;
    });
    return spaces;
}

/**
 * 记下最近去过的 Space（新的在前）。
 *
 * 上游是靠自己的 Space.Tracker 实现的——它挂钩 Mission Control 的
 * 变化来记录。二代有 hs.screen 的 spaceChange 事件，直接用它。
 */
function noteSpace(spaceId) {
    if (spaceId == null) return;
    const index = state.recentSpaces.indexOf(spaceId);
    if (index >= 0) state.recentSpaces.splice(index, 1);
    state.recentSpaces.unshift(spaceId);
    if (state.recentSpaces.length > 16) state.recentSpaces.pop();
}

/** 最近去过的、但不是当前的那个 Space */
function recentSpace() {
    const current = hs.screen.focusedSpace();
    const currentId = current ? current.id : null;
    for (const id of state.recentSpaces) {
        if (id === currentId) continue;
        const space = hs.screen.spaceForID(id);
        if (space && space.type === "desktop") return space;
    }
    return null;
}

/**
 * 切到某个 Space。
 *
 * @param {object} space HSSpace
 * @param {object=} keepApp 切换后要保持前台的应用（preserveAppFocus）
 */
function gotoSpace(space, keepApp) {
    if (!space) return null;

    noteSpace(space.id);

    const result = space.goto();
    if (result && typeof result.catch === "function") {
        result.catch((err) => {
            console.error("PaperWM: 切换 Space 失败：" + err.message);
        });
    }

    // 切过去之后决定焦点给谁
    hs.timer.doAfter(0.15, () => {
        if (keepApp) {
            const win = findAppWindowIn(keepApp, space.id);
            if (win) {
                win.focus();
                return;
            }
        }
        focusFirstWindowIn(space.id);
        centerMouseOn(space);
    });

    return space;
}

/**
 * 找一个应用的、位于某个 Space 上的标准窗口。
 *
 * 上游的 preserve_app_focus 就是这么干的：切换 Space 时，
 * 如果当前前台应用在目标 Space 上也有窗口，就把焦点给它，
 * 这样切来切去不会"丢"自己的应用。
 */
function findAppWindowIn(app, spaceId) {
    if (!app || typeof app.visibleWindows !== "function") return null;
    let windows;
    try {
        windows = app.visibleWindows();
    } catch (err) {
        return null;
    }
    if (!windows) return null;

    for (const win of windows) {
        // 很多应用会创建没有标题的窗口（浮动面板、气泡、提示、透明层），
        // 它们也算 visible，但可能在别的屏幕上
        if (!win.isStandard) continue;
        if (!win.title) continue;
        const spaces = win.spaces || [];
        if (spaces.some((s) => s.id === spaceId)) return win;
    }
    return null;
}

/** 把鼠标移到屏幕中央（切 Space 之后可选） */
function centerMouseOn(space) {
    if (!config.centerMouse) return;
    const screen = space && space.screen;
    if (!screen) return;
    const frame = screen.frame;
    try {
        hs.mouse.setAbsolutePosition(
            Math.round(frame.x + frame.w / 2),
            Math.round(frame.y + frame.h / 2)
        );
    } catch (err) {
        // 鼠标不可用时忽略
    }
}

/** 切到第 n 个桌面（1 起） */
function switchToSpace(n) {
    const spaces = desktopSpaces();
    const space = spaces[n - 1];
    if (!space) return null;

    const focused = hs.window.focusedWindow();
    const app = focused ? focused.application : null;
    return gotoSpace(space, config.preserveAppFocus ? app : null);
}

/** 切到上一个去过的 Space */
function switchToRecentSpace() {
    const space = recentSpace();
    if (!space) return null;
    const focused = hs.window.focusedWindow();
    const app = focused ? focused.application : null;
    return gotoSpace(space, config.preserveAppFocus ? app : null);
}

/** 切到当前 Space 的左边/右边的桌面 */
function incrementSpace(direction) {
    const spaces = desktopSpaces();
    if (spaces.length === 0) return null;

    const focused = hs.screen.focusedSpace();
    if (!focused) return null;

    const currentIndex = spaces.findIndex((space) => space.id === focused.id);
    if (currentIndex < 0) return null;

    const nextIndex = ((currentIndex + direction) % spaces.length + spaces.length) % spaces.length;
    return switchToSpace(nextIndex + 1);
}

/** 把焦点窗口移到第 n 个桌面 */
function moveWindowToSpace(n) {
    const win = hs.window.focusedWindow();
    if (!win) return null;

    const spaces = desktopSpaces();
    const space = spaces[n - 1];
    if (!space) return null;

    const currentSpaces = win.spaces;
    if (currentSpaces.some((s) => s.id === space.id)) return null;   // 已经在上面了

    const index = state.index.get(win.id);
    const wasFloating = actions.isFloating(win);
    const oldSpaceId = index ? index.space : (currentSpaces[0] ? currentSpaces[0].id : null);

    // 窗口离开当前 Space 前，先把它从布局里摘掉，免得留下悬空的引用
    if (index && !wasFloating) {
        actions.removeWindow(win, true);
        tiling.tileSpace(index.space);
    }

    const result = win.moveToSpace(space);
    if (!result || typeof result.then !== "function") return null;

    // move_window_keep_space：留在当前 Space，不跟着窗口走
    const stayHere = config.moveWindowKeepSpace;

    result.then(() => {
        // 到了新 Space：如果原来不是浮动窗口，就把它纳入新 Space 的布局
        if (!wasFloating) {
            const newIndex = actions.addWindow(win);
            if (newIndex != null) {
                tiling.tileSpace(newIndex);
            }
        }

        if (stayHere) {
            // 留在原地：把焦点还给当前 Space 的某个窗口
            const current = hs.screen.focusedSpace();
            if (current) {
                const back = focusFirstWindowIn(current.id);
                if (!back && oldSpaceId != null) {
                    tiling.tileSpace(oldSpaceId);
                }
            }
        } else {
            win.focus();
        }
    }).catch((err) => {
        console.error("PaperWM: 移动窗口到 Space 失败：" + err.message);
    });

    return space;
}

/**
 * 把焦点窗口移到相邻显示器的 Space 上。
 *
 * 一个显示器的时候没什么可移的——那就什么都不做。
 */
function moveWindowToScreen(direction) {
    const win = hs.window.focusedWindow();
    if (!win) return null;

    const screens = hs.screen.all();
    if (screens.length < 2) return null;

    const current = win.screen;
    if (!current) return null;

    const index = screens.findIndex((screen) => screen.id === current.id);
    if (index < 0) return null;

    // 左右是相邻的显示器，上下是"同一列"里上下相邻的显示器
    let targetIndex = -1;
    if (direction === -1 || direction === 1) {
        targetIndex = (index + direction + screens.length) % screens.length;
    } else {
        const vertical = direction === -2 || direction === 2;
        for (let i = 0; i < screens.length; i++) {
            const screen = screens[i];
            const overlapsX = screen.frame.x < current.frame.x + current.frame.w &&
                             screen.frame.x + screen.frame.w > current.frame.x;
            if (!overlapsX) continue;
            const above = screen.frame.y + screen.frame.h <= current.frame.y;
            const below = screen.frame.y >= current.frame.y + current.frame.h;
            if ((vertical && above && direction === -2) ||
                (vertical && below && direction === 2)) {
                targetIndex = i;
                break;
            }
        }
    }
    if (targetIndex < 0 || targetIndex === index) return null;

    const targetScreen = screens[targetIndex];
    // 目标显示器当前显示的 Space
    const space = targetScreen.currentSpace || targetScreen.spaces[0];
    if (!space || space.type !== "desktop") return null;

    const currentSpaces = win.spaces;
    if (currentSpaces.some((s) => s.id === space.id)) return null;

    const index2 = state.index.get(win.id);
    const wasFloating = actions.isFloating(win);

    if (index2 && !wasFloating) {
        actions.removeWindow(win, true);
        tiling.tileSpace(index2.space);
    }

    const result = win.moveToSpace(space);
    if (!result || typeof result.then !== "function") return null;

    const stayHere = config.moveWindowKeepSpace;

    result.then(() => {
        if (!wasFloating) {
            const newIndex = actions.addWindow(win);
            if (newIndex != null) tiling.tileSpace(newIndex);
        }
        if (stayHere) {
            const current = hs.screen.focusedSpace();
            if (current) focusFirstWindowIn(current.id);
        } else {
            win.focus();
        }
    }).catch((err) => {
        console.error("PaperWM: 移动窗口到别的显示器失败：" + err.message);
    });

    return space;
}

/** 聚焦某个 Space 上的第一个窗口 */
function focusFirstWindowIn(spaceId) {
    const columns = state.columns.get(spaceId);
    if (!columns || columns.length === 0) return null;
    const first = columns[0] && columns[0][0];
    if (first) {
        first.focus();
        return first;
    }
    return null;
}

module.exports = {
    desktopSpaces,
    switchToSpace,
    switchToRecentSpace,
    incrementSpace,
    moveWindowToSpace,
    moveWindowToScreen,
    focusFirstWindowIn,
    noteSpace,
    recentSpace,
    gotoSpace,
};
