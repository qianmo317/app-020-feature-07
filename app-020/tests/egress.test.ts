/**
 * 疏散人数与出口容量验收用例：
 * - 房间填了实际人数用实际值，留空按用途密度估算（办公 10、商业 3、仓库 50、病房 8、走道 0、其他 20 ㎡/人）；
 * - 所需总净宽 = 人数 × 百人指标 / 100；单出口容量 = 净宽 × 100 / 百人指标；
 * - 人数按「最近出口」整体分配，超载出口在结果中点名（EXIT_OVERFLOW，含超载人数）；
 * - 房间用途/面积变化后人数与结论跟着重算。
 */
import { describe, it, expect } from 'vitest';
import { mkRoom, rect, mkFloor, ruleWith, validateFloor } from './helpers';
import { roomOccupants, exitCapacity, exitWidthM } from '../src/lib/engine';
import { DEFAULT_RULES } from '../src/rules/defaults';

const officeRules = { ...DEFAULT_RULES.office }; // 0.65m/百人，默认门宽 0.9m → 单门 138 人

describe('人数：实际填写优先，留空按密度估算', () => {
  it('E1 100㎡ 办公：留空 → 10 人；填 35 → 35 人；填 0 → 0 人', () => {
    const est = mkRoom('r', 'office', rect(0, 0, 10, 10));
    expect(roomOccupants(est)).toBe(10);
    expect(roomOccupants(mkRoom('r', 'retail', rect(0, 0, 9, 10)))).toBe(30); // 90㎡ / 3
    expect(roomOccupants(mkRoom('r', 'storage', rect(0, 0, 10, 10)))).toBe(2); // 100/50
    expect(roomOccupants(mkRoom('r', 'ward', rect(0, 0, 8, 8)))).toBe(8); // 64/8
    expect(roomOccupants(mkRoom('走道', 'corridor', rect(0, 0, 41, 2)))).toBe(0);
    const actual = mkRoom('r', 'office', rect(0, 0, 10, 10), 35);
    expect(roomOccupants(actual)).toBe(35);
    const zero = mkRoom('r', 'office', rect(0, 0, 10, 10), 0);
    expect(roomOccupants(zero)).toBe(0);
  });

  it('E2 容量换算：0.9m 默认门 → 138 人；1.1m → 169 人', () => {
    expect(exitCapacity(0.9, officeRules)).toBe(138);
    expect(exitCapacity(1.1, officeRules)).toBe(169);
  });
});

describe('净宽与出口数量（整层校验）', () => {
  it('E3 240㎡ 大厅 12 人 + 单门 0.9m：人数规则不触发，但 12 人总宽 0.08m < 0.9m → 不缺宽；面积 >200 仍需 2 出口', () => {
    const { floor, rules } = mkFloor([mkRoom('大厅', 'other', rect(0, 0, 12, 20), 12)], [
      { kind: 'exit', x: 11.5, y: 10, spec: { exitWidthM: 0.9 } },
    ]);
    const r = validateFloor(floor, rules);
    expect(r.occupants).toBe(12);
    expect(r.egress.requiredWidthM).toBeCloseTo(0.078, 3);
    expect(r.egress.presentWidthM).toBeCloseTo(0.9, 3);
    expect(r.egress.pass).toBe(true);
    expect(r.exits.required).toBe(2); // 面积 > 200
    expect(r.items.some((i) => i.type === 'EXIT_COUNT')).toBe(true);
    expect(r.items.some((i) => i.type === 'EXIT_WIDTH')).toBe(false);
    expect(r.items.some((i) => i.type === 'EXIT_OVERFLOW')).toBe(false);
  });

  it('E4 400 人单出口（门 1.1m，容量 169）：超 231 人，报 EXIT_OVERFLOW；总宽 1.1m < 2.6m 报 EXIT_WIDTH；需 ≥3 出口', () => {
    const { floor, rules } = mkFloor([mkRoom('大办公', 'office', rect(0, 0, 20, 20), 400)], [
      { kind: 'exit', x: 19.5, y: 10, spec: { exitWidthM: 1.1 } },
    ]);
    const r = validateFloor(floor, rules);
    expect(r.occupants).toBe(400);
    expect(r.egress.requiredWidthM).toBeCloseTo(2.6, 6);
    expect(r.exits.required).toBe(3); // ceil(2.6/0.9) = 3
    const load = r.exitLoads[0];
    expect(load.assigned).toBe(400);
    expect(load.capacity).toBe(169);
    expect(load.overflow).toBe(231);
    const over = r.items.find((i) => i.type === 'EXIT_OVERFLOW');
    expect(over).toBeDefined();
    expect(over!.value).toBe(400);
    expect(over!.limit).toBe(169);
    expect(over!.message).toContain('超载 231 人');
    expect(over!.point).toEqual({ x: 19500, y: 10000 }); // 可在图上定位
    expect(r.items.some((i) => i.type === 'EXIT_WIDTH')).toBe(true);
    expect(r.pass).toBe(false);
  });

  it('E5 双出口就近分配：西房间的人只能压到西门 → 西门超载点名', () => {
    // 60m 走道 + 两端出口（各 0.9m/138 人）；西端办公室塞 300 人
    const { floor, rules } = mkFloor(
      [
        mkRoom('走道', 'corridor', rect(0, 0, 60, 2)),
        mkRoom('西厅', 'office', rect(0, 2, 8, 10), 300),
        mkRoom('东厅', 'office', rect(52, 2, 8, 10), 10),
      ],
      [
        { kind: 'exit', x: 0.5, y: 1, spec: { exitWidthM: 0.9 } },
        { kind: 'exit', x: 59.5, y: 1, spec: { exitWidthM: 0.9 } },
      ],
    );
    const r = validateFloor(floor, rules);
    const [west, east] = r.exitLoads;
    expect(west.assigned).toBe(300);
    expect(east.assigned).toBe(10);
    expect(west.overflow).toBe(162);
    expect(east.overflow).toBe(0);
    const over = r.items.filter((i) => i.type === 'EXIT_OVERFLOW');
    expect(over.length).toBe(1);
    expect(over[0].message).toContain('exit-0');
  });

  it('E6 门加宽到 2.2m（容量 338）→ E5 同样 300 人不再超载，但总净宽仍需检查', () => {
    const { floor, rules } = mkFloor(
      [
        mkRoom('走道', 'corridor', rect(0, 0, 60, 2)),
        mkRoom('西厅', 'office', rect(0, 2, 8, 10), 300),
      ],
      [
        { kind: 'exit', x: 0.5, y: 1, spec: { exitWidthM: 2.2 } },
        { kind: 'exit', x: 59.5, y: 1, spec: { exitWidthM: 0.9 } },
      ],
    );
    const r = validateFloor(floor, rules);
    expect(r.exitLoads[0].capacity).toBe(338);
    expect(r.exitLoads[0].overflow).toBe(0);
    expect(r.items.some((i) => i.type === 'EXIT_OVERFLOW')).toBe(false);
    // 总宽 3.1m ≥ 300×0.65/100 = 1.95m
    expect(r.egress.pass).toBe(true);
  });
});

describe('人数随房间用途/面积重算', () => {
  it('E7 同一 90㎡ 房间：办公估 9 人 → 改商业估 30 人（数量结论翻转）', () => {
    const mk = (usage: Parameters<typeof mkRoom>[1]) => {
      const rooms = [
        mkRoom('走道', 'corridor', rect(0, 0, 20, 2)),
        mkRoom('店', usage, rect(0, 2, 9, 10)),
      ];
      return mkFloor(rooms, [
        { kind: 'exit', x: 0.5, y: 1 },
        { kind: 'exit', x: 19.5, y: 1 },
      ]);
    };
    const { floor: of, rules: or } = mk('office');
    const ro = validateFloor(of, or);
    expect(ro.occupants).toBe(9);
    expect(ro.exits.required).toBe(1); // 面积 130㎡ ≤200，9 人 ≤50

    const { floor: rf, rules: rr } = mk('retail');
    const rr2 = validateFloor(rf, rr);
    expect(rr2.occupants).toBe(30); // 90/3
    // 30 人仍 ≤ 50 → 数量仍 1；面积也不变。改填实际 60 人则需 2 个
    expect(rr2.exits.required).toBe(1);
  });

  it('E8 填实际 80 人 → 需 2 出口 + 总宽 0.52m > 单门 0.9m? 不，0.52<0.9 宽够；数量触发', () => {
    const { floor, rules } = mkFloor(
      [
        mkRoom('走道', 'corridor', rect(0, 0, 20, 2)),
        mkRoom('房', 'office', rect(0, 2, 9, 10), 80),
      ],
      [{ kind: 'exit', x: 19.5, y: 1, spec: { exitWidthM: 0.9 } }],
    );
    const r = validateFloor(floor, rules);
    expect(r.occupants).toBe(80);
    expect(r.exits.required).toBe(2);
    expect(r.egress.requiredWidthM).toBeCloseTo(0.52, 6);
    expect(r.egress.pass).toBe(true);
    // 80 人全部就近到唯一出口，容量 138 → 单门不超载
    expect(r.exitLoads[0].assigned).toBe(80);
    expect(r.exitLoads[0].overflow).toBe(0);
  });

  it('E9 留空时出口未填净宽 → 采用规则默认 0.9m', () => {
    const { floor, rules } = mkFloor([mkRoom('大厅', 'other', rect(0, 0, 10, 10), 5)], [
      { kind: 'exit', x: 9.5, y: 5 },
    ]);
    const f = floor.facilities[0];
    expect(exitWidthM(f, rules)).toBe(0.9);
    const r = validateFloor(floor, rules);
    expect(r.exitLoads[0].widthM).toBe(0.9);
    expect(r.exitLoads[0].capacity).toBe(138);
  });

  it('E10 规则的百人指标可配置：收紧到 1.0m/百人后 200 人需 2.0m，1.8m 双门不达标', () => {
    const { floor, rules } = mkFloor([mkRoom('厅', 'other', rect(0, 0, 20, 10), 200)], [
      { kind: 'exit', x: 0.5, y: 5, spec: { exitWidthM: 0.9 } },
      { kind: 'exit', x: 19.5, y: 5, spec: { exitWidthM: 0.9 } },
    ]);
    const tight = ruleWith(rules, { egressWidthPer100M: 1.0 });
    const r = validateFloor(floor, tight);
    expect(r.egress.requiredWidthM).toBeCloseTo(2.0, 6);
    expect(r.egress.presentWidthM).toBeCloseTo(1.8, 6);
    expect(r.egress.pass).toBe(false);
    expect(r.items.some((i) => i.type === 'EXIT_WIDTH')).toBe(true);
  });
});
