import type { BuildingKind, RuleSet } from '../model';

/** 安全出口（疏散门）未单独填净宽时按规范取用的默认值 m（GB 50016：公共建筑疏散门净宽 ≥ 0.9m） */
export const DEFAULT_EXIT_WIDTH_M = 0.9;

/**
 * 默认规则集（参考值，均标注依据，可在 /rules 页面按项目实际调整；修改后版本号 +1）。
 * 说明：
 * - 疏散距离：GB 50016-2014(2018年版) 表 5.5.17（民用建筑）与 3.7.4（厂房）；
 *   袋形走道两侧或尽端的疏散门至最近安全出口距离按同一表取值。
 * - 灭火器保护半径：GB 50140-2005 按火灾类别与危险等级的最大保护距离折算，此处为可配置参考值。
 * - 疏散净宽：GB 50016-2014(2018年版) 表 5.5.21-1「每百人最小疏散净宽」，1~2 层取 0.65、
 *   人员密集的商业 0.75（均为 m/百人，项目可按层数调整）；单门容量 = 净宽 × 100 / 百人指标。
 */
export const DEFAULT_RULES: Record<BuildingKind, RuleSet> = {
  office: {
    buildingKind: 'office',
    maxTravelDistanceM: 40,
    deadEndDistanceM: 22,
    extinguisherRadiusM: 20,
    exitMinAreaM2: 200,
    exitMaxOccupants: 50,
    egressWidthPer100M: 0.65,
    exitDefaultWidthM: DEFAULT_EXIT_WIDTH_M,
    source: 'GB 50016-2014(2018年版) 表5.5.17、表5.5.21-1；GB 50140-2005',
    version: 1,
  },
  retail: {
    buildingKind: 'retail',
    maxTravelDistanceM: 30,
    deadEndDistanceM: 20,
    extinguisherRadiusM: 20,
    exitMinAreaM2: 200,
    exitMaxOccupants: 50,
    egressWidthPer100M: 0.75,
    exitDefaultWidthM: DEFAULT_EXIT_WIDTH_M,
    source: 'GB 50016-2014(2018年版) 表5.5.17（商店建筑）、表5.5.21-1；GB 50140-2005',
    version: 1,
  },
  factory: {
    buildingKind: 'factory',
    maxTravelDistanceM: 30,
    deadEndDistanceM: 20,
    extinguisherRadiusM: 12,
    exitMinAreaM2: 200,
    exitMaxOccupants: 50,
    egressWidthPer100M: 0.65,
    exitDefaultWidthM: DEFAULT_EXIT_WIDTH_M,
    source: 'GB 50016-2014(2018年版) 3.7.4（厂房疏散距离）、3.7.5（疏散净宽）；GB 50140-2005',
    version: 1,
  },
  school: {
    buildingKind: 'school',
    maxTravelDistanceM: 35,
    deadEndDistanceM: 22,
    extinguisherRadiusM: 20,
    exitMinAreaM2: 200,
    exitMaxOccupants: 50,
    egressWidthPer100M: 0.65,
    exitDefaultWidthM: DEFAULT_EXIT_WIDTH_M,
    source: 'GB 50099-2011、GB 50016-2014(2018年版) 表5.5.17、表5.5.21-1；GB 50140-2005',
    version: 1,
  },
};

/** 人员密度估算（㎡/人），未填写人数的房间按此估算 —— 用于出口数量与疏散宽度校验 */
export const OCCUPANCY_DENSITY_M2_PER_PERSON: Record<string, number> = {
  office: 10,
  retail: 3,
  storage: 50,
  ward: 8,
  corridor: 0, // 走道不计停留人数
  other: 20,
};

/** 检查周期（天），用于「下次检查日期」与过期判定 */
export const CHECK_INTERVAL_DAYS: Record<string, number> = {
  extinguisher: 30,
  hydrant: 30,
  exit_sign: 90,
  emergency_light: 90,
  exit: 180,
  sprinkler: 180,
};
