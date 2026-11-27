// PaperWM — 热键
//
// v1 用 hs.spoons.bindHotkeysToSpec(spec, mapping) 把一张
// { actionName: {{mods}, key} } 的表绑到动作表上。
//
// 二代没有 bindHotkeysToSpec，但 hs.hotkey.bind(mods, key, onPressed)
// 能做同样的事。这里保留 v1 的调用方式：
//
//   PaperWM.bindHotkeys({
//       focus_left: { { "alt", "ctrl" }, "j" },
//       ...
//   })
//
// mods 用数组 ["alt","cmd"]，key 是键名或字符。

"use strict";

const state = require("./state");
const actions = require("./actions");
const spaces = require("./spaces");
const tiling = require("./tiling");
const { config } = require("./config");
const { Direction } = tiling;

const bound = new Map();

/** 动作表：名字 -> 执行函数 */
function actionTable() {
    return {
        // 生命周期
        refresh_windows: () => require("./events").rebuildSpace(tiling.currentSpaceId()),
        refresh_windows_forcedly: () => require("./events").rebuildSpace(tiling.currentSpaceId(), true),
        dump_state: () => dumpState(),

        // 焦点
        focus_left:   () => actions.focusWindow(Direction.LEFT),
        focus_right:  () => actions.focusWindow(Direction.RIGHT),
        focus_up:     () => actions.focusWindow(Direction.UP),
        focus_down:   () => actions.focusWindow(Direction.DOWN),
        focus_prev:   () => actions.focusWindow(Direction.PREVIOUS),
        focus_next:   () => actions.focusWindow(Direction.NEXT),
        focus_window_first: () => actions.focusWindowFirst(),
        focus_window_last:  () => actions.focusWindowLast(),

        // 交换
        swap_left:    () => actions.swapWindows(Direction.LEFT),
        swap_right:   () => actions.swapWindows(Direction.RIGHT),
        swap_up:      () => actions.swapWindows(Direction.UP),
        swap_down:    () => actions.swapWindows(Direction.DOWN),

        // 尺寸与位置
        center_window:      () => actions.centerWindow(),
        anchor_window_left: () => actions.moveToSideEdge(Direction.LEFT),
        anchor_window_right:() => actions.moveToSideEdge(Direction.RIGHT),
        full_width:         () => actions.toggleWindowFullWidth(),
        increase_width:      () => actions.increaseWindowSize(Direction.WIDTH, 1),
        decrease_width:      () => actions.increaseWindowSize(Direction.WIDTH, -1),
        increase_height:     () => actions.increaseWindowSize(Direction.HEIGHT, 1),
        decrease_height:     () => actions.increaseWindowSize(Direction.HEIGHT, -1),
        cycle_width:         () => actions.cycleWindowSize(Direction.WIDTH, Direction.ASCENDING),
        cycle_height:        () => actions.cycleWindowSize(Direction.HEIGHT, Direction.ASCENDING),
        reverse_cycle_width: () => actions.cycleWindowSize(Direction.WIDTH, Direction.DESCENDING),
        reverse_cycle_height:() => actions.cycleWindowSize(Direction.HEIGHT, Direction.DESCENDING),

        // 列的拆分与合并
        slurp_in:   () => actions.slurpWindow(),
        barf_out:   () => actions.barfWindow(),
        toggle_stack: () => actions.toggleStack(),
        split_screen: () => actions.splitScreen(),

        // 浮动窗口
        toggle_floating: () => actions.toggleFloating(),
        focus_floating:  () => actions.focusFloating(),

        // Space
        switch_space_l: () => spaces.incrementSpace(Direction.LEFT),
        switch_space_r: () => spaces.incrementSpace(Direction.RIGHT),
        switch_recent_space: () => spaces.switchToRecentSpace(),

        // 把窗口移到相邻显示器的 Space 上
        move_window_l: () => spaces.moveWindowToScreen(Direction.LEFT),
        move_window_r: () => spaces.moveWindowToScreen(Direction.RIGHT),
        move_window_u: () => spaces.moveWindowToScreen(Direction.UP),
        move_window_d: () => spaces.moveWindowToScreen(Direction.DOWN),
    };
}

/**
 * 把 v1 那种热键写法拆开。
 *
 * v1（Lua）：{ { "alt", "cmd" }, "j" }
 * JS 对应：[["alt", "cmd"], "j"]
 * 也接受：{ mods: ["alt", "cmd"], key: "j" }
 *
 * 二代的基础组合键换成了 ⌃⌥，所以实际写的是 [["alt", "ctrl"], "j"]。
 */
function parseSpec(spec) {
    if (!spec) return null;
    // 数组写法：第一个元素是修饰键数组
    if (Array.isArray(spec)) {
        if (Array.isArray(spec[0])) {
            return { mods: spec[0], key: spec[1] };
        }
        if (spec.mods || spec.key) {
            return { mods: spec.mods || [], key: spec.key };
        }
        return null;
    }
    // 对象写法
    if (typeof spec === "object" && (spec.mods || spec.key)) {
        return { mods: spec.mods || [], key: spec.key };
    }
    return null;
}

/**
 * 绑定热键。
 * @param {object} mapping { actionName: { {mods}, key } }
 */
function bindHotkeys(mapping) {
    stopHotkeys();
    if (!mapping) return;

    // 记下这张表，start() 时会重新绑——这样在 TogglePanel 里关掉再打开
    // PaperWM，热键不会丢
    for (const [name, spec] of Object.entries(mapping)) {
        config.hotkeys[name] = spec;
    }

    const table = actionTable();

    for (const [name, spec] of Object.entries(mapping)) {
        const action = table[name];
        if (!action) {
            // 数字后缀的动作（focus_window_1、move_window_1 等）单独处理
            const numbered = /^(\w+)_([1-9])$/.exec(name);
            if (numbered) {
                bindNumbered(name, numbered[1], Number(numbered[2]), spec);
                continue;
            }
            console.error("PaperWM: 未知动作 '" + name + "'");
            continue;
        }

        const parsed = parseSpec(spec);
        if (!parsed) {
            console.error("PaperWM: 热键 '" + name + "' 的写法不对");
            continue;
        }

        const hotkey = hs.hotkey.bind(parsed.mods, parsed.key, () => {
            try {
                action();
            } catch (err) {
                console.error("PaperWM: 动作 '" + name + "' 出错：" + err.message);
            }
        }, null, null);

        if (!hotkey) {
            console.error("PaperWM: 热键 '" + name + "' 绑定失败");
            continue;
        }
        bound.set(name, hotkey);
    }
}

/** focus_window_N / move_window_N 这类带编号的动作 */
function bindNumbered(fullName, base, n, spec) {
    const parsed = parseSpec(spec);
    if (!parsed) {
        console.error("PaperWM: 热键 '" + fullName + "' 的写法不对");
        return;
    }

    let action = null;
    if (base === "focus_window") {
        action = () => actions.focusWindowAt(n);
    } else if (base === "move_window") {
        action = () => spaces.moveWindowToSpace(n);
    } else {
        console.error("PaperWM: 未知动作 '" + fullName + "'");
        return;
    }
    const hotkey = hs.hotkey.bind(parsed.mods, parsed.key, () => {
        try {
            action();
        } catch (err) {
            console.error("PaperWM: 动作 '" + fullName + "' 出错：" + err.message);
        }
    }, null, null);

    if (!hotkey) {
        console.error("PaperWM: 热键 '" + fullName + "' 绑定失败");
        return;
    }
    bound.set(fullName, hotkey);
}

/** 解绑全部热键 */
function stopHotkeys() {
    for (const hotkey of bound.values()) {
        try {
            hotkey.destroy();
        } catch (err) {
            // 忽略
        }
    }
    bound.clear();
}

/** 打印当前布局，调试用 */
function dumpState() {
    const lines = ["--- PaperWM 状态 ---"];
    for (const [spaceId, columns] of state.columns) {
        lines.push("Space " + spaceId + ":");
        for (let col = 0; col < columns.length; col++) {
            lines.push("  列 " + (col + 1) + ":");
            for (const win of columns[col]) {
                lines.push("    " + (win.title || "(无标题)") + " [id=" + win.id + "]");
            }
        }
    }
    if (state.floating.size) {
        lines.push("浮动窗口: " + [...state.floating].join(", "));
    }
    console.log(lines.join("\n"));
    return lines.join("\n");
}

module.exports = {
    bindHotkeys,
    stopHotkeys,
    actionTable,
    dumpState,
    bound,
};
