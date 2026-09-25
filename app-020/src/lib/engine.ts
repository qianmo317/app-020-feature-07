import type {
  ExitLoad,
  Floor,
  Pt,
  Room,
  RuleSet,
  ValidationItem,
  ValidationResult,
  FacilityKind,
} from '../model';
import {
  MM_PER_M,
  dist,
  gridPointsInPoly,
  pointInPoly,
  polyAreaM2,
  doorCandidates,
  bboxOf,
} from './geometry';
import { buildCorridorGraph, type DoorInput } from './graph';
import {
  CHECK_INTERVAL_DAYS,
  OCCUPANCY_DENSITY_M2_PER_PERSON,
  egressWidthPer100M,
} from '../rules/defaults';

const TRAVEL_STEP_MM = 250; // 走道栅格 0.25m，保证与手工沿路径测量误差 < 0.5m
const ROOM_STEP_MM = 500; // 房间内部采样 0.5m
const COVERAGE_STEP_MM = 500; // 覆盖判定栅格 0.5m

export type CoverageResult = {
  uncoveredM2: number;
  totalM2: number;
  pass: boolean;
  samples: Pt[]; // 未覆盖代表点（mm），最多 50 个
  cells: Pt[]; // 全部未覆盖栅格点（用于画布高亮），仅按需计算
};

/**
 * 灭火器保护半径覆盖：0.5m 栅格采样近似面积差集。
 * 未覆盖面积 > max(2㎡, 楼层面积 5%) 判不合规。
 */
export function computeCoverage(
  rooms: Room[],
  extinguisherPts: Pt[],
  radiusM: number,
  withCells = false,
): CoverageResult {
  const cells: Pt[] = [];
  const samples: Pt[] = [];
  if (!rooms.length) {
    return { uncoveredM2: 0, totalM2: 0, pass: true, samples, cells };
  }
  const bb = bboxOf(rooms.map((r) => r.polygon));
  const step = COVERAGE_STEP_MM;
  const radius = radiusM * MM_PER_M;
  const bucket = Math.max(radius, 5000);
  const hash = new Map<string, Pt[]>();
  for (const p of extinguisherPts) {
    const key = `${Math.floor(p.x / bucket)},${Math.floor(p.y / bucket)}`;
    const list = hash.get(key);
    if (list) list.push(p);
    else hash.set(key, [p]);
  }
  const coveredAt = (x: number, y: number): boolean => {
    const bi = Math.floor(x / bucket);
    const bj = Math.floor(y / bucket);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const list = hash.get(`${bi + di},${bj + dj}`);
        if (!list) continue;
        for (const p of list) {
          if (Math.hypot(p.x - x, p.y - y) <= radius) return true;
        }
      }
    }
    return false;
  };

  // 格心采样：每个 0.5m 格子用其中心点判定，格心必在多边形内部（射线法排除边界点的问题
  // 不会出现），总面积 = 格数 × 0.25㎡ 与手工核算一致，未覆盖面积误差 ≤ 每格半格 ≈ 10% 内
  const x0 = Math.floor(bb.minX / step) * step + step / 2;
  const y0 = Math.floor(bb.minY / step) * step + step / 2;
  const nx = Math.max(1, Math.ceil((bb.maxX - bb.minX) / step));
  const ny = Math.max(1, Math.ceil((bb.maxY - bb.minY) / step));
  // inside 标记：逐房间按 bbox 预filter 标记，避免每点遍历全部多边形（200 房间时的性能关键）
  const inside = new Uint8Array(nx * ny);
  for (const r of rooms) {
    const pbb = bboxOf([r.polygon]);
    const i0 = Math.max(0, Math.floor((pbb.minX - x0) / step));
    const i1 = Math.min(nx - 1, Math.ceil((pbb.maxX - x0) / step));
    const j0 = Math.max(0, Math.floor((pbb.minY - y0) / step));
    const j1 = Math.min(ny - 1, Math.ceil((pbb.maxY - y0) / step));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (!inside[j * nx + i] && pointInPoly({ x: x0 + i * step, y: y0 + j * step }, r.polygon)) {
          inside[j * nx + i] = 1;
        }
      }
    }
  }
  let uncovered = 0;
  let total = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!inside[j * nx + i]) continue;
      total++;
      const x = x0 + i * step;
      const y = y0 + j * step;
      if (!coveredAt(x, y)) {
        uncovered++;
        const p = { x, y };
        cells.push(p);
        if (samples.length < 50) samples.push(p);
      }
    }
  }
  const cellAreaM2 = (step / MM_PER_M) ** 2;
  const uncoveredM2 = uncovered * cellAreaM2;
  const totalM2 = total * cellAreaM2;
  const threshold = Math.max(2, totalM2 * 0.05);
  return { uncoveredM2, totalM2, pass: uncoveredM2 <= threshold, samples, cells: withCells ? cells : [] };
}

function roomWorstTravelM(room: Room, doors: Pt[], doorPathMm: number[], exitsInRoom: Pt[]): { worstM: number; point: Pt } | null {
  // 采样点 = 栅格点 + 顶点（顶点保证非凸房间的最远角被精确测到）
  const pts = [...gridPointsInPoly(room.polygon, ROOM_STEP_MM), ...room.polygon];
  if (!pts.length) return null;
  let worst = -1;
  let worstPt: Pt = pts[0];
  for (const p of pts) {
    let d = Infinity;
    if (exitsInRoom.length) {
      for (const e of exitsInRoom) d = Math.min(d, dist(p, e));
    } else {
      for (let i = 0; i < doors.length; i++) {
        const di = dist(p, doors[i]) + doorPathMm[i]; // 全程毫米
        if (di < d) d = di;
      }
    }
    if (d > worst) {
      worst = d;
      worstPt = p;
    }
  }
  return { worstM: worst / MM_PER_M, point: worstPt };
}

/**
 * 房间人数：实填优先（occupants >= 0）；留空时按用途密度估算
 * （办公 10 / 商业 3 / 仓库 50 / 病房 8 / 走道 0 / 其他 20 ㎡/人）。
 */
export function estimateOccupants(room: Room): number {
  if (room.occupants != null && room.occupants >= 0) return Math.round(room.occupants);
  return estimateOccupantsByArea(room);
}

/** 强制按用途密度估算（房间属性面板显示「留空将按 X 人计算」用） */
export function estimateOccupantsByArea(room: Room): number {
  const density = OCCUPANCY_DENSITY_M2_PER_PERSON[room.usage] ?? 20;
  if (density <= 0) return 0;
  return Math.max(0, Math.round(room.areaM2 / density));
}

/** 房间人数是否为实填 */
export function occupantsExplicit(room: Room): boolean {
  return room.occupants != null && room.occupants >= 0;
}

function roomCenter(room: Room): Pt {
  return {
    x: room.polygon.reduce((s, p) => s + p.x, 0) / room.polygon.length,
    y: room.polygon.reduce((s, p) => s + p.y, 0) / room.polygon.length,
  };
}

/** 出口净宽度（m）：设施单独填写优先，否则取规则最小宽度 */
export function exitWidthM(
  fac: { spec?: { widthM?: number } },
  rules: RuleSet,
): number {
  const w = fac.spec?.widthM;
  return w != null && w > 0 ? w : rules.exitMinWidthM;
}

const days = (n: number) => n * 24 * 3600 * 1000;

/** 设施检查记录是否过期（无记录 / 最近一次检查超过周期 / 状态为损坏或缺失） */
export function checkDueInfo(facility: { kind: FacilityKind; checks: { date: string; status: string }[] }, now: number): { overdue: boolean; defect: boolean; missing: boolean; dueDate: string | null } {
  const interval = CHECK_INTERVAL_DAYS[facility.kind] ?? 90;
  const sorted = [...facility.checks].sort((a, b) => b.date.localeCompare(a.date));
  if (!sorted.length) return { overdue: false, defect: false, missing: true, dueDate: null };
  const last = sorted[0];
  const dueTs = new Date(`${last.date}T00:00:00`).getTime() + days(interval);
  const d = new Date(dueTs);
  const p2 = (v: number) => String(v).padStart(2, '0');
  const defect = last.status === 'damaged' || last.status === 'missing';
  return {
    overdue: now > dueTs,
    defect,
    missing: false,
    // 按本地时区取日期（toISOString 会因 UTC 偏移提前一天切日）
    dueDate: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`,
  };
}

/**
 * 楼层合规校验（核心）：
 * 1) 疏散距离沿走道路径计算（走道栅格图 + Dijkstra），房间内为「最远点 → 房间门」直线段；
 * 2) 灭火器保护半径栅格采样覆盖判定；
 * 3) 安全出口数量 vs 面积/人数、出口与走道连通性；
 * 4) 人数按最近出口分配到各安全出口，逐口校核净宽度容量（m/百人），超载出口单独标错；
 * 5) 楼层所需疏散总净宽度 vs 全部出口净宽度之和；
 * 6) 袋形走道（死端）长度；
 * 7) 检查记录过期/缺失。
 * 人数取房间实填 occupants，留空按用途密度估算；结果中记录当时使用的规则版本与依据文号（打印报告可见）。
 */
export function validateFloor(floor: Floor, rules: RuleSet, now: number = Date.now()): ValidationResult {
  const items: ValidationItem[] = [];
  const corridorRooms = floor.rooms.filter((r) => r.usage === 'corridor');
  const openPlan = corridorRooms.length === 0;
  const walkPolys = openPlan ? floor.rooms.map((r) => r.polygon) : corridorRooms.map((r) => r.polygon);
  const nonWalkRooms = openPlan ? [] : floor.rooms.filter((r) => r.usage !== 'corridor');
  const exits = floor.facilities.filter((f) => f.kind === 'exit');
  const exitPts = exits.map((f) => ({ x: f.x, y: f.y }));

  // 房间中心预计算（人数分配与房内直线段共用，200 房间时避免在循环里反复 reduce）
  const centerByRoom = new Map<string, Pt>();
  for (const r of floor.rooms) centerByRoom.set(r.id, roomCenter(r));

  let travelWorstM: number | null = null;
  let worstPoint: Pt | null = null;
  let deadEndM: number | null = null;
  // exit 设施下标（exits 数组）→ 分配人数（按最近出口）
  const assignedByExit = new Map<number, number>();

  if (walkPolys.length && exitPts.length) {
    // 房间门推断
    const doorPtsByRoom = new Map<string, Pt[]>();
    const doorInputs: DoorInput[] = [];
    for (const r of nonWalkRooms) {
      const ds = doorCandidates(r.polygon, walkPolys);
      if (ds.length) {
        doorPtsByRoom.set(r.id, ds);
        for (const pt of ds) doorInputs.push({ roomId: r.id, pt });
      }
    }
    const g = buildCorridorGraph(walkPolys, exitPts, doorInputs, TRAVEL_STEP_MM);

    // 可承载人数的出口（已连接），行序对应 g.exitConnectedIdx
    const usableRows = g.exitConnectedIdx
      .map((exitIdx, row) => ({ exitIdx, row }))
      .filter(({ exitIdx }) => g.exitConnected[exitIdx]);

    // 把一个房间的人数分配给最近出口：distanceMm(row) 给出到第 row 个可用出口的路径距离（mm）
    const assignRoom = (r: Room, distanceMm: (row: number) => number) => {
      const n = estimateOccupants(r);
      if (n <= 0 || usableRows.length === 0) return;
      let bestK = 0;
      let bestD = Infinity;
      usableRows.forEach(({ row }, k) => {
        const d = distanceMm(row);
        if (d < bestD) {
          bestD = d;
          bestK = k;
        }
      });
      if (!Number.isFinite(bestD)) return; // 无可达出口（EXIT_NOT_CONNECTED 已另行提示）
      const exitIdx = usableRows[bestK].exitIdx;
      assignedByExit.set(exitIdx, (assignedByExit.get(exitIdx) ?? 0) + n);
    };

    exits.forEach((f, i) => {
      if (!g.exitConnected[i]) {
        items.push({
          severity: 'error',
          type: 'EXIT_NOT_CONNECTED',
          facilityId: f.id,
          point: { x: f.x, y: f.y },
          message: `安全出口 ${f.code} 未连接到${openPlan ? '房间区域' : '走道'}（周边 2.5m 内无可行走行区域）`,
        });
      }
    });

    // 走道网络整体最差点
    let maxD = -1;
    let maxIdx = -1;
    for (let u = 0; u < g.nLattice; u++) {
      if (g.dist[u] !== Infinity && g.dist[u] > maxD) {
        maxD = g.dist[u];
        maxIdx = u;
      }
    }
    if (maxIdx >= 0) {
      travelWorstM = maxD / MM_PER_M;
      worstPoint = { x: g.pts[maxIdx * 2], y: g.pts[maxIdx * 2 + 1] };
    }
    if (!openPlan) {
      deadEndM = g.deadEndMax / MM_PER_M;
      if (deadEndM > rules.deadEndDistanceM + 0.001) {
        items.push({
          severity: 'error',
          type: 'DEADEND_EXCEED',
          value: deadEndM,
          limit: rules.deadEndDistanceM,
          message: `袋形走道（死端）最大长度 ${deadEndM.toFixed(1)}m 超过限值 ${rules.deadEndDistanceM}m`,
        });
      }
    }

    // 各房间疏散距离
    for (const r of floor.rooms) {
      if (r.usage === 'corridor') continue;
      const exitsInRoom = exitPts.filter((p) => pointInPoly(p, r.polygon));
      const doors = doorPtsByRoom.get(r.id) ?? [];
      if (!exitsInRoom.length && !doors.length) {
        items.push({
          severity: 'warning',
          type: 'NO_DOOR',
          roomId: r.id,
          message: `房间「${r.name}」未找到通向${openPlan ? '其他区域' : '走道'}的门（房间需与走道共边）`,
        });
        continue;
      }
      // 门对应的路径距离（毫米，与房内直线段同单位相加）
      const doorIdx = doors.map((d) => doorInputs.findIndex((di) => di.pt.x === d.x && di.pt.y === d.y));
      const doorPathMm: number[] = doorIdx.map((idx) =>
        idx >= 0 && g.doorDist[idx] !== Infinity ? g.doorDist[idx] : Infinity,
      );
      const res = roomWorstTravelM(r, doors, doorPathMm, exitsInRoom);
      if (res && res.worstM > rules.maxTravelDistanceM + 0.001) {
        items.push({
          severity: 'error',
          type: 'TRAVEL_EXCEED',
          roomId: r.id,
          point: res.point,
          value: res.worstM,
          limit: rules.maxTravelDistanceM,
          message: `房间「${r.name}」疏散距离 ${res.worstM.toFixed(1)}m 超过限值 ${rules.maxTravelDistanceM}m（沿路径计算）`,
        });
      }
      // 人数按最近出口分配（与疏散距离同路径：房内中心→门直线段 + 门→出口走道路径）
      const center = centerByRoom.get(r.id)!;
      if (exitsInRoom.length) {
        // 房内出口（travel 上视为距离 0 的门）：房间中心到出口的直线距离
        const insideExitIdx: number[] = [];
        for (let e = 0; e < exitPts.length; e++) {
          const p = exitPts[e];
          for (const q of exitsInRoom) if (q.x === p.x && q.y === p.y) { insideExitIdx.push(e); break; }
        }
        assignRoom(r, (row) => {
          const exitIdx = g.exitConnectedIdx[row];
          // 已连接出口里找房内出口（通常至多 1~2 个，直接线性扫描）
          for (const e of insideExitIdx) if (e === exitIdx) return dist(center, exitPts[e]);
          return Infinity;
        });
      } else if (openPlan) {
        // 开敞大空间无墙体模型：房中心到各出口按直线近似（与房内疏散距离同口径）
        assignRoom(r, (row) => dist(center, exitPts[g.exitConnectedIdx[row]]));
      } else if (doors.length) {
        assignRoom(r, (row) => {
          let best = Infinity;
          const rowDist = g.perExitDoorDist[row];
          for (let k = 0; k < doorIdx.length; k++) {
            const idx = doorIdx[k];
            if (idx < 0) continue;
            const viaDoor = dist(center, doors[k]) + rowDist[idx];
            if (viaDoor < best) best = viaDoor;
          }
          return best;
        });
      }
    }

    // 走道房间各自的最差点（用于定位提示）
    if (!openPlan) {
      for (const r of corridorRooms) {
        const pts = gridPointsInPoly(r.polygon, TRAVEL_STEP_MM);
        let worst = -1;
        let wp: Pt | null = null;
        for (const p of pts) {
          const u = g.nodeAtLattice(p.x, p.y);
          if (u >= 0 && g.dist[u] !== Infinity && g.dist[u] > worst) {
            worst = g.dist[u];
            wp = p;
          }
        }
        if (wp && worst / MM_PER_M > rules.maxTravelDistanceM + 0.001) {
          items.push({
            severity: 'error',
            type: 'TRAVEL_EXCEED',
            roomId: r.id,
            point: wp,
            value: worst / MM_PER_M,
            limit: rules.maxTravelDistanceM,
            message: `走道「${r.name}」最远点疏散距离 ${(worst / MM_PER_M).toFixed(1)}m 超过限值 ${rules.maxTravelDistanceM}m`,
          });
        }
        // 走道估算人数为 0；仅在用户显式填写时参与出口分配（按走道中心最近出口）
        if (occupantsExplicit(r)) {
          const center = centerByRoom.get(r.id)!;
          const u = g.nodeAtLattice(center.x, center.y);
          if (u >= 0) assignRoom(r, (row) => g.perExitDist[row][u]);
        }
      }
    }
  } else if (walkPolys.length && !exitPts.length) {
    items.push({ severity: 'error', type: 'EXIT_COUNT', message: '未布置任何安全出口' });
  }

  // 灭火器覆盖
  const extPts = floor.facilities.filter((f) => f.kind === 'extinguisher').map((f) => ({ x: f.x, y: f.y }));
  const coverage = floor.rooms.length
    ? computeCoverage(floor.rooms, extPts, rules.extinguisherRadiusM)
    : null;
  if (coverage && !coverage.pass) {
    items.push({
      severity: 'warning',
      type: 'COVERAGE_UNCOVERED',
      value: coverage.uncoveredM2,
      point: coverage.samples[0],
      message: `灭火器保护半径（${rules.extinguisherRadiusM}m）未覆盖面积 ${coverage.uncoveredM2.toFixed(1)}㎡，超过阈值 max(2㎡, 5%)`,
    });
  }

  // 安全出口数量 vs 面积/人数
  const areaM2 = floor.rooms.reduce((s, r) => s + polyAreaM2(r.polygon), 0);
  let occupants = 0;
  let estimated = 0;
  for (const r of floor.rooms) {
    if (occupantsExplicit(r)) {
      occupants += estimateOccupants(r);
    } else {
      const n = estimateOccupantsByArea(r);
      occupants += n;
      estimated += n;
    }
  }
  const required = areaM2 > rules.exitMinAreaM2 || occupants > rules.exitMaxOccupants ? 2 : 1;
  if (exitPts.length && exits.length < required) {
    items.push({
      severity: 'error',
      type: 'EXIT_COUNT',
      value: exits.length,
      limit: required,
      message: `安全出口 ${exits.length} 个，少于要求数量（面积 ${areaM2.toFixed(0)}㎡ / ${estimated ? `人数 ${occupants}（其中约 ${estimated} 为估算）` : `人数 ${occupants}`} → 需 ≥ ${required} 个）`,
    });
  }

  // 疏散宽度：百人宽度指标按楼层取 GB 50016 表 5.5.21-1，且不窄于规则配置值
  const widthPer100M = egressWidthPer100M(floor.level, rules.exitWidthPer100M);
  const requiredWidthM = occupants > 0 ? Math.ceil((occupants * widthPer100M) / 100 * 100) / 100 : 0;
  const exitWidths = exits.map((f) => exitWidthM(f, rules));
  const availableWidthM = Math.round(exitWidths.reduce((s, w) => s + w, 0) * 100) / 100;

  // 各出口按净宽度可通过人数：width ÷ 百人宽度指标 ×100
  const exitLoads: ExitLoad[] = exits.map((f, i) => {
    const w = exitWidths[i];
    const assigned = assignedByExit.get(i) ?? 0;
    const capacity = Math.floor((w / widthPer100M) * 100 + 1e-9);
    return {
      facilityId: f.id,
      code: f.code,
      point: { x: f.x, y: f.y },
      widthM: w,
      capacity,
      assigned,
      overflow: Math.max(0, assigned - capacity),
    };
  });

  // 单个出口净宽度低于规范最小值
  exitLoads.forEach((load, i) => {
    if (exitWidths[i] < rules.exitMinWidthM - 1e-9) {
      items.push({
        severity: 'error',
        type: 'EXIT_WIDTH_NARROW',
        facilityId: load.facilityId,
        point: load.point,
        value: exitWidths[i],
        limit: rules.exitMinWidthM,
        message: `安全出口 ${load.code} 净宽度 ${exitWidths[i].toFixed(2)}m，小于最小净宽度 ${rules.exitMinWidthM}m（GB 50016 5.5.19）`,
      });
    }
  });

  // 哪个出口会挤：最近出口分配人数超过其宽度容量
  for (const load of exitLoads) {
    if (load.overflow > 0) {
      items.push({
        severity: 'error',
        type: 'EXIT_CAPACITY',
        facilityId: load.facilityId,
        point: load.point,
        value: load.assigned,
        limit: load.capacity,
        message: `安全出口 ${load.code} 分流 ${load.assigned} 人，按 ${load.widthM.toFixed(2)}m 净宽度仅可通过 ${load.capacity} 人（${widthPer100M.toFixed(2)}m/百人），超出 ${load.overflow} 人`,
      });
    }
  }

  // 总净宽度不足：若已有具体出口超载（error），此条降为 warning 作为补充汇总，避免双 error 同因重复
  if (occupants > 0 && availableWidthM + 1e-9 < requiredWidthM) {
    const alreadyPerExit = items.some(
      (it) => it.type === 'EXIT_CAPACITY' && it.facilityId != null,
    );
    items.push({
      severity: alreadyPerExit ? 'warning' : 'error',
      type: 'EXIT_WIDTH',
      value: availableWidthM,
      limit: requiredWidthM,
      message: `疏散出口总净宽度 ${availableWidthM.toFixed(2)}m，小于 ${occupants} 人所需 ${requiredWidthM.toFixed(2)}m（按 ${widthPer100M.toFixed(2)}m/百人，缺口 ${(requiredWidthM - availableWidthM).toFixed(2)}m）`,
    });
  }

  // 检查记录
  for (const f of floor.facilities) {
    const info = checkDueInfo(f, now);
    if (info.defect) {
      items.push({
        severity: 'error',
        type: 'FACILITY_DEFECT',
        facilityId: f.id,
        point: { x: f.x, y: f.y },
        message: `${f.code} 最近检查状态为「${f.checks.find((c) => c.date === [...f.checks].sort((a, b) => b.date.localeCompare(a.date))[0].date)?.status ?? 'missing'}」，需整改`,
      });
    } else if (info.missing) {
      items.push({
        severity: 'warning',
        type: 'CHECK_MISSING',
        facilityId: f.id,
        point: { x: f.x, y: f.y },
        message: `${f.code} 未登记任何检查记录`,
      });
    } else if (info.overdue) {
      items.push({
        severity: 'warning',
        type: 'CHECK_OVERDUE',
        facilityId: f.id,
        point: { x: f.x, y: f.y },
        message: `${f.code} 检查已过期（应检日期 ${info.dueDate}）`,
      });
    }
  }

  // 排序：error 在前，同类按实测/限值比降序
  items.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    const ra = a.value != null && a.limit ? a.value / a.limit : 0;
    const rb = b.value != null && b.limit ? b.value / b.limit : 0;
    return rb - ra;
  });

  const pass =
    !items.some((i) => i.severity === 'error') && (coverage ? coverage.pass : true);

  return {
    checkedAt: new Date(now).toISOString(),
    pass,
    items,
    travelWorstM,
    travelWorstPoint: worstPoint,
    deadEndM,
    coverage: coverage
      ? { uncoveredM2: coverage.uncoveredM2, totalM2: coverage.totalM2, pass: coverage.pass, samples: coverage.samples }
      : null,
    exits: { present: exits.length, required },
    occupancy: {
      occupants,
      estimated,
      requiredWidthM,
      availableWidthM,
      widthPer100M,
    },
    exitLoads,
    rulesSnapshot: {
      buildingKind: rules.buildingKind,
      version: rules.version,
      source: rules.source,
      maxTravelDistanceM: rules.maxTravelDistanceM,
      deadEndDistanceM: rules.deadEndDistanceM,
      extinguisherRadiusM: rules.extinguisherRadiusM,
      exitMinWidthM: rules.exitMinWidthM,
      exitWidthPer100M: widthPer100M,
    },
  };
}
