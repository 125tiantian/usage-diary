/* =======================================================
   额度小日记 · 主逻辑
   章节目录：
   1. 配置与常量
   2. 数据存储（localStorage）
   3. 时间和窗口计算
   4. 兑换率计算（含高峰/非高峰）
   5. 状态管理（state）
   6. 渲染：顶栏 & 状态卡
   7. 渲染：输入卡（含步进按钮交互）
   8. 渲染：汇率卡
   9. 渲染：周节奏曲线
   10. 渲染：5h 历史
   11. 设置面板
   12. 工具函数 & Toast
   13. 初始化
   ======================================================= */

/* =================================================
   1. 配置与常量
   ================================================= */

const STORAGE_KEY = 'limit-diary-v1';
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
// 5h 窗口起点取整粒度：十分钟。Claude 现在按"首次使用那一刻起算 5h"刷新，
// 会落在非整点，抹到最近的十分钟既贴近真实又不让界面冒出零碎分钟。
const WINDOW_STEP_MS = 10 * 60 * 1000;

const DEFAULT_SETTINGS = {
  weeklyResetDay: 6,      // 0=日, 6=六；当前规则的"星期"，从 weeklyRules 末尾派生
  weeklyResetHour: 18,    // 18 点；同上
  peakStartHour: 21,      // 北京时间 21 点
  peakEndHour: 3,         // 次日 3 点
  peakWeekdayOnly: true,  // 仅工作日
  // 周起点规则的时间线。每条 { from, day, hour } 描述"从这一刻起规则切换为 (day, hour)"。
  // 第一条 from===0 是"史前期"，按 day/hour 切；后续每条都是一次重置或手动改时间，按 from 起每 7 天一轮。
  // weekAnchor / preAnchorDay / preAnchorHour 是从这条链派生出来的兼容字段，给可能还在跑旧代码的端兜底，
  // 不参与新代码的计算（getWeekStart/getWeekEnd 完全走 weeklyRules）。
  weeklyRules: [{ from: 0, day: 6, hour: 18 }],
  weekAnchor: null,
  preAnchorDay: null,
  preAnchorHour: null,
  // 设置上次"真实"被修改的时间戳，用于云同步的版本判断。
  // 只有设置内容真的改了才会更新（仅打开关掉面板不更新），
  // 这样 pull 时才能正确判断"云端 vs 本地谁的设置更新"，不会被本地虚假的新时间戳覆盖。
  lastModifiedAt: 0,
  // "立即重置"按下的时刻们（硬重置闸门）。起点早于某道闸门的 5h 窗口到闸门即视为结束，
  // 之后的记录必开新窗口——对应"官方临时重置额度时 5h 也一起清零"的真实行为。
  hardResets: [],
};

// 配色 —— 不写死，从 CSS 变量动态读取，主题切换时会重新刷新
// 这样深色 / 浅色模式下图表颜色也会自动跟着变
let COLORS = {};

function refreshColors() {
  const s = getComputedStyle(document.documentElement);
  const get = (name) => s.getPropertyValue(name).trim();
  COLORS = {
    c5h:        get('--c-5h'),
    c5hDeep:    get('--c-5h-deep'),
    c5hSoft:    get('--c-5h-soft'),
    cWeekly:    get('--c-weekly'),
    cWeeklyDeep: get('--c-weekly-deep'),
    cWeeklySoft: get('--c-weekly-soft'),
    cRate:      get('--c-rate'),
    cRateDeep:  get('--c-rate-deep'),
    cHoney:     get('--c-honey'),
    cWarn:      get('--c-warn'),
    cSafe:      get('--c-safe'),
    cIdeal:     get('--c-ideal'),
    cPredict:   get('--c-predict'),
    text:       get('--text-primary'),
    textSec:    get('--text-secondary'),
    textMute:   get('--text-mute'),
    divider:    get('--c-divider'),
    bgCard:     get('--bg-card'),
  };
}

/* =================================================
   2. 数据存储
   ================================================= */

// 把老格式（weekAnchor + preAnchor*）迁成 weeklyRules 链。幂等：跑过的不会再跑一遍。
// 也处理"loadData 后第一条不是 from=0 / 数组共享 DEFAULT_SETTINGS"等防御性兜底。
function migrateSettings(s) {
  if (!s || typeof s !== 'object') return s;
  // hardResets 统一整理：深拷贝（防和 DEFAULT_SETTINGS 共享）、去掉非法值、排序去重
  s.hardResets = Array.isArray(s.hardResets)
    ? [...new Set(s.hardResets.filter((t) => typeof t === 'number' && isFinite(t)))].sort((a, b) => a - b)
    : [];
  if (Array.isArray(s.weeklyRules) && s.weeklyRules.length > 0) {
    // 已是新格式：深拷贝一份，避免和 DEFAULT_SETTINGS 共享数组；并保证第一条对齐 from=0
    // kind 是规则的"出身"标记（如 'realign' = 立即重置后自动归位的那条），要原样保留，
    // 重置时间线靠它区分"正常周期"和"用户改过设置"
    s.weeklyRules = s.weeklyRules.map((r) => (
      r.kind ? { from: r.from, day: r.day, hour: r.hour, kind: r.kind }
             : { from: r.from, day: r.day, hour: r.hour }
    ));
    if (s.weeklyRules[0].from !== 0) {
      s.weeklyRules.unshift({ from: 0, day: s.weeklyResetDay, hour: s.weeklyResetHour });
    }
    return s;
  }
  // 老格式 → 新格式：史前期取 preAnchor，没存就 fallback 到 weekly*（和老 getWeekStart 兜底一致）
  const initialDay = s.preAnchorDay != null ? s.preAnchorDay : s.weeklyResetDay;
  const initialHour = s.preAnchorHour != null ? s.preAnchorHour : s.weeklyResetHour;
  const rules = [{ from: 0, day: initialDay, hour: initialHour }];
  if (s.weekAnchor != null) {
    rules.push({ from: s.weekAnchor, day: s.weeklyResetDay, hour: s.weeklyResetHour });
  }
  s.weeklyRules = rules;
  return s;
}

// 往规则链末尾追加一条。同一整点重复触发就替换最后一条（避免连点出一堆重复段）；
// 顺手把 weeklyResetDay/Hour 派生成最新值，给依然按这两个字段读的展示代码用。
function appendWeeklyRule(settings, rule) {
  if (!settings.weeklyRules) settings.weeklyRules = [];
  const rules = settings.weeklyRules;
  const last = rules[rules.length - 1];
  if (last && rule.from < last.from) {
    console.warn('appendWeeklyRule: rule.from 比末尾还早，忽略', rule, last);
    return;
  }
  const cloned = rule.kind
    ? { from: rule.from, day: rule.day, hour: rule.hour, kind: rule.kind }
    : { from: rule.from, day: rule.day, hour: rule.hour };
  if (last && last.from === rule.from) {
    rules[rules.length - 1] = cloned;
  } else {
    rules.push(cloned);
  }
  settings.weeklyResetDay = rule.day;
  settings.weeklyResetHour = rule.hour;
}

// 把规则链派生成老字段。saveData 写盘前调一次，让万一还在跑旧代码的端
// （或老格式 import）能照常读到 weekAnchor/preAnchor*；新代码自己只看 weeklyRules。
function deriveLegacyFields(settings) {
  const rules = settings && settings.weeklyRules;
  if (!Array.isArray(rules) || rules.length === 0) return;
  const last = rules[rules.length - 1];
  settings.weeklyResetDay = last.day;
  settings.weeklyResetHour = last.hour;
  if (rules.length >= 2) {
    const prev = rules[rules.length - 2];
    settings.weekAnchor = last.from;
    settings.preAnchorDay = prev.day;
    settings.preAnchorHour = prev.hour;
  } else {
    settings.weekAnchor = null;
    settings.preAnchorDay = null;
    settings.preAnchorHour = null;
  }
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('读取本地数据失败', e);
    return null;
  }
}

function saveData() {
  try {
    deriveLegacyFields(state.settings);
    const payload = {
      records: state.records,
      notes: state.notes,
      settings: state.settings,
      version: 1,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn('保存数据失败', e);
    showToast('保存失败 (｡•́︿•̀｡)');
  }
}

/* =================================================
   3. 时间和窗口计算
   ================================================= */

// 把时间戳向下取整到整点小时。仅用于 weekly 重置锚点——周重置是"周几+整点"规则，
// 仍按整点对齐；5h 窗口才改用十分钟（floorToStep）。
function floorToHour(ts) {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

// 把时间戳向下取整到最近的十分钟
function floorToStep(ts) {
  const d = new Date(ts);
  d.setSeconds(0, 0);
  d.setMinutes(Math.floor(d.getMinutes() / 10) * 10);
  return d.getTime();
}

// 已经落在十分钟刻度就不动，否则向上取到下一个十分钟刻度
function ceilToStep(ts) {
  const floored = floorToStep(ts);
  return floored === ts ? ts : floored + WINDOW_STEP_MS;
}

// 窗口起点之后的第一道硬重置闸门；没有则 null
function firstHardResetAfter(startTs, settings) {
  const list = settings && Array.isArray(settings.hardResets) ? settings.hardResets : [];
  for (const h of list) {
    if (h > startTs) return h;
  }
  return null;
}

// 某个起点的窗口在 ts 时刻是否还活着：5h 没走完，也没被硬重置切断
function isWindowAliveAt(startTs, ts, settings) {
  if (ts >= startTs + FIVE_HOURS_MS) return false;
  const h = firstHardResetAfter(startTs, settings);
  return h == null || ts < h;
}

// 给 ts 开新窗口时的起点：十分钟取整，但不能取整到最近一次硬重置之前去，
// 否则新窗口会"生在闸门前"、刚开就被判定为已截断
function newWindowIdFor(ts, settings) {
  let id = floorToStep(ts);
  const list = settings && Array.isArray(settings.hardResets) ? settings.hardResets : [];
  for (const h of list) {
    if (h <= ts && h > id) id = h;
  }
  return id;
}

// 给定一个时间戳和上一条记录，判断它属于哪个 5h 窗口
function determineWindowId(ts, lastRecord) {
  if (!lastRecord) return newWindowIdFor(ts, state.settings);
  if (isWindowAliveAt(lastRecord.windowId, ts, state.settings)) return lastRecord.windowId;
  return newWindowIdFor(ts, state.settings);
}

// 把"按星期几 + 整点"的规则算出 ts 所在那一周的起点。这是老逻辑，抽成独立函数
// 方便 anchor 之前的历史周调用——那时候用的 day/hour 是改 anchor 之前的旧值。
function getWeekStartByDayHour(ts, day, hour) {
  const d = new Date(ts);
  const wd = d.getDay();
  const h = d.getHours();

  let daysBack = (wd - day + 7) % 7;
  if (daysBack === 0 && h < hour) {
    daysBack = 7;
  }
  const result = new Date(d);
  result.setDate(d.getDate() - daysBack);
  result.setHours(hour, 0, 0, 0);
  return result.getTime();
}

// 给"现在"和一个目标 (day, hour)，算出下一次落在该时刻的整点时间戳。
// 用于 closeSettings：用户改周重置规则时，新规则应当从下一个目标时刻开始生效，
// 而不是"现在"——这样本周自然延续到目标时刻，显示和实际重置时刻能对齐。
// 当前正好就在目标时刻（同 day 同 hour 整点）时，按"已经过这一刻"算，跳到下周。
function nextOccurrence(now, targetDay, targetHour) {
  const d = new Date(now);
  const wd = d.getDay();
  const h = d.getHours();
  let daysAhead = (targetDay - wd + 7) % 7;
  if (daysAhead === 0 && h >= targetHour) daysAhead = 7;
  const result = new Date(d);
  result.setDate(d.getDate() + daysAhead);
  result.setHours(targetHour, 0, 0, 0);
  return result.getTime();
}

// 给定一个时间戳，按 weeklyRules 时间线判断属于哪一周。
// 找到 ts 所在的那一段（最后一条 from <= ts 的规则）：
// - 若是史前期（rules[0]，from===0）：按 day/hour 规则切；
// - 若是某次切换之后的段：按 r.from 起每 7 天一轮切。
// 翻 ◀ 跨过 anchor 时会自动落到上一段对应的边界，保持历史周原来的样子。
function getWeekStart(ts, settings) {
  const rules = settings && Array.isArray(settings.weeklyRules) ? settings.weeklyRules : null;
  if (!rules || rules.length === 0) {
    // 兜底：理论上 migrateSettings 已经保证不会跑到这里
    return getWeekStartByDayHour(ts, settings.weeklyResetDay, settings.weeklyResetHour);
  }
  let idx = 0;
  for (let i = 0; i < rules.length; i++) {
    if (rules[i].from <= ts) idx = i;
    else break;
  }
  const r = rules[idx];
  if (idx === 0) {
    return getWeekStartByDayHour(ts, r.day, r.hour);
  }
  const diff = ts - r.from;
  const weeksSince = Math.floor(diff / (7 * ONE_DAY_MS));
  return r.from + weeksSince * 7 * ONE_DAY_MS;
}

// 当前周的结束时间。正常是 weekStart + 7 天，但如果本周跨过了"下一段规则的起点"，
// 就截断到那一段的 from——这样上一段最后一周不会穿到下一段的"新一周"里。
function getWeekEnd(weekStart, settings) {
  const raw = weekStart + 7 * ONE_DAY_MS;
  const rules = settings && Array.isArray(settings.weeklyRules) ? settings.weeklyRules : null;
  if (!rules) return raw;
  for (const r of rules) {
    if (weekStart < r.from && raw > r.from) return r.from;
  }
  return raw;
}

// 把"距下次重置的毫秒数"格式化成一句治愈风的短文案：
// < 1 小时 → "马上就重置啦 ✨"
// < 24 小时 → "还剩 Xh"（用 Math.floor，不虚高，避免 6 小时显示成 1 天的误导)
// ≥ 24 小时 → "还剩 X 天"
function formatRemainingUntilReset(ms) {
  const ONE_HOUR_MS = 60 * 60 * 1000;
  if (ms < ONE_HOUR_MS) return '马上就重置啦 ✨';
  if (ms < ONE_DAY_MS) {
    const hours = Math.floor(ms / ONE_HOUR_MS);
    return `还剩 ${hours}h`;
  }
  const days = Math.floor(ms / ONE_DAY_MS);
  return `还剩 ${days} 天`;
}

// 找"本周"（从上次 weekly 重置到下次重置之间）里最后一笔记录。
// 为什么要这个：weekly 的显示值必须只看本周的数据，
// 不然新一周刚开始、还没记录时，用"全局最后一笔"就会残留上一周的 82%、
// 状态卡和输入卡的 weekly 都会被误导。5h 的逻辑完全不受影响——
// 5h 窗口是独立的滚动周期，和 weekly 的固定重置时间没关系。
function getLastRecordThisWeek(records, settings) {
  if (!records || records.length === 0) return null;
  const weekStart = getWeekStart(Date.now(), settings);
  const weekEnd = getWeekEnd(weekStart, settings);
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.timestamp >= weekStart && r.timestamp < weekEnd) {
      return r;
    }
  }
  return null;
}

// 美国 DST：3 月第 2 个周日 ~ 11 月第 1 个周日
function getUSDSTBounds(year) {
  const mar1 = new Date(year, 2, 1);
  const start = new Date(year, 2, 1 + ((7 - mar1.getDay()) % 7) + 7);
  const nov1 = new Date(year, 10, 1);
  const end = new Date(year, 10, 1 + ((7 - nov1.getDay()) % 7));
  return { start, end };
}

function isUSinDST(d) {
  const dt = d || new Date();
  const { start, end } = getUSDSTBounds(dt.getFullYear());
  return dt >= start && dt < end;
}

// 高峰时段：按 Anthropic 官方公告内置，跟着美国 DST 自动切
// 夏令时北京 20-02、冬令时北京 21-03，永远仅工作日
function getPeakBand(d) {
  const dst = isUSinDST(d);
  return { start: dst ? 20 : 21, end: dst ? 2 : 3 };
}

function isPeakHour(ts) {
  const d = new Date(ts);
  const { start, end } = getPeakBand(d);
  const day = d.getDay();
  const hour = d.getHours();

  let inWindow = false;
  let weekdayToCheck = day;

  if (start < end) {
    inWindow = hour >= start && hour < end;
  } else {
    // 跨午夜：start 到 24 算今天、0 到 end 算昨天延续
    if (hour >= start) {
      inWindow = true;
    } else if (hour < end) {
      inWindow = true;
      weekdayToCheck = (day + 6) % 7;
    }
  }

  if (!inWindow) return false;
  if (weekdayToCheck === 0 || weekdayToCheck === 6) return false;
  return true;
}

// 从所有 records 计算出窗口结构
function computeWindows(records) {
  const map = new Map();
  for (const r of records) {
    if (!map.has(r.windowId)) {
      map.set(r.windowId, {
        id: r.windowId,
        startTime: r.windowId,
        endTime: r.windowId + FIVE_HOURS_MS,
        records: [],
      });
    }
    map.get(r.windowId).records.push(r);
  }
  // 每个窗口内按时间排序
  for (const w of map.values()) {
    w.records.sort((a, b) => a.timestamp - b.timestamp);
    w.firstValue = w.records[0].fiveH;
    w.lastValue = w.records[w.records.length - 1].fiveH;
    w.maxValue = Math.max(...w.records.map(r => r.fiveH));
    // 被"立即重置"切断的窗口：实际终点提前到闸门那一刻
    const cut = firstHardResetAfter(w.startTime, state.settings);
    w.wasCut = cut != null && cut < w.endTime;
    w.effectiveEnd = w.wasCut ? cut : w.endTime;
  }
  return Array.from(map.values()).sort((a, b) => a.startTime - b.startTime);
}

// 算某个窗口起点能挪到的合法范围 [minStart, maxStart]，十分钟对齐
function getWindowAdjustRange(target, allWindows) {
  const idx = allWindows.findIndex((w) => w.id === target.id);
  const prevWin = idx > 0 ? allWindows[idx - 1] : null;
  const nextWin = idx >= 0 && idx < allWindows.length - 1 ? allWindows[idx + 1] : null;
  const recs = target.records;
  const firstTs = recs[0].timestamp;
  const lastTs = recs[recs.length - 1].timestamp;

  // 起点下界：自家最晚一笔记录留得住 + 不能侵前一个窗口的地盘
  // （前一个窗口被硬重置截断时，它的地盘只到闸门为止，不占满整个 5h）
  let minStart = lastTs - FIVE_HOURS_MS + 1;
  if (prevWin) minStart = Math.max(minStart, prevWin.effectiveEnd != null ? prevWin.effectiveEnd : prevWin.endTime);
  // 也不能挪到自家记录之前最近一道硬重置闸门的前面，不然窗口会被闸门腰斩
  const gates = state.settings && Array.isArray(state.settings.hardResets) ? state.settings.hardResets : [];
  for (const h of gates) {
    if (h <= firstTs && h > minStart) minStart = h;
  }
  minStart = ceilToStep(minStart);

  // 起点上界：自家最早一笔记录留得住 + 不能侵后一个窗口的地盘
  let maxStart = firstTs;
  if (nextWin) maxStart = Math.min(maxStart, nextWin.startTime - FIVE_HOURS_MS);
  maxStart = floorToStep(maxStart);

  return { minStart, maxStart };
}

// 当前是否还处于活跃窗口（5h 没走完、也没被硬重置切断的窗口）
function getCurrentWindow(windows) {
  if (windows.length === 0) return null;
  const last = windows[windows.length - 1];
  if (isWindowAliveAt(last.startTime, Date.now(), state.settings)) return last;
  return null;
}

/* =================================================
   4. 汇率计算（以 weekly 跳格为锚点）
   ================================================= */

function median(arr) {
  if (arr.length === 0) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// 扫描所有记录，找出每次 weekly 跳格事件，算出每一格的 5h 成本
function computeRateSamples(records) {
  if (records.length < 2) return [];

  const sorted = records.slice().sort((a, b) => a.timestamp - b.timestamp);
  const samples = [];

  let segStart = sorted[0];
  let segStartIdx = 0;

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];

    // 跨过周界（含硬重置）一律重开分段：哪怕新周第一笔的 weekly 数值没降下来
    // （比如上周收尾本来就很低），也不能让旧周期的 5h 消耗串进新周期的格子里
    if (getWeekStart(cur.timestamp, state.settings) !== getWeekStart(prev.timestamp, state.settings)) {
      segStart = cur;
      segStartIdx = i;
      continue;
    }

    if (cur.weekly < prev.weekly) {
      segStart = cur;
      segStartIdx = i;
      continue;
    }

    const jump = cur.weekly - prev.weekly;
    if (jump <= 0) continue;

    let cost;
    if (cur.windowId === segStart.windowId) {
      cost = cur.fiveH - segStart.fiveH;
    } else {
      // 跨桶刷新（可能多次），按窗口分段累加
      cost = 0;
      let currentWid = segStart.windowId;
      let segBase = segStart.fiveH;
      let lastIn = segStart.fiveH;
      for (let j = segStartIdx + 1; j <= i; j++) {
        if (sorted[j].windowId !== currentWid) {
          cost += lastIn - segBase;
          currentWid = sorted[j].windowId;
          segBase = 0;
        }
        lastIn = sorted[j].fiveH;
      }
      cost += lastIn - segBase;
    }

    if (jump > 1) cost = cost / jump;

    if (cost > 0) {
      samples.push({ cost, timestamp: cur.timestamp });
    }

    segStart = cur;
    segStartIdx = i;
  }

  return samples;
}

// 当前汇率 = 最近 3 格的中位数
function computeCurrentRate(samples) {
  if (samples.length < 3) return null;
  const recent = samples.slice(-3).map(s => s.cost);
  return median(recent);
}

// 本周汇率 = 本周所有格的中位数
function computeWeeklyRate(samples, settings) {
  const weekStart = getWeekStart(Date.now(), settings);
  const weekEnd = getWeekEnd(weekStart, settings);
  const weekSamples = samples.filter(s => s.timestamp >= weekStart && s.timestamp < weekEnd);
  if (weekSamples.length === 0) return null;
  return median(weekSamples.map(s => s.cost));
}

// --- 以下高峰相关函数保留但不再被调用（高峰机制暂停）---
function computePeakRate(windows, settings) {
  return null;
}
function computeOffPeakRate(windows, settings) {
  return null;
}

/* =================================================
   5. 状态管理
   ================================================= */

const state = {
  records: [],
  notes: {},
  settings: { ...DEFAULT_SETTINGS },

  // UI 状态
  draft5h: 0,
  draftWeekly: 0,
  draftPrev5h: 0,        // 这次记录之前同窗口的最后一个 5h 值
  draftPrevWeekly: 0,    // 同上，weekly
  draftWindowId: null,   // 这次记录将要落入哪个窗口
  isNewWindow: false,    // 是不是要新开一个窗口
  isNewWeek: false,      // 本周是否还没有任何记录（= 这笔是本周第一笔）
  selectedHistoryWindowId: null,
  selectedWeekStart: null,       // null = 当前周
  adjustOpen: false,             // 历史卡里"调起点"面板是否展开
};

// 根据现状重置 draft（每次保存后/页面初始化时调用）
function resetDraft() {
  const records = state.records;
  const lastRecord = records[records.length - 1];
  // weekly 的"上次值"要用本周最后一笔；新一周刚开始、本周还没记录时
  // lastInWeek 是 null，prevWeekly 就归零，输入卡不会被上一周末的 82% 卡住。
  const lastInWeek = getLastRecordThisWeek(records, state.settings);
  const now = Date.now();

  // 1. 决定 draftWindowId（基于 5h 窗口，和 weekly 重置无关）
  let windowId;
  let prev5h = 0;
  let prevWeekly = lastInWeek ? lastInWeek.weekly : 0;
  let isNew = false;

  if (lastRecord && isWindowAliveAt(lastRecord.windowId, now, state.settings)) {
    // 还在最近一个 5h 窗口里（没满 5h、也没被硬重置切断）
    windowId = lastRecord.windowId;
    prev5h = lastRecord.fiveH;
    isNew = false;
  } else {
    // 需要开新 5h 窗口
    windowId = newWindowIdFor(now, state.settings);
    prev5h = 0;
    isNew = true;
  }

  state.draftWindowId = windowId;
  state.draftPrev5h = prev5h;
  state.draftPrevWeekly = prevWeekly;
  state.draft5h = prev5h;
  state.draftWeekly = prevWeekly;
  state.isNewWindow = isNew;
  // 本周还没有任何记录 → 这笔是本周第一笔，输入卡会给 weekly 加 "🌱 新一周" 标签
  state.isNewWeek = !lastInWeek;
}

// 当时间流逝导致 5h 窗口切换、或 weekly 周期刚刚重置时，
// 输入卡里的"当前窗口"标签和"上次值"可能会变得过时。
// 这个函数在用户"没有正在编辑"的前提下，用当前时间重新计算 draft 状态，
// 只在实际有变化时才重绘输入卡——避免无意义的重绘和动画闪烁。
// 调用时机：每分钟的 setInterval + 页面从后台切回前台时（visibilitychange）。
function maybeRefreshDraft() {
  // 判断"用户没有正在编辑"：草稿值仍然等于上次保存的值
  const untouched =
    state.draft5h === state.draftPrev5h &&
    state.draftWeekly === state.draftPrevWeekly;

  // 即使用户正在编辑，也要检查窗口是否已经过期。
  // 如果旧窗口已经结束了，那用户正在编辑的值是针对一个已经不存在的窗口，
  // 继续显示旧窗口的标签会误导——必须强制刷新。
  // 只有"窗口没变 + 用户在编辑"的组合才跳过。
  if (!untouched) {
    const lastRecord = state.records[state.records.length - 1];
    const now = Date.now();
    const windowStillAlive = lastRecord && isWindowAliveAt(lastRecord.windowId, now, state.settings);
    if (windowStillAlive) return;  // 同一个窗口内，保护用户的编辑
    // 窗口已过期 → 不管用户编辑了什么，往下走强制刷新
  }

  // 快照当前 draft 相关字段，准备做前后对比
  const before = {
    windowId: state.draftWindowId,
    prev5h: state.draftPrev5h,
    prevWeekly: state.draftPrevWeekly,
    isNewWindow: state.isNewWindow,
    isNewWeek: state.isNewWeek,
  };

  resetDraft();

  // 如果 resetDraft 后任何一个关键字段变了，说明时间推进产生了"可见差异"，
  // 触发输入卡重绘，让窗口标签、预填值、🌱 新一周等都跟上当前时间
  const changed =
    before.windowId !== state.draftWindowId ||
    before.prev5h !== state.draftPrev5h ||
    before.prevWeekly !== state.draftPrevWeekly ||
    before.isNewWindow !== state.isNewWindow ||
    before.isNewWeek !== state.isNewWeek;
  if (changed) {
    renderInputCard();
  }
}

// 添加一条新记录。isCorrection=true 时不新增，而是覆盖最后一条同窗口的记录
function addRecord(fiveH, weekly, noteText, isCorrection) {
  const ts = Date.now();
  const lastRecord = state.records[state.records.length - 1];
  const windowId = determineWindowId(ts, lastRecord);

  // 修正路径：上一条同窗口、且这次明确是"低于上次"的修正 → 覆盖而不是追加
  if (isCorrection && lastRecord && lastRecord.windowId === windowId) {
    lastRecord.timestamp = ts;
    lastRecord.fiveH = Math.round(fiveH);
    lastRecord.weekly = Math.round(weekly);
    // 备注框为空时不动旧备注（备注框默认是空的，不能让"修正数字"顺手清掉旧笔记）
    const trimmed = (noteText || '').trim();
    if (trimmed) lastRecord.note = trimmed;
    state.selectedHistoryWindowId = windowId;
    saveData();
    return;
  }

  const record = {
    id: ts,
    timestamp: ts,
    fiveH: Math.round(fiveH),
    weekly: Math.round(weekly),
    windowId: windowId,
  };

  const trimmed = (noteText || '').trim();
  if (trimmed) record.note = trimmed;

  state.records.push(record);
  // 记一笔之后自动把历史视图选中跟到这条记录所在的窗口。
  // 主要是为了解决"时间推进开了新窗口、但历史卡还停在上个窗口"的体感割裂——
  // 用户刚记的这一笔一般就是他最想看的，让视图跟过去更自然
  state.selectedHistoryWindowId = windowId;
  saveData();
}

// 旧数据兼容：早期版本的备注是按"窗口 id"存的（state.notes[windowId]），
// 现在改成挂在记录上。把旧的窗口级备注迁移到那个窗口的最后一条记录上，
// 这样旧数据不会丢，hover 那个点就能看到。迁移后 state.notes 清空。
function migrateNotesToRecords() {
  if (!state.notes || Object.keys(state.notes).length === 0) return;
  // 按 windowId 把记录分组，找到每个窗口的最后一条记录
  const lastByWindow = new Map();
  for (const r of state.records) {
    const cur = lastByWindow.get(r.windowId);
    if (!cur || r.timestamp > cur.timestamp) {
      lastByWindow.set(r.windowId, r);
    }
  }
  for (const [wid, noteText] of Object.entries(state.notes)) {
    if (!noteText || typeof noteText !== 'string') continue;
    const trimmed = noteText.trim();
    if (!trimmed) continue;
    const lastRec = lastByWindow.get(Number(wid));
    if (lastRec && !lastRec.note) {
      lastRec.note = trimmed;
    }
  }
  // 清空旧字段，下次启动就不会再迁移
  state.notes = {};
  saveData();
}

/* =================================================
   6. 渲染：顶栏 & 状态卡
   ================================================= */

function renderTopbar() {
  const now = new Date();
  const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
  const dateStr = `${now.getMonth() + 1}/${now.getDate()} 周${dayNames[now.getDay()]}`;
  $('#today-date').textContent = dateStr;

  const weekStart = getWeekStart(now.getTime(), state.settings);
  const weekEnd = getWeekEnd(weekStart, state.settings);
  const remainingMs = weekEnd - now.getTime();
  $('#weekly-reset-info').textContent = `weekly · ${formatRemainingUntilReset(remainingMs)}`;
}

function renderStatusCards() {
  const windows = computeWindows(state.records);
  const currentWindow = getCurrentWindow(windows);
  const lastRecord = state.records[state.records.length - 1];

  // —— 5h 状态卡 ——
  if (currentWindow) {
    const lastInWindow = currentWindow.records[currentWindow.records.length - 1];
    $('#status-5h-num').textContent = lastInWindow.fiveH;
    $('#status-5h-bar').style.width = `${lastInWindow.fiveH}%`;

    const startD = new Date(currentWindow.startTime);
    const endD = new Date(currentWindow.endTime);
    $('#status-5h-range').textContent = `${hm(startD)} - ${hm(endD)}`;

    const remainingMs = currentWindow.endTime - Date.now();
    const remainingMin = Math.max(0, Math.floor(remainingMs / 60000));
    const h = Math.floor(remainingMin / 60);
    const m = remainingMin % 60;
    $('#status-5h-countdown').textContent = `还剩 ${h}h ${m}m ⏱`;
  } else {
    $('#status-5h-num').textContent = '0';
    $('#status-5h-bar').style.width = '0%';
    $('#status-5h-range').textContent = '当前没有活跃窗口';
    $('#status-5h-countdown').textContent = '记一笔就开始 ✨';
  }

  // —— Weekly 状态卡 ——
  // 关键：只看"本周最后一笔"。新一周开始、还没记录时 weeklyVal 就是 0，
  // 不会再残留上一周末的数值让整张卡自相矛盾。
  const lastInWeek = getLastRecordThisWeek(state.records, state.settings);
  const weeklyVal = lastInWeek ? lastInWeek.weekly : 0;
  $('#status-weekly-num').textContent = weeklyVal;
  $('#status-weekly-bar').style.width = `${weeklyVal}%`;

  const weekStart = getWeekStart(Date.now(), state.settings);
  const weekEnd = getWeekEnd(weekStart, state.settings);
  const totalWeekMs = weekEnd - weekStart;
  const elapsedMs = Date.now() - weekStart;
  const idealPct = Math.min(100, Math.round((elapsedMs / totalWeekMs) * 100));
  const remainingMs = weekEnd - Date.now();

  $('#status-weekly-reset').textContent = formatRemainingUntilReset(remainingMs);
  if (weeklyVal < idealPct) {
    $('#status-weekly-ideal').textContent = `理想 ${idealPct}% 🌿 还有富余`;
  } else if (weeklyVal > idealPct + 5) {
    $('#status-weekly-ideal').textContent = `理想 ${idealPct}% 🔥 略快`;
  } else {
    $('#status-weekly-ideal').textContent = `理想 ${idealPct}% · 同步`;
  }
}

/* =================================================
   7. 渲染：输入卡
   ================================================= */

function renderInputCard() {
  // 大数字
  $('#input-5h-num').textContent = state.draft5h;
  $('#input-weekly-num').textContent = state.draftWeekly;

  // 进度条 —— prev fill 是上次值的位置
  $('#input-5h-prev-fill').style.width = `${state.draftPrev5h}%`;
  $('#input-weekly-prev-fill').style.width = `${state.draftPrevWeekly}%`;

  // new fill 是从 prev 到 current 的高亮段
  const new5hLeft = state.draftPrev5h;
  const new5hRight = state.draft5h;
  const new5hStart = Math.min(new5hLeft, new5hRight);
  const new5hEnd = Math.max(new5hLeft, new5hRight);
  const new5hFill = $('#input-5h-new-fill');
  new5hFill.style.left = `${new5hStart}%`;
  new5hFill.style.width = `${new5hEnd - new5hStart}%`;
  new5hFill.classList.toggle('is-reverse', state.draft5h < state.draftPrev5h);

  const newWLeft = state.draftPrevWeekly;
  const newWRight = state.draftWeekly;
  const newWStart = Math.min(newWLeft, newWRight);
  const newWEnd = Math.max(newWLeft, newWRight);
  const newWFill = $('#input-weekly-new-fill');
  newWFill.style.left = `${newWStart}%`;
  newWFill.style.width = `${newWEnd - newWStart}%`;
  newWFill.classList.toggle('is-reverse', state.draftWeekly < state.draftPrevWeekly);

  // 上次值的小标记
  $('#input-5h-prev-marker').style.left = `${state.draftPrev5h}%`;
  $('#input-5h-prev-label').textContent = `↑${state.draftPrev5h}`;
  $('#input-weekly-prev-marker').style.left = `${state.draftPrevWeekly}%`;
  // weekly 小标签：如果这笔是本周第一笔，就不显示"↑0"而是"🌱 新一周"，
  // 顺便加 is-anchor-left 防左溢出（默认 translateX(-50%) 会把 label 甩到
  // 进度条左边外面）和 is-new-week 换成鼠尾草绿色更醒目。
  const weeklyPrevLabel = $('#input-weekly-prev-label');
  if (state.isNewWeek) {
    weeklyPrevLabel.textContent = '🌱 新一周';
    weeklyPrevLabel.classList.add('is-anchor-left', 'is-new-week');
  } else {
    weeklyPrevLabel.textContent = `↑${state.draftPrevWeekly}`;
    weeklyPrevLabel.classList.remove('is-anchor-left', 'is-new-week');
  }

  // 当前窗口的标签
  const tag = $('#window-tag');
  if (state.isNewWindow) {
    const startD = new Date(state.draftWindowId);
    const endD = new Date(state.draftWindowId + FIVE_HOURS_MS);
    tag.textContent = `🌱 新窗口 ${hm(startD)} ~ ${hm(endD)}`;
    tag.classList.add('is-new');
  } else {
    const startD = new Date(state.draftWindowId);
    const endD = new Date(state.draftWindowId + FIVE_HOURS_MS);
    tag.textContent = `当前窗口 ${hm(startD)} ~ ${hm(endD)}`;
    tag.classList.remove('is-new');
  }

  // 备注：备注现在挂在每条记录上，输入框只是"这一笔要写什么"。
  // 不再预填任何东西——每次保存后自动清空（见 handleSave）。

  // 空状态提示：没有任何记录时才显示
  $('#empty-hint').hidden = state.records.length > 0;
}

// 步进按钮处理
function handleStep(target, step) {
  const before = target === '5h' ? state.draft5h : state.draftWeekly;
  if (target === '5h') {
    state.draft5h = clamp(state.draft5h + step, 0, 100);
  } else {
    state.draftWeekly = clamp(state.draftWeekly + step, 0, 100);
  }
  const after = target === '5h' ? state.draft5h : state.draftWeekly;

  renderInputCard();

  // 大数字弹跳：只在数字真的变了时触发（夹边界时不弹，避免 +1 已经 100 还瞎闪）
  if (after !== before) {
    const numEl = target === '5h'
      ? $('#input-5h-num').parentElement
      : $('#input-weekly-num').parentElement;
    fireAnim(numEl, 'is-pulse', 380);
  }
}

// 把一个 class 加到元素上触发 CSS animation，dur ms 后自动移除
// 重复调用会先 remove + reflow + add，让动画从头开始重播
function fireAnim(el, cls, dur) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  if (dur) setTimeout(() => el.classList.remove(cls), dur);
}

// 从某个原点位置（一般是被点击的按钮）飞出 N 颗 ✨ 粒子，
// 散射方向偏上方半圆，每颗的角度/距离/字符/颜色/字号都随机
function spawnSparks(originEl, count) {
  if (!originEl) return;
  const rect = originEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const symbols = ['✨', '·', '✿', '⋆', '✨'];
  const colors  = ['#F4D58D', '#F5A678', '#95C9A6', '#F4D58D'];

  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    p.className = 'spark-particle is-flying';
    p.textContent = symbols[i % symbols.length];

    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.0;
    const distance = 55 + Math.random() * 50;
    const dx = Math.cos(angle) * distance;
    const dy = Math.sin(angle) * distance;

    p.style.left = (cx + (Math.random() - 0.5) * 18) + 'px';
    p.style.top  = (cy - 4) + 'px';
    p.style.setProperty('--dx',  dx.toFixed(1) + 'px');
    p.style.setProperty('--dy',  dy.toFixed(1) + 'px');
    p.style.setProperty('--rot', (Math.random() * 220 - 80).toFixed(0) + 'deg');
    p.style.fontSize = (13 + Math.random() * 11) + 'px';
    p.style.color = colors[i % colors.length];

    document.body.appendChild(p);
    setTimeout(() => p.remove(), 1100);
  }
}

// 保存按钮处理
async function handleSave() {
  // 检查是否需要"低于上次"确认。低于上次几乎一定是修正——确认后覆盖前一条
  const lower5h = state.draft5h < state.draftPrev5h;
  const lowerWeekly = state.draftWeekly < state.draftPrevWeekly;
  let isCorrection = false;
  if ((lower5h || lowerWeekly) && !state.isNewWindow) {
    const fields = [];
    if (lower5h) fields.push(`5h:  ${state.draftPrev5h}% → ${state.draft5h}%`);
    if (lowerWeekly) fields.push(`weekly:  ${state.draftPrevWeekly}% → ${state.draftWeekly}%`);
    // 快照对话框打开时的最后一条记录的 windowId，确认后要校验窗口是否还活着
    const expectedLast = state.records[state.records.length - 1];
    const expectedWindowId = expectedLast ? expectedLast.windowId : null;
    const ok = await confirmDialog({
      icon: '✏️',
      title: '咦～这次比上次低哦',
      message: `${fields.join('\n')}\n\n是要修正之前打错的吗？\n确定的话就把上一笔替换掉～`,
      confirmText: '就这样记下',
      cancelText: '再想想',
    });
    if (!ok) return;
    // 对话框可能挂了很久跨过 5h 窗口边界（或正好撞上硬重置）——这时不能再当修正
    const lastNow = state.records[state.records.length - 1];
    const stillSameWindow = lastNow && lastNow.windowId === expectedWindowId
      && isWindowAliveAt(lastNow.windowId, Date.now(), state.settings);
    if (!stillSameWindow) {
      showToast('5h 窗口已经过去啦，刚才那一笔没替换哦');
      return;
    }
    isCorrection = true;
  }

  // 哪一栏真的变了——只有变了的那栏才播进度条柔光（数字本身不动，因为它没变）
  const changed5h = state.draft5h !== state.draftPrev5h;
  const changedW  = state.draftWeekly !== state.draftPrevWeekly;
  const anyChanged = changed5h || changedW;

  const noteText = $('#window-note').value;
  addRecord(state.draft5h, state.draftWeekly, noteText, isCorrection);

  // 备注挂到记录上之后清空输入框，下次记一笔从空开始
  $('#window-note').value = '';

  // —— 触发新的保存动画 ——
  const card = document.querySelector('.input-card');
  const saveBtn = $('#save-btn');
  const ripple = saveBtn && saveBtn.querySelector('.ripple');
  const sweep = card && card.querySelector('.sweep-overlay');
  const toast = card && card.querySelector('.save-confirm-toast');

  // 1. 按钮反馈：凹陷 → 涟漪 → 反弹 → 飞出 ✨ 粒子（永远播）
  if (saveBtn) {
    saveBtn.classList.remove('is-rebound');
    saveBtn.classList.add('is-pressing');
    fireAnim(ripple, 'is-rippling', 700);
    spawnSparks(saveBtn, anyChanged ? 7 : 3);
    setTimeout(() => {
      saveBtn.classList.remove('is-pressing');
      saveBtn.classList.add('is-rebound');
    }, 110);
    setTimeout(() => saveBtn.classList.remove('is-rebound'), 470);
  }

  // 2. 进度条柔光（只对变了的那栏）
  if (changed5h) {
    const glow = $('#input-5h-prev-fill').parentElement.querySelector('.settle-glow');
    fireAnim(glow, 'is-glowing', 700);
  }
  if (changedW) {
    const glow = $('#input-weekly-prev-fill').parentElement.querySelector('.settle-glow');
    fireAnim(glow, 'is-glowing', 700);
  }

  // 3. 卡片扫光 + 4. 底部气泡（紧随其后）
  setTimeout(() => fireAnim(sweep, 'is-sweeping', 750), 60);
  setTimeout(() => fireAnim(toast, 'is-showing', 1300), 130);

  resetDraft();
  renderAll();

  // 如果配置了云同步且没有被暂停，后台静默推送一次（失败也不阻塞本地操作）
  if (isSyncConfigured() && !isSyncPaused()) {
    syncPush(true).catch(() => {});
  }
}

/* =================================================
   8. 渲染：汇率卡
   ================================================= */

let rateChart = null;

function renderRateCard() {
  const samples = computeRateSamples(state.records);
  const current = computeCurrentRate(samples);
  const weekly = computeWeeklyRate(samples, state.settings);

  const fmt = (v) => v !== null ? v.toFixed(1) : '—';

  $('#rate-big').textContent = fmt(current);
  $('#rate-explain').textContent = current !== null
    ? `${fmt(current)}% 5h ≈ 1% weekly`
    : samples.length > 0
      ? `样本不足（${samples.length}/3）`
      : '等数据中…';

  $('#rate-overall').textContent = fmt(weekly);
  // 高峰/非高峰已暂停，不写值

  const trendEl = $('#rate-trend');
  if (current !== null && weekly !== null) {
    const diff = current - weekly;
    if (diff > weekly * 0.15) {
      trendEl.textContent = `🔥 比本周典型值高 ${Math.round((diff / weekly) * 100)}%`;
      trendEl.className = 'rate-trend is-up';
    } else if (diff < -weekly * 0.15) {
      trendEl.textContent = `🌿 比本周典型值低 ${Math.round((-diff / weekly) * 100)}%`;
      trendEl.className = 'rate-trend is-down';
    } else {
      trendEl.textContent = '☁️ 和本周典型值差不多';
      trendEl.className = 'rate-trend';
    }
  } else if (samples.length < 3) {
    trendEl.textContent = samples.length > 0 ? `样本不足（${samples.length}/3）` : '等数据中…';
    trendEl.className = 'rate-trend';
  } else {
    trendEl.textContent = '本周还没有样本';
    trendEl.className = 'rate-trend';
  }
}

function renderRateTrendChart() {
  const wrap = $('#rate-chart-wrap');
  if (wrap.hidden) return;

  const samples = computeRateSamples(state.records);

  // 按天分组格成本样本（key 带年份防跨年冲突），每天取中位数
  const byDay = new Map();
  for (const s of samples) {
    const d = new Date(s.timestamp);
    const dayKey = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey).push(s.cost);
  }

  // 始终显示最近 5 天（含今天），没数据的天留空
  const today = new Date();
  const labels = [];
  const lookupKeys = [];
  for (let d = 4; d >= 0; d--) {
    const dt = new Date(today);
    dt.setDate(dt.getDate() - d);
    labels.push(`${dt.getMonth() + 1}/${dt.getDate()}`);
    lookupKeys.push(`${dt.getFullYear()}-${dt.getMonth() + 1}-${dt.getDate()}`);
  }
  const data = lookupKeys.map(k => {
    const costs = byDay.get(k);
    if (!costs || costs.length === 0) return null;
    return +median(costs).toFixed(1);
  });

  const ctx = $('#rate-chart').getContext('2d');
  if (rateChart) rateChart.destroy();

  rateChart = createChartWithEnterAnim(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '日均汇率',
        data,
        borderColor: COLORS.cRateDeep,
        backgroundColor: 'rgba(184, 164, 212, 0.15)',
        borderWidth: 2,
        tension: 0.35,
        pointRadius: 3,
        pointBackgroundColor: COLORS.cRateDeep,
        spanGaps: true,
        fill: true,
        clip: false,  // 允许数据点画在 plot area 外面，防贴边圆点被切
      }],
    },
    options: chartBaseOptions({ yMax: null, hideY: false }),
  }, { duration: 1100 });
}

/* =================================================
   9. 渲染：周节奏曲线
   ================================================= */

let weeklyChart = null;

// renderWeeklyChart 接受一个 mode 参数：
// - 'update'（默认）：如果 chart 已存在，只换数据然后 chart.update()。
//                     这样保存一条新记录时只有"新点出现"的动画，旧点不动。
// - 'rebuild'：destroy 旧 chart 重建一个新的。用于主题切换（颜色全变）
//              和初次渲染（chart 还不存在）。
function renderWeeklyChart(mode = 'update') {
  const now = Date.now();
  const currentWeekStart = getWeekStart(now, state.settings);
  const weekStart = state.selectedWeekStart != null ? state.selectedWeekStart : currentWeekStart;
  const weekEnd = getWeekEnd(weekStart, state.settings);
  const isCurrentWeek = weekStart === currentWeekStart;

  // 更新导航标题
  const ws = new Date(weekStart);
  const we = new Date(weekEnd - 1);
  const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
  if (isCurrentWeek) {
    $('#weekly-nav-title').textContent = '本周';
  } else {
    $('#weekly-nav-title').textContent = `${ws.getMonth() + 1}/${ws.getDate()} ~ ${we.getMonth() + 1}/${we.getDate()}`;
  }
  // 右箭头：当前周时禁用
  $('#next-week-btn').disabled = isCurrentWeek;
  // 左箭头：没有更早的记录时禁用
  const hasOlderData = state.records.length > 0 && state.records[0].timestamp < weekStart;
  $('#prev-week-btn').disabled = !hasOlderData;

  // 当前周的所有记录（仍然要算，下面预测速率会用到 first/last）
  const weekRecords = state.records.filter(r =>
    r.timestamp >= weekStart && r.timestamp < weekEnd
  ).sort((a, b) => a.timestamp - b.timestamp);

  // —— 实际数据点：按 5h 窗口聚合，每个窗口取最后一条记录作为代表点 ——
  // 之前是每条记录画一个点，导致一周可能 30~70 个点挤在 700px 宽度上糊成一团。
  // 改成"每个窗口一个代表点"后，曲线变成"每个工作窗口结束时 weekly 累积到了多少"，
  // 视觉上是台阶式上扬：上升对应工作窗口、平台对应窗口之间的休息。
  // 注意：故意不在 weekStart 加 0% 假点。如果用户是中途开始记录的，
  // 加假点会让曲线撒谎（看起来像短时间内冲到 39%），曲线应该只画真实数据。
  const allWindows = computeWindows(state.records);
  const windowsInWeek = allWindows.filter(
    (w) => w.endTime > weekStart && w.startTime < weekEnd
  );
  const actualPoints = windowsInWeek
    .map((w) => {
      // 跨周窗口要小心：只取窗口里属于本周的那部分记录
      const recordsInWeek = w.records.filter(
        (r) => r.timestamp >= weekStart && r.timestamp < weekEnd
      );
      if (recordsInWeek.length === 0) return null;
      const lastRecord = recordsInWeek[recordsInWeek.length - 1];
      // X 坐标用窗口实际结束时间（被硬重置截断的窗口到闸门为止），这样点在时间轴上不会乱飘。
      // 两个例外改用最后一条记录的真实时间：活跃窗口（结束时间在未来，画过去会误导）、
      // 终点越过本周右界的跨周窗口（不然点会探出图表外面）。
      const isActive = isWindowAliveAt(w.startTime, Date.now(), state.settings);
      const end = w.effectiveEnd != null ? w.effectiveEnd : w.endTime;
      const x = isActive || end >= weekEnd ? lastRecord.timestamp : end;
      return { x, y: lastRecord.weekly };
    })
    .filter(Boolean);

  // 理想匀速线：从 (weekStart, 0) 到 (weekEnd, 100)
  // 残缺周（窗口不到 7 天）也按"这个窗口里要把 100% 用完"算斜率，
  // 跟状态卡的"理想 X%"（按 elapsed/total 归一）保持一致。
  const idealPoints = [
    { x: weekStart, y: 0 },
    { x: weekEnd, y: 100 },
  ];

  // 预测延伸线：仅当前周才显示预测
  let predictPoints = [];
  let predictionText = '';
  let predictionClass = '';
  if (isCurrentWeek && weekRecords.length >= 2) {
    // 速率只用"最后一段单调上升"的记录算。周内 weekly 一旦掉落（比如把周重置
    // 时间改到实际重置稍前，旧周期最后几笔 27、28 落进了新一周，随后掉回 0 重新爬），
    // 直接拿本周第一条当起点会把净消耗算成负数，预测整个被吞掉。
    // 和 computeRateSamples 的分段口径一致：掉落处重开一段，起点取最后一段的开头。
    let segStartIdx = 0;
    for (let i = 1; i < weekRecords.length; i++) {
      if (weekRecords[i].weekly < weekRecords[i - 1].weekly) segStartIdx = i;
    }
    const first = weekRecords[segStartIdx];
    const last = weekRecords[weekRecords.length - 1];
    const elapsed = last.timestamp - first.timestamp;
    const consumed = last.weekly - first.weekly;
    if (elapsed > 0 && consumed > 0) {
      const ratePerMs = consumed / elapsed;
      const remainingMs = weekEnd - last.timestamp;
      const additional = ratePerMs * remainingMs;
      const finalPredict = last.weekly + additional;

      if (finalPredict > 100) {
        const exhaustMs = ((100 - last.weekly) / ratePerMs);
        const exhaustTimestamp = last.timestamp + exhaustMs;
        const exhaustDate = new Date(exhaustTimestamp);
        predictPoints = [
          { x: last.timestamp, y: last.weekly },
          { x: exhaustTimestamp, y: 100 },
        ];
        predictionText = `按这个节奏，会在周${dayNames[exhaustDate.getDay()]} ${pad(exhaustDate.getHours())}:00 用完 🔥`;
        predictionClass = 'is-warn';
      } else {
        predictPoints = [
          { x: last.timestamp, y: last.weekly },
          { x: weekEnd, y: Math.max(0, finalPredict) },
        ];
        predictionText = `按这个节奏，周末会用到 ~${Math.round(finalPredict)}%，还很安全 🌿`;
        predictionClass = 'is-safe';
      }
    }
  }
  if (!predictionText) {
    if (!isCurrentWeek && weekRecords.length > 0) {
      const last = weekRecords[weekRecords.length - 1];
      predictionText = `这一周最终用到了 ${last.weekly}%`;
      predictionClass = last.weekly > 90 ? 'is-warn' : 'is-safe';
    } else if (!isCurrentWeek) {
      predictionText = '这一周没有记录';
    } else {
      predictionText = '记几条数据之后就能看到预测了～';
    }
  }

  $('#weekly-prediction').textContent = predictionText;
  $('#weekly-prediction').className = 'weekly-prediction ' + predictionClass;

  // —— 增量更新路径 ——
  // 如果 chart 已经存在且不要求强制重建，就只替换数据然后 update。
  // Chart.js 会自动让"变化的部分"动画（新增的数据点会从邻居位置过渡到自己的位置），
  // 没变的部分保持不动。这样保存一条记录时不会让整条曲线重绘。
  if (weeklyChart && mode !== 'rebuild') {
    weeklyChart.data.datasets[0].data = idealPoints;
    weeklyChart.data.datasets[1].data = predictPoints;
    weeklyChart.data.datasets[2].data = actualPoints;
    weeklyChart.options.scales.x.min = weekStart;
    weeklyChart.options.scales.x.max = weekEnd;
    weeklyChart.update();
    return;
  }

  // —— 重建路径 ——（第一次渲染 / 主题切换）
  const ctx = $('#weekly-chart').getContext('2d');
  if (weeklyChart) weeklyChart.destroy();

  weeklyChart = createChartWithEnterAnim(ctx, {
    type: 'line',
    data: {
      datasets: [
        {
          label: '理想匀速',
          data: idealPoints,
          borderColor: COLORS.cIdeal,
          borderWidth: 2,
          borderDash: [6, 6],
          pointRadius: 0,
          tension: 0,
          fill: false,
          clip: false,
        },
        {
          label: '预测',
          data: predictPoints,
          borderColor: COLORS.cPredict,
          borderWidth: 2,
          borderDash: [4, 4],
          pointRadius: 0,
          tension: 0,
          fill: false,
          clip: false,
        },
        {
          label: '实际',
          data: actualPoints,
          borderColor: COLORS.cWeeklyDeep,
          backgroundColor: 'rgba(149, 201, 166, 0.18)',
          borderWidth: 3,
          tension: 0.25,
          pointRadius: 5,           // 点稀疏了，可以画大一点更醒目
          pointBackgroundColor: COLORS.cWeeklyDeep,
          pointHoverRadius: 8,
          fill: true,
          clip: false,  // 允许贴顶/贴边的点完整画出，不被 plot area 边界切
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // animation 由 createChartWithEnterAnim 注入（init 时 false，否则真实动画）
      // 给画布留呼吸空间：
      // - top 24 防 "100%" tick label 被切 + 防接近 100% 的数据点贴顶
      // - right 16 防最右数据点贴边
      // - left 14 防最左数据点贴 y 轴
      layout: {
        padding: { top: 24, right: 16, bottom: 8, left: 14 },
      },
      interaction: { mode: 'nearest', intersect: false, axis: 'x' },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          align: 'end',
          labels: {
            font: { family: "'Nunito', sans-serif", size: 11 },
            color: COLORS.textSec,
            boxWidth: 12,
            padding: 10,
          },
        },
        tooltip: tooltipStyle({
          callbacks: {
            title: (items) => {
              if (!items.length) return '';
              const d = new Date(items[0].parsed.x);
              const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
              return `${d.getMonth() + 1}/${d.getDate()} 周${dayNames[d.getDay()]} ${hm(d)}`;
            },
            label: (item) => {
              if (item.dataset.label === '实际') {
                return `已用 ${Math.round(item.parsed.y)}%`;
              }
              return `${item.dataset.label}: ${Math.round(item.parsed.y)}%`;
            },
          },
        }),
      },
      scales: {
        x: {
          type: 'linear',
          min: weekStart,
          max: weekEnd,
          grid: { color: COLORS.divider, drawBorder: false },
          ticks: {
            color: COLORS.textSec,
            font: { family: "'Nunito', sans-serif", size: 11 },
            callback: function(value) {
              const d = new Date(value);
              const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
              return `周${dayNames[d.getDay()]}`;
            },
            stepSize: ONE_DAY_MS,
          },
        },
        y: {
          min: 0,
          max: 100,
          grid: { color: COLORS.divider, drawBorder: false },
          ticks: {
            color: COLORS.textSec,
            font: { family: "'Nunito', sans-serif", size: 11 },
            callback: (v) => v + '%',
            stepSize: 25,
          },
        },
      },
    },
  }, {
    duration: 1500,
    stagger: 70,
    pointCount: actualPoints.length,
    // 预测那条虚线（datasetIndex = 1）是从实际线末尾延伸出去的。
    // 如果也按 dataIndex × stagger 延迟，就只有 0 和 1 倍 stagger 两步，
    // 几乎瞬间画完——点还没上来线就已经在那了，体感像"抢跑"。
    // 让它等到实际线都画完再慢慢接上：延迟 = 实际线走完的时间 + 一点点余量。
    datasetDelay: (realStagger) => {
      const lastActualDelay = Math.max(0, (actualPoints.length - 1) * realStagger);
      return { 1: lastActualDelay + 400 };
    },
  });

  // 当 .middle-row 已经可见（scroll-reveal 已触发）但 chartsInInitialState 仍为 true
  // （下方 history-card 还没露出来），此时新建的 chart 以 animation:false + reset()
  // 的冻结状态创建，却不会再被 observer 触发入场动画。
  // 手动补一次，避免图表永远停在"所有点都在底部"的 reset 状态，
  // 以及随之而来的"触摸一下所有点跳到底部"问题。
  if (chartsInInitialState && document.querySelector('.middle-row').classList.contains('is-revealed')) {
    triggerChartEnterAnimation(weeklyChart);
  }
}

/* =================================================
   10. 渲染：5h 历史
   ================================================= */

let windowChart = null;

// 备注在 hover tooltip 里的最大显示长度。这是个轻量预览，
// 长备注会被截到这个字数 + "…"，想看完整内容就去下面的展开列表里看。
const NOTE_TOOLTIP_MAX = 26;

function renderHistory() {
  const windows = computeWindows(state.records);
  $('#history-count').textContent = windows.length > 0
    ? `共 ${windows.length} 个窗口`
    : '还没有窗口';

  // 默认选中最近的窗口
  if (state.selectedHistoryWindowId === null && windows.length > 0) {
    state.selectedHistoryWindowId = windows[windows.length - 1].id;
  }

  renderWindowDetail(windows);
}

function renderWindowDetail(windows) {
  if (windows.length === 0) {
    $('#history-title').textContent = '还没有窗口～';
    $('#window-summary').textContent = '记一笔就有数据啦 ✨';
    if (windowChart) {
      windowChart.destroy();
      windowChart = null;
    }
    renderNotesArea(null);
    renderAdjustPanel(null, []);
    return;
  }

  const idx = windows.findIndex(w => w.id === state.selectedHistoryWindowId);
  const w = idx >= 0 ? windows[idx] : windows[windows.length - 1];
  if (idx < 0) state.selectedHistoryWindowId = w.id;

  const startD = new Date(w.startTime);
  // 时间范围显示到实际终点：被硬重置截断的窗口只到闸门那一刻，不画满 5h
  const endD = new Date(w.effectiveEnd);
  const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
  const isActive = isWindowAliveAt(w.startTime, Date.now(), state.settings);
  const statusText = isActive ? '进行中' : w.wasCut ? '重置截断' : '已结束';
  const dateStr = `${startD.getMonth() + 1}/${startD.getDate()} 周${dayNames[startD.getDay()]}`;
  // 拆成"范围"和"状态"两段，各自 nowrap：手机上换行时整块下移，不会把"进行中"拆字
  $('#history-title').innerHTML =
    `<span class="history-title-range">${dateStr} ${hm(startD)} - ${hm(endD)}</span>` +
    `<i class="history-title-break" aria-hidden="true"></i>` +
    `<span class="history-title-status${isActive ? ' is-live' : ''}">${statusText}</span>`;

  // 总结
  const finalVal = w.lastValue;
  const recordCount = w.records.length;
  $('#window-summary').textContent = isActive
    ? `已烧到 ${finalVal}%，共 ${recordCount} 条记录`
    : `最终烧到 ${finalVal}%，共 ${recordCount} 条记录`;

  // 备注区：默认显示最新一条 + 可展开看全部
  renderNotesArea(w);

  // 调起点面板
  renderAdjustPanel(w, windows);

  // 折线图：在每个点上额外挂 record 引用，方便 tooltip 取出备注
  const points = w.records.map(r => ({ x: r.timestamp, y: r.fiveH, record: r }));
  // 加一个起点的 0 值（如果第一个记录不是 0）
  const ctx = $('#window-chart').getContext('2d');
  if (windowChart) windowChart.destroy();

  windowChart = createChartWithEnterAnim(ctx, {
    type: 'line',
    data: {
      datasets: [{
        label: '5h 用量',
        data: points,
        borderColor: COLORS.c5hDeep,
        backgroundColor: 'rgba(245, 166, 120, 0.18)',
        borderWidth: 3,
        tension: 0.3,
        pointRadius: 5,
        pointBackgroundColor: COLORS.c5hDeep,
        pointHoverRadius: 8,
        fill: true,
        clip: false,  // 允许贴顶/贴边的点完整画出
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // animation 由 createChartWithEnterAnim 注入（init 时 false，否则真实动画）
      // 给画布留呼吸空间——这同时修了 memory 里记着的旧 bug：
      // "5h 窗口历史折线图最顶上的点被遮住"。元凶其实就是这个裁切问题
      layout: {
        padding: { top: 24, right: 16, bottom: 8, left: 14 },
      },
      // hover 行为：和 weekly 图保持一致——鼠标只要在 X 方向靠近某个点就吸附，
      // 不必精准点到那个圆点上。之前没配这个，默认要 intersect: true，
      // 所以必须正中点上才有 tooltip，体感不顺手。
      interaction: { mode: 'nearest', intersect: false, axis: 'x' },
      plugins: {
        legend: { display: false },
        tooltip: tooltipStyle({
          callbacks: {
            title: (items) => {
              const d = new Date(items[0].parsed.x);
              return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
            },
            // tooltip 第一行是百分比；如果这条记录上挂了备注，
            // 第二行显示备注（截到 NOTE_TOOLTIP_MAX 字，超了用 …）。
            // Chart.js 允许 label 返回字符串数组，每项一行。
            label: (item) => {
              const lines = [`${item.parsed.y}%`];
              const rec = item.raw && item.raw.record;
              if (rec && rec.note) {
                let text = rec.note;
                if (text.length > NOTE_TOOLTIP_MAX) {
                  text = text.slice(0, NOTE_TOOLTIP_MAX) + '…';
                }
                lines.push(`📝 ${text}`);
              }
              return lines;
            },
          },
        }),
      },
      scales: {
        x: {
          type: 'linear',
          min: w.startTime,
          max: w.effectiveEnd,
          grid: { color: COLORS.divider, drawBorder: false },
          ticks: {
            color: COLORS.textSec,
            font: { family: "'Nunito', sans-serif", size: 11 },
            callback: function(value) {
              const d = new Date(value);
              return hm(d);
            },
            stepSize: 60 * 60 * 1000,  // 1 hour
          },
        },
        y: {
          min: 0,
          max: 100,
          grid: { color: COLORS.divider, drawBorder: false },
          ticks: {
            color: COLORS.textSec,
            font: { family: "'Nunito', sans-serif", size: 11 },
            callback: (v) => v + '%',
            stepSize: 25,
          },
        },
      },
    },
  }, { duration: 1300, stagger: 90, pointCount: points.length });
}

// 渲染备注区：默认只显示这个窗口里"最新一条带备注"的记录，
// 下方一个展开按钮，点开就铺出这个窗口里所有有备注的记录列表。
// 切换窗口（◀ ▶ 翻页）时会重置成"折叠"状态。
function renderNotesArea(window) {
  const latestEl = $('#notes-latest');
  const expandBtn = $('#notes-expand-btn');
  const listEl = $('#notes-list');

  // 没窗口或没记录的兜底
  if (!window || window.records.length === 0) {
    latestEl.textContent = '还没有记录～';
    latestEl.classList.add('is-empty');
    expandBtn.hidden = true;
    listEl.hidden = true;
    listEl.classList.add('is-collapsed');
    listEl.innerHTML = '';
    return;
  }

  // 这个窗口里有备注的记录（按时间顺序）
  const notedRecords = window.records.filter(r => r.note && r.note.trim());

  // 默认显示"最新一条"——也就是这个窗口里最后一条带备注的记录
  if (notedRecords.length === 0) {
    latestEl.textContent = '这个窗口里还没写过备注～hover 折线图上的点也没什么可看的 (｡•̀ᴗ-)';
    latestEl.classList.add('is-empty');
    expandBtn.hidden = true;
    listEl.hidden = true;
    listEl.classList.add('is-collapsed');
    listEl.innerHTML = '';
    return;
  }

  const latest = notedRecords[notedRecords.length - 1];
  const latestTime = new Date(latest.timestamp);
  latestEl.classList.remove('is-empty');
  latestEl.textContent = `${pad(latestTime.getHours())}:${pad(latestTime.getMinutes())} · ${latest.fiveH}% · ${latest.note}`;

  // 只有不止一条备注时才显示展开按钮（一条的话已经全显示了）
  if (notedRecords.length <= 1) {
    expandBtn.hidden = true;
    listEl.hidden = true;
    listEl.classList.add('is-collapsed');
    listEl.innerHTML = '';
    return;
  }

  expandBtn.hidden = false;
  // 用 innerHTML 是为了把 chevron 包成一个独立的 span，方便单独旋转。
  // 数字部分不变，每次切窗口克克都把按钮重置回"展开"+ 单箭头朝下。
  expandBtn.innerHTML = `展开 (${notedRecords.length})<span class="notes-expand-chev">▾</span>`;
  expandBtn.classList.remove('is-open');

  // 切窗口的时候默认折叠（不保留上一个窗口的展开状态）：
  // 用 class 而不是 hidden 属性，这样动画能跑起来
  listEl.hidden = false;
  listEl.classList.add('is-collapsed');

  // 列表内容：按时间倒序，最新的在上面
  const sorted = [...notedRecords].sort((a, b) => b.timestamp - a.timestamp);
  listEl.innerHTML = sorted.map((r) => {
    const t = new Date(r.timestamp);
    const timeStr = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
    // 用 escapeHtml 转义备注内容防 XSS
    const safeNote = escapeHtml(r.note);
    return `<div class="note-item">
      <div class="note-item-meta">${timeStr} · <span class="note-item-pct">${r.fiveH}%</span></div>
      <div class="note-item-text">${safeNote}</div>
    </div>`;
  }).join('');
}

// 渲染"调起点"面板：toggle 按钮跟窗口存在与否，面板用 .is-open 控制展开动画
function renderAdjustPanel(window, windows) {
  const toggleBtn = $('#adjust-toggle-btn');
  const panel = $('#adjust-panel');
  const hint = $('#adjust-hint');
  const dateInput = $('#adjust-date');
  const hourInput = $('#adjust-hour');
  const confirmBtn = $('#adjust-confirm-btn');

  // 没窗口时按钮藏起来、面板收回去（不再用 hidden 属性，让 max-height 动画接管）
  panel.hidden = false;
  if (!window) {
    toggleBtn.hidden = true;
    panel.classList.remove('is-open');
    state.adjustOpen = false;
    return;
  }
  toggleBtn.hidden = false;
  toggleBtn.textContent = state.adjustOpen ? '✕ 收起' : '✏️ 调起点';

  if (!state.adjustOpen) {
    panel.classList.remove('is-open');
    return;
  }

  const range = getWindowAdjustRange(window, windows);
  panel.classList.add('is-open');

  // 整个范围被夹死、连原起点都没法保持的情况几乎不会发生，但兜底处理
  if (range.minStart > range.maxStart) {
    hint.textContent = '这个窗口被前后夹得严严实实，挪不动 (｡•́︿•̀｡)';
    dateInput.disabled = true;
    hourInput.disabled = true;
    confirmBtn.disabled = true;
    return;
  }

  dateInput.disabled = false;
  hourInput.disabled = false;
  confirmBtn.disabled = false;

  const minD = new Date(range.minStart);
  const maxD = new Date(range.maxStart);
  hint.textContent = `这个窗口可以挪到 ${formatHintTime(minD)} 到 ${formatHintTime(maxD)} 之间`;

  // min/max 边界每次 render 都更新（反映相邻窗口的最新状态），但不在这里写 value——
  // 否则 renderAll 触发时（切主题/保存/同步）会把用户正在编辑的输入吞掉
  dateInput.min = formatYMD(minD);
  dateInput.max = formatYMD(maxD);
}

function formatYMD(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatHintTime(d) {
  const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
  return `${d.getMonth() + 1}/${d.getDate()} 周${dayNames[d.getDay()]} ${hm(d)}`;
}

// 把窗口当前起点填进输入框作为初始默认值，只在"关→开"瞬间调用
function seedAdjustInputs(window) {
  const curD = new Date(window.startTime);
  $('#adjust-date').value = formatYMD(curD);
  $('#adjust-hour').value = curD.getHours();
  // 分钟抹到十分钟刻度，和窗口起点的取整粒度一致
  $('#adjust-min').value = Math.floor(curD.getMinutes() / 10) * 10;
}

function toggleAdjustPanel() {
  const opening = !state.adjustOpen;
  state.adjustOpen = opening;
  const windows = computeWindows(state.records);
  const w = windows.find((x) => x.id === state.selectedHistoryWindowId);
  if (opening && w) seedAdjustInputs(w);
  renderAdjustPanel(w, windows);
}

function cancelAdjustPanel() {
  state.adjustOpen = false;
  const windows = computeWindows(state.records);
  const w = windows.find((x) => x.id === state.selectedHistoryWindowId);
  renderAdjustPanel(w, windows);
}

function confirmAdjustWindow() {
  const windows = computeWindows(state.records);
  const w = windows.find((x) => x.id === state.selectedHistoryWindowId);
  if (!w) return;

  const dateStr = $('#adjust-date').value;
  const hour = parseInt($('#adjust-hour').value, 10);
  const minute = parseInt($('#adjust-min').value, 10);
  const parts = dateStr ? dateStr.split('-').map((s) => parseInt(s, 10)) : [];
  if (parts.length !== 3 || parts.some(isNaN) || isNaN(hour) || hour < 0 || hour > 23
      || isNaN(minute) || minute < 0 || minute > 59) {
    showToast('日期或时间不太对～');
    return;
  }
  const newD = new Date(parts[0], parts[1] - 1, parts[2], hour, minute, 0, 0);
  const newId = newD.getTime();
  const oldId = w.id;
  if (newId === oldId) {
    showToast('起点没变哦 (｡•́︿•̀｡)');
    return;
  }

  const range = getWindowAdjustRange(w, windows);
  if (newId < range.minStart || newId > range.maxStart) {
    showToast('有点超出范围啦，看看上面的提示～');
    return;
  }

  // 标记这次编辑的时刻：调起点只改 windowId、不动 timestamp（timestamp 是读数的逻辑
  // 时刻，分周和画图都靠它，不能乱动）。所以单独写 updatedAt，让云同步能认出这次修改，
  // 否则另一台拉取时会因为 timestamp 没变而误判"本地更新"，把这次调整丢掉。
  const editedAt = Date.now();
  for (const r of state.records) {
    if (r.windowId === oldId) {
      r.windowId = newId;
      r.updatedAt = editedAt;
    }
  }
  if (state.selectedHistoryWindowId === oldId) {
    state.selectedHistoryWindowId = newId;
  }
  state.adjustOpen = false;

  saveData();
  resetDraft();
  renderAll();
  showToast('起点挪好啦 ✨');
}

// 简单的 HTML 转义，防止备注里的 <script> 之类被当 HTML 渲染
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* =================================================
   11. 设置面板
   ================================================= */

function openSettings() {
  $('#setting-weekly-day').value = state.settings.weeklyResetDay;
  $('#setting-weekly-hour').value = state.settings.weeklyResetHour;
  fillSyncInputs();
  renderResetCard();
  // renderPeakCardDST(); — 高峰机制暂停
  renderConfigSummary();
  // 同步「跟随系统深浅色」开关状态
  const themeSystemToggle = $('#theme-system-toggle');
  if (themeSystemToggle) themeSystemToggle.checked = getThemeMode() === 'system';
  const mask = $('#settings-modal');
  mask.classList.remove('is-closing');
  mask.hidden = false;
}

// 渲染"这周的起点"卡的状态化展示
function renderResetCard() {
  const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
  const day = state.settings.weeklyResetDay;
  const hour = state.settings.weeklyResetHour;
  const dayEl = $('#reset-stat-day');
  const timeEl = $('#reset-stat-time');
  if (dayEl) dayEl.textContent = `周${dayNames[day]} · ${pad(hour)}:00`;
  if (timeEl) {
    const now = Date.now();
    const weekEnd = getWeekEnd(getWeekStart(now, state.settings), state.settings);
    const remainingMs = weekEnd - now;
    timeEl.textContent = remainingMs > 0
      ? `距下次重置 ${formatRemainingUntilReset(remainingMs)}`
      : '距下次重置 马上就到啦 ✨';
  }
}

// 渲染高峰卡的 DST 切换显示
function renderPeakCardDST() {
  const peakEl = $('#peak-text');
  const dstLine = $('#peak-dst-line');
  if (!peakEl || !dstLine) return;
  const now = new Date();
  const dst = isUSinDST(now);
  peakEl.textContent = dst ? '20:00 — 02:00' : '21:00 — 03:00';

  const { start, end } = getUSDSTBounds(now.getFullYear());
  const fmtMD = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  if (dst) {
    const next = end < now ? getUSDSTBounds(now.getFullYear() + 1).end : end;
    dstLine.innerHTML = `现在按<b>美国夏令时</b>显示。${fmtMD(next)} 后切回 21:00 — 03:00`;
  } else {
    const next = start < now ? getUSDSTBounds(now.getFullYear() + 1).start : start;
    dstLine.innerHTML = `现在按<b>美国冬令时</b>显示。${fmtMD(next)} 后切到 20:00 — 02:00`;
  }
}

// 渲染同步配置卡的 summary：已配置时显示脱敏摘要，未配置时默认展开折叠区
function renderConfigSummary() {
  const c = syncState.config;
  const meta = $('#config-status-meta');
  const summary = $('#config-summary');
  const mkHint = $('#config-mk-hint');
  const binHint = $('#config-bin-hint');
  const foldable = $('#config-foldable');
  if (!meta || !foldable) return;
  if (c && c.masterKey && c.binId) {
    meta.textContent = '已配置';
    if (summary) summary.style.display = '';
    if (mkHint) mkHint.textContent = '●●●●●●●●●●●●';
    if (binHint) binHint.textContent = c.binId.length > 14 ? c.binId.slice(0, 10) + '…' : c.binId;
    foldable.classList.remove('is-open');
  } else {
    meta.textContent = '未配置';
    if (summary) summary.style.display = 'none';
    foldable.classList.add('is-open');
  }
}

// 用户被 Anthropic 临时重置了 weekly 额度时按一下，把"现在"钉为新一周起点。
// 注意语义：官方临时重置只是"中途清零一次"，每周固定的重置日程并不会跟着挪——
// 比如正常周一刷新、周三被临时刷了，那这个短周是"周三 → 下周一"，之后照旧每周一刷新。
// 所以这里除了钉新起点，还要再安排一条"到下个正常重置时刻自动归位"的规则（kind:'realign'），
// 让短周在正常时刻结束、之后的周期回到原来的节奏上。
async function markWeeklyResetNow() {
  const ok = await confirmDialog({
    icon: '🌱',
    title: '从这一刻起算新一周？',
    message: '之前的记录会原样留在上一周～\n从现在起 weekly 从 0 重新出发，到下个正常重置时刻自动归位，每周的重置节奏保持不变；正在跑的 5h 窗口也就此画上句号，下一笔会开一个全新窗口。',
    confirmText: '从这里出发',
    cancelText: '再想想',
  });
  if (!ok) return;

  // anchor 钉到整点而不是任意时刻，让"周X · HH:00"显示和实际重置时刻完全一致。
  // 但取整不能把按钮之前已记的数据划进新一周（那是旧周期的数值），
  // 有记录落在取整点之后时，把锚点往后挪到最后一笔之后
  let anchorTs = floorToHour(Date.now());
  let lastRecTs = -Infinity;
  for (const r of state.records) {
    if (r.timestamp > lastRecTs) lastRecTs = r.timestamp;
  }
  if (lastRecTs >= anchorTs) {
    anchorTs = floorToStep(Date.now());
    if (lastRecTs >= anchorTs) anchorTs = lastRecTs + 1;
  }

  // 记下这道硬重置闸门：起点早于它的 5h 窗口到此为止，下一笔必开新窗口
  if (!Array.isArray(state.settings.hardResets)) state.settings.hardResets = [];
  state.settings.hardResets.push(anchorTs);
  state.settings.hardResets.sort((a, b) => a - b);

  // 链尾可能挂着一条"还没生效"的未来规则——在设置里改过「周重置时间」会留下它
  // （from = 下一个目标时刻，比"现在"晚）。这种情况下直接 appendWeeklyRule 会撞上
  // 它的"防倒灌"闸（rule.from < last.from 就忽略），让这次重置被静默丢掉：动画照放、
  // 底层却没动。「立即重置」的语义就是从现在起算，那些还没生效的未来安排理应作废，
  // 先把链尾这类未来规则剥掉，剥完链尾必然 from <= anchorTs，append 就不会再被吞。
  const rules = state.settings.weeklyRules;
  if (Array.isArray(rules)) {
    while (rules.length > 1 && rules[rules.length - 1].from > anchorTs) {
      rules.pop();
    }
  }

  // 剥完未来规则后，链尾那条就是"当前真正在生效的每周日程"。
  // 临时重置不改日程，所以新规则沿用它的 day/hour，而不是按下按钮那一刻的星期/钟点。
  const effRule = Array.isArray(rules) && rules.length > 0 ? rules[rules.length - 1] : null;
  const effDay = effRule ? effRule.day : state.settings.weeklyResetDay;
  const effHour = effRule ? effRule.hour : state.settings.weeklyResetHour;

  // 往规则链末尾追加两条：
  // 1) 锚点规则：短周从"现在"起算——之前那一段的 day/hour 自动留在 rules[len-2]，
  //    翻 ◀ 时上一段会按"重置前那一刻的真实规则"切，不会被锁死成史前期那条老规则；
  // 2) 归位规则（kind:'realign'）：短周到下个正常重置时刻结束，之后回到每周固定节奏。
  //    getWeekEnd 碰到它会把短周截断在正常时刻，getWeekStart 从它起每 7 天一轮，
  //    正好和原日程对齐。
  appendWeeklyRule(state.settings, {
    from: anchorTs,
    day: effDay,
    hour: effHour,
  });
  appendWeeklyRule(state.settings, {
    from: nextOccurrence(anchorTs, effDay, effHour),
    day: effDay,
    hour: effHour,
    kind: 'realign',
  });
  state.settings.lastModifiedAt = Date.now();
  state.selectedWeekStart = null;

  // 同步回 input 控件——关面板时 closeSettings 会读它们写回 state，不同步就会被旧值反向覆盖。
  const dayInput = $('#setting-weekly-day');
  const hourInput = $('#setting-weekly-hour');
  if (dayInput) dayInput.value = state.settings.weeklyResetDay;
  if (hourInput) hourInput.value = state.settings.weeklyResetHour;

  // —— 播 "消解 → 脉动 → 🌱 → 浮入 → 气泡" 五段动画 ——
  const dayEl = $('#reset-stat-day');
  const timeEl = $('#reset-stat-time');
  const card = document.querySelector('.reset-card');
  const sprout = card && card.querySelector('.sprout-emoji');
  const toast = card && card.querySelector('.reset-confirm-toast');

  // t=0 旧文本上飘消解
  fireAnim(dayEl,  'is-dissolving', 0);
  fireAnim(timeEl, 'is-dissolving', 0);
  // t=80 卡片青绿色脉动
  setTimeout(() => fireAnim(card, 'is-pulsing', 1000), 80);
  // t=200 中央 🌱 萌芽
  setTimeout(() => fireAnim(sprout, 'is-popping', 1050), 200);
  // t=360 写新值 + 文本浮入；这里才真正调 saveData / renderAll，
  // 让旧文本能完整地"消解"完再被替换
  setTimeout(() => {
    resetDraft();
    saveData();
    renderAll();
    renderResetCard();
    if (dayEl)  { dayEl.classList.remove('is-dissolving');  fireAnim(dayEl,  'is-sprouting', 500); }
    if (timeEl) { timeEl.classList.remove('is-dissolving'); fireAnim(timeEl, 'is-sprouting', 500); }
  }, 360);
  // t=450 底部气泡
  setTimeout(() => fireAnim(toast, 'is-showing', 1900), 450);
}

// 把面板里的「周重置时间」输入写回 state，返回是否真的改了。
// 关面板和点保存键共用这段，逻辑只留一份。
function applyWeeklySettings() {
  // 高峰相关字段不再读取——按官方公告内置、跟着 DST 自动算
  const oldDay = state.settings.weeklyResetDay;
  const oldHour = state.settings.weeklyResetHour;
  const newDay = parseInt($('#setting-weekly-day').value, 10);
  const newHour = parseInt($('#setting-weekly-hour').value, 10);

  // 用户真的改了周起点（day 或 hour）→ 让新规则从"下一个目标时刻"起生效，
  // 而不是"改设置那一刻"——这样本周自然延续到目标时刻，显示的"周X · HH:00"和
  // 实际重置时刻一致；之前的记录仍归在本周内。
  // 想立刻重置请按"立即重置"按钮（markWeeklyResetNow 才用 from = now 的语义）。
  // 高峰设置和周起点无关，所以改高峰时不触发。
  const weeklyChanged = newDay !== oldDay || newHour !== oldHour;
  if (weeklyChanged) {
    const now = Date.now();
    const targetFrom = nextOccurrence(now, newDay, newHour);
    const rules = state.settings.weeklyRules;
    const last = rules && rules.length > 0 ? rules[rules.length - 1] : null;
    // kind:'manual' 标记"用户亲手改的日程"，重置时间线靠它显示「改了重置时间」；
    // 没这个标记的历史老节点只能靠启发式猜出身
    if (last && last.from > now) {
      // 末条规则还没生效（上次改设置/未来 anchor 还挂着）→ 替换，不追加，
      // 避免链上堆一串都没生效过的"幽灵规则"
      rules[rules.length - 1] = { from: targetFrom, day: newDay, hour: newHour, kind: 'manual' };
      state.settings.weeklyResetDay = newDay;
      state.settings.weeklyResetHour = newHour;
    } else {
      appendWeeklyRule(state.settings, { from: targetFrom, day: newDay, hour: newHour, kind: 'manual' });
    }
    state.settings.lastModifiedAt = now;
    // 周起点变了，"正在看的是哪一周"这个选中状态也失效——重置回"本周"
    state.selectedWeekStart = null;
    // 输入卡的 prevWeekly / isNewWeek 需要立刻按新规则重算，
    // 不然保存完面板关闭后还会显示改设置前的"上次值"
    resetDraft();
  }
  return weeklyChanged;
}

// 折叠区里点「保存」：写回设置 → 收起折叠 → 上方文字浮动刷新 + 气泡反馈
function saveWeeklySettings() {
  applyWeeklySettings();
  saveData();

  // 收起「改重置时间」折叠区
  const btn = $('#weekly-save-btn');
  const foldable = btn && btn.closest('.foldable');
  if (foldable) foldable.classList.remove('is-open');

  // 其它依赖周起点的卡也跟着新规则刷新
  renderAll();

  // 上方状态文字带"消解 → 浮入"动画刷新成新值
  const dayEl = $('#reset-stat-day');
  const timeEl = $('#reset-stat-time');
  fireAnim(dayEl,  'is-dissolving', 0);
  fireAnim(timeEl, 'is-dissolving', 0);
  setTimeout(() => {
    renderResetCard();
    if (dayEl)  { dayEl.classList.remove('is-dissolving');  fireAnim(dayEl,  'is-sprouting', 500); }
    if (timeEl) { timeEl.classList.remove('is-dissolving'); fireAnim(timeEl, 'is-sprouting', 500); }
  }, 340);

  // "已保存 ✓"小气泡
  fireAnim($('#reset-save-toast'), 'is-showing', 1300);
}

function closeSettings() {
  applyWeeklySettings();
  saveData();

  // 关闭动画：加 .is-closing 触发遮罩淡出 + 弹层下滑，
  // 等遮罩的 fadeOut 动画跑完之后再 hidden=true 并把 class 清掉，
  // 这样下一次打开是干净的初始状态、能正常播放打开动画。
  const mask = $('#settings-modal');
  mask.classList.add('is-closing');
  const onEnd = (e) => {
    // animationend 会在每个有动画的元素上各触发一次，
    // 只认遮罩自己的 fadeOut 那一次就行
    if (e.target !== mask || e.animationName !== 'fadeOut') return;
    mask.hidden = true;
    mask.classList.remove('is-closing');
    mask.removeEventListener('animationend', onEnd);
    renderAll();
  };
  mask.addEventListener('animationend', onEnd);
}

function exportJSON() {
  const data = {
    records: state.records,
    notes: state.notes,
    settings: state.settings,
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `limit-diary-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('已导出 ✨');
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (Array.isArray(data.records)) {
        state.records = data.records;
        state.notes = data.notes || {};
        state.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
        migrateSettings(state.settings);
        // 导入的也可能是旧格式，统一迁移一遍
        migrateNotesToRecords();
        saveData();
        resetDraft();
        renderAll();
        showToast('已导入 ✨');
      } else {
        showToast('文件格式不对');
      }
    } catch (err) {
      showToast('文件解析失败');
    }
  };
  reader.readAsText(file);
}

async function clearAllData() {
  // 第一道确认：软一点的提醒
  const firstOk = await confirmDialog({
    icon: '🗑️',
    title: '真的要清空所有数据吗？',
    message: '这个操作不能撤销哦 (｡•́︿•̀｡)',
    confirmText: '继续',
    cancelText: '算了',
    danger: true,
  });
  if (!firstOk) return;

  // 第二道确认：明确列出会丢失的东西
  const secondOk = await confirmDialog({
    icon: '⚠️',
    title: '再次确认',
    message: '所有的记录、备注、设置都会被清掉。\n确定要继续吗？',
    confirmText: '确定清空',
    cancelText: '算了不清了',
    danger: true,
  });
  if (!secondOk) return;

  state.records = [];
  state.notes = {};
  state.settings = { ...DEFAULT_SETTINGS };
  // DEFAULT_SETTINGS 里的 weeklyRules 是共享数组，这里 migrate 顺手深拷贝一份
  migrateSettings(state.settings);
  state.selectedHistoryWindowId = null;
  state.selectedWeekStart = null;
  saveData();
  resetDraft();
  renderAll();
  showToast('已清空');
}

/* =================================================
   11b. 云同步（jsonbin.io）
   ================================================= */

const SYNC_CONFIG_KEY = 'limit-diary-sync';
const JSONBIN_BASE = 'https://api.jsonbin.io/v3';

// 本地节流：打开应用时，如果距上次成功同步还不到这个时长，就跳过自动拉取，
// 直接用本地缓存。默认开启，避免短时间内反复打开都打远端、也省额度。
// 手动点「同步」按钮（handleSyncNow）和设置里的「立即拉取/推送」不受这个限制。
const SYNC_THROTTLE_MS = 20 * 60 * 1000; // 20 分钟

const syncState = {
  config: null,      // { masterKey, binId, lastSyncedAt }
  inFlight: false,   // 当前有没有请求在进行中
  lastError: null,
};

function loadSyncConfig() {
  try {
    const raw = localStorage.getItem(SYNC_CONFIG_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    return obj;
  } catch (e) {
    return null;
  }
}

function saveSyncConfig(config) {
  if (config && config.masterKey && config.binId) {
    localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(config));
    syncState.config = config;
  } else {
    localStorage.removeItem(SYNC_CONFIG_KEY);
    syncState.config = null;
  }
  updateSyncButton();
}

function isSyncConfigured() {
  const c = syncState.config;
  return !!(c && c.masterKey && c.binId);
}

// 自动同步是否被用户暂停（只影响自动触发的拉取/推送，手动按钮仍然可用）
function isSyncPaused() {
  const c = syncState.config;
  return !!(c && c.paused);
}

function setSyncPaused(paused) {
  const c = syncState.config;
  if (!c) return;
  saveSyncConfig({ ...c, paused: !!paused });
}

// 本地节流是否生效：距上次成功同步还不到 SYNC_THROTTLE_MS。
// 只用来挡"打开应用时的自动拉取"，手动同步永远绕过它。
function isSyncThrottled() {
  const c = syncState.config;
  const last = (c && c.lastSyncedAt) || 0;
  return last > 0 && (Date.now() - last) < SYNC_THROTTLE_MS;
}

function syncHeaders(key) {
  return {
    'Content-Type': 'application/json',
    'X-Master-Key': key,
  };
}

// 构造推到云端的 payload：包含数据本身 + 一个 syncMeta 用于冲突判断。
// lastModified 用 settings 的真实修改时刻（settings.lastModifiedAt），
// 而不是"推送这一刻"——后者会让没改过设置的设备在 push/pull 时显得"永远最新"，
// 从而把云端真正较新的 settings 覆盖掉。只有真改设置，版本号才前进。
function buildSyncPayload(source) {
  return {
    records: state.records,
    notes: state.notes,
    settings: state.settings,
    syncMeta: {
      lastModified: state.settings.lastModifiedAt || 0,
      source: source || 'push',
    },
  };
}

// —— UI 状态更新 ——

function setSyncBusy(busy) {
  syncState.inFlight = busy;
  const box = $('#sync-status-box');
  const btn = $('#sync-btn');
  if (busy) {
    if (box) box.classList.add('is-syncing');
    if (btn) btn.classList.add('is-syncing');
  } else {
    if (box) box.classList.remove('is-syncing');
    if (btn) btn.classList.remove('is-syncing');
  }
}

function setSyncStatus(status, message) {
  const box = $('#sync-status-box');
  const btn = $('#sync-btn');
  const text = $('#sync-status-text');

  if (box) box.classList.remove('is-ok', 'is-error', 'is-syncing');
  if (btn) btn.classList.remove('is-ok', 'is-error', 'is-syncing');

  if (status === 'ok') {
    if (box) box.classList.add('is-ok');
    if (btn) btn.classList.add('is-ok');
    if (text) text.textContent = message || '已同步';
    syncState.lastError = null;
  } else if (status === 'error') {
    if (box) box.classList.add('is-error');
    if (btn) btn.classList.add('is-error');
    if (text) text.textContent = message || '同步失败';
    syncState.lastError = message || '';
  } else if (status === 'syncing') {
    if (box) box.classList.add('is-syncing');
    if (btn) btn.classList.add('is-syncing');
    if (text) text.textContent = message || '正在同步…';
  } else {
    if (text) text.textContent = message || '未配置';
  }
}

function updateSyncButton() {
  const btn = $('#sync-btn');
  if (!btn) return;
  btn.hidden = !isSyncConfigured();
  refreshSyncPauseIndicator();
}

// 把暂停态反映到顶栏按钮和状态条上（不改文本，只加/去 class）。
// 文本的"已暂停"提示在 fillSyncInputs 里处理，保证用户每次打开设置面板都能看见。
function refreshSyncPauseIndicator() {
  const btn = $('#sync-btn');
  const box = $('#sync-status-box');
  const paused = isSyncConfigured() && isSyncPaused();
  if (btn) btn.classList.toggle('is-paused', paused);
  if (box) box.classList.toggle('is-paused', paused);
}

// 打开设置面板时把当前配置填进输入框
function fillSyncInputs() {
  const keyEl = $('#sync-master-key');
  const idEl = $('#sync-bin-id');
  const autoEl = $('#sync-auto-toggle');
  if (!keyEl || !idEl) return;
  const c = syncState.config;
  keyEl.value = (c && c.masterKey) || '';
  idEl.value = (c && c.binId) || '';
  // 正向开关：开 = 自动同步、关 = 不自动同步。底层仍存 paused，这里取反。
  if (autoEl) autoEl.checked = !isSyncPaused();

  // 状态条也刷新一下
  if (isSyncConfigured()) {
    if (!syncState.lastError) {
      const last = c.lastSyncedAt ? new Date(c.lastSyncedAt) : null;
      const when = last
        ? `上次同步：${last.getMonth() + 1}/${last.getDate()} ${pad(last.getHours())}:${pad(last.getMinutes())}`
        : '已配置，尚未同步';
      if (isSyncPaused()) {
        setSyncStatus('ok', `⏸ 自动同步已关闭 · ${when}`);
      } else {
        setSyncStatus('ok', when);
      }
    } else {
      setSyncStatus('error', syncState.lastError);
    }
  } else {
    setSyncStatus(null, '未配置');
  }
  refreshSyncPauseIndicator();
}

// 一条记录"最后被改动"的时刻，用来在合并时判断同一条记录哪一份更新。
// 取 timestamp（创建/修正时刻）和 updatedAt（编辑时刻）里更大的那个：
//   - 普通记录没有 updatedAt → 回退到 timestamp，和旧行为完全一致；
//   - 「调起点」这类只改归属、不改数值的编辑会写 updatedAt（见 confirmAdjustWindow），
//     这样另一台设备拉取时能正确认出"对面改过了"，不再因 timestamp 相同而误判本地更新。
// timestamp 仍保留它原本"读数的逻辑时刻"语义（用于分周、画图），这里不改动它。
function recordModTime(r) {
  if (!r) return 0;
  return Math.max(r.timestamp || 0, r.updatedAt || 0);
}

// —— 合并策略 ——
// records: 按 id 去重，同 id 冲突时保留"最后被改动"较晚的那一份（见 recordModTime）
// notes: 对象合并，本地覆盖远程（本地是用户最近操作的）
// settings: 按 syncMeta.lastModified 较新的那一份
function mergeSyncData(remote, local) {
  const r = remote || {};
  const l = local || {};

  const recordMap = new Map();
  for (const rec of (r.records || [])) {
    if (rec && rec.id != null) recordMap.set(rec.id, rec);
  }
  for (const rec of (l.records || [])) {
    if (!rec || rec.id == null) continue;
    const existing = recordMap.get(rec.id);
    if (!existing) {
      recordMap.set(rec.id, rec);
    } else if (recordModTime(rec) >= recordModTime(existing)) {
      recordMap.set(rec.id, rec);
    }
  }
  const records = Array.from(recordMap.values())
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  const notes = { ...(r.notes || {}), ...(l.notes || {}) };

  const remoteTime = (r.syncMeta && r.syncMeta.lastModified) || 0;
  const localTime = (l.syncMeta && l.syncMeta.lastModified) || 0;
  const settings = remoteTime > localTime
    ? (r.settings || l.settings || {})
    : (l.settings || r.settings || {});

  return { records, notes, settings };
}

// —— 网络操作 ——

async function syncInit(masterKey) {
  if (!masterKey) throw new Error('Master Key 不能为空');
  setSyncBusy(true);
  setSyncStatus('syncing', '正在创建云端备份…');

  try {
    const payload = buildSyncPayload('init');
    const resp = await fetch(`${JSONBIN_BASE}/b`, {
      method: 'POST',
      headers: {
        ...syncHeaders(masterKey),
        'X-Bin-Name': `limit-diary-${new Date().toISOString().slice(0, 10)}`,
        'X-Bin-Private': 'true',
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HTTP ${resp.status} - ${text.slice(0, 120)}`);
    }
    const data = await resp.json();
    const binId = (data.metadata && data.metadata.id) || (data.record && data.record.id);
    if (!binId) throw new Error('没拿到 bin ID');

    saveSyncConfig({
      masterKey,
      binId,
      lastSyncedAt: Date.now(),
    });

    setSyncBusy(false);
    setSyncStatus('ok', '已创建并推送 ✨');
    const idEl = $('#sync-bin-id');
    if (idEl) idEl.value = binId;
    return binId;
  } catch (e) {
    setSyncBusy(false);
    setSyncStatus('error', `初始化失败：${e.message}`);
    throw e;
  }
}

async function syncPull(silent) {
  const c = syncState.config;
  if (!c || !c.masterKey || !c.binId) {
    throw new Error('未配置云同步');
  }
  setSyncBusy(true);
  if (!silent) setSyncStatus('syncing', '正在拉取远程数据…');

  try {
    const resp = await fetch(`${JSONBIN_BASE}/b/${c.binId}/latest`, {
      headers: syncHeaders(c.masterKey),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HTTP ${resp.status} - ${text.slice(0, 120)}`);
    }
    const data = await resp.json();
    const remote = data.record || {};

    const local = {
      records: state.records,
      notes: state.notes,
      settings: state.settings,
      // 关键：用本地 settings 的真实修改时刻，而不是 Date.now()。
      // 用后者的话本地版本号"永远最新"，云端的 settings 永远拉不下来。
      syncMeta: { lastModified: state.settings.lastModifiedAt || 0, source: 'local' },
    };
    const merged = mergeSyncData(remote, local);

    state.records = merged.records;
    state.notes = merged.notes || {};
    state.settings = { ...DEFAULT_SETTINGS, ...(merged.settings || {}) };
    // 云端可能是老格式（没 weeklyRules）或来自另一台已经升级的设备，统一过一遍 migrate
    migrateSettings(state.settings);

    // 云端数据合并进来后，输入卡的 draft 状态（上次值、当前窗口 ID 等）
    // 是基于"旧 records"算的，已经过时了。重算 draft，让 renderAll() 看到最新状态。
    // 如果用户正在编辑，但窗口已经变了（云端带来了新窗口的记录），也要强制刷新——
    // 和 maybeRefreshDraft 同样的逻辑：旧窗口的编辑对新窗口没意义。
    const draftUntouched =
      state.draft5h === state.draftPrev5h &&
      state.draftWeekly === state.draftPrevWeekly;
    if (draftUntouched) {
      resetDraft();
    } else {
      const lastRecord = state.records[state.records.length - 1];
      const windowChanged = !lastRecord || lastRecord.windowId !== state.draftWindowId;
      if (windowChanged) resetDraft();
    }

    saveData();
    saveSyncConfig({ ...c, lastSyncedAt: Date.now() });

    setSyncBusy(false);
    setSyncStatus('ok', '已同步');
    return true;
  } catch (e) {
    setSyncBusy(false);
    setSyncStatus('error', `拉取失败：${e.message}`);
    if (!silent) showToast('拉取失败 (｡•́︿•̀｡)');
    throw e;
  }
}

async function syncPush(silent) {
  const c = syncState.config;
  if (!c || !c.masterKey || !c.binId) return false;

  setSyncBusy(true);
  if (!silent) setSyncStatus('syncing', '正在推送…');

  try {
    const payload = buildSyncPayload('push');
    const resp = await fetch(`${JSONBIN_BASE}/b/${c.binId}`, {
      method: 'PUT',
      headers: syncHeaders(c.masterKey),
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`HTTP ${resp.status} - ${text.slice(0, 120)}`);
    }
    saveSyncConfig({ ...c, lastSyncedAt: Date.now() });
    setSyncBusy(false);
    setSyncStatus('ok', '已同步');
    return true;
  } catch (e) {
    setSyncBusy(false);
    setSyncStatus('error', `推送失败：${e.message}`);
    if (!silent) showToast('推送失败 (｡•́︿•̀｡)');
    return false;
  }
}

// —— 同步配置字符串（跨设备一键导入）——

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToUtf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function exportSyncConfigString() {
  const c = syncState.config;
  if (!c || !c.masterKey || !c.binId) return null;
  try {
    return utf8ToBase64(JSON.stringify({ k: c.masterKey, b: c.binId }));
  } catch (e) {
    return null;
  }
}

function parseSyncConfigString(str) {
  if (!str) return null;
  try {
    const json = base64ToUtf8(str.trim());
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== 'object' || !obj.k || !obj.b) return null;
    return { masterKey: obj.k, binId: obj.b };
  } catch (e) {
    return null;
  }
}

// —— 按钮事件处理 ——

async function handleSyncInit() {
  const keyEl = $('#sync-master-key');
  if (!keyEl) return;
  const key = keyEl.value.trim();
  if (!key) {
    showToast('先填 Master Key 哦');
    return;
  }
  if (state.records.length > 0) {
    const ok = await confirmDialog({
      icon: '🪄',
      title: '要创建一个新 bin 吗？',
      message: `会把你本地的 ${state.records.length} 条记录上传到云端，作为新 bin 的初始内容。`,
      confirmText: '好的，创建',
      cancelText: '再想想',
    });
    if (!ok) return;
  }
  try {
    await syncInit(key);
    showToast('初始化成功 ✨');
  } catch (e) {
    // 错误已在 syncInit 里通过 setSyncStatus 显示
  }
}

// 设置页顶部的「同步」按钮：等同于打开应用时的自动同步——拉取最新数据并合并。
// 手动触发，绕过本地节流。
async function handleSyncNow() {
  if (!isSyncConfigured()) {
    showToast('先配置云同步哦');
    return;
  }
  try {
    await syncPull(false);
    renderAll();
    showToast('已同步 ✨');
  } catch (e) {
    // 错误状态已在 syncPull 里通过 setSyncStatus 显示
  }
}

async function handleSyncPullBtn() {
  // 按钮里的配置可能比 syncState.config 更新，先读取一次
  const keyEl = $('#sync-master-key');
  const idEl = $('#sync-bin-id');
  const key = keyEl ? keyEl.value.trim() : '';
  const binId = idEl ? idEl.value.trim() : '';
  if (!key || !binId) {
    showToast('需要 Master Key 和 Bin ID');
    return;
  }
  // 如果和当前 config 不一致，先保存
  const c = syncState.config;
  if (!c || c.masterKey !== key || c.binId !== binId) {
    saveSyncConfig({ masterKey: key, binId, lastSyncedAt: (c && c.lastSyncedAt) || 0 });
  }
  try {
    await syncPull(false);
    renderAll();
    showToast('已拉取最新 ✨');
  } catch (e) {}
}

async function handleSyncPushBtn() {
  const keyEl = $('#sync-master-key');
  const idEl = $('#sync-bin-id');
  const key = keyEl ? keyEl.value.trim() : '';
  const binId = idEl ? idEl.value.trim() : '';
  if (!key || !binId) {
    showToast('需要 Master Key 和 Bin ID');
    return;
  }
  const c = syncState.config;
  if (!c || c.masterKey !== key || c.binId !== binId) {
    saveSyncConfig({ masterKey: key, binId, lastSyncedAt: (c && c.lastSyncedAt) || 0 });
  }
  try {
    const ok = await syncPush(false);
    if (ok) showToast('已推送 ✨');
  } catch (e) {}
}

async function handleSyncClear() {
  const ok = await confirmDialog({
    icon: '🚫',
    title: '解除云同步？',
    message: '只会清除本地保存的 Master Key 和 Bin ID。云端的数据不会被删除，之后可以重新连接。',
    confirmText: '解除',
    cancelText: '算了',
    danger: true,
  });
  if (!ok) return;
  saveSyncConfig(null);
  fillSyncInputs();
  showToast('已解除云同步');
}

async function handleSyncExportString() {
  const str = exportSyncConfigString();
  if (!str) {
    showToast('先配置好云同步');
    return;
  }
  try {
    await navigator.clipboard.writeText(str);
    showToast('已复制到剪贴板 📋');
  } catch (e) {
    // 剪贴板权限失败，降级到对话框显示
    await confirmDialog({
      icon: '📋',
      title: '手动复制下面这段',
      message: str,
      confirmText: '好',
      cancelText: '取消',
    });
  }
}

async function handleSyncImportString() {
  const input = prompt('粘贴同步配置字符串：');
  if (!input) return;
  const parsed = parseSyncConfigString(input);
  if (!parsed) {
    showToast('配置字符串格式不对');
    return;
  }
  saveSyncConfig({ ...parsed, lastSyncedAt: 0 });
  fillSyncInputs();
  showToast('已导入，开始拉取…');
  try {
    await syncPull(false);
    renderAll();
    showToast('已同步 ✨');
  } catch (e) {}
}

/* =================================================
   12. 工具函数 & Toast
   ================================================= */

function $(sel) {
  return document.querySelector(sel);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// 把一个 Date 格式化成 HH:MM（窗口起止现在精确到十分钟）
function hm(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

let toastTimer = null;
function showToast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
}

// 治愈风自定义确认弹窗。替代原生 confirm()，让弹窗和整个项目的视觉风格一致。
// 返回 Promise<boolean>：true = 用户点了"确定"、false = 用户点了"取消"/ESC/点遮罩。
// opts 支持：
//   title        主标题（粗体、居中）
//   message      详细说明（细体、可多行，支持 \n）
//   confirmText  确定按钮的文字，默认 "确定"
//   cancelText   取消按钮的文字，默认 "再想想"
//   icon         顶部的大号 emoji 图标，默认 "❓"
//   danger       true 时把确定按钮染成珊瑚橘警示色（清空数据这种不可逆操作用）
function confirmDialog(opts = {}) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal confirm-dialog${opts.danger ? ' is-danger' : ''}">
        <div class="confirm-icon">${opts.icon || '❓'}</div>
        <div class="confirm-title">${escapeHtml(opts.title || '确定要这么做吗？')}</div>
        ${opts.message ? `<div class="confirm-message">${escapeHtml(opts.message)}</div>` : ''}
        <div class="confirm-buttons">
          <button type="button" class="confirm-btn confirm-btn--cancel">${escapeHtml(opts.cancelText || '再想想')}</button>
          <button type="button" class="confirm-btn confirm-btn--confirm">${escapeHtml(opts.confirmText || '确定')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(mask);

    const cancelBtn = mask.querySelector('.confirm-btn--cancel');
    const confirmBtn = mask.querySelector('.confirm-btn--confirm');

    // 默认把焦点放在"取消"上，避免用户一个不留神 Enter 就误触确定
    requestAnimationFrame(() => cancelBtn.focus());

    let settled = false;
    const close = (result) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      // 复用 settings-modal 的关闭动画：淡出遮罩 + 下滑弹层
      mask.classList.add('is-closing');
      const onEnd = (e) => {
        if (e.target !== mask || e.animationName !== 'fadeOut') return;
        mask.removeEventListener('animationend', onEnd);
        mask.remove();
      };
      mask.addEventListener('animationend', onEnd);
      resolve(result);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      else if (e.key === 'Enter') { e.preventDefault(); close(true); }
    };
    document.addEventListener('keydown', onKey);

    cancelBtn.addEventListener('click', () => close(false));
    confirmBtn.addEventListener('click', () => close(true));
    mask.addEventListener('click', (e) => {
      // 只有点到遮罩本身才关闭；点到弹层里不关
      if (e.target === mask) close(false);
    });
  });
}

// 控制第二屏图表动画的 flag：
// - true（init 阶段）：图表 new 出来后立即 reset 到初始状态等待滚动入场
// - false（用户滚到第二屏后）：图表正常带动画绘制
// 这样图表的动画和滚动入场视觉同步，而不是 init 时偷偷在 body 透明阶段画完
let chartsInInitialState = true;

// 公用的"慢慢长出来"动画配置：
// - duration 较长，让动画感觉舒缓
// - easeOutQuart 末尾减速，收尾柔和
// - delay 函数让每个数据点错开出场：
//   柱状图变成"一根一根从左到右长起来"
//   折线图变成"一个一个点依次冒出来 + 线段慢慢连起来"
//
// 总时长封顶（maxTotal，默认 2500ms）：
// 之前的逻辑是 stagger × pointCount，点一多（30 个窗口左右）总时长就到 4 秒，
// 显得拖。现在如果调用方传了 pointCount，就根据它把每点间隔自动压扁，
// 保证 duration + (pointCount-1) × stagger ≤ maxTotal。点少时不受影响。
function chartAnimation(opts = {}) {
  const duration = opts.duration || 1300;
  const requestedStagger = opts.stagger || 55;
  const maxTotal = opts.maxTotal || 2500;
  const pointCount = opts.pointCount || 0;
  // datasetDelay：按 datasetIndex 给额外的起始延迟。
  // 比如 weekly 图里预测那条虚线要等"实际线画完"才出现——就给它传一个
  // 大于实际线动画总时长的起始延迟，让它在后面慢慢接上来，不再抢跑。
  // 支持传函数：函数收到压缩后的真实 stagger，方便按"实际线点数 × stagger"来算延迟。
  let stagger = requestedStagger;
  if (pointCount > 1) {
    const maxStagger = Math.max(0, (maxTotal - duration) / (pointCount - 1));
    stagger = Math.min(requestedStagger, maxStagger);
  }
  const datasetDelay = typeof opts.datasetDelay === 'function'
    ? opts.datasetDelay(stagger)
    : (opts.datasetDelay || null);
  return {
    duration,
    easing: 'easeOutQuart',
    delay: (context) => {
      if (context.type === 'data' && context.mode === 'default') {
        const base = datasetDelay && datasetDelay[context.datasetIndex] != null
          ? datasetDelay[context.datasetIndex]
          : 0;
        return base + context.dataIndex * stagger;
      }
      return 0;
    },
    // 入场动画跑完之后切到"稳态动画"——不带 delay、duration 也短。
    // 不这么做的话，之后 hover 触发的内部 update 也会走同一套 delay 配置，
    // 所有点被 Chart.js 拽回起点等着"重新出场"，视觉上表现为
    // "一 hover 所有点全跑到最底下不动了"。
    // $steadyAnim 标记让这个切换只发生一次，之后所有更新都平滑进行。
    onComplete: (ctx) => {
      const chart = ctx.chart;
      if (!chart.$steadyAnim) {
        chart.$steadyAnim = true;
        chart.options.animation = {
          duration: 400,
          easing: 'easeOutQuart',
        };
      }
    },
  };
}

// WeakMap 存每个 chart 的"真实入场动画"配置。
// 为什么用 WeakMap：chart 被 destroy 时自动清理，不会残留。
// 为什么需要存：init 阶段第二屏 chart 必须用 animation:false 创建，
// 否则 Chart.js 会在下一帧偷偷把初始动画播完——等用户滚到第二屏时
// 动画早就结束了。等真正滚到视口里再把这个配置恢复回去 + reset + update，
// 才能让动画和"用户看到"的时机对齐。
const chartEnterAnimations = new WeakMap();

// 用正确的 animation 配置新建 chart 的小包装：
// - init 阶段把 options.animation 覆盖成 false（禁掉初始动画），
//   然后立即 reset() 把元素拉回起点。这样 chart 创建完就静静停在
//   "柱子高 0 / 点在底" 的初始状态，不会偷偷播动画。
// - 把真实 animation 配置挂到 WeakMap，供 scroll reveal 时恢复并重播
// - 非 init 阶段（比如主题切换触发的 renderWeeklyChart('rebuild')）
//   直接用真实动画，行为和以前一样
function createChartWithEnterAnim(ctx, config, enterAnimOpts) {
  const enterAnim = chartAnimation(enterAnimOpts);
  config.options = {
    ...config.options,
    animation: chartsInInitialState ? false : enterAnim,
  };
  const chart = new Chart(ctx, config);
  chartEnterAnimations.set(chart, enterAnim);
  if (chartsInInitialState) {
    // 立即停在起点，避免用户滚到第二屏时看到"从最终态跳回起点再长出来"的闪烁
    chart.reset();
  }
  return chart;
}

// 翻页切换图表时的"淡出 → 重建 → 淡入"过渡。
// 原来的切换是 destroy 瞬间消失 + new Chart 慢慢长出来，视觉上不对称。
// 现在先给 wrap 加 .is-leaving 让 opacity 过渡到 0，过渡结束后再真正重建，
// 然后下一帧去掉 class，wrap 淡回来的同时 Chart.js 自己的入场动画也在播，
// 前后都有"渐变"节奏，对称且柔和。
function crossFadeChart(wrapEl, swap) {
  if (!wrapEl) { swap(); return; }
  // 如果正处于淡出中（用户连点），先直接完成这次再进入下一次
  if (wrapEl.classList.contains('is-leaving')) {
    swap();
    return;
  }
  wrapEl.classList.add('is-leaving');
  const onEnd = (e) => {
    if (e.target !== wrapEl || e.propertyName !== 'opacity') return;
    wrapEl.removeEventListener('transitionend', onEnd);
    swap();
    requestAnimationFrame(() => {
      wrapEl.classList.remove('is-leaving');
    });
  };
  wrapEl.addEventListener('transitionend', onEnd);
}

// Chart.js 通用样式
function chartBaseOptions(opts = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: chartAnimation({ duration: 1100 }),
    // 给画布加一圈 padding，防两件事:
    // 1. 数据点贴边被裁切（pointRadius 5 的圆）
    // 2. y 轴最顶 tick label（如 "0.08"）的字符上半部分被画布顶部裁掉
    // top 必须 ≥24，因为 tick label 是渲染在 plot area 外的，不止 pointRadius 的事
    layout: {
      padding: { top: 24, right: 16, bottom: 8, left: 14 },
    },
    interaction: { mode: 'nearest', intersect: false, axis: 'x' },
    plugins: {
      legend: { display: false },
      tooltip: tooltipStyle(),
    },
    scales: {
      x: {
        grid: { color: COLORS.divider, drawBorder: false },
        ticks: {
          color: COLORS.textSec,
          font: { family: "'Nunito', sans-serif", size: 11 },
        },
      },
      y: {
        min: 0,
        max: opts.yMax,
        grid: { color: COLORS.divider, drawBorder: false },
        display: !opts.hideY,
        ticks: {
          color: COLORS.textSec,
          font: { family: "'Nunito', sans-serif", size: 11 },
        },
      },
    },
  };
}

function tooltipStyle(extra = {}) {
  const isDark = document.documentElement.dataset.theme === 'dark';
  return {
    backgroundColor: isDark ? 'rgba(45, 38, 30, 0.95)' : 'rgba(74, 63, 53, 0.92)',
    titleColor: '#FBF8F3',
    bodyColor: '#FBF8F3',
    titleFont: { family: "'Quicksand', sans-serif", size: 12, weight: '600' },
    bodyFont: { family: "'Nunito', sans-serif", size: 12 },
    padding: 10,
    cornerRadius: 8,
    displayColors: false,
    ...extra,
  };
}

/* —— 主题切换 —— */
const THEME_KEY = 'limit-diary-theme';

// 系统当前是否偏好深色
function systemPrefersDark() {
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

// 读取主题模式：'dark' / 'light' / 'system'（跟随系统）
// 没存过、或存的是老的非法值，都按 'system'（跟随系统）处理 —— 老用户默认也跟随系统
function getThemeMode() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light' || saved === 'system') return saved;
  } catch (e) {}
  return 'system';
}

function setThemeMode(mode) {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch (e) {}
}

// 把模式解析成实际生效的主题（'dark' / 'light'）
function loadTheme() {
  const mode = getThemeMode();
  if (mode === 'dark' || mode === 'light') return mode;
  return systemPrefersDark() ? 'dark' : 'light';
}

// 主题切换后，图表颜色跟着 CSS 变量走需要手动重建
function repaintAfterThemeChange() {
  renderRateCard();
  renderRateTrendChart();
  renderWeeklyChart('rebuild');
  renderHistory();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  refreshColors();
  // 更新切换按钮的图标
  const btn = $('#theme-btn');
  if (btn) {
    btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme || 'light';
  const next = current === 'dark' ? 'light' : 'dark';

  // 临时启用平滑过渡（只在切换瞬间，避免影响其他动画）
  document.documentElement.classList.add('theme-transitioning');
  applyTheme(next);
  // 手动点按钮 = 切到手动模式，存固定值（不再跟随系统）
  setThemeMode(next);
  // 如果设置面板开着，把「跟随系统」开关同步关掉
  const sysToggle = $('#theme-system-toggle');
  if (sysToggle) sysToggle.checked = false;

  // 主题切换时所有颜色都变了，必须强制重建图表（仅 update 不会更新颜色）
  repaintAfterThemeChange();

  setTimeout(() => {
    document.documentElement.classList.remove('theme-transitioning');
  }, 350);
}

/* =================================================
   13. 渲染入口 & 初始化
   ================================================= */

function renderAll() {
  renderTopbar();
  renderStatusCards();
  renderInputCard();
  renderRateCard();
  renderRateTrendChart();
  renderWeeklyChart();
  renderHistory();
}

function bindEvents() {
  // 步进按钮
  document.querySelectorAll('.step-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      const step = parseInt(btn.dataset.step, 10);
      handleStep(target, step);
    });
  });

  // 小时步进件 + 历史挑选弹层（5h 窗口 / Weekly）
  bindHourSteppers();
  bindPicker();

  // 键盘 ↑↓ 调整 5h
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('textarea, input')) return;
    if (e.key === 'ArrowUp') {
      handleStep('5h', e.shiftKey ? 5 : 1);
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      handleStep('5h', e.shiftKey ? -5 : -1);
      e.preventDefault();
    } else if (e.key === 'ArrowRight') {
      handleStep('weekly', e.shiftKey ? 5 : 1);
      e.preventDefault();
    } else if (e.key === 'ArrowLeft') {
      handleStep('weekly', e.shiftKey ? -5 : -1);
      e.preventDefault();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      handleSave();
      e.preventDefault();
    }
  });

  // 保存按钮
  $('#save-btn').addEventListener('click', handleSave);

  // 输入卡里的备注框：现在不需要实时保存——它只是"这一笔要写什么"，
  // 等用户点"记一下 ✨"才一起钉到那条记录上（见 handleSave / addRecord）

  // 备注列表展开 / 收起：切换 .is-collapsed class（用 class 而不是 hidden
   // 属性，这样 max-height/opacity 等过渡才能跑起来）。
   // 按钮上的 chevron 是个独立的 span，通过给按钮加 .is-open class 让它旋转 180 度。
   // 动画期间额外加 .is-animating（强制 overflow:hidden），防止展开瞬间
   // 滚动条因为 max-height 还没涨够而闪现一下，动画结束后自动移除。
  $('#notes-expand-btn').addEventListener('click', () => {
    const list = $('#notes-list');
    const btn = $('#notes-expand-btn');
    const count = list.querySelectorAll('.note-item').length;

    // 进入动画状态：强制 overflow:hidden，防滚动条闪现
    list.classList.add('is-animating');

    if (list.classList.contains('is-collapsed')) {
      list.classList.remove('is-collapsed');
      btn.classList.add('is-open');
      btn.innerHTML = `收起<span class="notes-expand-chev">▾</span>`;
    } else {
      list.classList.add('is-collapsed');
      btn.classList.remove('is-open');
      btn.innerHTML = `展开 (${count})<span class="notes-expand-chev">▾</span>`;
    }

    // 等 max-height 这个属性的过渡跑完之后再恢复 overflow:auto，
    // 这样真的需要滚动的时候用户还是能滚。
    // once: true 让监听器只触发一次自动清理，不需要手动 remove。
    const onEnd = (e) => {
      if (e.propertyName !== 'max-height') return;
      list.classList.remove('is-animating');
      list.removeEventListener('transitionend', onEnd);
    };
    list.addEventListener('transitionend', onEnd);
  });

  // 历史导航 —— 翻页时先让旧图淡出再重建，新图淡入 + 动画一起播
  $('#prev-window-btn').addEventListener('click', () => {
    const windows = computeWindows(state.records);
    const idx = windows.findIndex(w => w.id === state.selectedHistoryWindowId);
    if (idx > 0) {
      state.adjustOpen = false;
      crossFadeChart($('.window-chart-wrap'), () => {
        state.selectedHistoryWindowId = windows[idx - 1].id;
        renderHistory();
      });
    }
  });
  $('#next-window-btn').addEventListener('click', () => {
    const windows = computeWindows(state.records);
    const idx = windows.findIndex(w => w.id === state.selectedHistoryWindowId);
    if (idx >= 0 && idx < windows.length - 1) {
      state.adjustOpen = false;
      crossFadeChart($('.window-chart-wrap'), () => {
        state.selectedHistoryWindowId = windows[idx + 1].id;
        renderHistory();
      });
    }
  });

  // 历史窗口"调起点"
  $('#adjust-toggle-btn').addEventListener('click', toggleAdjustPanel);
  $('#adjust-cancel-btn').addEventListener('click', cancelAdjustPanel);
  $('#adjust-confirm-btn').addEventListener('click', confirmAdjustWindow);

  // Weekly 周导航 —— 同上
  $('#prev-week-btn').addEventListener('click', () => {
    crossFadeChart($('.weekly-chart-wrap'), () => {
      const now = Date.now();
      const currentWeekStart = getWeekStart(now, state.settings);
      const viewing = state.selectedWeekStart != null ? state.selectedWeekStart : currentWeekStart;
      // 不是简单减 7 天——而是让 getWeekStart 把 "viewing 前一刻" 规范化到
      // 它实际所属的那一周。这样跨 anchor 往回翻时会自动落到按旧规则切的 weekStart，
      // 不会得到一个"自制的 weekStart"（比如 anchor - 7 天这种不对齐整点的值）。
      state.selectedWeekStart = getWeekStart(viewing - 1, state.settings);
      renderWeeklyChart('rebuild');
    });
  });
  $('#next-week-btn').addEventListener('click', () => {
    crossFadeChart($('.weekly-chart-wrap'), () => {
      const now = Date.now();
      const currentWeekStart = getWeekStart(now, state.settings);
      const viewing = state.selectedWeekStart != null ? state.selectedWeekStart : currentWeekStart;
      // 用 getWeekEnd 当下一段起点：普通周等于 viewing+7d，碰到 weeklyRules 段
      // 交界时它会自动落在下一段的 from。早先用 viewing+7d→getWeekStart 会跳过
      // 中间被截短的那一段（比如 5/2~5/4 → 直接跳到本周，越过 5/4~5/6）。
      const next = getWeekEnd(viewing, state.settings);
      if (next >= currentWeekStart) {
        state.selectedWeekStart = null; // 回到当前周
      } else {
        state.selectedWeekStart = next;
      }
      renderWeeklyChart('rebuild');
    });
  });

  // 汇率趋势图现在常驻显示，不再有展开/折叠按钮，事件绑定也一起删掉

  // 主题切换
  $('#theme-btn').addEventListener('click', toggleTheme);

  // 设置面板
  $('#settings-btn').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', closeSettings);
  $('#settings-modal').addEventListener('click', (e) => {
    if (e.target.id === 'settings-modal') closeSettings();
  });

  // Anthropic 临时重置 weekly
  $('#weekly-anchor-now-btn').addEventListener('click', markWeeklyResetNow);

  // 折叠区里保存周重置时间
  $('#weekly-save-btn').addEventListener('click', saveWeeklySettings);

  // 设置面板里所有折叠按钮：点了就切换父级 .is-open，CSS 里的 grid 过渡接管展开收起
  document.querySelectorAll('[data-fold]').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.parentElement.classList.toggle('is-open');
    });
  });

  // 数据导入导出
  $('#export-btn').addEventListener('click', exportJSON);
  $('#import-btn').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      importJSON(e.target.files[0]);
    }
  });
  $('#clear-btn').addEventListener('click', clearAllData);

  // 云同步
  const syncBtn = $('#sync-btn');
  if (syncBtn) {
    syncBtn.addEventListener('click', () => {
      openSettings();
      setTimeout(() => {
        const el = $('#sync-status-box');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    });
  }
  const syncNowBtn = $('#sync-now-btn');
  if (syncNowBtn) syncNowBtn.addEventListener('click', handleSyncNow);
  const syncInitBtn = $('#sync-init-btn');
  if (syncInitBtn) syncInitBtn.addEventListener('click', handleSyncInit);
  const syncPullBtn = $('#sync-pull-btn');
  if (syncPullBtn) syncPullBtn.addEventListener('click', handleSyncPullBtn);
  const syncPushBtn = $('#sync-push-btn');
  if (syncPushBtn) syncPushBtn.addEventListener('click', handleSyncPushBtn);
  const syncExportBtn = $('#sync-export-btn');
  if (syncExportBtn) syncExportBtn.addEventListener('click', handleSyncExportString);
  const syncImportBtn = $('#sync-import-btn');
  if (syncImportBtn) syncImportBtn.addEventListener('click', handleSyncImportString);
  const syncClearBtn = $('#sync-clear-btn');
  if (syncClearBtn) syncClearBtn.addEventListener('click', handleSyncClear);
  const syncAutoToggle = $('#sync-auto-toggle');
  if (syncAutoToggle) {
    syncAutoToggle.addEventListener('change', (e) => {
      if (!isSyncConfigured()) {
        e.target.checked = true;
        showToast('先配置云同步再用哦');
        return;
      }
      // 正向开关：开 = 自动同步（paused=false）、关 = 不自动同步（paused=true）
      setSyncPaused(!e.target.checked);
      fillSyncInputs();
      showToast(e.target.checked ? '已开启自动同步 ✨' : '已关闭自动同步 ⏸');
    });
  }

  // 跟随系统深浅色开关
  const themeSystemToggle = $('#theme-system-toggle');
  if (themeSystemToggle) {
    themeSystemToggle.addEventListener('change', (e) => {
      document.documentElement.classList.add('theme-transitioning');
      if (e.target.checked) {
        // 切回跟随系统：存 'system'，按系统当前偏好生效
        setThemeMode('system');
        applyTheme(systemPrefersDark() ? 'dark' : 'light');
      } else {
        // 锁定当前正在显示的主题
        const current = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
        setThemeMode(current);
        applyTheme(current);
      }
      repaintAfterThemeChange();
      setTimeout(() => {
        document.documentElement.classList.remove('theme-transitioning');
      }, 350);
      showToast(e.target.checked ? '已跟随系统深浅色 🖥️' : '已锁定当前主题');
    });
  }

  // 手机端：触摸图表外任意区域时，清除所有图表的选中态和 tooltip。
  // 因为 Chart.js 用了 mode:'nearest' + intersect:false，在手机上
  // 手指几乎点哪里都会吸附到最近的点，导致 tooltip 很难消掉。
  // 这里监听 document 级别的 touchstart，如果触摸目标不是任何 canvas，
  // 就主动把所有图表的 tooltip 和高亮清掉。
  document.addEventListener('touchstart', (e) => {
    if (e.target.tagName === 'CANVAS') return;
    [rateChart, weeklyChart, windowChart].forEach(chart => {
      if (!chart) return;
      chart.setActiveElements([]);
      chart.tooltip.setActiveElements([], { x: 0, y: 0 });
      chart.update('none');
    });
  }, { passive: true });
}

// 把 body 切到 .is-ready 状态，触发淡入和首屏入场动画。
// 用 rAF 等浏览器把 Chart.js 第一次绘制都刷到屏幕上之后再触发，
// 这样用户看到的第一帧就是最终样子，没有"占位 → 真值"的抽搐。
let pageRevealed = false;
function revealPage() {
  if (pageRevealed) return;
  pageRevealed = true;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.body.classList.add('is-ready');
      // 页面浮起来之后停顿一下，再放进度条的"按钮"。
      // 之前进度条填充和 body 淡入挤在一起，用户只能看到尾巴；
      // 现在等约 0.7 秒，确保用户先看到空进度条、再悠悠地涨上去。
      setTimeout(() => {
        document.body.classList.add('is-bars-armed');
      }, 700);
    });
  });
}

// 把一个 chart 从"init 时的 animation:false 静态状态"
// 切换到"正常入场动画"并立即播放。
// 1) 从 WeakMap 取出真实动画配置塞回 chart.options.animation
// 2) chart.reset() 把元素回到起点(柱子高 0、线图点在底)
// 3) chart.update() 从起点到数据状态播动画
function triggerChartEnterAnimation(chart) {
  if (!chart) return;
  const enterAnim = chartEnterAnimations.get(chart);
  if (!enterAnim) return;
  chart.options.animation = enterAnim;
  chart.reset();
  chart.update();
}

// 滚动入场：监听标了 .scroll-reveal 的元素，进入视窗时加 .is-revealed
// 触发淡入 + 上浮 + 同步触发该容器内图表的"慢慢长出来"动画。
// 每个元素只触发一次（unobserve 掉）。
function setupScrollReveal() {
  if (!('IntersectionObserver' in window)) {
    // 老浏览器没这个 API：直接全部显示 + 触发所有图表动画
    document.querySelectorAll('.scroll-reveal').forEach((el) => {
      el.classList.add('is-revealed');
    });
    [rateChart, weeklyChart, windowChart].forEach(triggerChartEnterAnimation);
    chartsInInitialState = false;
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-revealed');

        // 找到该容器内的所有 canvas，恢复真实动画并触发播放。
        // 之前 init 时 chart 是用 animation:false 创建的，所以没播过，
        // 这里通过 triggerChartEnterAnimation 恢复真实动画 + reset + update，
        // 让它从起点完整地播一次给用户看。
        entry.target.querySelectorAll('canvas').forEach((canvas) => {
          const chart = Chart.getChart(canvas);
          triggerChartEnterAnimation(chart);
        });

        observer.unobserve(entry.target);

        // 所有 .scroll-reveal 都触发后，关闭 init 标志。
        // 之后保存等触发的 render 调用会走正常的"立即带动画"路径。
        if (
          document.querySelectorAll('.scroll-reveal:not(.is-revealed)').length === 0
        ) {
          chartsInInitialState = false;
        }
      }
    });
  }, {
    // 元素刚冒头就触发；曾经为别的问题拉到 0.35，确认无关后回滚
    threshold: 0.12,
    rootMargin: '-40px',
  });
  document.querySelectorAll('.scroll-reveal').forEach((el) => {
    observer.observe(el);
  });
}

/* =================================================
   14. 小时步进件 + 历史挑选弹层
   ================================================= */

// 把 0–23 的小时数循环增减：23→0、0→23，符合用户对"小时是个圆环"的直觉
// 步进一个数字输入并在 [0, wrap) 内循环。时用 wrap=24，分用 wrap=60（步长 10）
function stepNumberInput(input, delta, wrap) {
  let v = parseInt(input.value, 10);
  if (isNaN(v)) v = 0;
  v = ((v + delta) % wrap + wrap) % wrap;
  input.value = v;
  // 触发 input/change 事件，让任何监听者（含未来加的）能感知到值变了
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function bindHourSteppers() {
  document.addEventListener('click', (e) => {
    // 时步进（±1，循环 0~23）
    const hourBtn = e.target.closest('[data-hour-step]');
    if (hourBtn) {
      const wrap = hourBtn.closest('[data-hour-stepper]');
      const input = wrap && wrap.querySelector('input[type="number"]');
      if (input) stepNumberInput(input, parseInt(hourBtn.dataset.hourStep, 10) || 0, 24);
      return;
    }
    // 分步进（±10，循环 0~50）
    const minBtn = e.target.closest('[data-min-step]');
    if (minBtn) {
      const wrap = minBtn.closest('[data-min-stepper]');
      const input = wrap && wrap.querySelector('input[type="number"]');
      if (input) stepNumberInput(input, parseInt(minBtn.dataset.minStep, 10) || 0, 60);
      return;
    }
    // 给按钮一个轻反馈（复用现有 stepTap 风格的 :active 缩放就够，无需额外 class）
  });
}

// —— 历史挑选弹层 —— 点击 5h 历史标题 / Weekly 周标题，弹出可滚动列表，直接跳到对应项
let pickerLastTrigger = null;

function openPicker(kind) {
  const mask = $('#picker-mask');
  const titleEl = $('#picker-title');
  const list = $('#picker-list');
  if (!mask || !titleEl || !list) return;

  let items = [];
  if (kind === 'window') {
    titleEl.textContent = '挑一个 5h 窗口';
    items = buildWindowPickerItems();
  } else if (kind === 'week') {
    titleEl.textContent = '挑一周';
    items = buildWeekPickerItems();
  } else if (kind === 'resets') {
    titleEl.textContent = '🔄 重置时间线';
  }
  if (kind === 'resets') {
    // 重置时间线是纯展示，不走"可点选列表"那套渲染
    list.innerHTML = buildResetTimelineHtml();
  } else if (items.length === 0) {
    list.innerHTML = `<div class="picker-empty">还没有可挑的～</div>`;
  } else {
    list.innerHTML = items.map((it) => {
      // 日期分隔头：标出这一天的 5h 总用量 + weekly 末值，自然地把每天的窗口分开
      if (it.type === 'header') {
        const wk = it.weekly == null ? '—' : `${it.weekly}%`;
        return `<div class="picker-day">
          <span class="picker-day-date">${it.dateLabel}<em>${it.dayLabel}</em></span>
          <span class="picker-day-stats">
            <span class="picker-day-stat picker-day-stat--5h">5h ${it.total5h}%</span>
            <span class="picker-day-stat picker-day-stat--week">周 ${wk}</span>
          </span>
        </div>`;
      }
      const cls = 'picker-item picker-item--' + kind + (it.isSelected ? ' is-selected' : '') + (it.isCurrent ? ' is-current' : '');
      return `<button type="button" class="${cls}" data-pick="${it.value}">
        <span class="picker-item-main">
          <span class="picker-item-title">${it.title}</span>
          ${it.tag ? `<span class="picker-item-tag">${it.tag}</span>` : ''}
        </span>
        <span class="picker-item-meta">${it.meta || ''}</span>
      </button>`;
    }).join('');
  }

  mask.dataset.pickerKind = kind;
  mask.classList.remove('is-closing');
  mask.hidden = false;

  // 滚动到当前选中项，让用户一打开就看到自己当前在哪
  requestAnimationFrame(() => {
    const sel = list.querySelector('.picker-item.is-selected');
    if (sel) sel.scrollIntoView({ block: 'center' });
  });
}

function closePicker() {
  const mask = $('#picker-mask');
  if (!mask || mask.hidden) return;
  mask.classList.add('is-closing');
  const onEnd = (e) => {
    if (e.target !== mask || e.animationName !== 'fadeOut') return;
    mask.hidden = true;
    mask.classList.remove('is-closing');
    mask.removeEventListener('animationend', onEnd);
    if (pickerLastTrigger) {
      try { pickerLastTrigger.focus({ preventScroll: true }); } catch (_) {}
      pickerLastTrigger = null;
    }
  };
  mask.addEventListener('animationend', onEnd);
}

function buildWindowPickerItems() {
  const windows = computeWindows(state.records);
  const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
  // 倒序：最近的窗口排最上面
  const reversed = windows.slice().reverse();

  // 按"起点日期"把窗口分组，组与组之间插一条日期分隔头
  const groups = [];
  let cur = null;
  for (const w of reversed) {
    const d = new Date(w.startTime);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!cur || cur.key !== key) {
      cur = { key, dateD: d, windows: [] };
      groups.push(cur);
    }
    cur.windows.push(w);
  }

  const allRecs = state.records; // 全局按时间升序
  const items = [];
  for (const g of groups) {
    const d = g.dateD;
    // 这一天的 5h 总用量：各窗口末值之和
    const total5h = g.windows.reduce((s, w) => s + w.lastValue, 0);
    // 这一天的记录拉平排好序——净消耗要按周期分段算，因为当天可能正好跨过周重置
    const dayRecs = g.windows.flatMap((w) => w.records).sort((a, b) => a.timestamp - b.timestamp);
    const firstTs = dayRecs[0].timestamp;
    // 基线 = 同一周内、当天首条记录之前最后一笔的 weekly；跨周或没有则记 0
    let segWeek = getWeekStart(firstTs, state.settings);
    let segBase = 0;
    for (let i = 0; i < allRecs.length; i++) {
      const r = allRecs[i];
      if (r.timestamp >= firstTs) break;
      if (r.timestamp >= segWeek) segBase = r.weekly;
    }
    // 每个周期段贡献"段末值 − 段基线"；跨过周界就结清旧段、新段从 0 重新累计。
    // 以前直接拿"当天末值 − 基线"，重置当天末值是新周期的小值、基线是旧周期的大值，
    // 相减成负被夹成 0——真实消耗整天被吞掉，这里就是 6/8 显示"周 0%"的根源
    let weeklyUsed = 0;
    let segLast = segBase;
    for (const r of dayRecs) {
      const wk = getWeekStart(r.timestamp, state.settings);
      if (wk !== segWeek) {
        weeklyUsed += Math.max(0, segLast - segBase);
        segWeek = wk;
        segBase = 0;
      }
      segLast = r.weekly;
    }
    weeklyUsed += Math.max(0, segLast - segBase);
    items.push({
      type: 'header',
      dateLabel: `${d.getMonth() + 1}/${d.getDate()}`,
      dayLabel: `周${dayNames[d.getDay()]}`,
      total5h,
      weekly: weeklyUsed,
    });
    for (const w of g.windows) {
      const startD = new Date(w.startTime);
      const endD = new Date(w.effectiveEnd);
      const isActive = isWindowAliveAt(w.startTime, Date.now(), state.settings);
      const tag = isActive
        ? '<span class="picker-tag picker-tag--live">进行中</span>'
        : w.wasCut ? '<span class="picker-tag picker-tag--soft">重置截断</span>' : '';
      const meta = `${w.lastValue}% · ${w.records.length} 条`;
      items.push({
        type: 'item',
        value: String(w.id),
        title: `${hm(startD)}–${hm(endD)}`,
        tag,
        meta,
        isSelected: w.id === state.selectedHistoryWindowId,
        isCurrent: isActive,
      });
    }
  }
  return items;
}

function buildWeekPickerItems() {
  const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
  const now = Date.now();
  const currentWeekStart = getWeekStart(now, state.settings);
  const earliest = state.records.length > 0 ? state.records[0].timestamp : currentWeekStart;
  // 从当前周往回收集所有"碰到过"的周——能跨 weeklyRules 段，规则之间被截短的残缺周也都收上
  const weekStarts = [];
  let cursor = currentWeekStart;
  // 安全上限：最多收集 520 周（10 年），防 weeklyRules 异常导致死循环
  for (let i = 0; i < 520; i++) {
    weekStarts.push(cursor);
    if (cursor <= earliest) break;
    const prev = getWeekStart(cursor - 1, state.settings);
    if (prev >= cursor) break; // 兜底防呆
    cursor = prev;
  }
  // weekStarts 已经是新→旧（最新在前）

  // 预先把 weekly 末值算好，避免每周都重扫一遍
  const records = state.records;
  return weekStarts.map((ws) => {
    const we = getWeekEnd(ws, state.settings);
    const isCurrent = ws === currentWeekStart;
    const wsD = new Date(ws);
    const weD = new Date(we - 1);
    const sameMonth = wsD.getMonth() === weD.getMonth();
    const range = sameMonth
      ? `${wsD.getMonth() + 1}/${wsD.getDate()}–${weD.getDate()}`
      : `${wsD.getMonth() + 1}/${wsD.getDate()}–${weD.getMonth() + 1}/${weD.getDate()}`;
    const title = isCurrent ? '本周' : range;
    const tag = isCurrent ? '<span class="picker-tag picker-tag--live">本周</span>' : `<span class="picker-tag picker-tag--soft">周${dayNames[wsD.getDay()]}起</span>`;
    // 这周末值：取在 [ws, we) 区间的最后一笔记录的 weekly
    let last = null;
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (r.timestamp < ws) break;
      if (r.timestamp >= ws && r.timestamp < we) { last = r; break; }
    }
    const meta = last ? `${last.weekly}% · ${countRecordsInRange(records, ws, we)} 条` : '没记录';
    return {
      value: isCurrent ? '__current__' : String(ws),
      title,
      tag,
      meta,
      isSelected: isCurrent
        ? state.selectedWeekStart == null
        : state.selectedWeekStart === ws,
      isCurrent,
    };
  });
}

function countRecordsInRange(records, fromTs, toTs) {
  let c = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.timestamp < fromTs) break;
    if (r.timestamp >= fromTs && r.timestamp < toTs) c++;
  }
  return c;
}

/* —— 重置时间线 ——
   Weekly 节奏卡里的「重置记录」入口打开。把每一次周期边界铺成一条按时间倒序的时间线：
   - 每周重置：按规则推算出来的正常周期边界
   - 官方临时重置：用户按「立即重置」留下的真实记录（hardResets）
   - 改了重置时间：用户在设置里手动调过规则的节点
   每条带"距上次隔多久"和"重置前 weekly 用到多少"，方便观察重置周期的规律——
   特别是官方临时重置的频率，和被刷之前用量到了什么水平。 */

// 收集所有已经发生过的重置事件（按时间倒序），并补上间隔和重置前用量
function collectResetEvents() {
  const records = state.records;
  const settings = state.settings;
  if (records.length === 0) return [];
  const now = Date.now();
  const currentWeekStart = getWeekStart(now, settings);
  const earliest = records[0].timestamp;

  // 从本周起点往回铺周边界，铺到第一笔记录所在的那一周为止。
  // 和 buildWeekPickerItems 同款走法：跨规则段时自动落在被截短的残缺周边界上。
  const starts = [];
  let cursor = currentWeekStart;
  for (let i = 0; i < 520; i++) {
    starts.push(cursor);
    if (cursor <= earliest) break;
    const prev = getWeekStart(cursor - 1, settings);
    if (prev >= cursor) break; // 兜底防呆
    cursor = prev;
  }

  const hardSet = new Set(Array.isArray(settings.hardResets) ? settings.hardResets : []);
  // 给规则链上每个 from > 0 的节点定性。有 kind 标记的直接认：
  //   'realign' = 立即重置后的自动归位 → 本质是正常每周重置
  //   'manual'  = 用户亲手改的日程 → 改了重置时间
  // 没标记的是老版本攒下来的节点——当年「立即重置」和「改重置时间」留下的痕迹一模一样，
  // 只能启发式猜：和前一段日程相同、或和现在的日程相同（用户改时间基本都是把被
  // 旧版立即重置带歪的日程掰回真实重置时刻，那一刻本来就是正常每周重置）→ 每周重置；
  // 落在奇怪时刻的 → 多半是当年按「立即重置」记下的官方临时重置。
  const rules = Array.isArray(settings.weeklyRules) ? settings.weeklyRules : [];
  const curDay = settings.weeklyResetDay;
  const curHour = settings.weeklyResetHour;
  const ruleTypeByFrom = new Map();
  for (let i = 1; i < rules.length; i++) {
    const r = rules[i];
    const prev = rules[i - 1];
    let t;
    if (r.kind === 'realign') t = 'week';
    else if (r.kind === 'manual') t = 'rule';
    else if (r.day === prev.day && r.hour === prev.hour) t = 'week';
    else if (r.day === curDay && r.hour === curHour) t = 'week';
    else t = 'hard';
    ruleTypeByFrom.set(r.from, t);
  }

  const events = starts.map((ts) => {
    let type;
    if (hardSet.has(ts)) {
      type = 'hard'; // 真实记录优先：v2.66 起立即重置会留闸门，比启发式可靠
    } else {
      type = ruleTypeByFrom.get(ts) || 'week';
    }
    return { ts, type };
  });
  // 理论上每道硬重置闸门都对应一个周边界，防御性兜底：万一漏了就补进来
  for (const h of hardSet) {
    if (h <= now && h >= earliest && !events.some((e) => e.ts === h)) {
      events.push({ ts: h, type: 'hard' });
    }
  }
  events.sort((a, b) => b.ts - a.ts);

  // 补上"距上次重置隔了多久"和"重置前 weekly 用到多少"
  for (let i = 0; i < events.length; i++) {
    const cur = events[i];
    const prev = events[i + 1]; // 时间上更早的那一次
    cur.gapMs = prev ? cur.ts - prev.ts : null;
    // 重置前的用量：上一次重置之后、这一次重置之前的最后一笔记录
    const lowerBound = prev ? prev.ts : -Infinity;
    let before = null;
    for (let j = records.length - 1; j >= 0; j--) {
      const r = records[j];
      if (r.timestamp < lowerBound) break;
      if (r.timestamp < cur.ts) { before = r; break; }
    }
    cur.weeklyBefore = before ? before.weekly : null;
  }
  return events;
}

// 把重置间隔格式化成"X 天 / X 天 Y 小时 / X 小时"
function formatGapDuration(ms) {
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const totalH = Math.round(ms / ONE_HOUR_MS);
  if (totalH < 24) return `${Math.max(1, totalH)} 小时`;
  const d = Math.floor(totalH / 24);
  const h = totalH % 24;
  return h > 0 ? `${d} 天 ${h} 小时` : `${d} 天`;
}

function buildResetTimelineHtml() {
  const events = collectResetEvents();
  if (events.length === 0) {
    return '<div class="picker-empty">还没有记录～记几笔之后再来看吧 ✨</div>';
  }
  const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
  const fmtTs = (ts) => {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} 周${dayNames[d.getDay()]} ${hm(d)}`;
  };
  const TYPE_META = {
    next: { label: '下次重置', icon: '🔮' },
    week: { label: '每周重置', icon: '📅' },
    hard: { label: '官方临时重置', icon: '⚡' },
    rule: { label: '改了重置时间', icon: '✏️' },
  };

  // 最上面放一条"下次重置"的预告，下面接所有已发生的重置
  const now = Date.now();
  const nextTs = getWeekEnd(getWeekStart(now, state.settings), state.settings);
  const rows = [{ ts: nextTs, type: 'next', gapMs: null, weeklyBefore: null }, ...events];

  return '<div class="reset-tl">' + rows.map((e) => {
    const t = TYPE_META[e.type];
    const metaParts = [];
    if (e.type === 'next') {
      metaParts.push(formatRemainingUntilReset(Math.max(0, nextTs - now)));
    } else {
      metaParts.push(e.gapMs != null ? `距上次 ${formatGapDuration(e.gapMs)}` : '记录从这之后开始');
      if (e.weeklyBefore != null) metaParts.push(`重置前用到 ${e.weeklyBefore}%`);
    }
    return `<div class="reset-tl-item is-${e.type}">
      <span class="reset-tl-rail"><span class="reset-tl-dot"></span></span>
      <span class="reset-tl-body">
        <span class="reset-tl-line1">
          <span class="reset-tl-time">${fmtTs(e.ts)}</span>
          <span class="reset-tl-tag">${t.icon} ${t.label}</span>
        </span>
        <span class="reset-tl-meta">${metaParts.join(' · ')}</span>
      </span>
    </div>`;
  }).join('') + '</div>';
}

function pickWindowFromList(idStr) {
  const id = parseInt(idStr, 10);
  const windows = computeWindows(state.records);
  if (!windows.find((w) => w.id === id)) return;
  if (id === state.selectedHistoryWindowId) return;
  state.adjustOpen = false;
  crossFadeChart($('.window-chart-wrap'), () => {
    state.selectedHistoryWindowId = id;
    renderHistory();
  });
}

function pickWeekFromList(value) {
  const now = Date.now();
  const currentWeekStart = getWeekStart(now, state.settings);
  const target = value === '__current__' ? null : parseInt(value, 10);
  // 已经选中的就别白翻一次图
  const sameAsCurrent = target == null && state.selectedWeekStart == null;
  const sameAsOther = target != null && state.selectedWeekStart === target;
  if (sameAsCurrent || sameAsOther) return;
  crossFadeChart($('.weekly-chart-wrap'), () => {
    state.selectedWeekStart = target == null || target === currentWeekStart ? null : target;
    renderWeeklyChart('rebuild');
  });
}

function bindPicker() {
  // 点标题打开
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-picker]');
    if (trigger) {
      pickerLastTrigger = trigger;
      openPicker(trigger.dataset.picker);
      return;
    }
    // 列表项
    const item = e.target.closest('[data-pick]');
    if (item && $('#picker-mask').contains(item)) {
      const kind = $('#picker-mask').dataset.pickerKind;
      const v = item.dataset.pick;
      closePicker();
      if (kind === 'window') pickWindowFromList(v);
      else if (kind === 'week') pickWeekFromList(v);
      return;
    }
  });

  // 关闭按钮 + 点遮罩
  const closeBtn = $('#picker-close');
  if (closeBtn) closeBtn.addEventListener('click', closePicker);
  const mask = $('#picker-mask');
  if (mask) mask.addEventListener('click', (e) => {
    if (e.target === mask) closePicker();
  });

  // ESC 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#picker-mask').hidden) closePicker();
  });
}

// 兜底：万一 init 出错或 Chart.js 卡住，最迟 2 秒后强制显示页面，
// 避免用户卡在透明的空白屏上。
setTimeout(revealPage, 2000);

function init() {
  // 加载数据
  const data = loadData();
  if (data) {
    state.records = data.records || [];
    state.notes = data.notes || {};
    state.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  }
  // 老数据可能没有 weeklyRules（旧格式 weekAnchor + preAnchor*），统一迁一遍。
  // 全新安装也走一次，让 weeklyRules 数组从 DEFAULT_SETTINGS 共享引用变成自家的副本。
  migrateSettings(state.settings);

  // 旧数据兼容：把窗口级备注迁到记录上
  migrateNotesToRecords();

  // 加载云同步配置（不触发网络，只是把 key/binId 读进 syncState）
  syncState.config = loadSyncConfig();
  updateSyncButton();

  // 主题已经被 head 里的内联脚本提前应用了（防 FOUC），
  // 这里只需要 refreshColors 和更新按钮图标
  applyTheme(loadTheme());

  resetDraft();
  bindEvents();
  renderAll();
  setupScrollReveal();

  // 云同步：如果已配置且未被暂停，在页面渲染完后台静默拉取一次，
  // 有新数据就合并并重绘。失败不阻塞本地使用。
  // 本地节流：距上次同步不到 SYNC_THROTTLE_MS 就跳过这次自动拉取，直接用本地缓存。
  // 想强制拉最新可以点顶栏的☁️或设置里的「同步」按钮（不走节流）。
  if (isSyncConfigured() && !isSyncPaused() && !isSyncThrottled()) {
    setTimeout(() => {
      syncPull(true)
        .then(() => {
          renderAll();
        })
        .catch(() => {
          // 错误状态已经在 setSyncStatus 里了，用户打开设置面板就能看到
        });
    }, 500);
  }

  // 防抽抽：等所有 DOM/数字/图表都画完了，再触发页面淡入。
  // 用两次 rAF 是为了让浏览器至少把 Chart.js 第一次绘制的内容刷到屏幕上，
  // 这样淡入开始时用户看到的就已经是最终样子，不会有"占位 → 真值"的切换。
  revealPage();

  // 每分钟更新一次倒计时 + 状态卡 + 输入卡（如果输入卡的草稿状态过时了的话）
  setInterval(() => {
    renderTopbar();
    renderStatusCards();
    maybeRefreshDraft();
  }, 60 * 1000);

  // 从后台切回前台（比如用户把 PWA 切到后台刷别的，再切回来）时立刻同步一次，
  // 避免等最多 60 秒才赶上时间推进。document.visibilityState === 'visible'
  // 意味着用户正在看这个页面，这时候做一次"赶上进度"的更新是合理的。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      renderTopbar();
      renderStatusCards();
      maybeRefreshDraft();
    }
  });

  // 监听系统主题变化（仅当处于「跟随系统」模式时才实时跟随）
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener && mq.addEventListener('change', (e) => {
      try {
        if (getThemeMode() === 'system') {
          applyTheme(e.matches ? 'dark' : 'light');
          repaintAfterThemeChange();
        }
      } catch (err) {}
    });
  }
}

// 等 DOM 准备好就跑
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
