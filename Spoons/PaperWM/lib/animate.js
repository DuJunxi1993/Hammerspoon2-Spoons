// PaperWM — 过渡动画
//
// v1 是"瞬移"的：它用 setFrame(frame, 0) 专门把 macOS 的 200ms 窗口动画
// 关掉，因为平铺时同时动好几个窗口，动画会让画面乱成一团。
//
// 但二代不一样：二代要的是"看起来是滑过去"，而不是"啪一下换位置"。
// 所以这里自己实现补间动画：
//
//   · 所有动画共用**一个**定时器（不是每个窗口一个），
//     每帧把所有正在动的窗口往前推一步
//   · 缓动用 easeOutCubic，起步快、收尾慢，接近系统窗口动画的观感
//   · 动画过程中如果又有了新目标，就从**当前所在的位置**接着往新目标走，
//     不会跳
//   · 动画过程中窗口自己动了（用户拖了），就立刻取消动画，把控制权交回去
//
// 性能：一次平铺通常动 3~5 个窗口，每个窗口一次 setFrame 就是一次 AX 调用。
// 60Hz 跑 12 帧就是 60~70 次 AX 调用——比"瞬移"的 5 次多，但每次都只动
// 一点点位置，macOS 处理起来很轻。动画总时长 180ms，可以配置。

"use strict";

const state = require("./state");
const { config } = require("./config");

// 正在跑的动画：windowId -> { from, to, startAt, duration }
// 定时器只有一个
const running = new Map();
let timer = null;
let lastTick = 0;

// ---------------------------------------------------------------- 缓动

/**
 * easeOutCubic：起步快，收尾慢。
 * 和 macOS 自己的窗口动画观感接近。
 */
function easeOutCubic(t) {
    const p = 1 - t;
    return 1 - p * p * p;
}

/** 线性插值 */
function lerp(a, b, t) {
    return a + (b - a) * t;
}

// ---------------------------------------------------------------- 核心

/**
 * 把窗口移到目标位置。
 *
 * 有动画时走补间，没动画时直接跳。
 *
 * @param {object} win HSWindow
 * @param {object} frame { x, y, w, h }
 * @param {boolean=} instant 立刻到位，不做动画（拖动滑窗时用）
 */
function moveWindow(win, frame, instant) {
    if (!win || !frame) return false;

    // 比的是"这个窗口正要去哪儿"，不是"它现在在哪儿"。
    //
    // 有动画在跑的时候，这两件事不一样：窗口的实际位置还在半路上，
    // 动画终点才是它即将到达的地方。
    //
    // 拿实际位置去比会踩坑：比如窗口正在往屏幕外跑，而重排又要求
    // 它回到原位——实际位置和"要求的终点"恰好还没差出 0.5 像素，
    // 就被当成"位置没变，什么都不用做"，动画于是继续往屏幕外跑，
    // 最后窗口跑出屏幕，留下一大片空隙。
    const running_ = running.get(win.id);
    const current = running_ ? running_.to : win.frame;
    if (!current) return false;

    const same = Math.abs(current.x - frame.x) < 0.5 &&
                 Math.abs(current.y - frame.y) < 0.5 &&
                 Math.abs(current.w - frame.w) < 0.5 &&
                 Math.abs(current.h - frame.h) < 0.5;
    if (same) return false;

    if (instant || !config.animation || config.animationDuration <= 0) {
        cancel(win.id);
        apply(win, frame);
        return true;
    }

    start(win, current, frame);
    return true;
}

/** 真的把窗口挪到某个位置（同时记下期望值，好让 AX 事件别误判成用户拖动） */
function apply(win, frame) {
    const now = Date.now();
    const previous = state.expected.get(win.id);

    // 记下"最近几个值"，AX 事件滞后到达时还能对上
    const history = [];
    if (previous) {
        history.push({
            x: previous.x, y: previous.y, w: previous.w, h: previous.h,
        });
        for (const item of (previous.history || [])) {
            history.push(item);
            if (history.length >= 4) break;
        }
    }

    state.expected.set(win.id, {
        x: frame.x, y: frame.y, w: frame.w, h: frame.h,
        at: now,
        eps: config.frameEpsilon,
        history: history,
    });

    try {
        win.frame = new HSRect(frame.x, frame.y, frame.w, frame.h);
        return true;
    } catch (err) {
        state.expected.delete(win.id);
        console.error("PaperWM: 移动窗口失败：" + err.message);
        return false;
    }
}

/** 开始一段补间 */
function start(win, from, to) {
    const now = Date.now();
    const existing = running.get(win.id);

    // 已经在动画中了：从当前位置接着走，不要跳
    const startFrame = existing ? existing.current : from;

    running.set(win.id, {
        win: win,
        from: { x: startFrame.x, y: startFrame.y, w: startFrame.w, h: startFrame.h },
        to: { x: to.x, y: to.y, w: to.w, h: to.h },
        current: startFrame,
        startAt: now,
        duration: Math.max(16, config.animationDuration * 1000),   // 毫秒
    });

    ensureTimer();
}

/** 取消某个窗口的动画 */
function cancel(winId) {
    if (!running.has(winId)) return false;
    running.delete(winId);
    if (running.size === 0) stopTimer();
    return true;
}

/** 全部取消 */
function cancelAll() {
    running.clear();
    stopTimer();
}

/** 某个窗口当前应该在哪（动画进行中的插值位置） */
function currentFrame(winId) {
    const anim = running.get(winId);
    return anim ? anim.current : null;
}

/** 某个窗口最终会停在哪（动画的目标位置） */
function targetFrame(winId) {
    const anim = running.get(winId);
    return anim ? anim.to : null;
}

/**
 * 拿窗口的"布局意义上的"位置。
 *
 * 动画进行中时，win.frame 是中间值——排版要是拿它算，
 * 就会按还没到位的尺寸去排，动画结束后尺寸又对不上了。
 * 所以这里返回动画的目标值（没有动画时就是当前值）。
 */
function layoutFrame(win) {
    if (!win) return null;
    const target = running.get(win.id);
    if (target) return target.to;
    return win.frame;
}

/** 某个窗口是不是正在动 */
function isAnimating(winId) {
    return running.has(winId);
}

// ---------------------------------------------------------------- 定时器

function ensureTimer() {
    if (timer) return;
    // 每帧 16ms，约 60Hz
    timer = hs.timer.doEvery(1 / 60, tick);
    lastTick = Date.now();
}

function stopTimer() {
    if (!timer) return;
    timer.stop();
    timer = null;
}

/** 推进一步 */
function tick() {
    if (running.size === 0) {
        stopTimer();
        return;
    }

    const now = Date.now();
    const elapsed = now - lastTick;
    lastTick = now;

    for (const [winId, anim] of [...running]) {
        const t = anim.duration > 0 ? Math.min(1, (now - anim.startAt) / anim.duration) : 1;
        const e = easeOutCubic(t);

        const frame = {
            x: lerp(anim.from.x, anim.to.x, e),
            y: lerp(anim.from.y, anim.to.y, e),
            w: lerp(anim.from.w, anim.to.w, e),
            h: lerp(anim.from.h, anim.to.h, e),
        };
        anim.current = frame;

        if (t >= 1) {
            // 到位了：落在精确的目标值上，别留下小数点误差
            running.delete(winId);
            apply(anim.win, anim.to);
        } else {
            apply(anim.win, frame);
        }
    }

    if (running.size === 0) stopTimer();
}

/**
 * 动画过程中窗口自己动了？
 *
 * AX 回报的帧和动画当前帧差得太多，说明用户真的在拖它——
 * 这时候得把动画停掉，把控制权还给用户。
 */
function deviated(winId, actualFrame) {
    const anim = running.get(winId);
    if (!anim) return false;
    if (!actualFrame) return false;

    const current = anim.current;
    const drift = Math.max(
        Math.abs(actualFrame.x - current.x),
        Math.abs(actualFrame.y - current.y)
    );
    // 一帧最多移动"总距离 / 帧数"，留出足够的余量
    const tolerance = Math.max(40,
        (Math.abs(anim.to.x - anim.from.x) + Math.abs(anim.to.y - anim.from.y))
        / (anim.duration / 16) * 2);

    return drift > tolerance;
}

module.exports = {
    moveWindow,
    apply,
    cancel,
    cancelAll,
    currentFrame,
    targetFrame,
    layoutFrame,
    isAnimating,
    deviated,
    easeOutCubic,
    running,
};
