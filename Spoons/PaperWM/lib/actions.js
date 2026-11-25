// PaperWM — 窗口动作
//
// v1 的 windows.lua + actions.lua 的移植：焦点移动、窗口交换、
// slurp/barf、浮动窗口、宽度调整等。

"use strict";

const state = require("./state");
const { config } = require("./config");
const tiling = require("./tiling");
const stack = require("./stack");
const animate = require("./animate");
const { Direction } = tiling;

// ---------------------------------------------------------------- 内部工具

function focusedWindow() {
    return hs.window.focusedWindow();
}

/** 窗口所在的 Space id（取第一个） */
function spaceIdOf(win) {
    const spaces = win.spaces;
    return spaces && spaces.length ? spaces[0].id : null;
}

// ---------------------------------------------------------------- 增删窗口

/**
 * 在数组里按窗口 id 找位置。
 *
 * 不能用 Array.indexOf(win)：hs.window.focusedWindow() 每次返回的都是
 * 新的包装对象，和布局里存的那个不是同一个实例，按引用比较永远找不到。
 * 窗口的身份是它的 id。
 */
function indexOfWindow(list, win) {
    if (!list || !win) return -1;
    for (let i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === win.id) return i;
    }
    return -1;
}

/**
 * 把窗口加入布局。
 * @returns {number|null} 加入后所在 Space 的 id
 */
function addWindow(win) {
    if (!win) return null;
    if (state.index.has(win.id)) return null;
    if (state.floating.has(win.id)) return null;

    const spaceId = spaceIdOf(win);
    if (spaceId == null) return null;

    const columns = tiling.columnsFor(spaceId);
    const anchor = state.prevFocused;

    // 找到插入位置：优先插在上一个焦点窗口右边（窗口新开时它通常就是
    // 刚获得焦点前的那个窗口），否则按屏幕上的水平位置插入
    let insertAt = columns.length;
    if (anchor && anchor.id !== win.id) {
        const anchorIndex = state.index.get(anchor.id);
        if (anchorIndex && anchorIndex.space === spaceId) {
            insertAt = anchorIndex.col + 1;
        }
    } else {
        const frame = animate.layoutFrame(win);
        if (frame) {
            const center = frame.x + frame.w / 2;
            for (let col = 0; col < columns.length; col++) {
                const first = columns[col][0];
                const otherFrame = first && animate.layoutFrame(first);
                if (!otherFrame) continue;
                if (center < otherFrame.x + otherFrame.w / 2) {
                    insertAt = col;
                    break;
                }
            }
        }
    }

    columns.splice(insertAt, 0, [win]);
    stack.insertColumn(spaceId, insertAt);
    reindex(spaceId);
    state.tracked.set(win.id, win);

    // 新窗口给一个默认宽度（屏幕宽度的比例）
    const defaultWidth = appDefaultWidth(win);
    if (defaultWidth != null) {
        const frame = animate.layoutFrame(win);
        if (frame) {
            frame.w = defaultWidth;
            // 立刻生效：宽度是后面排版时要读的，不能等动画走完
            tiling.moveWindow(win, frame, true);
        }
    }

    return spaceId;
}

/**
 * 新窗口的默认宽度（像素）。
 *
 * 按 config.appWidths 里配的"应用名或 Bundle ID → 比例"算，
 * 没配就用 config.defaultWidth。比例是相对画布宽度，不是屏幕宽度。
 */
function appDefaultWidth(win) {
    const hasAppWidths = config.appWidths && Object.keys(config.appWidths).length > 0;
    if (!hasAppWidths && typeof config.defaultWidth !== "number") return null;

    let ratio = null;
    const app = win.application;
    if (app && hasAppWidths) {
        if (config.appWidths[app.name] != null) ratio = config.appWidths[app.name];
        else if (config.appWidths[app.bundleID] != null) ratio = config.appWidths[app.bundleID];
    }
    if (typeof ratio !== "number") ratio = config.defaultWidth;
    if (typeof ratio !== "number" || ratio <= 0) return null;

    const screen = win.screen;
    if (!screen) return null;

    const canvas = tiling.getCanvas(screen);
    const width = Math.floor((canvas.w * ratio) + 0.5);
    return Math.max(1, Math.min(canvas.w, width));
}

/**
 * 把窗口从布局里移除。
 *
 * 只管布局，不管浮动标记——浮动状态由调用方管理（toggleFloating 会先
 * 摘出布局再打标记，顺序反了的话标记会被这里抹掉）。
 */
function removeWindow(win, skipFocus) {
    if (!win) return null;
    const index = state.index.get(win.id);
    if (!index) return null;

    if (!skipFocus) {
        // 找一个相邻的窗口顶上
        for (const direction of [Direction.DOWN, Direction.UP, Direction.LEFT, Direction.RIGHT]) {
            if (focusWindow(direction, index)) break;
        }
    }

    // ⚠️ 实际搜出来的那一列，不要信索引表里的列号。
    // 索引表可能因为刚删过一列而过期（后面所有列的编号都偏大了），
    // 拿过期列号去删，会把无辜的窗口删掉、留下一列空洞。
    const col = tiling.columnOf(index.space, win);
    const columns = tiling.columnsFor(index.space);
    if (col >= 0) {
        const column = columns[col];
        if (column) {
            const at = indexOfWindow(column, win);
            if (at >= 0) column.splice(at, 1);
            if (column.length === 0) {
                columns.splice(col, 1);
                stack.removeColumn(index.space, col);
            }
        }
    }

    state.index.delete(win.id);
    state.tracked.delete(win.id);
    state.expected.delete(win.id);

    const positions = state.xPositions.get(index.space);
    if (positions) positions.delete(win.id);

    if (state.prevFocused && state.prevFocused.id === win.id) {
        state.prevFocused = null;
    }

    reindex(index.space);
    return index.space;
}

/** 重新计算某个 Space 的索引表（实现在 tiling.js，两边共用一份） */
function reindex(spaceId) {
    tiling.reindex(spaceId);
}

// ---------------------------------------------------------------- 焦点

/**
 * 把焦点移到相邻的窗口。
 * @param {number} direction Direction.LEFT/RIGHT/UP/DOWN/NEXT/PREVIOUS
 * @param {object=} focusedIndex 当前窗口的索引，不传则取当前焦点窗口
 */
function focusWindow(direction, focusedIndex, noWrap) {
    let index = focusedIndex;
    if (!index) {
        const win = focusedWindow();
        if (!win) return null;
        index = state.index.get(win.id);
    }
    if (!index) return null;

    const columns = tiling.columnsFor(index.space);
    let target = null;

    if (direction === Direction.LEFT || direction === Direction.RIGHT) {
        // 走进手风琴列时，落在展开的那个窗口上
        const targetCol = index.col + direction;
        if (stack.isStacked(index.space, targetCol)) {
            target = columns[targetCol] &&
                     columns[targetCol][stack.activeRow(index.space, targetCol) - 1];
        }
        // 左右：先在当前列里往下找，再看相邻列
        for (let row = index.row; row >= 0 && !target; row--) {
            target = columns[targetCol] && columns[targetCol][row];
        }

        // 走到两端了还想要 → 循环到另一头
        if (!target && !noWrap && config.infiniteLoopWindow && columns.length > 1) {
            const wrapCol = direction === Direction.LEFT ? columns.length - 1 : 0;
            if (stack.isStacked(index.space, wrapCol)) {
                target = columns[wrapCol] &&
                         columns[wrapCol][stack.activeRow(index.space, wrapCol) - 1];
            } else {
                for (let row = index.row; row >= 0 && !target; row--) {
                    target = columns[wrapCol] && columns[wrapCol][row];
                }
            }
            if (target) {
                // 把绕回来的那列挪到另一头，视觉上就是"滚过去了"
                const moved = columns.splice(wrapCol, 1)[0];
                if (direction === Direction.LEFT) {
                    columns.push(moved);
                } else {
                    columns.unshift(moved);
                }
                stack.moveColumn(index.space, wrapCol,
                    direction === Direction.LEFT ? columns.length - 1 : 0);
                reindex(index.space);
                tiling.tileSpace(index.space);
            }
        }
    } else if (direction === Direction.UP || direction === Direction.DOWN) {
        const column = columns[index.col];
        const row = index.row + (direction === Direction.UP ? -1 : 1);
        target = column ? column[row] : null;

        // 上下也循环
        if (!target && !noWrap && config.infiniteLoopWindow && column && column.length > 1) {
            target = column[direction === Direction.UP ? column.length - 1 : 0];
        }
    } else if (direction === Direction.NEXT || direction === Direction.PREVIOUS) {
        const diff = direction === Direction.NEXT ? 1 : -1;
        const column = columns[index.col];
        target = column ? column[index.row + diff] : null;
        if (!target) {
            // 换到相邻列：NEXT 取下一列的第一个，PREVIOUS 取上一列的最后一个
            const adjacent = columns[index.col + diff];
            if (adjacent) {
                target = diff < 0 ? adjacent[adjacent.length - 1] : adjacent[0];
            }
        }
    }

    if (!target) return null;

    target.focus();
    return target;
}

/** 焦点移到第 n 个窗口（从左到右、从上到下） */
function focusWindowAt(n) {
    const spaceId = tiling.currentSpaceId();
    if (spaceId == null) return null;
    const columns = state.columns.get(spaceId);
    if (!columns) return null;

    let i = 1;
    for (const column of columns) {
        for (const win of column) {
            if (i === n) {
                win.focus();
                return win;
            }
            i++;
        }
    }
    return null;
}

/** 焦点移到当前 Space 最左边的窗口 */
function focusWindowFirst() {
    const spaceId = tiling.currentSpaceId();
    if (spaceId == null) return null;
    const columns = state.columns.get(spaceId);
    if (!columns || !columns[0] || !columns[0][0]) return null;
    columns[0][0].focus();
    return columns[0][0];
}

/** 焦点移到当前 Space 最右边的窗口 */
function focusWindowLast() {
    const spaceId = tiling.currentSpaceId();
    if (spaceId == null) return null;
    const columns = state.columns.get(spaceId);
    if (!columns || !columns.length) return null;
    const last = columns[columns.length - 1];
    if (!last || !last.length) return null;
    last[last.length - 1].focus();
    return last[last.length - 1];
}

// ---------------------------------------------------------------- 交换

/**
 * 把焦点窗口和相邻窗口交换位置。
 * 左右交换时整列一起换，上下交换时只换列内的位置。
 */
function swapWindows(direction) {
    const win = focusedWindow();
    if (!win) return false;
    const index = state.index.get(win.id);
    if (!index) return false;

    const columns = tiling.columnsFor(index.space);

    if (direction === Direction.LEFT || direction === Direction.RIGHT) {
        const currentColumn = columns[index.col];
        const targetColumn = columns[index.col + direction];
        if (!currentColumn || !targetColumn) return false;

        // 把焦点窗口挪到目标列的位置
        const targetFrame = targetColumn[0] && animate.layoutFrame(targetColumn[0]);
        const frame = animate.layoutFrame(win);
        if (targetFrame && frame) {
            frame.x = targetFrame.x;
            tiling.moveWindow(win, frame);
        }

        // 交换两列
        const removed = columns.splice(index.col, 1)[0];
        columns.splice(index.col + direction, 0, removed);
        // 叠放标记跟着列一起换位置
        stack.moveColumn(index.space, index.col, index.col + direction);
    } else {
        const column = columns[index.col];
        if (!column) return false;
        const targetRow = index.row + (direction === Direction.UP ? -1 : 1);
        if (targetRow < 0 || targetRow >= column.length) return false;
        const removed = column.splice(index.row, 1)[0];
        column.splice(targetRow, 0, removed);
    }

    reindex(index.space);
    tiling.tileSpace(index.space);
    return true;
}

// ---------------------------------------------------------------- 尺寸

/** 把窗口水平居中，不改变大小和垂直位置 */
function centerWindow() {
    const win = focusedWindow();
    if (!win) return false;
    const frame = animate.layoutFrame(win);
    const screen = win.screen;
    if (!frame || !screen) return false;

    const sf = screen.frame;
    frame.x = sf.x + Math.floor((sf.w - frame.w) / 2);
    tiling.moveWindow(win, frame);

    const spaceId = spaceIdOf(win);
    if (spaceId != null) tiling.tileSpace(spaceId);
    return true;
}

// 记住每个窗口"全宽之前"的宽度
const widthCache = new Map();

/** 把窗口拉成整个屏幕宽度；再按一次恢复 */
function toggleWindowFullWidth() {
    const win = focusedWindow();
    if (!win) return false;
    const screen = win.screen;
    const frame = animate.layoutFrame(win);
    if (!screen || !frame) return false;

    const canvas = tiling.getCanvas(screen);
    const cached = widthCache.get(win.id);

    if (cached != null) {
        frame.x = canvas.x + Math.floor((canvas.w - cached) / 2);
        frame.w = cached;
        widthCache.delete(win.id);
    } else {
        widthCache.set(win.id, frame.w);
        frame.x = canvas.x;
        frame.w = canvas.w;
    }

    tiling.moveWindow(win, frame);
    const spaceId = spaceIdOf(win);
    if (spaceId != null) tiling.tileSpace(spaceId);
    return true;
}

/**
 * 按比例循环调整窗口宽/高。
 * @param {number} direction Direction.WIDTH / Direction.HEIGHT
 * @param {number} order Direction.ASCENDING / Direction.DESCENDING
 */
function cycleWindowSize(direction, order) {
    const win = focusedWindow();
    if (!win) return false;
    const screen = win.screen;
    const frame = animate.layoutFrame(win);
    if (!screen || !frame) return false;

    const canvas = tiling.getCanvas(screen);
    const isWidth = direction === Direction.WIDTH;

    // 宽用左右间隙的平均值，高用上下间隙的平均值
    const gapSize = isWidth
        ? (tiling.gap("left") + tiling.gap("right")) / 2
        : (tiling.gap("top") + tiling.gap("bottom")) / 2;

    const areaSize = isWidth ? canvas.w : canvas.h;
    const frameSize = isWidth ? frame.w : frame.h;

    const sizes = config.windowRatios.map((ratio) => ratio * (areaSize + gapSize) - gapSize);

    let newSize;
    if (order === Direction.ASCENDING) {
        newSize = sizes[0];
        for (const size of sizes) {
            if (size > frameSize + 10) {
                newSize = size;
                break;
            }
        }
    } else {
        newSize = sizes[sizes.length - 1];
        for (let i = sizes.length - 1; i >= 0; i--) {
            if (sizes[i] < frameSize - 10) {
                newSize = sizes[i];
                break;
            }
        }
    }

    if (isWidth) {
        frame.x = frame.x + Math.floor((frame.w - newSize) / 2);
        frame.w = newSize;
    } else {
        frame.y = Math.max(canvas.y, frame.y + Math.floor((frame.h - newSize) / 2));
        frame.h = newSize;
        if (frame.y + frame.h > canvas.y + canvas.h) {
            frame.y = canvas.y + canvas.h - frame.h;
        }
    }

    tiling.moveWindow(win, frame);
    const spaceId = spaceIdOf(win);
    if (spaceId != null) tiling.tileSpace(spaceId);
    return true;
}

/**
 * 按比例微调窗口宽/高。
 * @param {number} direction Direction.WIDTH / Direction.HEIGHT
 * @param {number} scale 1 增大，-1 减小
 */
function increaseWindowSize(direction, scale) {
    const win = focusedWindow();
    if (!win) return false;
    const screen = win.screen;
    const frame = animate.layoutFrame(win);
    if (!screen || !frame) return false;

    const canvas = tiling.getCanvas(screen);

    if (direction === Direction.WIDTH) {
        const diff = canvas.w * 0.1 * scale;
        const newSize = Math.max(diff, Math.min(canvas.w, frame.w + diff));
        frame.x = frame.x + Math.floor((frame.w - newSize) / 2);
        frame.w = newSize;
    } else {
        const diff = canvas.h * 0.1 * scale;
        const newSize = Math.max(diff, Math.min(canvas.h, frame.h + diff));
        frame.y = frame.y + Math.floor((frame.h - newSize) / 2);
        frame.h = newSize;
        if (frame.y + frame.h > canvas.y + canvas.h) {
            frame.y = canvas.y + canvas.h - frame.h;
        }
    }

    tiling.moveWindow(win, frame);
    const spaceId = spaceIdOf(win);
    if (spaceId != null) tiling.tileSpace(spaceId);
    return true;
}

// ---------------------------------------------------------------- 列的拆分与合并

/** 把当前列里除焦点窗口外的窗口，平分剩下的高度 */
function tileColumnEqually(column, spaceId) {
    if (!column || column.length === 0) return;
    const first = column[0];
    const screen = first.screen;
    if (!screen) return;

    const canvas = tiling.getCanvas(screen);
    const bottomGap = tiling.gap("bottom");
    const h = Math.max(0, Math.floor((canvas.h - (column.length - 1) * bottomGap) / column.length));

    const bounds = { x: null, x2: null, y: canvas.y, y2: canvas.y + canvas.h };
    const firstFrame = animate.layoutFrame(first);
    if (firstFrame) bounds.x = firstFrame.x;
    tiling.tileColumn(column, bounds, h);
}

/** 把焦点窗口挪到左边的列里（slurp） */
function slurpWindow() {
    const win = focusedWindow();
    if (!win) return false;
    const index = state.index.get(win.id);
    if (!index) return false;

    const columns = tiling.columnsFor(index.space);
    const currentColumn = columns[index.col];
    const targetColumn = columns[index.col - 1];
    if (!currentColumn || !targetColumn) return false;

    // 窗口离开叠放的列之前，先把展开的行调整好
    stack.rowRemoved(index.space, index.col, index.row + 1);

    const at = indexOfWindow(currentColumn, win);
    if (at >= 0) currentColumn.splice(at, 1);
    targetColumn.push(win);

    // 源列被搬空了就把这一列去掉，别留一个空列在中间
    if (currentColumn.length === 0) {
        columns.splice(index.col, 1);
        stack.removeColumn(index.space, index.col);
    }

    reindex(index.space);

    // 目标列是手风琴的话，被 slurp 进来的窗口就是展开的那个
    if (stack.isStacked(index.space, index.col - 1)) {
        stack.setActiveRow(index.space, index.col - 1, targetColumn.length);
    } else {
        tileColumnEqually(targetColumn, index.space);
    }
    tiling.tileSpace(index.space);
    return true;
}

/** 把焦点窗口拆出来，放到右边新开的一列（barf） */
function barfWindow() {
    const win = focusedWindow();
    if (!win) return false;
    const index = state.index.get(win.id);
    if (!index) return false;

    const columns = tiling.columnsFor(index.space);
    const currentColumn = columns[index.col];
    if (!currentColumn || currentColumn.length === 1) return false;

    stack.rowRemoved(index.space, index.col, index.row + 1);

    const at = indexOfWindow(currentColumn, win);
    if (at >= 0) currentColumn.splice(at, 1);

    const targetIndex = index.col + 1;
    columns.splice(targetIndex, 0, [win]);
    stack.insertColumn(index.space, targetIndex);
    // 新列不是手风琴（除非全局默认就是）
    if (config.columnLayout !== "stacked") {
        stack.setStacked(index.space, targetIndex, false);
    }

    // 把新窗口放到目标列该在的位置
    const frame = animate.layoutFrame(win);
    const previous = columns[targetIndex - 1] && columns[targetIndex - 1][0];
    const previousFrame = previous && animate.layoutFrame(previous);
    if (frame && previousFrame) {
        frame.x = previousFrame.x + previousFrame.w + tiling.gap("right");
        tiling.moveWindow(win, frame);
    }

    reindex(index.space);
    if (!stack.isStacked(index.space, index.col)) {
        tileColumnEqually(currentColumn, index.space);
    }
    tiling.tileSpace(index.space);
    return true;
}

/**
 * 切换焦点窗口所在列的"手风琴"状态。
 *
 * 叠起来之后：每个窗口露出 accordionPeek 像素的标题栏，
 * 焦点窗口是展开的那个。点别的那条边就能展开它。
 */
function toggleStack() {
    const win = focusedWindow();
    if (!win) return false;
    const index = state.index.get(win.id);
    if (!index) return false;

    const columns = tiling.columnsFor(index.space);
    const column = columns[index.col];
    if (!column) return false;

    const stacked = stack.isStacked(index.space, index.col);
    stack.setStacked(index.space, index.col, !stacked);

    if (stacked) {
        // 取消叠放：列恢复等分高度（宽度和位置不变，不用整个 Space 重排）
        if (column.length > 1) tileColumnEqually(column, index.space);
    } else {
        stack.setActiveRow(index.space, index.col, index.row + 1);
        tiling.tileSpace(index.space);
    }
    return true;
}

/**
 * 把焦点窗口和它左边的列各占一半屏幕。
 *
 * 左边那列占左半边，当前列占右半边。
 */
function splitScreen() {
    const win = focusedWindow();
    if (!win) return false;
    const index = state.index.get(win.id);
    if (!index) return false;

    const columns = tiling.columnsFor(index.space);
    const leftColumn = columns[index.col - 1];
    const currentColumn = columns[index.col];
    if (!leftColumn || !currentColumn) return false;

    const screen = win.screen;
    if (!screen) return false;
    const canvas = tiling.getCanvas(screen);
    const halfWidth = Math.floor(canvas.w / 2);

    const leftBounds = { x: canvas.x, x2: null, y: canvas.y, y2: canvas.y + canvas.h };
    const currentBounds = {
        x: canvas.x + halfWidth,
        x2: null,
        y: canvas.y,
        y2: canvas.y + canvas.h,
    };

    tiling.tileColumn(leftColumn, leftBounds, null, halfWidth - tiling.gap("left"));
    tiling.tileColumn(currentColumn, currentBounds, null, halfWidth);
    tiling.tileSpace(index.space);
    return true;
}

/**
 * 把焦点窗口贴到画布的左边缘或右边缘，
 * 让它成为平铺视口的最左/最右锚点。
 */
function moveToSideEdge(direction) {
    if (direction !== Direction.LEFT && direction !== Direction.RIGHT) return false;

    const win = focusedWindow();
    if (!win) return false;
    const screen = win.screen;
    const frame = animate.layoutFrame(win);
    if (!screen || !frame) return false;

    const canvas = tiling.getCanvas(screen);
    if (direction === Direction.LEFT) {
        frame.x = canvas.x;
    } else {
        frame.x = Math.max(canvas.x, (canvas.x + canvas.w) - frame.w);
    }
    tiling.moveWindow(win, frame);

    const spaceId = spaceIdOf(win);
    if (spaceId != null) tiling.tileSpace(spaceId);
    return true;
}

// ---------------------------------------------------------------- 浮动窗口

function isFloating(win) {
    return state.floating.has(win.id);
}

/**
 * 把窗口设成浮动窗口。
 *
 * @param {object} win HSWindow
 * @param {boolean} transient true = 弹出式窗口（文件选择面板之类）。
 *        它用完就没了，不写进 userdefaults；下次启动也不会被恢复。
 * @returns {number|null} 如果窗口原来在布局里，返回它所在 Space 的 id
 */
function makeFloating(win, transient) {
    if (!win) return null;
    // 先从布局里摘出来（万一它已经在布局里了），
    // 顺序不能反——removeWindow 会把浮动标记抹掉。
    const spaceId = removeWindow(win, true);
    state.floating.add(win.id);
    if (transient) {
        state.transient.add(win.id);
    } else {
        state.transient.delete(win.id);
        persistFloating();
    }
    return spaceId;
}

/**
 * 取消浮动状态。
 *
 * @param {boolean} keepTransient 内部用：只是把弹出式窗口从浮动里摘掉，
 *        不写 userdefaults。
 */
function unfloat(win, keepTransient) {
    if (!win) return null;
    const wasTransient = state.transient.has(win.id);
    state.floating.delete(win.id);
    state.transient.delete(win.id);
    if (!keepTransient && !wasTransient) persistFloating();
    return null;
}

/** 切换窗口的浮动状态 */
function toggleFloating(win) {
    const target = win || focusedWindow();
    if (!target) return false;

    const floating = !isFloating(target);
    if (floating) {
        // 顺序很重要：先从布局里摘出来，再打浮动标记。
        // 反过来的话 removeWindow 会把刚打上的标记抹掉。
        const spaceId = removeWindow(target, true);
        state.floating.add(target.id);
        state.transient.delete(target.id);
        persistFloating();
        target.focus();
        // 摘走一个窗口之后，剩下的要重新排一下
        if (spaceId != null) tiling.tileSpace(spaceId);
    } else {
        state.floating.delete(target.id);
        state.transient.delete(target.id);
        persistFloating();
        const spaceId = addWindow(target);
        if (spaceId != null) {
            target.focus();
            tiling.tileSpace(spaceId);
        }
    }
    return floating;
}

/** 聚焦所有浮动窗口（依次点亮，再把焦点还回去） */
function focusFloating() {
    const original = focusedWindow();
    for (const win of hs.window.visibleWindows()) {
        if (!state.index.has(win.id) && state.floating.has(win.id)) {
            win.focus();
        }
    }
    if (original) original.focus();
}

/** 保存浮动窗口列表 */
function persistFloating() {
    try {
        // 弹出式窗口（文件选择面板之类）用完就没了，不该存进 userdefaults
        const ids = [...state.floating].filter((id) => !state.transient.has(id));
        hs.userdefaults.set(config.floatingKey, JSON.stringify(ids));
    } catch (err) {
        console.error("PaperWM: 保存浮动窗口列表失败：" + err.message);
    }
}

/** 恢复浮动窗口列表 */
function restoreFloating() {
    try {
        const raw = hs.userdefaults.get(config.floatingKey);
        if (typeof raw !== "string" || !raw) return;
        const ids = JSON.parse(raw);
        if (!Array.isArray(ids)) return;
        state.floating.clear();
        state.transient.clear();
        for (const id of ids) state.floating.add(id);
    } catch (err) {
        console.error("PaperWM: 恢复浮动窗口列表失败：" + err.message);
    }
}

module.exports = {
    indexOfWindow,
    addWindow,
    removeWindow,
    reindex,
    focusWindow,
    focusWindowAt,
    focusWindowFirst,
    focusWindowLast,
    swapWindows,
    centerWindow,
    moveToSideEdge,
    toggleWindowFullWidth,
    cycleWindowSize,
    increaseWindowSize,
    slurpWindow,
    barfWindow,
    toggleStack,
    splitScreen,
    isFloating,
    makeFloating,
    unfloat,
    toggleFloating,
    focusFloating,
    persistFloating,
    restoreFloating,
    spaceIdOf,
};
