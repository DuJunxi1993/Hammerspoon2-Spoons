// PaperWM — 手风琴叠放（stacked columns）
//
// 一列窗口可以切换成"手风琴"：列里的窗口叠在一起，每个只露出一点标题栏，
// 焦点窗口是展开的那个，其余的只露出一条边。点那条边就能展开它。
//
// v1 把 stacked / active_row 这两个字段直接挂在列的 table 上，
// 交换、slurp、barf 的时候跟着列一起走。JS 的数组挂不了额外字段，
// 所以这里用一张平行的表：spaceId -> Map<col, {stacked, activeRow}>。
// 列的位置变了，这里的记录也要跟着搬。

"use strict";

const state = require("./state");
const { config } = require("./config");

/** 某个 Space 的叠放信息表 */
function tableFor(spaceId) {
    let table = state.stacks.get(spaceId);
    if (!table) {
        table = new Map();
        state.stacks.set(spaceId, table);
    }
    return table;
}

/**
 * 某一列是不是手风琴。
 *
 * config.columnLayout === "stacked" 时默认所有列都是手风琴，
 * 相当于上游的"默认列布局方式"。
 */
function isStacked(spaceId, col) {
    const table = state.stacks.get(spaceId);
    const info = table ? table.get(col) : null;
    if (info && info.stacked) return true;
    if (info && info.stacked === false) return false;
    return config.columnLayout === "stacked";
}

/** 设置某一列的叠放状态 */
function setStacked(spaceId, col, stacked) {
    const table = tableFor(spaceId);
    const info = table.get(col) || { stacked: false, activeRow: 1 };
    info.stacked = !!stacked;
    if (!info.stacked) info.activeRow = 1;
    table.set(col, info);
}

/** 设置某一列展开的是第几个窗口（从 1 开始） */
function setActiveRow(spaceId, col, row) {
    const table = tableFor(spaceId);
    const info = table.get(col) || { stacked: false, activeRow: 1 };
    info.activeRow = row;
    table.set(col, info);
}

/**
 * 取某一列展开的是第几个窗口，超出范围就夹回来。
 */
function activeRow(spaceId, col) {
    const table = state.stacks.get(spaceId);
    const info = table ? table.get(col) : null;
    const row = info && info.activeRow ? info.activeRow : 1;

    const columns = state.columns.get(spaceId);
    const column = columns ? columns[col] : null;
    const size = column ? column.length : 0;
    if (size === 0) return 1;
    return Math.max(1, Math.min(row, size));
}

/**
 * 某个窗口要离开叠放的列之前调用：把展开的行往上挪一挪，
 * 这样剩下的那个展开的窗口还是原来那个。
 */
function rowRemoved(spaceId, col, row) {
    const table = state.stacks.get(spaceId);
    const info = table ? table.get(col) : null;
    if (!info || !info.stacked) return;
    const active = info.activeRow || 1;
    if (row <= active) info.activeRow = Math.max(1, active - 1);
}

/**
 * 列的位置变了（比如左右交换），把叠放信息也搬一下。
 *
 * @param {number} spaceId
 * @param {number} from 原来的列号
 * @param {number} to 现在的列号
 */
function moveColumn(spaceId, from, to) {
    const table = state.stacks.get(spaceId);
    if (!table) return;

    const info = table.get(from);
    table.delete(from);
    if (info) table.set(to, info);
}

/**
 * 在第 at 列插入一个新列时，把叠放信息整体往后挪。
 */
function insertColumn(spaceId, at) {
    const table = state.stacks.get(spaceId);
    if (!table) return;
    for (const key of [...table.keys()]) {
        if (key >= at) {
            const info = table.get(key);
            table.delete(key);
            table.set(key + 1, info);
        }
    }
}

/**
 * 删掉一列（比如列空了），后面的列号要往前挪，叠放信息也得跟着挪。
 */
function removeColumn(spaceId, col) {
    const table = state.stacks.get(spaceId);
    if (!table) return;
    table.delete(col);
    for (const key of [...table.keys()]) {
        if (key > col) {
            const info = table.get(key);
            table.delete(key);
            table.set(key - 1, info);
        }
    }
}

module.exports = {
    isStacked,
    setStacked,
    setActiveRow,
    activeRow,
    rowRemoved,
    moveColumn,
    insertColumn,
    removeColumn,
};
