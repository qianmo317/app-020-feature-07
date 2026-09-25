import type { BuildingKind, RuleSet } from '../model';

/**
 * 默认规则集（参考值，均标注依据，可在 /rules 页面按项目实际调整；修改后版本号 +1）。
 * 说明：
 * - 疏散距离：GB 50016-2014(2018年版) 表 5.5.17（民用建筑）与 3.7.4（厂房）；
 *   袋形走道两侧或尽端的疏散门至最近安全出口距离按同一表取值。
 * - 灭火器保护半径：GB 50140-2005 按火灾类别与危险等级的最大保护距离折算，此处为可配置参考值。
 * - 疏散宽度：GB 50016-2014(2018年版) 表 5.5.21-1（每百人最小疏散净宽度）
 *   与 5.5.19（安全出口/疏散门最小净宽度 0.9m）。
 */
export const DEFAULT_RULES: Record<BuildingKind, RuleSet> = {
  office: {
    buildingKind: 'office',
    maxTravelDistanceM: 40,
    deadEndDistanceM: 22,
    extinguisherRadiusM: 20,
    exitMinAreaM2: 200,
    exitMaxOccupants: 50,
    exitMinWidthM: 0.9,
    exitWidthPer100M: 1.0,
    source: 'GB 50016-2014(2018年版) 表5.5.17、表5.5.21-1、5.5.19；GB 50140-2005',
    version: 2,
  },
  retail: {
    buildingKind: 'retail',
    maxTravelDistanceM: 30,
    deadEndDistanceM: 20,
    extinguisherRadiusM: 20,
    exitMinAreaM2: 200,
    exitMaxOccupants: 50,
    exitMinWidthM: 0.9,
    exitWidthPer100M: 1.0,
    source: 'GB 50016-2014(2018年版) 表5.5.17（商店建筑）、表5.5.21-1、5.5.19；GB 50140-2005',
    version: 2,
  },
  factory: {
    buildingKind: 'factory',
    maxTravelDistanceM: 30,
    deadEndDistanceM: 20,
    extinguisherRadiusM: 12,
    exitMinAreaM2: 200,
    exitMaxOccupants: 50,
    exitMinWidthM: 0.9,
    exitWidthPer100M: 1.0,
    source: 'GB 50016-2014(2018年版) 3.7.4（厂房疏散距离）、3.7.5（疏散宽度）、5.5.19；GB 50140-2005',
    version: 2,
  },
  school: {
    buildingKind: 'school',
    maxTravelDistanceM: 35,
    deadEndDistanceM: 22,
    extinguisherRadiusM: 20,
    exitMinAreaM2: 200,
    exitMaxOccupants: 50,
    exitMinWidthM: 0.9,
    exitWidthPer100M: 1.0,
    source: 'GB 50099-2011、GB 50016-2014(2018年版) 表5.5.17、表5.5.21-1、5.5.19；GB 50140-2005',
    version: 2,
  },
};

/** 人员密度估算（㎡/人），未填写人数的房间按此估算 */
export const OCCUPANCY_DENSITY_M2_PER_PERSON: Record<string, number> = {
  office: 10,
  retail: 3,
  storage: 50,
  ward: 8,
  corridor: 0, // 走道不计停留人数
  other: 20,
};

/** 安全出口默认净宽度（m）：GB 50016-2014 5.5.19 一般疏散门 ≥ 0.9m，未单独填写宽度时按此值 */
export const DEFAULT_EXIT_WIDTH_M = 0.9;

/**
 * GB 50016-2014(2018年版) 表 5.5.21-1：地上建筑每百人最小疏散净宽度（m/百人）。
 * 1-2 层 0.65，3 层 0.75，≥4 层 1.00；地下按埋深另计（此处保守取 1.00）。
 * 校验取值不小于规则页配置的 exitWidthPer100M（不同建筑类别可收紧）。
 */
export const EGRESS_WIDTH_PER_100_M: { maxLevel: number; width: number }[] = [
  { maxLevel: 2, width: 0.65 },
  { maxLevel: 3, width: 0.75 },
  { maxLevel: Infinity, width: 1.0 },
];

/** 按楼层选取规范百人宽度指标，再与规则集配置值取大值 */
export function egressWidthPer100M(level: number, configured: number): number {
  if (level <= 0) return Math.max(1.0, configured);
  const norm = EGRESS_WIDTH_PER_100_M.find((row) => level <= row.maxLevel)?.width ?? 1.0;
  return Math.max(norm, configured);
}

/** 检查周期（天），用于「下次检查日期」与过期判定 */
export const CHECK_INTERVAL_DAYS: Record<string, number> = {
  extinguisher: 30,
  hydrant: 30,
  exit_sign: 90,
  emergency_light: 90,
  exit: 180,
  sprinkler: 180,
};
