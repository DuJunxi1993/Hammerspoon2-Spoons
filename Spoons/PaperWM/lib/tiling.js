// PaperWM — 布局引擎
//
// 这是 v1 的 tiling.lua + windows.lua 的移植。算法原样保留（那套算法
// 是 PaperWM 的核心，经得起检验），只是把 Lua 的 table 换成 JS 的
// Map/数组，把 hs.window 的方法调用换成二代的属性访问。
//
// 布局模型：
//   每个 Space 是若干"列"（column），每列里上下堆叠若干窗口。
//   平铺时以"锚点窗口"（通常是当前焦点窗口）所在列为基准，
//   向右、向左依次把每一列铺开。
//
// 坐标系提醒：
//   二代的 screen.frame 是**可见区域**（已经扣掉菜单栏和 Dock），
//   screen.fullFrame 是整个显示器。窗口的 frame 是 AX 坐标
//   （原点在主屏左上角，y 向下），和 screen.frame 同一套坐标系，
//   可以直接比较——这一点和 v1 相同。

"use strict";

const state = require("./state");
const { config, DEFAULT_GAP } = require("./config");
const animate = require("./animate");
const stack = require("./stack");

// 期望位置的有效期（毫秒）：超过这个时间还没等到对应的 AX 事件，
// 就认为那不是我们造成的移动
const EXPECTED_TTL_MS = 1000;

// ---------------------------------------------------------------- 方向

const Direction = {
    LEFT: -1,
    RIGHT: 1,
    UP: -2,
    DOWN: 2,
    NEXT: 3,
    PREVIOUS: -3,
    WIDTH: 4,
    HEIGHT: 5,
    ASCENDING: 6,
    DESCENDING: 7,
};

// ---------------------------------------------------------------- 间距

/** 某一边的间隙 */
function gap(side) {
    const g = config.windowGap;
    if (typeof g === "number") return g;
    if (g && typeof g === "object") {
        const value = g[side];
        return typeof value === "number" ? value : DEFAULT_GAP;
    }
    return DEFAULT_GAP;
}

/** 可铺布的区域（画布） */
function getCanvas(screen) {
    const sf = screen.frame;
    const full = screen.fullFrame;

    let frameTop = sf.y;
    let frameBottom = sf.y + sf.h;
    const bar = config.externalBar;
    if (bar) {
        if (typeof bar.top === "number") frameTop = full.y + bar.top;
        if (typeof bar.bottom === "number") frameBottom = (full.y + full.h) - bar.bottom;
    }
    const frameHeight = frameBottom - frameTop;

    const left = gap("left");
    const right = gap("right");
    const top = gap("top");
    const bottom = gap("bottom");

    return {
        x: sf.x + left,
        y: frameTop + top,
        w: sf.w - (left + right),
        h: frameHeight - (top + bottom),
    };
}

// ---------------------------------------------------------------- 布局存取

/** 取某个 Space 的列数组（没有就建一个空的） */
function columnsFor(spaceId) {
    let columns = state.columns.get(spaceId);
    if (!columns) {
        columns = [];
        state.columns.set(spaceId, columns);
    }
    return columns;
}

/** 窗口在布局中的位置 */
function windowIndex(win, remove) {
    if (!win) return null;
    const index = state.index.get(win.id);
    if (remove) state.index.delete(win.id);
    return index;
}

/**
 * 该 Space 上"第一个能看见的"窗口。
 *
 * @param {number} spaceId
 * @param {object} screenFrame 屏幕可见区域
 * @param {number=} direction Direction.LEFT / Direction.RIGHT
 *        指定方向时，找的是那个方向上最靠边的窗口：
 *        LEFT  找最左边（x 最小）的
 *        RIGHT 找最右边（x2 最大）的
 *        不指定则找完全落在屏幕里的、离左边缘最近的那个
 * @returns {object|null}
 */
function firstVisibleWindow(spaceId, screenFrame, direction) {
    const columns = state.columns.get(spaceId);
    if (!columns) return null;

    let onScreenDistance = Infinity;
    let onScreenClosest = null;
    let offScreenDistance = -Infinity;
    let offScreenClosest = null;

    for (const column of columns) {
        const win = column[0];   // 每列只看第一个窗口
        if (!win) continue;
        const frame = animate.layoutFrame(win);
        if (!frame) continue;

        let d;
        if (direction === Direction.LEFT) {
            d = frame.x - screenFrame.x;
        } else if (direction === Direction.RIGHT) {
            d = (screenFrame.x + screenFrame.w) - (frame.x + frame.w);
        } else {
            d = frame.x - screenFrame.x;
        }

        if (d >= 0 && d < onScreenDistance) {
            onScreenDistance = d;
            onScreenClosest = win;
        }
        if (d < 0 && d > offScreenDistance) {
            offScreenDistance = d;
            offScreenClosest = win;
        }
    }
    return onScreenClosest || offScreenClosest;
}

/** 记录窗口的"虚拟 X 坐标" */
function updateVirtualPositions(spaceId, column, x) {
    let positions = state.xPositions.get(spaceId);
    if (!positions) {
        positions = new Map();
        state.xPositions.set(spaceId, positions);
    }
    for (const win of column) {
        positions.set(win.id, x);
    }
}

/** 取某个 Space 上所有窗口的虚拟 X 坐标 */
function virtualPositions(spaceId) {
    return state.xPositions.get(spaceId) || new Map();
}

// ---------------------------------------------------------------- 移动窗口

/**
 * 把窗口移到指定位置。
 *
 * 二代没有窗口动画（v1 需要 setFrame(frame, 0) 来禁用 200ms 的过渡动画），
 * 但 macOS 会回报 windowMoved/windowResized 事件。这里把"我们要求的
 * frame"记下来，事件到来时比对——吻合就忽略，避免自己触发自己。
 *
 * 实际挪动交给 animate.js：开了动画就走补间（平滑滑过去），
 * 没开就直接跳。
 */
function moveWindow(win, frame, instant) {
    if (!win || !frame) return false;

    const current = win.frame;
    if (!current) return false;
    if (Math.abs(current.x - frame.x) < 0.5 && Math.abs(current.y - frame.y) < 0.5 &&
        Math.abs(current.w - frame.w) < 0.5 && Math.abs(current.h - frame.h) < 0.5) {
        return false;   // 位置没变，不碰窗口
    }

    return animate.moveWindow(win, frame, instant);
}

/**
 * 事件到来时，判断这次移动是不是我们自己造成的。
 * 是的话返回 true（应当忽略）。
 *
 * 开了过渡动画之后，这件事变复杂了：
 *
 *   · 一次 moveAndResize 会同时改位置和大小，AX 往往回报**两个**事件
 *     （windowMoved 和 windowResized）。所以不能"匹配上就删掉期望"——
 *     第二个事件就找不到期望了，会被误判成用户拖动，导致反复重排。
 *
 *   · 动画期间每一帧都会改一次位置，于是期望值每帧都变。AX 事件是
 *     异步送来的，很可能滞后好几帧才到——那时候期望值早就不一样了。
 *
 * 所以期望值不是"一个值"，而是"最近几个值的列表"：事件到达时只要跟
 * 其中任何一个对得上，就算我们自己造成的。
 *
 * 列表里每个值都带时间戳，超过有效期就整个作废——那说明这是一次
 * 用户操作，我们要重新排布。
 */
function consumeExpected(winId, actualFrame) {
    const expected = state.expected.get(winId);
    if (!expected) return false;

    const now = Date.now();
    const age = now - expected.at;

    // 期望值过期了：说明这是一次用户操作
    if (age > EXPECTED_TTL_MS) {
        state.expected.delete(winId);
        return false;
    }

    if (!actualFrame) {
        expected.at = now;
        return true;
    }

    const eps = expected.eps || config.frameEpsilon;

    // 当前值或历史值里有对得上的 → 自己造成的
    const candidates = [expected].concat(expected.history || []);
    for (const candidate of candidates) {
        if (matches(candidate, actualFrame, eps)) {
            expected.at = now;
            return true;
        }
    }

    // 没对上，但刚刚才动过这个窗口：多半是应用自己微调了一下
    // （或者事件顺序和我们的写入顺序相反）。仍然算自己造成的，
    // 但把期望更新成实际值，免得下一次再错位。
    if (age < 400) {
        expected.x = actualFrame.x;
        expected.y = actualFrame.y;
        expected.w = actualFrame.w;
        expected.h = actualFrame.h;
        expected.at = now;
        expected.history = [];
        return true;
    }

    return false;
}

/** 两个 frame 是否在容差内相等 */
function matches(candidate, actualFrame, eps) {
    return Math.abs(actualFrame.x - candidate.x) <= eps &&
           Math.abs(actualFrame.y - candidate.y) <= eps &&
           Math.abs(actualFrame.w - candidate.w) <= eps &&
           Math.abs(actualFrame.h - candidate.h) <= eps;
}

// ---------------------------------------------------------------- 铺一列

/**
 * 把一列窗口铺成手风琴。
 *
 * 每个窗口都是整列那么宽、那么高，上下错开 accordionPeek 像素，
 * 这样每个标题栏都露一条边，能看见、能点。
 *
 * 展开的那个（activeRow）在中间：它上面的窗口从画布顶部往下叠，
 * 它下面的窗口从它的下沿往下叠——下面那些会超出屏幕底部，这是故意的
 * （PaperWM 原版就是这样）。
 *
 * @param {Array} windows 这一列的窗口
 * @param {object} bounds { x, x2, y, y2 }
 * @param {number} activeRow 展开的是第几个窗口（从 1 开始）
 * @param {number=} w 列宽
 * @returns {number} 这一列的宽度
 */
function tileStackedColumn(windows, bounds, activeRow, w) {
    const peek = config.accordionPeek;
    const n = windows.length;
    activeRow = Math.max(1, Math.min(activeRow, n));
    if (w == null) {
        const first = windows[0];
        const frame = first ? animate.layoutFrame(first) : null;
        w = frame ? frame.w : 0;
    }

    const x = bounds.x != null ? bounds.x : bounds.x2 - w;
    // 共享高度：整列减去错开的部分，但不能矮到没法用
    const h = Math.max(config.stackMinHeight,
                       (bounds.y2 - bounds.y) - ((n - 1) * peek));

    for (let row = 0; row < n; row++) {
        const win = windows[row];
        const frame = animate.layoutFrame(win);
        if (!frame) continue;

        const target = {
            x: x,
            y: 0,
            w: w,
            h: h,
        };
        if (row + 1 <= activeRow) {
            target.y = bounds.y + (row * peek);
        } else {
            target.y = bounds.y + ((activeRow - 1) * peek) + h + ((row - activeRow) * peek);
        }

        moveWindow(win, target);
    }

    return w;
}

/**
 * 铺一列窗口（等分高度）。
 *
 * @param {Array} windows 这一列的窗口
 * @param {object} bounds { x, x2, y, y2 }，x 与 x2 至少给一个
 * @param {number=} h 每个窗口的高度
 * @param {number=} w 每个窗口的宽度
 * @param {number=} id 需要特殊高度的窗口 id
 * @param {number=} h4id 那个窗口的特殊高度
 * @returns {number} 这一列的宽度
 */
function tileColumn(windows, bounds, h, w, id, h4id) {
    const bottomGap = gap("bottom");
    let lastWindow = null;
    let lastFrame = null;

    for (const win of windows) {
        const current = animate.layoutFrame(win);
        if (!current) continue;

        const frame = { x: current.x, y: current.y, w: current.w, h: current.h };
        if (w == null) w = frame.w;

        if (bounds.x != null) {
            frame.x = bounds.x;
        } else if (bounds.x2 != null) {
            frame.x = bounds.x2 - w;
        }

        if (h != null) {
            frame.h = (id != null && h4id != null && win.id === id) ? h4id : h;
        }

        frame.y = bounds.y;
        frame.w = w;

        // 不要超出下边界
        let y2 = frame.y + frame.h;
        if (y2 > bounds.y2) {
            y2 = bounds.y2;
            frame.h = y2 - frame.y;
        }

        moveWindow(win, frame);
        bounds.y = Math.min(y2 + bottomGap, bounds.y2);

        lastWindow = win;
        lastFrame = frame;
    }

    // 最后一个窗口补到底部
    if (lastWindow && lastFrame && (lastFrame.y + lastFrame.h) < bounds.y2) {
        lastFrame.h = bounds.y2 - lastFrame.y;
        moveWindow(lastWindow, lastFrame);
    }

    return w == null ? 0 : w;
}

// ---------------------------------------------------------------- 铺整个 Space

/**
 * 重新计算某个 Space 的索引表。
 *
 * 索引表是"窗口 → 它在第几列第几行"的映射。列一被删掉，
 * 后面所有列的编号都会往前挪一位，索引表必须跟着重建，
 * 否则拿着过期的列号去排版，窗口就会跑到莫名其妙的位置。
 */
function reindex(spaceId) {
    const columns = state.columns.get(spaceId);
    if (!columns) return;
    for (let col = 0; col < columns.length; col++) {
        const column = columns[col];
        for (let row = 0; row < column.length; row++) {
            state.index.set(column[row].id, { space: spaceId, col, row });
        }
    }
}

/**
 * 在布局里找某个窗口所在的列号；找不到返回 -1。
 *
 * 比查 state.index 更可靠：索引表可能因为列被删掉而过期，
 * 而这里永远是当前真实的情况。排版时找锚点列、删窗口时找它那一列，
 * 都应该用这个。
 */
function columnOf(spaceId, win) {
    const columns = state.columns.get(spaceId);
    if (!columns || !win) return -1;
    for (let c = 0; c < columns.length; c++) {
        const column = columns[c];
        for (const w of column) {
            if (w && w.id === win.id) return c;
        }
    }
    return -1;
}

/**
 * 清掉布局里已经死掉的窗口。
 *
 * 窗口被关掉时，AX 有时不会送 uIElementDestroyed 通知（应用被强杀、
 * 窗口是面板之类的情况）。但死掉的窗口 frame 是空的——这个查一下就知道，
 * 比去问"这个窗口还在不在"便宜得多。
 *
 * 不清理的话，这些死窗口会一直占着列，布局就错位了。
 */
function pruneDeadWindows(spaceId) {
    const columns = state.columns.get(spaceId);
    if (!columns) return 0;

    let removed = 0;
    let columnsRemoved = false;

    for (let col = columns.length - 1; col >= 0; col--) {
        const column = columns[col];
        for (let i = column.length - 1; i >= 0; i--) {
            const win = column[i];
            if (win && win.frame) continue;

            column.splice(i, 1);
            if (win) {
                state.index.delete(win.id);
                state.tracked.delete(win.id);
                state.expected.delete(win.id);
                state.floating.delete(win.id);
                const positions = state.xPositions.get(spaceId);
                if (positions) positions.delete(win.id);
                const anchor = state.anchors.get(spaceId);
                if (anchor === win.id) state.anchors.delete(spaceId);
            }
            removed++;
        }
        if (column.length === 0) {
            columns.splice(col, 1);
            columnsRemoved = true;
            // 叠放信息跟着列一起往前挪
            stack.removeColumn(spaceId, col);
        }
    }

    // ⚠️ 关键：列被删掉之后，后面所有列的编号都变了，
    // 索引表必须重建。否则排版时会拿着过期的列号，
    // 把锚点窗口当成左边的列铺到屏幕最左边——
    // 表现出来就是"窗口贴屏幕左边，右侧空出来"。
    if (columnsRemoved || removed > 0) {
        reindex(spaceId);
    }
    return removed;
}

/**
 * 把某个 Space 上的窗口平铺好。
 * @param {number} spaceId
 */
function tileSpace(spaceId) {
    const space = hs.screen.spaceForID(spaceId);
    if (!space || space.type !== "desktop") return;

    // 先把死掉的窗口清出去，否则它们会一直占着列
    pruneDeadWindows(spaceId);

    const screen = space.screen;
    if (!screen) return;

    const columns = state.columns.get(spaceId);
    if (!columns || columns.length === 0) return;

    // 锚点：当前焦点窗口（若它在本 Space 且是受管窗口）
    //
    // 焦点不在这个 Space 上的时候（比如你正在别的 Space 上干活，
    // 这边有个窗口被系统挪了一下），不要随便换一个锚点——那会让
    // 这个 Space 的布局莫名其妙地跳一下。记住上次的锚点，沿用它。
    const focused = hs.window.focusedWindow();
    let anchor = null;
    if (focused && !state.floating.has(focused.id) &&
        focused.spaces.some((s) => s.id === spaceId) &&
        state.index.has(focused.id)) {
        anchor = focused;
        state.anchors.set(spaceId, focused.id);
    } else {
        const remembered = state.anchors.get(spaceId);
        if (remembered != null) {
            const index = state.index.get(remembered);
            if (index && index.space === spaceId) {
                const win = state.tracked.get(remembered);
                if (win) anchor = win;
            }
            if (!anchor) state.anchors.delete(spaceId);
        }
    }
    if (!anchor) {
        // 实在没有就退而求其次：屏幕里最左边那个
        anchor = firstVisibleWindow(spaceId, screen.frame);
    }
    if (!anchor) return;

    const anchorIndex = windowIndex(anchor);
    if (!anchorIndex) return;

    // ⚠️ 用实际搜出来的列号，不要信索引表里的。
    // 索引表可能因为刚删过一列而过期（列号都偏大了），
    // 拿过期列号去铺左右两边的列，就会把锚点窗口自己当成
    // "左边那一列"铺到屏幕最左边——右侧就空出来了。
    const anchorCol = columnOf(spaceId, anchor);
    if (anchorCol < 0) return;

    const screenFrame = screen.frame;
    const leftMargin = screenFrame.x + config.screenMargin;
    const rightMargin = screenFrame.x + screenFrame.w - config.screenMargin;
    const canvas = getCanvas(screen);

    // 把锚点窗口夹回画布内
    const anchorFrame = animate.layoutFrame(anchor);
    if (!anchorFrame) return;
    const af = { x: anchorFrame.x, y: anchorFrame.y, w: anchorFrame.w, h: anchorFrame.h };
    af.x = Math.max(af.x, canvas.x);
    af.w = Math.min(af.w, canvas.w);
    af.h = Math.min(af.h, canvas.h);
    if (af.x + af.w > canvas.x + canvas.w) {
        af.x = canvas.x + canvas.w - af.w;
    }

    const column = columns[anchorCol];
    if (!column) return;

    if (stack.isStacked(spaceId, anchorCol)) {
        // 手风琴叠放：只有焦点窗口能改变展开的是哪一个，
        // 其它情况（比如后台重排时的兜底选择）保持原样
        if (focused && focused.id === anchor.id) {
            stack.setActiveRow(spaceId, anchorCol, anchorIndex.row + 1);
        }
        const bounds = { x: af.x, x2: null, y: canvas.y, y2: canvas.y + canvas.h };
        tileStackedColumn(column, bounds,
            stack.activeRow(spaceId, anchorCol), af.w);
    } else if (column.length === 1) {
        // 整列只有一个窗口：铺满整个画布
        af.y = canvas.y;
        af.h = canvas.h;
        moveWindow(anchor, af);
    } else {
        // 锚点保持自己的高度，其余窗口平分剩下的空间
        const n = column.length - 1;
        const bottomGap = gap("bottom");
        const h = Math.max(0, Math.floor((canvas.h - af.h - n * bottomGap) / n));
        const bounds = { x: af.x, x2: null, y: canvas.y, y2: canvas.y + canvas.h };
        tileColumn(column, bounds, h, af.w, anchor.id, af.h);
    }
    updateVirtualPositions(spaceId, column, af.x);

    // 向右铺
    let x = af.x + af.w + gap("right");
    for (let col = anchorCol + 1; col < columns.length; col++) {
        const bounds = {
            x: Math.min(x, rightMargin),
            x2: null,
            y: canvas.y,
            y2: canvas.y + canvas.h,
        };
        const width = tileOneColumn(spaceId, col, bounds);
        updateVirtualPositions(spaceId, columns[col], x);
        x = x + width + gap("right");
    }

    // 向左铺
    let x2 = af.x - gap("left");
    for (let col = anchorCol - 1; col >= 0; col--) {
        const bounds = {
            x: null,
            x2: Math.max(x2, leftMargin),
            y: canvas.y,
            y2: canvas.y + canvas.h,
        };
        const width = tileOneColumn(spaceId, col, bounds);
        updateVirtualPositions(spaceId, columns[col], x2 - width);
        x2 = x2 - width - gap("left");
    }
}

/**
 * 铺一列——按它是不是手风琴来决定用哪种铺法。
 */
function tileOneColumn(spaceId, col, bounds) {
    const columns = state.columns.get(spaceId);
    const column = columns ? columns[col] : null;
    if (!column || column.length === 0) return 0;

    if (stack.isStacked(spaceId, col)) {
        return tileStackedColumn(column, bounds, stack.activeRow(spaceId, col));
    }
    return tileColumn(column, bounds);
}

/** 当前 Space 的 id */
function currentSpaceId() {
    const space = hs.screen.focusedSpace();
    return space ? space.id : null;
}

module.exports = {
    Direction,
    gap,
    getCanvas,
    columnsFor,
    windowIndex,
    firstVisibleWindow,
    updateVirtualPositions,
    virtualPositions,
    moveWindow,
    consumeExpected,
    tileColumn,
    tileStackedColumn,
    tileOneColumn,
    tileSpace,
    reindex,
    columnOf,
    pruneDeadWindows,
    currentSpaceId,
};
