// PaperWM — AX 窗口分类
//
// 二代没有 hs.window:isMaximizable()，这里自己用 AX 属性判断。
//
// 上游 PaperWM 有这么一段（windows.lua）：
//
//     -- ignore windows that have a zoom button, but are not maximizable
//     local allow_non_maximizable = Windows.PaperWM.allow_non_maximizable_window
//         and Windows.PaperWM.allow_non_maximizable_window(add_window)
//     if not allow_non_maximizable and not add_window:isMaximizable() then
//         Windows.PaperWM.logger.d("ignoring non-maximizable window")
//     end
//
// 少了这一段，macOS 原生的文件选择面板就会被当成普通窗口纳入布局：
// 它的 AXSubrole 是 AXStandardWindow（isStandard 为真，拦不住），
// 但它没有放大/最小化/全屏按钮，根本不该参与平铺。
//
// 实际表现：面板一冒出来就占掉一列，整个布局被挤歪；面板一关，
// 又触发"列被删掉但索引表没重建"的老问题，窗口就卡在屏幕左边、
// 右边空一大块，点左边缘也没反应。
//
// 所以这里的判断不止看"能不能最大化"，还看是不是模态、是不是面板，
// 覆盖面比上游更宽一点——上游那条规则本来就够用，但我们顺手
// 把其它几类临时窗口也一起挡掉。

"use strict";

const { config } = require("./config");

// 窗口的"可最大化"属性不会变，按 id 缓存，省掉重复的 AX 查询。
// 实测读 8 个窗口的 zoom 按钮要 3~9ms，缓存后基本是 0。
const maximizableCache = new Map();

// 临时窗口的判定结果也缓存一下（同一批窗口经常被反复问）
const transientCache = new Map();

/** 取窗口的 AX 元素，失败返回 null */
function axElementOf(win) {
    if (!win) return null;
    try {
        const el = win.axElement();
        return el || null;
    } catch (err) {
        return null;
    }
}

/** 读一个 AX 属性，读不到返回 undefined（抛错时） */
function attr(el, name) {
    if (!el) return undefined;
    try {
        return el.attributeValue(name);
    } catch (err) {
        return undefined;
    }
}

/**
 * 这个 AX 元素还活着吗？
 *
 * 重要：HS2 的 attributeValue 内部是 `try?`，**AX 查询失败和属性不存在
 * 返回的都是 null**，两者分不开。应用正忙的时候（加载、索引、跑脚本），
 * 整组查询都会超时返回 null——这时如果把 null 当成"属性不存在"，
 * 就会得出"这个窗口没有放大按钮 → 不能最大化 → 弹出窗口"这种
 * 完全错误的结论，正在布局里的窗口会被踢出去。
 *
 * 所以先读一个必然存在的属性（AXRole）探活，活着才敢相信后面的 null。
 *
 * @returns {boolean|null} null = 探不了活，不下结论
 */
function isAlive(el) {
    if (!el) return null;
    const role = attr(el, "AXRole");
    if (role === undefined) return null;   // 抛错了
    if (role === null) return false;       // 读回来了但是空的 → 没响应
    return true;
}

/**
 * 窗口能不能最大化？
 *
 * 也就是有没有一个**可用**的放大按钮。按钮存在但被禁用（比如
 * 只能改大小的小窗口），同样算不能最大化。
 *
 * @returns {boolean|null}
 *   true/false —— 结论明确
 *   null      —— AX 读不出来，不下结论（调用方应该保守处理，
 *                不要因为一次读取失败就把已经在布局里的窗口踢出去）
 */
function isMaximizable(win) {
    if (!win) return false;
    const id = win.id;
    if (maximizableCache.has(id)) return maximizableCache.get(id);

    const el = axElementOf(win);
    if (!el) return null;                   // 读不到 AX 元素，不下结论

    const alive = isAlive(el);
    if (alive !== true) return null;        // AX 没响应，不下结论，也不缓存

    const zoom = attr(el, "AXZoomButton");
    if (zoom === undefined) return null;

    if (!zoom) {
        // AX 活着，AXZoomButton 确实是空的 → 真的没有放大按钮
        maximizableCache.set(id, false);
        return false;
    }

    const enabled = attr(zoom, "AXEnabled");
    if (enabled === undefined) return null;

    const result = !!enabled;
    maximizableCache.set(id, result);
    return result;
}

/**
 * 窗口是不是临时窗口（不该参与平铺）。
 *
 * 判据：
 *   · AXModal 为真        —— 模态对话框
 *   · identifier 是面板   —— macOS 原生的 open-panel / save-panel
 *   · AXSubrole 是对话框 —— 保险
 *
 * @returns {boolean|null} null = AX 读不出来，不下结论
 */
function isTransient(win) {
    if (!win) return true;
    const id = win.id;
    if (transientCache.has(id)) return transientCache.get(id);

    const el = axElementOf(win);
    if (!el) return null;   // 读不到，不下结论，也不缓存

    const alive = isAlive(el);
    if (alive !== true) return null;   // AX 没响应，不下结论

    let result = false;

    // 模态
    if (attr(el, "AXModal") === true) {
        result = true;
    }

    // Apple 的文件选择面板：identifier 是 open-panel / save-panel
    if (!result) {
        const identifier = attr(el, "AXIdentifier");
        if (typeof identifier === "string" && /panel$/i.test(identifier)) {
            result = true;
        }
    }

    // 对话框类（正常情况下 isStandard 已经拦掉了，这里兜底）
    if (!result) {
        const subrole = attr(el, "AXSubrole");
        if (subrole === "AXDialog" || subrole === "AXSystemDialog" ||
            subrole === "AXSheet" || subrole === "AXFloatingWindow" ||
            subrole === "AXOverlayWindow" || subrole === "AXToolWindow") {
            result = true;
        }
    }

    transientCache.set(id, result);
    return result;
}

/** 忘掉某个窗口的缓存（窗口没了以后调用） */
function forget(winId) {
    maximizableCache.delete(winId);
    transientCache.delete(winId);
}

/** 清空全部缓存 */
function clearCache() {
    maximizableCache.clear();
    transientCache.clear();
}

module.exports = {
    isMaximizable,
    isTransient,
    forget,
    clearCache,
};
