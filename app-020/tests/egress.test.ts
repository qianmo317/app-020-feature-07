/**
 * 人数与疏散宽度验收用例：
 * - 房间实填人数优先；留空按用途密度估算（办公 10、商业 3、仓库 50、病房 8、走道 0、其他 20 ㎡/人）
 * - 所需总净宽度 = 人数 × 百人宽度指标（按楼层）；出口容量 = 净宽 ÷ 指标 × 100
 * - 人数按最近出口分配，超载出口产出 EXIT_CAPACITY 并带超出人数
 * - 用途/面积/人数变化后结论跟着重算
 */
import { describe, it, expect } from 'vitest';
import { mkFloor, mkRoom, rect, ruleWith, validateFloor, DEFAULT_RULES } from './helpers';

/** 走道 + 两侧房间，出口放在走道两端（坐标单位 m） */
function floorWithRooms(
  rooms: ReturnType<typeof mkRoom>[],
  exits: { kind: 'exit'; x: number; y: number }[] = [
    { kind: 'exit', x: 0.5, y: 1 },
    { kind: 'exit', x: 40.5, y: 1 },
  ],
) {
  return mkFloor([mkRoom('走道', 'corridor', rect(0, 0, 41, 2)), ...rooms], exits);
}

describe('人数估算（实填优先，留空按密度）', () => {
  it('E1 各用途密度：办公10 / 商业3 / 仓库50 / 病房8 / 走道0 / 其他20 ㎡/人', () => {
    const cases: [Parameters<typeof mkRoom>[1], number, number][] = [
      ['office', 100, 10],
      ['retail', 90, 30],
      ['storage', 1000, 20],
      ['ward', 80, 10],
      ['corridor', 200, 0],
      ['other', 400, 20],
    ];
    const rooms = cases.map(([usage, area], i) =>
      mkRoom(`r${i}`, usage, rect(100 + i * 30, 0, area <= 100 ? Math.sqrt(area) : 50, area <= 100 ? Math.sqrt(area) : area / 50)),
    );
    const { floor, rules } = mkFloor(rooms, []);
    const r = validateFloor(floor, rules);
    expect(r.occupancy.occupants).toBe(90); // 10+30+20+10+0+20
    expect(r.occupancy.estimated).toBe(90);
  });

  it('E2 实填人数覆盖密度估算', () => {
    const { floor, rules } = floorWithRooms([
      mkRoom('101', 'office', rect(0, 2, 8, 6), 55), // 48㎡ 本应估 5 人
      mkRoom('102', 'retail', rect(8, 2, 8, 6)), // 48㎡ 估 16 人
    ]);
    const r = validateFloor(floor, rules);
    expect(r.occupancy.occupants).toBe(71); // 55 + 16
    expect(r.occupancy.estimated).toBe(16);
  });

  it('E3 显式填 0 人（如空置仓库）按 0 计算，而不是按密度估', () => {
    const { floor, rules } = mkFloor(
      [mkRoom('空库', 'storage', rect(0, 0, 50, 20), 0)],
      [{ kind: 'exit', x: 25, y: 10 }],
    );
    const r = validateFloor(floor, rules);
    expect(r.occupancy.occupants).toBe(0);
    expect(r.occupancy.requiredWidthM).toBe(0);
  });
});

describe('疏散宽度与出口数量', () => {
  it('E4 120 人 / 1.0m 每百人 → 需 1.2m；两个 0.9m 出口（共 1.8m）够，且不超载', () => {
    // 左半层 60 人、右半层 60 人，分别就近两端出口（0.9m → 容量 90 人）
    const { floor, rules } = floorWithRooms([
      mkRoom('左厅', 'other', rect(0, 2, 20, 30), 60),
      mkRoom('右厅', 'other', rect(21, 2, 20, 30), 60),
    ]);
    const r = validateFloor(floor, rules);
    expect(r.occupancy.requiredWidthM).toBeCloseTo(1.2, 5);
    expect(r.occupancy.availableWidthM).toBeCloseTo(1.8, 5);
    expect(r.items.some((i) => i.type === 'EXIT_WIDTH')).toBe(false);
    expect(r.items.some((i) => i.type === 'EXIT_CAPACITY')).toBe(false);
  });

  it('E5 单出口净宽 < 0.9m → EXIT_WIDTH_NARROW', () => {
    const { floor } = mkFloor(
      [mkRoom('大厅', 'other', rect(0, 0, 20, 10), 20)],
      [{ kind: 'exit', x: 10, y: 5 }],
    );
    floor.facilities[0] = { ...floor.facilities[0], spec: { widthM: 0.8 } };
    const r = validateFloor(floor, DEFAULT_RULES.office);
    const item = r.items.find((i) => i.type === 'EXIT_WIDTH_NARROW');
    expect(item).toBeDefined();
    expect(item!.value).toBeCloseTo(0.8, 5);
    expect(item!.limit).toBe(0.9);
  });

  it('E6 人数 > 50 触发需 ≥2 出口（实填人数）', () => {
    const { floor, rules } = mkFloor(
      [mkRoom('大厅', 'other', rect(0, 0, 10, 4), 51)], // 40㎡ 估算只 2 人
      [{ kind: 'exit', x: 5, y: 2 }],
    );
    const r = validateFloor(floor, rules);
    expect(r.exits.required).toBe(2);
    expect(r.items.some((i) => i.type === 'EXIT_COUNT')).toBe(true);
  });
});

describe('按最近出口分配与超载标注', () => {
  it('E7 全层 200 人集中在左端 → 左出口超载，右出口空闲', () => {
    const { floor, rules } = floorWithRooms([
      mkRoom('左厅', 'other', rect(0, 2, 10, 40), 200),
    ]);
    const r = validateFloor(floor, rules);
    // 0.9m / 1.0m/百人 → 单口容量 90 人
    const loads = r.exitLoads;
    expect(loads).toHaveLength(2);
    const left = loads.find((l) => l.code.includes('0'))!;
    expect(left.assigned).toBe(200);
    expect(left.capacity).toBe(90);
    expect(left.overflow).toBe(110);
    const over = r.items.find((i) => i.type === 'EXIT_CAPACITY');
    expect(over).toBeDefined();
    expect(over!.facilityId).toBe(left.facilityId);
    expect(over!.message).toContain('超出 110 人');
  });

  it('E8 超载解除：把人数改小后 EXIT_CAPACITY 消失', () => {
    const { floor, rules } = floorWithRooms([
      mkRoom('左厅', 'other', rect(0, 2, 10, 40), 200),
    ]);
    expect(validateFloor(floor, rules).items.some((i) => i.type === 'EXIT_CAPACITY')).toBe(true);
    floor.rooms.find((x) => x.name === '左厅')!.occupants = 80;
    const r2 = validateFloor(floor, rules);
    expect(r2.items.some((i) => i.type === 'EXIT_CAPACITY')).toBe(false);
  });

  it('E9 改用途（人数随之重估）改变宽度结论：办公 480㎡=48 人 → 商业=160 人超载', () => {
    const { floor, rules } = floorWithRooms([
      mkRoom('大厅', 'office', rect(0, 2, 20, 24)), // 480㎡
    ]);
    const office = validateFloor(floor, rules);
    expect(office.occupancy.occupants).toBe(48);
    expect(office.items.some((i) => i.type === 'EXIT_CAPACITY')).toBe(false);
    floor.rooms.find((x) => x.name === '大厅')!.usage = 'retail';
    // 注意 areaM2 在 store 中由 addRoom/move 维护；测试里手动同步
    const retail = validateFloor(floor, rules);
    expect(retail.occupancy.occupants).toBe(160); // 480/3
    expect(retail.items.some((i) => i.type === 'EXIT_CAPACITY')).toBe(true);
  });

  it('E10 加宽超载出口到 1.6m（容量 160）即不超载；总宽仍提示则降级为警告', () => {
    const { floor, rules } = floorWithRooms([
      mkRoom('左厅', 'other', rect(0, 2, 10, 40), 200),
    ]);
    const left = floor.facilities.find((f) => f.x === 500)!;
    left.spec = { widthM: 1.6 };
    const r = validateFloor(floor, rules);
    const leftLoad = r.exitLoads.find((l) => l.facilityId === left.id)!;
    expect(leftLoad.capacity).toBe(160);
    expect(leftLoad.overflow).toBe(40);
    // 总宽 1.6+0.9=2.5 ≥ 2.0，需要宽度满足，仅该出口超载
    const widthItem = r.items.find((i) => i.type === 'EXIT_WIDTH');
    expect(widthItem).toBeUndefined();
  });

  it('E11 百人宽度指标按楼层取值：3 层用 0.75，5 层用 1.00（规则配置 0.65 也被抬高）', () => {
    const { floor, rules } = floorWithRooms([mkRoom('101', 'office', rect(0, 2, 8, 6), 100)]);
    const loose = ruleWith(rules, { exitWidthPer100M: 0.65 });
    floor.level = 3;
    expect(validateFloor(floor, loose).occupancy.widthPer100M).toBeCloseTo(0.75, 5);
    floor.level = 5;
    expect(validateFloor(floor, loose).occupancy.widthPer100M).toBeCloseTo(1.0, 5);
    floor.level = 1;
    expect(validateFloor(floor, loose).occupancy.widthPer100M).toBeCloseTo(0.65, 5);
  });
});
